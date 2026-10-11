// reliability.test.ts — P(win) calibration per decile (plan 10 C2; sib research 05 §12 "Evaluation
// of the evaluator": a calibrated synthetic forecaster passes, a miscalibrated one fails): the
// Wilson interval, the normal quantile, the forecasts needed to resolve ±5, and the verdicts —
// met (calibrated, large n), not_met (a resolvable miss; an inconsistent decile), unresolved (a
// literal miss the sample cannot resolve), insufficient_n — plus hostile input and properties; and
// the reliability term a perfectly calibrated forecaster would expect (exact on hand-computed cases,
// matched by a seeded Monte-Carlo of calibrated outcomes, bounded by a property); and (Stage C,
// changelog R6-2) that term's whole sampling distribution under calibration — the observed term
// exactly the decomposition's, its mean the floor, a mirrored family's spread wider than an
// independent one's, p-values uniform under calibration and tiny under gross miscalibration.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "../../../../src/domain/clock.js";
import {
  CALIBRATION,
  nToResolve,
  normalQuantile,
  reliabilityByDecile,
  reliabilityNull,
  wilsonInterval,
} from "../../../../src/domain/analytics/calibration/index.js";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";
import { brierScore, brierWithDecomposition } from "../../../../src/domain/reclog/metrics.js";

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

describe("reliability_if_calibrated — the noise floor of the reliability term", () => {
  it("is (1/N) Σ_k (1/n_k) Σ p(1 − p) on hand-computed cases", () => {
    // two deciles: 10 forecasts at 0.3, 20 at 0.6 → (0.21 + 0.24) / 30
    const two = reliabilityByDecile([...block(0.3, 10, 0.3), ...block(0.6, 20, 0.6)]);
    expect(two.reliability_if_calibrated).toBeCloseTo((0.3 * 0.7 + 0.6 * 0.4) / 30, 12);
    // forecasts that differ inside one decile: the bin's mean of p(1 − p), weighed once
    const mixed = reliabilityByDecile([
      { p: 0.31, outcome: true },
      { p: 0.39, outcome: false },
    ]);
    expect(mixed.reliability_if_calibrated).toBeCloseTo((0.31 * 0.69 + 0.39 * 0.61) / 2 / 2, 12);
    // certain forecasts carry no sampling noise
    const sure = reliabilityByDecile([...block(0, 5, 0), ...block(1, 5, 1)]);
    expect(sure.reliability_if_calibrated).toBe(0);
    // it reads the forecasts only: the outcomes do not move it, the observed term does
    const flipped = reliabilityByDecile([...block(0.3, 10, 1), ...block(0.6, 20, 0)]);
    expect(flipped.reliability_if_calibrated).toBe(two.reliability_if_calibrated);
    expect(flipped.brier.decomposition.reliability).toBeGreaterThan(
      two.brier.decomposition.reliability,
    );
  });

  it("matches the mean reliability term of calibrated outcomes (seeded Monte-Carlo)", () => {
    // 272 forecasts spread like a season replay's (clustered near ½), outcomes ~ Bernoulli(p)
    const rng = seededRng(20261011);
    const ps = Array.from({ length: 272 }, () => 0.5 + (rng.next() + rng.next() - 1) * 0.45);
    const expected = reliabilityByDecile(
      ps.map((p) => ({ p, outcome: false })),
    ).reliability_if_calibrated;
    const reps = 4000;
    let sum = 0;
    for (let r = 0; r < reps; r++) {
      const pairs = ps.map((p) => ({ p, outcome: rng.next() < p }));
      sum += brierWithDecomposition(pairs).decomposition.reliability;
    }
    // the replicate mean's standard error is ≈ 1–2 % of the value at 4 000 replicates
    expect(sum / reps).toBeGreaterThan(expected * 0.95);
    expect(sum / reps).toBeLessThan(expected * 1.05);
  });

  it("(property) 0 ≤ floor ≤ ¼ × filled deciles / N; independent of the outcomes", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ p: fc.double({ min: 0, max: 1, noNaN: true }), outcome: fc.boolean() }),
          { minLength: 1, maxLength: 300 },
        ),
        (pairs) => {
          const r = reliabilityByDecile(pairs);
          const filled = r.bins.filter((b) => b.n > 0).length;
          expect(r.reliability_if_calibrated).toBeGreaterThanOrEqual(0);
          expect(r.reliability_if_calibrated).toBeLessThanOrEqual((0.25 * filled) / r.n + 1e-12);
          const inverted = reliabilityByDecile(
            pairs.map(({ p, outcome }) => ({ p, outcome: !outcome })),
          );
          expect(inverted.reliability_if_calibrated).toBe(r.reliability_if_calibrated);
        },
      ),
    );
  });
});

describe("reliabilityNull — the calibrated forecaster's sampling distribution of the term (R6-2)", () => {
  /** 136 forecasts clustered near ½ like a season replay's (one side per matchup). */
  const spread = (seed: number, n = 136): number[] => {
    const rng = seededRng(seed);
    return Array.from({ length: n }, () => 0.5 + (rng.next() + rng.next() - 1) * 0.45);
  };
  const calibratedEvents = (ps: readonly number[], seed: number) => {
    const rng = seededRng(seed);
    return ps.map((p) => ({ p, outcome: rng.next() < p }));
  };
  const mirror = (xs: readonly { p: number; outcome: boolean }[]) =>
    xs.flatMap((e) => [e, { p: 1 - e.p, outcome: !e.outcome }]);

  it("scores exactly the decomposition's reliability term, mirrored or not (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ p: fc.double({ min: 0, max: 1, noNaN: true }), outcome: fc.boolean() }),
          { minLength: 1, maxLength: 120 },
        ),
        fc.boolean(),
        (events, mirrored) => {
          const r = reliabilityNull(events, { rng: seededRng(7), mirrored, sims: 100 });
          const scored = mirrored ? mirror(events) : events;
          expect(r.observed).toBeCloseTo(
            brierWithDecomposition(scored).decomposition.reliability,
            12,
          );
          expect(r.forecasts).toBe(scored.length);
          expect(r.events).toBe(events.length);
          expect(r.mirrored).toBe(mirrored);
          expect(r.p_value).toBeGreaterThan(0);
          expect(r.p_value).toBeLessThanOrEqual(1);
          expect(r.q95).toBeLessThanOrEqual(r.q99);
          expect(r.mean).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("its mean is the floor (reliability_if_calibrated of the same forecasts), mirrored or not", () => {
    const events = calibratedEvents(spread(11), 12);
    for (const mirrored of [false, true]) {
      const r = reliabilityNull(events, { rng: seededRng(13), mirrored, sims: 20_000 });
      const floor = reliabilityByDecile(
        mirrored ? mirror(events) : events,
      ).reliability_if_calibrated;
      expect(Math.abs(r.mean - floor) / floor).toBeLessThan(0.03);
      expect(r.q95).toBeGreaterThan(r.mean);
    }
  });

  it("a mirrored family's term spreads wider than the same forecasts drawn independently", () => {
    const events = calibratedEvents(spread(21), 22);
    const mirrored = reliabilityNull(events, { rng: seededRng(23), mirrored: true, sims: 20_000 });
    // the same 272 forecasts as 272 independent events
    const independent = reliabilityNull(mirror(events), { rng: seededRng(23), sims: 20_000 });
    expect(mirrored.forecasts).toBe(independent.forecasts);
    expect(Math.abs(mirrored.mean - independent.mean) / independent.mean).toBeLessThan(0.05);
    expect(mirrored.q95 - mirrored.mean).toBeGreaterThan(
      1.2 * (independent.q95 - independent.mean),
    );
  });

  it("p-values: 1 for a term of 0, 1/(sims + 1) for gross miscalibration, uniform under calibration", () => {
    // every bin's realised rate equals its forecast → observed 0 → every draw is ≥ it
    const exact = [...block(0.3, 10, 0.3), ...block(0.6, 20, 0.6)];
    const zero = reliabilityNull(exact, { rng: seededRng(1), sims: 500 });
    expect(zero.observed).toBeCloseTo(0, 12);
    expect(zero.p_value).toBe(1);
    // forecasts of 0.9 that never happen, 0.1 that always do
    const wrong = [...block(0.9, 100, 0), ...block(0.1, 100, 1)];
    const r = reliabilityNull(wrong, { rng: seededRng(2), sims: 1000 });
    expect(r.p_value).toBe(1 / 1001);
    expect(r.observed).toBeGreaterThan(r.q99);
    // calibrated datasets: about 5 % of p-values fall below 0.05 (400 datasets, 200 draws each)
    const ps = spread(31);
    let below = 0;
    const reps = 400;
    for (let i = 0; i < reps; i++) {
      const events = calibratedEvents(ps, 1000 + i);
      if (
        reliabilityNull(events, { rng: seededRng(5000 + i), mirrored: true, sims: 200 }).p_value <
        0.05
      )
        below += 1;
    }
    // binomial sd at 400 × 0.05 is ≈ 4.4 datasets
    expect(below / reps).toBeGreaterThan(0.015);
    expect(below / reps).toBeLessThan(0.095);
  });

  it("is deterministic for a seed and close across seeds", () => {
    const events = calibratedEvents(spread(41), 42);
    const a = reliabilityNull(events, { rng: seededRng(43), mirrored: true });
    const b = reliabilityNull(events, { rng: seededRng(43), mirrored: true });
    expect(a).toEqual(b);
    const c = reliabilityNull(events, { rng: seededRng(44), mirrored: true });
    expect(Math.abs(a.p_value - c.p_value)).toBeLessThan(0.03);
    expect(a.sims).toBe(CALIBRATION.nullSims);
  });

  it("refuses hostile input with a typed error", () => {
    const rng = seededRng(1);
    const bad: unknown[] = [
      [],
      [{ p: Number.NaN, outcome: true }],
      [{ p: 1.2, outcome: true }],
      [{ p: 0.5, outcome: "yes" }],
      [null],
      "not an array",
    ];
    for (const b of bad)
      expect(() => reliabilityNull(b as { p: number; outcome: boolean }[], { rng })).toThrow(
        AnalyticsError,
      );
    const ok = block(0.5, 10, 0.5);
    for (const sims of [0, 99, 1.5, 200_001, Number.NaN])
      expect(() => reliabilityNull(ok, { rng, sims })).toThrow(AnalyticsError);
    expect(() => reliabilityNull(ok, { rng, bins: 0 })).toThrow(AnalyticsError);
    expect(() => reliabilityNull(ok, { rng, bins: 101 })).toThrow(AnalyticsError);
    expect(() =>
      reliabilityNull(ok, { rng: undefined as unknown as ReturnType<typeof seededRng> }),
    ).toThrow(AnalyticsError);
    const huge = Array.from({ length: CALIBRATION.maxForecasts / 2 + 1 }, () => ({
      p: 0.5,
      outcome: true,
    }));
    expect(() => reliabilityNull(huge, { rng, mirrored: true, sims: 100 })).toThrow(AnalyticsError);
  });
});
