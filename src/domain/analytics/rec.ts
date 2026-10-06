// rec.ts — the analytics side of E12/E13 (plan 07 E12 `espn_record_recommendation`, E13
// `espn_analyze_retrospective`; research 05 §5 Calibration, §8.1 #7, §8.4): the alternatives an
// analytics result offers for the log; our pre-lock forecasts and ESPN's comparator in the shapes
// the retrospective scores (ESPN's mean widened by the SAME position-CV rule E1 uses — "beat ESPN's
// mean-only projection given a positional-CV distribution"); and the shipped `weight_espn` that makes
// the "start by ESPN projection" baseline uninformative in v1 (plan 07 E13; R2 nit 2). Pure. New here.
import type { Alternative } from "../reclog/types.js";
import type {
  ComparatorProbability,
  PlayerForecast,
  WeekProbability,
} from "../reclog/retrospective.js";
import type { Week } from "../league/types.js";
import type { Dist, ScoringSettings } from "../scoring/types.js";
import { gammaDist, normalDist, sigmaOf } from "./math.js";
import { positionCv, type ProjectedPlayer } from "./projection.js";
import {
  WEIGHT_ESPN_V1,
  type LineupData,
  type RecSubject,
  type SeasonSimData,
  type WaiversData,
} from "./types.js";

/** The `weight_espn` v1 ships (plan 07 E1; ADV OBJ-02) — E13's `RetrospectiveInput.weight_espn`. */
export const SHIPPED_WEIGHT_ESPN = WEIGHT_ESPN_V1;

/**
 * Whether the "start by ESPN's projection" baseline can say anything (plan 07 E13 `informative`):
 * only once our mean can differ from ESPN's — at weight_espn = 1.0 `objective: mean` picks ESPN's
 * lineup and the regret is identically zero.
 */
export function espnBaselineInformative(weightEspn: number = SHIPPED_WEIGHT_ESPN): boolean {
  return Number.isFinite(weightEspn) && weightEspn < 1;
}

/** ESPN's projection as the retrospective's comparator Dist (E1's position-CV rule, no sampling). */
export function espnComparatorDist(
  espnMean: number | null,
  position: string,
  positionId: number,
  settings: ScoringSettings,
): Dist | null {
  if (espnMean === null || !Number.isFinite(espnMean)) return null;
  return gammaDist(espnMean, positionCv(position, positionId, settings), "position_cv");
}

/**
 * One E13 player forecast from an E1 projected week (the newest projection made before lock — the
 * caller's responsibility) and the realised ESPN `appliedTotal`; null when the week is not in the
 * projection or the outcome is not a number.
 */
export function playerForecastOf(
  p: ProjectedPlayer,
  week: Week,
  outcome: number | null,
  settings: ScoringSettings,
): PlayerForecast | null {
  const w = p.weeks.find((x) => x.week === week);
  if (w === undefined || outcome === null || !Number.isFinite(outcome)) return null;
  return {
    week,
    player_id: p.target.player_id,
    position: p.target.position,
    ours: w.dist,
    ours_samples: null,
    espn: espnComparatorDist(w.espn, p.target.position, p.target.position_id, settings),
    outcome,
  };
}

/** The P(win) row E13 scores: our pre-lock P(win) of the recommended lineup beside ESPN's. */
export function pWinForecastOf(
  week: Week,
  lineup: Pick<LineupData, "p_win_after">,
  espnWinProbability: number | null,
  won: boolean,
): ComparatorProbability {
  return { week, ours: lineup.p_win_after, espn: espnWinProbability, outcome: won };
}

/** The P(playoffs) row E13 scores (the reading in use; ESPN's `playoffPct` normalised to 0..1). */
export function pPlayoffsForecastOf(
  week: Week,
  season: Pick<SeasonSimData, "readings" | "playoff_pct_espn">,
  madePlayoffs: boolean,
): ComparatorProbability {
  return {
    week,
    ours: season.readings[0]?.p_playoffs ?? null,
    espn: season.playoff_pct_espn,
    outcome: madePlayoffs,
  };
}

/** The P(active) rows E13 scores from an E1 projection's first week (designations only). */
export function pActiveForecastsOf(
  players: readonly ProjectedPlayer[],
  week: Week,
  played: ReadonlyMap<number, boolean>,
): WeekProbability[] {
  const out: WeekProbability[] = [];
  for (const p of players) {
    const w = p.weeks.find((x) => x.week === week);
    const id = p.target.player_id;
    if (w?.p_active == null || id === null || w.p_active_basis === "none") continue;
    const outcome = played.get(id);
    if (outcome === undefined) continue;
    out.push({ week, p: w.p_active, outcome });
  }
  return out;
}

/**
 * The alternative an E2 result offers the log (E12 `alternatives[]`): keeping the current lineup —
 * the no-op every lineup change is measured against (research 05 §8.1 #7). Empty when the
 * recommendation is already no move.
 */
export function lineupAlternatives(data: LineupData): Alternative[] {
  if (data.no_move) return [];
  const starters = data.current_lineup.filter((s) => s.slot !== "BE" && s.slot !== "IR");
  const subjects: RecSubject[] = starters.map((s) => ({
    player_id: s.player_id,
    gsis_id: null,
    role: "start",
    slot: s.slot,
  }));
  const sd = sigmaOf(data.rec.distribution);
  return [
    {
      action: "keep the current lineup",
      subjects,
      point_estimate: data.e_points_before,
      distribution: normalDist(data.e_points_before, sd, data.basis),
      decision_metric_value: data.e_points_before,
    },
  ];
}

/** The alternative an E5 result offers the log: no claim this run (priority kept). */
export function waiverAlternatives(data: WaiversData): Alternative[] {
  if (data.rec.no_move) return [];
  return [
    {
      action: "make no claim and keep the waiver position",
      subjects: [],
      point_estimate: 0,
      distribution: normalDist(0, 0, "position_cv"),
      decision_metric_value: 0,
    },
  ];
}
