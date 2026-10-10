// history.ts — the held-out start/sit replay's door to data (plan 10 C2, C3; research 05 §8.4 #7):
// the committed previous seasons of the public probe league `league-b` (fixtures/espn/recorded/
// history/<season>/league-b, recorded keyless and scrubbed — the only league-seasons whose box
// scores carry ESPN's weekly projection beside each rostered player's actual), the league's own
// settings and roster slots that season, and the season's pro schedule. Each box score is read
// through tests/fixtures/helpers/history-fixtures.ts (the manifest's index; its hashes are held by
// tests/fixtures/history-manifest.test.ts). A team-week listed in the manifest's `incomplete` (a
// withheld roster entry) is marked incomplete and never replayed; a matchup counts head-to-head only
// when both sides are complete and each side's starters sum to its total (a two-week playoff final
// does not). Read-only; nothing is fetched. Team names are never read (only ids).
import { normalizeSettings } from "../../../../../src/domain/scoring/settings.js";
import type { ScoringSettings, StatLine } from "../../../../../src/domain/scoring/types.js";
import { statLineFromEspn } from "../../../../../src/domain/scoring/stat_map.js";
import {
  POSITION_NAMES,
  buildRosterSlots,
  slotClassOf,
} from "../../../../../src/domain/league/slots.js";
import type { ProSchedule, RosterSlots } from "../../../../../src/domain/league/types.js";
import {
  historyBody,
  historyEntries,
  historyManifest,
} from "../../../../fixtures/helpers/history-fixtures.js";
import { proScheduleFromWire, settingsInputFromWire } from "../../../league/helpers.js";

/** The probe-league slot whose previous seasons carry box scores with ESPN's projections. */
export const HISTORY_SLOT = "league-b";

/** The held-out seasons: every season whose `league-b` box scores the history manifest lists. */
export function heldOutSeasons(): readonly number[] {
  const seasons = new Set<number>();
  for (const f of historyManifest().files) {
    const m = /^recorded\/history\/(\d{4})\/league-b\/mBoxscore\.sp\d+(?:\.p\d+)?\.json$/.exec(
      f.path,
    );
    if (m) seasons.add(Number(m[1]));
  }
  return [...seasons].sort((a, b) => a - b);
}

/** One rostered player-week of a history box score. */
export interface HistoryEntry {
  readonly player_id: number;
  /** ESPN display position from `defaultPositionId`. */
  readonly position: string;
  readonly position_id: number;
  /**
   * The NFL team he belonged to that week. A history box score lists each player's team at
   * RECORDING time (2026), not that season's, so the team is read from the week's actual stat entry
   * (the team in that game); a week without one (a bye, inactive) takes his nearest earlier game's
   * team that season, else his nearest later one, else the listed team (`historySeason`).
   */
  readonly pro_team_id: number;
  /** The team of this week's game (the actual stat entry's `proTeamId`); null when he had none. */
  readonly game_pro_team_id: number | null;
  readonly eligible_slot_ids: readonly number[];
  /** The lineup slot the manager played him in. */
  readonly slot_id: number;
  /** ESPN's weekly projection under the league's S (statSourceId 1, split 1); null when absent. */
  readonly projected: number | null;
  /** ESPN's realised appliedTotal (statSourceId 0, split 1); null when absent (did not play). */
  readonly actual: number | null;
  /** The actual week's raw stats translated to a canonical line; null when absent or untranslatable. */
  readonly actual_line: StatLine | null;
}

/** One team side of a history box-score week. */
export interface HistoryTeam {
  readonly team_id: number;
  readonly opponent_id: number;
  readonly matchup_id: number;
  readonly total_points: number;
  readonly entries: readonly HistoryEntry[];
  /** No withheld entry (manifest `incomplete`). */
  readonly complete: boolean;
  /** Σ actual of the as-played starters equals `total_points` (± 0.011). */
  readonly starters_sum_total: boolean;
}

/** One scoring period of a held-out season. */
export interface HistoryWeek {
  readonly season: number;
  readonly week: number;
  readonly teams: readonly HistoryTeam[];
}

/** A held-out season: the league's settings that season and its weeks. */
export interface HistorySeason {
  readonly season: number;
  readonly settings: ScoringSettings;
  readonly roster: RosterSlots;
  readonly schedule: ProSchedule;
  readonly final_week: number;
  readonly weeks: readonly HistoryWeek[];
}

interface RawStat {
  readonly statSourceId: number;
  readonly statSplitTypeId: number;
  readonly seasonId: number;
  readonly scoringPeriodId: number;
  readonly appliedTotal?: number;
  readonly proTeamId?: number;
  readonly stats?: Readonly<Record<string, unknown>>;
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
          readonly stats?: readonly RawStat[];
        };
      };
    }[];
  };
}

const isStarterSlot = (slot: number): boolean => {
  const c = slotClassOf(slot);
  return c === "starter" || c === "flex";
};

function entryOf(
  e: RawSide["rosterForCurrentScoringPeriod"]["entries"][number],
  season: number,
  week: number,
): HistoryEntry {
  const pl = e.playerPoolEntry.player;
  const stats = pl.stats ?? [];
  const pick = (source: number): RawStat | undefined =>
    stats.find(
      (s) =>
        s.statSourceId === source &&
        s.statSplitTypeId === 1 &&
        s.seasonId === season &&
        s.scoringPeriodId === week,
    );
  const proj = pick(1);
  const act = pick(0);
  let line: StatLine | null = null;
  if (act?.stats !== undefined) {
    try {
      line = statLineFromEspn({ raw: act.stats }, pl.defaultPositionId).line;
    } catch {
      line = null;
    }
  }
  return {
    player_id: e.playerId,
    position: POSITION_NAMES[pl.defaultPositionId] ?? "OTHER",
    position_id: pl.defaultPositionId,
    pro_team_id: pl.proTeamId,
    game_pro_team_id:
      typeof act?.proTeamId === "number" && act.proTeamId > 0 ? act.proTeamId : null,
    eligible_slot_ids: pl.eligibleSlots,
    slot_id: e.lineupSlotId,
    projected: typeof proj?.appliedTotal === "number" ? proj.appliedTotal : null,
    actual: typeof act?.appliedTotal === "number" ? act.appliedTotal : null,
    actual_line: line,
  };
}

/** The week's team sides (both sides of every two-team matchup). */
export function historyWeek(season: number, week: number): HistoryWeek {
  const name = `mBoxscore.sp${String(week)}`;
  const body = historyBody(season, HISTORY_SLOT, name) as unknown as {
    readonly schedule: readonly { id: number; home: RawSide; away?: RawSide }[];
  };
  const incomplete = new Set<number>(
    historyEntries(season, HISTORY_SLOT, name).flatMap(
      (f) => (f as { incomplete?: { team_ids?: number[] } }).incomplete?.team_ids ?? [],
    ),
  );
  const teams: HistoryTeam[] = [];
  for (const m of body.schedule) {
    if (m.away === undefined) continue;
    for (const [side, other] of [
      [m.home, m.away],
      [m.away, m.home],
    ] as const) {
      const entries = side.rosterForCurrentScoringPeriod.entries.map((e) =>
        entryOf(e, season, week),
      );
      const sum = entries
        .filter((e) => isStarterSlot(e.slot_id))
        .reduce((s, e) => s + (e.actual ?? 0), 0);
      teams.push({
        team_id: side.teamId,
        opponent_id: other.teamId,
        matchup_id: m.id,
        total_points: side.totalPoints,
        entries,
        complete: !incomplete.has(side.teamId),
        starters_sum_total: Math.abs(sum - side.totalPoints) <= 0.011,
      });
    }
  }
  return { season, week, teams };
}

/** A held-out season of `league-b`: settings, slots, pro schedule, and every box-score week. */
export function historySeason(season: number): HistorySeason {
  const settingsBody = historyBody(season, HISTORY_SLOT, "mSettings") as unknown as {
    readonly settings: { readonly scoringSettings: unknown };
    readonly status?: { readonly finalScoringPeriod?: number };
  };
  const finalWeek = settingsBody.status?.finalScoringPeriod ?? 17;
  const raw: HistoryWeek[] = [];
  for (let w = 1; w <= finalWeek; w++) raw.push(historyWeek(season, w));
  // the player's team per week: this week's game, else the nearest earlier game, else the nearest later
  const games = new Map<number, Map<number, number>>();
  for (const wk of raw)
    for (const t of wk.teams)
      for (const e of t.entries)
        if (e.game_pro_team_id !== null) {
          const m = games.get(e.player_id) ?? new Map<number, number>();
          m.set(wk.week, e.game_pro_team_id);
          games.set(e.player_id, m);
        }
  const teamAt = (e: HistoryEntry, week: number): number => {
    if (e.game_pro_team_id !== null) return e.game_pro_team_id;
    const m = games.get(e.player_id);
    if (m === undefined) return e.pro_team_id;
    const weeksPlayed = [...m.keys()].sort((a, b) => a - b);
    const before = weeksPlayed.filter((w) => w < week).at(-1);
    const after = weeksPlayed.find((w) => w > week);
    const pick = before ?? after;
    return pick === undefined ? e.pro_team_id : (m.get(pick) ?? e.pro_team_id);
  };
  const weeks: HistoryWeek[] = raw.map((wk) => ({
    ...wk,
    teams: wk.teams.map((t) => ({
      ...t,
      entries: t.entries.map((e) => ({ ...e, pro_team_id: teamAt(e, wk.week) })),
    })),
  }));
  return {
    season,
    settings: normalizeSettings(settingsBody.settings.scoringSettings),
    roster: buildRosterSlots(settingsInputFromWire(settingsBody).roster).roster,
    schedule: proScheduleFromWire(historyBody(season, "season", "proTeamSchedules_wl"), season),
    final_week: finalWeek,
    weeks,
  };
}
