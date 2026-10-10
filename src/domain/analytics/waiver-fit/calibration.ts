// calibration.ts — P(clears_to_FA) calibration and the league-fitted demand scale (plan 10 C5:
// "P(clears_to_FA) calibrated within ±10 points where the league's history allows (soft where
// n < 30)"; research 05 §1.6 eval 2 and "working", §8.4 calibration checks: reliability by decile).
// E5's clears probability is (1 − q(r))^m — m rivals able to claim, q the demand curve
// (waiverDp.ts `demandOf`, waivers.ts); the calibration compares those predictions with realised
// outcomes (did the player clear unclaimed), and the scale fit finds the multiplier λ on q that
// maximises the outcomes' likelihood (golden-section search on log λ — deterministic). Pure. New here.
import { round } from "../math.js";
import { demandOf } from "../waiverDp.js";
import { WAIVER_FIT } from "./constants.js";

/** One prediction and what happened. */
export interface ClearsObservation {
  /** The predicted P(clears_to_FA). */
  readonly p: number;
  readonly cleared: boolean;
}

/** One reliability bin (predicted probability in [lo, hi)). */
export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly mean_p: number | null;
  readonly observed: number | null;
  /** observed − mean_p (probability points as a fraction; null when empty). */
  readonly deviation: number | null;
  /** n ≥ WAIVER_FIT.minBinN: the bin counts toward the ±10-point verdict. */
  readonly judged: boolean;
}

/** A calibration. */
export interface ClearsCalibration {
  readonly n: number;
  readonly rejected: number;
  readonly brier: number | null;
  readonly mean_p: number | null;
  readonly base_rate: number | null;
  /** base_rate − mean_p: calibration in the large. */
  readonly in_the_large: number | null;
  readonly bins: readonly ReliabilityBin[];
  /** The largest |deviation| over judged bins (null when no bin is judged). */
  readonly max_abs_deviation: number | null;
  /** Every judged bin within ±tolerance (null when no bin is judged). */
  readonly within_tolerance: boolean | null;
  /** n < WAIVER_FIT.softBelow: a soft number (plan 10 C5). */
  readonly soft: boolean;
  readonly tolerance: number;
}

/** Reliability by equal-width bins of the predicted probability, Brier, calibration in the large. */
export function calibrateClearsToFa(
  observations: readonly ClearsObservation[],
  opts: { readonly bins?: number; readonly min_bin_n?: number; readonly tolerance?: number } = {},
): ClearsCalibration {
  const k =
    opts.bins !== undefined && Number.isInteger(opts.bins) && opts.bins >= 1 && opts.bins <= 100
      ? opts.bins
      : WAIVER_FIT.calibrationBins;
  const minN = opts.min_bin_n ?? WAIVER_FIT.minBinN;
  const tol = opts.tolerance ?? WAIVER_FIT.tolerance;
  const sums = Array.from({ length: k }, () => ({ n: 0, p: 0, y: 0 }));
  let n = 0;
  let rejected = 0;
  let brier = 0;
  let sp = 0;
  let sy = 0;
  for (const o of observations) {
    if (!Number.isFinite(o.p) || o.p < 0 || o.p > 1 || typeof o.cleared !== "boolean") {
      rejected += 1;
      continue;
    }
    const y = o.cleared ? 1 : 0;
    n += 1;
    sp += o.p;
    sy += y;
    brier += (o.p - y) ** 2;
    const b = Math.min(k - 1, Math.floor(o.p * k));
    const s = sums[b];
    if (s !== undefined) {
      s.n += 1;
      s.p += o.p;
      s.y += y;
    }
  }
  const bins: ReliabilityBin[] = sums.map((s, i) => {
    const meanP = s.n > 0 ? s.p / s.n : null;
    const obs = s.n > 0 ? s.y / s.n : null;
    return {
      lo: round(i / k, 4),
      hi: round((i + 1) / k, 4),
      n: s.n,
      mean_p: meanP === null ? null : round(meanP, 4),
      observed: obs === null ? null : round(obs, 4),
      deviation: meanP === null || obs === null ? null : round(obs - meanP, 4),
      judged: s.n >= minN,
    };
  });
  const judged = bins.filter((b) => b.judged && b.deviation !== null);
  const maxDev =
    judged.length === 0
      ? null
      : round(Math.max(...judged.map((b) => Math.abs(b.deviation ?? 0))), 4);
  return Object.freeze({
    n,
    rejected,
    brier: n > 0 ? round(brier / n, 4) : null,
    mean_p: n > 0 ? round(sp / n, 4) : null,
    base_rate: n > 0 ? round(sy / n, 4) : null,
    in_the_large: n > 0 ? round(sy / n - sp / n, 4) : null,
    bins: Object.freeze(bins),
    max_abs_deviation: maxDev,
    within_tolerance: maxDev === null ? null : maxDev <= tol + 1e-12,
    soft: n < WAIVER_FIT.softBelow,
    tolerance: tol,
  });
}

/** E5's clears probability for a per-week rate r, m able rivals and a demand multiplier. */
export function clearProbability(r: number, rivals: number, scale = 1): number {
  const m = Number.isFinite(rivals) && rivals > 0 ? Math.floor(rivals) : 0;
  return (1 - Math.min(1, demandOf(r, scale))) ** m;
}

/** One outcome for the demand-scale fit. */
export interface ClearsOutcome {
  /** The player's per-week rate (E5's r: surplus over the drop candidate / horizon). */
  readonly r: number;
  /** Rivals able to claim him. */
  readonly rivals: number;
  readonly cleared: boolean;
}

/** The fitted demand multiplier. */
export interface DemandScaleFit {
  readonly scale: number;
  readonly n: number;
  readonly rejected: number;
  /** Mean log-likelihood at the fitted scale and at the cold start (scale 1). */
  readonly log_likelihood: number | null;
  readonly log_likelihood_cold: number | null;
  /** The optimum sits on a search bound (the data want a scale outside it). */
  readonly at_bound: boolean;
}

const EPS = 1e-12;

/** Maximum-likelihood multiplier on the demand curve for the observed clears (n ≥ 1; else 1). */
export function fitDemandScale(outcomes: readonly ClearsOutcome[]): DemandScaleFit {
  const ok = outcomes.filter(
    (o) =>
      Number.isFinite(o.r) &&
      Number.isFinite(o.rivals) &&
      o.rivals >= 1 &&
      typeof o.cleared === "boolean",
  );
  const rejected = outcomes.length - ok.length;
  if (ok.length === 0)
    return Object.freeze({
      scale: 1,
      n: 0,
      rejected,
      log_likelihood: null,
      log_likelihood_cold: null,
      at_bound: false,
    });
  const ll = (scale: number): number => {
    let s = 0;
    for (const o of ok) {
      const p = clearProbability(o.r, o.rivals, scale);
      s += Math.log(Math.min(1 - EPS, Math.max(EPS, o.cleared ? p : 1 - p)));
    }
    return s / ok.length;
  };
  const { min, max } = WAIVER_FIT.demandScale;
  let a = Math.log(min);
  let b = Math.log(max);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = ll(Math.exp(c));
  let fd = ll(Math.exp(d));
  for (let i = 0; i < 80; i++) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = ll(Math.exp(c));
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = ll(Math.exp(d));
    }
  }
  const scale = Math.exp((a + b) / 2);
  const atBound = scale <= min * 1.001 || scale >= max * 0.999;
  return Object.freeze({
    scale: round(scale, 4),
    n: ok.length,
    rejected,
    log_likelihood: round(ll(scale), 5),
    log_likelihood_cold: round(ll(1), 5),
    at_bound: atBound,
  });
}
