// reliability.test.ts — P(win) calibration per decile (plan 10 C2; sib research 05 §12 "Evaluation
// of the evaluator": a calibrated synthetic forecaster passes, a miscalibrated one fails): the
// Wilson interval, the normal quantile, the forecasts needed to resolve ±5, and the verdicts —
// met (calibrated, large n), not_met (a resolvable miss; an inconsistent decile), unresolved (a
// literal miss the sample cannot resolve), insufficient_n — plus hostile input and properties.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CALIBRATION,
  nToResolve,
  normalQuantile,
  reliabilityByDecile,
  wilsonInterval,
} from "../../../../src/domain/analytics/calibration/index.js";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";
import { brierScore } from "../../../../src/domain/reclog/metrics.js";

/** n forecasts at p, of which exactly round(rate × n) happen. */
function block(p: number, n: number, rate: number): { p: number; outcome: boolean }[] {
  const k = Math.round(rate * n);
  return Array.from({ length: n }, (_, i) => ({ p, outcome: i < k }));
}

describe("wilsonInterval / normalQuantile / nToResolve", () => {
  it("matches known values", () => {
    const [lo0, hi0] = wilsonInterval(0, 10);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.2775, 3);
    const [lo, hi] = wilsonInterval(5, 10);
    expect(lo).toBeCloseTo(0.2366, 3);
    expect(hi).toBeCloseTo(0.7634, 3);
    expect(wilsonInterval(10, 10)[1]).toBe(1);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(nToResolve(0.5, 0.05)).toBe(385);
    expect(nToResolve(0, 0.05)).toBe(1);
  });

  it("refuses malformed arguments", () => {
    expect(() => wilsonInterval(1, 0)).toThrow(AnalyticsError);
    expect(() => wilsonInterval(-1, 5)).toThrow(AnalyticsError);
    expect(() => wilsonInterval(6, 5)).toThrow(AnalyticsError);
    expect(() => wilsonInterval(1.5, 5)).toThrow(AnalyticsError);
    expect(() => wilsonInterval(1, 5, 0)).toThrow(AnalyticsError);
    expect(() => wilsonInterval(1, 5, Number.NaN)).toThrow(AnalyticsError);
    for (const p of [0, 1, -0.1, 1.1, Number.NaN])
      expect(() => normalQuantile(p)).toThrow(AnalyticsError);
    expect(() => nToResolve(1.2, 0.05)).toThrow(AnalyticsError);
    expect(() => nToResolve(0.5, 0)).toThrow(AnalyticsError);
    expect(() => nToResolve(0.5, 1)).toThrow(AnalyticsError);
  });

  it("(property) the interval holds k/n inside [0, 1] and the quantile is antisymmetric", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (n, f) => {
          const k = Math.min(n, Math.floor(f * n));
          const [lo, hi] = wilsonInterval(k, n);
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(hi).toBeLessThanOrEqual(1);
          expect(lo).toBeLessThanOrEqual(k / n + 1e-12);
          expect(hi).toBeGreaterThanOrEqual(k / n - 1e-12);
        },
      ),
    );
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 0.999, noNaN: true }), (p) => {
        expect(normalQuantile(p)).toBeCloseTo(-normalQuantile(1 - p), 6);
      }),
    );
  });
});

describe("reliabilityByDecile", () => {
  it("met: a calibrated forecaster with large deciles", () => {
    const pairs = [
      ...block(0.15, 400, 0.15),
      ...block(0.35, 400, 0.35),
      ...block(0.55, 400, 0.55),
      ...block(0.85, 400, 0.85),
    ];
    const r = reliabilityByDecile(pairs);
    expect(r.status).toBe("met");
    expect(r.bins_checked).toBe(4);
    expect(r.bins_outside).toEqual([]);
    expect(r.consistent).toBe(true);
    expect(r.max_checked_gap).toBeCloseTo(0, 9);
    expect(r.brier.value).toBeCloseTo(brierScore(pairs), 12);
    expect(r.brier_coin_flip).toBe(0.25);
    expect(r.tolerance).toBe(CALIBRATION.tolerance);
    expect(r.min_bin_n).toBe(CALIBRATION.minBinN);
  });

  it("not_met: a resolvable miss (n beyond what ±5 needs)", () => {
    const r = reliabilityByDecile(block(0.45, 1000, 0.6));
    expect(r.status).toBe("not_met");
    expect(r.bins_outside).toEqual([4]);
    expect(r.bins[4]?.gap).toBeCloseTo(0.15, 9);
  });

  it("not_met: a small decile inconsistent with its forecasts at the family-wise level", () => {
    const r = reliabilityByDecile([...block(0.02, 20, 1), ...block(0.55, 100, 0.55)]);
    expect(r.consistent).toBe(false);
    expect(r.bins[0]?.verdict).toBe("insufficient_n");
    expect(r.bins[0]?.consistent).toBe(false);
    expect(r.status).toBe("not_met");
  });

  it("unresolved: a literal miss in a decile too small to resolve ±5, every decile consistent", () => {
    const r = reliabilityByDecile([...block(0.36, 50, 0.3), ...block(0.55, 60, 0.55)]);
    expect(r.bins_outside).toEqual([3]);
    expect(r.bins[3]?.n_to_resolve).toBeGreaterThan(50);
    expect(r.consistent).toBe(true);
    expect(r.status).toBe("unresolved");
  });

  it("insufficient_n: no decile reaches min_bin_n", () => {
    const r = reliabilityByDecile(block(0.5, 20, 0.5));
    expect(r.status).toBe("insufficient_n");
    expect(r.bins_checked).toBe(0);
    expect(r.max_checked_gap).toBeNull();
  });

  it("honours the options and the decile edges (0 in the first bin, 1 in the last)", () => {
    const r = reliabilityByDecile(
      [
        { p: 0, outcome: false },
        { p: 1, outcome: true },
      ],
      { min_bin_n: 1, tolerance: 0.1, bins: 10 },
    );
    expect(r.bins[0]?.n).toBe(1);
    expect(r.bins[9]?.n).toBe(1);
    expect(r.status).toBe("met");
    expect(r.bins[5]).toMatchObject({
      n: 0,
      mean_p: null,
      verdict: "insufficient_n",
      consistent: null,
    });
    const two = reliabilityByDecile(block(0.3, 40, 0.3), { bins: 2, min_bin_n: 10 });
    expect(two.bins).toHaveLength(2);
    expect(two.bins[0]?.hi).toBe(0.5);
  });

  it("refuses hostile input with a typed error", () => {
    const bad: unknown[] = [
      [],
      [{ p: Number.NaN, outcome: true }],
      [{ p: 1.2, outcome: true }],
      [{ p: -0.1, outcome: false }],
      [{ p: 0.5, outcome: "yes" }],
      [{ p: "0.5", outcome: true }],
      [null],
      "not an array",
    ];
    for (const b of bad)
      expect(() => reliabilityByDecile(b as { p: number; outcome: boolean }[])).toThrow(
        AnalyticsError,
      );
    const ok = block(0.5, 40, 0.5);
    expect(() => reliabilityByDecile(ok, { tolerance: 0 })).toThrow(AnalyticsError);
    expect(() => reliabilityByDecile(ok, { tolerance: 1 })).toThrow(AnalyticsError);
    expect(() => reliabilityByDecile(ok, { min_bin_n: 0 })).toThrow(AnalyticsError);
    expect(() => reliabilityByDecile(ok, { min_bin_n: 1.5 })).toThrow(AnalyticsError);
    expect(() => reliabilityByDecile(ok, { bins: 0 })).toThrow(AnalyticsError);
    expect(() => reliabilityByDecile(ok, { bins: 101 })).toThrow(AnalyticsError);
  });

  it("(property) bins partition the forecasts; gap = rate − mean; the status is one of four", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ p: fc.double({ min: 0, max: 1, noNaN: true }), outcome: fc.boolean() }),
          { minLength: 1, maxLength: 300 },
        ),
        (pairs) => {
          const r = reliabilityByDecile(pairs);
          expect(r.bins.reduce((s, b) => s + b.n, 0)).toBe(pairs.length);
          for (const b of r.bins) {
            if (b.n === 0) continue;
            expect(b.mean_p ?? -1).toBeGreaterThanOrEqual(b.lo - 1e-12);
            expect(b.mean_p ?? 2).toBeLessThanOrEqual(b.hi + 1e-12);
            expect(b.gap ?? 0).toBeCloseTo((b.rate ?? 0) - (b.mean_p ?? 0), 12);
          }
          expect(["met", "not_met", "unresolved", "insufficient_n"]).toContain(r.status);
          expect(r.brier.value).toBeCloseTo(brierScore(pairs), 12);
        },
      ),
    );
  });
});
