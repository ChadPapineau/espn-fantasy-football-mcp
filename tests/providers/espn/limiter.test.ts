// limiter.test.ts — src/providers/espn/limiter.ts (plan 01 §6; plan 06 §1.4 + V7; plan 05 §2
// `providers/espn/limiter`): never more than 30 requests in any 60 s window or 1 in any second, never
// more than 2 in flight; the daily caps bind job rows only; fail closed when the row cannot be
// written; the breaker opens after 3 consecutive 5xx/429/timeouts (in process AND from another
// process's rows) and closes after 5 min; the backoff is 1, 2, 4, 8 s ±25 %.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ESPN_BREAKER, ESPN_JOB_DAILY_CAPS, ESPN_LIMITER } from "../../../src/config/schema.js";
import { fixedClock } from "../../../src/domain/clock.js";
import {
  backoffMs,
  Breaker,
  EspnLimiter,
  EspnLimiterUnavailableError,
  EspnRateLimitedError,
  limiterRequest,
  realSleep,
  Semaphore,
  utcDayStart,
} from "../../../src/providers/espn/limiter.js";
import { MemoryLimiterRepo, NOW_ISO } from "./helpers.js";

const T0 = Date.parse(NOW_ISO);

describe("the request shape and the schedule", () => {
  it("limiterRequest: the two windows; a daily cap for job rows only", () => {
    const s = limiterRequest(T0, true, "server");
    expect(s.windows).toEqual([
      { start: new Date(T0 - 60_000).toISOString(), max: ESPN_LIMITER.perMinute },
      { start: new Date(T0 - 1000).toISOString(), max: ESPN_LIMITER.perSecond },
    ]);
    expect(s.dailyCap).toBeNull();
    expect(limiterRequest(T0, true, "job").dailyCap).toEqual({
      dayStart: "2026-10-06T00:00:00.000Z",
      max: ESPN_JOB_DAILY_CAPS.keyless,
    });
    expect(limiterRequest(T0, false, "job").dailyCap?.max).toBe(ESPN_JOB_DAILY_CAPS.cookie);
    expect(utcDayStart(Date.parse("2026-10-06T23:59:59.999Z"))).toBe(
      Date.parse("2026-10-06T00:00:00.000Z"),
    );
  });
  it("backoff: 1, 2, 4, 8, 8 s at the midpoint; ±25 % at the extremes; odd randoms clamp", () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffMs(a, 0.5))).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(backoffMs(1, 0)).toBe(750);
    expect(backoffMs(1, 1)).toBe(1250);
    expect(backoffMs(1, -5)).toBe(750);
    expect(backoffMs(1, Number.NaN)).toBe(1000);
    expect(backoffMs(0, 0.5)).toBe(1000);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, r) => {
          const v = backoffMs(a, r);
          const base = Math.min(8000, 1000 * 2 ** (a - 1));
          expect(v).toBeGreaterThanOrEqual(Math.floor(base * 0.75));
          expect(v).toBeLessThanOrEqual(Math.ceil(base * 1.25));
        },
      ),
    );
  });
  it("realSleep resolves, honours abort before and during the wait", async () => {
    await realSleep(1, null);
    await realSleep(Number.NaN, null);
    const pre = new AbortController();
    pre.abort();
    await expect(realSleep(10, pre.signal)).rejects.toThrow(/aborted/);
    const mid = new AbortController();
    const p = realSleep(10_000, mid.signal);
    mid.abort();
    await expect(p).rejects.toThrow(/aborted/);
    const ok = new AbortController();
    await realSleep(1, ok.signal);
  });
});

describe("Semaphore", () => {
  it("never more than max in flight; waiters run in order", async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.inFlight).toBe(2);
    let third = false;
    const p = s.acquire().then(() => (third = true));
    await Promise.resolve();
    expect(third).toBe(false);
    s.release();
    await p;
    expect(third).toBe(true);
    expect(s.inFlight).toBe(2);
    s.release();
    s.release();
    s.release();
    expect(s.inFlight).toBe(0);
  });
});

describe("Breaker", () => {
  it("opens after 3 consecutive failures, closes after 5 min; success resets", () => {
    const clock = fixedClock(NOW_ISO);
    const b = new Breaker(clock, null);
    b.record("server_error");
    b.record("timeout");
    b.record("pending");
    b.record("client_error");
    expect(b.isOpen()).toBe(false);
    b.record("ok");
    b.record("server_error");
    b.record("rate_limited");
    expect(b.isOpen()).toBe(false);
    b.record("timeout");
    expect(b.isOpen()).toBe(true);
    expect(b.status()).toMatchObject({ breaker_open: true, consecutive_failures: 3 });
    clock.advance(ESPN_BREAKER.openMs);
    expect(b.isOpen()).toBe(false);
    b.record("not_modified");
    expect(b.status()).toEqual({
      breaker_open: false,
      breaker_open_until: null,
      consecutive_failures: 0,
    });
  });
  it("forceOpen (a host move) opens at once", () => {
    const b = new Breaker(fixedClock(NOW_ISO), null);
    b.forceOpen();
    expect(b.isOpen()).toBe(true);
  });
  it("another process's three failures open this process's breaker (derived from the rows)", () => {
    const clock = fixedClock(NOW_ISO);
    const repo = new MemoryLimiterRepo();
    for (let i = 0; i < 3; i++) {
      const v = repo.tryRecord(limiterRequest(T0 - 10_000 + i * 2000, true, "server"));
      if (v.ok) repo.recordOutcome(v.id, "server_error");
    }
    const b = new Breaker(clock, repo);
    expect(b.isOpen()).toBe(true);
    expect(b.status().breaker_open_until).toBe(
      new Date(T0 - 6000 + ESPN_BREAKER.openMs).toISOString(),
    );
    const brokenRepo = new MemoryLimiterRepo();
    brokenRepo.recentOutcomes = () => {
      throw new Error("store down");
    };
    const broken = new Breaker(clock, brokenRepo);
    expect(broken.isOpen()).toBe(false);
    expect(broken.status().breaker_open).toBe(false);
  });
});

describe("EspnLimiter", () => {
  it("records one row per request and its final outcome", async () => {
    const repo = new MemoryLimiterRepo();
    const l = new EspnLimiter({ repo, clock: fixedClock(NOW_ISO), origin: "server" });
    const t = await l.acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null });
    expect(repo.rows).toHaveLength(1);
    expect(l.inFlight).toBe(1);
    t.finish("ok");
    t.finish("ok");
    expect(repo.rows[0]?.outcome).toBe("ok");
    expect(l.inFlight).toBe(0);
  });
  it("waits for the per-second window inside the deadline", async () => {
    const clock = fixedClock(NOW_ISO);
    const repo = new MemoryLimiterRepo();
    const waits: number[] = [];
    const l = new EspnLimiter({
      repo,
      clock,
      origin: "server",
      sleep: (ms) => {
        waits.push(ms);
        clock.advance(ms);
        return Promise.resolve();
      },
    });
    (await l.acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null })).finish("ok");
    (await l.acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null })).finish("ok");
    expect(waits).toEqual([1000]);
    expect(repo.rows.map((r) => r.at)).toEqual([T0, T0 + 1000]);
  });
  it("a wait past the deadline is RATE_LIMITED with retry_after_s; the slot is released", async () => {
    const clock = fixedClock(NOW_ISO);
    const repo = new MemoryLimiterRepo();
    for (let i = 0; i < ESPN_LIMITER.perMinute; i++)
      repo.rows.push({
        id: 100 + i,
        at: T0 - 30_000 + i,
        keyless: true,
        origin: "server",
        outcome: "ok",
      });
    const l = new EspnLimiter({ repo, clock, origin: "server" });
    const e = await l
      .acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EspnRateLimitedError);
    expect((e as EspnRateLimitedError).effDetails).toEqual({ retry_after_s: 30, reason: "window" });
    expect(l.inFlight).toBe(0);
  });
  it("the job fleet's daily cap refuses at once (job rows only)", async () => {
    const repo = new MemoryLimiterRepo();
    for (let i = 0; i < ESPN_JOB_DAILY_CAPS.keyless; i++)
      repo.rows.push({
        id: i + 1,
        at: Date.parse("2026-10-06T01:00:00Z") + i * 60_000,
        keyless: true,
        origin: "job",
        outcome: "ok",
      });
    const clock = fixedClock(NOW_ISO);
    const sleep = (ms: number) => (clock.advance(ms), Promise.resolve());
    const job = new EspnLimiter({ repo, clock, origin: "job", sleep });
    const e = (await job
      .acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null })
      .catch((x: unknown) => x)) as EspnRateLimitedError;
    expect(e).toBeInstanceOf(EspnRateLimitedError);
    expect(e.effDetails.reason).toBe("daily_cap");
    expect(e.effDetails.retry_after_s).toBe(12 * 3600);
    const server = new EspnLimiter({ repo, clock, origin: "server", sleep });
    (await server.acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null })).finish("ok");
    // the cookie cap is counted apart from the keyless one
    (
      await job.acquire({ keyless: false, deadlineAtMs: clock.nowMs() + 20_000, signal: null })
    ).finish("ok");
    expect(repo.rows.filter((r) => r.origin === "job" && !r.keyless)).toHaveLength(1);
  });
  it("fails closed when the row cannot be written; an unwritable outcome is an event, not a throw", async () => {
    const repo = new MemoryLimiterRepo();
    const events: string[] = [];
    const l = new EspnLimiter({
      repo,
      clock: fixedClock(NOW_ISO),
      origin: "server",
      onEvent: (e) => events.push(e),
    });
    repo.failWrites = true;
    const e = await l
      .acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EspnLimiterUnavailableError);
    expect((e as EspnLimiterUnavailableError).effCode).toBe("INTERNAL");
    expect(l.inFlight).toBe(0);
    repo.failWrites = false;
    const t = await l.acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null });
    repo.recordOutcome = () => {
      throw new Error("down");
    };
    t.finish("ok");
    expect(events).toContain("limiter.outcome_unwritten");
  });
  it("never more than 2 in flight in this process", async () => {
    const clock = fixedClock(NOW_ISO);
    const repo = new MemoryLimiterRepo();
    const l = new EspnLimiter({
      repo,
      clock,
      origin: "server",
      sleep: (ms) => (clock.advance(ms), Promise.resolve()),
    });
    const a = await l.acquire({ keyless: true, deadlineAtMs: T0 + 60_000, signal: null });
    clock.advance(1000);
    const b = await l.acquire({ keyless: true, deadlineAtMs: T0 + 60_000, signal: null });
    clock.advance(1000);
    let third = false;
    const c = l
      .acquire({ keyless: true, deadlineAtMs: T0 + 60_000, signal: null })
      .then((t) => ((third = true), t));
    await Promise.resolve();
    await Promise.resolve();
    expect(third).toBe(false);
    expect(l.inFlight).toBe(2);
    a.finish("ok");
    (await c).finish("ok");
    b.finish("ok");
    expect(l.inFlight).toBe(0);
  });
  it("property: any arrival pattern never exceeds 30 per 60 s or 1 per second", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 1, maxLength: 60 }),
        async (gaps) => {
          const clock = fixedClock(NOW_ISO);
          const repo = new MemoryLimiterRepo();
          const l = new EspnLimiter({
            repo,
            clock,
            origin: "server",
            sleep: (ms) => (clock.advance(ms), Promise.resolve()),
          });
          for (const g of gaps) {
            clock.advance(g);
            const t = await l
              .acquire({ keyless: true, deadlineAtMs: clock.nowMs() + 120_000, signal: null })
              .catch(() => null);
            t?.finish("ok");
          }
          const at = repo.rows.map((r) => r.at).sort((x, y) => x - y);
          for (const t of at) {
            expect(at.filter((x) => x > t - 60_000 && x <= t).length).toBeLessThanOrEqual(
              ESPN_LIMITER.perMinute,
            );
            expect(at.filter((x) => x > t - 1000 && x <= t).length).toBeLessThanOrEqual(
              ESPN_LIMITER.perSecond,
            );
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
