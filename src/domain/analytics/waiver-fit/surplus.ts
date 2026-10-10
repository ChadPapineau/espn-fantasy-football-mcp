// surplus.ts — the league's own surplus distribution (research 05 §1.2: "per-week surplus rate of the
// best weekly claim r", a FORECAST distribution; §1.6 eval 3; plan 10 C5). One observation per
// processing run: the best claimable player's surplus over the drop candidate, s, as a per-week rate
// r = s / (W + 1) — the claim's value spans W + 1 weeks (changelog R5-1). Observations are split
// linearly onto the support (keeping their mean) and combined with the cold-start table as a
// Dirichlet prior worth WAIVER_FIT.surplusPriorRuns runs. A non-finite or negative observation is
// rejected (counted), never used. Pure. New here (Phase 3).
import { WAIVER_DP } from "../constants.js";
import { round } from "../math.js";
import { WAIVER_FIT } from "./constants.js";

/** One run's best claim: its surplus rate (points per week over the drop candidate). */
export interface SurplusObservation {
  readonly r: number;
  /** Optional weight (default 1; a run seen twice counts once by passing 0.5 each). */
  readonly weight?: number;
}

/** A fitted surplus distribution. */
export interface SurplusFit {
  /** The distribution on WAIVER_FIT.support (Σ p = 1). */
  readonly rates: readonly { readonly r: number; readonly p: number }[];
  /** Observations used (Σ weight). */
  readonly n: number;
  /** Observations rejected (non-finite, negative, or a non-positive weight). */
  readonly rejected: number;
  /** Observations above the support's top, clamped to it. */
  readonly clamped: number;
  /** The observed mean rate (null with no observation). */
  readonly observed_mean_r: number | null;
  /** The fitted distribution's mean rate. */
  readonly mean_r: number;
  /** The cold-start table's mean rate (the prior). */
  readonly prior_mean_r: number;
  readonly prior_runs: number;
}

/** The per-week rate of a run's best claim: max(0, s) / (W + 1); null when s or W is unusable. */
export function surplusRate(s: number, W: number): number | null {
  if (!Number.isFinite(s) || !Number.isFinite(W) || W < 0) return null;
  return Math.max(0, s) / (W + 1);
}

/**
 * The observations from E5-shaped runs: per run, the best candidate's surplus `s` at that run's `W`
 * (a run with no candidate, or none with a finite `s`, contributes r = 0 — the wire offered nothing).
 */
export function surplusObservationsFromRuns(
  runs: readonly { readonly W: number; readonly candidates: readonly { readonly s: number }[] }[],
): SurplusObservation[] {
  const out: SurplusObservation[] = [];
  for (const run of runs) {
    let best = 0;
    for (const c of run.candidates) if (Number.isFinite(c.s) && c.s > best) best = c.s;
    const r = surplusRate(best, run.W);
    if (r !== null) out.push({ r });
  }
  return out;
}

/** The cold-start table on the fitted support (extended points carry no prior mass). */
function priorOnSupport(support: readonly number[]): number[] {
  return support.map((x) => WAIVER_DP.rates.find((y) => y.r === x)?.p ?? 0);
}

/**
 * Fits the league's surplus distribution: linear binning onto WAIVER_FIT.support plus the
 * cold-start table as a Dirichlet prior (`prior_runs` pseudo-runs). With no usable observation it
 * returns the cold-start distribution.
 */
export function fitSurplusDistribution(
  observations: readonly SurplusObservation[],
  opts: { readonly prior_runs?: number } = {},
): SurplusFit {
  const support = WAIVER_FIT.support;
  const priorRuns =
    opts.prior_runs !== undefined && Number.isFinite(opts.prior_runs) && opts.prior_runs >= 0
      ? opts.prior_runs
      : WAIVER_FIT.surplusPriorRuns;
  const prior = priorOnSupport(support);
  const counts = new Array<number>(support.length).fill(0);
  let n = 0;
  let rejected = 0;
  let clamped = 0;
  let sum = 0;
  const top = support[support.length - 1] ?? 0;
  for (const o of observations) {
    const w = o.weight ?? 1;
    if (!Number.isFinite(o.r) || o.r < 0 || !Number.isFinite(w) || w <= 0) {
      rejected += 1;
      continue;
    }
    n += w;
    sum += w * o.r;
    if (o.r >= top) {
      if (o.r > top) clamped += 1;
      counts[support.length - 1] = (counts[support.length - 1] ?? 0) + w;
      continue;
    }
    let j = 0;
    while (j + 1 < support.length && (support[j + 1] ?? top) <= o.r) j += 1;
    const lo = support[j] ?? 0;
    const hi = support[j + 1] ?? top;
    const f = hi > lo ? (o.r - lo) / (hi - lo) : 0;
    counts[j] = (counts[j] ?? 0) + w * (1 - f);
    counts[j + 1] = (counts[j + 1] ?? 0) + w * f;
  }
  const mass = support.map((_, i) => priorRuns * (prior[i] ?? 0) + (counts[i] ?? 0));
  const total = mass.reduce((a, b) => a + b, 0);
  const p = total > 0 ? mass.map((m) => m / total) : prior;
  // tidy: round to 1e-9 and put the residue on the largest mass so Σ p = 1 exactly enough for the DP
  const rounded = p.map((x) => round(x, 9));
  const residue = 1 - rounded.reduce((a, b) => a + b, 0);
  const iMax = rounded.indexOf(Math.max(...rounded));
  rounded[iMax] = (rounded[iMax] ?? 0) + residue;
  const rates = support
    .map((r, i) => ({ r, p: Math.max(0, rounded[i] ?? 0) }))
    .filter((x) => x.p > 0);
  const meanOf = (xs: readonly { r: number; p: number }[]): number =>
    xs.reduce((a, x) => a + x.r * x.p, 0);
  return Object.freeze({
    rates: Object.freeze(rates.map((x) => Object.freeze(x))),
    n,
    rejected,
    clamped,
    observed_mean_r: n > 0 ? round(sum / n, 4) : null,
    mean_r: round(meanOf(rates), 4),
    prior_mean_r: round(meanOf(WAIVER_DP.rates), 4),
    prior_runs: priorRuns,
  });
}
