// waiver-dp.test.ts — the waiver-priority DP (research 05 §1.2): the cold-start Π(k, W) table cell
// for cell (Π(2, 13) within 0.5 of 29.5 — plan 10 A9a (i), changelog R5-1), V(1,16) / V(10,16),
// the drift and demand sensitivities the research quotes, the band at ×0.5 / ×1.5, and the
// monotonicity the option argument implies (Π falls with k, rises with W, unspent priority after the
// last run is worth 0).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  demandOf,
  premiumBand,
  priorityPremium,
  solvePremiumTable,
} from "../../../src/domain/analytics/waiverDp.js";

/** Research 05 §1.2's table: rows k = 1..10, columns W = 1, 3, …, 15. */
const TABLE: readonly (readonly number[])[] = [
  [1.8, 6.8, 12.8, 18.9, 25.0, 31.1, 37.5, 44.0],
  [1.2, 4.9, 9.5, 14.4, 19.5, 24.5, 29.5, 34.5],
  [0.9, 3.7, 7.2, 11.2, 15.4, 19.6, 23.7, 27.8],
  [0.6, 2.9, 5.6, 8.8, 12.2, 15.7, 19.1, 22.5],
  [0.5, 2.2, 4.4, 6.9, 9.7, 12.5, 15.4, 18.2],
  [0.3, 1.7, 3.5, 5.5, 7.7, 10.0, 12.3, 14.6],
  [0.2, 1.4, 2.8, 4.3, 6.1, 7.9, 9.7, 11.6],
  [0.2, 1.0, 2.2, 3.4, 4.7, 6.2, 7.6, 9.0],
  [0.1, 0.8, 1.6, 2.5, 3.6, 4.7, 5.8, 6.9],
  [0.1, 0.5, 1.2, 1.8, 2.6, 3.3, 4.1, 4.9],
];
const WS = [1, 3, 5, 7, 9, 11, 13, 15];

describe("the cold-start Π(k, W) table (research 05 §1.2)", () => {
  it("Π(2, 13) is within 0.5 of 29.5 (plan 10 A9a (i), hard)", () => {
    expect(Math.abs(priorityPremium(2, 13, 10) - 29.5)).toBeLessThan(0.5);
  });

  it.each(TABLE.map((row, i) => [i + 1, row] as const))("row k = %i matches to 0.05", (k, row) => {
    row.forEach((cell, j) => {
      expect(Math.abs(priorityPremium(k, WS[j] ?? 0, 10) - cell)).toBeLessThan(0.051);
    });
  });

  it("V(1, 16) = 95.8 and V(10, 16) = 48.5 — the whole order is worth about two starter-weeks", () => {
    const t = solvePremiumTable({ teams: 10 });
    expect(t.value(1, 16)).toBeCloseTo(95.8, 1);
    expect(t.value(10, 16)).toBeCloseTo(48.5, 1);
  });

  it("the per-week thresholds r* = Π / (W + 1) with 10 weeks left (2.50 … 0.26)", () => {
    const expected = [2.5, 1.95, 1.54, 1.22, 0.97, 0.77, 0.61, 0.47, 0.36, 0.26];
    expected.forEach((r, i) => {
      expect(priorityPremium(i + 1, 9, 10) / 10).toBeCloseTo(r, 1);
    });
  });

  it("the drift and demand sensitivities the research quotes (Π(1, 9))", () => {
    expect(solvePremiumTable({ teams: 10, drift: 0.15 }).premium(1, 9)).toBeCloseTo(26.8, 1);
    expect(solvePremiumTable({ teams: 10, drift: 0.35 }).premium(1, 9)).toBeCloseTo(23.2, 1);
    expect(solvePremiumTable({ teams: 10, demandScale: 0.5 }).premium(1, 9)).toBeCloseTo(19.9, 1);
    expect(solvePremiumTable({ teams: 10, demandScale: 1.5 }).premium(1, 9)).toBeCloseTo(27.2, 1);
  });
});

describe("the premium band (plan 07 E5; ADV OBJ-03)", () => {
  it("is populated: low < premium < high wherever the premium is positive", () => {
    for (let k = 1; k <= 9; k++)
      for (const W of [1, 5, 9, 13]) {
        const b = premiumBand(k, W, 10);
        expect(b.low).toBeLessThan(b.premium);
        expect(b.premium).toBeLessThan(b.high);
      }
  });

  it("scales almost linearly with the surplus (research 05 §1.2 reading)", () => {
    const b = premiumBand(1, 9, 10);
    expect(b.low / b.premium).toBeGreaterThan(0.4);
    expect(b.low / b.premium).toBeLessThan(0.6);
    expect(b.high / b.premium).toBeGreaterThan(1.3);
    expect(b.high / b.premium).toBeLessThan(1.7);
  });
});

describe("structure", () => {
  it("unspent priority after the last run is worth zero: Π(k, 0) = 0 for every k", () => {
    for (let k = 1; k <= 10; k++) expect(priorityPremium(k, 0, 10)).toBe(0);
  });

  it("property: Π falls with k and rises with W; fractional W interpolates between neighbours", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 19 }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        (n, k0, W) => {
          const k = Math.min(k0, n - 1);
          const t = solvePremiumTable({ teams: n });
          const a = t.premium(k, W);
          if (t.premium(k + 1, W) > a + 1e-9) return false;
          if (t.premium(k, Math.min(22, W + 1)) < a - 1e-9) return false;
          const lo = t.premium(k, Math.floor(W));
          const hi = t.premium(k, Math.min(22, Math.floor(W) + 1));
          return a >= Math.min(lo, hi) - 1e-9 && a <= Math.max(lo, hi) + 1e-9;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("clamps W into the table and refuses bad positions, sizes and parameters", () => {
    const t = solvePremiumTable({ teams: 10 });
    expect(t.premium(1, -3)).toBe(0);
    expect(t.premium(1, 1e9)).toBe(t.premium(1, 22));
    expect(t.premium(1, Number.NaN)).toBe(0);
    expect(() => t.premium(0, 3)).toThrow(RangeError);
    expect(() => t.premium(11, 3)).toThrow(RangeError);
    expect(() => t.premium(1.5, 3)).toThrow(RangeError);
    expect(() => solvePremiumTable({ teams: 1 })).toThrow(RangeError);
    expect(() => solvePremiumTable({ teams: 21 })).toThrow(RangeError);
    expect(() => solvePremiumTable({ teams: 10.5 })).toThrow(RangeError);
    expect(() => solvePremiumTable({ teams: 10, surplusScale: 0 })).toThrow(RangeError);
    expect(() => solvePremiumTable({ teams: 10, demandScale: Number.NaN })).toThrow(RangeError);
    expect(() => solvePremiumTable({ teams: 10, drift: 1 })).toThrow(RangeError);
  });

  it("is memoised per parameter set (the same object back)", () => {
    expect(solvePremiumTable({ teams: 12 })).toBe(solvePremiumTable({ teams: 12 }));
  });

  it("the demand curve is capped and reads non-positive or non-finite rates as the floor", () => {
    expect(demandOf(0)).toBeCloseTo(0.05);
    expect(demandOf(-4)).toBeCloseTo(0.05);
    expect(demandOf(Number.NaN)).toBeCloseTo(0.05);
    expect(demandOf(2.5)).toBeCloseTo(0.25);
    expect(demandOf(100)).toBe(0.85);
    expect(demandOf(2.5, 1.5)).toBeCloseTo(0.375);
  });
});
