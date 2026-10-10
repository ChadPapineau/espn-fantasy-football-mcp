// fit.ts — the waiver DP re-solved from a league's own surplus distribution and drift (plan 10 §3.3,
// C5; plan 07 E5 `premium_basis: "league_fitted"`; research 05 §1.6 eval 3: "re-solve Π; report how
// far the cold-start table was off"; ADV OBJ-03: "cold_start_table stays until the league's own feed
// re-solves Π"). The same DP as the cold start (waiverDp.ts `solvePremiumTable`, its `rates` and
// `drift` parameters), the same ×0.5 / ×1.5 band (plan 07 E5) around the fitted distribution. The
// basis becomes `league_fitted` only once the feed holds WAIVER_FIT.minRuns runs; before that the
// cold-start tables are returned with the reason. Pure. New here (Phase 3).
import { round } from "../math.js";
import { PREMIUM_BAND_MULTIPLIERS, type PremiumBasis } from "../types.js";
import { solvePremiumTable, type PremiumTable } from "../waiverDp.js";
import { WAIVER_FIT } from "./constants.js";
import { fitDrift, type DriftFit } from "./drift.js";
import { fitSurplusDistribution, type SurplusFit, type SurplusObservation } from "./surplus.js";

/** A league-fitted (or, short of data, cold-start) premium: what E5 reads Π and its band from. */
export interface LeaguePremiumFit {
  readonly basis: PremiumBasis;
  readonly teams: number;
  readonly surplus: SurplusFit;
  readonly drift: DriftFit;
  /** The demand multiplier the DP was solved with (1 = the cold-start curve). */
  readonly demand_scale: number;
  /** Why the basis stayed cold, or the caveats of the fit (generated text). */
  readonly reasons: readonly string[];
  readonly base: PremiumTable;
  readonly low: PremiumTable;
  readonly high: PremiumTable;
  /** One generated line for E5's assumptions. */
  readonly summary: string;
}

/** The research table's columns (research 05 §1.2). */
export const RESEARCH_W_COLUMNS = Object.freeze([1, 3, 5, 7, 9, 11, 13, 15]);

/**
 * Fits the premium: the surplus distribution from `surplus` (one observation per run), the drift
 * from `drift` (fitDrift's result; null → the cold-start c), an optional demand multiplier.
 * Throws RangeError (from the DP) only on a league size outside 2..20.
 */
export function fitLeaguePremium(input: {
  readonly teams: number;
  readonly surplus: readonly SurplusObservation[];
  readonly drift?: DriftFit | null;
  readonly demand_scale?: number | null;
  readonly min_runs?: number;
}): LeaguePremiumFit {
  const surplus = fitSurplusDistribution(input.surplus);
  const drift = input.drift ?? fitDrift([], "claims");
  const minRuns =
    input.min_runs !== undefined && Number.isFinite(input.min_runs) && input.min_runs >= 0
      ? input.min_runs
      : WAIVER_FIT.minRuns;
  const ds = input.demand_scale;
  const demandScale =
    ds !== undefined &&
    ds !== null &&
    Number.isFinite(ds) &&
    ds >= WAIVER_FIT.demandScale.min &&
    ds <= WAIVER_FIT.demandScale.max
      ? ds
      : 1;
  const reasons: string[] = [];
  const fitted = surplus.n >= minRuns;
  if (!fitted)
    reasons.push(
      `${String(surplus.n)} run(s) in the league's feed, fewer than the ${String(minRuns)} a fitted premium needs: the cold-start table stays`,
    );
  if (surplus.rejected > 0)
    reasons.push(`${String(surplus.rejected)} unusable surplus observation(s) ignored`);
  if (surplus.clamped > 0)
    reasons.push(
      `${String(surplus.clamped)} run(s) above ${String(WAIVER_FIT.support.at(-1))} points per week counted at the top of the support`,
    );
  if (fitted && drift.basis === "prior")
    reasons.push(
      `drift c stays the cold-start ${String(drift.prior_c)}: ${String(drift.team_weeks)} team-week(s) observed`,
    );
  if (fitted && drift.basis === "prior_within_acquisition_bound")
    reasons.push(
      `drift c stays the cold-start ${String(drift.prior_c)}: the acquisition share ${String(drift.upper_bound)} only bounds it from above (free-agent adds count there too)`,
    );
  if (fitted && drift.basis === "acquisition_bound")
    reasons.push(
      `drift c cut to the acquisition share ${String(drift.c)}: rivals win claims less often than the cold-start ${String(drift.prior_c)} allows`,
    );
  const params = fitted
    ? {
        teams: input.teams,
        rates: surplus.rates,
        drift: drift.c,
        demandScale,
      }
    : { teams: input.teams };
  const base = solvePremiumTable(params);
  const low = solvePremiumTable({ ...params, surplusScale: PREMIUM_BAND_MULTIPLIERS.low });
  const high = solvePremiumTable({ ...params, surplusScale: PREMIUM_BAND_MULTIPLIERS.high });
  const summary = fitted
    ? `premium re-solved from the league's own feed: ${String(surplus.n)} runs (mean best-claim rate ${String(surplus.mean_r)} pts/week vs the cold start's ${String(surplus.prior_mean_r)}), drift c ${String(drift.c)} (${drift.basis})${demandScale !== 1 ? `, demand ×${String(round(demandScale, 3))}` : ""}`
    : "premium from the cold-start table: the league's own feed is too short to re-solve it";
  return Object.freeze({
    basis: fitted ? "league_fitted" : "cold_start_table",
    teams: input.teams,
    surplus,
    drift,
    demand_scale: fitted ? demandScale : 1,
    reasons: Object.freeze(reasons),
    base,
    low,
    high,
    summary,
  });
}

/** One cell of the fitted-vs-cold comparison (research 05 §1.6 eval 3). */
export interface PremiumCell {
  readonly k: number;
  readonly W: number;
  readonly cold: number;
  readonly fitted: number;
  /** fitted − cold (ROS points). */
  readonly diff: number;
  /** fitted / cold (null when the cold cell is 0). */
  readonly ratio: number | null;
}

/** The fitted table against the cold-start table cell by cell (default: every k, the research W). */
export function comparePremium(
  fit: Pick<LeaguePremiumFit, "base" | "teams">,
  cells: { readonly ks?: readonly number[]; readonly Ws?: readonly number[] } = {},
): PremiumCell[] {
  const cold = solvePremiumTable({ teams: fit.teams });
  const ks = cells.ks ?? Array.from({ length: fit.teams }, (_, i) => i + 1);
  const Ws = cells.Ws ?? RESEARCH_W_COLUMNS;
  const out: PremiumCell[] = [];
  for (const k of ks)
    for (const W of Ws) {
      const c = cold.premium(k, W);
      const f = fit.base.premium(k, W);
      out.push({
        k,
        W,
        cold: round(c, 2),
        fitted: round(f, 2),
        diff: round(f - c, 2),
        ratio: c > 0 ? round(f / c, 3) : null,
      });
    }
  return out;
}
