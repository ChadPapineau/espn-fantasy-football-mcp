// margin.test.ts — the calibration of a head-to-head forecast's margin (changelog R6-2, Stage C;
// plan 10 C2): the Student t and χ² quantiles against tabled values; the slope, its interval, the
// standardised residual and its range on a hand-computed case; a calibrated synthetic forecaster
// passes (and its intervals cover at about their level), while a regressed truth (the selection-bias
// signature) and a too-narrow spread fail; invariance properties; hostile input refused.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng, type Rng } from "../../../../src/domain/clock.js";
import {
  MARGIN,
  chiSquareQuantile,
  marginCalibration,
  normalQuantile,
  tQuantile,
  type MarginForecast,
} from "../../../../src/domain/analytics/calibration/index.js";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";

/** A standard normal draw (Box–Muller on the seeded stream). */
const gauss = (rng: Rng): number =>
  Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());

/**
 * n synthetic matchups: forecast margins spread like a season's (sd ≈ 10), a true sd of 30; the
 * realised margin is `scale` × forecast + noise of sd `trueSd`, the forecast claims sd `claimedSd`.
 */
function synthetic(
  seed: number,
  n: number,
  opts: { scale?: number; trueSd?: number; claimedSd?: number } = {},
): MarginForecast[] {
  const rng = seededRng(seed);
  const scale = opts.scale ?? 1;
  const trueSd = opts.trueSd ?? 30;
  const claimed = opts.claimedSd ?? 30;
  return Array.from({ length: n }, () => {
    const mean = 10 * gauss(rng);
    return { mean, sd: claimed, realised: scale * mean + trueSd * gauss(rng) };
  });
}

describe("tQuantile / chiSquareQuantile", () => {
  it("match tabled values", () => {
    expect(tQuantile(0.975, 5)).toBeCloseTo(2.5706, 2);
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.2281, 2);
    expect(tQuantile(0.975, 30)).toBeCloseTo(2.0423, 3);
    expect(tQuantile(0.995, 30)).toBeCloseTo(2.75, 2);
    expect(tQuantile(0.975, 134)).toBeCloseTo(1.9778, 3);
    // → the normal quantile as ν grows
    expect(tQuantile(0.975, 1e6)).toBeCloseTo(normalQuantile(0.975), 5);
    expect(chiSquareQuantile(0.975, 10)).toBeCloseTo(20.483, 0);
    expect(chiSquareQuantile(0.025, 10) / 3.247).toBeGreaterThan(0.99);
    expect(chiSquareQuantile(0.975, 136) / 136).toBeCloseTo(1.2513, 2);
    expect(chiSquareQuantile(0.025, 136) / 136).toBeCloseTo(0.7765, 2);
  });

  it("refuses a degree of freedom below 1 and a level outside (0, 1)", () => {
    for (const df of [0, 0.5, -1, Number.NaN]) {
      expect(() => tQuantile(0.975, df)).toThrow(AnalyticsError);
      expect(() => chiSquareQuantile(0.975, df)).toThrow(AnalyticsError);
    }
    expect(() => tQuantile(1, 10)).toThrow(AnalyticsError);
    expect(() => chiSquareQuantile(0, 10)).toThrow(AnalyticsError);
  });
});

describe("marginCalibration", () => {
  it("computes the slope, its interval, the residual and z² on a hand-computed case", () => {
    const m = marginCalibration([
      { mean: -10, sd: 10, realised: -8 },
      { mean: 0, sd: 10, realised: 1 },
      { mean: 10, sd: 10, realised: 12 },
    ]);
    // Sxx = 200, Sxy = 200 → slope 1; intercept 5/3; RSS = 2/3 on 1 df → se = √(2/3 / 200)
    expect(m.n).toBe(3);
    expect(m.slope).toBeCloseTo(1, 12);
    expect(m.intercept).toBeCloseTo(5 / 3, 12);
    expect(m.slope_se).toBeCloseTo(Math.sqrt(2 / 3 / 200), 12);
    expect(m.mean_residual).toBeCloseTo(5 / 3, 12);
    expect(m.z2).toBeCloseTo((0.04 + 0.01 + 0.04) / 3, 12);
    const t = tQuantile(0.975, 1);
    expect(m.slope_ci[0]).toBeCloseTo(1 - t * m.slope_se, 12);
    expect(m.slope_ci[1]).toBeCloseTo(1 + t * m.slope_se, 12);
    expect(m.slope_consistent).toBe(true);
    expect(m.z2_range[0]).toBeCloseTo(chiSquareQuantile(0.025, 3) / 3, 12);
    // a spread ten times too wide is outside the range a right spread produces
    expect(m.spread_consistent).toBe(false);
  });

  it("a calibrated synthetic forecaster passes; its intervals cover at about their level", () => {
    const m = marginCalibration(synthetic(1, 136));
    expect(m.slope_consistent).toBe(true);
    expect(m.spread_consistent).toBe(true);
    let slopeHits = 0;
    let spreadHits = 0;
    const reps = 400;
    for (let i = 0; i < reps; i++) {
      const r = marginCalibration(synthetic(100 + i, 136));
      if (r.slope_consistent) slopeHits += 1;
      if (r.spread_consistent) spreadHits += 1;
    }
    // nominal 95 %; binomial sd at 400 × 0.95 ≈ 1.1 points
    expect(slopeHits / reps).toBeGreaterThan(0.91);
    expect(slopeHits / reps).toBeLessThan(0.985);
    expect(spreadHits / reps).toBeGreaterThan(0.91);
    expect(spreadHits / reps).toBeLessThan(0.985);
  });

  it("detects the selection-bias signature (margins regressed toward 0) and a wrong spread at size", () => {
    const regressed = marginCalibration(synthetic(2, 4000, { scale: 0.5 }));
    expect(regressed.slope).toBeCloseTo(0.5, 1);
    expect(regressed.slope_consistent).toBe(false);
    expect(regressed.slope_ci[1]).toBeLessThan(1);
    const timid = marginCalibration(synthetic(3, 4000, { scale: 1.5 }));
    expect(timid.slope_ci[0]).toBeGreaterThan(1);
    const narrow = marginCalibration(synthetic(4, 1000, { claimedSd: 15 }));
    expect(narrow.z2).toBeCloseTo(4, 0);
    expect(narrow.spread_consistent).toBe(false);
    const wide = marginCalibration(synthetic(5, 1000, { claimedSd: 60 }));
    expect(wide.z2).toBeLessThan(wide.z2_range[0]);
    expect(wide.spread_consistent).toBe(false);
  });

  it("(property) rescaling every margin and sd leaves slope and z² unchanged; a shift in the realised margins moves only the intercept and the mean residual", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        (seed, c, shift) => {
          const xs = synthetic(seed, 40);
          const base = marginCalibration(xs);
          const scaled = marginCalibration(
            xs.map((x) => ({ mean: c * x.mean, sd: c * x.sd, realised: c * x.realised })),
          );
          expect(scaled.slope).toBeCloseTo(base.slope, 8);
          expect(scaled.z2).toBeCloseTo(base.z2, 8);
          expect(scaled.slope_consistent).toBe(base.slope_consistent);
          const shifted = marginCalibration(
            xs.map((x) => ({ ...x, realised: x.realised + shift })),
          );
          expect(shifted.slope).toBeCloseTo(base.slope, 8);
          expect(shifted.slope_se).toBeCloseTo(base.slope_se, 8);
          expect(shifted.intercept).toBeCloseTo(base.intercept + shift, 8);
          expect(shifted.mean_residual).toBeCloseTo(base.mean_residual + shift, 8);
        },
      ),
      { numRuns: 80 },
    );
  });

  it("refuses hostile input with a typed error", () => {
    const ok = synthetic(6, 10);
    const bad: unknown[] = [
      [],
      ok.slice(0, MARGIN.minN - 1),
      "not an array",
      [...ok, null],
      [...ok, { mean: Number.NaN, sd: 30, realised: 1 }],
      [...ok, { mean: 1, sd: 0, realised: 1 }],
      [...ok, { mean: 1, sd: -3, realised: 1 }],
      [...ok, { mean: 1, sd: 30, realised: Number.POSITIVE_INFINITY }],
      [...ok, { mean: 2e6, sd: 30, realised: 1 }],
      [...ok, { mean: "1", sd: 30, realised: 1 }],
      // forecast margins that are all equal: no slope
      ok.map((x) => ({ ...x, mean: 5 })),
    ];
    for (const b of bad)
      expect(() => marginCalibration(b as MarginForecast[])).toThrow(AnalyticsError);
  });
});
