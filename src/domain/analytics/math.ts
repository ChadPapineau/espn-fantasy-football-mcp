// math.ts — the numeric kernels the P0 analytics share (sibling research 05 §1 step 9 gamma/Poisson
// draws, §11.1 normal approximation Φ; research 05 §2.4 normal team scores): every draw comes from
// the injected seeded Rng (src/domain/clock.ts), never Math.random. Pure.
// Ported from sibling @f6ba81e (src/domain/analytics/math.ts), adapted (Float64Array quantiles,
// `normalPdf`, `meanOf`; the deterministic gamma quadrature is not needed by v1-ensemble).
import type { Rng } from "../clock.js";
import { at } from "../scoring/numeric.js";
import type { Dist, DistBasis } from "../scoring/types.js";
import { Z75, Z90 } from "./constants.js";

/** Clamps x into [lo, hi] (NaN → lo). */
export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/** Rounds to `digits` decimals, normalising −0 to 0 (output hygiene); non-finite → 0. */
export function round(x: number, digits = 4): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * The standard normal CDF Φ(x) (Cody-style rational erfc approximation, |error| < 1.2e-7). Φ(±∞) =
 * 1/0; NaN → 0.5 (a non-number never reads as certainty).
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return 0.5;
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  // erfc(0) reads ≈ 1 + 3e-8: cap at ½ so Φ is continuous and monotone at 0
  const p = Math.min(0.5, 0.5 * erfc);
  return x >= 0 ? 1 - p : p;
}

/** The standard normal density φ(x). */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** One standard normal draw (Box–Muller; `u1` kept away from 0). */
export function normalDraw(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-300);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A Gamma(shape, 1) draw (Marsaglia & Tsang 2000; shape < 1 boosted by U^(1/shape)). Throws
 * RangeError for a non-positive or non-finite shape.
 */
export function gammaDraw(rng: Rng, shape: number): number {
  if (!Number.isFinite(shape) || shape <= 0) throw new RangeError("math: gamma shape must be > 0");
  if (shape < 1) {
    const u = Math.max(rng.next(), 1e-300);
    return gammaDraw(rng, shape + 1) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalDraw(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * A mean-1 gamma multiplier with coefficient of variation `cv` (shape 1/cv², scale cv²) — the
 * `position_cv` width (sibling research 05 §1 step 9's parametric fallback). cv ≤ 0 → exactly 1.
 */
export function gammaMultiplier(rng: Rng, cv: number): number {
  if (!(cv > 0)) return 1;
  const shape = 1 / (cv * cv);
  return gammaDraw(rng, shape) / shape;
}

/** A Poisson(λ) draw: Knuth for λ ≤ 30, else a rounded normal approximation floored at 0. */
export function poissonDraw(rng: Rng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normalDraw(rng)));
  const l = Math.exp(-lambda);
  let k = 0;
  let p = rng.next();
  while (p > l) {
    k += 1;
    p *= rng.next();
  }
  return k;
}

/** Hyndman–Fan type-7 quantile of an ASCENDING array (the engine's definition); empty → 0. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const h = (n - 1) * clamp(q, 0, 1);
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (h - lo) * (b - a);
}

/** The arithmetic mean (0 for an empty array). */
export function meanOf(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += xs[i] ?? 0;
  return s / n;
}

/**
 * A Dist over raw sample points (the same quantile rule as scoreSamples). `mean` overrides the
 * sample mean (E1 reports ESPN's mean exactly — weight_espn = 1.0 — not its Monte-Carlo estimate).
 */
export function distFromSamples(points: ArrayLike<number>, basis: DistBasis, mean?: number): Dist {
  const sorted = Float64Array.from(points).sort();
  const n = sorted.length;
  let zeros = 0;
  for (let i = 0; i < n; i++) if (sorted[i] === 0) zeros += 1;
  return {
    mean: round(mean ?? meanOf(sorted)),
    p10: round(quantileSorted(sorted, 0.1)),
    p25: round(quantileSorted(sorted, 0.25)),
    p50: round(quantileSorted(sorted, 0.5)),
    p75: round(quantileSorted(sorted, 0.75)),
    p90: round(quantileSorted(sorted, 0.9)),
    p_zero: n === 0 ? 1 : round(zeros / n),
    basis,
  };
}

/** A point mass at zero (bye, ruled out): mean 0, every quantile 0, p_zero 1. */
export function zeroDist(basis: DistBasis): Dist {
  return { mean: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p_zero: 1, basis };
}

/** A Dist of a normal N(μ, σ²) (team totals; sibling research 05 §11.1). p_zero 0 unless σ = μ = 0. */
export function normalDist(mu: number, sigma: number, basis: DistBasis): Dist {
  const s = Math.max(0, Number.isFinite(sigma) ? sigma : 0);
  const q = (z: number): number => round(mu + z * s);
  return {
    mean: round(mu),
    p10: q(-Z90),
    p25: q(-Z75),
    p50: round(mu),
    p75: q(Z75),
    p90: q(Z90),
    p_zero: mu === 0 && s === 0 ? 1 : 0,
    basis,
  };
}

/**
 * σ of a Dist from its 10–90 spread (normal approximation: (p90 − p10) / 2·z90). A Dist carries no
 * variance field (plan 07 legend), so every consumer uses this one estimator. Never negative.
 */
export function sigmaOf(d: Dist): number {
  const s = (d.p90 - d.p10) / (2 * Z90);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** Average ranks (1-based; ties share their mean rank). */
export function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const out = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && at(idx, j + 1).x === at(idx, i).x) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[at(idx, k).i] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation of two equal-length series; null when n < 2 or a series is constant. */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const n = ra.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = at(ra, i) - ma;
    const y = at(rb, i) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// --- the gamma CDF (deterministic K/D-ST bracket probabilities) — ported from sibling @f6ba81e ---------

const LANCZOS: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7; relative error ≲ 1e-13). */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const y = x - 1;
  let a = at(LANCZOS, 0);
  for (let i = 1; i < LANCZOS.length; i++) a += at(LANCZOS, i) / (y + i);
  const t = y + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * The regularized lower incomplete gamma P(a, x) = the Gamma(a, 1) CDF at x (series below a + 1,
 * the Lentz continued fraction above — Numerical Recipes §6.2). Throws RangeError for a ≤ 0.
 */
export function gammaCdf(a: number, x: number): number {
  if (!Number.isFinite(a) || a <= 0) throw new RangeError("math: gamma shape must be > 0");
  if (!(x > 0)) return 0;
  if (x === Infinity) return 1;
  const lead = Math.exp(-x + a * Math.log(x) - lnGamma(a));
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; n < 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    return clamp(sum * lead, 0, 1);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return clamp(1 - lead * h, 0, 1);
}

/** The CDF at x of a gamma with mean `mean` and coefficient of variation `cv` (both > 0). */
export function gammaCdfMeanCv(x: number, mean: number, cv: number): number {
  const shape = 1 / (cv * cv);
  return gammaCdf(shape, (x * shape) / mean);
}

/** The Gamma(shape, 1) quantile at p ∈ (0, 1), by bisection on the (monotone) CDF. */
export function gammaQuantile(p: number, shape: number): number {
  if (!(p > 0)) return 0;
  if (p >= 1) return Infinity;
  let lo = 0;
  let hi = Math.max(1, shape);
  while (gammaCdf(shape, hi) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (gammaCdf(shape, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The Dist of a gamma with mean `mean` and coefficient of variation `cv` (deterministic quantiles):
 * a point estimate widened by the `position_cv` rule without sampling. mean ≤ 0 → a point mass.
 */
export function gammaDist(mean: number, cv: number, basis: DistBasis): Dist {
  if (!(mean > 0) || !(cv > 0))
    return {
      mean: round(mean),
      p10: round(mean),
      p25: round(mean),
      p50: round(mean),
      p75: round(mean),
      p90: round(mean),
      p_zero: mean === 0 ? 1 : 0,
      basis,
    };
  const shape = 1 / (cv * cv);
  const q = (x: number): number => round((mean * gammaQuantile(x, shape)) / shape);
  return {
    mean: round(mean),
    p10: q(0.1),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p_zero: 0,
    basis,
  };
}
