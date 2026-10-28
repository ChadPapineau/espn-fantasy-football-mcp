// limiter.test.ts — src/providers/espn/limiter.ts (plan 01 §6; plan 06 §1.4 + V7; plan 05 §2
// `providers/espn/limiter`): never more than 30 requests in any 60 s window or 1 in any second, never
// more than 2 in flight; the daily caps bind job rows only; fail closed when the row cannot be
// written; the breaker opens after 3 consecutive 5xx/429/timeouts (in process AND from another
// process's rows) and closes after 5 min; the backoff is 1, 2, 4, 8 s ±25 %.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  IN_FLIGHT_MAX_AGE_MS,
  IN_FLIGHT_POLL_MS,
  inFlightOf,
  limiterRequest,
  realSleep,
  Semaphore,
  trySlot,
  utcDayStart,
} from "../../../src/providers/espn/limiter.js";
import { storeFactory } from "../../../src/store/index.js";
import { MemoryLimiterRepo, NOW_ISO } from "./helpers.js";

/** A clock that starts at `startMs` and runs with real time, plus `advance` jumps. */
function runningClockAt(startMs: number) {
  let base = startMs;
  const origin = performance.now();
  const now = (): number => Math.floor(base + (performance.now() - origin));
  return {
    nowMs: now,
    nowIso: () => new Date(now()).toISOString(),
    advance(ms: number) {
      base += ms;
    },
  };
}

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
  it("opened while the clock ran 3 h fast, then set back: open 5 min from the correction at the most, never the skew (Stage C store-future-stamped-rows-block)", () => {
    // the gate's repro: the breaker was still open 60 min after a 3 h correction (control: 5 min)
    for (const open of [
      (b: Breaker) => {
        b.record("server_error");
        b.record("server_error");
        b.record("server_error");
      },
      (b: Breaker) => {
        b.forceOpen();
      },
    ]) {
      const clock = fixedClock(NOW_ISO);
      const b = new Breaker(clock, null);
      clock.set(T0 + 3 * 3_600_000);
      open(b);
      expect(b.isOpen()).toBe(true);
      clock.set(T0); // NTP steps the clock back 3 h
      expect(b.isOpen()).toBe(true);
      expect(b.status().breaker_open_until).toBe(new Date(T0 + ESPN_BREAKER.openMs).toISOString());
      clock.advance(ESPN_BREAKER.openMs - 1);
      expect(b.isOpen()).toBe(true);
      clock.advance(1);
      expect(b.isOpen()).toBe(false);
      expect(b.status()).toMatchObject({ breaker_open: false, breaker_open_until: null });
    }
  });
  it("a clock adjustment under a second changes nothing; a window set before the clock moved runs as set", () => {
    const clock = fixedClock(NOW_ISO);
    const b = new Breaker(clock, null);
    b.forceOpen();
    clock.set(T0 - 800); // a sub-second step back: read as written
    expect(b.status().breaker_open_until).toBe(new Date(T0 + ESPN_BREAKER.openMs).toISOString());
    clock.set(T0 + 60_000); // forward: the window keeps its end
    expect(b.status().breaker_open_until).toBe(new Date(T0 + ESPN_BREAKER.openMs).toISOString());
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
  // Stage C (limiter-concurrency-per-process): plan 01 §6 D7's "≤ 2 concurrent" is the ONE global
  // limiter's — the server, a launchd job and a second client share it; it was an in-process
  // semaphore only, so two processes held four requests in flight
  it("never more than 2 in flight ACROSS processes: a second process waits for a slot", async () => {
    const clock = fixedClock(NOW_ISO);
    const repo = new MemoryLimiterRepo();
    const waits: number[] = [];
    let onWait = (): void => undefined;
    const sleep = (ms: number): Promise<void> => {
      waits.push(ms);
      clock.advance(ms);
      onWait();
      return Promise.resolve();
    };
    const server = new EspnLimiter({ repo, clock, origin: "server", sleep });
    const job = new EspnLimiter({ repo, clock, origin: "job", sleep });
    const pending = (): number => repo.rows.filter((r) => r.outcome === "pending").length;
    const deadline = (): number => clock.nowMs() + 20_000;
    const a = await server.acquire({ keyless: true, deadlineAtMs: deadline(), signal: null });
    clock.advance(1000);
    const b = await job.acquire({ keyless: true, deadlineAtMs: deadline(), signal: null });
    clock.advance(1000);
    expect(pending()).toBe(2);
    // a third request, from a process holding only one of them, waits until one finishes
    let polls = 0;
    onWait = () => {
      polls++;
      expect(pending()).toBe(2);
      if (polls === 3) a.finish("ok");
    };
    const c = await job.acquire({ keyless: true, deadlineAtMs: deadline(), signal: null });
    expect(waits).toEqual([IN_FLIGHT_POLL_MS, IN_FLIGHT_POLL_MS, IN_FLIGHT_POLL_MS]);
    expect(pending()).toBe(2);
    expect(repo.rows.map((r) => r.outcome)).toEqual(["ok", "pending", "pending"]);
    b.finish("ok");
    c.finish("ok");
    expect(pending()).toBe(0);
    expect(server.inFlight + job.inFlight).toBe(0);
  });
  it("a pending row past IN_FLIGHT_MAX_AGE_MS (a process that died mid-request) holds no slot", async () => {
    const repo = new MemoryLimiterRepo();
    for (const [i, age] of [IN_FLIGHT_MAX_AGE_MS + 1, IN_FLIGHT_MAX_AGE_MS + 5000].entries())
      repo.rows.push({
        id: 50 + i,
        at: T0 - age,
        keyless: true,
        origin: "job",
        outcome: "pending",
      });
    const waits: number[] = [];
    const l = new EspnLimiter({
      repo,
      clock: fixedClock(NOW_ISO),
      origin: "server",
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
    });
    (await l.acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null })).finish("ok");
    expect(waits).toEqual([]);
  });
  it("no slot before the deadline → RATE_LIMITED (concurrency), nothing recorded, the slot released", async () => {
    const repo = new MemoryLimiterRepo();
    for (const [i, age] of [3000, 2000].entries())
      repo.rows.push({
        id: 60 + i,
        at: T0 - age,
        keyless: true,
        origin: "job",
        outcome: "pending",
      });
    const clock = fixedClock(NOW_ISO);
    const l = new EspnLimiter({
      repo,
      clock,
      origin: "server",
      sleep: (ms) => (clock.advance(ms), Promise.resolve()),
    });
    const e = await l
      .acquire({ keyless: true, deadlineAtMs: T0 + 1000, signal: null })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EspnRateLimitedError);
    expect((e as EspnRateLimitedError).effDetails).toEqual({
      retry_after_s: 1,
      reason: "concurrency",
    });
    expect(repo.rows).toHaveLength(2);
    expect(l.inFlight).toBe(0);
  });
  it("a clock that never moves cannot hold the wait open: the deadline's number of polls, then refused", async () => {
    const repo = new MemoryLimiterRepo();
    for (const [i, age] of [3000, 2000].entries())
      repo.rows.push({
        id: 70 + i,
        at: T0 - age,
        keyless: true,
        origin: "job",
        outcome: "pending",
      });
    const waits: number[] = [];
    const l = new EspnLimiter({
      repo,
      clock: fixedClock(NOW_ISO),
      origin: "server",
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
    });
    const e = await l
      .acquire({ keyless: true, deadlineAtMs: T0 + 2000, signal: null })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EspnRateLimitedError);
    expect((e as EspnRateLimitedError).effDetails.reason).toBe("concurrency");
    expect(waits).toHaveLength(2000 / IN_FLIGHT_POLL_MS);
    expect(l.inFlight).toBe(0);
  });
  it("rows that cannot be read refuse fail-closed (like a row that cannot be written)", async () => {
    const repo = new MemoryLimiterRepo();
    repo.recentOutcomes = () => {
      throw new Error("store busy");
    };
    const l = new EspnLimiter({ repo, clock: fixedClock(NOW_ISO), origin: "server" });
    const e = await l
      .acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: null })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EspnLimiterUnavailableError);
    expect(repo.rows).toHaveLength(0);
    expect(l.inFlight).toBe(0);
  });
  it("inFlightOf counts only live pending rows", () => {
    const at = (ms: number): string => new Date(T0 - ms).toISOString();
    expect(
      inFlightOf(
        [
          { at: at(0), outcome: "pending" },
          { at: at(1000), outcome: "ok" },
          { at: at(IN_FLIGHT_MAX_AGE_MS), outcome: "pending" },
          { at: at(IN_FLIGHT_MAX_AGE_MS + 1), outcome: "pending" },
          { at: "not a time", outcome: "pending" },
        ],
        T0,
      ),
    ).toBe(2);
    expect(inFlightOf([], T0)).toBe(0);
  });
  it("inFlightOf leaves out a row stamped past now: no evidence of a request in flight (Stage C store-future-stamped-rows-block)", () => {
    const ahead = (ms: number): string => new Date(T0 + ms).toISOString();
    // a process that crashed while the clock ran 3 h fast left two pending rows: before, they held
    // both slots — every send refused `concurrency` — until real time passed their stamps
    expect(
      inFlightOf(
        [
          { at: ahead(3 * 3_600_000), outcome: "pending" },
          { at: ahead(3 * 3_600_000 - 1000), outcome: "pending" },
        ],
        T0,
      ),
    ).toBe(0);
    // within a clock adjustment of now a row reads as written, and a live one beside it counts
    expect(
      inFlightOf(
        [
          { at: ahead(600_000), outcome: "pending" },
          { at: ahead(800), outcome: "pending" },
          { at: new Date(T0 - 500).toISOString(), outcome: "pending" },
        ],
        T0,
      ),
    ).toBe(2);
  });
  it("trySlot: the one rule every recorder takes its slot by (in-flight cap first, then the bucket)", () => {
    const repo = new MemoryLimiterRepo();
    // two live requests anywhere: refused `concurrency`, nothing written, the poll interval as wait
    for (const [i, age] of [1500, 500].entries())
      repo.rows.push({
        id: 80 + i,
        at: T0 - age,
        keyless: true,
        origin: "job",
        outcome: "pending",
      });
    expect(trySlot(repo, limiterRequest(T0 + 2000, false, "server"))).toEqual({
      ok: false,
      reason: "concurrency",
      retry_after_ms: IN_FLIGHT_POLL_MS,
    });
    expect(repo.rows).toHaveLength(2);
    // one of them finished: the bucket decides — inside a second of the last row it is the window
    repo.rows[1]!.outcome = "ok";
    expect(trySlot(repo, limiterRequest(T0, false, "server"))).toMatchObject({
      ok: false,
      reason: "window",
    });
    const v = trySlot(repo, limiterRequest(T0 + 1000, false, "server"));
    expect(v).toMatchObject({ ok: true });
    expect(repo.rows.at(-1)).toMatchObject({ at: T0 + 1000, outcome: "pending" });
    // that row now holds the second slot: the next send waits for one of the two to finish
    expect(trySlot(repo, limiterRequest(T0 + 3000, true, "job"))).toMatchObject({
      reason: "concurrency",
    });
    // a repository that cannot be read or written throws; the caller fails closed
    const broken = new MemoryLimiterRepo();
    broken.recentOutcomes = () => {
      throw new Error("store busy");
    };
    expect(() => trySlot(broken, limiterRequest(T0, true, "server"))).toThrow("store busy");
  });
  it("property: two processes, any arrival pattern and request lengths, never > 2 in flight", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            proc: fc.integer({ min: 0, max: 1 }),
            gap: fc.integer({ min: 0, max: 1500 }),
            hold: fc.integer({ min: 0, max: 4 }),
          }),
          { minLength: 1, maxLength: 24 },
        ),
        async (plan) => {
          const clock = fixedClock(NOW_ISO);
          const repo = new MemoryLimiterRepo();
          // a request finishes after `hold` ticks (a tick: one acquisition step or one wait)
          const open: { proc: number; ticket: { finish(o: "ok"): void }; left: number }[] = [];
          let maxPending = 0;
          const tick = (): void => {
            for (const o of open) o.left--;
            for (const o of open.filter((x) => x.left < 0)) o.ticket.finish("ok");
            open.splice(0, open.length, ...open.filter((x) => x.left >= 0));
          };
          const sleep = (ms: number): Promise<void> => {
            clock.advance(ms);
            tick();
            return Promise.resolve();
          };
          const procs = [0, 1].map(
            (i) => new EspnLimiter({ repo, clock, origin: i === 0 ? "server" : "job", sleep }),
          );
          for (const step of plan) {
            clock.advance(step.gap);
            // the process's own semaphore wait: time passes until one of its requests finishes
            while (open.filter((o) => o.proc === step.proc).length >= ESPN_LIMITER.concurrency) {
              clock.advance(100);
              tick();
            }
            const t = await procs[step.proc]!.acquire({
              keyless: false,
              deadlineAtMs: clock.nowMs() + 600_000,
              signal: null,
            }).catch(() => null);
            maxPending = Math.max(
              maxPending,
              repo.rows.filter((r) => r.outcome === "pending").length,
            );
            if (t !== null) open.push({ proc: step.proc, ticket: t, left: step.hold });
            tick();
          }
          expect(maxPending).toBeLessThanOrEqual(ESPN_LIMITER.concurrency);
        },
      ),
      { numRuns: 60 },
    );
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

describe("Stage C: the in-flight cap is decided inside the store's transaction; an unsent request writes no row", () => {
  /** The real store (src/store) in a temp directory. */
  function realStore() {
    const dir = mkdtempSync(path.join(tmpdir(), "eff-limiter-"));
    const store = storeFactory.open({
      path: path.join(dir, "store.sqlite"),
      datasetDir: path.join(dir, "datasets"),
      backupDir: path.join(dir, "backups"),
      clock: fixedClock(NOW_ISO),
      migrate: true,
    });
    return {
      repo: store.repos.limiter,
      close: () => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("limiter-concurrency-per-process: another process's rows inserted after this one counted — refused inside the transaction, nothing written", () => {
    const s = realStore();
    try {
      // another process put two requests in flight (its rows, outcome still pending)
      for (const at of [T0 - 4000, T0 - 2000])
        expect(s.repo.tryRecord(limiterRequest(at, true, "job")).ok).toBe(true);
      // this process counted before those inserts (a stalled process, a busy lock): its read of
      // the in-flight rows is stale — the count inside the store's BEGIN IMMEDIATE still refuses
      const stale = { ...s.repo, recentOutcomes: () => [] };
      expect(trySlot(stale, limiterRequest(T0, false, "server"))).toEqual({
        ok: false,
        reason: "concurrency",
        retry_after_ms: IN_FLIGHT_POLL_MS,
      });
      expect(s.repo.countSince(new Date(T0 - 60_000).toISOString())).toBe(2);
      // a pending row older than IN_FLIGHT_MAX_AGE_MS holds no slot (its process died): once the
      // first is that old, one slot is free again
      expect(
        trySlot(stale, limiterRequest(T0 - 4000 + IN_FLIGHT_MAX_AGE_MS + 1, false, "server")),
      ).toMatchObject({ ok: true });
    } finally {
      s.close();
    }
  });

  it("store-future-stamped-rows-block: two pending rows a crashed process stamped 3 h fast hold no slot — the send is admitted and they then hold one 30 s", () => {
    const s = realStore();
    try {
      // a process recorded two sends while the clock ran 3 h fast and died before their outcomes
      for (const ms of [3 * 3_600_000, 3 * 3_600_000 + 1100])
        expect(s.repo.tryRecord(limiterRequest(T0 + ms, true, "job")).ok).toBe(true);
      // after the correction: the pre-check reads them as no evidence, the store re-stamps them to
      // this request's instant inside its transaction — they then count as in flight just now
      expect(trySlot(s.repo, limiterRequest(T0, false, "server"))).toEqual({
        ok: false,
        reason: "concurrency",
        retry_after_ms: IN_FLIGHT_POLL_MS,
      });
      // …for IN_FLIGHT_MAX_AGE_MS (30 s), never the 3 h of the skew
      expect(
        trySlot(s.repo, limiterRequest(T0 + IN_FLIGHT_MAX_AGE_MS + 1, false, "server")),
      ).toMatchObject({ ok: true });
    } finally {
      s.close();
    }
  });

  it("espn-deadline-budget-exhausted-internal: a read queued behind two hung requests is refused at its deadline — RATE_LIMITED, no row", async () => {
    const repo = new MemoryLimiterRepo();
    const clock = runningClockAt(T0);
    const l = new EspnLimiter({ repo, clock, origin: "server" });
    const a = await l.acquire({
      keyless: true,
      deadlineAtMs: clock.nowMs() + 20_000,
      signal: null,
    });
    clock.advance(1_100);
    const b = await l.acquire({
      keyless: true,
      deadlineAtMs: clock.nowMs() + 20_000,
      signal: null,
    });
    expect(repo.rows).toHaveLength(2);
    // the third waits for an in-process slot only until its deadline (wall time: 120 ms here)
    const started = performance.now();
    const e = await l
      .acquire({ keyless: true, deadlineAtMs: clock.nowMs() + 120, signal: null })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EspnRateLimitedError);
    expect((e as EspnRateLimitedError).effDetails.reason).toBe("concurrency");
    expect(performance.now() - started).toBeLessThan(5_000);
    // nothing was recorded for the request that was never sent
    expect(repo.rows).toHaveLength(2);
    a.finish("ok");
    b.finish("ok");
    expect(l.inFlight).toBe(0);
  });

  it("a send whose deadline passed while it waited for the window is refused before its row is written", async () => {
    const repo = new MemoryLimiterRepo();
    const clock = fixedClock(NOW_ISO);
    const l = new EspnLimiter({ repo, clock, origin: "server" });
    const e = await l
      .acquire({ keyless: true, deadlineAtMs: T0, signal: null })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EspnRateLimitedError);
    expect(repo.rows).toHaveLength(0);
    // a ticket carries the instant it was recorded at, always before its deadline
    const t = await l.acquire({ keyless: true, deadlineAtMs: T0 + 10_000, signal: null });
    expect(t.atMs).toBe(T0);
    t.finish("ok");
  });

  it("the bounded semaphore: a freed slot wins over the bound; a cancelled wait holds nothing", async () => {
    const sem = new Semaphore(1);
    expect(await sem.acquire(0)).toBe(true);
    expect(await sem.acquire(0)).toBe(false);
    const waiting = sem.acquire(5_000);
    sem.release();
    expect(await waiting).toBe(true);
    const ctl = new AbortController();
    const cancelled = sem.acquire(5_000, ctl.signal);
    ctl.abort();
    expect(await cancelled).toBe(false);
    sem.release();
    expect(sem.inFlight).toBe(0);
    expect(await sem.acquire(0)).toBe(true);
  });
});

// Stage C findings espn-breaker-ignores-resets and espn-coalesced-read-leader-budget
describe("Stage C: network failures count; a shared read's deadline is read at every step", () => {
  it("the in-process breaker counts network failures like a 5xx; a client error (a cancellation) never does", () => {
    const clock = fixedClock(NOW_ISO);
    const b = new Breaker(clock, null);
    b.record("network_error");
    b.record("network_error");
    expect(b.isOpen()).toBe(false);
    b.record("network_error");
    expect(b.status()).toMatchObject({ breaker_open: true, consecutive_failures: 3 });
    const c = new Breaker(clock, null);
    for (let i = 0; i < 5; i++) c.record("client_error");
    expect(c.status()).toMatchObject({ breaker_open: false, consecutive_failures: 0 });
    // the cross-process view agrees: three network_error rows open it for a second process
    const repo = new MemoryLimiterRepo();
    for (let i = 0; i < 3; i++) {
      const v = repo.tryRecord(limiterRequest(T0 - 10_000 + i * 2000, true, "server"));
      if (v.ok) repo.recordOutcome(v.id, "network_error");
    }
    expect(new Breaker(clock, repo).isOpen()).toBe(true);
  });

  it("an in-process slot wait re-arms when the deadline grows (a later reader joined)", async () => {
    const clock = fixedClock(NOW_ISO);
    const l = new EspnLimiter({ repo: new MemoryLimiterRepo(), clock, origin: "server" });
    // two sends hold both in-process slots (a second apart: the 1/s window)
    const a = await l.acquire({
      keyless: true,
      deadlineAtMs: clock.nowMs() + 20_000,
      signal: null,
    });
    clock.advance(1000);
    const b = await l.acquire({
      keyless: true,
      deadlineAtMs: clock.nowMs() + 20_000,
      signal: null,
    });
    clock.advance(1000);
    let until = clock.nowMs() + 60;
    const third = l.acquire({ keyless: true, deadlineAtMs: () => until, signal: null });
    // the deadline grows before its first 60 ms wait gives up; a slot frees only after that bound
    await new Promise((r) => setTimeout(r, 20));
    until = clock.nowMs() + 5_000;
    await new Promise((r) => setTimeout(r, 100));
    a.finish("ok");
    const t = await third;
    expect(t.atMs).toBe(clock.nowMs());
    t.finish("ok");
    b.finish("ok");
    expect(l.inFlight).toBe(0);
    // a deadline that does not grow still gives up at its bound, holding nothing
    clock.advance(1000);
    const c = await l.acquire({
      keyless: true,
      deadlineAtMs: clock.nowMs() + 20_000,
      signal: null,
    });
    clock.advance(1000);
    const d = await l.acquire({
      keyless: true,
      deadlineAtMs: clock.nowMs() + 20_000,
      signal: null,
    });
    const fixed = clock.nowMs() + 30;
    await expect(
      l.acquire({ keyless: true, deadlineAtMs: () => fixed, signal: null }),
    ).rejects.toBeInstanceOf(EspnRateLimitedError);
    c.finish("ok");
    d.finish("ok");
    expect(l.inFlight).toBe(0);
  });

  it("the cross-process concurrency polls extend with a deadline that grows", async () => {
    const clock = fixedClock(NOW_ISO);
    const repo = new MemoryLimiterRepo();
    // two requests in flight in another process, sent 2 s ago (outside the 1/s window, inside the
    // 30 s in-flight horizon): every poll is refused for concurrency
    const other = (id: number) => ({
      id,
      at: T0 - 2000,
      keyless: true,
      origin: "server",
      outcome: "pending" as const,
    });
    repo.rows.push(other(900), other(901));
    let until = T0 + 2 * IN_FLIGHT_POLL_MS + 1;
    let sleeps = 0;
    const l = new EspnLimiter({
      repo,
      clock,
      origin: "server",
      sleep: () => {
        sleeps++;
        // the first poll: a later reader joins; the fourth: the other process finishes
        if (sleeps === 1) until = T0 + 8 * IN_FLIGHT_POLL_MS + 1;
        if (sleeps === 4) for (const r of repo.rows) r.outcome = "ok";
        if (sleeps > 10) throw new Error("runaway poll loop");
        return Promise.resolve();
      },
    });
    const t = await l.acquire({ keyless: true, deadlineAtMs: () => until, signal: null });
    // more polls than the first deadline allowed (2): the grown deadline's were added
    expect(sleeps).toBe(4);
    t.finish("ok");
    // with a deadline that never grows, the polls run out at its bound
    repo.rows.push(other(902), other(903));
    let polls = 0;
    const fixedL = new EspnLimiter({
      repo,
      clock,
      origin: "server",
      sleep: () => {
        polls++;
        if (polls > 10) throw new Error("runaway poll loop");
        return Promise.resolve();
      },
    });
    await expect(
      fixedL.acquire({
        keyless: true,
        deadlineAtMs: () => T0 + 2 * IN_FLIGHT_POLL_MS + 1,
        signal: null,
      }),
    ).rejects.toBeInstanceOf(EspnRateLimitedError);
    expect(polls).toBe(2);
  });

  it("every reader gone (the shared signal aborted): refused before any row is written", async () => {
    const clock = fixedClock(NOW_ISO);
    const repo = new MemoryLimiterRepo();
    const l = new EspnLimiter({ repo, clock, origin: "server" });
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      l.acquire({ keyless: true, deadlineAtMs: T0 + 20_000, signal: ctl.signal }),
    ).rejects.toBeInstanceOf(EspnRateLimitedError);
    expect(repo.rows).toHaveLength(0);
    expect(l.inFlight).toBe(0);
  });
});
