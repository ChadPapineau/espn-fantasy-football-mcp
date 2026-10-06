// team-defense.ts — `ds_team_defense_week` derived at load from the stats_player_week rows (tables.ts
// DS_TEAM_DEFENSE_WEEK: SUM of TEAM_DEFENSE_SUM_COLUMNS per season/week/team over the rows accepted
// into ds_stats_player_week — NULL counts 0 —, the defensive fumble-return TDs, and the opponent
// offence's passing / sack / rushing yards from the opponent's rows of the same game; plan 08 §3.2
// dst_* inputs). A team-level row (no player_id — nflverse's unattributed team credits, e.g. the BUF
// week-2 2026 safety) adds its team-defence credits only: no player count, no offence yardage (the
// sibling's QA finding, re-observed in the 2026 file here). Memory: one accumulator per team-week.
// Ported from sibling @521f9f3, adapted.
import {
  DS_TEAM_DEFENSE_WEEK,
  DST_FUMBLE_RETURN_TD_COLUMN,
  TEAM_DEFENSE_SUM_COLUMNS,
} from "../../store/datasets/tables.js";
import { asReal, asText, type RawRow } from "./rows.js";

type Value = string | number | null;

/**
 * Defensive fumble-return TDs of one player row: min(fumble_recovery_tds, fumble_recovery_opp) when
 * the player recovered an opponent's fumble (nflverse `def_tds` holds interception returns only — the
 * sibling's QA-1-017). A non-numeric or negative input counts 0.
 */
export function defensiveFumbleReturnTds(raw: RawRow): number {
  const opp = asReal(raw.fumble_recovery_opp) ?? 0;
  const tds = asReal(raw.fumble_recovery_tds) ?? 0;
  return opp > 0 && tds > 0 ? Math.min(tds, opp) : 0;
}

/** Whether a row carries any team-defence credit (what a dropped row would have contributed). */
export function hasDefenseCredit(raw: RawRow): boolean {
  return (
    TEAM_DEFENSE_SUM_COLUMNS.some((c) => (asReal(raw[c]) ?? 0) !== 0) ||
    defensiveFumbleReturnTds(raw) !== 0
  );
}

interface Acc {
  readonly season: number;
  readonly week: number;
  readonly team: string;
  season_type: string | null;
  opponent_team: string | null;
  game_id: string | null;
  readonly sums: Record<string, number>;
  pass: number;
  sackYds: number;
  rush: number;
  rows: number;
}

const key = (season: number, week: number, team: string): string =>
  `${String(season)}|${String(week)}|${team}`;

/** Accumulates accepted player rows into team-defence rows. */
export class TeamDefenseAggregator {
  private readonly groups = new Map<string, Acc>();
  private readonly conflicts = new Set<string>();

  /** Adds one accepted player row (raw upstream values; season/week/team already validated). */
  add(season: number, week: number, team: string, raw: RawRow): void {
    this.accumulate(season, week, team, raw, true);
  }

  /**
   * Adds a team-level row (no player_id): its team-defence credits count for the team; it is not a
   * player row, and its offence yardage is not the opponent's yards allowed.
   */
  addTeamRow(season: number, week: number, team: string, raw: RawRow): void {
    this.accumulate(season, week, team, raw, false);
  }

  private accumulate(
    season: number,
    week: number,
    team: string,
    raw: RawRow,
    player: boolean,
  ): void {
    const k = key(season, week, team);
    let acc = this.groups.get(k);
    if (!acc) {
      acc = {
        season,
        week,
        team,
        season_type: null,
        opponent_team: null,
        game_id: null,
        sums: Object.fromEntries(
          [...TEAM_DEFENSE_SUM_COLUMNS, DST_FUMBLE_RETURN_TD_COLUMN].map((c) => [c, 0]),
        ),
        pass: 0,
        sackYds: 0,
        rush: 0,
        rows: 0,
      };
      this.groups.set(k, acc);
    }
    if (player) acc.rows++;
    for (const f of ["season_type", "opponent_team", "game_id"] as const) {
      const v = asText(raw[f]);
      if (v === null) continue;
      if (acc[f] === null) acc[f] = v;
      else if (acc[f] !== v) this.conflicts.add(k);
    }
    for (const c of TEAM_DEFENSE_SUM_COLUMNS)
      acc.sums[c] = (acc.sums[c] ?? 0) + (asReal(raw[c]) ?? 0);
    acc.sums[DST_FUMBLE_RETURN_TD_COLUMN] =
      (acc.sums[DST_FUMBLE_RETURN_TD_COLUMN] ?? 0) + defensiveFumbleReturnTds(raw);
    if (!player) return;
    acc.pass += asReal(raw.passing_yards) ?? 0;
    acc.sackYds += asReal(raw.sack_yards_lost) ?? 0;
    acc.rush += asReal(raw.rushing_yards) ?? 0;
  }

  /** Team-weeks whose rows named more than one opponent / game id / season type. */
  get conflictCount(): number {
    return this.conflicts.size;
  }

  /**
   * The team-defence rows in DS_TEAM_DEFENSE_WEEK column order, sorted by season, week, team. The
   * opponent yardage is null when the opponent has no rows that week or played another game.
   */
  rows(): Record<string, Value>[] {
    const out: Record<string, Value>[] = [];
    const sorted = [...this.groups.values()].sort(
      (a, b) => a.season - b.season || a.week - b.week || (a.team < b.team ? -1 : 1),
    );
    for (const a of sorted) {
      const opp =
        a.opponent_team === null
          ? undefined
          : this.groups.get(key(a.season, a.week, a.opponent_team));
      const sameGame =
        opp !== undefined &&
        (a.game_id === null || opp.game_id === null || opp.game_id === a.game_id);
      const values: Record<string, Value> = {
        season: a.season,
        week: a.week,
        season_type: a.season_type,
        team: a.team,
        opponent_team: a.opponent_team,
        game_id: a.game_id,
        ...Object.fromEntries(TEAM_DEFENSE_SUM_COLUMNS.map((c) => [c, a.sums[c] ?? 0])),
        [DST_FUMBLE_RETURN_TD_COLUMN]: a.sums[DST_FUMBLE_RETURN_TD_COLUMN] ?? 0,
        opp_passing_yards: sameGame ? opp.pass : null,
        opp_sack_yards_lost: sameGame ? opp.sackYds : null,
        opp_rushing_yards: sameGame ? opp.rush : null,
        player_rows: a.rows,
      };
      const row: Record<string, Value> = {};
      for (const c of DS_TEAM_DEFENSE_WEEK.columns) row[c.name] = values[c.name] ?? null;
      out.push(row);
    }
    return out;
  }
}
