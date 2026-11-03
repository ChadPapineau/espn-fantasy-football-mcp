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
// pacing and without it. No request is made.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENCY_RETRIES,
  MAX_CONSECUTIVE_REFUSALS,
  PacedRun,
  RUN_PACE_MS,
  RUN_SHARE_PER_MINUTE,
  RunInterrupted,
  WINDOW_WAIT_MARGIN_MS,
  limiterRefusal,
  paceWaitText,
  waitBudgetMs,
  type PaceWait,
} from "../../src/cli/espn-pacing.js";
import { ESPN_LIMITER } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import { EspnUpstreamError } from "../../src/providers/espn/errors.js";
import { EspnLimiter, EspnRateLimitedError, type Sleep } from "../../src/providers/espn/limiter.js";
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
  it("leaves six slots a minute to the other processes", () => {
    expect(RUN_SHARE_PER_MINUTE).toBeLessThan(ESPN_LIMITER.perMinute);
    expect(RUN_PACE_MS).toBe(2500);
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
      expect(waits).toEqual([{ reason, wait_s: 31, reads: 1, waits: 1, budget_s: 180 }]);
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

  async function runReads(paceMs: number) {
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
    return { at: repo.rows.map((r) => r.at), waits, run };
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
    const w = { wait_s: 31, reads: 30, waits: 1, budget_s: 180 } as const;
    expect(paceWaitText("transactions-backfill", { ...w, reason: "window" })).toBe(
      "transactions-backfill: the ESPN request window (30 a minute, shared with the server and the jobs) is full — waiting 31 s, then retrying the same read (30 read(s) done; wait 1, at most 180 s of waiting in all)",
    );
    expect(paceWaitText("transactions-backfill", { ...w, reason: "retry_after" })).toContain(
      "ESPN asked for a pause (Retry-After) — waiting 31 s",
    );
    expect(paceWaitText("transactions-backfill", { ...w, reason: "concurrency" })).toContain(
      "two ESPN requests are still in flight in another process — waiting 31 s",
    );
  });

  it("property: fixed words and numbers, nothing else", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("window", "retry_after", "concurrency"),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (reason, wait_s, reads, waits, budget_s) => {
          const text = paceWaitText("transactions-backfill", {
            reason,
            wait_s,
            reads,
            waits,
            budget_s,
          });
          expect(text).toMatch(
            /^transactions-backfill: [A-Za-z ,()-]+(?:30 a minute, shared with the server and the jobs\) is full)? — waiting \d+ s, then retrying the same read \(\d+ read\(s\) done; wait \d+, at most \d+ s of waiting in all\)$/,
          );
        },
      ),
    );
  });
});
