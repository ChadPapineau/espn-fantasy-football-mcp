// espn-pacing.test.ts — the paced run of a long CLI ESPN run (src/cli/espn-pacing.ts; plan 01 §6 and
// D7: ≤ 30/min, ≤ 1/s, ≤ 2 in flight, a read waits for its slot only until its ≤ 20 s deadline;
// the install defect of 2026-11-02: `eff transactions --backfill` died RATE_LIMITED part-way). On
// fake time (a fixed clock moved only by the injected sleep and by each read's own latency): reads
// are paced RUN_PACE_MS apart and a cache hit is not paced after; the limiter's window and
// Retry-After refusals are waited out (retry_after_s + the margin) and the same read runs again; a
// daily cap, a second concurrency refusal in a row and every other failure (ESPN's own 429, a
// look-alike, an unknown reason) are rethrown unchanged at once; a refusal storm stops at
// MAX_CONSECUTIVE_REFUSALS and a long refusal at the wait budget; an abort ends a wait at once (the
// real timer too); over the real EspnLimiter, 37 reads complete and no send passes the windows, with
// pacing and without it. The verifiers' findings on 4141144: a refusal behind the provider's
// STALE_ONLY (a week cached more than a day before) is the refusal, waited on and rethrown as itself
// (F1); a window another process filled is seen before the read (windowFreeInMs, the store's count)
// and waited for there, so the limiter never admits a send in the last moments of the read's
// deadline (F2); a read refused after the signal announces no wait (F3). The verifier's findings on
// fbbd705: the share counts requests — a read starts only while the bucket's last minute leaves
// room for its every attempt (shareFreeInMs), so over the real limiter reads of two or three
// attempts, or a minute of one-attempt reads and then three each, keep the run's own rows within
// RUN_SHARE_PER_MINUTE in any minute; reads of one attempt never wait for it, moments of it are
// silent pacing, a longer wait is announced and bounded (F2); and the run's signal reaches each read
// through a budget of its own, so a read waiting in the limiter is refused before its slot and what
// an aborted read throws is the run's interrupt, while ESPN's own answers fail as themselves (F1).
// No request is made.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENCY_RETRIES,
  MAX_CONSECUTIVE_REFUSALS,
  PacedRun,
  READ_MAX_ROWS,
  RUN_PACE_MS,
  RUN_SHARE_PER_MINUTE,
  RUN_START_MAX_ROWS,
  RunInterrupted,
  WINDOW_WAIT_MARGIN_MS,
  endedByAbort,
  limiterRefusal,
  paceWaitText,
  refusalBehind,
  shareFreeInMs,
  waitBudgetMs,
  windowFreeInMs,
  type PaceWait,
} from "../../src/cli/espn-pacing.js";
import { FUTURE_STAMP_TOLERANCE_MS } from "../../src/config/freshness.js";
import { ESPN_BACKOFF, ESPN_LIMITER } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import { EspnUpstreamError } from "../../src/providers/espn/errors.js";
import { EspnLimiter, EspnRateLimitedError, type Sleep } from "../../src/providers/espn/limiter.js";
import { EspnStaleOnlyError } from "../../src/providers/espn/request.js";
import {
  MAX_UPSTREAM_PER_CALL,
  PER_CALL_DEADLINE_MS,
  UpstreamBudgetExhausted,
  type ReadOptions,
} from "../../src/providers/platform.js";
import { limiterDecision } from "../../src/store/types.js";
import { MemoryLimiterRepo } from "../providers/espn/helpers.js";

const T0 = Date.parse("2026-11-02T20:00:00.000Z");
const abortError = (): DOMException => new DOMException("aborted", "AbortError");

/** Read through a call: a hook run between two checks may abort the signal. */
const isAborted = (signal: AbortSignal | null): boolean => signal?.aborted === true;

/** Fake time: the clock moves only when a sleep or a read's latency moves it. */
function fakeTime(onSleep: (ms: number) => void = () => undefined) {
  const clock = fixedClock(T0);
  const sleeps: number[] = [];
  const sleep: Sleep = (ms, signal) => {
    if (isAborted(signal)) return Promise.reject(abortError());
    sleeps.push(ms);
    onSleep(ms);
    if (isAborted(signal)) return Promise.reject(abortError());
    clock.advance(Math.max(0, ms));
    return Promise.resolve();
  };
  return { clock, sleeps, sleep };
}

const refusal = (ms: number, reason: ConstructorParameters<typeof EspnRateLimitedError>[1]) =>
  new EspnRateLimitedError(ms, reason);

/** What the provider's stale fallback throws past the hard limit: `cause` kept (request.ts). */
const staleOnly = (cause?: unknown) =>
  new EspnStaleOnlyError("mTransactions2", cause === undefined ? undefined : { cause });

/** `n` rows of the shared bucket at `atMs` (another process's burst), newest first. */
const rowsAt = (atMs: number, n: number = ESPN_LIMITER.perMinute): { at: string }[] =>
  Array.from({ length: n }, () => ({ at: new Date(atMs).toISOString() }));

/** A read that throws each of `errors` in turn, then answers `value` (its starts recorded). */
function scripted<T>(
  clock: { nowMs(): number; advance(ms: number): void },
  errors: Error[],
  value: T,
) {
  const starts: number[] = [];
  const fn = (): Promise<T> => {
    starts.push(clock.nowMs());
    clock.advance(300);
    const e = errors.shift();
    return e === undefined ? Promise.resolve(value) : Promise.reject(e);
  };
  return { fn, starts };
}

describe("limiterRefusal: only the local limiter's own refusal is one", () => {
  it("reads the four reasons and the stated wait", () => {
    for (const reason of ["window", "daily_cap", "concurrency", "retry_after"] as const)
      expect(limiterRefusal(refusal(29_400, reason))).toEqual({ reason, retryAfterMs: 30_000 });
  });
  it("ESPN's own 429, a look-alike object, an unknown reason, a wait that is not a number: none", () => {
    expect(
      limiterRefusal(
        new EspnUpstreamError("rate_limited", { upstream_status: 429, retry_after_s: 5 }),
      ),
    ).toBeNull();
    expect(
      limiterRefusal({
        effCode: "RATE_LIMITED",
        effDetails: { reason: "window", retry_after_s: 1 },
      }),
    ).toBeNull();
    expect(limiterRefusal(refusal(1000, "bogus" as never))).toBeNull();
    expect(limiterRefusal(refusal(Number.NaN, "window"))).toBeNull();
    expect(limiterRefusal(new Error("x"))).toBeNull();
    expect(limiterRefusal(null)).toBeNull();
  });
  it("F1: a refusal behind a STALE_ONLY is that refusal; any other STALE_ONLY is none", () => {
    for (const reason of ["window", "daily_cap", "concurrency", "retry_after"] as const) {
      const r = refusal(29_400, reason);
      expect(limiterRefusal(staleOnly(r))).toEqual({ reason, retryAfterMs: 30_000 });
      expect(refusalBehind(staleOnly(r))).toBe(r);
    }
    const espn429 = new EspnUpstreamError("rate_limited", {
      upstream_status: 429,
      retry_after_s: 5,
    });
    for (const e of [
      staleOnly(),
      staleOnly(espn429),
      staleOnly(new Error("x")),
      staleOnly({ effCode: "RATE_LIMITED", effDetails: { reason: "window", retry_after_s: 1 } }),
      // one level only: a STALE_ONLY around a STALE_ONLY around a refusal is none
      staleOnly(staleOnly(refusal(1000, "window"))),
    ]) {
      expect(limiterRefusal(e)).toBeNull();
      expect(refusalBehind(e)).toBe(e);
    }
    // a refusal's cause is never looked at (nothing else is unwrapped)
    const plain = refusal(1000, "window");
    expect(refusalBehind(plain)).toBe(plain);
    expect(refusalBehind(null)).toBeNull();
  });
});

describe("windowFreeInMs: the shared window's next free slot, counted as the store counts it", () => {
  const NOW = T0;
  const rows = (...ats: number[]) =>
    ats.sort((a, b) => b - a).map((at) => ({ at: new Date(at).toISOString() }));
  const full = (oldest: number, n: number = ESPN_LIMITER.perMinute) =>
    Array.from({ length: n }, (_, i) => oldest + i * 10);

  it("no row, 29 rows, rows older than the window: free now", () => {
    expect(windowFreeInMs([], NOW)).toBe(0);
    expect(windowFreeInMs(rows(...full(NOW - 5_000, 29)), NOW)).toBe(0);
    expect(windowFreeInMs(rows(...full(NOW - 60_001 - 500)), NOW)).toBe(0);
  });

  it("30 rows inside the minute: free when the oldest of them leaves it", () => {
    expect(windowFreeInMs(rows(...full(NOW - 40_300)), NOW)).toBe(19_700);
    // the window's start is inclusive (the store's `ts >= now − 60 s`): a row exactly 60 s old still
    // holds its slot; the wait is never below 1 ms
    expect(windowFreeInMs(rows(...full(NOW - 60_000)), NOW)).toBe(1);
    // only the newest 30 rows matter: an older 31st one changes nothing
    expect(windowFreeInMs(rows(...full(NOW - 40_300), NOW - 50_000), NOW)).toBe(19_700);
  });

  it("a row stamped ahead (a clock since set back) holds a slot from now; an unreadable one holds none", () => {
    const ahead = NOW + FUTURE_STAMP_TOLERANCE_MS + 3_600_000;
    const r = [
      { at: new Date(ahead).toISOString() },
      ...rows(...full(NOW - 30_000, ESPN_LIMITER.perMinute - 1)),
    ];
    expect(windowFreeInMs(r, NOW)).toBe(30_000);
    const unreadable = [{ at: "not an instant" }, ...rows(...full(NOW - 30_000, 29))];
    expect(windowFreeInMs(unreadable, NOW)).toBe(0);
  });

  it("property: free at its answer + 1 ms by the store's own decision, full a moment before", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -120_000, max: 0 }), { maxLength: 45 }), (offsets) => {
        const all = offsets.map((o) => NOW + o);
        const newestFirst = rows(...all);
        const decide = (at: number) =>
          limiterDecision({
            nowMs: at,
            windows: [{ startMs: at - 60_000, max: ESPN_LIMITER.perMinute }],
            windowRows: [all.filter((t) => t >= at - 60_000 && t <= at)],
            dailyCap: null,
          }).ok;
        const free = windowFreeInMs(newestFirst, NOW);
        expect(free).toBeGreaterThanOrEqual(0);
        expect(free).toBeLessThanOrEqual(60_001);
        if (free === 0) expect(decide(NOW)).toBe(true);
        else {
          expect(decide(NOW + free - 1)).toBe(false);
          expect(decide(NOW + free + 1)).toBe(true);
        }
      }),
    );
  });
});

describe("shareFreeInMs: room for a read inside the run's share, counted as the store counts it", () => {
  const NOW = T0;

  it("21 rows in the minute: room now; 22: until the 22nd newest leaves it; a full window: never sooner than it frees", () => {
    expect(shareFreeInMs([], NOW)).toBe(0);
    expect(shareFreeInMs(rowsAt(NOW - 5_000, RUN_START_MAX_ROWS), NOW)).toBe(0);
    expect(shareFreeInMs(rowsAt(NOW - 5_000, RUN_START_MAX_ROWS + 1), NOW)).toBe(55_000);
    // newest first: the 22 newest decide; the window's own count is the 30 newest's
    const rows = [
      ...rowsAt(NOW - 1_000, RUN_START_MAX_ROWS),
      ...rowsAt(NOW - 20_000, 1),
      ...rowsAt(NOW - 50_000, 8),
    ];
    expect(windowFreeInMs(rows, NOW)).toBe(10_000);
    expect(shareFreeInMs(rows, NOW)).toBe(40_000);
    expect(windowFreeInMs(rows, NOW, RUN_START_MAX_ROWS + 1)).toBe(40_000);
  });

  it("property: free at its answer + 1 ms by the store's own decision at 22, full a moment before; never before the window", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -120_000, max: 0 }), { maxLength: 45 }), (offsets) => {
        const all = offsets.map((o) => NOW + o);
        const newestFirst = [...all]
          .sort((a, b) => b - a)
          .map((at) => ({ at: new Date(at).toISOString() }));
        const room = (at: number) =>
          all.filter((t) => t >= at - 60_000 && t <= at).length <= RUN_START_MAX_ROWS;
        const free = shareFreeInMs(newestFirst, NOW);
        expect(free).toBeGreaterThanOrEqual(windowFreeInMs(newestFirst, NOW));
        expect(free).toBeLessThanOrEqual(60_001);
        if (free === 0) expect(room(NOW)).toBe(true);
        else {
          expect(room(NOW + free - 1)).toBe(false);
          expect(room(NOW + free + 1)).toBe(true);
        }
      }),
    );
  });
});

describe("waitBudgetMs: the planned reads at 30/min in whole windows, plus one spare window", () => {
  it("the backfill's sizes", () => {
    expect(waitBudgetMs(37)).toBe(180_000);
    expect(waitBudgetMs(39)).toBe(180_000);
    expect(waitBudgetMs(57)).toBe(180_000);
    expect(waitBudgetMs(30)).toBe(120_000);
    expect(waitBudgetMs(31)).toBe(180_000);
    expect(waitBudgetMs(0)).toBe(120_000);
    expect(waitBudgetMs(Number.NaN)).toBe(120_000);
    expect(waitBudgetMs(-5)).toBe(120_000);
  });
  it("property: whole windows, always room for the reads' own windows and one more", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (n) => {
        const b = waitBudgetMs(n);
        expect(b % 60_000).toBe(0);
        expect(b).toBeGreaterThanOrEqual((n / ESPN_LIMITER.perMinute) * 60_000 + 60_000);
        expect(b).toBeLessThan((n / ESPN_LIMITER.perMinute) * 60_000 + 120_000);
      }),
    );
  });
});

describe("pacing", () => {
  it("leaves six slots a minute to the other processes, retries counted", () => {
    expect(RUN_SHARE_PER_MINUTE).toBe(ESPN_LIMITER.perMinute - 6);
    // a read can add its every attempt to the bucket: it starts with room for them in the share
    expect(READ_MAX_ROWS).toBe(ESPN_BACKOFF.maxAttempts);
    expect(RUN_START_MAX_ROWS).toBe(RUN_SHARE_PER_MINUTE - READ_MAX_ROWS);
    expect(RUN_START_MAX_ROWS).toBe(21);
    // 22 reads a minute: reads of one attempt each find room at every start
    expect(RUN_PACE_MS).toBe(2728);
    expect(RUN_PACE_MS * (RUN_START_MAX_ROWS + 1)).toBeGreaterThan(60_000);
    expect(RUN_PACE_MS).toBeGreaterThan(1000 / ESPN_LIMITER.perSecond);
  });

  it("upstream reads start RUN_PACE_MS apart; a cache hit sends nothing and is not paced after", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 10 });
    const starts: number[] = [];
    const read = (hit: boolean) =>
      run.read(
        () => {
          starts.push(t.clock.nowMs());
          t.clock.advance(hit ? 1 : 300);
          return Promise.resolve({ hit });
        },
        (v) => !v.hit,
      );
    await read(false);
    await read(false);
    await read(false);
    expect(starts.map((s) => s - T0)).toEqual([0, RUN_PACE_MS, 2 * RUN_PACE_MS]);
    // a read whose answer turns out a cache hit was paced (nobody knows before), but the read after
    // it is paced from the last UPSTREAM read's start — never from the hit's: it starts at once
    await read(true);
    await read(false);
    expect(starts[3]).toBe(T0 + 3 * RUN_PACE_MS);
    expect((starts[4] ?? 0) - (starts[3] ?? 0)).toBe(1);
    expect(run.reads).toBe(5);
    expect(run.waits).toBe(0);
    expect(run.waitedMs).toBe(0);
  });

  it("a clock set back never makes a pacing wait longer than RUN_PACE_MS", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 2 });
    await run.read(() => Promise.resolve(1));
    t.clock.advance(-3_600_000);
    await run.read(() => Promise.resolve(2));
    expect(Math.max(...t.sleeps)).toBeLessThanOrEqual(RUN_PACE_MS);
  });

  it("paceMs 0 turns pacing off (the waits on refusals stay)", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 3, paceMs: 0 });
    for (let i = 0; i < 3; i++) await run.read(() => Promise.resolve(i));
    expect(t.sleeps).toEqual([]);
  });
});

describe("waiting out the limiter's refusals", () => {
  it.each(["window", "retry_after"] as const)(
    "a %s refusal: retry_after_s plus the margin, one progress event, the same read again",
    async (reason) => {
      const t = fakeTime();
      const waits: PaceWait[] = [];
      const run = new PacedRun({
        clock: t.clock,
        sleep: t.sleep,
        plannedReads: 37,
        onWait: (w) => {
          waits.push(w);
        },
      });
      await run.read(() => Promise.resolve(0));
      const r = scripted(t.clock, [refusal(29_400, reason)], "page");
      expect(await run.read(r.fn)).toBe("page");
      expect(r.starts).toHaveLength(2);
      expect(t.sleeps).toContain(30_000 + WINDOW_WAIT_MARGIN_MS);
      // the retry starts no sooner than the stated wait plus the margin after the refusal
      const [refusedAt = 0, retriedAt = 0] = r.starts;
      expect(retriedAt - refusedAt).toBeGreaterThanOrEqual(30_000 + WINDOW_WAIT_MARGIN_MS);
      expect(waits).toEqual([
        { reason, retry: true, wait_s: 31, reads: 1, waits: 1, budget_s: 180 },
      ]);
      expect(run.waits).toBe(1);
      expect(run.waitedMs).toBe(30_500);
      expect(run.gaveUp).toBeNull();
    },
  );

  it("a spent daily cap is rethrown at once: no wait, no event, no second read", async () => {
    const t = fakeTime();
    let events = 0;
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      plannedReads: 37,
      onWait: () => {
        events++;
      },
    });
    const cap = refusal(3_600_000, "daily_cap");
    const r = scripted(t.clock, [cap], "never");
    await expect(run.read(r.fn)).rejects.toBe(cap);
    expect(r.starts).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
    expect(events).toBe(0);
    expect(run.gaveUp).toBeNull();
  });

  it("one concurrency refusal is retried; a second in a row is rethrown unchanged", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 37 });
    const once = scripted(t.clock, [refusal(250, "concurrency")], "ok");
    expect(await run.read(once.fn)).toBe("ok");
    expect(once.starts).toHaveLength(2);
    expect(t.sleeps).toContain(1000 + WINDOW_WAIT_MARGIN_MS);
    const second = refusal(250, "concurrency");
    const twice = scripted(t.clock, [refusal(250, "concurrency"), second], "never");
    await expect(run.read(twice.fn)).rejects.toBe(second);
    expect(twice.starts).toHaveLength(1 + MAX_CONCURRENCY_RETRIES);
    // repeated concurrency refusals fail as before: not a wait bound
    expect(run.gaveUp).toBeNull();
  });

  it("a window refusal between two concurrency refusals ends the streak", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 37 });
    const r = scripted(
      t.clock,
      [refusal(250, "concurrency"), refusal(5_000, "window"), refusal(250, "concurrency")],
      "ok",
    );
    expect(await run.read(r.fn)).toBe("ok");
    expect(r.starts).toHaveLength(4);
  });

  it("every other failure is rethrown at once, ESPN's own 429 and a cookie rejection among them", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 37 });
    for (const e of [
      new EspnUpstreamError("rate_limited", { upstream_status: 429, retry_after_s: 2 }),
      Object.assign(new Error("rejected"), { effCode: "ESPN_AUTH_REJECTED" }),
      Object.assign(new Error("look-alike"), {
        effCode: "RATE_LIMITED",
        effDetails: { reason: "window", retry_after_s: 1 },
      }),
      refusal(1000, "bogus" as never),
    ]) {
      const r = scripted(t.clock, [e], "never");
      await expect(run.read(r.fn)).rejects.toBe(e);
      expect(r.starts).toHaveLength(1);
    }
    // only the pacing waits ran (each ≤ RUN_PACE_MS), never a refusal's
    expect(t.sleeps.every((ms) => ms <= RUN_PACE_MS)).toBe(true);
    expect(run.waits).toBe(0);
  });
});

describe("F1: a refusal the provider turned into STALE_ONLY (a week cached more than a day before)", () => {
  it("a window or Retry-After refusal behind it is waited out and the same read runs again", async () => {
    for (const reason of ["window", "retry_after"] as const) {
      const t = fakeTime();
      const waits: PaceWait[] = [];
      const run = new PacedRun({
        clock: t.clock,
        sleep: t.sleep,
        plannedReads: 37,
        onWait: (w) => {
          waits.push(w);
        },
      });
      const r = scripted(t.clock, [staleOnly(refusal(29_400, reason))], "page");
      expect(await run.read(r.fn)).toBe("page");
      expect(r.starts).toHaveLength(2);
      expect(t.sleeps).toContain(30_000 + WINDOW_WAIT_MARGIN_MS);
      expect(waits).toEqual([
        { reason, retry: true, wait_s: 31, reads: 0, waits: 1, budget_s: 180 },
      ]);
    }
  });

  it("one not waited on fails as the limiter's refusal (RATE_LIMITED), never as the STALE_ONLY", async () => {
    // a spent daily cap
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 37 });
    const cap = refusal(3_600_000, "daily_cap");
    await expect(run.read(scripted(t.clock, [staleOnly(cap)], "x").fn)).rejects.toBe(cap);
    // a second concurrency refusal in a row
    const second = refusal(250, "concurrency");
    await expect(
      run.read(
        scripted(t.clock, [staleOnly(refusal(250, "concurrency")), staleOnly(second)], "x").fn,
      ),
    ).rejects.toBe(second);
    // past the consecutive bound
    const t2 = fakeTime();
    const run2 = new PacedRun({ clock: t2.clock, sleep: t2.sleep, plannedReads: 1_000 });
    const storm = Array.from({ length: MAX_CONSECUTIVE_REFUSALS + 1 }, () =>
      refusal(10_000, "window"),
    );
    const last = storm[MAX_CONSECUTIVE_REFUSALS];
    await expect(run2.read(scripted(t2.clock, storm.map(staleOnly), "x").fn)).rejects.toBe(last);
    expect(run2.gaveUp).toBe("consecutive");
    // past the budget
    const t3 = fakeTime();
    const run3 = new PacedRun({ clock: t3.clock, sleep: t3.sleep, plannedReads: 37 });
    const long = refusal(3_600_000, "retry_after");
    await expect(run3.read(scripted(t3.clock, [staleOnly(long)], "x").fn)).rejects.toBe(long);
    expect(run3.gaveUp).toBe("budget");
  });

  it("a STALE_ONLY with no refusal behind it is rethrown as is, at once", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 37 });
    for (const e of [
      staleOnly(),
      staleOnly(new EspnUpstreamError("rate_limited", { upstream_status: 429, retry_after_s: 2 })),
      staleOnly(new EspnUpstreamError("timeout", { reason: "attempt_timeout" })),
    ]) {
      const r = scripted(t.clock, [e], "never");
      await expect(run.read(r.fn)).rejects.toBe(e);
      expect(r.starts).toHaveLength(1);
    }
    expect(run.waits).toBe(0);
  });
});

describe("F2: a window another process filled is waited for before the read, not inside it", () => {
  /** A look that answers each of `answers` in turn (then no row: free), its calls counted. */
  function look(answers: (readonly { at: string }[] | Error)[]) {
    let calls = 0;
    const fn = (): readonly { at: string }[] => {
      calls++;
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? [];
    };
    return { fn, calls: () => calls };
  }

  it("seen full: its time to free in whole seconds plus the margin, one event, then one read", async () => {
    const t = fakeTime();
    const waits: PaceWait[] = [];
    // 30 rows of another process 40.299 s old: the window frees in 19.701 s
    const l = look([rowsAt(T0 - 40_299)]);
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      plannedReads: 37,
      bucketRows: l.fn,
      onWait: (w) => {
        waits.push(w);
      },
    });
    const r = scripted(t.clock, [], "page");
    expect(await run.read(r.fn)).toBe("page");
    expect(r.starts).toEqual([T0 + 20_000 + WINDOW_WAIT_MARGIN_MS]);
    expect(t.sleeps).toEqual([20_000 + WINDOW_WAIT_MARGIN_MS]);
    expect(waits).toEqual([
      { reason: "window", retry: false, wait_s: 21, reads: 0, waits: 1, budget_s: 180 },
    ]);
    expect(run.waits).toBe(1);
    expect(run.waitedMs).toBe(20_500);
    // looked again after the wait (free), and before nothing else
    expect(l.calls()).toBe(2);
  });

  it("free, room in the share, rows past the minute, unreadable or failing: no wait (the limiter decides as always)", async () => {
    for (const a of [
      [],
      rowsAt(T0 - 5_000, RUN_START_MAX_ROWS),
      rowsAt(T0 - 60_001),
      Array.from({ length: ESPN_LIMITER.perMinute }, () => ({ at: "not an instant" })),
      new Error("store busy"),
    ]) {
      const t = fakeTime();
      const run = new PacedRun({
        clock: t.clock,
        sleep: t.sleep,
        plannedReads: 37,
        bucketRows: look([a]).fn,
      });
      expect(await run.read(() => Promise.resolve(1))).toBe(1);
      expect(t.sleeps).toEqual([]);
      expect(run.waits).toBe(0);
    }
  });

  it("a window refused after the look is still waited out, and a retry after a refusal says so", async () => {
    const t = fakeTime();
    const waits: PaceWait[] = [];
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      plannedReads: 37,
      // free at the first look; full at the second (after the read's 300 ms and the refusal's
      // 30.5 s wait), freeing 4 s later
      bucketRows: look([[], rowsAt(T0 + 30_800 - 56_000)]).fn,
      onWait: (w) => {
        waits.push(w);
      },
    });
    const r = scripted(t.clock, [refusal(29_400, "window")], "page");
    expect(await run.read(r.fn)).toBe("page");
    expect(r.starts).toHaveLength(2);
    expect(waits.map((w) => [w.reason, w.retry, w.wait_s])).toEqual([
      ["window", true, 31],
      ["window", true, 5],
    ]);
  });

  it("waits counted with the refusals: past MAX_CONSECUTIVE_REFUSALS the read goes to the limiter as it is", async () => {
    const t = fakeTime();
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      plannedReads: 1_000,
      // another process keeps the window full: it frees 10 s after every look
      bucketRows: () => rowsAt(t.clock.nowMs() - 50_000),
    });
    // never refused: the read runs once the waits are spent, and its answer stands
    const ok = scripted(t.clock, [], "page");
    expect(await run.read(ok.fn)).toBe("page");
    expect(ok.starts).toHaveLength(1);
    expect(run.waits).toBe(MAX_CONSECUTIVE_REFUSALS);
    // refused then: that refusal is past the bound and rethrown
    const refused = refusal(10_000, "window");
    const r = scripted(t.clock, [refused], "never");
    await expect(run.read(r.fn)).rejects.toBe(refused);
    expect(r.starts).toHaveLength(1);
    expect(run.waits).toBe(2 * MAX_CONSECUTIVE_REFUSALS);
    expect(run.gaveUp).toBe("consecutive");
  });

  it("a wait that would pass the budget is not started: the read goes to the limiter as it is", async () => {
    const t = fakeTime();
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      plannedReads: 1,
      bucketRows: () => rowsAt(t.clock.nowMs() - 1_000),
    });
    expect(run.budgetMs).toBe(120_000);
    expect(await run.read(() => Promise.resolve(1))).toBe(1);
    expect(run.waits).toBe(2);
    expect(run.waitedMs).toBe(2 * 59_500);
    expect(run.waitedMs).toBeLessThanOrEqual(run.budgetMs);
    expect(run.gaveUp).toBeNull();
  });

  it("an abort during the wait: RunInterrupted, the read never starts", async () => {
    const ac = new AbortController();
    const t = fakeTime((ms) => {
      if (ms > RUN_PACE_MS) ac.abort();
    });
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      signal: ac.signal,
      plannedReads: 37,
      bucketRows: () => rowsAt(t.clock.nowMs() - 30_000),
    });
    let called = 0;
    await expect(
      run.read(() => {
        called++;
        return Promise.resolve(1);
      }),
    ).rejects.toBeInstanceOf(RunInterrupted);
    expect(called).toBe(0);
    expect(run.waitedMs).toBe(0);
  });

  it("over the real limiter: 30 rows 40.3 s old — the send waits for them here and has its whole deadline", async () => {
    const repo = new MemoryLimiterRepo();
    const t = fakeTime();
    for (let i = 0; i < ESPN_LIMITER.perMinute; i++)
      repo.rows.push({
        id: 10_000 + i,
        at: T0 - 40_300,
        keyless: false,
        origin: "server",
        outcome: "ok",
      });
    const limiterSleeps: number[] = [];
    const limiter = new EspnLimiter({
      repo,
      clock: t.clock,
      origin: "server",
      sleep: (ms, signal) => {
        limiterSleeps.push(ms);
        return t.sleep(ms, signal);
      },
    });
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      plannedReads: 37,
      bucketRows: () => repo.recentOutcomes(ESPN_LIMITER.perMinute),
    });
    let left = -1;
    await run.read(async () => {
      const deadline = t.clock.nowMs() + 20_000;
      const ticket = await limiter.acquire({
        keyless: false,
        deadlineAtMs: deadline,
        signal: null,
      });
      left = deadline - ticket.atMs;
      t.clock.advance(250);
      ticket.finish("ok");
    });
    // the limiter never waited inside the read: the attempt had the whole ≤ 20 s deadline
    expect(limiterSleeps).toEqual([]);
    expect(left).toBe(20_000);
    expect(run.waits).toBe(1);
    // and the send was admitted only once the other process's rows had left the window
    const ours = repo.rows.filter((r) => r.id < 10_000).map((r) => r.at);
    expect(ours).toHaveLength(1);
    expect((ours[0] ?? 0) - (T0 - 40_300)).toBeGreaterThan(60_000);
  });
});

describe("F3: a read refused after the signal announces no wait", () => {
  it("the abort lands while the read is in flight, the read is then refused: RunInterrupted, no event", async () => {
    const ac = new AbortController();
    const t = fakeTime();
    const waits: PaceWait[] = [];
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      signal: ac.signal,
      plannedReads: 37,
      onWait: (w) => {
        waits.push(w);
      },
    });
    await expect(
      run.read(() => {
        ac.abort();
        return Promise.reject(refusal(30_000, "window"));
      }),
    ).rejects.toBeInstanceOf(RunInterrupted);
    expect(waits).toEqual([]);
    expect(run.waits).toBe(0);
    expect(t.sleeps).toEqual([]);
    // a failure that is no refusal still fails as itself (the read's own outcome), not as an interrupt
    const ac2 = new AbortController();
    const run2 = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      signal: ac2.signal,
      plannedReads: 3,
    });
    const boom = Object.assign(new Error("rejected"), { effCode: "ESPN_AUTH_REJECTED" });
    await expect(
      run2.read(() => {
        ac2.abort();
        return Promise.reject(boom);
      }),
    ).rejects.toBe(boom);
  });
});

describe("the bounds", () => {
  it("a refusal storm stops after MAX_CONSECUTIVE_REFUSALS waits; the last refusal is rethrown", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 1_000 });
    const errors = Array.from({ length: MAX_CONSECUTIVE_REFUSALS + 5 }, () =>
      refusal(10_000, "window"),
    );
    const last = errors[MAX_CONSECUTIVE_REFUSALS];
    const r = scripted(t.clock, errors, "never");
    await expect(run.read(r.fn)).rejects.toBe(last);
    expect(r.starts).toHaveLength(MAX_CONSECUTIVE_REFUSALS + 1);
    expect(run.waits).toBe(MAX_CONSECUTIVE_REFUSALS);
    expect(run.gaveUp).toBe("consecutive");
  });

  it("the total waits stay within the budget; a wait that would pass it is not started", async () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 1 });
    expect(run.budgetMs).toBe(120_000);
    const r = scripted(
      t.clock,
      Array.from({ length: 5 }, () => refusal(59_000, "window")),
      "x",
    );
    await expect(run.read(r.fn)).rejects.toBeInstanceOf(EspnRateLimitedError);
    expect(run.waits).toBe(2);
    expect(run.waitedMs).toBe(2 * 59_500);
    expect(run.waitedMs).toBeLessThanOrEqual(run.budgetMs);
    expect(run.gaveUp).toBe("budget");
    // a single stated wait past the budget (a long Retry-After) is not waited at all
    const t2 = fakeTime();
    const run2 = new PacedRun({ clock: t2.clock, sleep: t2.sleep, plannedReads: 37 });
    const long = refusal(3_600_000, "retry_after");
    await expect(run2.read(scripted(t2.clock, [long], "x").fn)).rejects.toBe(long);
    expect(t2.sleeps).toEqual([]);
    expect(run2.gaveUp).toBe("budget");
  });

  it("plan() raises the budget and never lowers it", () => {
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 37 });
    run.plan(10);
    expect(run.budgetMs).toBe(180_000);
    run.plan(Number.NaN);
    expect(run.budgetMs).toBe(180_000);
    run.plan(61);
    expect(run.budgetMs).toBe(240_000);
  });
});

describe("an abort ends the run at once", () => {
  it("before a read: nothing starts", async () => {
    const t = fakeTime();
    const ac = new AbortController();
    ac.abort();
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      signal: ac.signal,
      plannedReads: 3,
    });
    let called = 0;
    await expect(
      run.read(() => {
        called++;
        return Promise.resolve(1);
      }),
    ).rejects.toBeInstanceOf(RunInterrupted);
    expect(called).toBe(0);
  });

  it("during a refusal's wait: RunInterrupted, the read not retried", async () => {
    const ac = new AbortController();
    const t = fakeTime((ms) => {
      if (ms > RUN_PACE_MS) ac.abort();
    });
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      signal: ac.signal,
      plannedReads: 3,
    });
    const r = scripted(t.clock, [refusal(30_000, "window")], "never");
    await expect(run.read(r.fn)).rejects.toBeInstanceOf(RunInterrupted);
    expect(r.starts).toHaveLength(1);
    expect(run.waitedMs).toBe(0);
  });

  it("during a pacing wait, and after a sleep that ignored the signal", async () => {
    const ac = new AbortController();
    const t = fakeTime();
    const deaf: Sleep = (ms) => {
      ac.abort();
      t.clock.advance(ms);
      return Promise.resolve();
    };
    const run = new PacedRun({ clock: t.clock, sleep: deaf, signal: ac.signal, plannedReads: 3 });
    await run.read(() => Promise.resolve(1));
    await expect(run.read(() => Promise.resolve(2))).rejects.toBeInstanceOf(RunInterrupted);
    expect(run.reads).toBe(1);
  });

  it("a sleep failing for another reason is rethrown as is", async () => {
    const t = fakeTime();
    const boom = new Error("timer");
    const run = new PacedRun({
      clock: t.clock,
      sleep: () => Promise.reject(boom),
      signal: new AbortController().signal,
      plannedReads: 3,
    });
    await run.read(() => Promise.resolve(1));
    await expect(run.read(() => Promise.resolve(2))).rejects.toBe(boom);
  });

  it("the real timer: a 30 s window wait ends within moments of the abort", async () => {
    const ac = new AbortController();
    const run = new PacedRun({ clock: fixedClock(T0), signal: ac.signal, plannedReads: 3 });
    const started = performance.now();
    setTimeout(() => {
      ac.abort();
    }, 20);
    const once = [refusal(30_000, "window")];
    await expect(
      run.read(() => {
        const e = once.shift();
        return e === undefined ? Promise.resolve(1) : Promise.reject(e);
      }),
    ).rejects.toBeInstanceOf(RunInterrupted);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("over the real limiter (fake time): 37 reads complete, no send passes a window", () => {
  /** Every admitted send obeys the limiter's windows (≤ 30 in any 60 s, ≤ 1 in any 1 s). */
  function assertWindows(at: readonly number[]): void {
    for (const t of at) {
      expect(at.filter((s) => s > t - 60_000 && s <= t).length).toBeLessThanOrEqual(30);
      expect(at.filter((s) => s > t - 1_000 && s <= t).length).toBeLessThanOrEqual(1);
    }
  }

  async function runReads(paceMs: number, looks = false) {
    const repo = new MemoryLimiterRepo();
    const t = fakeTime();
    const limiter = new EspnLimiter({ repo, clock: t.clock, origin: "server", sleep: t.sleep });
    const waits: PaceWait[] = [];
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      plannedReads: 37,
      paceMs,
      onWait: (w) => {
        waits.push(w);
      },
      ...(looks ? { bucketRows: () => repo.recentOutcomes(ESPN_LIMITER.perMinute) } : {}),
    });
    for (let i = 0; i < 37; i++)
      await run.read(async () => {
        const ticket = await limiter.acquire({
          keyless: false,
          deadlineAtMs: t.clock.nowMs() + 20_000,
          signal: null,
        });
        t.clock.advance(250);
        ticket.finish("ok");
      });
    return { at: repo.rows.map((r) => r.at), waits, run, sleeps: t.sleeps };
  }

  it("paced (the default): never refused, 24 a minute at the most", async () => {
    const { at, waits, run } = await runReads(RUN_PACE_MS);
    expect(at).toHaveLength(37);
    expect(waits).toEqual([]);
    expect(run.reads).toBe(37);
    assertWindows(at);
    for (const t of at)
      expect(at.filter((s) => s > t - 60_000 && s <= t).length).toBeLessThanOrEqual(
        RUN_SHARE_PER_MINUTE,
      );
  });

  it("paced, the share looked at before every read (as the backfill runs): reads of one attempt never wait for it", async () => {
    const { at, waits, run, sleeps } = await runReads(RUN_PACE_MS, true);
    expect(at).toHaveLength(37);
    expect(waits).toEqual([]);
    expect(run.waits).toBe(0);
    // the pacing waits only: never a share wait, silent or not
    expect(sleeps.every((ms) => ms <= RUN_PACE_MS - 250)).toBe(true);
    for (const t of at)
      expect(at.filter((s) => s >= t - 60_000 && s <= t).length).toBeLessThanOrEqual(
        RUN_START_MAX_ROWS + 1,
      );
  });

  it("unpaced: the 31st read is refused for the window, waited out, and the run completes", async () => {
    const { at, waits, run } = await runReads(0);
    expect(at).toHaveLength(37);
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits[0]?.reason).toBe("window");
    expect(waits[0]?.reads).toBe(30);
    expect(run.waitedMs).toBeLessThanOrEqual(run.budgetMs);
    assertWindows(at);
  });
});

describe("the progress line: counts and seconds only", () => {
  it("one per reason", () => {
    const w = { retry: true, wait_s: 31, reads: 30, waits: 1, budget_s: 180 } as const;
    expect(paceWaitText("transactions-backfill", { ...w, reason: "window" })).toBe(
      "transactions-backfill: the ESPN request window (30 a minute, shared with the server and the jobs) is full — waiting 31 s, then retrying the same read (30 read(s) done; wait 1, at most 180 s of waiting in all)",
    );
    expect(paceWaitText("transactions-backfill", { ...w, reason: "share", retry: false })).toBe(
      "transactions-backfill: the ESPN request window (30 a minute, shared with the server and the jobs) is near full (the run keeps six free) — waiting 31 s, then reading (30 read(s) done; wait 1, at most 180 s of waiting in all)",
    );
    expect(paceWaitText("transactions-backfill", { ...w, reason: "retry_after" })).toContain(
      "ESPN asked for a pause (Retry-After) — waiting 31 s",
    );
    expect(paceWaitText("transactions-backfill", { ...w, reason: "concurrency" })).toContain(
      "two ESPN requests are still in flight in another process — waiting 31 s",
    );
    // a wait before the read's first try (the window seen full) promises no retry
    expect(
      paceWaitText("transactions-backfill", { ...w, reason: "window", retry: false }),
    ).toContain("is full — waiting 31 s, then reading (30 read(s) done;");
  });

  it("property: fixed words and numbers, nothing else", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("window", "share", "retry_after", "concurrency"),
        fc.boolean(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (reason, retry, wait_s, reads, waits, budget_s) => {
          const text = paceWaitText("transactions-backfill", {
            reason,
            retry,
            wait_s,
            reads,
            waits,
            budget_s,
          });
          expect(text).toMatch(
            /^transactions-backfill: [A-Za-z ,()-]+(?:30 a minute, shared with the server and the jobs\) is (?:full|near full \(the run keeps six free\)))? — waiting \d+ s, then (?:retrying the same read|reading) \(\d+ read\(s\) done; wait \d+, at most \d+ s of waiting in all\)$/,
          );
        },
      ),
    );
  });
});

describe("the share counts requests: a read starts only with room for its every attempt (verifier F2 on fbbd705)", () => {
  /** A run looking at fixed rows, its waits and starts recorded. */
  function shareRun(rows: () => readonly { at: string }[], plannedReads = 37) {
    const t = fakeTime();
    const waits: PaceWait[] = [];
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      plannedReads,
      bucketRows: rows,
      onWait: (w) => {
        waits.push(w);
      },
    });
    return { t, waits, run };
  }

  it("22 rows in the minute, the window not full: a share wait, announced and counted, then one read", async () => {
    let calls = 0;
    const { t, waits, run } = shareRun(() =>
      calls++ === 0 ? rowsAt(T0 - 30_000, RUN_START_MAX_ROWS + 1) : [],
    );
    const r = scripted(t.clock, [], "page");
    expect(await run.read(r.fn)).toBe("page");
    expect(r.starts).toEqual([T0 + 30_000 + WINDOW_WAIT_MARGIN_MS]);
    expect(t.sleeps).toEqual([30_000 + WINDOW_WAIT_MARGIN_MS]);
    expect(waits).toEqual([
      { reason: "share", retry: false, wait_s: 31, reads: 0, waits: 1, budget_s: 180 },
    ]);
    expect(run.waitedMs).toBe(30_500);
    expect(calls).toBe(2);
  });

  it("a full window is a `window` wait, until the share has room — not only its first free slot", async () => {
    // 8 rows 59 s old and 22 rows 30 s old: one slot frees in 1 s, the share's room in 30 s
    let calls = 0;
    const { t, waits, run } = shareRun(() =>
      calls++ === 0
        ? [...rowsAt(T0 - 30_000, RUN_START_MAX_ROWS + 1), ...rowsAt(T0 - 59_000, 8)]
        : [],
    );
    await run.read(scripted(t.clock, [], 1).fn);
    expect(waits.map((w) => [w.reason, w.wait_s])).toEqual([["window", 31]]);
    expect(t.sleeps).toEqual([30_500]);
  });

  it("moments of the share are pacing: waited silently, uncounted, to the millisecond", async () => {
    // 22 rows 59 s old: room in 1 s, shorter than the pacing interval (latency, not load)
    let calls = 0;
    const { t, waits, run } = shareRun(() =>
      calls++ === 0 ? rowsAt(T0 - 59_000, RUN_START_MAX_ROWS + 1) : [],
    );
    const r = scripted(t.clock, [], "page");
    expect(await run.read(r.fn)).toBe("page");
    expect(t.sleeps).toEqual([1_001]);
    expect(r.starts).toEqual([T0 + 1_001]);
    expect(waits).toEqual([]);
    expect(run.waits).toBe(0);
    expect(run.waitedMs).toBe(0);
    // looked once: the read follows the pacing wait
    expect(calls).toBe(1);
    // the window full, a wait as short is still a window wait: announced
    const full = shareRun(() => rowsAt(T0 - 59_000));
    await full.run.read(scripted(full.t.clock, [], 1).fn);
    expect(full.waits.map((w) => [w.reason, w.wait_s])).toEqual([["window", 2]]);
  });

  it("past a bound the share is not waited on: the read goes to the limiter as it is", async () => {
    const t = fakeTime();
    // a guard: an unbounded run of waits fails here instead of spinning on fake time
    let slept = 0;
    const guarded: Sleep = (ms, signal) =>
      ++slept > 100 ? Promise.reject(new Error("unbounded waits")) : t.sleep(ms, signal);
    const run = new PacedRun({
      clock: t.clock,
      sleep: guarded,
      plannedReads: 1_000,
      bucketRows: () => rowsAt(t.clock.nowMs() - 10_000, RUN_START_MAX_ROWS + 1),
    });
    const r = scripted(t.clock, [], "page");
    expect(await run.read(r.fn)).toBe("page");
    expect(r.starts).toHaveLength(1);
    expect(run.waits).toBe(MAX_CONSECUTIVE_REFUSALS);
    expect(run.gaveUp).toBeNull();
  });

  it.each([
    ["two attempts each (a 5xx, then its retry)", (): number => 2],
    ["three attempts each", (): number => 3],
    // a minute of reads that went out once, then reads that need every attempt: the share kept
    // room for them at every start
    ["one attempt for a minute of reads, then three each", (i: number): number => (i < 20 ? 1 : 3)],
  ])(
    "over the real limiter: reads of %s — the run's own rows stay within its share in any minute",
    async (_name, attemptsOf) => {
      const repo = new MemoryLimiterRepo();
      const t = fakeTime();
      const limiter = new EspnLimiter({ repo, clock: t.clock, origin: "server", sleep: t.sleep });
      const waits: PaceWait[] = [];
      const reads = 37;
      const planned = Array.from({ length: reads }, (_, i) => attemptsOf(i));
      const rows = planned.reduce((a, n) => a + n, 0);
      const run = new PacedRun({
        clock: t.clock,
        sleep: t.sleep,
        // the budget sized for the attempts (the backfill's covers two a read)
        plannedReads: rows,
        bucketRows: () => repo.recentOutcomes(ESPN_LIMITER.perMinute),
        onWait: (w) => {
          waits.push(w);
        },
      });
      for (const attempts of planned)
        await run.read(async (o: ReadOptions) => {
          const b = o.budget;
          if (b === undefined) throw new Error("no budget");
          // one request: its attempts, each a row of its own, a backoff of 1 s between them
          for (let a = 1; a <= attempts; a++) {
            const ticket = await limiter.acquire({
              keyless: false,
              deadlineAtMs: b.deadline_at_ms,
              signal: b.signal,
            });
            t.clock.advance(200);
            ticket.finish(a < attempts ? "server_error" : "ok");
            if (a < attempts) await t.sleep(1_000, b.signal);
          }
        });
      const at = repo.rows.map((r) => r.at);
      expect(at).toHaveLength(rows);
      for (const s of at)
        expect(at.filter((u) => u >= s - 60_000 && u <= s).length).toBeLessThanOrEqual(
          RUN_SHARE_PER_MINUTE,
        );
      // waited for the share before reads, never refused by a window the run filled itself
      expect(waits.length).toBeGreaterThanOrEqual(1);
      expect(waits.every((w) => w.reason === "share" && !w.retry)).toBe(true);
      expect(run.waitedMs).toBeLessThanOrEqual(run.budgetMs);
      expect(run.gaveUp).toBeNull();
    },
  );
});

describe("the run's signal reaches each read through its own budget (verifier F1 on fbbd705)", () => {
  it("each attempt gets a fresh budget — the provider's per-call defaults — that the run's signal alone aborts", async () => {
    const t = fakeTime();
    const ac = new AbortController();
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      signal: ac.signal,
      plannedReads: 3,
    });
    const seen: { opts: ReadOptions; at: number }[] = [];
    const once = [refusal(1_000, "window")];
    await run.read((o) => {
      seen.push({ opts: o, at: t.clock.nowMs() });
      const e = once.shift();
      return e === undefined ? Promise.resolve(1) : Promise.reject(e);
    });
    expect(seen).toHaveLength(2);
    const [a, b] = seen.map((x) => x.opts.budget);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    for (const { opts, at } of seen) {
      const budget = opts.budget;
      expect(budget?.deadline_at_ms).toBe(at + PER_CALL_DEADLINE_MS);
      expect(budget?.signal.aborted).toBe(false);
      expect(budget?.used()).toBe(0);
      expect(budget?.canStart(at)).toBe(true);
      for (let i = 0; i < MAX_UPSTREAM_PER_CALL; i++) expect(budget?.tryConsume()).toBe(true);
      expect(budget?.tryConsume()).toBe(false);
    }
    // the attempts have ended: the run's signal no longer reaches their budgets
    ac.abort();
    expect(a?.signal.aborted).toBe(false);
    expect(b?.signal.aborted).toBe(false);
    // without a signal the reads still get their budgets, never aborted
    const quiet = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 1 });
    let got: ReadOptions | null = null;
    await quiet.read((o) => {
      got = o;
      return Promise.resolve(1);
    });
    expect((got as ReadOptions | null)?.budget?.signal.aborted).toBe(false);
  });

  it("the signal aborts the running attempt's budget at once", async () => {
    const t = fakeTime();
    const ac = new AbortController();
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      signal: ac.signal,
      plannedReads: 3,
    });
    let aborted: boolean | null = null;
    await expect(
      run.read((o) => {
        ac.abort();
        aborted = o.budget?.signal.aborted ?? null;
        return Promise.reject(refusal(250, "concurrency"));
      }),
    ).rejects.toBeInstanceOf(RunInterrupted);
    expect(aborted).toBe(true);
  });

  it("what an aborted read throws is the run's interrupt: a refusal of any reason, the budget's, the cancelled request's, an aborted wait's — behind a STALE_ONLY too", async () => {
    const cancelled = new EspnUpstreamError("aborted", { reason: "aborted" });
    for (const e of [
      refusal(250, "concurrency"),
      refusal(1_000, "window"),
      refusal(3_600_000, "daily_cap"),
      refusal(5_000, "retry_after"),
      new UpstreamBudgetExhausted("mTransactions2", "deadline"),
      new UpstreamBudgetExhausted("mTransactions2", "budget"),
      cancelled,
      abortError(),
      staleOnly(cancelled),
      staleOnly(refusal(250, "concurrency")),
      staleOnly(new UpstreamBudgetExhausted("mSettings", "deadline")),
    ]) {
      expect(endedByAbort(e)).toBe(true);
      const t = fakeTime();
      const ac = new AbortController();
      const waits: PaceWait[] = [];
      const run = new PacedRun({
        clock: t.clock,
        sleep: t.sleep,
        signal: ac.signal,
        plannedReads: 3,
        onWait: (w) => {
          waits.push(w);
        },
      });
      await expect(
        run.read(() => {
          ac.abort();
          return Promise.reject(e);
        }),
      ).rejects.toBeInstanceOf(RunInterrupted);
      expect(waits).toEqual([]);
      expect(t.sleeps).toEqual([]);
      expect(run.gaveUp).toBeNull();
    }
  });

  it("an answer from ESPN is the read's own outcome, signal or not; without the signal the abort's failures are rethrown as they are", async () => {
    for (const e of [
      Object.assign(new Error("rejected"), { effCode: "ESPN_AUTH_REJECTED" }),
      new EspnUpstreamError("league_not_found", { reason: "league_not_found" }),
      new EspnUpstreamError("server_error", { upstream_status: 503 }),
      new EspnUpstreamError("rate_limited", { upstream_status: 429, retry_after_s: 2 }),
      new EspnUpstreamError("timeout", { reason: "attempt_timeout" }),
      staleOnly(new EspnUpstreamError("server_error", { upstream_status: 503 })),
      staleOnly(),
      new Error("x"),
    ]) {
      expect(endedByAbort(e)).toBe(false);
      const t = fakeTime();
      const ac = new AbortController();
      const run = new PacedRun({
        clock: t.clock,
        sleep: t.sleep,
        signal: ac.signal,
        plannedReads: 3,
      });
      await expect(
        run.read(() => {
          ac.abort();
          return Promise.reject(e);
        }),
      ).rejects.toBe(e);
    }
    expect(endedByAbort(null)).toBe(false);
    expect(endedByAbort({ name: "AbortError" })).toBe(false);
    // no signal: the budget's and the cancelled request's failures are no refusal — rethrown at once
    const t = fakeTime();
    const run = new PacedRun({ clock: t.clock, sleep: t.sleep, plannedReads: 3 });
    for (const e of [
      new UpstreamBudgetExhausted("mTransactions2", "deadline"),
      new EspnUpstreamError("aborted", { reason: "aborted" }),
    ]) {
      const r = scripted(t.clock, [e], "never");
      await expect(run.read(r.fn)).rejects.toBe(e);
      expect(r.starts).toHaveLength(1);
    }
    expect(run.waits).toBe(0);
  });

  it("over the real limiter: a read waiting there for the window is refused before its slot — no row, the run's interrupt", async () => {
    const repo = new MemoryLimiterRepo();
    for (let i = 0; i < ESPN_LIMITER.perMinute; i++)
      repo.rows.push({
        id: 10_000 + i,
        at: T0 - 45_000,
        keyless: false,
        origin: "server",
        outcome: "ok",
      });
    const ac = new AbortController();
    const limiterSleeps: number[] = [];
    // the limiter's wait for the window (15 s, inside the 20 s deadline): Ctrl-C during it
    const t = fakeTime((ms) => {
      if (ms > RUN_PACE_MS) {
        limiterSleeps.push(ms);
        ac.abort();
      }
    });
    const limiter = new EspnLimiter({ repo, clock: t.clock, origin: "server", sleep: t.sleep });
    // no look before the read: the limiter itself waits for the window, inside the read
    const run = new PacedRun({
      clock: t.clock,
      sleep: t.sleep,
      signal: ac.signal,
      plannedReads: 3,
    });
    await expect(
      run.read(async (o) => {
        const b = o.budget;
        if (b === undefined) throw new Error("no budget");
        const ticket = await limiter.acquire({
          keyless: false,
          deadlineAtMs: b.deadline_at_ms,
          signal: b.signal,
        });
        ticket.finish("ok");
      }),
    ).rejects.toBeInstanceOf(RunInterrupted);
    expect(limiterSleeps).toEqual([15_000]);
    expect(repo.rows.filter((r) => r.id < 10_000)).toEqual([]);
  });
});
