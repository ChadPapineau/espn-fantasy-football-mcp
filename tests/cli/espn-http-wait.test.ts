// espn-http-wait.test.ts — the CLI's ESPN request helper waiting for the limiter (plan 01 §6; plan 03
// §1.3 exit codes; Stage C findings cli-limiter-unref-timer-exit13 and
// cli-limiter-boundary-retry-rate-limited): the wait holds the event loop (a child process with
// nothing else alive still sends its request and exits 0 — an unreferenced timer ended it with exit
// 13), a retry that wakes on the store's inclusive window boundary is waited for again instead of
// being reported `rate_limited`, and the total wait stays within MAX_LIMITER_WAIT_MS. No network:
// the http client is a stub; the limiter is the real store table (or a stub in the child).
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LIMITER_WAIT_MS, espnRequest, limiterSleep } from "../../src/cli/espn-http.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { fixedClock } from "../../src/domain/clock.js";
import type { HttpClient } from "../../src/http/client.js";
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
