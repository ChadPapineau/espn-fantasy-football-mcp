// statline.ts — `toStatLine(nflverse)` for the store's PlayerWeekReader (plan 08 §3.2 column map onto
// the §3.1 canonical names; §3.3 position class) and the team-defence (D/ST) line of
// READER_QUERIES["PlayerWeekReader.defenseLines"]. Lives in src/store because the store may not import
// src/sources (plan 01 §1.1) where plan 08 names the column table. Ported from sibling @cf3b015,
// adapted (ESPN canonical names, ESPN position ids, the D/ST family scalars dst_pa_raw / dst_ya_raw).
import {
  asPositionId,
  type Canonical,
  type PositionClass,
  type StatLine,
} from "../../domain/scoring/types.js";

/** A row as SQLite returns it. */
export type SqlRow = Readonly<Record<string, unknown>>;

/**
 * canonical ← the SUM of these ds_stats_player_week columns (present when any is non-null; a NULL
 * stat is absent from `present`). FG buckets follow the league-bound partition of plan 08 §3.1
 * ([0,39], [40,49], [50,59], [60,∞)) from nflverse's weekly bins, which coincide with it.
 * `ret_td_total`: kick/punt returns are not split without pbp (plan 08 §3.2 fallback).
 */
export const PLAYER_STAT_MAP: Readonly<Record<Canonical, readonly string[]>> = Object.freeze({
  pass_att: ["attempts"],
  pass_cmp: ["completions"],
  pass_yd: ["passing_yards"],
  pass_td: ["passing_tds"],
  pass_int: ["passing_interceptions"],
  pass_2pt: ["passing_2pt_conversions"],
  pass_1d: ["passing_first_downs"],
  sacked: ["sacks_suffered"],
  rush_att: ["carries"],
  rush_yd: ["rushing_yards"],
  rush_td: ["rushing_tds"],
  rush_2pt: ["rushing_2pt_conversions"],
  rush_1d: ["rushing_first_downs"],
  targets: ["targets"],
  rec: ["receptions"],
  rec_yd: ["receiving_yards"],
  rec_td: ["receiving_tds"],
  rec_2pt: ["receiving_2pt_conversions"],
  rec_1d: ["receiving_first_downs"],
  fum: ["sack_fumbles", "rushing_fumbles", "receiving_fumbles"],
  fum_lost: ["sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"],
  fum_rec_td_off: ["fumble_recovery_tds"],
  ret_td_total: ["special_teams_tds"],
  fg_0_39: ["fg_made_0_19", "fg_made_20_29", "fg_made_30_39"],
  fg_40_49: ["fg_made_40_49"],
  fg_50_59: ["fg_made_50_59"],
  fg_60p: ["fg_made_60_"],
  fg_made_total: ["fg_made"],
  fg_att_total: ["fg_att"],
  fg_miss_total: ["fg_missed"],
  fg_miss_0_39: ["fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39"],
  fg_miss_40_49: ["fg_missed_40_49"],
  fg_miss_50_59: ["fg_missed_50_59"],
  fg_miss_60p: ["fg_missed_60_"],
  pat_made: ["pat_made"],
  pat_att: ["pat_att"],
  pat_miss: ["pat_missed"],
});

/**
 * canonical ← the SUM of these ds_team_defense_week columns (the D/ST line, plan 08 §3.2).
 * `dst_blk` counts FG and punt blocks; PAT blocks are a league rule the store cannot see (the
 * analytics add `def_pat_blocks` when the league scores them).
 */
export const DEFENSE_STAT_MAP: Readonly<Record<Canonical, readonly string[]>> = Object.freeze({
  dst_sack: ["def_sacks"],
  dst_int: ["def_interceptions"],
  dst_ff: ["def_fumbles_forced"],
  dst_fr: ["fumble_recovery_opp"],
  dst_int_td: ["def_tds"],
  dst_fr_td: ["fumble_recovery_tds_opp"],
  dst_ret_td: ["special_teams_tds"],
  dst_safety: ["def_safeties"],
  dst_blk: ["def_fg_blocks", "def_punt_blocks"],
  dst_kr_yd: ["kickoff_return_yards"],
  dst_pr_yd: ["punt_return_yards"],
});

/** nflverse position → ESPN position id and class (plan 08 §3.3; providers/espn ESPN_POSITIONS). */
const POSITIONS: Readonly<Record<string, readonly [number, PositionClass]>> = Object.freeze({
  QB: [1, "O"],
  RB: [2, "O"],
  FB: [2, "O"],
  HB: [2, "O"],
  WR: [3, "O"],
  TE: [4, "O"],
  K: [5, "K"],
  PK: [5, "K"],
  P: [7, "K"],
  DT: [9, "IDP"],
  NT: [9, "IDP"],
  DE: [10, "IDP"],
  LB: [11, "IDP"],
  ILB: [11, "IDP"],
  OLB: [11, "IDP"],
  MLB: [11, "IDP"],
  CB: [12, "IDP"],
  DB: [13, "IDP"],
  S: [13, "IDP"],
  SS: [13, "IDP"],
  FS: [13, "IDP"],
});

/**
 * The ESPN position of an nflverse row: its `position`, else its `position_group`; an unknown one
 * (offensive line, long snapper) is position 0, class `O` — such a line scores nothing anyway.
 */
export function positionOf(
  position: unknown,
  positionGroup: unknown,
): readonly [number, PositionClass] {
  for (const p of [position, positionGroup])
    if (typeof p === "string" && Object.hasOwn(POSITIONS, p)) return POSITIONS[p] ?? [0, "O"];
  return [0, "O"];
}

/** A finite number from a SQLite value, else null. */
export function sqlNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

function build(
  row: SqlRow,
  map: Readonly<Record<Canonical, readonly string[]>>,
  extra: Readonly<Record<Canonical, number | null>>,
  position: readonly [number, PositionClass],
): StatLine {
  const values: Record<Canonical, number> = {};
  for (const [canonical, cols] of Object.entries(map)) {
    let sum: number | null = null;
    for (const c of cols) {
      const v = sqlNum(row[c]);
      if (v !== null) sum = (sum ?? 0) + v;
    }
    if (sum !== null) values[canonical] = sum;
  }
  for (const [canonical, v] of Object.entries(extra)) if (v !== null) values[canonical] = v;
  return {
    values,
    present: Object.keys(values).sort(),
    position: asPositionId(position[0]),
    position_class: position[1],
    provisional: false,
    source: "nflverse",
  };
}

/** A ds_stats_player_week row → canonical StatLine (`provisional` is set by the caller's schedule). */
export function playerRowToStatLine(row: SqlRow): StatLine {
  return build(row, PLAYER_STAT_MAP, {}, positionOf(row.position, row.position_group));
}

/**
 * A ds_team_defense_week row → the D/ST StatLine. `pointsAllowed` is the opponent's final score
 * (definition (a), plan 08 §3.2 U-6) or null when the game is not final / the schedules file is
 * absent. dst_ya_raw = opp_passing_yards − |opp_sack_yards_lost| + opp_rushing_yards ([U] ESPN's
 * definition), present only when the opponent had rows.
 */
export function defenseRowToStatLine(row: SqlRow, pointsAllowed: number | null): StatLine {
  const pass = sqlNum(row.opp_passing_yards);
  const rush = sqlNum(row.opp_rushing_yards);
  // nflverse records sack yards as negative numbers; the magnitude is subtracted either way.
  const sackYds = Math.abs(sqlNum(row.opp_sack_yards_lost) ?? 0);
  const ya = pass !== null && rush !== null ? pass - sackYds + rush : null;
  return build(row, DEFENSE_STAT_MAP, { dst_pa_raw: pointsAllowed, dst_ya_raw: ya }, [16, "DST"]);
}
