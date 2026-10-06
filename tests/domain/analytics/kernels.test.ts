// kernels.test.ts — the shared kernels: the cooperative runner (plan 01 §1.1, plan 03 §1.2: batches
// of ≤ 20 ms CPU, a yield between batches, the CPU deadline → partial with the completed count),
// the seeded draws and quantiles, the gamma CDF/quantile, the Hungarian assignment, lineup totals,
// `data.inputs[]` and the error mapping fields.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
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
  it("runs every step once, in order, yielding between batches of ≤ batchMs", async () => {
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
    expect(pacer.yields).toBe(r.batches - 1);
    // a batch overruns its budget by at most the steps between two clock reads (adaptive ≥ 1)
    expect(r.max_batch_ms).toBeLessThanOrEqual(20);
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
    expect(await runCooperative(0, () => undefined, { pacer: steppingPacer(1) })).toMatchObject({
      completed: 0,
      batches: 0,
    });
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

  it("the loop pacer yields through setImmediate: a timer queued before the run fires mid-run", async () => {
    let t = 0;
    const clock = { nowMs: () => (t += 5), nowIso: () => new Date(t).toISOString() };
    let fired = -1;
    let step = 0;
    setImmediate(() => {
      fired = step;
    });
    await runCooperative(
      200,
      () => {
        step += 1;
      },
      { pacer: loopPacer(clock), batchMs: 10, deadlineMs: null },
    );
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThan(200);
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
