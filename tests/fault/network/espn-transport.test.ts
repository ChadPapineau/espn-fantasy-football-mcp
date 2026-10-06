// espn-transport.test.ts — plan 05 §4.1 network fault rows on the ESPN path, through the composed
// transport the provider uses: client.espnGet (one attempt) inside runUpstreamCall (≤ 20 s deadline,
// backoff, breaker). Fake timers drive the clock; an injected fetch is the only "network", and every
// URL it saw is checked at the end: never the write host, never off the read host. The cookie is
// synthetic; the suite asserts it never appears in an error, a log line or a tool error.
import { inspect } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESPN_READ_HOST_DEFAULT } from "../../../src/config/schema.js";
import { isWriteHost } from "../../../src/http/allowlist.js";
import { createCircuitBreaker, type CircuitBreaker } from "../../../src/http/breaker.js";
import { createHttpClient, type EspnResponse, type FetchLike } from "../../../src/http/client.js";
import { runUpstreamCall, type AttemptRecord } from "../../../src/http/deadline.js";
import { HttpError } from "../../../src/http/errors.js";
import { classifyError, toToolError } from "../../../src/mcp/errors.js";
import { PER_CALL_DEADLINE_MS } from "../../../src/providers/platform.js";
import {
  captureLog,
  chunkedBody,
  everyRendering,
  json,
  netError,
  redirect,
  testCookie,
} from "../../http/helpers.js";

const T0 = Date.UTC(2026, 9, 4, 17, 0, 0);
const LEAGUE = "7".repeat(8);
const URL_ROSTER = `https://${ESPN_READ_HOST_DEFAULT}/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${LEAGUE}?view=mRoster&scoringPeriodId=4`;
const COOKIE = testCookie("F");

/** Every URL any fake fetch in this file was asked for. */
const seen: string[] = [];
/** Every error and log line produced, for the cookie audit. */
const artefacts: string[] = [];

afterAll(() => {
  expect(seen.length).toBeGreaterThan(0);
  for (const u of seen) {
    const host = new URL(u).hostname;
    expect(isWriteHost(host), u).toBe(false);
    expect(host).toBe(ESPN_READ_HOST_DEFAULT);
  }
  for (const a of artefacts) {
    expect(a).not.toContain(COOKIE);
    expect(a).not.toContain(LEAGUE);
  }
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

type Step = Response | Error | "hang";

/** A fetch scripted per call (the last step repeats), recording every URL. */
function scripted(steps: readonly Step[]): {
  fetch: FetchLike;
  readonly calls: number;
  cookies: (string | null)[];
} {
  const state = { calls: 0 };
  const cookies: (string | null)[] = [];
  const fetch: FetchLike = (url, init) => {
    seen.push(url);
    cookies.push(new Headers(init.headers).get("cookie"));
    const step = steps[Math.min(state.calls, steps.length - 1)] ?? "hang";
    state.calls++;
    if (step === "hang") return new Promise<Response>(() => undefined); // a black hole ignores its signal
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(step.clone());
  };
  return {
    fetch,
    get calls() {
      return state.calls;
    },
    cookies,
  };
}

interface Harness {
  readonly breaker: CircuitBreaker;
  readonly log: ReturnType<typeof captureLog>;
  call(
    f: FetchLike,
    cookie?: string | null,
  ): Promise<{ value?: EspnResponse; error?: unknown; elapsed: number; records: AttemptRecord[] }>;
}

function harness(breaker: CircuitBreaker = createCircuitBreaker()): Harness {
  const log = captureLog();
  return {
    breaker,
    log,
    async call(f, cookie = COOKIE) {
      const client = createHttpClient({ fetch: f, log: log.log });
      const records: AttemptRecord[] = [];
      const start = Date.now();
      const box: { out: { value?: EspnResponse; error?: unknown } | null } = { out: null };
      runUpstreamCall(
        (ctx) =>
          client.espnGet(URL_ROSTER, { signal: ctx.signal, cookie, timeoutMs: ctx.timeoutMs }),
        {
          deadlineAtMs: start + PER_CALL_DEADLINE_MS,
          signal: new AbortController().signal,
          clock: { nowMs: () => Date.now() },
          rng: { next: () => 0.5 },
          breaker,
          outcomeOf: (r) =>
            r.status === 304 ? "not_modified" : r.status >= 400 ? "client_error" : "ok",
          onAttempt: (r) => records.push(r),
        },
      ).then(
        (r) => (box.out = { value: r.value }),
        (error: unknown) => (box.out = { error }),
      );
      for (let i = 0; i < 20 && box.out === null; i++) await vi.advanceTimersByTimeAsync(0);
      for (let t = 0; t < 60_000 && box.out === null; t += 10)
        await vi.advanceTimersByTimeAsync(10);
      const settled = box.out;
      if (settled === null) throw new Error("the call never settled");
      if (settled.error !== undefined) {
        artefacts.push(
          everyRendering(settled.error),
          inspect(settled.error, { depth: 6 }),
          JSON.stringify(toToolError(settled.error, "r-abc123def456")),
        );
      }
      artefacts.push(JSON.stringify(log.lines));
      return { ...settled, elapsed: Date.now() - start, records };
    },
  };
}

const code = (e: unknown): string => classifyError(e).code;

describe("plan 05 §4.1 — retryable faults: 3 attempts inside the deadline, then the breaker", () => {
  it("429 (synthetic) → RATE_LIMITED after 3 attempts with backoff; no 4th attempt", async () => {
    const f = scripted([new Response("", { status: 429 })]);
    const h = harness();
    const r = await h.call(f.fetch);
    expect(code(r.error)).toBe("RATE_LIMITED");
    expect(f.calls).toBe(3);
    expect(r.records.map((x) => x.outcome)).toEqual([
      "rate_limited",
      "rate_limited",
      "rate_limited",
    ]);
    expect(r.elapsed).toBeGreaterThanOrEqual(3000); // ~1 s + ~2 s of backoff
    expect(r.elapsed).toBeLessThanOrEqual(PER_CALL_DEADLINE_MS);
  });

  it.each([500, 503])(
    "%i → ESPN_UPSTREAM_UNAVAILABLE after 3 attempts; the breaker opens; the next call sends nothing",
    async (status) => {
      const f = scripted([new Response("<html>oops</html>", { status })]);
      const h = harness();
      const r = await h.call(f.fetch);
      expect(code(r.error)).toBe("ESPN_UPSTREAM_UNAVAILABLE");
      expect((r.error as HttpError).status).toBe(status);
      expect(f.calls).toBe(3);
      expect(h.breaker.status(Date.now()).state).toBe("open");
      const g = scripted([json({})]);
      const r2 = await h.call(g.fetch);
      expect((r2.error as HttpError).kind).toBe("breaker_open");
      expect(code(r2.error)).toBe("ESPN_UPSTREAM_UNAVAILABLE");
      expect(g.calls).toBe(0);
    },
  );

  it.each([
    ["timeout (AbortError)", "hang" as const],
    ["ECONNRESET", netError("ECONNRESET")],
  ])("%s → ESPN_UPSTREAM_UNAVAILABLE within 20 s; at most 3 attempts", async (_what, step) => {
    const f = scripted([step]);
    const r = await harness().call(f.fetch);
    expect(code(r.error)).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(f.calls).toBeLessThanOrEqual(3);
    expect(r.elapsed).toBeLessThanOrEqual(PER_CALL_DEADLINE_MS);
  });

  it("black hole (DNS resolves, every attempt times out) → one call ≤ 20 s; the breaker counts it", async () => {
    const f = scripted(["hang"]);
    const h = harness();
    const r = await h.call(f.fetch);
    expect((r.error as HttpError).kind).toBe("timeout");
    expect(code(r.error)).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(r.elapsed).toBeLessThanOrEqual(PER_CALL_DEADLINE_MS);
    expect(f.calls).toBe(2); // 15 s + ~1 s backoff + the ~4 s left — never a retry past 20 s
    expect(h.breaker.status(Date.now()).consecutive_failures).toBe(2);
  });

  it("a recovery inside the call: 503 then 200 → the answer, breaker reset", async () => {
    const f = scripted([new Response("", { status: 503 }), json({ teams: [] })]);
    const h = harness();
    const r = await h.call(f.fetch);
    expect(r.value?.status).toBe(200);
    expect(f.calls).toBe(2);
    expect(h.breaker.status(Date.now()).consecutive_failures).toBe(0);
  });
});

describe("plan 05 §4.1 — never-retried faults", () => {
  it.each(["ENOTFOUND", "ECONNREFUSED"])(
    "%s → ESPN_UPSTREAM_UNAVAILABLE immediately, zero retries, the breaker counter moves",
    async (c) => {
      const f = scripted([netError(c)]);
      const h = harness();
      const r = await h.call(f.fetch);
      expect(code(r.error)).toBe("ESPN_UPSTREAM_UNAVAILABLE");
      expect((r.error as HttpError).causeCode).toBe(c);
      expect(f.calls).toBe(1);
      expect(r.elapsed).toBe(0);
      expect(h.breaker.status(Date.now()).consecutive_failures).toBe(1);
    },
  );

  it.each([
    [401, { details: [{ type: "AUTH_LEAGUE_NOT_VISIBLE" }] }],
    [403, { details: [] }],
    [404, { details: [{ type: "GENERAL_NOT_FOUND" }] }],
    [400, { details: [{ type: "FILTER_LIMIT_MISSING_SORT" }] }],
  ])(
    "%i is returned once for the provider to classify — no second request",
    async (status, body) => {
      const f = scripted([json(body, status)]);
      const h = harness();
      const r = await h.call(f.fetch);
      expect(r.value?.status).toBe(status);
      expect(JSON.parse(new TextDecoder().decode(r.value?.body))).toEqual(body);
      expect(f.calls).toBe(1);
      expect(h.breaker.status(Date.now()).consecutive_failures).toBe(0);
    },
  );

  it("302 to https://www.espn.com/fantasy/ → ESPN_HOST_MOVED; not followed; the cookie sent only to the read host", async () => {
    const f = scripted([redirect("https://www.espn.com/fantasy/", 302)]);
    const h = harness();
    const r = await h.call(f.fetch);
    expect(code(r.error)).toBe("ESPN_HOST_MOVED");
    expect(f.calls).toBe(1);
    expect(f.cookies).toEqual([COOKIE]);
    // the provider force-opens the breaker on a host move (plan 05 §4.1 "breaker open")
    h.breaker.trip(Date.now());
    const g = scripted([json({})]);
    expect((await h.call(g.fetch)).error).toMatchObject({ kind: "breaker_open" });
    expect(g.calls).toBe(0);
  });

  it("a non-JSON 200 (the P26 'Access Denied' page) is returned bounded, for the provider to refuse", async () => {
    const f = scripted([
      new Response("<html>Access Denied</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]);
    const r = await harness().call(f.fetch);
    expect(r.value?.status).toBe(200);
    expect(r.value?.headers["content-type"]).toBe("text/html");
    expect(f.calls).toBe(1);
  });

  it("an oversized body (> 8 MB, streamed, no Content-Length) → ESPN_UPSTREAM_UNAVAILABLE, bounded memory", async () => {
    const body = chunkedBody(10_000, 64 * 1024);
    const f = scripted([new Response(body.stream, { status: 200 })]);
    const r = await harness().call(f.fetch);
    expect((r.error as HttpError).kind).toBe("too_large");
    expect(code(r.error)).toBe("ESPN_UPSTREAM_UNAVAILABLE");
    expect(body.pulled()).toBeLessThanOrEqual(8 * 16 + 4); // 8 MB / 64 KB chunks (+ stream read-ahead), then stop
    expect(f.calls).toBe(1);
  });
});

describe("the breaker across calls (plan 01 §6: a dead host costs 3 requests, then one per 5 minutes)", () => {
  it("open → zero requests for 5 minutes → one probe → closed on success", async () => {
    const h = harness();
    const dead = scripted([new Response("", { status: 503 })]);
    await h.call(dead.fetch);
    expect(dead.calls).toBe(3);
    const blocked = scripted([json({})]);
    for (let i = 0; i < 5; i++)
      expect((await h.call(blocked.fetch)).error).toMatchObject({ kind: "breaker_open" });
    expect(blocked.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    const probe = scripted([json({ ok: 1 })]);
    expect((await h.call(probe.fetch)).value?.status).toBe(200);
    expect(probe.calls).toBe(1);
    expect(h.breaker.status(Date.now()).state).toBe("closed");
  });

  it("a failed probe re-opens for another full window", async () => {
    const h = harness();
    await h.call(scripted([new Response("", { status: 500 })]).fetch);
    await vi.advanceTimersByTimeAsync(300_000);
    const probe = scripted([new Response("", { status: 500 })]);
    await h.call(probe.fetch);
    expect(probe.calls).toBe(1); // the half-open probe, and no retry once it re-opened
    expect(h.breaker.status(Date.now()).state).toBe("open");
  });
});

describe("keyless calls carry no cookie at all", () => {
  it("a keyless call on the same transport sends no Cookie header", async () => {
    const f = scripted([json({})]);
    await harness().call(f.fetch, null);
    expect(f.cookies).toEqual([null]);
  });
});
