// tables.ts — the ds_* dataset-table contract for every Phase-1 dataset source (plan 01 §5.1/§5.2/§5.5
// per-source dataset files, each opened as its OWN read-only connection; plan 08 §3.2 stat columns;
// plan 10 §3.1a sources), grounded in the real 2026 nflverse parquet files read on 2026-10-06 and the
// recorded `proTeamSchedules_wl`. Ported from sibling @5302d5c, adapted (ESPN season sources, espn_id
// and ESPN game-id lookups, nflverse players fallback, no attach schema, plan 01 table names).
//
// One contract, two sides: the sources layer fills these tables (through DatasetWriter) and the
// store layer implements the domain's dataset readers over them (READER_QUERIES below).
// Columns keep the upstream's own names wherever they are stored verbatim; every other column names
// the upstream fields it is derived from and how (`derivation`, naming a function of derive.ts or
// src/sources/venues.ts). Conventions for every table:
//   - TEXT values pass through `emptyToNull` (derive.ts): "" and whitespace-only → NULL;
//   - a NOT NULL column whose source value is null makes the ROW invalid → the row is dropped and
//     counted in the SchemaReport warnings (never the whole publish), unless `row_filter` says more;
//   - ids written as text upstream (nflverse `espn_id`, `schedules.espn`) are stored as INTEGER via
//     `parseDecimalId`, so they join ESPN's numeric ids directly; a malformed id → NULL (+ warning);
//   - tables are created STRICT (ddlFor), so a type slip fails loudly at insert time.
import { createHash } from "node:crypto";
import type { DatasetSourceId, License } from "../../config/freshness.js";
import { ESPN_READ_HOST_DEFAULT } from "../../config/schema.js";
import type { UntrustedSource } from "../../domain/league/types.js";
import type { DatasetColumn, DatasetColumnType, DatasetTableSpec } from "../types.js";
import type { NewsSource } from "./derive.js";

// --- contract types (extend the store's DatasetTableSpec; every contract IS a DatasetTableSpec) -----

/** One column plus its provenance. */
export interface ContractColumn extends DatasetColumn {
  /**
   * Upstream fields read to produce it (`[name]` when verbatim). `a.b` names a nested JSON field or
   * another dataset's column (`ds_pro_schedule.espn_game_id`); `provider:x` a weather API field;
   * empty for checked-in reference data.
   */
  readonly from: readonly string[];
  /** How it is derived; null = verbatim copy of the one `from` column (after `emptyToNull` on TEXT). */
  readonly derivation: string | null;
}

/**
 * The Phase-1 dataset sources: every SOURCE_REGISTRY source of phase `1a` (plan 10 §3.1a — the two
 * keyless ESPN season views, nflverse schedules/injuries/roster_weekly/stats_player_week, the
 * nflverse players fallback of the crosswalk (research 04 §C step 2), and weather). Phase 1b adds no
 * dataset source (it is the live-league half).
 */
export const PHASE_1_DATASET_SOURCES = [
  "espn:pro_schedule",
  "espn:players",
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:players",
  "nflverse:stats_player_week",
  "weather:open_meteo",
  "weather:nws",
] as const satisfies readonly DatasetSourceId[];
/** A Phase-1 dataset source id. */
export type Phase1DatasetSourceId = (typeof PHASE_1_DATASET_SOURCES)[number];

/** A ds_* table with its provenance. Assignable to `DatasetTableSpec` (what DatasetWriter takes). */
export interface DatasetTableContract extends DatasetTableSpec {
  readonly columns: readonly ContractColumn[];
  /** The source whose dataset file holds the table. */
  readonly source: Phase1DatasetSourceId;
  /** Upstream file (release path), endpoint or reference the rows come from. */
  readonly upstream: string;
  /** `season` when the table is per-season (then `season` is in `primary_key`); null otherwise. */
  readonly season_key: "season" | null;
  /** Rows dropped or collapsed at load beyond the NOT NULL rule (counted as warnings); null = none. */
  readonly row_filter: string | null;
  readonly description: string;
}

// --- column helpers ---------------------------------------------------------------------------------

const col = (
  name: string,
  type: DatasetColumnType,
  nullable: boolean,
  from: readonly string[] = [name],
  derivation: string | null = null,
): ContractColumn =>
  Object.freeze({ name, type, nullable, from: Object.freeze([...from]), derivation });
const text = (name: string, nullable = true): ContractColumn => col(name, "TEXT", nullable);
const int = (name: string, nullable = true): ContractColumn => col(name, "INTEGER", nullable);
const real = (name: string, nullable = true): ContractColumn => col(name, "REAL", nullable);
const ints = (...names: string[]): ContractColumn[] => names.map((n) => int(n));
const reals = (...names: string[]): ContractColumn[] => names.map((n) => real(n));
const texts = (...names: string[]): ContractColumn[] => names.map((n) => text(n));
/** A text id stored as INTEGER (`parseDecimalId`). */
const decimalId = (name: string, from: string, nullable = true): ContractColumn =>
  col(
    name,
    "INTEGER",
    nullable,
    [from],
    `parseDecimalId(${from}): decimal text → positive integer; malformed → NULL (+ warning)`,
  );
/** An ESPN boolean flag stored as 0 | 1 (`boolToInt`). */
const flag = (name: string, from: string): ContractColumn =>
  col(
    name,
    "INTEGER",
    false,
    [from],
    `boolToInt(${from}): true → 1, false → 0; else the row is invalid`,
  );

const table = (t: DatasetTableContract): DatasetTableContract =>
  Object.freeze({
    ...t,
    columns: Object.freeze([...t.columns]),
    primary_key: t.primary_key ? Object.freeze([...t.primary_key]) : null,
    indexes: Object.freeze(t.indexes.map((ix) => Object.freeze([...ix]))),
  });

const RELEASES = "https://github.com/nflverse/nflverse-data/releases/download";
const ESPN_SEASON = `https://${ESPN_READ_HOST_DEFAULT}/apis/v3/games/ffl/seasons/{season}`;

// --- espn:pro_schedule ----------------------------------------------------------------------------------

/**
 * `ds_pro_schedule` — every NFL game of the season from the keyless `proTeamSchedules_wl` view
 * (research 04 §B.1.6; plan 01 §5.2). Each game is listed under BOTH teams' `proGamesByScoringPeriod`
 * (544 entries → 272 games in the 2026 recording): the source collapses them by `id`. `date_ms` is
 * ESPN's epoch-ms kickoff — zone-free, what the kickoff-relative jobs self-select from (plan 06 §2);
 * it is a placeholder ≈ 10 h before nflverse's while `start_time_tbd` (24 games in 2026; never shown).
 * Recorded 2026: 272 games, 24 TBD, 248 valid_for_locking, 63 stats_official (weeks 1–3 + 15 of 16
 * week-4 games at recording time).
 */
export const DS_PRO_SCHEDULE = table({
  name: "ds_pro_schedule",
  source: "espn:pro_schedule",
  upstream: `${ESPN_SEASON}?view=proTeamSchedules_wl (settings.proTeams[].proGamesByScoringPeriod)`,
  season_key: "season",
  row_filter:
    "the duplicate entry of each game (listed under both teams) collapses to one row by id; two entries with one id but different fields → the publish fails (schema_mismatch)",
  description: "ESPN pro schedule: kickoff (epoch ms), teams, TBD / lock / stats-official flags",
  columns: [
    col("season", "INTEGER", false, [], "the requested season (the path's {season})"),
    col(
      "espn_game_id",
      "INTEGER",
      false,
      ["id"],
      "game id (the join key to ds_schedules.espn_game_id)",
    ),
    col("week", "INTEGER", false, ["scoringPeriodId"], "verbatim (REG 1–18)"),
    col(
      "date_ms",
      "INTEGER",
      true,
      ["date"],
      "epochMs(date): non-negative safe integer, else NULL",
    ),
    flag("start_time_tbd", "startTimeTBD"),
    flag("valid_for_locking", "validForLocking"),
    flag("stats_official", "statsOfficial"),
    col("home_pro_team_id", "INTEGER", false, ["homeProTeamId"], "verbatim ESPN pro-team id"),
    col("away_pro_team_id", "INTEGER", false, ["awayProTeamId"], "verbatim ESPN pro-team id"),
  ],
  primary_key: ["season", "espn_game_id"],
  indexes: [
    ["season", "week"],
    ["season", "home_pro_team_id"],
    ["season", "away_pro_team_id"],
  ],
});

/**
 * `ds_pro_teams` — the 33 `proTeams` of the same response (32 + the free-agent pseudo-team id 0,
 * abbrev `FA`, byeWeek 0 → NULL). The id → abbrev map every other ESPN-keyed reader joins to.
 */
export const DS_PRO_TEAMS = table({
  name: "ds_pro_teams",
  source: "espn:pro_schedule",
  upstream: `${ESPN_SEASON}?view=proTeamSchedules_wl (settings.proTeams[])`,
  season_key: "season",
  row_filter: null,
  description: "ESPN pro teams: id, abbreviation (ESPN spelling: WSH, LAR), bye week",
  columns: [
    col("season", "INTEGER", false, [], "the requested season (the path's {season})"),
    col("pro_team_id", "INTEGER", false, ["id"], "verbatim (0 = free agent)"),
    text("abbrev", false),
    text("location"),
    text("name"),
    col(
      "bye_week",
      "INTEGER",
      true,
      ["byeWeek"],
      "byeWeek(byeWeek): 1–22, else NULL (FA writes 0)",
    ),
  ],
  primary_key: ["season", "pro_team_id"],
  indexes: [],
});

// --- espn:players ---------------------------------------------------------------------------------------

/**
 * `ds_players` — the ESPN player universe from the keyless `players_wl` view with root-level
 * `filterActive` (research 03 §A.2 row 20: a JSON root array) — C1's local name index and the
 * crosswalk's ESPN side (plan 07 C1; research 04 §C). Recorded 2026-10-06
 * (fixtures/espn/recorded/season/players_wl.json): 2,669 rows sorted by id, exactly research 03 §B's
 * keys plus `lastVideoDate` on 378 (not kept); 95 team units with negative ids (31 D/ST, 32 TQB,
 * 32 HC); `ownership` absent on 1 row and `lastNewsDate` on 206 (→ NULL). `players_wl` carries no
 * jersey and no team abbreviation: the abbreviation comes from ds_pro_teams (another file — a second
 * statement), the jersey stays null (src/domain/crosswalk/types.ts `EspnPlayerIdentity`).
 */
export const DS_PLAYERS = table({
  name: "ds_players",
  source: "espn:players",
  upstream: `${ESPN_SEASON}/players?view=players_wl + header x-fantasy-filter {"filterActive":{"value":true}}`,
  season_key: "season",
  row_filter: "an entry without an integer id, a fullName, a defaultPositionId or a proTeamId",
  description: "ESPN player universe: id, name, position id, pro team id, % owned",
  columns: [
    col("season", "INTEGER", false, [], "the requested season (the path's {season})"),
    col(
      "espn_id",
      "INTEGER",
      false,
      ["id"],
      "verbatim (a person id is positive; D/ST, TQB and HC units are negative)",
    ),
    col("full_name", "TEXT", false, ["fullName"], "verbatim fullName (renamed)"),
    col("first_name", "TEXT", true, ["firstName"], "verbatim firstName (renamed)"),
    col("last_name", "TEXT", true, ["lastName"], "verbatim lastName (renamed)"),
    col(
      "position_id",
      "INTEGER",
      false,
      ["defaultPositionId"],
      "verbatim ESPN POSITION id (not a slot id)",
    ),
    col("pro_team_id", "INTEGER", false, ["proTeamId"], "verbatim (0 = free agent)"),
    col(
      "eligible_slots",
      "TEXT",
      true,
      ["eligibleSlots"],
      "JSON.stringify of the integer slot-id array; NULL when absent or not an integer array",
    ),
    col(
      "percent_owned",
      "REAL",
      true,
      ["ownership.percentOwned"],
      "finite number 0–100, else NULL",
    ),
    col("droppable", "INTEGER", true, ["droppable"], "boolToInt(droppable)"),
    col("last_news_date_ms", "INTEGER", true, ["lastNewsDate"], "epochMs(lastNewsDate)"),
  ],
  primary_key: ["season", "espn_id"],
  indexes: [
    ["espn_id", "season"],
    ["season", "pro_team_id"],
    ["season", "position_id"],
  ],
});

// --- nflverse:schedules ------------------------------------------------------------------------------

/**
 * `ds_schedules` — every game of the covered seasons from `schedules/games.parquet` (ONE file for all
 * seasons 1999–; the source keeps `season ∈ ctx.seasons`). Observed 2026-10-06: 7,548 rows (272 in
 * 2026, all REG), 46 columns, SNAPPY; `espn` filled on every row and decimal (272/272 of 2026 match
 * the recorded ESPN pro schedule) but NOT unique across seasons (duplicates in 2003–2010 only), so it
 * is indexed, never a key. 2026: lines on 79 games, scores on 64, `temp`/`wind` on 45, `roof = ""`
 * on 34, `gametime` null on 259 games of 1999 only.
 */
export const DS_SCHEDULES = table({
  name: "ds_schedules",
  source: "nflverse:schedules",
  upstream: `${RELEASES}/schedules/games.parquet`,
  season_key: "season",
  row_filter: "season not in ctx.seasons",
  description:
    "NFL games: kickoff, teams, score, rest, betting lines, roof/surface, venue, ESPN id",
  columns: [
    text("game_id", false),
    int("season", false),
    text("game_type", false), // REG | WC | DIV | CON | SB
    int("week", false), // nflverse numbering: REG 1–18, postseason continues 19–22
    decimalId("espn_game_id", "espn"),
    text("gameday", false), // YYYY-MM-DD, Eastern date
    text("weekday"),
    text("gametime"), // HH:MM Eastern
    col(
      "kickoff_utc",
      "TEXT",
      true,
      ["gameday", "gametime"],
      "kickoffUtcFromEastern(gameday, gametime): America/New_York wall time → UTC ISO-8601 (DST-aware); null when gametime is null/malformed",
    ),
    text("away_team", false),
    text("home_team", false),
    ...ints("away_score", "home_score"), // null until final
    text("location"), // Home | Neutral
    ...ints("result", "total", "overtime", "away_rest", "home_rest"),
    ...ints("away_moneyline", "home_moneyline"),
    real("spread_line"), // + = home favoured (nflverse dictionary)
    ...ints("away_spread_odds", "home_spread_odds"),
    real("total_line"),
    ...ints("under_odds", "over_odds", "div_game"),
    col(
      "roof",
      "TEXT",
      true,
      ["roof"],
      'normalizeRoof(roof): "" (retractable, state unknown) → NULL; lower-cased',
    ),
    text("surface"),
    ...ints("temp", "wind"), // post-game actuals for outdoor/open games only — never a forecast
    text("stadium_id"), // verbatim nflverse id — NOT always the real venue (see venue_id)
    text("stadium"), // raw stadium name (third-party text; wrapped on output)
    col(
      "venue_id",
      "TEXT",
      true,
      ["game_id", "stadium_id", "stadium"],
      "resolveVenueId(game_id, stadium_id, stadium) from src/sources/venues.ts: per-game override → unique stadium-name match → stadium_id; null when unknown. nflverse mis-codes the 2026 London JAX home game (stadium_id JAX00, stadium 'Tottenham Hotspur Stadium') and files 2025's international games under the home team's stadium",
    ),
  ],
  primary_key: ["season", "game_id"],
  indexes: [["season", "week"], ["season", "home_team"], ["season", "away_team"], ["espn_game_id"]],
});

/**
 * `ds_venues` — the checked-in stadium reference (src/sources/venues.ts VENUES), written into the
 * schedules dataset file on every schedules publish so `ds_schedules.venue_id` joins inside one file.
 */
export const DS_VENUES = table({
  name: "ds_venues",
  source: "nflverse:schedules",
  upstream: "src/sources/venues.ts (checked-in reference)",
  season_key: null,
  row_filter: null,
  description: "Venue reference: IANA zone, coordinates, default roof",
  columns: [
    col("stadium_id", "TEXT", false, [], "VenueReference.stadium_id (checked-in reference)"),
    col("name", "TEXT", false, [], "VenueReference.name (checked-in reference)"),
    col("tz", "TEXT", false, [], "VenueReference.tz (checked-in reference)"),
    col("lat", "REAL", false, [], "VenueReference.lat (checked-in reference)"),
    col("lon", "REAL", false, [], "VenueReference.lon (checked-in reference)"),
    col(
      "roof_default",
      "TEXT",
      false,
      [],
      "VenueReference.roof_default: outdoors | dome | closed | open",
    ),
    col("retractable", "INTEGER", false, [], "VenueReference.retractable → 0 | 1"),
    col("country", "TEXT", false, [], "VenueReference.country: ISO 3166-1 alpha-2"),
  ],
  primary_key: ["stadium_id"],
  indexes: [],
});

// --- nflverse:injuries --------------------------------------------------------------------------------

/**
 * `ds_injuries` — official injury + practice reports, `injuries/injuries_{season}.parquet`. Observed
 * 2026-10-06: 1,052 rows, weeks 1–4, 16 columns, SNAPPY, no duplicate (season, week, gsis_id); NO
 * timestamp or per-day practice column (one `practice_status` per player-week; `report_status` null
 * on 629 practice-only rows) — `as_of` is the release stamp.
 */
export const DS_INJURIES = table({
  name: "ds_injuries",
  source: "nflverse:injuries",
  upstream: `${RELEASES}/injuries/injuries_{season}.parquet`,
  season_key: "season",
  row_filter: "gsis_id null/empty",
  description: "Official injury report status and practice participation per player-week",
  columns: [
    int("season", false),
    text("game_type", false),
    int("week", false),
    text("team", false),
    text("gsis_id", false),
    ...texts("position", "full_name"),
    ...texts("report_primary_injury", "report_secondary_injury", "report_status"),
    ...texts("practice_primary_injury", "practice_secondary_injury", "practice_status"),
  ],
  primary_key: ["season", "week", "gsis_id", "team"],
  indexes: [["gsis_id", "season", "week"]],
});

// --- nflverse:roster_weekly ---------------------------------------------------------------------------

/**
 * `ds_roster_weekly` — weekly rosters + cross-platform ids, the crosswalk's source (research 04 §C:
 * `espn_id` is a LOOKUP), `weekly_rosters/roster_weekly_{season}.parquet`. Observed 2026-10-06:
 * 10,612 rows, weeks 1–4, 36 columns, SNAPPY; `espn_id` decimal text on 7,760 rows (2,083 distinct,
 * each with ONE gsis_id and vice versa), 442/445 week-4 ACT QB/RB/WR/TE; 5 rows with null gsis_id
 * (dropped). `yahoo_id` is not kept (the Yahoo platform is out of scope here).
 */
export const DS_ROSTER_WEEKLY = table({
  name: "ds_roster_weekly",
  source: "nflverse:roster_weekly",
  upstream: `${RELEASES}/weekly_rosters/roster_weekly_{season}.parquet`,
  season_key: "season",
  row_filter: "gsis_id null/empty",
  description: "Weekly NFL rosters with gsis_id and the ESPN / Sleeper / PFR ids",
  columns: [
    int("season", false),
    int("week", false),
    text("game_type", false),
    text("team", false),
    text("gsis_id", false),
    decimalId("espn_id", "espn_id"),
    text("full_name", false),
    ...texts("first_name", "last_name", "football_name"),
    ...texts("position", "depth_chart_position"),
    int("jersey_number"),
    ...texts("status", "status_description_abbr"), // ACT DEV RES RET EXE CUT INA
    col(
      "birth_date",
      "TEXT",
      true,
      ["birth_date"],
      "isoDate(birth_date): parquet DATE → YYYY-MM-DD",
    ),
    ...texts("sleeper_id", "pfr_id", "sportradar_id", "rotowire_id", "pff_id"),
    ...texts("fantasy_data_id", "esb_id", "smart_id"),
    ...ints("years_exp", "entry_year", "rookie_year", "draft_number"),
    text("draft_club"),
  ],
  primary_key: ["season", "week", "gsis_id"],
  indexes: [
    ["season", "gsis_id", "week"],
    ["season", "team", "position"],
    ["espn_id", "season", "week"],
    ["sleeper_id"],
  ],
});

// --- nflverse:players ------------------------------------------------------------------------------------

/**
 * `ds_nfl_players` — the nflverse players table, the crosswalk's fallback for an ESPN id absent from
 * the season's roster_weekly (research 04 §C step 2: free agents, retired / inactive players still on
 * IR), `players/players.parquet`. Observed 2026-10-06: 24,844 rows, 39 columns, SNAPPY; `espn_id`
 * decimal text on 16,578 rows, unique; 6,079 rows carry a legacy non-GSIS id (`ABC123456` form) in
 * `gsis_id` — dropped (no nflverse stats row can join them); `jersey_number` is TEXT here (INT32 in
 * roster_weekly). One gsis_id's `espn_id` disagrees with roster_weekly's (roster_weekly wins: it is
 * step 1 of the precedence).
 */
export const DS_NFL_PLAYERS = table({
  name: "ds_nfl_players",
  source: "nflverse:players",
  upstream: `${RELEASES}/players/players.parquet`,
  season_key: null,
  row_filter: "gsis_id null/empty or not GSIS_ID_RE (00-0012345)",
  description: "nflverse player directory: gsis_id ↔ espn_id for players outside the season roster",
  columns: [
    text("gsis_id", false),
    decimalId("espn_id", "espn_id"),
    text("display_name", false),
    ...texts("first_name", "last_name", "football_name", "suffix"),
    ...texts("position", "position_group", "latest_team", "status"),
    col(
      "jersey_number",
      "INTEGER",
      true,
      ["jersey_number"],
      "jerseyNumber(jersey_number): text 0–99 → integer, else NULL",
    ),
    col(
      "birth_date",
      "TEXT",
      true,
      ["birth_date"],
      "isoDate(birth_date): YYYY-MM-DD text, validated",
    ),
    ...ints("rookie_season", "last_season", "years_of_experience"),
    text("pfr_id"),
  ],
  primary_key: ["gsis_id"],
  indexes: [["espn_id"]],
});

// --- nflverse:stats_player_week ------------------------------------------------------------------------

/**
 * The stat columns of `ds_stats_player_week`, verbatim nflverse names — exactly what plan 08 §3.2's
 * `toStatLine(nflverse)` reads, plus the usage fields of `PlayerWeekLine.usage` and nflverse's own
 * fantasy points (a cross-check only). `fg_*_list` are `;`-separated kick distances ("51;43") — the
 * path to a league's own FG-distance brackets (plan 08 §4.1) without pbp.
 */
export const PLAYER_WEEK_STAT_COLUMNS: readonly ContractColumn[] = Object.freeze([
  ...ints("completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions"),
  ...ints("sacks_suffered", "sack_yards_lost", "sack_fumbles", "sack_fumbles_lost"),
  ...ints("passing_air_yards", "passing_first_downs", "passing_2pt_conversions"),
  ...ints("carries", "rushing_yards", "rushing_tds", "rushing_fumbles", "rushing_fumbles_lost"),
  ...ints("rushing_first_downs", "rushing_2pt_conversions"),
  ...ints("receptions", "targets", "receiving_yards", "receiving_tds"),
  ...ints("receiving_fumbles", "receiving_fumbles_lost", "receiving_air_yards"),
  ...ints("receiving_yards_after_catch", "receiving_first_downs", "receiving_2pt_conversions"),
  ...reals("racr", "target_share", "air_yards_share", "wopr"),
  ...ints("special_teams_tds", "fumble_recovery_own", "fumble_recovery_tds"),
  ...ints("punt_return_yards", "kickoff_return_yards"),
  ...ints("fg_made", "fg_att", "fg_missed", "fg_blocked", "fg_long"),
  ...ints("fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49"),
  ...ints("fg_made_50_59", "fg_made_60_"),
  ...ints("fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39", "fg_missed_40_49"),
  ...ints("fg_missed_50_59", "fg_missed_60_"),
  ...texts("fg_made_list", "fg_missed_list", "fg_blocked_list"),
  ...ints("pat_made", "pat_att", "pat_missed", "pat_blocked"),
  ...reals("fantasy_points", "fantasy_points_ppr"),
]);

/**
 * `ds_stats_player_week` — one row per player-week, `stats_player/stats_player_week_{season}.parquet`.
 * Observed 2026-10-06: 4,449 rows, weeks 1–4, 150 columns, SNAPPY; 4 rows with null player_id
 * (all-null team placeholders, dropped); every team-week has ONE game_id. Every position is kept
 * (IDP rows too) — the reader filters.
 */
export const DS_STATS_PLAYER_WEEK = table({
  name: "ds_stats_player_week",
  source: "nflverse:stats_player_week",
  upstream: `${RELEASES}/stats_player/stats_player_week_{season}.parquet`,
  season_key: "season",
  row_filter: "player_id null/empty",
  description: "Weekly player stat lines (offence, kicking, usage shares)",
  columns: [
    text("player_id", false), // = gsis_id
    ...texts("player_display_name", "position", "position_group"),
    int("season", false),
    int("week", false),
    text("season_type", false), // REG | POST
    text("game_id"),
    text("team", false),
    text("opponent_team"),
    ...PLAYER_WEEK_STAT_COLUMNS,
  ],
  primary_key: ["season", "week", "player_id"],
  indexes: [
    ["player_id", "season", "week"],
    ["season", "week", "team"],
  ],
});

/** Player columns summed into a team-defence row (verbatim names, summed per team-week). */
export const TEAM_DEFENSE_SUM_COLUMNS = Object.freeze([
  "def_sacks",
  "def_interceptions",
  "def_fumbles_forced",
  "fumble_recovery_opp",
  "def_tds",
  "special_teams_tds",
  "def_safeties",
  "def_fg_blocks",
  "def_punt_blocks",
  "def_pat_blocks",
  "punt_return_yards",
  "kickoff_return_yards",
] as const);

/** The derived defensive fumble-return-TD column of ds_team_defense_week. */
export const DST_FUMBLE_RETURN_TD_COLUMN = "fumble_recovery_tds_opp";

/**
 * `ds_team_defense_week` — the team-defence (D/ST) week DERIVED at load from the same
 * stats_player_week file: `SUM(col) GROUP BY season, week, team` over ALL of the file's player rows
 * (IDP and returners included), plus the opponent offence's yardage from the opponent team's rows of
 * the same game. Points allowed are NOT here: they come from `ds_schedules` scores (the schedules
 * file). Chosen over `stats_team_week` because that source is Phase 2 in SOURCE_REGISTRY; its
 * agreement with stats_team_week is [U] until Phase 2 cross-checks it.
 */
export const DS_TEAM_DEFENSE_WEEK = table({
  name: "ds_team_defense_week",
  source: "nflverse:stats_player_week",
  upstream: `${RELEASES}/stats_player/stats_player_week_{season}.parquet`,
  season_key: "season",
  row_filter:
    "none: every row of the file is aggregated by team, including the team-level rows with no player_id (one holds a team-credited safety); those add defence stats only, never opponent yardage",
  description: "Team-defence week lines aggregated from player rows",
  columns: [
    int("season", false),
    int("week", false),
    text("season_type", false),
    text("team", false),
    col(
      "opponent_team",
      "TEXT",
      true,
      ["opponent_team"],
      "the team's (single) opponent_team for the week",
    ),
    col("game_id", "TEXT", true, ["game_id"], "the team's (single) game_id for the week"),
    col("def_sacks", "REAL", false, ["def_sacks"], "SUM over the team's rows (half sacks → REAL)"),
    ...TEAM_DEFENSE_SUM_COLUMNS.filter((c) => c !== "def_sacks").map((c) =>
      col(c, "INTEGER", false, [c], "SUM over the team's rows (NULL counts 0)"),
    ),
    col(
      DST_FUMBLE_RETURN_TD_COLUMN,
      "INTEGER",
      false,
      ["fumble_recovery_tds", "fumble_recovery_opp"],
      "SUM over the team's rows of min(fumble_recovery_tds, fumble_recovery_opp) when fumble_recovery_opp > 0: defensive fumble-return TDs (nflverse def_tds holds interception returns only — the sibling's QA-1-017)",
    ),
    col(
      "opp_passing_yards",
      "INTEGER",
      true,
      ["passing_yards", "opponent_team", "game_id"],
      "SUM(passing_yards) over the opponent's rows in the same game (gross, before sacks); null when the opponent has no rows",
    ),
    col(
      "opp_sack_yards_lost",
      "INTEGER",
      true,
      ["sack_yards_lost", "opponent_team", "game_id"],
      "SUM(sack_yards_lost) over the opponent's rows in the same game",
    ),
    col(
      "opp_rushing_yards",
      "INTEGER",
      true,
      ["rushing_yards", "opponent_team", "game_id"],
      "SUM(rushing_yards) over the opponent's rows in the same game",
    ),
    col(
      "player_rows",
      "INTEGER",
      false,
      ["player_id"],
      "COUNT of the team's player rows aggregated",
    ),
  ],
  primary_key: ["season", "week", "team"],
  indexes: [["season", "week", "opponent_team"]],
});

// --- weather:open_meteo / weather:nws ------------------------------------------------------------------

/**
 * The weather tables' shared column list. One row per upcoming game at an outdoor venue (plan 01
 * §5.2: only the coming week's outdoor games), the forecast hour that contains kickoff. The weather
 * source is driven by the ESPN pro schedule (src/sources/source.ts `SourceContext.datasets`): the
 * game's nflverse `game_id` is DERIVED (`nflverseGameId`, verified 272/272), so `WeatherReader`
 * looks rows up by the same id as `NflGame.game_id`; the venue is `venueForGame` (src/sources/
 * venues.ts — the neutral-site override, else the home team's stadium). `precip_prob` is a FRACTION
 * 0–1 (providers send percent; divide by 100). Units: °F, mph.
 */
const WEATHER_COLUMNS = (provider: string): ContractColumn[] => [
  col(
    "game_id",
    "TEXT",
    false,
    [
      "ds_pro_schedule.season",
      "ds_pro_schedule.week",
      "ds_pro_schedule.away_pro_team_id",
      "ds_pro_schedule.home_pro_team_id",
      "ds_pro_teams.abbrev",
    ],
    "nflverseGameId(season, week, espnAbbrevToNflverse(away abbrev), espnAbbrevToNflverse(home abbrev))",
  ),
  col("espn_game_id", "INTEGER", false, ["ds_pro_schedule.espn_game_id"], "copied from the game"),
  col("season", "INTEGER", false, ["ds_pro_schedule.season"], "copied from the game"),
  col("week", "INTEGER", false, ["ds_pro_schedule.week"], "copied from the game"),
  col(
    "venue_id",
    "TEXT",
    false,
    ["ds_pro_schedule.home_pro_team_id", "ds_pro_teams.abbrev"],
    "venueForGame(game_id, home team) from src/sources/venues.ts",
  ),
  col("lat", "REAL", false, ["ds_venues.lat"], "the venue coordinates queried"),
  col("lon", "REAL", false, ["ds_venues.lon"], "the venue coordinates queried"),
  col(
    "kickoff_utc",
    "TEXT",
    false,
    ["ds_pro_schedule.date_ms"],
    "epochMsToIso(date_ms); games with start_time_tbd are skipped (no forecast for a placeholder time)",
  ),
  col(
    "forecast_hour_utc",
    "TEXT",
    false,
    [`${provider}:time`],
    "the forecast hour containing kickoff, UTC ISO",
  ),
  col("temp_f", "REAL", true, [`${provider}:temperature`], "°F"),
  col("wind_mph", "REAL", true, [`${provider}:wind_speed`], "mph (10 m)"),
  col(
    "gust_mph",
    "REAL",
    true,
    [`${provider}:wind_gusts`],
    "mph; null when the provider omits gusts",
  ),
  col(
    "precip_prob",
    "REAL",
    true,
    [`${provider}:precipitation_probability`],
    "percent / 100 → 0..1",
  ),
  col(
    "as_of",
    "TEXT",
    false,
    [`${provider}:update_time`],
    "the provider's forecast issue time when it states one (NWS `updateTime`), else the fetch instant from the injected Clock",
  ),
];

/** `ds_weather_open_meteo` — Open-Meteo hourly forecast (research 04 §B.7; non-commercial). */
export const DS_WEATHER_OPEN_METEO = table({
  name: "ds_weather_open_meteo",
  source: "weather:open_meteo",
  upstream:
    "https://api.open-meteo.com/v1/forecast (hourly; temperature_unit=fahrenheit, wind_speed_unit=mph)",
  season_key: null,
  row_filter: "games not in the coming week, with start_time_tbd, or at a dome/closed venue",
  description: "Kickoff-hour forecast per upcoming outdoor game (Open-Meteo)",
  columns: WEATHER_COLUMNS("open_meteo"),
  primary_key: ["game_id"],
  indexes: [["season", "week"], ["espn_game_id"]],
});

/** `ds_weather_nws` — NWS gridpoint hourly forecast (research 04 §B.7; US venues only). */
export const DS_WEATHER_NWS = table({
  name: "ds_weather_nws",
  source: "weather:nws",
  upstream: "https://api.weather.gov/points/{lat},{lon} → forecastHourly",
  season_key: null,
  row_filter:
    "games not in the coming week, with start_time_tbd, at a dome/closed venue, or outside the US",
  description: "Kickoff-hour forecast per upcoming outdoor US game (NWS)",
  columns: WEATHER_COLUMNS("nws"),
  primary_key: ["game_id"],
  indexes: [["season", "week"], ["espn_game_id"]],
});

// --- the registry ---------------------------------------------------------------------------------------

/** Every Phase-1 ds_* table, by the source whose dataset file holds it. */
export const DATASET_TABLES: Readonly<
  Record<Phase1DatasetSourceId, readonly DatasetTableContract[]>
> = Object.freeze({
  "espn:pro_schedule": Object.freeze([DS_PRO_SCHEDULE, DS_PRO_TEAMS]),
  "espn:players": Object.freeze([DS_PLAYERS]),
  "nflverse:schedules": Object.freeze([DS_SCHEDULES, DS_VENUES]),
  "nflverse:injuries": Object.freeze([DS_INJURIES]),
  "nflverse:roster_weekly": Object.freeze([DS_ROSTER_WEEKLY]),
  "nflverse:players": Object.freeze([DS_NFL_PLAYERS]),
  "nflverse:stats_player_week": Object.freeze([DS_STATS_PLAYER_WEEK, DS_TEAM_DEFENSE_WEEK]),
  "weather:open_meteo": Object.freeze([DS_WEATHER_OPEN_METEO]),
  "weather:nws": Object.freeze([DS_WEATHER_NWS]),
});

/** Every Phase-1 table, flat. */
export const ALL_DATASET_TABLES: readonly DatasetTableContract[] = Object.freeze(
  PHASE_1_DATASET_SOURCES.flatMap((s) => DATASET_TABLES[s]),
);

/** Whether `s` is a Phase-1 dataset source id. */
export function isPhase1DatasetSource(s: string): s is Phase1DatasetSourceId {
  return (PHASE_1_DATASET_SOURCES as readonly string[]).includes(s);
}

/** The tables a source publishes; empty for a source with no Phase-1 tables. */
export function tablesFor(source: DatasetSourceId): readonly DatasetTableContract[] {
  return isPhase1DatasetSource(source) ? DATASET_TABLES[source] : [];
}

/** The nflverse parquet sources: the ones whose `assertSchema` checks a column set and a codec. */
export const PARQUET_SOURCES = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:players",
  "nflverse:stats_player_week",
] as const satisfies readonly Phase1DatasetSourceId[];

/**
 * The upstream parquet columns a parquet source's `assertSchema` must require (plan 01 §5.5: a
 * missing or renamed column fails the job): the union of every `from` of its tables, excluding
 * reference and cross-dataset inputs (`a.b`, `provider:x`). Sorted, unique. Non-parquet sources
 * (the ESPN JSON views, weather) return [] — their wire checks live in the source.
 */
export function requiredUpstreamColumns(source: DatasetSourceId): readonly string[] {
  if (!(PARQUET_SOURCES as readonly string[]).includes(source)) return [];
  const out = new Set<string>();
  for (const t of tablesFor(source)) {
    for (const c of t.columns) {
      for (const f of c.from) if (!f.includes(".") && !f.includes(":")) out.add(f);
    }
  }
  return [...out].sort();
}

/**
 * The `ds_schema` fingerprint of a source's tables (store/types.ts `PublishStats.columns_hash`;
 * plan 03 §7: a dataset-table change makes the next refresh write a new file): sha256 hex of the
 * sorted `table.column type NULL|NOT NULL` lines (a source with no Phase-1 tables → sha256 of "").
 */
export function columnsHash(source: DatasetSourceId): string {
  return columnsHashOf(tablesFor(source));
}

/** `columnsHash` over any table specs (order-independent: the lines are sorted). */
export function columnsHashOf(tables: readonly DatasetTableSpec[]): string {
  const lines = tables.flatMap((t) =>
    t.columns.map((c) => `${t.name}.${c.name} ${c.type} ${c.nullable ? "NULL" : "NOT NULL"}`),
  );
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}

// --- DDL -------------------------------------------------------------------------------------------------

/** Identifier grammar for table and column names (lowercase snake; nflverse's `fg_made_60_` fits). */
export const DATASET_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** Validates and double-quotes one identifier; throws on anything outside DATASET_IDENTIFIER_RE. */
export function quoteIdentifier(id: string): string {
  if (!DATASET_IDENTIFIER_RE.test(id))
    throw new Error(`dataset contract: invalid identifier ${JSON.stringify(id)}`);
  return `"${id}"`;
}

/**
 * CREATE TABLE (STRICT) + CREATE INDEX statements for one table, run by the publisher on the fresh
 * staging file (its `main` schema — no attach, plan 01 §5.5). Every identifier is validated against
 * DATASET_IDENTIFIER_RE and double-quoted; a spec that names an unknown PK/index column, repeats a
 * column, has no column, or uses an unknown type throws. Index names are `<table>__<col>__<col>`.
 */
export function ddlFor(spec: DatasetTableSpec): readonly string[] {
  if (spec.columns.length === 0) throw new Error(`dataset contract: ${spec.name} has no columns`);
  const names = new Set<string>();
  const cols = spec.columns.map((c) => {
    if (names.has(c.name))
      throw new Error(`dataset contract: duplicate column ${c.name} in ${spec.name}`);
    if (!["TEXT", "INTEGER", "REAL", "BLOB"].includes(c.type))
      throw new Error(`dataset contract: bad type for ${c.name} in ${spec.name}`);
    names.add(c.name);
    return `${quoteIdentifier(c.name)} ${c.type}${c.nullable ? "" : " NOT NULL"}`;
  });
  const known = (c: string): string => {
    if (!names.has(c)) throw new Error(`dataset contract: ${spec.name} has no column ${c}`);
    return quoteIdentifier(c);
  };
  const tbl = quoteIdentifier(spec.name);
  const pk = spec.primary_key ? [`PRIMARY KEY (${spec.primary_key.map(known).join(", ")})`] : [];
  const out = [`CREATE TABLE ${tbl} (${[...cols, ...pk].join(", ")}) STRICT`];
  for (const ix of spec.indexes) {
    if (ix.length === 0) throw new Error(`dataset contract: empty index on ${spec.name}`);
    const cs = ix.map(known).join(", ");
    out.push(`CREATE INDEX ${quoteIdentifier(`${spec.name}__${ix.join("__")}`)} ON ${tbl} (${cs})`);
  }
  return out;
}

// --- reader queries: the SQL each domain reader method runs (store implements; plan 01 §5.5) ------------

/**
 * One statement a reader runs on ONE dataset file's own read-only connection (no attach — plan 01
 * §5.5, ADV OBJ-22). List parameters are JSON arrays bound as TEXT and expanded with `json_each`, so
 * the SQL text is fixed and no caller value is ever spliced into it. A method that needs two files
 * runs two statements and joins in code; a missing file skips its statement (the stamp says so).
 */
export interface ReaderStatement {
  readonly source: Phase1DatasetSourceId;
  readonly tables: readonly string[];
  /** Named parameters (`:name`) the statement binds. */
  readonly params: readonly string[];
  readonly sql: string;
}

/** A reader method's contract: statements plus how rows map onto the domain type. */
export interface ReaderContract {
  /** `Interface.method` in src/domain (analytics/types.ts, crosswalk/types.ts). */
  readonly method: string;
  /** The domain row type it returns. */
  readonly returns: string;
  readonly statements: readonly ReaderStatement[];
  /** Mapping rules the store applies to each row (third-party text is wrapped per its tag). */
  readonly mapping: string;
}

const stmt = (
  source: Phase1DatasetSourceId,
  tables: readonly string[],
  params: readonly string[],
  sql: string,
): ReaderStatement =>
  Object.freeze({
    source,
    tables: Object.freeze([...tables]),
    params: Object.freeze([...params]),
    sql,
  });

const reader = (r: ReaderContract): ReaderContract =>
  Object.freeze({ ...r, statements: Object.freeze([...r.statements]) });

const GAMES_SELECT = `SELECT s.*, v.tz AS venue_tz, v.roof_default AS venue_roof_default
FROM ds_schedules AS s LEFT JOIN ds_venues AS v ON v.stadium_id = s.venue_id`;

const NFL_GAME_MAPPING =
  "game_id, espn_game_id, season, week as-is; kickoff ← kickoff_utc; away/home ← away_team/home_team (rows with a non-NflTeam abbreviation are skipped and warned); roof ← COALESCE(roof, venue_roof_default); surface as-is; stadium ← wrapUntrustedOrNull(stadium, 'nflverse.schedules.stadium'); divisional ← div_game = 1 (null → null); rest_days ← away_rest/home_rest; lines ← null when spread_line, total_line and both moneylines are all null, else { spread_line, total_line, implied: impliedPoints(spread_line, total_line), moneyline: away/home_moneyline, as_of: stamp.as_of }; is_final ← away_score AND home_score non-null ([U] nflverse fills scores only at final); score ← both scores when final, else null";

/** Every reader method of the Phase-1 dataset ports, keyed `Interface.method`. */
export const READER_QUERIES = Object.freeze({
  /** ProScheduleReader.games(season, weeks | null) — ds_pro_schedule. */
  "ProScheduleReader.games": reader({
    method: "ProScheduleReader.games",
    returns: "ProGame",
    statements: [
      stmt(
        "espn:pro_schedule",
        ["ds_pro_schedule"],
        ["season", "weeks"],
        `SELECT * FROM ds_pro_schedule
WHERE season = :season AND (:weeks IS NULL OR week IN (SELECT value FROM json_each(:weeks)))
ORDER BY date_ms IS NULL, date_ms, espn_game_id`,
      ),
    ],
    mapping:
      "espn_game_id, season, week, home_pro_team_id, away_pro_team_id as-is; kickoff ← epochMsToIso(date_ms) (kept when start_time_tbd — the consumer never displays it, plan 07 D3); start_time_tbd, valid_for_locking, stats_official ← = 1; `weeks = NULL` means every week",
  }),
  /** ProScheduleReader.teams(season) — ds_pro_teams. */
  "ProScheduleReader.teams": reader({
    method: "ProScheduleReader.teams",
    returns: "ProTeam",
    statements: [
      stmt(
        "espn:pro_schedule",
        ["ds_pro_teams"],
        ["season"],
        `SELECT * FROM ds_pro_teams WHERE season = :season ORDER BY pro_team_id`,
      ),
    ],
    mapping: "id ← pro_team_id; abbrev as-is (ESPN spelling); bye_week as-is (FA → null)",
  }),
  /** NflGamesReader.games(season, weeks) — ds_schedules LEFT JOIN ds_venues (both in one file). */
  "NflGamesReader.games": reader({
    method: "NflGamesReader.games",
    returns: "NflGame",
    statements: [
      stmt(
        "nflverse:schedules",
        ["ds_schedules", "ds_venues"],
        ["season", "weeks"],
        `${GAMES_SELECT}
WHERE s.season = :season AND s.week IN (SELECT value FROM json_each(:weeks))
ORDER BY s.kickoff_utc IS NULL, s.kickoff_utc, s.game_id`,
      ),
    ],
    mapping: NFL_GAME_MAPPING,
  }),
  /** NflGamesReader.byEspnGameId(espnGameIds) — the ESPN↔nflverse join (research 04 §B.1.6). */
  "NflGamesReader.byEspnGameId": reader({
    method: "NflGamesReader.byEspnGameId",
    returns: "NflGame",
    statements: [
      stmt(
        "nflverse:schedules",
        ["ds_schedules", "ds_venues"],
        ["espn_game_ids"],
        `${GAMES_SELECT}
WHERE s.espn_game_id IN (SELECT value FROM json_each(:espn_game_ids))
ORDER BY s.season DESC, s.game_id`,
      ),
    ],
    mapping: `${NFL_GAME_MAPPING}; an id matching more than one row (nflverse repeats ESPN ids only in 2003–2010) returns every match, newest season first`,
  }),
  /** InjuryReader.reports(season, week, gsisIds | null) — ds_injuries. */
  "InjuryReader.reports": reader({
    method: "InjuryReader.reports",
    returns: "InjuryReport",
    statements: [
      stmt(
        "nflverse:injuries",
        ["ds_injuries"],
        ["season", "week", "gsis_ids"],
        `SELECT * FROM ds_injuries
WHERE season = :season AND week = :week
  AND (:gsis_ids IS NULL OR gsis_id IN (SELECT value FROM json_each(:gsis_ids)))
ORDER BY team, gsis_id`,
      ),
    ],
    mapping:
      "gsis_id, season, week as-is; nfl_team ← team (non-NflTeam rows skipped and warned); report_status ← bareUntrusted(report_status, 'dataset_text') under tag 'nflverse.injuries.report_status'; practice ← practice_status null ? [] : [{ day: 'week', status: bareUntrusted(practice_status) }] (ONE practice status per player-week, no per-day rows); primary_injury ← wrapUntrustedOrNull(COALESCE(report_primary_injury, practice_primary_injury), 'nflverse.injuries.primary_injury'); secondary_injury likewise ('nflverse.injuries.secondary_injury'); as_of ← stamp.as_of (no timestamp column); `gsis_ids = NULL` means every player",
  }),
  /** PlayerWeekReader.lines(gsisIds, season, weeks) — ds_stats_player_week. */
  "PlayerWeekReader.lines": reader({
    method: "PlayerWeekReader.lines",
    returns: "PlayerWeekLine",
    statements: [
      stmt(
        "nflverse:stats_player_week",
        ["ds_stats_player_week"],
        ["season", "weeks", "gsis_ids"],
        `SELECT * FROM ds_stats_player_week
WHERE season = :season AND week IN (SELECT value FROM json_each(:weeks))
  AND player_id IN (SELECT value FROM json_each(:gsis_ids))
ORDER BY player_id, week`,
      ),
    ],
    mapping:
      "gsis_id ← player_id; nfl_team ← team; opponent ← opponent_team; position as-is; line ← toStatLine(nflverse) over PLAYER_WEEK_STAT_COLUMNS (plan 08 §3.2; a NULL stat is absent from `present`); usage ← { targets, target_share, air_yards ← receiving_air_yards, air_yards_share, adot ← receiving_air_yards / targets (null when targets is 0/null), wopr, racr, carries, snaps/snap_pct/routes_proxy/carry_share/rz_*/gl_carries/xfp_ep ← null until their Phase-2 sources }",
  }),
  /**
   * PlayerWeekReader.defenseLines(teams, season, weeks) — ds_team_defense_week, then points allowed
   * from ds_schedules (a second statement on the schedules file; skipped when that file is absent,
   * and dst_pa is then absent from the line).
   */
  "PlayerWeekReader.defenseLines": reader({
    method: "PlayerWeekReader.defenseLines",
    returns: "TeamDefenseWeekLine",
    statements: [
      stmt(
        "nflverse:stats_player_week",
        ["ds_team_defense_week"],
        ["season", "weeks", "teams"],
        `SELECT * FROM ds_team_defense_week
WHERE season = :season AND week IN (SELECT value FROM json_each(:weeks))
  AND team IN (SELECT value FROM json_each(:teams))
ORDER BY team, week`,
      ),
      stmt(
        "nflverse:schedules",
        ["ds_schedules"],
        ["season", "game_ids"],
        `SELECT game_id, away_team, home_team, away_score, home_score FROM ds_schedules
WHERE season = :season AND game_id IN (SELECT value FROM json_each(:game_ids))`,
      ),
    ],
    mapping: `nfl_team ← team; opponent ← opponent_team; line ← src/domain/scoring statLineFromTeamDefense (the one translator, plan 08 §3.2: dst_sack ← def_sacks, dst_int ← def_interceptions, dst_ff ← def_fumbles_forced, dst_fr ← fumble_recovery_opp, dst_int_td ← def_tds, dst_fr_td ← ${DST_FUMBLE_RETURN_TD_COLUMN}, dst_td ← their sum, ret_td_total ← special_teams_tds + def_tds + ${DST_FUMBLE_RETURN_TD_COLUMN}, dst_safety ← def_safeties, dst_blk ← def_fg_blocks + def_punt_blocks + def_pat_blocks (ESPN counts PAT blocks: 70/70 recorded weeks), kr_yd ← kickoff_return_yards, pr_yd ← punt_return_yards, dst_pa_raw ← the opponent's score from statement 2 net of the OPPONENT defence's interception- and fumble-return TDs and safeties (statement 1 read a second time for the opponent's row; final games only; U-6 settled, 69/70), dst_ya_raw ← opp_passing_yards + opp_rushing_yards − |opp_sack_yards_lost| (nflverse stores sack yards negative; 70/70)); statement 2's game_ids are statement 1's game_id values`,
  }),
  /** WeatherReader.forGames(gameIds) — the configured weather source's table, then the other. */
  "WeatherReader.forGames": reader({
    method: "WeatherReader.forGames",
    returns: "WeatherObservation",
    statements: [
      stmt(
        "weather:open_meteo",
        ["ds_weather_open_meteo"],
        ["game_ids"],
        `SELECT * FROM ds_weather_open_meteo
WHERE game_id IN (SELECT value FROM json_each(:game_ids)) ORDER BY game_id`,
      ),
      stmt(
        "weather:nws",
        ["ds_weather_nws"],
        ["game_ids"],
        `SELECT * FROM ds_weather_nws
WHERE game_id IN (SELECT value FROM json_each(:game_ids)) ORDER BY game_id`,
      ),
    ],
    mapping:
      "run the EFF_WEATHER_SOURCE statement first, then the other for game_ids still missing (a missing file is skipped); game_ids are nflverse game ids (NflGame.game_id); source ← 'weather:open_meteo' | 'weather:nws' by table; temp_f, wind_mph, gust_mph, precip_prob (0..1), as_of as-is; the stamp is the first contributing source's",
  }),
  /** RosterWeeklyReader.latest(season) — the newest week's row per gsis_id. */
  "RosterWeeklyReader.latest": reader({
    method: "RosterWeeklyReader.latest",
    returns: "NflRosterPlayer",
    statements: [
      stmt(
        "nflverse:roster_weekly",
        ["ds_roster_weekly"],
        ["season"],
        `SELECT r.* FROM ds_roster_weekly AS r
JOIN (SELECT gsis_id, MAX(week) AS week FROM ds_roster_weekly WHERE season = :season GROUP BY gsis_id) AS m
  ON m.gsis_id = r.gsis_id AND m.week = r.week
WHERE r.season = :season ORDER BY r.gsis_id`,
      ),
    ],
    mapping:
      "gsis_id, season, week, full_name (raw — matching only, emitted only via bareUntrusted under 'nflverse.roster_weekly.name'), position, jersey_number, espn_id, sleeper_id, status as-is; team as NflTeam (non-NflTeam rows skipped and warned)",
  }),
  /** RosterWeeklyReader.byEspnId(espnId) — the crosswalk LOOKUP (research 04 §C step 1). */
  "RosterWeeklyReader.byEspnId": reader({
    method: "RosterWeeklyReader.byEspnId",
    returns: "NflRosterPlayer",
    statements: [
      stmt(
        "nflverse:roster_weekly",
        ["ds_roster_weekly"],
        ["espn_id"],
        `SELECT * FROM ds_roster_weekly WHERE espn_id = :espn_id
ORDER BY season DESC, week DESC LIMIT 1`,
      ),
    ],
    mapping:
      "the newest row for that ESPN id (0 or 1 row), mapped as RosterWeeklyReader.latest; a non-positive or non-integer id never reaches SQL (returns no rows)",
  }),
  /** PlayerUniverseReader.all(season) — ds_players, then the pro-team abbreviations. */
  "PlayerUniverseReader.all": reader({
    method: "PlayerUniverseReader.all",
    returns: "EspnPlayerIdentity",
    statements: [
      stmt(
        "espn:players",
        ["ds_players"],
        ["season"],
        `SELECT * FROM ds_players WHERE season = :season ORDER BY espn_id`,
      ),
      stmt(
        "espn:pro_schedule",
        ["ds_pro_teams"],
        ["season"],
        `SELECT pro_team_id, abbrev FROM ds_pro_teams WHERE season = :season`,
      ),
    ],
    mapping:
      "espn_id, full_name (raw — matching only), position_id, pro_team_id, percent_owned as-is; pro_team ← statement 2's abbrev for pro_team_id (null when the schedule file is absent, the id is unknown, or pro_team_id = 0); jersey ← null (players_wl carries none)",
  }),
  /** PlayerUniverseReader.byIds(espnIds) — the newest season's row per id. */
  "PlayerUniverseReader.byIds": reader({
    method: "PlayerUniverseReader.byIds",
    returns: "EspnPlayerIdentity",
    statements: [
      stmt(
        "espn:players",
        ["ds_players"],
        ["espn_ids"],
        `SELECT p.* FROM ds_players AS p
JOIN (SELECT espn_id, MAX(season) AS season FROM ds_players
      WHERE espn_id IN (SELECT value FROM json_each(:espn_ids)) GROUP BY espn_id) AS m
  ON m.espn_id = p.espn_id AND m.season = p.season
ORDER BY p.espn_id`,
      ),
      stmt(
        "espn:pro_schedule",
        ["ds_pro_teams"],
        ["seasons"],
        `SELECT season, pro_team_id, abbrev FROM ds_pro_teams
WHERE season IN (SELECT value FROM json_each(:seasons))`,
      ),
    ],
    mapping:
      "as PlayerUniverseReader.all; statement 2's seasons are statement 1's distinct season values",
  }),
  /**
   * NflPlayersReader.byEspnIds(espnIds) — the crosswalk fallback (research 04 §C step 2). The port is
   * src/domain/crosswalk/types.ts NflPlayersReader; the store exposes it as Store.nflPlayers.
   */
  "NflPlayersReader.byEspnIds": reader({
    method: "NflPlayersReader.byEspnIds",
    returns: "NflPlayerRecord",
    statements: [
      stmt(
        "nflverse:players",
        ["ds_nfl_players"],
        ["espn_ids"],
        `SELECT * FROM ds_nfl_players
WHERE espn_id IN (SELECT value FROM json_each(:espn_ids)) ORDER BY espn_id`,
      ),
    ],
    mapping:
      "gsis_id, espn_id, display_name (raw — matching only, emitted only via bareUntrusted under 'nflverse.players.name'), position, latest_team (NflTeam or null), jersey_number, status, last_season as-is; a pair from here carries source 'nflverse:players'",
  }),
} satisfies Record<string, ReaderContract>);

/** A reader method key. */
export type ReaderMethod = keyof typeof READER_QUERIES;

/**
 * Reader keys with no domain port yet (the store implements them once the port exists). Empty since
 * the crosswalk module declared NflPlayersReader; kept as an export so a future pending port has one
 * place to be named.
 */
export const PENDING_PORT_READERS: readonly ReaderMethod[] = Object.freeze([]);

// =====================================================================================================
// Phase 2 — the usage / market / news datasets (plan 10 §3.2 sources; plan 01 §5.2 rows and §5.5; plan
// 06 §1.3 jobs; plan 07 D1 D4 D5 D6, E5 signals; plan 08 §3.2, §4.3), grounded in the 2024, 2025 and
// 2026 release files read on 2026-10-06 (docs/evals/phase2-datasets.md records URL, size, rows, codec,
// kept columns and licence per dataset). ADDITIVE: nothing above this line changes.
//
// Conventions on top of the Phase-1 ones (header): REAL values pass through `finiteOrNull` (NaN and
// ±Infinity → NULL); every column says whether its value is third-party free text (`untrusted`: the
// plan 02 §6 provenance tag a reader wraps it with — null = an id, a number or a checked label).
// History: the backtests' prior seasons (plan 10 §3.2 "two prior nflverse seasons"; D9; A-3) live in
// their OWN dataset files (`<source>_history`, one per dataset, holding every prior season), so a
// current-season refresh never rewrites them and each is one more read-only connection (plan 01 §5.5
// — 25 contract files, all opened at once, no ATTACH: tests/store/datasets/phase2-connections.test.ts).
// =====================================================================================================

/** The Phase-2 dataset sources with a contract (plan 10 §3.2 scope; SOURCE_REGISTRY phase "2"). */
export const PHASE_2_DATASET_SOURCES = [
  "nflverse:stats_team_week",
  "nflverse:pbp",
  "nflverse:snap_counts",
  "nflverse:depth_charts",
  "ffopportunity:ep_weekly",
  "sleeper:trending",
  "news:rotowire",
  "news:espn",
  "news:cbs",
] as const satisfies readonly DatasetSourceId[];
/** A Phase-2 dataset source id. */
export type Phase2DatasetSourceId = (typeof PHASE_2_DATASET_SOURCES)[number];

/**
 * Phase-2 SOURCE_REGISTRY sources deliberately WITHOUT a contract: not in plan 10 §3.2's source list
 * and no domain port reads them (plan 06 lists them in the snaps job; a later phase adds them).
 */
export const PHASE_2_UNCONTRACTED_SOURCES = [
  "nflverse:pfr_advstats",
  "nflverse:ftn_charting",
] as const satisfies readonly DatasetSourceId[];

/** How many prior seasons Phase 2 loads for the soft backtests (plan 10 D9: 2 in Phase 2; A-3). */
export const HISTORY_SEASON_COUNT = 2;

/** The prior seasons a history file holds for a current season: [current − 2, current − 1]. */
export function historySeasonsFor(currentSeason: number): readonly number[] {
  if (!Number.isInteger(currentSeason) || currentSeason < 2001 || currentSeason > 2999)
    throw new RangeError("dataset contract: invalid current season");
  return Object.freeze(
    Array.from(
      { length: HISTORY_SEASON_COUNT },
      (_, i) => currentSeason - HISTORY_SEASON_COUNT + i,
    ),
  );
}

/**
 * How many prior seasons the history files hold from Phase 3 on (plan 10 §3.3 "≥ 3 historical
 * seasons", D9 "≥ 3 in Phase 3", A-3): the held-out backtests C1–C7 need three. ADDITIVE (Phase 3):
 * HISTORY_SEASON_COUNT above stays Phase 2's count; the history sources hold at least these
 * seasons whatever a run names (src/sources/nflverse/seasons.ts), and `nflverse:schedules` holds them
 * too (its one file covers every season). Grounded on the 2023–2025 files: docs/evals/phase3-data.md.
 */
export const BACKTEST_SEASON_COUNT = 3;

/** The prior seasons the history files hold from Phase 3 on: [current − 3, current − 1], ascending. */
export function backtestSeasonsFor(currentSeason: number): readonly number[] {
  if (!Number.isInteger(currentSeason) || currentSeason < 2001 || currentSeason > 2999)
    throw new RangeError("dataset contract: invalid current season");
  return Object.freeze(
    Array.from(
      { length: BACKTEST_SEASON_COUNT },
      (_, i) => currentSeason - BACKTEST_SEASON_COUNT + i,
    ),
  );
}

/**
 * The history dataset files: each repeats the tables of the current-season source it names, for the
 * prior seasons only (B3/B6/B7 backtests: stats + defence lines, team stats, pbp, snaps, injuries,
 * depth charts, expected points). nflverse `schedules` needs none (games.parquet holds every season:
 * the runner adds the prior seasons to that source's `ctx.seasons`); `roster_weekly` needs none (the
 * all-time `ds_nfl_players` maps gsis_id ↔ pfr_id / espn_id for any season).
 */
export const HISTORY_DATASET_SOURCES = [
  "nflverse:stats_player_week_history",
  "nflverse:stats_team_week_history",
  "nflverse:pbp_history",
  "nflverse:snap_counts_history",
  "nflverse:injuries_history",
  "nflverse:depth_charts_history",
  "ffopportunity:ep_weekly_history",
] as const;
/** A history dataset source id (`<provider>:<dataset>_history`; fits config/paths SOURCE_ID_RE). */
export type HistoryDatasetSourceId = (typeof HISTORY_DATASET_SOURCES)[number];

/** The current-season source each history file repeats. */
export const HISTORY_OF: Readonly<Record<HistoryDatasetSourceId, DatasetSourceId>> = Object.freeze({
  "nflverse:stats_player_week_history": "nflverse:stats_player_week",
  "nflverse:stats_team_week_history": "nflverse:stats_team_week",
  "nflverse:pbp_history": "nflverse:pbp",
  "nflverse:snap_counts_history": "nflverse:snap_counts",
  "nflverse:injuries_history": "nflverse:injuries",
  "nflverse:depth_charts_history": "nflverse:depth_charts",
  "ffopportunity:ep_weekly_history": "ffopportunity:ep_weekly",
});

/** Every source a ds_* contract exists for: Phase 1, Phase 2 and the history files. */
export type ContractSourceId =
  Phase1DatasetSourceId | Phase2DatasetSourceId | HistoryDatasetSourceId;

/** One Phase-2 column: provenance plus whether it is third-party free text. */
export interface Phase2Column extends ContractColumn {
  /** The `untrusted_text` tag a reader wraps the value with (plan 02 §6.2); null = not free text. */
  readonly untrusted: UntrustedSource | null;
}

/** The upstream season files a table is filled from (inclusive bounds; null = open). */
export interface SeasonRange {
  readonly from: number | null;
  readonly to: number | null;
}

/** A Phase-2 ds_* table. Assignable to `DatasetTableSpec`. */
export interface Phase2TableContract extends DatasetTableSpec {
  readonly columns: readonly Phase2Column[];
  /** The current-season source whose file holds the table (a history-only table names its twin). */
  readonly source: Phase2DatasetSourceId;
  /** The history file that repeats the table for prior seasons, or null. */
  readonly history: HistoryDatasetSourceId | null;
  /** Upstream release file, endpoint or feed. */
  readonly upstream: string;
  readonly season_key: "season" | null;
  /** Which upstream seasons' files have THIS layout (the depth-chart schema changed in 2025). */
  readonly seasons: SeasonRange;
  readonly row_filter: string | null;
  readonly description: string;
  /** The upstream licence (research 04 §E; SOURCE_REGISTRY). */
  readonly license: License;
}

// --- Phase-2 column helpers ---------------------------------------------------------------------------

const p2 = (
  name: string,
  type: DatasetColumnType,
  nullable: boolean,
  from: readonly string[] = [name],
  derivation: string | null = null,
  untrusted: UntrustedSource | null = null,
): Phase2Column =>
  Object.freeze({ name, type, nullable, from: Object.freeze([...from]), derivation, untrusted });
const p2text = (name: string, nullable = true): Phase2Column => p2(name, "TEXT", nullable);
const p2int = (name: string, nullable = true): Phase2Column => p2(name, "INTEGER", nullable);
const p2real = (name: string, nullable = true): Phase2Column => p2(name, "REAL", nullable);
const p2ints = (...names: string[]): Phase2Column[] => names.map((n) => p2int(n));
const p2reals = (...names: string[]): Phase2Column[] => names.map((n) => p2real(n));
const p2texts = (...names: string[]): Phase2Column[] => names.map((n) => p2text(n));
/** A whole number stored as DOUBLE upstream → INTEGER. */
const whole = (name: string, nullable = true, from = name): Phase2Column =>
  p2(
    name,
    "INTEGER",
    nullable,
    [from],
    `wholeNumber(${from}): whole DOUBLE → integer; a fraction or NaN → NULL`,
  );
/** A 0/1 DOUBLE indicator → INTEGER 0 | 1. */
const ind = (name: string): Phase2Column =>
  p2(name, "INTEGER", true, [name], `flag01(${name}): 0/1 DOUBLE → 0 | 1; else NULL`);

const p2table = (t: Phase2TableContract): Phase2TableContract =>
  Object.freeze({
    ...t,
    columns: Object.freeze([...t.columns]),
    primary_key: t.primary_key ? Object.freeze([...t.primary_key]) : null,
    indexes: Object.freeze(t.indexes.map((ix) => Object.freeze([...ix]))),
    seasons: Object.freeze({ ...t.seasons }),
  });

const ANY_SEASON: SeasonRange = Object.freeze({ from: null, to: null });
const FFO_RELEASES = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";

// --- nflverse:stats_team_week --------------------------------------------------------------------------

/**
 * The stat columns of `ds_stats_team_week`, verbatim nflverse names: the offence families of plan 08
 * §3.2, the defence/return/kicking families the D/ST line and its cross-check need (the Phase-1
 * `ds_team_defense_week` aggregation's agreement with these is the [U] plan 08 §3.2 names), and
 * penalties/timeouts. Not kept: the punting (`pt_*`), game-winning-FG (`gwfg_*`), tackle and
 * `*_distance` families — no Phase-2 consumer.
 */
export const TEAM_WEEK_STAT_COLUMNS: readonly Phase2Column[] = Object.freeze([
  ...p2ints("completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions"),
  ...p2ints("sacks_suffered", "sack_yards_lost", "sack_fumbles", "sack_fumbles_lost"),
  ...p2ints("passing_air_yards", "passing_yards_after_catch", "passing_first_downs"),
  ...p2reals("passing_epa", "passing_cpoe"),
  p2int("passing_2pt_conversions"),
  ...p2ints("carries", "rushing_yards", "rushing_tds", "rushing_fumbles", "rushing_fumbles_lost"),
  p2int("rushing_first_downs"),
  p2real("rushing_epa"),
  p2int("rushing_2pt_conversions"),
  ...p2ints("receptions", "targets", "receiving_yards", "receiving_tds"),
  ...p2ints("receiving_fumbles", "receiving_fumbles_lost", "receiving_air_yards"),
  ...p2ints("receiving_yards_after_catch", "receiving_first_downs"),
  p2real("receiving_epa"),
  ...p2ints("receiving_2pt_conversions", "special_teams_tds"),
  ...p2ints("def_tackles_for_loss", "def_fumbles_forced"),
  ...p2reals("def_sacks", "def_sack_yards"),
  ...p2ints("def_qb_hits", "def_interceptions", "def_interception_yards", "def_pass_defended"),
  ...p2ints("def_tds", "def_fumbles", "def_safeties", "def_punt_blocks", "def_pat_blocks"),
  ...p2ints("def_fg_blocks", "fumble_recovery_own", "fumble_recovery_opp"),
  ...p2ints("fumble_recovery_yards_opp", "fumble_recovery_tds"),
  ...p2ints("penalties", "penalty_yards", "timeouts", "fumbles_total", "fumbles_lost_total"),
  ...p2ints("punt_returns", "punt_return_yards", "kickoff_returns", "kickoff_return_yards"),
  ...p2ints("fg_made", "fg_att", "fg_missed", "fg_blocked", "fg_long"),
  ...p2ints("fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49"),
  ...p2ints("fg_made_50_59", "fg_made_60_"),
  ...p2ints("fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39", "fg_missed_40_49"),
  ...p2ints("fg_missed_50_59", "fg_missed_60_"),
  ...p2texts("fg_made_list", "fg_missed_list", "fg_blocked_list"),
  ...p2ints("pat_made", "pat_att", "pat_missed", "pat_blocked"),
]);

/**
 * `ds_stats_team_week` — one row per team-game, `stats_team/stats_team_week_{season}.parquet`.
 * Observed 2026-10-06: 2026 128 rows (weeks 1–4, all REG), 2025 and 2024 570 rows each (544 REG +
 * 26 POST); 138 columns, SNAPPY, identical across the three seasons; (season, week, team) unique;
 * every game_id appears exactly twice (one row per side).
 */
export const DS_STATS_TEAM_WEEK = p2table({
  name: "ds_stats_team_week",
  source: "nflverse:stats_team_week",
  history: "nflverse:stats_team_week_history",
  upstream: `${RELEASES}/stats_team/stats_team_week_{season}.parquet`,
  season_key: "season",
  seasons: ANY_SEASON,
  row_filter: "team null/empty",
  description: "Weekly team stat lines: offence, defence, returns, kicking, penalties",
  license: "CC-BY-4.0",
  columns: [
    p2int("season", false),
    p2int("week", false),
    p2text("team", false),
    p2text("season_type", false), // REG | POST
    p2text("game_id"),
    p2text("opponent_team"),
    ...TEAM_WEEK_STAT_COLUMNS,
  ],
  primary_key: ["season", "week", "team"],
  indexes: [
    ["team", "season", "week"],
    ["season", "week", "opponent_team"],
  ],
});

// --- nflverse:pbp ------------------------------------------------------------------------------------

/**
 * `ds_pbp` — the projected play-by-play subset (plan 01 §5.2 "ds_pbp (projected columns)"; plan 10
 * §3.2: RZ/GL flags, `kick_distance`, `yards_gained` on TD plays, `defteam`, `xpass`, `pass_oe`, `epa`,
 * `play_type`, `posteam`, the player ids), `pbp/play_by_play_{season}.parquet` (372 columns; 2026
 * 11,155 plays, 2025 48,771, 2024 49,492; SNAPPY; identical schema). Kept: 51 columns. Every id is a
 * gsis_id. Grounded: with `PBP_KEPT_PLAY_TYPES`, targets (`pass_attempt = 1 AND sack = 0 AND
 * two_point_attempt = 0` with a receiver), carries (`rush_attempt = 1 AND two_point_attempt = 0` with
 * a rusher), pass/rush/receiving TDs and FG attempts/makes equal stats_player_week on every
 * player-week of 2024–2026 except one 2024 carry (PbpReader statements below use those definitions).
 */
export const DS_PBP = p2table({
  name: "ds_pbp",
  source: "nflverse:pbp",
  history: "nflverse:pbp_history",
  upstream: `${RELEASES}/pbp/play_by_play_{season}.parquet`,
  season_key: "season",
  seasons: ANY_SEASON,
  row_filter:
    "play_type not in PBP_KEPT_PLAY_TYPES (derive.ts): drops period/timeout markers (play_type null; 1,446 in 2024) and penalty-nullified `no_play` rows (4,936 in 2024); every kept play has posteam, defteam and yardline_100 (observed 2024–2026)",
  description:
    "Play-by-play subset: situation, RZ/GL flags, play type, players, TDs, kicks, EPA, xpass",
  license: "CC-BY-4.0",
  columns: [
    p2int("season", false),
    p2int("week", false),
    p2text("season_type", false), // REG | POST
    p2text("game_id", false),
    whole("play_id", false),
    p2text("posteam", false),
    p2text("defteam", false),
    whole("qtr"),
    whole("down"),
    whole("ydstogo"),
    whole("yardline_100", false),
    p2(
      "rz",
      "INTEGER",
      false,
      ["yardline_100"],
      "redZoneFlag(yardline_100): 1 when yardline_100 ≤ 20 (RED_ZONE_YARDLINE), else 0",
    ),
    p2(
      "gl",
      "INTEGER",
      false,
      ["yardline_100"],
      "goalLineFlag(yardline_100): 1 when yardline_100 ≤ 5 (GOAL_LINE_YARDLINE), else 0",
    ),
    ind("goal_to_go"),
    p2text("play_type", false),
    whole("yards_gained"), // on a TD play: the scoring play's length (plan 08 §4.3 long_td_bonus)
    whole("air_yards"),
    whole("return_yards"),
    whole("kick_distance"), // FG / PAT distance (plan 08 §3.2 fg_* brackets)
    ...[
      "qb_dropback",
      "qb_kneel",
      "qb_spike",
      "qb_scramble",
      "pass_attempt",
      "rush_attempt",
      "complete_pass",
      "sack",
      "interception",
      "fumble_lost",
      "safety",
      "touchdown",
      "pass_touchdown",
      "rush_touchdown",
      "return_touchdown",
      "two_point_attempt",
    ].map(ind),
    ...p2texts("two_point_conv_result", "extra_point_result", "field_goal_result"),
    ...p2texts("td_team", "td_player_id", "passer_player_id", "receiver_player_id"),
    ...p2texts("rusher_player_id", "kicker_player_id"),
    ...p2texts("kickoff_returner_player_id", "punt_returner_player_id"),
    ...p2reals("epa", "wp", "xpass", "pass_oe"),
    ind("success"),
  ],
  primary_key: ["season", "game_id", "play_id"],
  // Only the indexes the IN-list lookups need (PbpReader.playerUsage by receiver / rusher; team
  // totals by posteam): every other statement filters on (season, week) first, ≤ ~2,700 plays a week.
  // Measured 2024–2025: 12.2 MB of rows; each extra id index costs ~0.7 MB a season (A-11 ≈ 10 MB).
  indexes: [
    ["season", "week", "posteam"],
    ["receiver_player_id", "season", "week"],
    ["rusher_player_id", "season", "week"],
  ],
});

// --- nflverse:snap_counts -------------------------------------------------------------------------------

/**
 * `ds_snap_counts` — offence/defence/special-teams snaps per player-game (PFR via nflverse), keyed by
 * `pfr_player_id` — NO gsis_id upstream: readers map gsis_id → pfr_id through ds_roster_weekly, then
 * ds_nfl_players (2026: 1,739 of 1,742 snap pfr ids are in players.parquet, 507/508 skill players).
 * `snap_counts/snap_counts_{season}.parquet`: 2026 5,970 rows (weeks 1–4), 2025 26,613, 2024 26,615;
 * 16 columns, SNAPPY; (season, week, pfr_player_id) unique; snaps are whole DOUBLEs, `*_pct` fractions
 * 0–1. The player name column is not kept (joins are by id; one less untrusted surface).
 */
export const DS_SNAP_COUNTS = p2table({
  name: "ds_snap_counts",
  source: "nflverse:snap_counts",
  history: "nflverse:snap_counts_history",
  upstream: `${RELEASES}/snap_counts/snap_counts_{season}.parquet`,
  season_key: "season",
  seasons: ANY_SEASON,
  row_filter: "pfr_player_id or team null/empty",
  description: "Snap counts and shares per player-game (offence, defence, special teams)",
  license: "CC-BY-4.0",
  columns: [
    p2int("season", false),
    p2int("week", false),
    p2text("game_type", false), // REG | WC | DIV | CON | SB
    p2text("game_id", false),
    p2text("pfr_game_id"),
    p2text("pfr_player_id", false),
    p2text("position"),
    p2text("team", false),
    p2text("opponent"),
    whole("offense_snaps"),
    p2("offense_pct", "REAL", true, ["offense_pct"], "fraction01(offense_pct): 0–1, else NULL"),
    whole("defense_snaps"),
    p2("defense_pct", "REAL", true, ["defense_pct"], "fraction01(defense_pct): 0–1, else NULL"),
    whole("st_snaps"),
    p2("st_pct", "REAL", true, ["st_pct"], "fraction01(st_pct): 0–1, else NULL"),
  ],
  primary_key: ["season", "week", "pfr_player_id"],
  indexes: [
    ["pfr_player_id", "season", "week"],
    ["season", "week", "team"],
  ],
});

// --- nflverse:depth_charts ------------------------------------------------------------------------------

/** The season the depth-chart file switched to ESPN-keyed daily snapshots (Y-04 §B1 (b)). */
export const DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM = 2025;

/**
 * `ds_depth_charts` — the 2025+ ESPN-keyed depth charts (research 04 §A #7: `espn_id` on every row,
 * so the join to ESPN players needs no crosswalk), `depth_charts/depth_charts_{season}.parquet`: one
 * full snapshot of all 32 teams per day (`dt`), NO season and NO week column (2026: 613,196 rows, 220
 * snapshots 2026-03-22 → 2026-10-06; 2025: 554,215 rows, 221 snapshots). Stored as RUNS
 * (`depthChartRuns`, derive.ts): an occupant's unbroken stay in a slot — 12,046 rows for 2026 and
 * 18,254 for 2025 — so the chart as of any instant is one range predicate and the current chart is
 * `valid_to_ms IS NULL`. `gsis_id` is null on 300 of 3,318 2026 espn ids (practice squad / new
 * signings) — the espn_id is the key.
 */
export const DS_DEPTH_CHARTS = p2table({
  name: "ds_depth_charts",
  source: "nflverse:depth_charts",
  history: "nflverse:depth_charts_history",
  upstream: `${RELEASES}/depth_charts/depth_charts_{season}.parquet`,
  season_key: "season",
  seasons: { from: DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM, to: null },
  row_filter:
    "a snapshot row whose dt, espn_id, team, pos_grp_id, pos_id, pos_slot or pos_rank is malformed, or whose pos_grp/pos_abb fails DEPTH_LABEL_RE, is invalid (dropped + warned); a well-formed label outside DEPTH_LABELS is stored as 'OTHER' (warned); consecutive snapshots of one occupant in one slot collapse into one run (depthChartRuns); a second row for a taken slot in one snapshot is dropped (none observed)",
  description: "ESPN-keyed depth charts as occupancy runs (current chart: valid_to_ms IS NULL)",
  license: "CC-BY-4.0",
  columns: [
    p2(
      "season",
      "INTEGER",
      false,
      [],
      "the file's {season} (the 2025+ schema has no season column)",
    ),
    p2text("team", false),
    p2(
      "espn_id",
      "INTEGER",
      false,
      ["espn_id"],
      "parseDecimalId(espn_id); malformed → the row is invalid",
    ),
    p2text("gsis_id"),
    p2(
      "player_name",
      "TEXT",
      true,
      ["player_name"],
      "capText(player_name, 256)",
      "nflverse.depth_charts.name",
    ),
    p2("pos_grp_id", "INTEGER", false, ["pos_grp_id"], "nonNegativeDecimal(pos_grp_id)"),
    p2(
      "pos_grp",
      "TEXT",
      false,
      ["pos_grp"],
      "depthLabel(pos_grp): DEPTH_LABELS member, another well-formed label → 'OTHER', else the row is invalid",
    ),
    p2("pos_id", "INTEGER", false, ["pos_id"], "nonNegativeDecimal(pos_id)"),
    p2(
      "pos_abb",
      "TEXT",
      false,
      ["pos_abb"],
      "depthLabel(pos_abb): DEPTH_LABELS member, another well-formed label → 'OTHER', else the row is invalid",
    ),
    p2int("pos_slot", false),
    p2int("pos_rank", false),
    p2(
      "valid_from_ms",
      "INTEGER",
      false,
      ["dt"],
      "depthChartRuns: depthSnapshotMs(dt) of the run's first snapshot",
    ),
    p2(
      "last_seen_ms",
      "INTEGER",
      false,
      ["dt"],
      "depthChartRuns: depthSnapshotMs(dt) of the run's last snapshot",
    ),
    p2(
      "valid_to_ms",
      "INTEGER",
      true,
      ["dt"],
      "depthChartRuns: the team's next snapshot after last_seen_ms (exclusive); NULL = in the newest snapshot",
    ),
    p2("snapshots", "INTEGER", false, ["dt"], "depthChartRuns: snapshots the run spans"),
  ],
  primary_key: ["season", "team", "pos_grp_id", "pos_slot", "pos_rank", "valid_from_ms"],
  indexes: [
    ["season", "team", "valid_to_ms"],
    ["espn_id", "season"],
    ["gsis_id", "season"],
  ],
});

/**
 * `ds_depth_charts_legacy` — the ≤ 2024 weekly, gsis-keyed depth-chart layout (HISTORY file only; the
 * 2024 backtest season), `depth_charts/depth_charts_{season}.parquet` with season/club_code/week/
 * formation/depth_position/depth_team: 2024 37,312 rows, 15 columns, SNAPPY. 234 `SBBYE` rows have no
 * week (dropped); 201 rows duplicate another exactly once derived (198 already byte-identical
 * upstream) and collapse — no two DIFFERENT rows share a key; a blank `depth_position` (467 rows, e.g.
 * "\n    ") falls back to `position`. No espn_id: readers join through gsis_id.
 */
export const DS_DEPTH_CHARTS_LEGACY = p2table({
  name: "ds_depth_charts_legacy",
  source: "nflverse:depth_charts",
  history: "nflverse:depth_charts_history",
  upstream: `${RELEASES}/depth_charts/depth_charts_{season}.parquet (seasons ≤ 2024 layout)`,
  season_key: "season",
  seasons: { from: null, to: DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM - 1 },
  row_filter:
    "week null (SBBYE rows) or gsis_id empty → dropped; exact duplicate rows collapse to one; two different rows with one key → the publish fails (schema_mismatch; none observed)",
  description: "Weekly depth charts in the pre-2025 layout (history only)",
  license: "CC-BY-4.0",
  columns: [
    p2int("season", false),
    p2int("week", false),
    p2text("game_type", false),
    p2("team", "TEXT", false, ["club_code"], "verbatim club_code (renamed; nflverse spelling)"),
    p2text("gsis_id", false),
    p2(
      "full_name",
      "TEXT",
      true,
      ["full_name"],
      "capText(full_name, 256)",
      "nflverse.depth_charts.name",
    ),
    p2text("position"),
    p2(
      "formation",
      "TEXT",
      false,
      ["formation"],
      "depthLabel(formation): Offense | Defense | Special Teams (DEPTH_LABELS)",
    ),
    p2(
      "pos_abb",
      "TEXT",
      false,
      ["depth_position", "position"],
      "depthLabel(emptyToNull(depth_position) ?? position) (DEPTH_LABELS, else 'OTHER'); neither well-formed → the row is invalid",
    ),
    p2(
      "depth_team",
      "INTEGER",
      false,
      ["depth_team"],
      "legacyDepthRank(depth_team): '1'–'9' → 1–9",
    ),
    p2("jersey_number", "INTEGER", true, ["jersey_number"], "jerseyNumber(jersey_number)"),
  ],
  primary_key: [
    "season",
    "week",
    "game_type",
    "team",
    "formation",
    "pos_abb",
    "depth_team",
    "gsis_id",
  ],
  indexes: [
    ["season", "team", "week"],
    ["gsis_id", "season", "week"],
  ],
});

// --- ffopportunity:ep_weekly ------------------------------------------------------------------------------

/**
 * The player-level columns of `ds_ep_weekly` kept verbatim (REAL): actuals and model expectations per
 * component, so xFP can be re-scored under the LEAGUE's scoring (E1 `player_sim`, plan 10 §3.2) rather
 * than ffopportunity's own, plus the team denominators the shares need. Not kept: the `*_diff`
 * columns (actual − exp) and the rest of the `*_team` family.
 */
export const EP_WEEKLY_COLUMNS: readonly Phase2Column[] = Object.freeze(
  p2reals(
    "pass_attempt", "rec_attempt", "rush_attempt", "pass_air_yards", "rec_air_yards",
    "pass_completions", "receptions", "pass_completions_exp", "receptions_exp",
    "pass_yards_gained", "rec_yards_gained", "rush_yards_gained",
    "pass_yards_gained_exp", "rec_yards_gained_exp", "rush_yards_gained_exp",
    "pass_touchdown", "rec_touchdown", "rush_touchdown",
    "pass_touchdown_exp", "rec_touchdown_exp", "rush_touchdown_exp",
    "pass_two_point_conv", "rec_two_point_conv", "rush_two_point_conv",
    "pass_two_point_conv_exp", "rec_two_point_conv_exp", "rush_two_point_conv_exp",
    "pass_first_down", "rec_first_down", "rush_first_down",
    "pass_first_down_exp", "rec_first_down_exp", "rush_first_down_exp",
    "pass_interception", "rec_interception", "pass_interception_exp", "rec_interception_exp",
    "rec_fumble_lost", "rush_fumble_lost",
    "pass_fantasy_points", "rec_fantasy_points", "rush_fantasy_points",
    "pass_fantasy_points_exp", "rec_fantasy_points_exp", "rush_fantasy_points_exp",
    "total_yards_gained", "total_yards_gained_exp", "total_touchdown", "total_touchdown_exp",
    "total_first_down", "total_first_down_exp", "total_fantasy_points", "total_fantasy_points_exp",
    "pass_attempt_team", "rec_attempt_team", "rush_attempt_team", "rec_air_yards_team",
  ), // prettier-ignore
);

/**
 * `ds_ep_weekly` — ffopportunity expected fantasy points per player-week (research 04 §B.3;
 * CC-BY-SA 4.0 — share-alike: kept separable, attributed per SOURCE_REGISTRY),
 * `ffverse/ffopportunity` release `latest-data`, `ep_weekly_{season}.parquet`: 2026 1,362 rows
 * (weeks 1–4), 2025 6,054, 2024 6,005; 159 columns, SNAPPY. `season` is TEXT and `week` a DOUBLE
 * upstream; `player_id` (= gsis_id) is null on team-level unattributed rows (97 in 2026, dropped);
 * (season, week, player_id) unique otherwise.
 */
export const DS_EP_WEEKLY = p2table({
  name: "ds_ep_weekly",
  source: "ffopportunity:ep_weekly",
  history: "ffopportunity:ep_weekly_history",
  upstream: `${FFO_RELEASES}/ep_weekly_{season}.parquet`,
  season_key: "season",
  seasons: ANY_SEASON,
  row_filter: "player_id null/empty (team-level unattributed opportunity rows)",
  description: "Expected fantasy points and their components per player-week (ffopportunity)",
  license: "CC-BY-SA-4.0",
  columns: [
    p2("season", "INTEGER", false, ["season"], "seasonFromText(season): the TEXT '2026' → 2026"),
    whole("week", false),
    p2text("game_id", false),
    p2text("player_id", false), // = gsis_id
    p2text("posteam", false),
    p2text("position"),
    ...EP_WEEKLY_COLUMNS,
  ],
  primary_key: ["season", "week", "player_id"],
  indexes: [
    ["player_id", "season", "week"],
    ["season", "week", "posteam"],
  ],
});

// --- sleeper:trending ------------------------------------------------------------------------------------

/** The `lookback_hours` and `limit` the trending source requests (Sleeper's documented parameters). */
export const SLEEPER_TRENDING_REQUEST = Object.freeze({ lookback_hours: 24, limit: 50 });

/**
 * `ds_trending` — Sleeper's trending adds and drops (SECONDARY: ESPN `ownership.percentChange` is the
 * primary market signal, research 04 §A #13; non-commercial terms), `GET
 * api.sleeper.app/v1/players/nfl/trending/{add|drop}` → `[{ "player_id": "4984", "count": 1234 }]`
 * (shape observed by the sibling 2026-09-29, Y-04 §B4; not re-fetched here). One fresh file per
 * refresh holds the latest two lists; `player_id` is a Sleeper id (digits, or a team code for a
 * defence) mapped to gsis_id by readers through `ds_roster_weekly.sleeper_id`.
 */
export const DS_TRENDING = p2table({
  name: "ds_trending",
  source: "sleeper:trending",
  history: null,
  upstream:
    "https://api.sleeper.app/v1/players/nfl/trending/{add|drop}?lookback_hours=24&limit=50 (JSON array)",
  season_key: null,
  seasons: ANY_SEASON,
  row_filter:
    "an entry whose player_id fails sleeperPlayerId or whose count is not a non-negative integer; a player_id repeated within one list keeps its first (highest) entry",
  description: "Sleeper trending adds/drops (secondary market signal)",
  license: "non-commercial",
  columns: [
    p2("kind", "TEXT", false, [], "the request path's {add|drop}"),
    p2("sleeper_id", "TEXT", false, ["player_id"], "sleeperPlayerId(player_id)"),
    p2("rank", "INTEGER", false, [], "1-based position in the response array"),
    p2("count", "INTEGER", false, ["count"], "nonNegativeInt(count)"),
    p2(
      "lookback_hours",
      "INTEGER",
      false,
      [],
      "the request's lookback_hours (SLEEPER_TRENDING_REQUEST)",
    ),
    p2("as_of", "TEXT", false, [], "the fetch instant (injected Clock), UTC ISO-8601"),
  ],
  primary_key: ["kind", "sleeper_id"],
  indexes: [["sleeper_id"], ["kind", "rank"]],
});

// --- news:rotowire / news:espn / news:cbs ---------------------------------------------------------------

const NEWS_FEEDS = Object.freeze({
  rotowire: "https://www.rotowire.com/rss/news.php?sport=NFL",
  espn: "https://www.espn.com/espn/rss/nfl/news",
  cbs: "https://www.cbssports.com/rss/headlines/nfl/",
} satisfies Record<NewsSource, string>);

/** The storage ceilings of the RSS text (code points; the wrapper caps lower at output). */
export const NEWS_STORAGE_CAPS = Object.freeze({ title: 1000, blurb: 4000 });

const newsTag = <K extends "title" | "blurb" | "url">(src: NewsSource, k: K) =>
  `rss.${src}.${k}` as const satisfies UntrustedSource;

const newsItems = (src: NewsSource, id: Phase2DatasetSourceId): Phase2TableContract =>
  p2table({
    name: "ds_news",
    source: id,
    history: null,
    upstream: `${NEWS_FEEDS[src]} (RSS 2.0 <item>)`,
    season_key: null,
    seasons: ANY_SEASON,
    row_filter:
      "an item without a title, without a guid AND a link, or with an unparsable pubDate is invalid; items published more than NEWS_RETENTION_MS (30 d) before the fetch are not carried over; an item already in the previous file keeps its first_seen_ms (append + dedup by item_id, plan 01 §5.2)",
    description: `RSS headlines (${src}); all text untrusted`,
    license: "api-terms",
    columns: [
      p2("item_id", "TEXT", false, ["guid", "link"], `newsItemId('${src}', guid, link)`),
      p2("source", "TEXT", false, [], `the constant '${src}' (NEWS_SOURCES)`),
      p2("published_ms", "INTEGER", false, ["pubDate"], "rssDateMs(pubDate)"),
      p2(
        "first_seen_ms",
        "INTEGER",
        false,
        [],
        "the fetch instant of the item's first sighting (carried over)",
      ),
      p2(
        "title",
        "TEXT",
        false,
        ["title"],
        `capText(title, NEWS_STORAGE_CAPS.title)`,
        newsTag(src, "title"),
      ),
      p2(
        "blurb",
        "TEXT",
        true,
        ["description"],
        `capText(description, NEWS_STORAGE_CAPS.blurb)`,
        newsTag(src, "blurb"),
      ),
      p2("link", "TEXT", true, ["link"], "httpUrlOrNull(link)", newsTag(src, "url")),
    ],
    primary_key: ["item_id"],
    indexes: [["published_ms"]],
  });

const newsPlayers = (src: NewsSource, id: Phase2DatasetSourceId): Phase2TableContract =>
  p2table({
    name: "ds_news_players",
    source: id,
    history: null,
    upstream: `derived at load from the ${src} items (title + blurb) against the ESPN player universe`,
    season_key: null,
    seasons: ANY_SEASON,
    row_filter: "refs of items not in ds_news are dropped",
    description: `Players an RSS item (${src}) names, by deterministic match`,
    license: "api-terms",
    columns: [
      p2("item_id", "TEXT", false, ["ds_news.item_id"], "the matched item's id"),
      p2(
        "espn_id",
        "INTEGER",
        false,
        ["ds_players.espn_id", "ds_players.full_name", "ds_pro_teams.abbrev"],
        "the news source's deterministic name matcher (plan 07 D6 players_matched; plan 02 §6.4 — rules, never a model) over the item's title and blurb against ds_players",
      ),
      p2(
        "gsis_id",
        "TEXT",
        true,
        ["crosswalk.gsis_id"],
        "the crosswalk's gsis_id for espn_id at load; NULL when unpaired",
      ),
      p2("match_confidence", "REAL", false, [], "the matcher's confidence 0–1 by method"),
      p2("match_method", "TEXT", false, [], "NEWS_MATCH_METHODS (derive.ts)"),
    ],
    primary_key: ["item_id", "espn_id"],
    indexes: [["gsis_id"], ["espn_id"]],
  });

/** `ds_news` + `ds_news_players` of each RSS source (one dataset file per feed; identical layouts). */
export const NEWS_TABLES: Readonly<
  Record<"news:rotowire" | "news:espn" | "news:cbs", readonly Phase2TableContract[]>
> = Object.freeze({
  "news:rotowire": Object.freeze([
    newsItems("rotowire", "news:rotowire"),
    newsPlayers("rotowire", "news:rotowire"),
  ]),
  "news:espn": Object.freeze([newsItems("espn", "news:espn"), newsPlayers("espn", "news:espn")]),
  "news:cbs": Object.freeze([newsItems("cbs", "news:cbs"), newsPlayers("cbs", "news:cbs")]),
});

// --- the Phase-2 + history registries -------------------------------------------------------------------

/** Every Phase-2 ds_* table, by the source whose CURRENT-season file holds it. */
export const PHASE_2_DATASET_TABLES: Readonly<
  Record<Phase2DatasetSourceId, readonly Phase2TableContract[]>
> = Object.freeze({
  "nflverse:stats_team_week": Object.freeze([DS_STATS_TEAM_WEEK]),
  "nflverse:pbp": Object.freeze([DS_PBP]),
  "nflverse:snap_counts": Object.freeze([DS_SNAP_COUNTS]),
  "nflverse:depth_charts": Object.freeze([DS_DEPTH_CHARTS]),
  "ffopportunity:ep_weekly": Object.freeze([DS_EP_WEEKLY]),
  "sleeper:trending": Object.freeze([DS_TRENDING]),
  ...NEWS_TABLES,
});

/** Every Phase-2 table contract, flat (the legacy depth layout included). */
export const ALL_PHASE_2_TABLES: readonly Phase2TableContract[] = Object.freeze([
  ...PHASE_2_DATASET_SOURCES.flatMap((s) => PHASE_2_DATASET_TABLES[s]),
  DS_DEPTH_CHARTS_LEGACY,
]);

/**
 * The tables each history file holds: the SAME spec objects as its current-season source (so every
 * reader statement runs on it unchanged), plus the pre-2025 depth-chart layout in the depth file.
 */
export const HISTORY_DATASET_TABLES: Readonly<
  Record<HistoryDatasetSourceId, readonly (DatasetTableContract | Phase2TableContract)[]>
> = Object.freeze({
  "nflverse:stats_player_week_history": DATASET_TABLES["nflverse:stats_player_week"],
  "nflverse:stats_team_week_history": PHASE_2_DATASET_TABLES["nflverse:stats_team_week"],
  "nflverse:pbp_history": PHASE_2_DATASET_TABLES["nflverse:pbp"],
  "nflverse:snap_counts_history": PHASE_2_DATASET_TABLES["nflverse:snap_counts"],
  "nflverse:injuries_history": DATASET_TABLES["nflverse:injuries"],
  "nflverse:depth_charts_history": Object.freeze([DS_DEPTH_CHARTS, DS_DEPTH_CHARTS_LEGACY]),
  "ffopportunity:ep_weekly_history": PHASE_2_DATASET_TABLES["ffopportunity:ep_weekly"],
});

/** Every contract source: Phase 1, Phase 2, history (25 dataset files). */
export const CONTRACT_DATASET_SOURCES: readonly ContractSourceId[] = Object.freeze([
  ...PHASE_1_DATASET_SOURCES,
  ...PHASE_2_DATASET_SOURCES,
  ...HISTORY_DATASET_SOURCES,
]);

/** Whether `s` is a Phase-2 dataset source id. */
export function isPhase2DatasetSource(s: string): s is Phase2DatasetSourceId {
  return (PHASE_2_DATASET_SOURCES as readonly string[]).includes(s);
}

/** Whether `s` is a history dataset source id. */
export function isHistoryDatasetSource(s: string): s is HistoryDatasetSourceId {
  return (HISTORY_DATASET_SOURCES as readonly string[]).includes(s);
}

/** Whether `s` names a source with a ds_* contract. */
export function isContractDatasetSource(s: string): s is ContractSourceId {
  return (CONTRACT_DATASET_SOURCES as readonly string[]).includes(s);
}

/**
 * The tables a contract source's file holds (Phase 1, Phase 2 or history); [] for any other id. The
 * publisher and the connection manager use THIS (not Phase-1 `tablesFor`) once Phase-2 sources publish.
 */
export function contractTablesFor(source: string): readonly DatasetTableSpec[] {
  if (isPhase1DatasetSource(source)) return DATASET_TABLES[source];
  if (isPhase2DatasetSource(source)) return PHASE_2_DATASET_TABLES[source];
  if (isHistoryDatasetSource(source)) return HISTORY_DATASET_TABLES[source];
  return [];
}

/** The `ds_schema` columns hash of any contract source (equals `columnsHash` for Phase-1 ones). */
export function contractColumnsHash(source: string): string {
  return columnsHashOf(contractTablesFor(source));
}

/** The history file of a current-season source, or null (Phase-1 readers' prior seasons run there). */
export function historyTwinOf(source: string): HistoryDatasetSourceId | null {
  for (const h of HISTORY_DATASET_SOURCES) if (HISTORY_OF[h] === source) return h;
  return null;
}

/** Whether `season` falls in a table's upstream layout range. */
export function seasonInRange(r: SeasonRange, season: number): boolean {
  return (r.from === null || season >= r.from) && (r.to === null || season <= r.to);
}

/** The parquet sources among Phase 2 and history (their `assertSchema` checks columns + codec). */
export const PHASE_2_PARQUET_SOURCES = [
  "nflverse:stats_team_week",
  "nflverse:pbp",
  "nflverse:snap_counts",
  "nflverse:depth_charts",
  "ffopportunity:ep_weekly",
  ...HISTORY_DATASET_SOURCES,
] as const satisfies readonly ContractSourceId[];

/**
 * The upstream parquet columns a Phase-2 or history source's file for `season` must carry (plan 01
 * §5.5: a missing or renamed column fails the job, naming it — acceptance B1): the union of every
 * `from` of the source's tables whose layout covers `season` (cross-dataset inputs `a.b` excluded).
 * A history file of a Phase-1 dataset requires what its current source requires. Sorted, unique;
 * [] for the JSON/RSS sources (their wire checks live in the source).
 */
export function phase2RequiredUpstreamColumns(
  source: ContractSourceId,
  season: number,
): readonly string[] {
  if (!(PHASE_2_PARQUET_SOURCES as readonly string[]).includes(source)) return [];
  if (isHistoryDatasetSource(source) && isPhase1DatasetSource(HISTORY_OF[source]))
    return requiredUpstreamColumns(HISTORY_OF[source]);
  const out = new Set<string>();
  for (const t of contractTablesFor(source) as readonly Phase2TableContract[]) {
    if (!seasonInRange(t.seasons, season)) continue;
    for (const c of t.columns) for (const f of c.from) if (!f.includes(".")) out.add(f);
  }
  return [...out].sort();
}

/** The parquet kind an upstream column must decode as (what a source's schema assertion checks). */
export type UpstreamKind = "string" | "int" | "double";

/** The upstream kind each Phase-2 derivation function reads. */
const DERIVATION_KINDS: Readonly<Record<string, UpstreamKind>> = Object.freeze({
  wholeNumber: "double",
  flag01: "double",
  fraction01: "double",
  redZoneFlag: "double",
  goalLineFlag: "double",
  parseDecimalId: "string",
  nonNegativeDecimal: "string",
  seasonFromText: "string",
  capText: "string",
  depthLabel: "string",
  legacyDepthRank: "string",
  jerseyNumber: "string",
  depthChartRuns: "string",
});

/**
 * The expected kind of every required upstream column of a Phase-2 parquet file for `season`
 * (`phase2RequiredUpstreamColumns`'s columns): a verbatim column by its contract type (TEXT → string,
 * INTEGER → int, REAL → double); a derived one by the function its derivation names first. A history
 * file of a Phase-1 dataset returns {} (its kinds are the Phase-1 source's: src/sources/nflverse/
 * schemas.ts). A derivation reading "verbatim …" keeps the type rule. Throws on a derivation
 * no kind is known for, or on two columns reading one upstream field as different kinds (a contract
 * bug — the test suite runs it for every source and season).
 */
export function phase2UpstreamKinds(
  source: ContractSourceId,
  season: number,
): Readonly<Record<string, UpstreamKind>> {
  if (!(PHASE_2_PARQUET_SOURCES as readonly string[]).includes(source)) return Object.freeze({});
  if (isHistoryDatasetSource(source) && isPhase1DatasetSource(HISTORY_OF[source]))
    return Object.freeze({});
  return upstreamKindsOf(contractTablesFor(source) as readonly Phase2TableContract[], season);
}

/** `phase2UpstreamKinds` over explicit tables (the rule itself; exported for its tests). */
export function upstreamKindsOf(
  tables: readonly Phase2TableContract[],
  season: number,
): Readonly<Record<string, UpstreamKind>> {
  const out = Object.create(null) as Record<string, UpstreamKind>;
  for (const t of tables) {
    if (!seasonInRange(t.seasons, season)) continue;
    for (const c of t.columns) {
      if (c.from.every((f) => f.includes("."))) continue; // reference data or another dataset
      const byType: UpstreamKind =
        c.type === "TEXT" ? "string" : c.type === "INTEGER" ? "int" : "double";
      const fn = /^([A-Za-z][A-Za-z0-9]*)[(:]/.exec(c.derivation ?? "")?.[1];
      let kind: UpstreamKind;
      if (c.derivation === null || c.derivation.startsWith("verbatim ")) kind = byType;
      else {
        const k =
          fn !== undefined && Object.hasOwn(DERIVATION_KINDS, fn)
            ? DERIVATION_KINDS[fn]
            : undefined;
        if (k === undefined)
          throw new Error(`dataset contract: no upstream kind for ${t.name}.${c.name}`);
        kind = k;
      }
      for (const f of c.from) {
        if (f.includes(".")) continue;
        const prior = out[f];
        if (prior !== undefined && prior !== kind)
          throw new Error(`dataset contract: ${f} read as ${prior} and ${kind}`);
        out[f] = kind;
      }
    }
  }
  return out;
}

// --- Phase-2 reader queries ------------------------------------------------------------------------------

/**
 * One statement of a Phase-2 reader: like `ReaderStatement`, on ONE file's read-only connection.
 * `history` names the history file the SAME SQL also runs on for a prior season (the reader picks the
 * file whose `dataset_meta.seasons` holds the requested season; both when a window spans them).
 */
export interface Phase2ReaderStatement {
  readonly source: ContractSourceId;
  readonly history: HistoryDatasetSourceId | null;
  readonly tables: readonly string[];
  readonly params: readonly string[];
  readonly sql: string;
}

/** A Phase-2 reader method's contract. */
export interface Phase2ReaderContract {
  /** `Interface.method` (a src/domain port, or a pending one — PHASE_2_PENDING_PORT_READERS). */
  readonly method: string;
  readonly returns: string;
  readonly statements: readonly Phase2ReaderStatement[];
  readonly mapping: string;
}

const p2stmt = (
  source: ContractSourceId,
  tables: readonly string[],
  params: readonly string[],
  sql: string,
  history: HistoryDatasetSourceId | null = isHistoryDatasetSource(source)
    ? null
    : historyTwinOf(source),
): Phase2ReaderStatement =>
  Object.freeze({
    source,
    history,
    tables: Object.freeze([...tables]),
    params: Object.freeze([...params]),
    sql,
  });

const p2reader = (r: Phase2ReaderContract): Phase2ReaderContract =>
  Object.freeze({ ...r, statements: Object.freeze([...r.statements]) });

const IN_LIST = (col: string, param: string): string =>
  `${col} IN (SELECT value FROM json_each(:${param}))`;

/** The pbp predicates the grounding pinned (equal to nflverse's own counting, see DS_PBP). */
export const PBP_TARGET_SQL = "pass_attempt = 1 AND sack = 0 AND two_point_attempt = 0";
export const PBP_CARRY_SQL = "rush_attempt = 1 AND two_point_attempt = 0";

const newsRecent = (src: "news:rotowire" | "news:espn" | "news:cbs"): Phase2ReaderStatement =>
  p2stmt(
    src,
    ["ds_news", "ds_news_players"],
    ["since_ms", "gsis_ids", "limit"],
    `SELECT n.* FROM ds_news AS n
WHERE n.published_ms >= :since_ms
  AND (:gsis_ids IS NULL OR EXISTS (SELECT 1 FROM ds_news_players AS p
       WHERE p.item_id = n.item_id AND ${IN_LIST("p.gsis_id", "gsis_ids")}))
ORDER BY n.published_ms DESC, n.item_id LIMIT :limit`,
  );

const newsRefs = (src: "news:rotowire" | "news:espn" | "news:cbs"): Phase2ReaderStatement =>
  p2stmt(
    src,
    ["ds_news_players"],
    ["item_ids"],
    `SELECT * FROM ds_news_players WHERE ${IN_LIST("item_id", "item_ids")}
ORDER BY item_id, match_confidence DESC, espn_id`,
  );

/** Every Phase-2 reader method, keyed `Interface.method`. */
export const PHASE_2_READER_QUERIES = Object.freeze({
  /** DepthChartReader.chart(season, teams) — the current (newest-snapshot) chart, or 2024's last week. */
  "DepthChartReader.chart": p2reader({
    method: "DepthChartReader.chart",
    returns: "DepthChartRow",
    statements: [
      p2stmt(
        "nflverse:depth_charts",
        ["ds_depth_charts"],
        ["season", "teams"],
        `SELECT * FROM ds_depth_charts
WHERE season = :season AND ${IN_LIST("team", "teams")} AND valid_to_ms IS NULL
ORDER BY team, pos_grp_id, pos_slot, pos_rank`,
      ),
      p2stmt(
        "nflverse:depth_charts_history",
        ["ds_depth_charts_legacy"],
        ["season", "teams"],
        `SELECT d.* FROM ds_depth_charts_legacy AS d
JOIN (SELECT team, MAX(week) AS week FROM ds_depth_charts_legacy
      WHERE season = :season AND ${IN_LIST("team", "teams")} GROUP BY team) AS m
  ON m.team = d.team AND m.week = d.week
WHERE d.season = :season ORDER BY d.team, d.formation, d.pos_abb, d.depth_team, d.gsis_id`,
      ),
    ],
    mapping:
      "season ≥ DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM → statement 1 (current file, or its history twin for a prior season): week ← null (the 2025+ layout has no week), nfl_team ← team (non-NflTeam skipped and warned), pos_grp, pos_abb as-is (a DEPTH_LABELS member or 'OTHER' by construction — labels are emitted unwrapped), rank ← pos_rank, gsis_id, espn_id as-is, name ← bareUntrusted(player_name ?? '', 'player_name') under 'nflverse.depth_charts.name'; an earlier season → statement 2 (history file): week as-is (the team's last listed week), pos_grp ← formation, pos_abb as-is, rank ← depth_team, espn_id ← null (join via gsis_id), name ← bareUntrusted(full_name) under the same tag",
  }),
  /** DepthChartReader.asOf(season, teams, atMs | week) — the chart in force at an instant (pending port). */
  "DepthChartReader.asOf": p2reader({
    method: "DepthChartReader.asOf",
    returns: "DepthChartRow",
    statements: [
      p2stmt(
        "nflverse:depth_charts",
        ["ds_depth_charts"],
        ["season", "teams", "at_ms"],
        `SELECT * FROM ds_depth_charts
WHERE season = :season AND ${IN_LIST("team", "teams")}
  AND valid_from_ms <= :at_ms AND (valid_to_ms IS NULL OR :at_ms < valid_to_ms)
ORDER BY team, pos_grp_id, pos_slot, pos_rank`,
      ),
      p2stmt(
        "nflverse:depth_charts_history",
        ["ds_depth_charts_legacy"],
        ["season", "teams", "week"],
        `SELECT * FROM ds_depth_charts_legacy
WHERE season = :season AND week = :week AND ${IN_LIST("team", "teams")}
ORDER BY team, formation, pos_abb, depth_team, gsis_id`,
      ),
    ],
    mapping:
      "as DepthChartReader.chart; statement 1 takes an epoch-ms instant (the B3/B6 backtests ask 'the chart at the week's first kickoff'), statement 2 (≤ 2024 layout) a week; a team with no snapshot at or before the instant returns no rows",
  }),
  /** EpWeeklyReader.rows(gsisIds, season, weeks) — ds_ep_weekly. */
  "EpWeeklyReader.rows": p2reader({
    method: "EpWeeklyReader.rows",
    returns: "EpWeeklyRow",
    statements: [
      p2stmt(
        "ffopportunity:ep_weekly",
        ["ds_ep_weekly"],
        ["season", "weeks", "gsis_ids"],
        `SELECT * FROM ds_ep_weekly
WHERE season = :season AND ${IN_LIST("week", "weeks")} AND ${IN_LIST("player_id", "gsis_ids")}
ORDER BY player_id, week`,
      ),
    ],
    mapping:
      "gsis_id ← player_id; season, week as-is; xfp_total ← total_fantasy_points_exp (ffopportunity's own PPR scoring — a league-scored xFP is Σ the *_exp components × the league's weights, plan 08 §5); the component columns ride along for E1 player_sim; attribution 'ffopportunity (ffverse)', CC-BY-SA 4.0",
  }),
  /** NewsReader.recent(sinceIso, limit, gsisIds | null) — one statement pair per feed file. */
  "NewsReader.recent": p2reader({
    method: "NewsReader.recent",
    returns: "NewsItem",
    statements: [
      newsRecent("news:rotowire"),
      newsRecent("news:espn"),
      newsRecent("news:cbs"),
      newsRefs("news:rotowire"),
      newsRefs("news:espn"),
      newsRefs("news:cbs"),
    ],
    mapping:
      "since_ms ← Date.parse(sinceIso); statements 1–3 per feed (a missing file is skipped and named in the stamp), merged newest first by (published_ms DESC, item_id), cut to `limit`; statements 4–6 with that feed's item_ids; id ← item_id; source ← source; published_at ← epochMsToIso(published_ms); title ← wrapUntrusted(title, 'rss.<source>.title'); blurb ← wrapUntrusted(blurb ?? '', 'rss.<source>.blurb'); url ← wrapUntrusted(link ?? '', 'rss.<source>.url') — never fetched, never a link; gsis_ids ← the refs' non-null gsis_id values (espn_id rides along for player_id); `gsis_ids = NULL` means every item",
  }),
  /** TrendingReader.latest() — ds_trending, then gsis ids from the roster file. */
  "TrendingReader.latest": p2reader({
    method: "TrendingReader.latest",
    returns: "TrendingRow",
    statements: [
      p2stmt(
        "sleeper:trending",
        ["ds_trending"],
        [],
        `SELECT * FROM ds_trending ORDER BY kind, rank`,
      ),
      p2stmt(
        "nflverse:roster_weekly",
        ["ds_roster_weekly"],
        ["sleeper_ids"],
        `SELECT sleeper_id, gsis_id, season, week FROM ds_roster_weekly
WHERE ${IN_LIST("sleeper_id", "sleeper_ids")}
ORDER BY sleeper_id, season DESC, week DESC`,
      ),
    ],
    mapping:
      "sleeper_id, kind ('add' | 'drop'), count, as_of as-is; gsis_id ← statement 2's FIRST row per sleeper_id (newest season/week; null when absent or the roster file is missing; a defence's team code never matches); statement 2's sleeper_ids are statement 1's; labelled secondary (ESPN percentChange is primary)",
  }),
  /** SnapCountReader.counts(gsisIds, season, weeks) — pfr ids via the roster/players files (pending port). */
  "SnapCountReader.counts": p2reader({
    method: "SnapCountReader.counts",
    returns: "SnapCountRow",
    statements: [
      p2stmt(
        "nflverse:roster_weekly",
        ["ds_roster_weekly"],
        ["season", "gsis_ids"],
        `SELECT DISTINCT gsis_id, pfr_id FROM ds_roster_weekly
WHERE season = :season AND ${IN_LIST("gsis_id", "gsis_ids")} AND pfr_id IS NOT NULL
ORDER BY gsis_id, pfr_id`,
      ),
      p2stmt(
        "nflverse:players",
        ["ds_nfl_players"],
        ["gsis_ids"],
        `SELECT gsis_id, pfr_id FROM ds_nfl_players
WHERE ${IN_LIST("gsis_id", "gsis_ids")} AND pfr_id IS NOT NULL ORDER BY gsis_id`,
      ),
      p2stmt(
        "nflverse:snap_counts",
        ["ds_snap_counts"],
        ["season", "weeks", "pfr_ids"],
        `SELECT * FROM ds_snap_counts
WHERE season = :season AND ${IN_LIST("week", "weeks")} AND ${IN_LIST("pfr_player_id", "pfr_ids")}
ORDER BY pfr_player_id, week`,
      ),
    ],
    mapping:
      "pfr_id per gsis_id: statement 1 (the season's roster; one pfr_id per gsis_id observed) wins, else statement 2 (all-time players — the only path for a prior season, whose roster is not loaded); a gsis_id with two pfr_ids or a pfr_id claimed by two gsis_ids is dropped and warned (never guessed); statement 3's pfr_ids are those; row → { gsis_id, season, week, nfl_team ← team, snaps ← offense_snaps, snap_pct ← offense_pct, defense_snaps, st_snaps }",
  }),
  /** TeamWeekReader.lines(teams, season, weeks) — ds_stats_team_week (pending port). */
  "TeamWeekReader.lines": p2reader({
    method: "TeamWeekReader.lines",
    returns: "TeamWeekLine",
    statements: [
      p2stmt(
        "nflverse:stats_team_week",
        ["ds_stats_team_week"],
        ["season", "weeks", "teams"],
        `SELECT * FROM ds_stats_team_week
WHERE season = :season AND ${IN_LIST("week", "weeks")} AND ${IN_LIST("team", "teams")}
ORDER BY team, week`,
      ),
    ],
    mapping:
      "nfl_team ← team, opponent ← opponent_team (non-NflTeam skipped and warned); the stat columns as-is (TEAM_WEEK_STAT_COLUMNS); carry_share denominators ← carries, target denominators ← targets; the D/ST cross-check reads def_* and fumble_recovery_* against ds_team_defense_week",
  }),
  /** PbpReader.playerUsage(gsisIds, season, weeks) — targets, carries, RZ/GL, team totals (pending port). */
  "PbpReader.playerUsage": p2reader({
    method: "PbpReader.playerUsage",
    returns: "PbpUsageRow",
    statements: [
      p2stmt(
        "nflverse:pbp",
        ["ds_pbp"],
        ["season", "weeks", "gsis_ids"],
        `SELECT season, week, posteam AS team, receiver_player_id AS gsis_id,
  COUNT(*) AS targets, SUM(rz) AS rz_targets, SUM(gl) AS gl_targets,
  SUM(CASE WHEN complete_pass = 1 THEN 1 ELSE 0 END) AS receptions,
  SUM(COALESCE(air_yards, 0)) AS air_yards
FROM ds_pbp
WHERE +season = :season AND ${IN_LIST("+week", "weeks")} AND ${IN_LIST("receiver_player_id", "gsis_ids")}
  AND ${PBP_TARGET_SQL}
GROUP BY season, week, posteam, receiver_player_id ORDER BY gsis_id, week, team`,
      ),
      p2stmt(
        "nflverse:pbp",
        ["ds_pbp"],
        ["season", "weeks", "gsis_ids"],
        `SELECT season, week, posteam AS team, rusher_player_id AS gsis_id,
  COUNT(*) AS carries, SUM(rz) AS rz_carries, SUM(gl) AS gl_carries
FROM ds_pbp
WHERE +season = :season AND ${IN_LIST("+week", "weeks")} AND ${IN_LIST("rusher_player_id", "gsis_ids")}
  AND ${PBP_CARRY_SQL}
GROUP BY season, week, posteam, rusher_player_id ORDER BY gsis_id, week, team`,
      ),
      p2stmt(
        "nflverse:pbp",
        ["ds_pbp"],
        ["season", "weeks", "teams"],
        `SELECT season, week, posteam AS team,
  SUM(CASE WHEN qb_dropback = 1 AND two_point_attempt = 0 THEN 1 ELSE 0 END) AS dropbacks,
  SUM(CASE WHEN ${PBP_TARGET_SQL} AND receiver_player_id IS NOT NULL THEN 1 ELSE 0 END) AS targets,
  SUM(CASE WHEN ${PBP_CARRY_SQL} AND rusher_player_id IS NOT NULL THEN 1 ELSE 0 END) AS carries,
  SUM(CASE WHEN ${PBP_TARGET_SQL} AND receiver_player_id IS NOT NULL THEN rz ELSE 0 END) AS rz_targets,
  SUM(CASE WHEN ${PBP_CARRY_SQL} AND rusher_player_id IS NOT NULL THEN rz ELSE 0 END) AS rz_carries,
  SUM(CASE WHEN ${PBP_CARRY_SQL} AND rusher_player_id IS NOT NULL THEN gl ELSE 0 END) AS gl_carries
FROM ds_pbp
WHERE season = :season AND ${IN_LIST("week", "weeks")} AND ${IN_LIST("posteam", "teams")}
GROUP BY season, week, posteam ORDER BY team, week`,
      ),
    ],
    mapping:
      "statements 1–2 carry a unary + on season/week so the planner takes the receiver/rusher index (no ANALYZE in a published file: 0.3 ms instead of 11 ms over a 2-season history file); per (gsis_id, week, team): targets, rz_targets, gl_targets, receptions, air_yards from statement 1; carries, rz_carries, gl_carries from statement 2 (absent → 0 when the week's pbp file is loaded, else null); statement 3's teams are the teams statements 1–2 returned; rz_share ← (rz_targets + rz_carries) / (team rz_targets + rz_carries), null when the team had none; routes_proxy ← SnapCountReader snap_pct × team dropbacks (named a proxy: research 04 #3)",
  }),
  /** PbpReader.scoringPlays(gsisIds, season, weeks) — TD lengths, kicks, 2-pt, return TDs (pending port). */
  "PbpReader.scoringPlays": p2reader({
    method: "PbpReader.scoringPlays",
    returns: "PbpScoringPlay",
    statements: [
      p2stmt(
        "nflverse:pbp",
        ["ds_pbp"],
        ["season", "weeks", "gsis_ids"],
        `SELECT season, week, game_id, play_id, play_type, posteam, defteam, yards_gained, kick_distance,
  field_goal_result, extra_point_result, two_point_attempt, two_point_conv_result, touchdown,
  pass_touchdown, rush_touchdown, return_touchdown, td_team, td_player_id, passer_player_id,
  receiver_player_id, rusher_player_id, kicker_player_id, kickoff_returner_player_id,
  punt_returner_player_id
FROM ds_pbp
WHERE season = :season AND ${IN_LIST("week", "weeks")}
  AND (touchdown = 1 OR two_point_attempt = 1 OR play_type IN ('field_goal', 'extra_point'))
  AND (${IN_LIST("td_player_id", "gsis_ids")} OR ${IN_LIST("passer_player_id", "gsis_ids")}
    OR ${IN_LIST("receiver_player_id", "gsis_ids")} OR ${IN_LIST("rusher_player_id", "gsis_ids")}
    OR ${IN_LIST("kicker_player_id", "gsis_ids")})
ORDER BY season, week, game_id, play_id`,
      ),
    ],
    mapping:
      "plan 08 §4.3 long_td_bonus: a pass TD's length = yards_gained for its passer and its receiver (td_player_id), a rush TD's for its rusher; plan 08 §3.2 fg_*: kick_distance + field_goal_result (made | missed | blocked) per kicker, bracketized to the league's bounds; kr_td / pr_td ← returnTdKind(play) (derive.ts); 2-pt by passer/receiver/rusher with two_point_conv_result = 'success'",
  }),
  /** PbpReader.teamProfile(teams, season, weeks) — the D5 defence profile by defteam (pending port). */
  "PbpReader.teamProfile": p2reader({
    method: "PbpReader.teamProfile",
    returns: "PbpTeamProfileRow",
    statements: [
      p2stmt(
        "nflverse:pbp",
        ["ds_pbp"],
        ["season", "weeks", "teams"],
        `SELECT season, week, defteam AS team, COUNT(*) AS plays,
  SUM(CASE WHEN qb_dropback = 1 THEN 1 ELSE 0 END) AS dropbacks,
  SUM(CASE WHEN sack = 1 THEN 1 ELSE 0 END) AS sacks,
  SUM(CASE WHEN interception = 1 THEN 1 ELSE 0 END) AS interceptions,
  SUM(CASE WHEN fumble_lost = 1 THEN 1 ELSE 0 END) AS fumbles_lost,
  SUM(CASE WHEN qb_dropback = 1 THEN epa ELSE 0 END) AS epa_dropback_sum,
  SUM(CASE WHEN qb_dropback = 0 AND rush_attempt = 1 THEN epa ELSE 0 END) AS epa_rush_sum,
  SUM(CASE WHEN qb_dropback = 0 AND rush_attempt = 1 THEN 1 ELSE 0 END) AS rushes,
  AVG(pass_oe) AS pass_oe_mean, COUNT(pass_oe) AS pass_oe_n, AVG(xpass) AS xpass_mean
FROM ds_pbp
WHERE season = :season AND ${IN_LIST("week", "weeks")} AND ${IN_LIST("defteam", "teams")}
  AND play_type IN ('pass', 'run') AND two_point_attempt = 0
GROUP BY season, week, defteam ORDER BY team, week`,
      ),
    ],
    mapping:
      "per defence-week: pass_rate ← dropbacks / plays, sack_rate ← sacks / dropbacks, takeaway_rate ← (interceptions + fumbles_lost) / plays, epa_allowed.pass ← epa_dropback_sum / dropbacks, .rush ← epa_rush_sum / rushes, proe ← pass_oe_mean (nflverse's pass rate over expectation, percent points; null when pass_oe_n = 0); the shrinkage and windowing are E-layer (plan 07 D5)",
  }),
} satisfies Record<string, Phase2ReaderContract>);

/** A Phase-2 reader method key. */
export type Phase2ReaderMethod = keyof typeof PHASE_2_READER_QUERIES;

/**
 * Phase-2 reader keys with no domain port yet (src/domain/analytics/types.ts declares DepthChartReader
 * .chart, EpWeeklyReader, NewsReader and TrendingReader only): the analytics module declares these
 * ports, then the store implements them over the statements above.
 */
export const PHASE_2_PENDING_PORT_READERS: readonly Phase2ReaderMethod[] = Object.freeze([
  "DepthChartReader.asOf",
  "SnapCountReader.counts",
  "TeamWeekReader.lines",
  "PbpReader.playerUsage",
  "PbpReader.scoringPlays",
  "PbpReader.teamProfile",
]);

/**
 * Phase-1 reader statements whose source has a history twin run unchanged on it for a prior season
 * (`PlayerWeekReader.lines`/`defenseLines` on nflverse:stats_player_week_history, `InjuryReader
 * .reports` on nflverse:injuries_history): READER_QUERIES stays as it is; this names the pairing.
 */
export const PHASE_1_HISTORY_TWINS: Readonly<
  Partial<Record<Phase1DatasetSourceId, HistoryDatasetSourceId>>
> = Object.freeze({
  "nflverse:stats_player_week": "nflverse:stats_player_week_history",
  "nflverse:injuries": "nflverse:injuries_history",
});
