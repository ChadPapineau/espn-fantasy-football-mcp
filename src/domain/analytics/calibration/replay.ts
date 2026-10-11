// replay.ts — one held-out team-week through the shipped start/sit engine (plan 10 C2; plan 10 A11a's
// baselines; sib research 05 §3 Evaluation, §12.3; research 05 §8.4 #7): E2 (`analyzeLineup`) under
// `auto`, `mean` and `pwin` against the opponent's roster, the "start by ESPN's projection" and
// "start by last week's points" baselines (the same exact assignment, by those numbers), the
// hindsight-best legal lineup (by realised points) and the manager's lineup as played; each rule's
// starters are realised at ESPN's actual points. Where the matchup is decided by this week's points,
// the row also carries the model's P(win) of the two lineups as played (the matchup's forecast — the
// event ESPN's winProbability forecasts too) and E2's own `p_win_after` with its counterfactual
// outcome (the recommended lineup against the opponent's best-by-mean lineup, as E2 assumes) — and,
// since Stage C (changelog R6-2), both pairs' projected and realised totals and the opponent's id,
// for the margin calibration. The decision is pre-week: nobody is locked. Pure; the caller supplies
// the Dists (any model). New here.
import type { Clock } from "../../clock.js";
import type { SeedingMode } from "../../../config/schema.js";
import { slotClassOf } from "../../league/slots.js";
import type { RosterSlots } from "../../league/types.js";
import type { Dist } from "../../scoring/types.js";
import { ensure } from "../errors.js";
import { analyzeLineup, bestLineup, type LineupPlayer } from "../lineup.js";
import { round } from "../math.js";
import { diffSd, pairMoments, pWinNormal, type PairMoments, type TotalMember } from "../totals.js";
import type { LineupData, ObjectiveArg } from "../types.js";
import type { ObjectiveSwitchRecord } from "./objectiveSwitch.js";
import type { H2hPairFacts, StartSitRow, StartSitRule } from "./types.js";

/** One team-week to replay (built by the backtest harness from a recorded box score and E1). */
export interface StartSitTeamWeek {
  readonly season: number;
  readonly week: number;
  readonly team_id: number;
  readonly roster: RosterSlots;
  /** My roster with its Dists; `slot_id` = the slot each player was played in. */
  readonly players: readonly LineupPlayer[];
  /** The opponent's roster the same way, or null (no opponent). */
  readonly opponent: readonly LineupPlayer[] | null;
  /** The opponent's team id (carried into the head-to-head facts; additive, Stage C). */
  readonly opponent_id?: number;
  /** Realised points per player id (both rosters); a missing id realises 0 (did not play). */
  readonly realised: ReadonlyMap<number, number>;
  /** ESPN's weekly projection per player id (the baseline); a missing id projects 0. */
  readonly espn_projection: ReadonlyMap<number, number>;
  /** Last week's realised points per player id; null when there is no last week. */
  readonly last_week: ReadonlyMap<number, number> | null;
  /** The matchup is decided by this week's points and both rosters are complete. */
  readonly h2h: boolean;
  readonly seeding_config: { readonly mode: SeedingMode; readonly confirmed_at: string | null };
  readonly clock: Clock;
  /** The auto-default switch record E2 reads (default: the committed record). */
  readonly objective_switch?: ObjectiveSwitchRecord;
}

const point = (mean: number): Dist => ({
  mean,
  p10: mean,
  p25: mean,
  p50: mean,
  p75: mean,
  p90: mean,
  p_zero: mean === 0 ? 1 : 0,
  basis: "position_cv",
});

const finiteOr0 = (x: number | undefined): number =>
  typeof x === "number" && Number.isFinite(x) ? x : 0;

const isStartSlot = (slotId: number): boolean => {
  const c = slotClassOf(slotId);
  return c === "starter" || c === "flex";
};

const member = (p: LineupPlayer): TotalMember => ({
  player_id: p.player_id,
  position: p.position,
  pro_team_id: p.pro_team_id,
  points: p.points,
});

const keyOf = (ids: readonly number[]): string =>
  [...ids]
    .sort((a, b) => a - b)
    .map(String)
    .join(",");

const recStarters = (d: LineupData): number[] => (d.rec.lineup ?? []).map((s) => s.player_id);

/** +1 / −1 / 0 — who out-scored whom (to 0.01). */
const sign = (a: number, b: number): -1 | 0 | 1 => {
  const d = round(a - b, 2);
  return d > 0 ? 1 : d < 0 ? -1 : 0;
};

/**
 * Replays one team-week (plan 10 C2). Throws AnalyticsError `invalid_request` on an empty roster or
 * a locked player (a pre-week replay moves everyone) and on E2's own bounds.
 */
export function replayStartSit(tw: StartSitTeamWeek): StartSitRow {
  ensure(tw.players.length >= 1, "a replayed team-week needs a roster", "players");
  ensure(
    tw.players.every((p) => !p.locked) && (tw.opponent ?? []).every((p) => !p.locked),
    "a pre-week replay has no locked player",
    "players",
  );
  const opponent = tw.opponent !== null && tw.opponent.length > 0 ? tw.opponent : null;
  const real = (ids: readonly number[]): number =>
    round(
      ids.reduce((s, id) => s + finiteOr0(tw.realised.get(id)), 0),
      2,
    );
  const base = {
    roster: tw.roster,
    players: tw.players,
    opponent,
    seeding_config: tw.seeding_config,
    clock: tw.clock,
    ...(tw.objective_switch === undefined ? {} : { objective_switch: tw.objective_switch }),
  };
  const run = (objective: ObjectiveArg): LineupData => analyzeLineup({ ...base, objective });
  const auto = run("auto");
  const mean = run("mean");
  const pwin = run("pwin");
  const by = (value: (p: LineupPlayer) => number): number[] =>
    bestLineup(
      tw.roster,
      tw.players.map((p) => ({ ...p, points: point(value(p)) })),
    ).map((p) => p.player_id);
  const espn = by((p) => finiteOr0(tw.espn_projection.get(p.player_id)));
  const hindsight = by((p) => finiteOr0(tw.realised.get(p.player_id)));
  const lw = tw.last_week;
  const last = lw === null ? null : by((p) => finiteOr0(lw.get(p.player_id)));
  const manager = tw.players.filter((p) => isStartSlot(p.slot_id)).map((p) => p.player_id);
  const lineups: Record<StartSitRule, number[] | null> = {
    hindsight,
    auto: recStarters(auto),
    mean: recStarters(mean),
    pwin: recStarters(pwin),
    espn_projection: espn,
    last_week: last,
    manager,
  };
  const realised = {} as Record<StartSitRule, number | null>;
  const lineupKey = {} as Record<StartSitRule, string | null>;
  for (const [rule, ids] of Object.entries(lineups) as [StartSitRule, number[] | null][]) {
    realised[rule] = ids === null ? null : real(ids);
    lineupKey[rule] = ids === null ? null : keyOf(ids);
  }
  const autoIds = new Set(lineups.auto);
  let h2h: StartSitRow["h2h"] = null;
  if (tw.h2h && opponent !== null && auto.p_win_after !== null) {
    const oppPlayed = opponent.filter((p) => isStartSlot(p.slot_id));
    const mePlayed = tw.players.filter((p) => isStartSlot(p.slot_id));
    const oppBestPlayers = bestLineup(tw.roster, opponent);
    const meAuto = tw.players.filter((p) => autoIds.has(p.player_id));
    const oppTotal = real(oppPlayed.map((p) => p.player_id));
    const oppBest = real(oppBestPlayers.map((p) => p.player_id));
    const sPlayed = sign(realised.manager ?? 0, oppTotal);
    const sAuto = sign(realised.auto ?? 0, oppBest);
    const pmPlayed = pairMoments(mePlayed.map(member), oppPlayed.map(member));
    const facts = (pm: PairMoments, realM: number, realO: number): H2hPairFacts => ({
      mu_m: round(pm.mu_m, 6),
      mu_o: round(pm.mu_o, 6),
      sd: round(diffSd(pm), 6),
      real_m: realM,
      real_o: realO,
    });
    h2h = {
      outcome_played: sPlayed === 0 ? null : sPlayed > 0,
      p_win_played: round(pWinNormal(pmPlayed), 6),
      p_win_auto: round(auto.p_win_after, 6),
      outcome_auto: sAuto === 0 ? null : sAuto > 0,
      opponent_total: oppTotal,
      opponent_id: tw.opponent_id ?? null,
      played: facts(pmPlayed, realised.manager ?? 0, oppTotal),
      auto: facts(
        pairMoments(meAuto.map(member), oppBestPlayers.map(member)),
        realised.auto ?? 0,
        oppBest,
      ),
    };
  }
  const autoStarters = auto.recommended_lineup.filter((s) => autoIds.has(s.player_id));
  return {
    season: tw.season,
    week: tw.week,
    team_id: tw.team_id,
    objective_auto: auto.objective_used,
    basis: auto.basis,
    player_sim_share:
      autoStarters.length === 0
        ? 0
        : round(
            autoStarters.filter((s) => s.points.basis === "player_sim").length /
              autoStarters.length,
            4,
          ),
    realised,
    lineup_key: lineupKey,
    h2h,
  };
}
