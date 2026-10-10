// excerpt-format.ts — the committed backtest excerpt of plan 10 C1 (research 05 §8.4 #2: the
// projection backtest over ≥ 3 nflverse seasons, plan 10 D9): its tables, columns and file layout,
// shared by the generator (make-excerpt.ts, run by hand on release files — never by CI) and the
// loader (data.ts, every test). Text like every nflverse excerpt in this repo (fixtures/nflverse/
// ATTRIBUTION.md): a JSON header + TSV parts of JSON cells (tests/sources/nflverse/helpers/tsv.ts),
// each part ≤ 240 KB, every part's sha256 pinned in data/manifest.json. New here.
import { join } from "node:path";

export const ROOT = new URL("../../../../../", import.meta.url).pathname;
/** Where the excerpt lives. */
export const DATA_DIR = join(ROOT, "tests/domain/analytics/projections-v2/data");
/** The release base URLs. */
export const NFLVERSE_REL = "https://github.com/nflverse/nflverse-data/releases/download";
export const FFOPP_REL = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";
/** The largest TSV part (the repo's excerpt convention). */
export const MAX_PART_BYTES = 240 * 1024;

/** The seasons held: 2023 tunes, 2024 and 2025 are held out (plan 10 C1: ≥ 2 held-out seasons). */
export const EXCERPT_SEASONS = Object.freeze([2023, 2024, 2025] as const);
/** The regular-season weeks kept (week 18 feeds the next season's trailing window). */
export const EXCERPT_LAST_WEEK = 18;
/** The fantasy positions the excerpt keeps (nflverse `position_group`). */
export const EXCERPT_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"] as const);

/**
 * The player-week table (nflverse `stats_player_week` + `snap_counts` + pbp counts; CC-BY 4.0): the
 * keys, every column the scoring translator reads for a stat the reference leagues score (the B7
 * excerpt's set), the opportunity columns, the snap share (joined on the nflverse players file's
 * pfr_id) and the red-zone / goal-line counts and touchdowns from pbp.
 */
export const PLAYER_WEEK_COLUMNS = Object.freeze([
  "player_id",
  "position",
  "season",
  "week",
  "team",
  "opponent_team",
  "completions",
  "attempts",
  "passing_yards",
  "passing_tds",
  "passing_interceptions",
  "sacks_suffered",
  "sack_fumbles_lost",
  "passing_2pt_conversions",
  "carries",
  "rushing_yards",
  "rushing_tds",
  "rushing_fumbles_lost",
  "rushing_2pt_conversions",
  "targets",
  "receptions",
  "receiving_yards",
  "receiving_tds",
  "receiving_fumbles_lost",
  "receiving_2pt_conversions",
  "receiving_air_yards",
  "special_teams_tds",
  "fumble_recovery_own",
  "fumble_recovery_tds",
  "offense_snaps",
  "offense_pct",
  "rz_targets",
  "rz_carries",
  "gl_carries",
  "rz_rec_tds",
  "rz_rush_tds",
  "gl_rush_tds",
] as const);

/**
 * The team-week table (nflverse `stats_team_week` + `schedules` + pbp; CC-BY 4.0): the offence's
 * volume, the game's market line from the team's side (`spread` > 0 = favoured; nflverse's
 * `spread_line` is the home side's), the venue, and pbp's dropbacks, designed rushes, red-zone plays
 * and expected pass rate sums.
 */
export const TEAM_WEEK_COLUMNS = Object.freeze([
  "team",
  "season",
  "week",
  "opponent",
  "home",
  "attempts",
  "sacks_suffered",
  "carries",
  "targets",
  "points_for",
  "points_against",
  "spread",
  "total_line",
  "roof",
  "temp",
  "wind",
  "plays",
  "dropbacks",
  "rushes",
  "rz_plays",
  "xpass_sum",
  "xpass_n",
] as const);

/** The injury-report table (nflverse `injuries`, final report per player-week; CC-BY 4.0). */
export const INJURY_WEEK_COLUMNS = Object.freeze([
  "gsis_id",
  "season",
  "week",
  "team",
  "position",
  "report_status",
  "practice_status",
] as const);

/**
 * The expected-points table (ffopportunity `ep_weekly`; CC BY-SA 4.0 — kept in its own files, the
 * share-alike condition attaching to them only): the location-based expectations of research 05
 * §5 / sib §1 step 5, values rounded to 4 decimals.
 */
export const EP_WEEK_COLUMNS = Object.freeze([
  "player_id",
  "season",
  "week",
  "receptions_exp",
  "rec_touchdown_exp",
  "rush_touchdown_exp",
  "pass_touchdown_exp",
  "pass_interception_exp",
  "total_fantasy_points_exp",
] as const);

/** The ESPN → GSIS crosswalk of the players in league-b's recorded box scores (nflverse players). */
export const XWALK_COLUMNS = Object.freeze(["espn_id", "gsis_id"] as const);

/** One excerpt table. */
export type ExcerptTable = "player_week" | "team_week" | "injury_week" | "ep_week" | "espn_xwalk";

/** The columns of a table. */
export const TABLE_COLUMNS: Readonly<Record<ExcerptTable, readonly string[]>> = Object.freeze({
  player_week: PLAYER_WEEK_COLUMNS,
  team_week: TEAM_WEEK_COLUMNS,
  injury_week: INJURY_WEEK_COLUMNS,
  ep_week: EP_WEEK_COLUMNS,
  espn_xwalk: XWALK_COLUMNS,
});

/** One TSV part in the manifest. */
export interface ExcerptPart {
  readonly path: string;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
}

/** One upstream release file an excerpt was cut from. */
export interface ExcerptUpstream {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** One excerpt file (a header + parts). */
export interface ExcerptFile {
  /** The JSON header, relative to DATA_DIR. */
  readonly path: string;
  readonly table: ExcerptTable;
  readonly season: number | null;
  readonly licence: "CC-BY-4.0" | "CC-BY-SA-4.0";
  readonly rows: number;
  readonly columns: readonly string[];
  readonly parts: readonly ExcerptPart[];
  readonly upstream: readonly ExcerptUpstream[];
}

/** data/manifest.json. */
export interface ExcerptManifest {
  readonly $comment: string;
  readonly retrieved: string;
  readonly files: readonly ExcerptFile[];
}

/** A header file (`*.excerpt.json`). */
export interface ExcerptHeader {
  readonly $comment: string;
  readonly columns: readonly string[];
  readonly rows: number;
  readonly parts: readonly string[];
}
