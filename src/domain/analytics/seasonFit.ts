// seasonFit.ts — E3 `espn_analyze_matchup(mode: season)` with E1 inputs, the FITTED season (plan 07
// E3 Method: "each team's weekly distribution from E1 when available, else Normal(μ_i, σ_i) with
// the season-to-date mean shrunk n/(n+4)"; plan 10 B9: with E1 inputs it reproduces the cold-start
// result within 0.05 on the base fixture). Each team's weekly model is its E1 lineup projection used
// as the PRIOR the season-to-date evidence updates with the cold start's own weight: μ = μ_E1 +
// n/(n+4) · (season mean − μ_E1), σ = E1's lineup σ (the position-CV spread with the same-team
// correlations) — the cold start is the same formula with the league mean as the prior, so the two
// share their evidence term and differ only where the rosters do. A team without projections keeps
// the simulator's cold start (named in the assumptions). The simulation itself is seeding.ts
// (Phase 1a domain code, cooperative under the CPU deadline). Pure. New here.
import type { RosterSlots, Week } from "../league/types.js";
import { SEEDING } from "./constants.js";
import { ensure } from "./errors.js";
import { bestLineup, type LineupPlayer } from "./lineup.js";
import { round } from "./math.js";
import {
  simulateSeason,
  type SeasonSimOutcome,
  type SeasonSimRequest,
  type SeasonTeam,
} from "./seeding.js";
import { lineupMoments } from "./totals.js";
import type { Assumption } from "./types.js";

/** One team-week of an E1 lineup projection: the expected total and its σ. */
export interface TeamWeekProjection {
  readonly week: Week;
  readonly mu: number;
  readonly sigma: number;
}

/**
 * A team's weekly lineup projection from its roster and E1 (`bestLineup` by mean, locks respected;
 * `lineupMoments` with the same-team correlations). Throws nothing; an empty roster gives 0, 0.
 */
export function teamWeekOf(
  roster: RosterSlots,
  players: readonly LineupPlayer[],
  week: Week,
): TeamWeekProjection {
  const starters = bestLineup(roster, players);
  const m = lineupMoments(
    starters.map((p) => ({
      player_id: p.player_id,
      position: p.position,
      pro_team_id: p.pro_team_id,
      points: p.points,
    })),
  );
  return { week, mu: m.mu, sigma: Math.sqrt(m.v) };
}

/** The weekly model the projection weeks imply: their mean μ and the root-mean-square σ. */
export function projectionModel(
  weeks: readonly TeamWeekProjection[],
): { readonly mu: number; readonly sigma: number } | null {
  const ok = weeks.filter(
    (w) => Number.isFinite(w.mu) && Number.isFinite(w.sigma) && w.sigma >= 0 && w.mu >= 0,
  );
  if (ok.length === 0) return null;
  const mu = ok.reduce((s, w) => s + w.mu, 0) / ok.length;
  const sigma = Math.sqrt(ok.reduce((s, w) => s + w.sigma * w.sigma, 0) / ok.length);
  return { mu, sigma };
}

/**
 * The fitted weekly model of one team: E1's projection as the prior, updated by the season-to-date
 * mean with weight n/(n + SEEDING.shrinkGames) (the cold start's weight); σ from E1.
 */
export function fittedWeekly(
  team: Pick<SeasonTeam, "wins" | "losses" | "ties" | "points_for">,
  prior: { readonly mu: number; readonly sigma: number },
): { readonly mu: number; readonly sigma: number } {
  const n = team.wins + team.losses + team.ties;
  if (n <= 0) return { mu: prior.mu, sigma: prior.sigma };
  const w = n / (n + SEEDING.shrinkGames);
  return { mu: prior.mu + w * (team.points_for / n - prior.mu), sigma: prior.sigma };
}

/** A fitted-season request: the simulator's request plus each team's E1 projection weeks. */
export interface FittedSeasonRequest extends Omit<SeasonSimRequest, "teams"> {
  /** Standings to date (any `weekly` given here is ignored — the projections decide). */
  readonly teams: readonly Omit<SeasonTeam, "weekly">[];
  /** Team id → its E1 lineup projection for the remaining weeks (≥ 1); absent → cold start. */
  readonly projections: ReadonlyMap<number, readonly TeamWeekProjection[]>;
}

/** The fitted season's outcome: the simulator's, plus how each team was modelled. */
export interface FittedSeasonOutcome extends SeasonSimOutcome {
  /** `e1_fitted` when every team had projections, `cold_start` when none did, else `mixed`. */
  readonly weekly_model: "e1_fitted" | "cold_start" | "mixed";
  readonly fitted_teams: readonly number[];
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

/**
 * E3 `season` with E1 inputs. Throws AnalyticsError `invalid_request` on a malformed league (the
 * simulator's checks) or a projection for a team not in the league.
 */
export async function simulateFittedSeason(req: FittedSeasonRequest): Promise<FittedSeasonOutcome> {
  const ids = new Set(req.teams.map((t) => t.team_id));
  for (const id of req.projections.keys())
    ensure(ids.has(id), "a projection names a team not in the league", "projections");
  const fitted: number[] = [];
  const teams: SeasonTeam[] = req.teams.map((t) => {
    const prior = projectionModel(req.projections.get(t.team_id) ?? []);
    if (prior === null) return { ...t, weekly: null };
    fitted.push(t.team_id);
    return { ...t, weekly: fittedWeekly(t, prior) };
  });
  const { projections: _p, ...rest } = req;
  const sim = await simulateSeason({ ...rest, teams });
  const model: FittedSeasonOutcome["weekly_model"] =
    fitted.length === teams.length ? "e1_fitted" : fitted.length === 0 ? "cold_start" : "mixed";
  const note =
    fitted.length === 0
      ? null
      : A(
          `fitted weekly model for ${String(fitted.length)} teams: the E1 lineup projection updated by the season-to-date mean at n/(n+${String(SEEDING.shrinkGames)}), σ from E1`,
          "the projections or the standings change",
        );
  const rec = sim.data.rec;
  return {
    ...sim,
    data:
      note === null
        ? sim.data
        : { ...sim.data, rec: { ...rec, assumptions: [note, ...rec.assumptions] } },
    weekly_model: model,
    fitted_teams: fitted.sort((a, b) => a - b),
    models: new Map(
      [...sim.models.entries()].map(([k, v]) => [
        k,
        { mu: round(v.mu, 3), sigma: round(v.sigma, 3) },
      ]),
    ),
  };
}
