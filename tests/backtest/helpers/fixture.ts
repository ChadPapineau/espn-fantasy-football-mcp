// fixture.ts — the backtest harness's only door to data (plan 10 A11a/A12a; plan 05 §3 fixture law):
// recorded ESPN box scores read through the golden path guard (tests/golden/recorded.ts re-hashes
// every body against the manifest), each league's own recorded settings, the recorded 2026 pro
// schedule, and the committed nflverse `schedules` excerpt for implied totals (joined to ESPN by
// the ESPN game id). Read-only; nothing is fetched.
import { finalWeeks, LEAGUES, readRecorded, type LeagueSlot } from "../../golden/recorded.js";
import { recordedSchedule, recordedSettings } from "../../domain/league/helpers.js";
import { fixtureRows } from "../../sources/nflverse/helpers/fixtures.js";
import { POSITION_NAMES, buildRosterSlots } from "../../../src/domain/league/slots.js";
import type { ProSchedule, RosterSlots } from "../../../src/domain/league/types.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";

export { LEAGUES, type LeagueSlot };

/** One rostered player-week of a recorded box score, as the replay needs it. */
export interface ReplayEntry {
  readonly player_id: number;
  readonly position: string;
  readonly position_id: number;
  readonly pro_team_id: number;
  readonly eligible_slot_ids: readonly number[];
  readonly slot_id: number;
  /** ESPN's weekly projection under the league's S (statSourceId 1, split 1); null when absent. */
  readonly projected: number | null;
  /** ESPN's realised appliedTotal (statSourceId 0, split 1); null when absent. */
  readonly actual: number | null;
}

/** One team side of a recorded box-score week. */
export interface ReplayTeam {
  readonly league: LeagueSlot;
  readonly week: number;
  readonly matchup_id: number;
  readonly team_id: number;
  readonly opponent_id: number | null;
  readonly total_points: number;
  readonly entries: readonly ReplayEntry[];
}

interface RawStat {
  readonly statSourceId: number;
  readonly statSplitTypeId: number;
  readonly seasonId: number;
  readonly scoringPeriodId: number;
  readonly appliedTotal?: number;
}
interface RawSide {
  readonly teamId: number;
  readonly totalPoints: number;
  readonly rosterForCurrentScoringPeriod: {
    readonly entries: readonly {
      readonly lineupSlotId: number;
      readonly playerId: number;
      readonly playerPoolEntry: {
        readonly player: {
          readonly defaultPositionId: number;
          readonly proTeamId: number;
          readonly eligibleSlots: readonly number[];
          readonly stats: readonly RawStat[];
        };
      };
    }[];
  };
}

/** Every team side of one league's recorded final week (withheld matchups are absent whole). */
export function replayTeams(league: LeagueSlot, week: number): ReplayTeam[] {
  const body = readRecorded(`${league}/mBoxscore.sp${String(week)}.json`) as unknown as {
    seasonId: number;
    schedule: { id: number; home: RawSide; away?: RawSide }[];
  };
  const out: ReplayTeam[] = [];
  for (const m of body.schedule) {
    for (const side of ["home", "away"] as const) {
      const s = m[side];
      if (s === undefined) continue;
      const other = side === "home" ? m.away : m.home;
      const pick = (stats: readonly RawStat[], source: number): number | null =>
        stats.find(
          (e) =>
            e.statSourceId === source &&
            e.statSplitTypeId === 1 &&
            e.seasonId === body.seasonId &&
            e.scoringPeriodId === week,
        )?.appliedTotal ?? null;
      out.push({
        league,
        week,
        matchup_id: m.id,
        team_id: s.teamId,
        opponent_id: other?.teamId ?? null,
        total_points: s.totalPoints,
        entries: s.rosterForCurrentScoringPeriod.entries.map((e) => {
          const pl = e.playerPoolEntry.player;
          return {
            player_id: e.playerId,
            position: POSITION_NAMES[pl.defaultPositionId] ?? "OTHER",
            position_id: pl.defaultPositionId,
            pro_team_id: pl.proTeamId,
            eligible_slot_ids: pl.eligibleSlots,
            slot_id: e.lineupSlotId,
            projected: pick(pl.stats, 1),
            actual: pick(pl.stats, 0),
          };
        }),
      });
    }
  }
  return out;
}

/** A league's recorded scoring settings and roster slots. */
export function leagueOf(league: LeagueSlot): {
  readonly settings: ScoringSettings;
  readonly roster: RosterSlots;
} {
  const body = readRecorded(`${league}/mSettings.json`) as {
    settings: { scoringSettings: unknown };
  };
  return {
    settings: normalizeSettings(body.settings.scoringSettings),
    roster: buildRosterSlots(recordedSettings(league).roster).roster,
  };
}

/** The recorded final weeks of a league (≥ 3 — plan 10 A1a). */
export const weeksOf = (league: LeagueSlot): readonly number[] => finalWeeks(league);

/** The recorded 2026 pro schedule. */
export const schedule = (): ProSchedule => recordedSchedule();

/**
 * Implied team totals per (week, ESPN pro team id) from the nflverse `schedules` excerpt (2026),
 * joined by the ESPN game id: home = (total + spread) / 2, away = (total − spread) / 2 (nflverse's
 * spread is positive when the home team is favoured).
 */
export function impliedTotals(): {
  readonly week: number;
  readonly pro_team_id: number;
  readonly implied: number | null;
}[] {
  const games = new Map(schedule().games.map((g) => [g.espn_game_id, g]));
  const out: { week: number; pro_team_id: number; implied: number | null }[] = [];
  for (const r of fixtureRows("schedules/games.excerpt.json")) {
    if (r.season !== 2026 || r.game_type !== "REG") continue;
    const id = typeof r.espn === "string" ? Number(r.espn) : null;
    const g = id === null ? undefined : games.get(id);
    if (g === undefined) continue;
    const total = typeof r.total_line === "number" ? r.total_line : null;
    const spread = typeof r.spread_line === "number" ? r.spread_line : null;
    const home = total === null || spread === null ? null : (total + spread) / 2;
    const away = total === null || spread === null ? null : (total - spread) / 2;
    out.push({ week: g.week, pro_team_id: g.home_pro_team_id, implied: home });
    out.push({ week: g.week, pro_team_id: g.away_pro_team_id, implied: away });
  }
  return out;
}
