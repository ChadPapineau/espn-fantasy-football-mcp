// deadline.test.ts — runUpstreamCall (plan 01 §6 + ADV OBJ-20): ≤ 20 s total with the retries
// inside it, a retry only when the deadline leaves room, backoff 1/2/4/8 s ±25 % only on
// 429/5xx/timeouts/resets, Retry-After honoured, ENOTFOUND/ECONNREFUSED/4xx never retried, the
// breaker consulted before every attempt. Fake timers drive the clock; no network.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESPN_BACKOFF } from "../../src/config/schema.js";
import { createCircuitBreaker } from "../../src/http/breaker.js";
import {
  backoffDelayMs,
  MIN_ATTEMPT_MS,
  runUpstreamCall,
  type AttemptContext,
  type AttemptRecord,
  type UpstreamCallOptions,
} from "../../src/http/deadline.js";
import { HttpError } from "../../src/http/errors.js";
import { ATTEMPT_TIMEOUT_MS, PER_CALL_DEADLINE_MS } from "../../src/providers/platform.js";

const T0 = Date.UTC(2026, 9, 4, 17, 0, 0);
const clock = { nowMs: () => Date.now() };
const rng = (u = 0.5) => ({ next: () => u });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

function opts<T>(over: Partial<UpstreamCallOptions<T>> = {}): UpstreamCallOptions<T> {
  return {
    deadlineAtMs: Date.now() + PER_CALL_DEADLINE_MS,
    signal: new AbortController().signal,
    clock,
    rng: rng(),
    ...over,
  };
}

/** Settles `p` while advancing fake time in steps; returns the outcome and the elapsed ms. */
async function settle<T>(
  p: Promise<T>,
  maxMs = 120_000,
): Promise<{ value?: T; error?: unknown; elapsed: number }> {
  const start = Date.now();
  // a box, not a `let`: the callbacks set it during the awaits below, which TS's narrowing cannot see
  const box: { out: { value?: T; error?: unknown } | null } = { out: null };
  p.then(
    (value) => (box.out = { value }),
    (error: unknown) => (box.out = { error }),
  );
  for (let i = 0; i < 20 && box.out === null; i++) await vi.advanceTimersByTimeAsync(0);
  for (let t = 0; t <= maxMs && box.out === null; t += 10) await vi.advanceTimersByTimeAsync(10);
  if (box.out === null) throw new Error("did not settle");
  return { ...box.out, elapsed: Date.now() - start };
}

const http = (
  kind: HttpError["kind"],
  extra: Partial<ConstructorParameters<typeof HttpError>[0]> = {},
) => new HttpError({ kind, espn: true, ...extra });

describe("backoffDelayMs (1, 2, 4, 8 s ±25 %)", () => {
  it("nominal delays at u = 0.5, capped at 8 s", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, ESPN_BACKOFF, 0.5))).toEqual([
      1000, 2000, 4000, 8000, 8000, 8000,
    ]);
    expect(ESPN_BACKOFF).toEqual({ baseMs: 1000, maxMs: 8000, jitter: 0.25, maxAttempts: 3 });
  });
  it("property: always within ±25 % of nominal; a bad u reads as nominal", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (n, u) => {
          const nominal = Math.min(8000, 1000 * 2 ** (n - 1));
          const d = backoffDelayMs(n, ESPN_BACKOFF, u);
          expect(d).toBeGreaterThanOrEqual(Math.floor(nominal * 0.75));
          expect(d).toBeLessThanOrEqual(Math.ceil(nominal * 1.25));
        },
      ),
    );
    for (const u of [Number.NaN, -1, 1, 5]) expect(backoffDelayMs(1, ESPN_BACKOFF, u)).toBe(1000);
    expect(backoffDelayMs(0, ESPN_BACKOFF, 0.5)).toBe(1000);
  });
});

describe("runUpstreamCall: retries", () => {
  it("first-try success: one attempt, outcome ok, the breaker fed", async () => {
    const records: AttemptRecord[] = [];
    const breaker = createCircuitBreaker();
    const r = await runUpstreamCall(
      () => Promise.resolve("v"),
      opts({ breaker, onAttempt: (x) => records.push(x) }),
    );
    expect(r).toEqual({ value: "v", attempts: 1 });
    expect(records).toEqual([{ attempt: 1, outcome: "ok", kind: null, ms: 0 }]);
    expect(breaker.status(Date.now()).consecutive_failures).toBe(0);
  });

  it("5xx then success: one backoff of ~1 s, two attempts", async () => {
    let n = 0;
    const p = runUpstreamCall(
      () => (++n === 1 ? Promise.reject(http("http_5xx", { status: 503 })) : Promise.resolve(n)),
      opts(),
    );
    const r = await settle(p);
    expect(r.value).toEqual({ value: 2, attempts: 2 });
    expect(r.elapsed).toBeGreaterThanOrEqual(750);
    expect(r.elapsed).toBeLessThanOrEqual(1300);
  });

  it.each([
    ["http_5xx", { status: 500 }],
    ["rate_limited", { status: 429 }],
    ["timeout", {}],
    ["reset", { causeCode: "ECONNRESET" }],
  ] as const)("%s ×3 → 3 attempts, never a 4th, the last error thrown", async (kind, extra) => {
    let n = 0;
    const records: AttemptRecord[] = [];
    const p = runUpstreamCall(
      () => {
        n++;
        return Promise.reject(http(kind, extra));
      },
      opts({ onAttempt: (x) => records.push(x) }),
    );
    const r = await settle(p);
    expect(r.error).toBeInstanceOf(HttpError);
    expect((r.error as HttpError).kind).toBe(kind);
    expect(n).toBe(3);
    expect(records.map((x) => x.attempt)).toEqual([1, 2, 3]);
    expect(r.elapsed).toBeLessThanOrEqual(PER_CALL_DEADLINE_MS);
  });

  it.each([
    ["dns", "ENOTFOUND"],
    ["dns", "EAI_AGAIN"],
    ["connect", "ECONNREFUSED"],
    ["connect", "EHOSTUNREACH"],
    ["tls", "CERT_HAS_EXPIRED"],
    ["network", null],
    ["too_large", null],
    ["redirect_refused", null],
  ] as const)("%s (%s) is never retried: exactly one attempt, immediately", async (kind, code) => {
    let n = 0;
    const breaker = createCircuitBreaker();
    const p = runUpstreamCall(() => {
      n++;
      return Promise.reject(http(kind, { causeCode: code }));
    }, opts({ breaker }));
    const r = await settle(p);
    expect((r.error as HttpError).kind).toBe(kind);
    expect(n).toBe(1);
    expect(r.elapsed).toBe(0);
    expect(breaker.status(Date.now()).consecutive_failures).toBe(1);
  });

  it("a 4xx answer is a value, never retried; outcomeOf classifies it for the breaker", async () => {
    const breaker = createCircuitBreaker();
    breaker.record("server_error", Date.now());
    breaker.record("server_error", Date.now());
    const records: AttemptRecord[] = [];
    const r = await runUpstreamCall(() => Promise.resolve({ status: 404 }), {
      ...opts<{ status: number }>({ breaker, onAttempt: (x) => records.push(x) }),
      outcomeOf: (v) =>
        v.status === 304 ? "not_modified" : v.status >= 400 ? "client_error" : "ok",
    });
    expect(r.attempts).toBe(1);
    expect(records[0]?.outcome).toBe("client_error");
    expect(breaker.status(Date.now()).consecutive_failures).toBe(0);
  });

  it("Retry-After is honoured when the deadline leaves room", async () => {
    let n = 0;
    const p = runUpstreamCall(
      () =>
        ++n === 1
          ? Promise.reject(http("rate_limited", { status: 429, retryAfterS: 4 }))
          : Promise.resolve("ok"),
      opts(),
    );
    const r = await settle(p);
    expect(r.value?.attempts).toBe(2);
    expect(r.elapsed).toBeGreaterThanOrEqual(4000);
    expect(r.elapsed).toBeLessThan(4100);
  });

  it("a Retry-After past the deadline ends the call at once with the 429", async () => {
    let n = 0;
    const p = runUpstreamCall(() => {
      n++;
      return Promise.reject(http("rate_limited", { status: 429, retryAfterS: 30 }));
    }, opts());
    const r = await settle(p);
    expect((r.error as HttpError).kind).toBe("rate_limited");
    expect(n).toBe(1);
    expect(r.elapsed).toBe(0);
  });
});

describe("runUpstreamCall: the 20 s deadline (ADV OBJ-20)", () => {
  it("black hole (every attempt hangs, ignoring its signal): one call ≤ 20 s, timeouts inside it", async () => {
    const starts: { at: number; timeoutMs: number }[] = [];
    const p = runUpstreamCall((ctx: AttemptContext) => {
      starts.push({ at: Date.now() - T0, timeoutMs: ctx.timeoutMs });
      return new Promise<never>(() => undefined);
    }, opts());
    const r = await settle(p);
    expect((r.error as HttpError).kind).toBe("timeout");
    expect(r.elapsed).toBeLessThanOrEqual(PER_CALL_DEADLINE_MS);
    expect(starts[0]).toEqual({ at: 0, timeoutMs: ATTEMPT_TIMEOUT_MS });
    expect(starts).toHaveLength(2);
    // the retry starts after ~1 s backoff and gets only what is left of the 20 s
    const second = starts[1];
    expect(second).toBeDefined();
    if (second) {
      expect(second.at + second.timeoutMs).toBeLessThanOrEqual(PER_CALL_DEADLINE_MS);
      expect(second.timeoutMs).toBeGreaterThanOrEqual(MIN_ATTEMPT_MS);
    }
  });

  it("a caller deadline past 20 s is clamped to 20 s", async () => {
    const p = runUpstreamCall(
      () => new Promise<never>(() => undefined),
      opts({ deadlineAtMs: Date.now() + 120_000 }),
    );
    const r = await settle(p);
    expect(r.elapsed).toBeLessThanOrEqual(PER_CALL_DEADLINE_MS);
  });

  it("a shorter caller deadline is honoured; no retry that would run past it", async () => {
    let n = 0;
    const p = runUpstreamCall(
      () => {
        n++;
        return Promise.reject(http("http_5xx", { status: 500 }));
      },
      opts({ deadlineAtMs: Date.now() + 1500 }),
    );
    const r = await settle(p);
    expect(n).toBe(1); // 1 s backoff + 1 s minimum attempt > 1.5 s
    expect(r.elapsed).toBe(0);
  });

  it("a deadline already passed → `deadline`, zero attempts", async () => {
    let n = 0;
    await expect(
      runUpstreamCall(
        () => {
          n++;
          return Promise.resolve(1);
        },
        opts({ deadlineAtMs: Date.now() }),
      ),
    ).rejects.toMatchObject({ kind: "deadline", espn: true });
    await expect(
      runUpstreamCall(() => Promise.resolve(1), opts({ deadlineAtMs: Number.NaN })),
    ).rejects.toMatchObject({
      kind: "deadline",
    });
    expect(n).toBe(0);
  });

  it("an attempt that resolves just before its timeout wins; no timer is left behind", async () => {
    const p = runUpstreamCall(
      () =>
        new Promise<string>((res) => {
          setTimeout(() => {
            res("late");
          }, ATTEMPT_TIMEOUT_MS - 1);
        }),
      opts(),
    );
    const r = await settle(p);
    expect(r.value).toEqual({ value: "late", attempts: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("runUpstreamCall: breaker, aborts, hooks", () => {
  it("an open breaker → breaker_open with retry_after, zero attempts", async () => {
    const breaker = createCircuitBreaker();
    breaker.trip(Date.now());
    let n = 0;
    const e = await runUpstreamCall(() => {
      n++;
      return Promise.resolve(1);
    }, opts({ breaker })).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "breaker_open", retryAfterS: 300, espn: true });
    expect(n).toBe(0);
  });

  it("the breaker opening mid-call (3rd consecutive failure) stops the retries", async () => {
    const breaker = createCircuitBreaker();
    breaker.record("server_error", Date.now());
    breaker.record("server_error", Date.now());
    let n = 0;
    const r = await settle(
      runUpstreamCall(() => {
        n++;
        return Promise.reject(http("http_5xx", { status: 500 }));
      }, opts({ breaker })),
    );
    expect((r.error as HttpError).kind).toBe("http_5xx");
    expect(n).toBe(1);
    expect(breaker.status(Date.now()).state).toBe("open");
  });

  it("a half-open breaker lets exactly one concurrent call through", async () => {
    const breaker = createCircuitBreaker();
    breaker.trip(Date.now(), Date.now() + 1);
    await vi.advanceTimersByTimeAsync(2);
    let n = 0;
    const hang = () => {
      n++;
      return new Promise<number>((res) => {
        setTimeout(() => {
          res(1);
        }, 100);
      });
    };
    const a = runUpstreamCall(hang, opts({ breaker }));
    const b = runUpstreamCall(hang, opts({ breaker })).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(200);
    expect((await a).value).toBe(1);
    expect(await b).toMatchObject({ kind: "breaker_open" });
    expect(n).toBe(1);
  });

  it("the caller's abort mid-attempt → aborted, no retry", async () => {
    const ac = new AbortController();
    let n = 0;
    const p = runUpstreamCall(
      () => {
        n++;
        return new Promise<never>(() => undefined);
      },
      opts({ signal: ac.signal }),
    );
    const q = p.catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    expect(await q).toMatchObject({ kind: "aborted" });
    expect(n).toBe(1);
  });

  it("an abort during the backoff ends the call with the last error; a pre-aborted call never starts", async () => {
    const ac = new AbortController();
    let n = 0;
    const p = runUpstreamCall(
      () => {
        n++;
        return Promise.reject(http("http_5xx", { status: 500 }));
      },
      opts({ signal: ac.signal }),
    ).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    expect(await p).toMatchObject({ kind: "http_5xx" });
    expect(n).toBe(1);
    const pre = new AbortController();
    pre.abort();
    await expect(
      runUpstreamCall(() => Promise.resolve(1), opts({ signal: pre.signal })),
    ).rejects.toMatchObject({
      kind: "aborted",
    });
  });

  it("an attempt that rejects with an HttpError after the caller aborted reads as aborted", async () => {
    const ac = new AbortController();
    const p = runUpstreamCall(
      () => {
        ac.abort();
        return Promise.reject(http("http_5xx", { status: 500 }));
      },
      opts({ signal: ac.signal }),
    );
    await expect(p).rejects.toMatchObject({ kind: "aborted" });
  });

  it("beforeAttempt (the cross-process limiter) may refuse: its error propagates, no attempt runs", async () => {
    const breaker = createCircuitBreaker();
    breaker.trip(Date.now(), Date.now() + 1);
    await vi.advanceTimersByTimeAsync(2);
    let n = 0;
    const refusal = new Error("limiter: window full");
    await expect(
      runUpstreamCall(
        () => {
          n++;
          return Promise.resolve(1);
        },
        opts({ breaker, beforeAttempt: () => Promise.reject(refusal) }),
      ),
    ).rejects.toBe(refusal);
    expect(n).toBe(0);
    // the half-open probe slot was released
    expect(breaker.check(Date.now())).toEqual({ allowed: true, probe: true });
  });

  it("a non-HttpError from an attempt is rethrown as-is and never retried", async () => {
    const boom = new SyntaxError("parse");
    let n = 0;
    const records: AttemptRecord[] = [];
    await expect(
      runUpstreamCall(
        () => {
          n++;
          return Promise.reject(boom);
        },
        opts({ onAttempt: (x) => records.push(x) }),
      ),
    ).rejects.toBe(boom);
    expect(n).toBe(1);
    expect(records[0]).toMatchObject({ outcome: null, kind: null });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the hostile case under test
    await expect(runUpstreamCall(() => Promise.reject("str"), opts())).rejects.toThrow("non-Error");
  });

  it("a throwing onAttempt or outcomeOf never changes the result", async () => {
    const r = await runUpstreamCall(() => Promise.resolve(7), {
      ...opts<number>({
        onAttempt: () => {
          throw new Error("hook");
        },
      }),
      outcomeOf: () => {
        throw new Error("classify");
      },
    });
    expect(r.value).toBe(7);
  });

  it("validates its options", async () => {
    await expect(
      runUpstreamCall(() => Promise.resolve(1), opts({ attemptTimeoutMs: 0 })),
    ).rejects.toThrow(RangeError);
    await expect(
      runUpstreamCall(
        () => Promise.resolve(1),
        opts({ policy: { ...ESPN_BACKOFF, maxAttempts: 0 } }),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      runUpstreamCall(
        () => Promise.resolve(1),
        opts({ signal: undefined as unknown as AbortSignal }),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      runUpstreamCall(() => Promise.resolve(1), opts({ clock: { nowMs: () => Number.NaN } })),
    ).rejects.toThrow(RangeError);
  });
});
