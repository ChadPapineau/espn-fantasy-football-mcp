// kernels.test.ts — the shared kernels: the cooperative runner (plan 01 §1.1, plan 03 §1.2: batches
// of ≤ 20 ms CPU, a yield between batches, the CPU deadline → partial with the completed count),
// the seeded draws and quantiles, the gamma CDF/quantile, the Hungarian assignment, lineup totals,
// `data.inputs[]` and the error mapping fields.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedClock, seededRng, threadCpuClock } from "../../../src/domain/clock.js";
import { loopPacer, runCooperative } from "../../../src/domain/analytics/cooperative.js";
import { FORBIDDEN, solveAssignment } from "../../../src/domain/analytics/assignment.js";
import { AnalyticsError, ensure } from "../../../src/domain/analytics/errors.js";
import { collectInputs, mergeInputs, newestAsOf } from "../../../src/domain/analytics/inputs.js";
import {
  clamp,
  distFromSamples,
  gammaCdf,
  gammaCdfMeanCv,
  gammaDist,
  gammaDraw,
  gammaMultiplier,
  gammaQuantile,
  meanOf,
  normalCdf,
  normalDist,
  poissonDraw,
  quantileSorted,
  ranks,
  round,
  sigmaOf,
  spearman,
  zeroDist,
} from "../../../src/domain/analytics/math.js";
import {
  diffSd,
  lineupCov,
  lineupMoments,
  pairMoments,
  pWinInterval,
  pWinNormal,
  rho,
} from "../../../src/domain/analytics/totals.js";
import type { PlatformStamp } from "../../../src/domain/league/types.js";
import type { DatasetStamp } from "../../../src/domain/analytics/types.js";
import { dist, steppingPacer } from "./helpers.js";

describe("runCooperative", () => {
  it("runs every step once, in order, yielding before, between and after batches of ≤ batchMs", async () => {
    const seen: number[] = [];
    const pacer = steppingPacer(1);
    const r = await runCooperative(500, (i) => seen.push(i), {
      pacer,
      batchMs: 10,
      deadlineMs: null,
    });
    expect(seen).toEqual(Array.from({ length: 500 }, (_, i) => i));
    expect(r).toMatchObject({ completed: 500, partial: false });
    expect(r.batches).toBeGreaterThan(1);
    expect(pacer.yields).toBe(r.batches + 1);
    // a batch overruns its budget by at most the steps between two clock reads (adaptive ≥ 1)
    expect(r.max_batch_ms).toBeLessThanOrEqual(20);
  });

  it("A16a: the caller's work before and after a run never shares a turn with a batch", async () => {
    // a yield before the first step and after the last: a synchronous prelude (a parse, a
    // precompute) and postlude (assembling the answer) each get a turn of their own
    for (const [units, deadlineMs] of [
      [1, null],
      [37, null],
      [5_000, null],
      [5_000, 30],
    ] as const) {
      let done = 0;
      const at: number[] = [];
      let t = 0;
      const pacer = {
        nowMs: () => (t += 1),
        yieldToLoop: () => {
          at.push(done);
          return Promise.resolve();
        },
      };
      const r = await runCooperative(units, () => (done += 1), { pacer, batchMs: 8, deadlineMs });
      expect(at[0], `${String(units)}: first yield`).toBe(0);
      expect(at.at(-1), `${String(units)}: last yield`).toBe(r.completed);
      expect(at).toHaveLength(r.batches + 1);
      expect(r.partial).toBe(deadlineMs !== null);
    }
  });

  it("stops at the CPU deadline: partial, with the completed count", async () => {
    const r = await runCooperative(10_000, () => undefined, {
      pacer: steppingPacer(1),
      deadlineMs: 25,
    });
    expect(r.partial).toBe(true);
    expect(r.completed).toBeGreaterThan(0);
    expect(r.completed).toBeLessThan(10_000);
    expect(r.cpu_ms).toBeGreaterThanOrEqual(25);
  });

  it("clamps the batch to 1..20 ms, handles zero units and refuses a bad count", async () => {
    const idle = steppingPacer(1);
    expect(await runCooperative(0, () => undefined, { pacer: idle })).toMatchObject({
      completed: 0,
      batches: 0,
    });
    expect(idle.yields).toBe(0); // nothing to run: no turn given up
    const r = await runCooperative(50, () => undefined, {
      pacer: steppingPacer(1),
      batchMs: 500,
      deadlineMs: null,
    });
    expect(r.max_batch_ms).toBeLessThanOrEqual(21);
    await expect(runCooperative(-1, () => undefined, { pacer: steppingPacer(1) })).rejects.toThrow(
      RangeError,
    );
    await expect(runCooperative(1.5, () => undefined, { pacer: steppingPacer(1) })).rejects.toThrow(
      RangeError,
    );
  });

  it("A16a: a coarse step never makes a batch of batchMs plus one more step", async () => {
    // 10 ms steps against a 16 ms batch: one step per batch (the next would overrun), never two
    for (const stepMs of [10, 6, 3]) {
      let wall = 0;
      const pacer = { nowMs: () => wall, yieldToLoop: () => Promise.resolve() };
      const r = await runCooperative(40, () => (wall += stepMs), {
        pacer,
        batchMs: 16,
        deadlineMs: null,
      });
      expect(r.completed).toBe(40);
      expect(r.max_batch_ms, `${String(stepMs)} ms steps`).toBeLessThanOrEqual(16);
    }
    // a step longer than the batch still runs (one per batch) — progress is never blocked
    let wall = 0;
    const slow = { nowMs: () => wall, yieldToLoop: () => Promise.resolve() };
    const r = await runCooperative(5, () => (wall += 25), { pacer: slow, batchMs: 16 });
    expect(r).toMatchObject({ completed: 5, partial: false, batches: 5 });
  });

  it("A16a: cheap steps then a heavy one seen before never make a batch past batchMs", async () => {
    // the trade partner search's shape: a team's first package is heavy (its roster not yet
    // memoised, ~10 ms), the rest cheap (1 ms). Pacing from the last step alone ran 15 ms of cheap
    // steps and then the heavy one — a 25 ms turn. Once a heavy step has been timed, the batch
    // yields early enough for it: only the very first heavy step can pass the budget
    const costs = Array.from({ length: 400 }, (_, i) => (i % 25 === 7 ? 10 : 1));
    let wall = 0;
    const batches: number[] = [];
    let batchStart = 0;
    const pacer = {
      nowMs: () => wall,
      yieldToLoop: () => {
        if (wall > batchStart) batches.push(wall - batchStart);
        batchStart = wall;
        return Promise.resolve();
      },
    };
    const r = await runCooperative(400, (i) => (wall += costs[i] ?? 0), {
      pacer,
      batchMs: 16,
      deadlineMs: null,
    });
    expect(r).toMatchObject({ completed: 400, partial: false });
    expect(batches.filter((b) => b > 16)).toHaveLength(1); // the first heavy step only
    expect(Math.max(...batches.slice(batches.findIndex((b) => b > 16) + 1))).toBeLessThanOrEqual(
      16,
    );
  });

  it("A16a property: a batch passes batchMs only on a chunk longer than every chunk before it", async () => {
    // steps of 0.5..15.9 ms are each timed alone (a chunk of one step: the clock is read after every
    // step at this pace), so the claim is about steps: any batch over budget ends on a record step
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: 0.5, max: 15.9, noNaN: true }), { minLength: 1, maxLength: 120 }),
        async (costs) => {
          let wall = 0;
          let done = 0;
          const ends: { at: number; done: number }[] = [{ at: 0, done: 0 }];
          const pacer = {
            nowMs: () => wall,
            yieldToLoop: () => {
              ends.push({ at: wall, done });
              return Promise.resolve();
            },
          };
          const r = await runCooperative(
            costs.length,
            (i) => {
              wall += costs[i] ?? 0;
              done += 1;
            },
            { pacer, batchMs: 16, deadlineMs: null },
          );
          expect(r.completed).toBe(costs.length);
          for (let k = 1; k < ends.length; k++) {
            const a = ends[k - 1];
            const b = ends[k];
            if (a === undefined || b === undefined || b.done === a.done) continue;
            if (b.at - a.at <= 16 + 1e-9) continue;
            const last = costs[b.done - 1] ?? 0;
            const before = costs.slice(0, b.done - 1);
            expect(
              before.every((c) => c < last),
              `batch ${String(k)} over budget`,
            ).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the deadline counts the thread's CPU: a machine asleep mid-batch never cuts the run short", async () => {
    // wall time jumps 60 s inside one batch (a Maintenance Sleep, a preempted process); the thread
    // spent 0.1 ms of CPU per step — 400 steps are 40 ms of CPU, far under an 8 s deadline
    let wall = 0;
    let cpu = 0;
    let step = 0;
    const pacer = {
      nowMs: () => wall,
      cpuMs: () => cpu,
      yieldToLoop: () => Promise.resolve(),
    };
    const r = await runCooperative(
      400,
      () => {
        step += 1;
        cpu += 0.1;
        wall += step === 7 ? 60_000 : 0.1;
      },
      { pacer, batchMs: 16, deadlineMs: 8000 },
    );
    expect(r).toMatchObject({ completed: 400, partial: false });
    expect(r.cpu_ms).toBeCloseTo(40, 6);
    // the stall a heartbeat would see is still the wall time of that batch
    expect(r.max_batch_ms).toBeGreaterThanOrEqual(60_000);
  });

  it("the deadline still stops a run that spends the CPU: partial, the completed count", async () => {
    let wall = 0;
    let cpu = 0;
    const pacer = {
      nowMs: () => wall,
      cpuMs: () => cpu,
      yieldToLoop: () => Promise.resolve(),
    };
    const r = await runCooperative(
      10_000,
      () => {
        cpu += 1;
        wall += 1;
      },
      { pacer, batchMs: 10, deadlineMs: 100 },
    );
    expect(r.partial).toBe(true);
    expect(r.completed).toBeGreaterThanOrEqual(100);
    expect(r.completed).toBeLessThan(10_000);
    expect(r.cpu_ms).toBeGreaterThanOrEqual(100);
    // 0 ms: one step, then partial (the R5-m3 switch's tool-level contract)
    const zero = await runCooperative(10, () => (cpu += 0.01), { pacer, deadlineMs: 0 });
    expect(zero).toMatchObject({ completed: 1, partial: true });
  });

  it("the loop pacer reads the injected CPU meter; the real one is finite and never goes back", () => {
    let c = 3;
    const pacer = loopPacer(fixedClock(0), { cpuMs: () => (c += 2) });
    expect(pacer.cpuMs?.()).toBe(5);
    expect(pacer.cpuMs?.()).toBe(7);
    const real = loopPacer(fixedClock(0));
    const a = real.cpuMs?.() ?? Number.NaN;
    let x = 0;
    for (let i = 0; i < 200_000; i++) x += Math.sqrt(i);
    const b = real.cpuMs?.() ?? Number.NaN;
    expect(x).toBeGreaterThan(0);
    expect(Number.isFinite(a)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(threadCpuClock.cpuMs()).toBeGreaterThanOrEqual(b);
  });

  it("the loop pacer yields through setImmediate: queued work runs before the first step and mid-run", async () => {
    let t = 0;
    const clock = { nowMs: () => (t += 5), nowIso: () => new Date(t).toISOString() };
    let before = -1;
    let mid = -1;
    let after = -1;
    let step = 0;
    setImmediate(() => {
      before = step;
    });
    await runCooperative(
      200,
      () => {
        step += 1;
        if (step === 1)
          setImmediate(() => {
            mid = step;
          });
        if (step === 200)
          setImmediate(() => {
            after = step;
          });
      },
      { pacer: loopPacer(clock), batchMs: 10, deadlineMs: null },
    );
    expect(before).toBe(0); // the turn before the first batch
    expect(mid).toBeGreaterThan(1); // a turn between batches
    expect(mid).toBeLessThan(200);
    expect(after).toBe(200); // the turn after the last batch, before the run resolves
  });
});

describe("math", () => {
  it("clamp, round and Φ edge cases", () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(round(-0.00001)).toBe(0);
    expect(round(Infinity)).toBe(0);
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(Number.NaN)).toBe(0.5);
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(-Infinity)).toBe(0);
    expect(normalCdf(1.2815515655446004)).toBeCloseTo(0.9, 6);
  });

  it("seeded draws: gamma multipliers have mean 1 and the asked CV; Poisson the asked mean", () => {
    const rng = seededRng(11);
    const g = Array.from({ length: 40_000 }, () => gammaMultiplier(rng, 0.5));
    const m = meanOf(g);
    expect(m).toBeCloseTo(1, 1);
    expect(Math.sqrt(meanOf(g.map((x) => (x - m) ** 2)))).toBeCloseTo(0.5, 1);
    expect(gammaMultiplier(rng, 0)).toBe(1);
    expect(gammaDraw(rng, 0.3)).toBeGreaterThanOrEqual(0);
    expect(() => gammaDraw(rng, 0)).toThrow(RangeError);
    const pz = Array.from({ length: 20_000 }, () => poissonDraw(rng, 2.4));
    expect(meanOf(pz)).toBeCloseTo(2.4, 1);
    expect(poissonDraw(rng, 0)).toBe(0);
    expect(meanOf(Array.from({ length: 5000 }, () => poissonDraw(rng, 50)))).toBeCloseTo(50, 0);
  });

  it("quantiles, Dists and σ", () => {
    expect(quantileSorted([], 0.5)).toBe(0);
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    const d = distFromSamples([0, 0, 1, 2, 3], "position_cv");
    expect(d).toMatchObject({ mean: 1.2, p_zero: 0.4, p50: 1 });
    expect(distFromSamples([], "position_cv").p_zero).toBe(1);
    expect(distFromSamples([5, 6], "player_sim", 9).mean).toBe(9);
    expect(zeroDist("position_cv")).toMatchObject({ mean: 0, p_zero: 1 });
    expect(normalDist(0, 0, "position_cv").p_zero).toBe(1);
    expect(sigmaOf(normalDist(100, 20, "position_cv"))).toBeCloseTo(20, 3);
    expect(sigmaOf({ ...zeroDist("position_cv"), p10: 5, p90: 1 })).toBe(0);
  });

  it("the gamma CDF and quantile invert each other; the mean–CV form matches", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.3, max: 40, noNaN: true }),
        fc.double({ min: 0.02, max: 0.98, noNaN: true }),
        (shape, p) => Math.abs(gammaCdf(shape, gammaQuantile(p, shape)) - p) < 1e-6,
      ),
      { numRuns: 100 },
    );
    expect(gammaCdf(2, 0)).toBe(0);
    expect(gammaCdf(2, Infinity)).toBe(1);
    expect(() => gammaCdf(0, 1)).toThrow(RangeError);
    expect(gammaQuantile(0, 2)).toBe(0);
    expect(gammaQuantile(1, 2)).toBe(Infinity);
    expect(gammaCdfMeanCv(22, 22, 0.42)).toBeGreaterThan(0.45);
    const g = gammaDist(20, 0.4, "position_cv");
    expect(g.mean).toBe(20);
    expect(g.p10).toBeLessThan(g.p50);
    expect(g.p50).toBeLessThan(20);
    expect(gammaDist(0, 0.4, "position_cv").p_zero).toBe(1);
    expect(gammaDist(-2, 0.4, "position_cv")).toMatchObject({ mean: -2, p90: -2, p_zero: 0 });
  });

  it("ranks and Spearman", () => {
    expect(ranks([3, 1, 3])).toEqual([2.5, 1, 2.5]);
    expect(spearman([1, 2, 3], [10, 20, 30])).toBe(1);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(spearman([1], [1])).toBeNull();
    expect(spearman([1, 1], [1, 2])).toBeNull();
  });
});

describe("the Hungarian assignment", () => {
  it("finds the minimum-cost assignment (brute force on random 4×6 matrices)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 6, maxLength: 6 }), {
          minLength: 4,
          maxLength: 4,
        }),
        (m) => {
          const ans = solveAssignment(m);
          const cost = ans.reduce((s, j, i) => s + (m[i]?.[j] ?? 0), 0);
          let best = Infinity;
          const rec = (i: number, used: Set<number>, acc: number): void => {
            if (i === m.length) {
              best = Math.min(best, acc);
              return;
            }
            for (let j = 0; j < 6; j++)
              if (!used.has(j)) rec(i + 1, new Set([...used, j]), acc + (m[i]?.[j] ?? 0));
          };
          rec(0, new Set(), 0);
          return new Set(ans).size === ans.length && cost === best;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("handles empty, forbidden cells and refuses malformed matrices", () => {
    expect(solveAssignment([])).toEqual([]);
    expect(solveAssignment([[FORBIDDEN, 0]])).toEqual([1]);
    expect(() => solveAssignment([[1], [2]])).toThrow(RangeError);
    expect(() => solveAssignment([[1, 2], [3]])).toThrow(RangeError);
    expect(() => solveAssignment([[Number.NaN, 1]])).toThrow(RangeError);
  });
});

describe("lineup totals", () => {
  const m = (id: number, pos: string, team: number | null, mean: number) => ({
    player_id: id,
    position: pos,
    pro_team_id: team,
    points: dist(mean, 0.5),
  });
  it("correlates same-team QB–WR (research 05 §3.2 at the 5-pt TD), never across teams or without a team", () => {
    expect(rho(m(1, "QB", 5, 20), m(2, "WR", 5, 10))).toBe(0.353);
    expect(rho(m(1, "QB", 5, 20), m(2, "WR", 6, 10))).toBe(0);
    expect(rho(m(1, "QB", null, 20), m(2, "WR", null, 10))).toBe(0);
    expect(rho(m(1, "QB", 0, 20), m(2, "WR", 0, 10))).toBe(0);
    expect(rho(m(1, "K", 5, 20), m(2, "D/ST", 5, 10))).toBe(0);
    expect(rho(m(1, "QB", 5, 20), m(1, "QB", 5, 20))).toBe(1);
  });

  it("moments, covariance and the normal P(win)", () => {
    const me = [m(1, "QB", 5, 20), m(2, "WR", 5, 10)];
    const opp = [m(3, "RB", 7, 25)];
    const lm = lineupMoments(me);
    expect(lm.mu).toBe(30);
    expect(lm.v).toBeGreaterThan(sigmaOf(dist(20, 0.5)) ** 2 + sigmaOf(dist(10, 0.5)) ** 2);
    expect(lineupCov(me, opp)).toBe(0);
    const pm = pairMoments(me, opp);
    expect(pWinNormal(pm)).toBeGreaterThan(0.5);
    expect(pWinNormal({ mu_m: 1, mu_o: 0, v_m: 0, v_o: 0, cov: 0 })).toBe(1);
    expect(pWinNormal({ mu_m: 0, mu_o: 1, v_m: 0, v_o: 0, cov: 0 })).toBe(0);
    expect(pWinNormal({ mu_m: 1, mu_o: 1, v_m: 0, v_o: 0, cov: 0 })).toBe(0.5);
    expect(diffSd({ mu_m: 0, mu_o: 0, v_m: 1, v_o: 1, cov: 5 })).toBe(0);
    const [lo, hi] = pWinInterval(pm, 3);
    expect(lo).toBeLessThan(pWinNormal(pm));
    expect(hi).toBeGreaterThan(pWinNormal(pm));
    expect(pWinInterval({ mu_m: 1, mu_o: 0, v_m: 0, v_o: 0, cov: 0 }, 0)).toEqual([1, 1]);
  });
});

describe("inputs and errors", () => {
  const clock = fixedClock("2026-10-06T12:00:00.000Z");
  const ds: DatasetStamp = {
    source: "nflverse:injuries",
    as_of: "2026-10-06T06:00:00.000Z",
    fetched_at: "2026-10-06T07:00:00.000Z",
    checked_at: "2026-10-06T07:00:00.000Z",
    freshness_class: "nflverse_injuries",
    file_version: "v1",
  };
  const ps: PlatformStamp = {
    source: "espn:mRoster",
    as_of: "2026-10-06T11:59:00.000Z",
    fetched_at: "2026-10-06T11:59:30.000Z",
    freshness: "espn_roster",
    provisional: true,
    cache: "miss",
    drift: null,
    degraded: null,
  };

  it("collects one row per source, newest wins, sorted; provisional platform reads stay provisional", () => {
    const rows = collectInputs(
      [ps, ds, null, undefined, { ...ds, as_of: "2026-10-05T00:00:00.000Z" }],
      clock,
    );
    expect(rows.map((r) => r.source)).toEqual(["espn:mRoster", "nflverse:injuries"]);
    expect(rows[0]?.freshness).toBe("provisional");
    expect(rows[1]?.as_of).toBe("2026-10-06T06:00:00.000Z");
    expect(rows[1]?.age_s).toBe(5 * 3600);
    const merged = mergeInputs(rows, [
      { source: "espn:mRoster", as_of: "2026-10-06T12:00:00.000Z", age_s: 0, freshness: "fresh" },
    ]);
    expect(merged[0]?.freshness).toBe("fresh");
    expect(newestAsOf(merged, "x")).toBe("2026-10-06T12:00:00.000Z");
    expect(newestAsOf([], "fallback")).toBe("fallback");
    expect(newestAsOf([{ as_of: "not a date" }], "fallback")).toBe("fallback");
  });

  it("AnalyticsError carries the mapper's effCode and only a safe field", () => {
    const e = new AnalyticsError("invalid_request", "bad", "players");
    expect(e).toMatchObject({
      code: "invalid_request",
      effCode: "VALIDATION",
      effDetails: { field: "players", reason: "invalid_request" },
    });
    expect(new AnalyticsError("no_settings", "x").effCode).toBe("STALE_ONLY");
    expect(new AnalyticsError("dataset_never_loaded", "x").effCode).toBe("STALE_ONLY");
    expect(new AnalyticsError("not_in_phase", "x").effCode).toBe("VALIDATION");
    expect(new AnalyticsError("invalid_request", "x", "bad field <script>").effDetails).toEqual({
      reason: "invalid_request",
    });
    expect(() => {
      ensure(false, "nope", "n_sims");
    }).toThrow(AnalyticsError);
    expect(() => {
      ensure(true, "fine");
    }).not.toThrow();
  });
});
