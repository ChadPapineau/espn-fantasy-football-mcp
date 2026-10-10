// surplus.test.ts — the league's surplus distribution (plan 10 C5; research 05 §1.2 rates, §1.6 eval
// 3): the rate of a run's best claim, linear binning that keeps the mean, the cold-start table as a
// Dirichlet prior, hostile observations rejected, clamping above the support, and properties.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WAIVER_DP } from "../../../../src/domain/analytics/constants.js";
import {
  WAIVER_FIT,
  fitSurplusDistribution,
  surplusObservationsFromRuns,
  surplusRate,
} from "../../../../src/domain/analytics/waiver-fit/index.js";
import { isValidRateDistribution } from "../../../../src/domain/analytics/waiverDp.js";

const coldMean = WAIVER_DP.rates.reduce((a, x) => a + x.r * x.p, 0);
const sum = (xs: readonly { p: number }[]) => xs.reduce((a, x) => a + x.p, 0);
const mean = (xs: readonly { r: number; p: number }[]) => xs.reduce((a, x) => a + x.r * x.p, 0);

describe("surplusRate and the runs' observations", () => {
  it("r = max(0, s) / (W + 1); unusable inputs give null", () => {
    expect(surplusRate(28, 13)).toBe(2);
    expect(surplusRate(-5, 3)).toBe(0);
    expect(surplusRate(10, 0)).toBe(10);
    for (const [s, W] of [
      [Number.NaN, 3],
      [3, Number.NaN],
      [3, -1],
      [Number.POSITIVE_INFINITY, 3],
    ] as const)
      expect(surplusRate(s, W)).toBeNull();
  });

  it("one observation per run: the best finite surplus; an empty or hostile run is r = 0", () => {
    const obs = surplusObservationsFromRuns([
      { W: 9, candidates: [{ s: 5 }, { s: 30 }, { s: Number.NaN }] },
      { W: 4, candidates: [] },
      { W: 4, candidates: [{ s: Number.POSITIVE_INFINITY }, { s: -3 }] },
      { W: -1, candidates: [{ s: 10 }] },
    ]);
    expect(obs).toEqual([{ r: 3 }, { r: 0 }, { r: 0 }]);
  });
});

describe("fitSurplusDistribution", () => {
  it("no observation: the cold-start distribution, its mean, basis-free", () => {
    const f = fitSurplusDistribution([]);
    expect(f.n).toBe(0);
    expect(f.observed_mean_r).toBeNull();
    expect(f.rates).toEqual(WAIVER_DP.rates.map((x) => ({ r: x.r, p: x.p })));
    expect(f.mean_r).toBeCloseTo(coldMean, 4);
    expect(f.prior_mean_r).toBeCloseTo(coldMean, 4);
    expect(f.prior_runs).toBe(WAIVER_FIT.surplusPriorRuns);
    expect(isValidRateDistribution(f.rates)).toBe(true);
  });

  it("observations exactly in the cold-start proportions reproduce it exactly", () => {
    const counts = [15, 15, 10, 6, 3, 1];
    const obs = WAIVER_DP.rates.flatMap((x, i) =>
      Array.from({ length: counts[i] ?? 0 }, () => ({ r: x.r })),
    );
    const f = fitSurplusDistribution(obs);
    expect(f.n).toBe(50);
    for (const x of WAIVER_DP.rates)
      expect(f.rates.find((y) => y.r === x.r)?.p ?? 0).toBeCloseTo(x.p, 9);
  });

  it("linear binning splits between neighbours and keeps the mean; the prior pulls toward the cold start", () => {
    const f = fitSurplusDistribution([{ r: 1.75 }], { prior_runs: 0 });
    expect(f.rates).toEqual([
      { r: 1, p: 0.5 },
      { r: 2.5, p: 0.5 },
    ]);
    expect(f.mean_r).toBeCloseTo(1.75, 9);
    const g = fitSurplusDistribution([{ r: 1.75 }], { prior_runs: 3 });
    expect(g.mean_r).toBeCloseTo((3 * coldMean + 1.75) / 4, 4);
  });

  it("an observation above the support's top is clamped there and counted", () => {
    const f = fitSurplusDistribution([{ r: 35 }, { r: 20 }], { prior_runs: 0 });
    expect(f.clamped).toBe(1);
    expect(f.rates).toEqual([{ r: 20, p: 1 }]);
    expect(f.observed_mean_r).toBe(27.5);
  });

  it("hostile observations are rejected, never used; weights count", () => {
    const f = fitSurplusDistribution(
      [
        { r: Number.NaN },
        { r: -1 },
        { r: Number.POSITIVE_INFINITY },
        { r: 2, weight: 0 },
        { r: 2, weight: -1 },
        { r: 2, weight: Number.NaN },
        { r: 4.5, weight: 2 },
      ],
      { prior_runs: 0 },
    );
    expect(f.rejected).toBe(6);
    expect(f.n).toBe(2);
    expect(f.rates).toEqual([{ r: 4.5, p: 1 }]);
    // a bad prior strength falls back to the default
    for (const prior_runs of [Number.NaN, -2])
      expect(fitSurplusDistribution([], { prior_runs }).prior_runs).toBe(
        WAIVER_FIT.surplusPriorRuns,
      );
  });

  it("property: a valid distribution whose mean is the prior/data blend (observations within the support)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 20, noNaN: true }), { maxLength: 60 }),
        fc.integer({ min: 0, max: 20 }),
        (rs, priorRuns) => {
          const f = fitSurplusDistribution(
            rs.map((r) => ({ r })),
            { prior_runs: priorRuns },
          );
          expect(isValidRateDistribution(f.rates)).toBe(true);
          expect(Math.abs(sum(f.rates) - 1)).toBeLessThan(1e-6);
          if (rs.length + priorRuns > 0) {
            const expected =
              (priorRuns * coldMean + rs.reduce((a, b) => a + b, 0)) / (priorRuns + rs.length);
            expect(Math.abs(mean(f.rates) - expected)).toBeLessThan(1e-6);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
