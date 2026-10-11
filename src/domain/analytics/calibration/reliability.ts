// reliability.ts — P(win) calibration per decile (plan 10 C2 "P(win) calibrated within ±5 points per
// decile"; sib research 05 §11 Evaluation "calibration within ±5 points per decile", §12.1 Brier with
// its reliability–resolution–uncertainty decomposition and the reliability diagram; research 05
// §8.4 "the retrospective refuses conclusions from fewer than ~30 calls of a type"). A decile is
// CHECKED when it holds ≥ CALIBRATION.minBinN forecasts; the literal criterion holds when every
// checked decile's realised rate is within ±tolerance of its mean forecast. A ±5-point gap is smaller
// than one standard error until a decile holds ≈ 90 forecasts at p ≈ ½ (≈ 384 to resolve it at
// 95 %), so every decile also carries its Wilson 95 % interval and the forecasts it would need to
// resolve the tolerance, and a family-wise consistency check (Bonferroni over the non-empty deciles —
// ten 95 % intervals would flag a perfectly calibrated forecaster four times in ten). The verdict
// separates a gap the sample can resolve, or a decile inconsistent with its forecasts (`not_met`),
// from a literal miss the sample cannot resolve (`unresolved` — reported with the literal numbers,
// never tolerated or hidden). Beside the Brier decomposition's reliability term the report carries
// the term a perfectly calibrated forecaster issuing the same forecasts would expect from sampling
// alone (B2b gate round 3: the yardstick for reading the observed term as noise or as miscalibration
// — a comparison with the resolution term is not one). Stage C (changelog R6-2): the floor is the
// term's MEAN; `reliabilityNull` adds its whole sampling distribution under calibration — a seeded
// Monte-Carlo that draws one outcome per independent event and, for a mirrored family (each
// matchup scored from both sides), gives the mirror the complementary outcome — so "twice the
// floor" can be read as a p-value instead of a ratio. Pure (the Rng is injected). New here.
import type { Rng } from "../../clock.js";
import {
  RELIABILITY_BINS,
  at,
  binIndex,
  brierWithDecomposition,
  stableSum,
  type BrierValue,
  type ProbabilityOutcome,
} from "../../reclog/metrics.js";
import { ensure } from "../errors.js";
import { normalCdf } from "../math.js";

/** The calibration criterion's constants (plan 10 C2; research 05 §8.4). */
export const CALIBRATION = Object.freeze({
  /** ±5 points per decile (plan 10 C2). */
  tolerance: 0.05,
  /** Fewest forecasts in a decile before its gap is checked (research 05 §8.4 "~30 calls"). */
  minBinN: 30,
  /** Two-sided level of the Wilson interval and of the family-wise consistency check. */
  alpha: 0.05,
  /** Most forecasts one report accepts (a season replay holds a few hundred). */
  maxForecasts: 200_000,
  /** Monte-Carlo draws of the calibrated forecaster's reliability term (reliabilityNull default). */
  nullSims: 10_000,
  /** Fewest / most draws reliabilityNull accepts. */
  minNullSims: 100,
  maxNullSims: 200_000,
});

/** The standard normal quantile Φ⁻¹(p) for p in (0, 1), by bisection on normalCdf (|error| < 1e-9). */
export function normalQuantile(p: number): number {
  ensure(Number.isFinite(p) && p > 0 && p < 1, "a quantile level must be in (0, 1)", "p");
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** z of a two-sided interval at level 1 − alpha. */
const zTwoSided = (alpha: number): number => normalQuantile(1 - alpha / 2);

/** A decile's verdict under the literal criterion. */
export type BinVerdict = "within" | "outside" | "insufficient_n";

/** One reliability bin: [lo, hi) of the forecast (p = 1 in the last). */
export interface ReliabilityBin {
  readonly index: number;
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  /** Mean forecast in the bin; null when empty. */
  readonly mean_p: number | null;
  /** Realised frequency; null when empty. */
  readonly rate: number | null;
  /** rate − mean_p (positive = the event happened more often than forecast); null when empty. */
  readonly gap: number | null;
  /** Wilson 95 % interval of the realised rate; null when empty. */
  readonly wilson: readonly [number, number] | null;
  /** Forecasts the bin would need for ±tolerance to be the 95 % half-width at its mean forecast. */
  readonly n_to_resolve: number | null;
  readonly verdict: BinVerdict;
  /** The mean forecast lies inside the family-wise (Bonferroni) Wilson interval; null when empty. */
  readonly consistent: boolean | null;
}

/** The report's overall status. */
export type CalibrationStatus =
  /** Every checked decile is within ±tolerance (at least one checked) and every decile consistent. */
  | "met"
  /** A checked decile misses ±tolerance with a sample large enough to resolve it, or a decile is
   * inconsistent with its forecasts at the family-wise level. */
  | "not_met"
  /** ±tolerance is missed only in deciles too small to resolve it, every decile consistent. */
  | "unresolved"
  /** No decile holds minBinN forecasts (and none is inconsistent). */
  | "insufficient_n";

/** P(win) calibration of one forecast family. */
export interface ReliabilityReport {
  readonly n: number;
  readonly brier: BrierValue;
  /** Brier of always forecasting ½ (0.25) — the coin-flip baseline. */
  readonly brier_coin_flip: number;
  readonly bins: readonly ReliabilityBin[];
  readonly tolerance: number;
  readonly min_bin_n: number;
  readonly bins_checked: number;
  /** Indices of the checked deciles outside ±tolerance. */
  readonly bins_outside: readonly number[];
  /** Largest |gap| over the checked deciles; null when none is checked. */
  readonly max_checked_gap: number | null;
  /** Every non-empty decile is consistent with its forecasts at the family-wise level. */
  readonly consistent: boolean;
  /**
   * The expected value of `brier.decomposition.reliability` (same bins) if every outcome were drawn
   * independently from its own forecast — a perfectly calibrated forecaster issuing exactly these
   * forecasts: (1/N) Σ_k (1/n_k) Σ_{i∈k} p_i(1 − p_i). An observed term at or below it is what
   * sampling alone produces; one well above it points to miscalibration the deciles can see.
   */
  readonly reliability_if_calibrated: number;
  readonly status: CalibrationStatus;
}

/** The Wilson score interval of k successes in n trials (n ≥ 1) at normal quantile z. */
export function wilsonInterval(
  k: number,
  n: number,
  z: number = zTwoSided(CALIBRATION.alpha),
): readonly [number, number] {
  ensure(Number.isInteger(n) && n >= 1, "wilson needs n ≥ 1", "n");
  ensure(Number.isInteger(k) && k >= 0 && k <= n, "wilson needs 0 ≤ k ≤ n", "k");
  ensure(Number.isFinite(z) && z > 0, "wilson needs z > 0", "z");
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  // the edges are exact (k = 0 → lower 0, k = n → upper 1); floating point would leave 1 − ε
  return [k === 0 ? 0 : Math.max(0, centre - half), k === n ? 1 : Math.min(1, centre + half)];
}

/** Forecasts a bin needs for ±tol to be the 95 % half-width at forecast p (binomial variance). */
export function nToResolve(p: number, tol: number): number {
  ensure(Number.isFinite(p) && p >= 0 && p <= 1, "p must be in [0, 1]", "p");
  ensure(Number.isFinite(tol) && tol > 0 && tol < 1, "tolerance must be in (0, 1)", "tolerance");
  const z = zTwoSided(CALIBRATION.alpha);
  const v = Math.max(p * (1 - p), 1e-12);
  return Math.ceil((z * z * v) / (tol * tol));
}

const EPS = 1e-12;

/**
 * Bins forecasts by decile and judges them against ±tolerance (plan 10 C2). Throws AnalyticsError
 * `invalid_request` on an empty list, a malformed pair (reclog's Brier check), or bad options.
 */
export function reliabilityByDecile(
  pairs: readonly ProbabilityOutcome[],
  opts: { readonly tolerance?: number; readonly min_bin_n?: number; readonly bins?: number } = {},
): ReliabilityReport {
  const tol = opts.tolerance ?? CALIBRATION.tolerance;
  const minN = opts.min_bin_n ?? CALIBRATION.minBinN;
  const bins = opts.bins ?? RELIABILITY_BINS;
  ensure(Number.isFinite(tol) && tol > 0 && tol < 1, "tolerance must be in (0, 1)", "tolerance");
  ensure(Number.isInteger(minN) && minN >= 1 && minN <= 1e6, "min_bin_n must be ≥ 1", "min_bin_n");
  ensure(Number.isInteger(bins) && bins >= 1 && bins <= 100, "bins must be 1..100", "bins");
  const list: unknown = pairs;
  ensure(
    Array.isArray(list) && list.length >= 1 && list.length <= CALIBRATION.maxForecasts,
    "forecast count out of range",
    "pairs",
  );
  let brier: BrierValue;
  try {
    brier = brierWithDecomposition(pairs, bins);
  } catch {
    ensure(false, "a forecast must be a probability in [0, 1] with a boolean outcome", "pairs");
  }
  const groups = Array.from({ length: bins }, () => ({ p: [] as number[], k: 0 }));
  for (const { p, outcome } of pairs) {
    const g = at(groups, binIndex(p, bins));
    g.p.push(p);
    if (outcome) g.k += 1;
  }
  const filled = groups.filter((g) => g.p.length > 0).length;
  const z95 = zTwoSided(CALIBRATION.alpha);
  const zFamily = zTwoSided(CALIBRATION.alpha / Math.max(1, filled));
  const out: ReliabilityBin[] = groups.map((g, index) => {
    const n = g.p.length;
    const lo = index / bins;
    const hi = (index + 1) / bins;
    if (n === 0)
      return {
        index,
        lo,
        hi,
        n,
        mean_p: null,
        rate: null,
        gap: null,
        wilson: null,
        n_to_resolve: null,
        verdict: "insufficient_n",
        consistent: null,
      };
    const meanP = stableSum(g.p) / n;
    const rate = g.k / n;
    const gap = rate - meanP;
    const family = wilsonInterval(g.k, n, zFamily);
    const verdict: BinVerdict =
      n < minN ? "insufficient_n" : Math.abs(gap) <= tol + EPS ? "within" : "outside";
    return {
      index,
      lo,
      hi,
      n,
      mean_p: meanP,
      rate,
      gap,
      wilson: wilsonInterval(g.k, n, z95),
      n_to_resolve: nToResolve(meanP, tol),
      verdict,
      consistent: meanP >= family[0] - EPS && meanP <= family[1] + EPS,
    };
  });
  const checked = out.filter((b) => b.verdict !== "insufficient_n");
  const outside = checked.filter((b) => b.verdict === "outside");
  const consistent = out.every((b) => b.consistent !== false);
  const resolvedMiss = outside.some((b) => b.n >= (b.n_to_resolve ?? Infinity));
  const status: CalibrationStatus =
    !consistent || resolvedMiss
      ? "not_met"
      : checked.length === 0
        ? "insufficient_n"
        : outside.length === 0
          ? "met"
          : "unresolved";
  return {
    n: pairs.length,
    brier,
    brier_coin_flip: 0.25,
    bins: out,
    tolerance: tol,
    min_bin_n: minN,
    bins_checked: checked.length,
    bins_outside: outside.map((b) => b.index),
    max_checked_gap:
      checked.length === 0 ? null : Math.max(...checked.map((b) => Math.abs(b.gap ?? 0))),
    consistent,
    reliability_if_calibrated: reliabilityIfCalibrated(
      groups.map((g) => g.p),
      pairs.length,
    ),
    status,
  };
}

/**
 * E[reliability term] for forecasts grouped as `bins` when each outcome is an independent
 * Bernoulli(p_i): within bin k the gap ō_k − f̄_k has mean 0 and variance Σ p_i(1 − p_i) / n_k², and
 * the term weighs its square by n_k / N.
 */
function reliabilityIfCalibrated(bins: readonly (readonly number[])[], n: number): number {
  const terms: number[] = [];
  for (const ps of bins) {
    if (ps.length === 0) continue;
    terms.push(stableSum(ps.map((p) => p * (1 - p))) / ps.length);
  }
  return stableSum(terms) / n;
}

/** The calibrated forecaster's sampling distribution of the reliability term (changelog R6-2). */
export interface ReliabilityNull {
  /** The observed reliability term of the scored forecasts (every side). */
  readonly observed: number;
  /** Independent events drawn (a matchup counts once). */
  readonly events: number;
  /** Forecasts scored: `events`, or 2 × `events` when mirrored. */
  readonly forecasts: number;
  readonly mirrored: boolean;
  readonly sims: number;
  /** Mean simulated term (its expectation is `reliability_if_calibrated` of the same forecasts). */
  readonly mean: number;
  /** 95th / 99th percentile of the simulated term. */
  readonly q95: number;
  readonly q99: number;
  /**
   * (1 + #{simulated ≥ observed}) / (1 + sims): how often a perfectly calibrated forecaster issuing
   * exactly these forecasts scores a term at least as large (the Monte-Carlo p-value; never 0).
   */
  readonly p_value: number;
}

/** The fixed part of the term: each forecast's bin, each bin's size and mean forecast. */
interface BinPlan {
  readonly bin: readonly number[];
  readonly size: readonly number[];
  readonly meanP: readonly number[];
}

function binPlan(ps: readonly number[], bins: number): BinPlan {
  const bin = ps.map((p) => binIndex(p, bins));
  const size = new Array<number>(bins).fill(0);
  const sums: number[][] = Array.from({ length: bins }, () => []);
  ps.forEach((p, i) => {
    const k = at(bin, i);
    size[k] = at(size, k) + 1;
    at(sums, k).push(p);
  });
  return { bin, size, meanP: sums.map((s) => (s.length === 0 ? 0 : stableSum(s) / s.length)) };
}

/** Σ_k n_k (f̄_k − ō_k)² / N for one set of outcomes (the Brier decomposition's reliability). */
function reliabilityTerm(plan: BinPlan, outcomes: readonly boolean[], hits: number[]): number {
  hits.fill(0);
  outcomes.forEach((o, i) => {
    if (o) {
      const k = at(plan.bin, i);
      hits[k] = at(hits, k) + 1;
    }
  });
  let term = 0;
  plan.size.forEach((n, k) => {
    if (n > 0) term += n * (at(plan.meanP, k) - at(hits, k) / n) ** 2;
  });
  return term / outcomes.length;
}

/**
 * The reliability term's distribution under perfect calibration (changelog R6-2, Stage C): every
 * event's outcome drawn from its own forecast, `sims` times. `events` lists each INDEPENDENT event
 * once with its forecast and observed outcome; `mirrored` scores every event from both sides — the
 * forecast p with the outcome and 1 − p with its complement, as a head-to-head family that counts
 * each matchup for both teams does — so the mirror's outcome is never drawn independently (two
 * mirrored deciles move together, which roughly doubles the term's spread; the mean is unchanged).
 * Deterministic for a given Rng state. Throws AnalyticsError `invalid_request` on an empty or
 * oversized list, a malformed event, or bad options.
 */
export function reliabilityNull(
  events: readonly ProbabilityOutcome[],
  opts: {
    readonly rng: Rng;
    readonly mirrored?: boolean;
    readonly sims?: number;
    readonly bins?: number;
  },
): ReliabilityNull {
  const sims = opts.sims ?? CALIBRATION.nullSims;
  const bins = opts.bins ?? RELIABILITY_BINS;
  const mirrored = opts.mirrored === true;
  ensure(
    Number.isInteger(sims) && sims >= CALIBRATION.minNullSims && sims <= CALIBRATION.maxNullSims,
    "sims out of range",
    "sims",
  );
  ensure(Number.isInteger(bins) && bins >= 1 && bins <= 100, "bins must be 1..100", "bins");
  ensure(
    typeof (opts.rng as Partial<Rng> | undefined)?.next === "function",
    "an rng is required",
    "rng",
  );
  const list: unknown = events;
  ensure(
    Array.isArray(list) &&
      list.length >= 1 &&
      list.length * (mirrored ? 2 : 1) <= CALIBRATION.maxForecasts,
    "event count out of range",
    "events",
  );
  try {
    brierWithDecomposition(events, bins);
  } catch {
    ensure(false, "an event must be a probability in [0, 1] with a boolean outcome", "events");
  }
  const scored = mirrored
    ? events.flatMap((e) => [e, { p: 1 - e.p, outcome: !e.outcome }])
    : [...events];
  const plan = binPlan(
    scored.map((x) => x.p),
    bins,
  );
  const hits = new Array<number>(bins).fill(0);
  const observed = reliabilityTerm(
    plan,
    scored.map((x) => x.outcome),
    hits,
  );
  const draws = new Array<number>(sims);
  const outcomes = new Array<boolean>(scored.length).fill(false);
  let atLeast = 0;
  for (let s = 0; s < sims; s++) {
    events.forEach((e, i) => {
      const o = opts.rng.next() < e.p;
      if (mirrored) {
        outcomes[2 * i] = o;
        outcomes[2 * i + 1] = !o;
      } else outcomes[i] = o;
    });
    const term = reliabilityTerm(plan, outcomes, hits);
    draws[s] = term;
    if (term >= observed - EPS) atLeast += 1;
  }
  const sorted = [...draws].sort((a, b) => a - b);
  const quantile = (q: number): number => at(sorted, Math.max(0, Math.ceil(q * sims) - 1));
  return {
    observed,
    events: events.length,
    forecasts: scored.length,
    mirrored,
    sims,
    mean: stableSum(draws) / sims,
    q95: quantile(0.95),
    q99: quantile(0.99),
    p_value: (1 + atLeast) / (1 + sims),
  };
}
