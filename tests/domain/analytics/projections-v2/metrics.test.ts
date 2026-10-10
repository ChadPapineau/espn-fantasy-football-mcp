// metrics.test.ts — the backtest's scoring rules (sib research 05 §1-Evaluation; plan 10 C1): the
// sample CRPS against hand values and its properties (fast-check: ≥ 0, a point mass is |x − y|,
// translation invariance, a sharper correct forecast scores lower), the gamma closed form against
// the sample estimator (with and without a zero mass), pinball, inclusive coverage, Spearman within
// groups.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "../../../../src/domain/clock.js";
import { gammaCdf, gammaMultiplier } from "../../../../src/domain/analytics/math.js";
import {
  covered,
  crpsGamma,
  crpsSample,
  crpsSorted,
  meanOrNull,
  pinball,
  spearmanWithin,
} from "../../../../src/domain/analytics/projections-v2/metrics.js";

describe("crpsSorted / crpsSample", () => {
  it("a single sample is the absolute error", () => {
    expect(crpsSorted([5], 2)).toBe(3);
    expect(crpsSample([1.5], 4)).toBe(2.5);
  });

  it("matches a hand computation (fair estimator)", () => {
    // sample {0, 10}, y = 4: mean|x − y| = (4 + 6)/2 = 5; Σ_{i<j}|xi − xj| / (n(n−1)) = 10 / 2 = 5
    expect(crpsSorted([0, 10], 4)).toBeCloseTo(0, 12);
    // {0, 2, 4}, y = 1: mean abs = (1 + 1 + 3)/3 = 5/3; pairs 2 + 4 + 2 = 8 → 8/6
    expect(crpsSorted([0, 2, 4], 1)).toBeCloseTo(5 / 3 - 8 / 6, 12);
  });

  it("is NaN on an empty sample", () => {
    expect(Number.isNaN(crpsSorted([], 1))).toBe(true);
  });

  it("property: ≥ 0 up to the fair estimator's bias, translation-invariant, order-free", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -50, max: 50, noNaN: true }), { minLength: 2, maxLength: 40 }),
        fc.double({ min: -60, max: 60, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        (xs, y, shift) => {
          const c = crpsSample(xs, y);
          const spread = Math.max(...xs) - Math.min(...xs);
          // the fair estimator can dip below 0 by at most the spread / n
          expect(c).toBeGreaterThanOrEqual(-spread / xs.length - 1e-9);
          expect(
            crpsSample(
              xs.map((x) => x + shift),
              y + shift,
            ),
          ).toBeCloseTo(c, 6);
          expect(crpsSample([...xs].reverse(), y)).toBeCloseTo(c, 9);
        },
      ),
    );
  });

  it("a sharper forecast centred on the outcome scores lower than a wide one", () => {
    const rng = seededRng(7);
    const tight = Array.from({ length: 400 }, () => 10 * gammaMultiplier(rng, 0.2));
    const wide = Array.from({ length: 400 }, () => 10 * gammaMultiplier(rng, 0.8));
    expect(crpsSample(tight, 10)).toBeLessThan(crpsSample(wide, 10));
  });
});

describe("crpsGamma", () => {
  it("agrees with the sample estimator on a large gamma sample", () => {
    const rng = seededRng(11);
    for (const [mean, cv, y] of [
      [12, 0.6, 3],
      [12, 0.6, 25],
      [20, 0.4, 20],
      [5, 0.9, 0],
    ] as const) {
      const xs = Array.from({ length: 20000 }, () => mean * gammaMultiplier(rng, cv));
      expect(crpsGamma(mean, cv, y)).toBeCloseTo(crpsSample(xs, y), 1);
    }
  });

  it("equals ∫ (F(x) − 1{x ≥ y})² dx of the zero-inflated mixture (numeric integration)", () => {
    const integral = (mean: number, cv: number, y: number, p: number): number => {
      const a = 1 / (cv * cv);
      const F = (x: number): number => (x < 0 ? 0 : 1 - p + p * gammaCdf(a, (x * a) / mean));
      const hi = Math.max(y, mean) * 12;
      const steps = 60000;
      const h = hi / steps;
      let s = 0;
      for (let i = 0; i < steps; i++) {
        const x = (i + 0.5) * h;
        const d = F(x) - (x >= y ? 1 : 0);
        s += d * d * h;
      }
      return s;
    };
    for (const p of [1, 0.7, 0.3])
      for (const y of [0, 4, 15, 30])
        expect(crpsGamma(12, 0.6, y, p)).toBeCloseTo(integral(12, 0.6, y, p), 2);
  });

  it("a non-positive mean or CV is a point mass", () => {
    expect(crpsGamma(0, 0.6, 3)).toBe(3);
    expect(crpsGamma(7, 0, 3)).toBe(4);
    expect(crpsGamma(-2, 0.5, 1)).toBe(1);
    // p = 0: a point mass at zero whatever the active part
    expect(crpsGamma(12, 0.6, 5, 0)).toBeCloseTo(5, 12);
  });

  it("property: a mean nearer the outcome scores lower at the same CV", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 2, max: 30, noNaN: true }),
        fc.double({ min: 0.2, max: 1, noNaN: true }),
        (y, cv) => {
          expect(crpsGamma(y, cv, y)).toBeLessThan(crpsGamma(y * 2.5, cv, y));
        },
      ),
    );
  });
});

describe("pinball / covered / spearmanWithin / meanOrNull", () => {
  it("pinball is asymmetric by τ", () => {
    expect(pinball(0.9, 10, 20)).toBeCloseTo(9, 12);
    expect(pinball(0.9, 10, 0)).toBeCloseTo(1, 12);
    expect(pinball(0.5, 10, 10)).toBe(0);
  });

  it("coverage is inclusive at both ends", () => {
    expect(covered(0, 10, 0)).toBe(true);
    expect(covered(0, 10, 10)).toBe(true);
    expect(covered(0, 10, 10.01)).toBe(false);
  });

  it("averages per-group Spearman and skips tiny or constant groups", () => {
    const rows = [
      { group: "a", forecast: 1, outcome: 1 },
      { group: "a", forecast: 2, outcome: 2 },
      { group: "a", forecast: 3, outcome: 3 },
      { group: "b", forecast: 1, outcome: 3 },
      { group: "b", forecast: 2, outcome: 2 },
      { group: "b", forecast: 3, outcome: 1 },
      { group: "c", forecast: 1, outcome: 1 },
      { group: "d", forecast: 1, outcome: 5 },
      { group: "d", forecast: 1, outcome: 6 },
      { group: "d", forecast: 1, outcome: 7 },
    ];
    expect(spearmanWithin(rows)).toEqual({ mean: 0, groups: 2 });
    expect(spearmanWithin([])).toEqual({ mean: null, groups: 0 });
  });

  it("meanOrNull", () => {
    expect(meanOrNull([])).toBeNull();
    expect(meanOrNull([1, 2, 3])).toBe(2);
  });
});
