// metrics.ts — the scoring rules of the projection backtest (sibling research 05 §1-Evaluation:
// CRPS for the full distribution — strictly proper, the integral of the Brier score over thresholds
// [Gneiting & Raftery 2007]; pinball loss at p10/p50/p90; p10–p90 interval coverage; Spearman rank
// correlation within position per week, what start/sit consumes; MAE of the mean, the least
// important). CRPS of a sample uses the unbiased ("fair") pairwise term; the gamma baselines (a mean
// with the positional CV — the `position_cv` distribution) use the closed form, optionally mixed with
// a point mass at zero (P(active)). Pure. New here.
import { gammaCdf, lnGamma, spearman } from "../math.js";

/**
 * CRPS of an ASCENDING sample at outcome y: mean|X − y| − Σ_{i<j}(x_j − x_i) / (n(n − 1)) (the fair
 * estimator; a single sample is a point mass: |x − y|). Empty → NaN.
 */
export function crpsSorted(sorted: ArrayLike<number>, y: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  let abs = 0;
  let pair = 0;
  for (let k = 0; k < n; k++) {
    const x = sorted[k] ?? 0;
    abs += Math.abs(x - y);
    pair += (2 * k - n + 1) * x;
  }
  if (n === 1) return abs;
  return abs / n - pair / (n * (n - 1));
}

/** Sorts a copy and returns its CRPS at y. */
export function crpsSample(sample: ArrayLike<number>, y: number): number {
  return crpsSorted(Float64Array.from(sample).sort(), y);
}

/**
 * CRPS of the mixture (1 − p)·δ0 + p·Gamma(mean, cv) at y ≥ 0 — closed form (the gamma CRPS of
 * Scheuerer & Möller / scoringRules, combined through CRPS = E|X − y| − ½E|X − X′|). mean ≤ 0 or
 * cv ≤ 0 reads as a point mass at max(mean, 0) for the active part.
 */
export function crpsGamma(mean: number, cv: number, y: number, pActive = 1): number {
  const p = Math.min(1, Math.max(0, pActive));
  let eAbsY: number; // E_G|X − y|
  let eAbsXX: number; // E_G|X − X'|
  let eAbsX: number; // E_G|X|
  if (!(mean > 0) || !(cv > 0)) {
    const m = Math.max(0, mean);
    eAbsY = Math.abs(m - y);
    eAbsXX = 0;
    eAbsX = m;
  } else {
    const a = 1 / (cv * cv);
    const b = a / mean; // rate
    eAbsY =
      y > 0
        ? y * (2 * gammaCdf(a, b * y) - 1) - (a / b) * (2 * gammaCdf(a + 1, b * y) - 1)
        : mean - y;
    // E|X − X'| = 2 / (b · B(½, a)),  B(½, a) = Γ(½)Γ(a)/Γ(a + ½)
    const lnB = lnGamma(0.5) + lnGamma(a) - lnGamma(a + 0.5);
    eAbsXX = 2 / (b * Math.exp(lnB));
    eAbsX = mean;
  }
  const e1 = (1 - p) * Math.abs(y) + p * eAbsY;
  const e2 = 2 * p * (1 - p) * eAbsX + p * p * eAbsXX;
  return e1 - 0.5 * e2;
}

/** The pinball (quantile) loss of quantile value qv at level τ for outcome y. */
export function pinball(tau: number, qv: number, y: number): number {
  const d = y - qv;
  return d >= 0 ? tau * d : (tau - 1) * d;
}

/** Whether y is inside [lo, hi] (inclusive: a zero outcome under a p10 of 0 is covered). */
export function covered(lo: number, hi: number, y: number): boolean {
  return y >= lo - 1e-9 && y <= hi + 1e-9;
}

/** One forecast for the grouped rank correlation. */
export interface RankedForecast {
  readonly group: string;
  readonly forecast: number;
  readonly outcome: number;
}

/**
 * The mean of per-group Spearman correlations (groups with < 3 forecasts or a constant series are
 * skipped) and how many groups counted.
 */
export function spearmanWithin(rows: readonly RankedForecast[]): {
  readonly mean: number | null;
  readonly groups: number;
} {
  const by = new Map<string, { f: number[]; o: number[] }>();
  for (const r of rows) {
    const g = by.get(r.group) ?? { f: [], o: [] };
    g.f.push(r.forecast);
    g.o.push(r.outcome);
    by.set(r.group, g);
  }
  let sum = 0;
  let n = 0;
  for (const g of [...by.keys()].sort()) {
    const v = by.get(g);
    if (v === undefined || v.f.length < 3) continue;
    const s = spearman(v.f, v.o);
    if (s === null) continue;
    sum += s;
    n += 1;
  }
  return { mean: n === 0 ? null : sum / n, groups: n };
}

/** The mean of a list (null when empty). */
export function meanOrNull(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
