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
import type { DatasetSourceId } from "../../config/freshness.js";
import { ESPN_READ_HOST_DEFAULT } from "../../config/schema.js";
import type { DatasetColumn, DatasetColumnType, DatasetTableSpec } from "../types.js";

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
