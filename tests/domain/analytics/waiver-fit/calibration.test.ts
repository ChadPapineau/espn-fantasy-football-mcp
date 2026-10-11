// calibration.test.ts — P(clears_to_FA) calibration and the demand-scale fit (plan 10 C5: "calibrated
// within ±10 points … soft where n < 30"; research 05 §8.4 reliability by decile): bins, Brier, the
// in-the-large gap, judged bins only, the soft flag, hostile observations rejected; the clears
// probability is E5's formula; the scale fit recovers a planted multiplier and says when it hits
// a bound; the curve fit (B2b) recovers a planted intercept and slope separately and says when one
// sits on a bound.
import { describe, expect, it } from "vitest";
import { WAIVER_DP } from "../../../../src/domain/analytics/constants.js";
import {
  WAIVER_FIT,
  calibrateClearsToFa,
  clearProbability,
  clearProbabilityCurve,
  demandCurveOf,
  fitDemandCurve,
  fitDemandScale,
  type ClearsObservation,
  type ClearsOutcome,
} from "../../../../src/domain/analytics/waiver-fit/index.js";
import { demandOf } from "../../../../src/domain/analytics/waiverDp.js";

/** n observations at p with exactly round(n·rate) cleared. */
const at = (p: number, n: number, rate: number): ClearsObservation[] =>
  Array.from({ length: n }, (_, i) => ({ p, cleared: i < Math.round(n * rate) }));

describe("calibrateClearsToFa", () => {
  it("a perfectly calibrated set: deviations 0, within tolerance, Brier as computed", () => {
    const obs = [...at(0.15, 20, 0.15), ...at(0.55, 20, 0.55), ...at(0.95, 20, 0.95)];
    const c = calibrateClearsToFa(obs);
    expect(c.n).toBe(60);
    expect(c.soft).toBe(false);
    expect(c.max_abs_deviation).toBe(0);
    expect(c.within_tolerance).toBe(true);
    expect(c.in_the_large).toBeCloseTo(0, 4);
    const brier =
      (3 * 0.85 ** 2 +
        17 * 0.15 ** 2 +
        11 * 0.45 ** 2 +
        9 * 0.55 ** 2 +
        19 * 0.05 ** 2 +
        0.95 ** 2) /
      60;
    expect(c.brier).toBeCloseTo(brier, 4);
    expect(c.bins).toHaveLength(WAIVER_FIT.calibrationBins);
    expect(c.bins[1]?.n).toBe(20);
    expect(c.bins[0]?.mean_p).toBeNull();
    expect(c.bins[0]?.judged).toBe(false);
  });

  it("a miscalibrated bin beyond ±10 points fails; a thin bin is not judged", () => {
    const obs = [...at(0.6, 30, 0.85), ...at(0.05, 5, 1)];
    const c = calibrateClearsToFa(obs);
    expect(c.max_abs_deviation).toBeCloseTo(26 / 30 - 0.6, 4);
    expect(c.within_tolerance).toBe(false);
    expect(c.bins[0]?.judged).toBe(false);
    expect(c.bins[0]?.deviation).toBeCloseTo(0.95, 4);
    // p = 1 lands in the last bin
    expect(calibrateClearsToFa(at(1, 12, 1)).bins.at(-1)?.n).toBe(12);
  });

  it("soft below 30; no judged bin → verdict null; hostile observations rejected", () => {
    const c = calibrateClearsToFa([
      ...at(0.5, 5, 0.5),
      { p: Number.NaN, cleared: true },
      { p: 1.2, cleared: true },
      { p: -0.1, cleared: false },
      { p: 0.5, cleared: "yes" as unknown as boolean },
    ]);
    expect(c.n).toBe(5);
    expect(c.rejected).toBe(4);
    expect(c.soft).toBe(true);
    expect(c.within_tolerance).toBeNull();
    expect(c.max_abs_deviation).toBeNull();
    const empty = calibrateClearsToFa([]);
    expect(empty.brier).toBeNull();
    expect(empty.base_rate).toBeNull();
    expect(empty.in_the_large).toBeNull();
  });

  it("options: bins, the judged minimum, the tolerance (bad bins fall back)", () => {
    const obs = at(0.6, 10, 0.75);
    expect(
      calibrateClearsToFa(obs, { bins: 4, min_bin_n: 1, tolerance: 0.2 }).within_tolerance,
    ).toBe(true);
    expect(calibrateClearsToFa(obs, { bins: 0 }).bins).toHaveLength(WAIVER_FIT.calibrationBins);
    expect(calibrateClearsToFa(obs, { bins: 2.5 }).bins).toHaveLength(WAIVER_FIT.calibrationBins);
  });
});

describe("clearProbability — E5's formula", () => {
  it("(1 − min(1, q(r)·λ))^m", () => {
    expect(clearProbability(0, 9)).toBeCloseTo(0.95 ** 9, 12);
    expect(clearProbability(2, 9)).toBeCloseTo((1 - demandOf(2)) ** 9, 12);
    expect(clearProbability(2, 9, 0.5)).toBeCloseTo((1 - demandOf(2, 0.5)) ** 9, 12);
    expect(clearProbability(100, 9, 5)).toBeCloseTo(0.15 ** 9, 15);
    expect(clearProbability(2, 0)).toBe(1);
    expect(clearProbability(2, Number.NaN)).toBe(1);
    expect(clearProbability(2, 3.7)).toBeCloseTo((1 - demandOf(2)) ** 3, 12);
  });
});

describe("fitDemandScale", () => {
  /** Outcomes whose clear frequencies match the model at scale λ (deterministic). */
  function planted(scale: number): ClearsOutcome[] {
    const out: ClearsOutcome[] = [];
    for (const r of [0, 0.5, 1, 2, 3]) {
      const p = clearProbability(r, 9, scale);
      const n = 400;
      const k = Math.round(n * p);
      for (let i = 0; i < n; i++) out.push({ r, rivals: 9, cleared: i < k });
    }
    return out;
  }

  it("recovers a planted multiplier and beats the cold curve on likelihood", () => {
    for (const scale of [0.4, 1, 2]) {
      const f = fitDemandScale(planted(scale));
      expect(Math.abs(f.scale - scale) / scale).toBeLessThan(0.05);
      expect(f.at_bound).toBe(false);
      expect(f.log_likelihood ?? -1).toBeGreaterThanOrEqual((f.log_likelihood_cold ?? 0) - 1e-9);
      expect(f.n).toBe(2000);
    }
  });

  it("everyone clears: the optimum sits on the lower bound, said; no usable outcome → 1", () => {
    const f = fitDemandScale(
      Array.from({ length: 50 }, () => ({ r: 0, rivals: 9, cleared: true })),
    );
    expect(f.at_bound).toBe(true);
    expect(f.scale).toBeLessThan(WAIVER_FIT.demandScale.min * 1.01);
    const none = fitDemandScale([
      { r: Number.NaN, rivals: 9, cleared: true },
      { r: 1, rivals: 0, cleared: true },
      { r: 1, rivals: 3, cleared: "no" as unknown as boolean },
    ]);
    expect(none).toEqual({
      scale: 1,
      n: 0,
      rejected: 3,
      log_likelihood: null,
      log_likelihood_cold: null,
      at_bound: false,
    });
  });
});

describe("fitDemandCurve (intercept and slope separately — the B2b fix)", () => {
  /** Outcomes whose clear frequencies match the curve (q0, q1) exactly (deterministic). */
  function planted(q0: number, q1: number): ClearsOutcome[] {
    const out: ClearsOutcome[] = [];
    for (const r of [0, 0.5, 1, 2, 4, 6]) {
      const p = clearProbabilityCurve(r, 9, q0, q1);
      const n = 600;
      const k = Math.round(n * p);
      for (let i = 0; i < n; i++) out.push({ r, rivals: 9, cleared: i < k });
    }
    return out;
  }

  it("the curve is the cold start's at (0.05, 0.08), capped at qCap; hostile parameters read as 0", () => {
    for (const r of [0, 0.3, 1, 2.5, 7, 20, Number.NaN, -1])
      expect(demandCurveOf(r, WAIVER_DP.q0, WAIVER_DP.q1)).toBeCloseTo(demandOf(r), 12);
    expect(demandCurveOf(100, 0.5, 1)).toBe(WAIVER_DP.qCap);
    expect(demandCurveOf(2, Number.NaN, -3)).toBe(0);
    expect(clearProbabilityCurve(2, 0, 0.1, 0.1)).toBe(1);
    expect(clearProbabilityCurve(2, Number.NaN, 0.1, 0.1)).toBe(1);
    for (const r of [0, 1, 3])
      expect(clearProbabilityCurve(r, 9, WAIVER_DP.q0, WAIVER_DP.q1)).toBeCloseTo(
        clearProbability(r, 9),
        12,
      );
  });

  it("recovers a planted intercept and slope — where one multiplier cannot — and beats the cold curve", () => {
    for (const [q0, q1] of [
      [0.005, 0.03],
      [0.02, 0.15],
      [0.08, 0.01],
    ] as const) {
      const outcomes = planted(q0, q1);
      const f = fitDemandCurve(outcomes);
      expect(Math.abs(f.q0 - q0) / q0, `q0 ${String(q0)}`).toBeLessThan(0.1);
      expect(Math.abs(f.q1 - q1) / q1, `q1 ${String(q1)}`).toBeLessThan(0.1);
      expect(f.at_bound).toEqual({ q0: false, q1: false });
      expect(f.n).toBe(3600);
      expect(f.log_likelihood ?? -1).toBeGreaterThanOrEqual((f.log_likelihood_cold ?? 0) - 1e-9);
      // the curve fits at least as well as the best multiplier on the cold curve
      const s = fitDemandScale(outcomes);
      expect(f.log_likelihood ?? -1).toBeGreaterThanOrEqual((s.log_likelihood ?? 0) - 1e-6);
    }
  });

  it("demand that does not rise with the rate: the slope sits on its lower bound, said; no usable outcome → the cold start", () => {
    const flat: ClearsOutcome[] = [];
    for (const r of [0, 1, 2, 4])
      for (let i = 0; i < 300; i++) flat.push({ r, rivals: 9, cleared: i >= 15 });
    const f = fitDemandCurve(flat);
    expect(f.at_bound.q1).toBe(true);
    expect(f.at_bound.q0).toBe(false);
    // 5 % claimed by nine rivals → a per-rival demand near 1 − 0.95^(1/9)
    expect(Math.abs(f.q0 - (1 - 0.95 ** (1 / 9)))).toBeLessThan(0.001);
    const none = fitDemandCurve([
      { r: Number.NaN, rivals: 9, cleared: true },
      { r: 1, rivals: 0, cleared: true },
      { r: 1, rivals: 3, cleared: "no" as unknown as boolean },
    ]);
    expect(none).toEqual({
      q0: WAIVER_DP.q0,
      q1: WAIVER_DP.q1,
      n: 0,
      rejected: 3,
      log_likelihood: null,
      log_likelihood_cold: null,
      at_bound: { q0: false, q1: false },
    });
  });

  it("is deterministic and keeps its parameters inside the bounds", () => {
    const outcomes = planted(0.01, 0.05);
    expect(fitDemandCurve(outcomes)).toEqual(fitDemandCurve(outcomes));
    const all = fitDemandCurve(
      Array.from({ length: 40 }, (_, i) => ({ r: i % 5, rivals: 9, cleared: false })),
    );
    expect(all.q0).toBeLessThanOrEqual(WAIVER_FIT.demandCurve.q0.max);
    expect(all.q1).toBeLessThanOrEqual(WAIVER_FIT.demandCurve.q1.max);
    expect(all.q0).toBeGreaterThanOrEqual(WAIVER_FIT.demandCurve.q0.min);
  });
});
