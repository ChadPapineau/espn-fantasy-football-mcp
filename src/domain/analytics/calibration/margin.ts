// margin.ts — the calibration of a head-to-head forecast's MARGIN (changelog R6-2, Stage C; plan 10
// C2; sib research 05 §11 "the model's own error", §12.1): P(win) = Φ(μ / σ) is calibrated exactly
// when the realised margin M − O is centred on the forecast margin μ_m − μ_o with spread σ, so the
// two mechanisms that would mis-calibrate it can be tested on the margins themselves — far more
// information than the binary results a decile table reads (136 matchups put ~12 in a tail decile,
// but every one of them carries a margin):
//   - scale: the OLS slope of the realised margin on the forecast margin. Below 1 the realised
//     margins regress toward 0 — what the optimiser's selection bias (the winner's curse on a
//     best-by-mean lineup) or over-dispersed means would do to the side with the larger projection;
//     above 1 the forecast margins are too timid. Its 95 % interval (Student t, n − 2 df).
//   - spread: the mean squared standardised residual ((realised − μ)/σ)², 1 when σ is right; the
//     range a right σ produces at this n is χ²_n / n (Wilson–Hilferty quantiles).
// Each event once: a family that scores a matchup from both sides passes one side per matchup.
// Pure. New here.
import { ensure } from "../errors.js";
import { CALIBRATION, normalQuantile } from "./reliability.js";

/** One forecast margin and what happened. */
export interface MarginForecast {
  /** The forecast margin μ_m − μ_o. */
  readonly mean: number;
  /** sd of M − O under the forecast (> 0). */
  readonly sd: number;
  /** The realised margin. */
  readonly realised: number;
}

/** The margin calibration of one forecast family. */
export interface MarginCalibration {
  readonly n: number;
  /** OLS slope of the realised margin on the forecast margin (1 = right scale). */
  readonly slope: number;
  readonly slope_se: number;
  /** The slope's two-sided 1 − alpha interval (Student t, n − 2 df). */
  readonly slope_ci: readonly [number, number];
  readonly intercept: number;
  /** Mean realised − forecast margin. */
  readonly mean_residual: number;
  /** Mean of ((realised − mean) / sd)² — 1 when the spread is right. */
  readonly z2: number;
  /** The two-sided 1 − alpha range of z2 when the spread is right and the residuals normal: χ²_n / n. */
  readonly z2_range: readonly [number, number];
  /** 1 lies inside `slope_ci`. */
  readonly slope_consistent: boolean;
  /** `z2` lies inside `z2_range`. */
  readonly spread_consistent: boolean;
}

/** Bounds a margin calibration accepts. */
export const MARGIN = Object.freeze({
  /** Fewest margins (the slope's residual variance needs n − 2 ≥ 1). */
  minN: 3,
  /** Largest |margin| or sd accepted (fantasy points). */
  maxAbs: 1e6,
});

/**
 * Student t quantile t_ν(p) by the Cornish–Fisher expansion in 1/ν around the normal quantile
 * (Abramowitz & Stegun 26.7.5, three terms): |error| < 0.005 for ν ≥ 5 at p ≤ 0.975 and < 0.001
 * for ν ≥ 30 at p ≤ 0.995 (the use here: p = 0.975 at ν = n − 2, n ≈ 136).
 */
export function tQuantile(p: number, df: number): number {
  ensure(Number.isFinite(df) && df >= 1, "t quantile needs df ≥ 1", "df");
  const z = normalQuantile(p);
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
  );
}

/** χ²_ν quantile by Wilson–Hilferty: ν (1 − 2/(9ν) + z √(2/(9ν)))³ (< 1 % off for ν ≥ 10). */
export function chiSquareQuantile(p: number, df: number): number {
  ensure(Number.isFinite(df) && df >= 1, "chi-square quantile needs df ≥ 1", "df");
  const z = normalQuantile(p);
  const a = 2 / (9 * df);
  return df * Math.max(0, 1 - a + z * Math.sqrt(a)) ** 3;
}

const finiteWithin = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= MARGIN.maxAbs;

/**
 * Margin calibration of one forecast family (changelog R6-2). Throws AnalyticsError
 * `invalid_request` on fewer than MARGIN.minN or more than CALIBRATION.maxForecasts margins, a
 * non-finite or oversized value, a spread ≤ 0, or forecast margins that are all equal.
 */
export function marginCalibration(xs: readonly MarginForecast[]): MarginCalibration {
  const list: unknown = xs;
  ensure(
    Array.isArray(list) && list.length >= MARGIN.minN && list.length <= CALIBRATION.maxForecasts,
    "margin count out of range",
    "margins",
  );
  for (const x of list as unknown[]) {
    const r = x as Partial<MarginForecast> | null;
    ensure(
      typeof r === "object" &&
        r !== null &&
        finiteWithin(r.mean) &&
        finiteWithin(r.realised) &&
        finiteWithin(r.sd) &&
        r.sd > 0,
      "a margin needs a finite mean and realised value and a positive sd",
      "margins",
    );
  }
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x.mean, 0) / n;
  const my = xs.reduce((s, x) => s + x.realised, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const x of xs) {
    sxx += (x.mean - mx) ** 2;
    sxy += (x.mean - mx) * (x.realised - my);
  }
  ensure(sxx > 1e-9 * n, "the forecast margins must not all be equal", "margins");
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const rss = xs.reduce((s, x) => s + (x.realised - intercept - slope * x.mean) ** 2, 0);
  const se = Math.sqrt(rss / (n - 2) / sxx);
  const t = tQuantile(1 - CALIBRATION.alpha / 2, n - 2);
  const z2 = xs.reduce((s, x) => s + ((x.realised - x.mean) / x.sd) ** 2, 0) / n;
  const z2Range: [number, number] = [
    chiSquareQuantile(CALIBRATION.alpha / 2, n) / n,
    chiSquareQuantile(1 - CALIBRATION.alpha / 2, n) / n,
  ];
  const slopeCi: [number, number] = [slope - t * se, slope + t * se];
  return {
    n,
    slope,
    slope_se: se,
    slope_ci: slopeCi,
    intercept,
    mean_residual: my - mx,
    z2,
    z2_range: z2Range,
    slope_consistent: slopeCi[0] <= 1 && 1 <= slopeCi[1],
    spread_consistent: z2Range[0] <= z2 && z2 <= z2Range[1],
  };
}
