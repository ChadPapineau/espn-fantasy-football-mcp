// espn-http-wait.test.ts — the CLI's ESPN request helper waiting for the limiter (plan 01 §6; plan 03
// §1.3 exit codes; Stage C findings cli-limiter-unref-timer-exit13 and
// cli-limiter-boundary-retry-rate-limited): the wait holds the event loop (a child process with
// nothing else alive still sends its request and exits 0 — an unreferenced timer ended it with exit
// 13), a retry that wakes on the store's inclusive window boundary is waited for again instead of
// being reported `rate_limited`, and the total wait stays within MAX_LIMITER_WAIT_MS; ESPN's
// Retry-After on the keyless season GET reaches the refresh runner and no request goes inside the
// hinted window (finding cli-season-get-drops-retry-after); the caller's signal ends a request in
// flight or a limiter wait at once (finding cli-first-signal-swallowed). No network: the http
// client is a stub (or the real client over a stub fetch); the limiter is the real store table (or
// a stub).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_LIMITER_WAIT_MS,
  espnRequest,
  limiterSleep,
  seasonGet,
} from "../../src/cli/espn-http.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { fixedClock, seededRng } from "../../src/domain/clock.js";
import { createHttpClient, type HttpClient } from "../../src/http/client.js";
import { HttpError } from "../../src/http/errors.js";
import { espnSeasonSources } from "../../src/sources/espn_season/index.js";
import { runRefresh } from "../../src/sources/runner.js";
import { MemoryLimiterRepo } from "../providers/espn/helpers.js";
import { ROOT, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

const CHILD = path.join(ROOT, "tests", "cli", "procs", "limiter-wait-child.ts");
const URL0 = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026";

function runChild(
  retryAfterMs: number,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", CHILD, String(retryAfterMs)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      resolve({ code, out, err });
    });
  });
}

const okHttp = (sent: string[]): Pick<HttpClient, "espnGet"> => ({
  espnGet: (url: string) => {
    sent.push(url);
    return Promise.resolve({
      status: 200,
      body: new Uint8Array(),
      headers: {},
      final_url: url,
      cookie_sent: false,
    });
  },
});

describe("the limiter wait holds the process (exit 13 regression)", () => {
  it("a top-level request that must wait for a full window is still sent; the process exits 0", async () => {
    const r = await runChild(300);
    expect(r.err).not.toMatch(/unsettled top-level await/i);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim()) as unknown).toEqual({ status: 200, checks: 2, sent: 1 });
  }, 30_000);

  it("the real wait is a referenced timer", async () => {
    const timers: NodeJS.Timeout[] = [];
    const orig = globalThis.setTimeout;
    const spy = ((fn: () => void, ms?: number) => {
      const t = orig(fn, ms);
      timers.push(t);
      return t;
    }) as typeof setTimeout;
    globalThis.setTimeout = spy;
    let pending: Promise<void>;
    try {
      pending = limiterSleep(5);
    } finally {
      globalThis.setTimeout = orig;
    }
    // while the wait is pending its timer keeps the event loop alive
    expect(timers.map((t) => t.hasRef())).toEqual([true]);
    await pending;
  });
});

describe("the inclusive window boundary (rate_limited regression)", () => {
  it("a retry that wakes exactly on the boundary waits again and is sent", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-10-06T18:00:00.000Z");
    const io = makeIo(sb, { clock });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, clock, log, { migrate: true });
    try {
      const sent: string[] = [];
      const slept: number[] = [];
      const deps = {
        http: okHttp(sent),
        limiter: store.repos.limiter,
        clock,
        origin: "server" as const,
        // a timer that wakes exactly when asked (Node timers often do): the clock moves by the wait
        sleep: (ms: number) => {
          slept.push(ms);
          clock.advance(ms);
          return Promise.resolve();
        },
      };
      const first = await espnRequest(deps, { url: URL0, cookie: null });
      const second = await espnRequest(deps, { url: URL0, cookie: null });
      expect("status" in first && first.status).toBe(200);
      expect("status" in second && second.status).toBe(200);
      expect(sent).toHaveLength(2);
      // the first wait lands on the boundary (still inside), the second clears it
      expect(slept[0]).toBe(1000);
      expect(slept.length).toBeGreaterThanOrEqual(2);
      expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_LIMITER_WAIT_MS);
      expect(store.repos.limiter.countToday("2026-10-06T00:00:00.000Z").server.keyless).toBe(2);
    } finally {
      store.close();
    }
  });

  it("a window that stays full is refused after at most MAX_LIMITER_WAIT_MS of waiting, nothing sent", async () => {
    const sent: string[] = [];
    let slept = 0;
    let checks = 0;
    const r = await espnRequest(
      {
        http: okHttp(sent),
        limiter: {
          tryRecord: () => {
            checks++;
            return { ok: false as const, reason: "window" as const, retry_after_ms: 700 };
          },
          recordOutcome: () => undefined,
          recentOutcomes: () => [],
        } as never,
        clock: fixedClock("2026-10-06T18:00:00.000Z"),
        origin: "server",
        sleep: (ms) => {
          slept += ms;
          return Promise.resolve();
        },
      },
      { url: URL0, cookie: null },
    );
    expect(r).toEqual({ error: "rate_limited" });
    expect(sent).toHaveLength(0);
    expect(slept).toBeLessThanOrEqual(MAX_LIMITER_WAIT_MS);
    expect(slept).toBe(7 * 700);
    expect(checks).toBe(8);
  });
});

describe("the CLI's requests take their slot under the cross-process in-flight cap (limiter-concurrency-per-process)", () => {
  it("two requests in flight in other processes: the CLI waits for a slot and sends once one finishes; never a third in flight", async () => {
    sb = sandbox();
    const io = makeIo(sb, { clock: fixedClock("2026-10-06T18:00:00.000Z") });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      const repo = store.repos.limiter;
      const t0 = io.clock.nowMs();
      // the server and a launchd job each hold a request in flight (pending rows)
      const a = repo.tryRecord({
        at: new Date(t0 - 4000).toISOString(),
        keyless: true,
        origin: "server",
        windows: [],
        dailyCap: null,
      });
      const b = repo.tryRecord({
        at: new Date(t0 - 2000).toISOString(),
        keyless: true,
        origin: "job",
        windows: [],
        dailyCap: null,
      });
      if (!a.ok || !b.ok) throw new Error("setup rows refused");
      const sent: string[] = [];
      let waits = 0;
      const r = await espnRequest(
        {
          http: okHttp(sent),
          limiter: repo,
          clock: io.clock,
          origin: "server",
          sleep: (ms) => {
            waits += 1;
            // while the CLI waits, nothing it sends; after the second wait one request finishes
            expect(sent).toHaveLength(0);
            if (waits === 2) repo.recordOutcome(a.id, "ok");
            io.clock.advance(ms);
            return Promise.resolve();
          },
        },
        { url: URL0, cookie: null },
      );
      expect("status" in r && r.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(waits).toBeGreaterThanOrEqual(2);
      // b is still in flight and another process starts one more: the slots are full for good —
      // the CLI waits its budget out and reports rate_limited, nothing sent, no row written
      const c = repo.tryRecord({
        at: new Date(io.clock.nowMs() - 1000).toISOString(),
        keyless: true,
        origin: "job",
        windows: [],
        dailyCap: null,
      });
      expect(c.ok).toBe(true);
      const rows = repo.countSince(new Date(t0 - 60_000).toISOString());
      const sent2: string[] = [];
      let slept = 0;
      const refused = await espnRequest(
        {
          http: okHttp(sent2),
          limiter: repo,
          clock: io.clock,
          origin: "server",
          sleep: (ms) => {
            slept += ms;
            return Promise.resolve();
          },
        },
        { url: URL0, cookie: null },
      );
      expect(refused).toEqual({ error: "rate_limited" });
      expect(sent2).toHaveLength(0);
      expect(slept).toBeLessThanOrEqual(MAX_LIMITER_WAIT_MS);
      expect(repo.countSince(new Date(t0 - 60_000).toISOString())).toBe(rows);
    } finally {
      store.close();
    }
  });
});

// Stage C finding cli-season-get-drops-retry-after: the CLI's keyless season GET dropped ESPN's
// Retry-After, so `eff refresh espn:*` retried a 429 after ~0.6 s and ~0.04 s
describe("Retry-After on the CLI's keyless season GET", () => {
  const SEASON_URL = `${URL0}?view=proTeamSchedules_wl`;
  /** ESPN answering 429 with `Retry-After: 60`; the clock moves only when someone sleeps. */
  function world() {
    let t = Date.parse("2026-10-06T12:00:00.000Z");
    const clock = { nowMs: () => t, nowIso: () => new Date(t).toISOString() };
    const sentAt: number[] = [];
    const http = createHttpClient({
      fetch: () => {
        sentAt.push(t);
        return Promise.resolve(
          new Response("{}", {
            status: 429,
            headers: { "retry-after": "60", "content-type": "application/json" },
          }),
        );
      },
    });
    const sleep = (ms: number): Promise<void> => {
      t += ms;
      return Promise.resolve();
    };
    const get = seasonGet({
      http,
      limiter: new MemoryLimiterRepo(),
      clock,
      origin: "server",
      sleep,
    });
    return { get, sentAt, clock, sleep, advance: (ms: number) => (t += ms) };
  }
  const opts = () => ({ signal: new AbortController().signal, maxBytes: 1 << 20 });

  it("the error carries the hint; inside the hinted window nothing is sent; after it a request goes", async () => {
    const w = world();
    const first = (await w.get(SEASON_URL, opts()).catch((e: unknown) => e)) as HttpError;
    expect(first).toBeInstanceOf(HttpError);
    expect([first.kind, first.status, first.retryAfterS]).toEqual(["rate_limited", 429, 60]);
    w.advance(10_000);
    const inside = (await w.get(SEASON_URL, opts()).catch((e: unknown) => e)) as HttpError;
    expect([inside.kind, inside.retryAfterS]).toEqual(["rate_limited", 50]);
    expect(w.sentAt).toHaveLength(1);
    w.advance(50_000);
    await w.get(SEASON_URL, opts()).catch(() => undefined);
    expect(w.sentAt).toHaveLength(2);
  });

  it("a 503 with Retry-After opens the window too; a 429 without one, or a 404, opens none", async () => {
    let t = Date.parse("2026-10-06T12:00:00.000Z");
    const clock = { nowMs: () => t, nowIso: () => new Date(t).toISOString() };
    const answers: { status: number; headers: Record<string, string> }[] = [
      { status: 503, headers: { "retry-after": "30" } },
      { status: 429, headers: {} },
      { status: 429, headers: {} },
      { status: 404, headers: {} },
      { status: 404, headers: {} },
    ];
    let sent = 0;
    const http = createHttpClient({
      fetch: () => {
        const a = answers[sent++] ?? { status: 404, headers: {} };
        return Promise.resolve(new Response("{}", { status: a.status, headers: a.headers }));
      },
    });
    const get = seasonGet({ http, limiter: new MemoryLimiterRepo(), clock, origin: "server" });
    const fail = (): Promise<HttpError> =>
      get(SEASON_URL, opts()).then(
        () => {
          throw new Error("expected a failure");
        },
        (e: unknown) => e as HttpError,
      );
    expect((await fail()).retryAfterS).toBe(30);
    t += 5_000;
    expect([(await fail()).status, sent]).toEqual([null, 1]);
    t += 25_000;
    // the window is over: each 429 without a hint, and each 404, is sent at once
    expect([(await fail()).retryAfterS, sent]).toEqual([null, 2]);
    t += 2_000;
    expect([(await fail()).retryAfterS, sent]).toEqual([null, 3]);
    t += 2_000;
    expect([(await fail()).kind, sent]).toEqual(["http_4xx", 4]);
    t += 2_000;
    expect([(await fail()).kind, sent]).toEqual(["http_4xx", 5]);
  });

  it("through the refresh runner: it waits for the hint and no request lands inside the window", async () => {
    const w = world();
    const sleeps: number[] = [];
    const tmp = mkdtempSync(path.join(tmpdir(), "eff-retry-after-"));
    try {
      const r = await runRefresh(
        { source: espnSeasonSources().proSchedule, seasons: [2026], week: null },
        {
          http: w.get,
          download: () => Promise.reject(new Error("no download")),
          clock: w.clock,
          rng: seededRng(7),
          publisher: {} as never,
          refreshLog: { record: () => undefined, current: () => [] },
          proSchedule: {
            games: () => ({ rows: [], stamp: null }),
            teams: () => ({ rows: [], stamp: null }),
          },
          temp: {
            create: () => Promise.resolve(mkdtempSync(path.join(tmp, "run-"))),
            remove: () => Promise.resolve(),
          },
          sleep: (ms: number) => {
            sleeps.push(ms);
            return w.sleep(ms);
          },
        },
      );
      expect(r).toMatchObject({ status: "failed", source_error: "RATE_LIMITED" });
      const t0 = w.sentAt[0] ?? Number.NaN;
      // every request after the first waited out the 60 s ESPN asked for
      for (const at of w.sentAt.slice(1)) expect(at - t0).toBeGreaterThanOrEqual(60_000);
      // the runner waited the hint (capped at its 30 s maximum per retry), never ~0.6 s
      expect(sleeps.length).toBeGreaterThan(0);
      for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(30_000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Stage C finding cli-first-signal-swallowed: seasonGet dropped the caller's signal, so the first
// SIGINT/SIGTERM to `eff refresh espn:*` (which claims the signals for its run) waited out the
// request in flight, or the limiter wait, before the run could stop. The signal now ends either at
// once, as `aborted`: no upstream verdict (the breaker never counts it) and, before a slot is
// taken or while waiting for one, nothing recorded and nothing sent.
describe("the caller's signal ends the CLI's ESPN request at once", () => {
  const SEASON_URL = `${URL0}?view=proTeamSchedules_wl`;
  const clock = fixedClock("2026-10-06T18:00:00.000Z");

  it("a season GET in flight: the fetch's own signal aborts synchronously, the GET rejects aborted, the row keeps no verdict", async () => {
    const limiter = new MemoryLimiterRepo();
    const fetchSignals: AbortSignal[] = [];
    const http = createHttpClient({
      // a hung socket: it never settles and ignores its signal
      fetch: (_url, init) => {
        if (init.signal) fetchSignals.push(init.signal);
        return new Promise<Response>(() => undefined);
      },
    });
    const get = seasonGet({ http, limiter, clock, origin: "server" });
    const caller = new AbortController();
    const pending = get(SEASON_URL, { signal: caller.signal, maxBytes: 1 << 20 }).catch(
      (e: unknown) => e,
    );
    for (let i = 0; i < 200 && fetchSignals.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(fetchSignals).toHaveLength(1);
    const sent = fetchSignals[0];
    expect(sent?.aborted).toBe(false);
    caller.abort();
    // before the fix the request ran on to its own 15 s attempt timeout
    expect(sent?.aborted).toBe(true);
    const e = (await pending) as HttpError;
    expect(e).toBeInstanceOf(HttpError);
    expect(e.kind).toBe("aborted");
    expect(limiter.rows.map((r) => r.outcome)).toEqual(["pending"]);
  });

  it("a wait for the limiter: the abort ends it at once, nothing sent, nothing recorded", async () => {
    const sent: string[] = [];
    let checks = 0;
    const caller = new AbortController();
    const r = espnRequest(
      {
        http: okHttp(sent),
        limiter: {
          tryRecord: () => {
            checks++;
            return { ok: false as const, reason: "window" as const, retry_after_ms: 700 };
          },
          recordOutcome: () => undefined,
          recentOutcomes: () => [],
        } as never,
        clock,
        origin: "job",
        // a wait that never ends by itself: only the abort can end it
        sleep: () => new Promise<void>(() => undefined),
      },
      { url: SEASON_URL, cookie: null, signal: caller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    caller.abort();
    expect(await r).toEqual({ error: "aborted" });
    expect(sent).toHaveLength(0);
    expect(checks).toBe(1);
  });

  it("an already aborted signal: no slot taken, nothing sent; seasonGet reports aborted", async () => {
    const limiter = new MemoryLimiterRepo();
    const sent: string[] = [];
    const caller = new AbortController();
    caller.abort();
    expect(
      await espnRequest(
        { http: okHttp(sent), limiter, clock, origin: "job" },
        { url: SEASON_URL, cookie: null, signal: caller.signal },
      ),
    ).toEqual({ error: "aborted" });
    const get = seasonGet({ http: okHttp(sent), limiter, clock, origin: "job" });
    const e = (await get(SEASON_URL, { signal: caller.signal, maxBytes: 1 << 20 }).catch(
      (x: unknown) => x,
    )) as HttpError;
    expect([e instanceof HttpError, e.kind]).toEqual([true, "aborted"]);
    expect(sent).toHaveLength(0);
    expect(limiter.rows).toHaveLength(0);
  });

  it("without a signal nothing changes: the request is sent and answered", async () => {
    const sent: string[] = [];
    const r = await espnRequest(
      { http: okHttp(sent), limiter: new MemoryLimiterRepo(), clock, origin: "server" },
      { url: SEASON_URL, cookie: null },
    );
    expect("status" in r && r.status).toBe(200);
    expect(sent).toEqual([SEASON_URL]);
  });
});
