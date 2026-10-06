// columns.ts — nflverse stat columns → canonical stat names and `toStatLine(nflverse)` (plan 08 §3.2
// table, §3.1 canonical names, §3.3/§3.4 position classes, §4.1 FG buckets; the loader's schema
// assertion is what verifies these column names exist — A-1). The Phase-1 analytics / backtest path.
// PURE: imports only src/domain/scoring/types.ts (no I/O, no store or providers), so it can move into
// src/domain verbatim — the store may not import src/sources. Ported from sibling @521f9f3, adapted
// (plan 08's ESPN canonical vocabulary: separate 2-pt ids, ESPN FG buckets incl. attempts/misses,
// ESPN position ids on the line, the D/ST line of ds_team_defense_week).
import {
  asPositionId,
  type Canonical,
  type PositionClass,
  type PositionId,
  type StatLine,
} from "../../domain/scoring/types.js";

/** One canonical stat and the nflverse columns summed to produce it. */
export interface StatMapping {
  readonly canonical: Canonical;
  /** Summed; a null component counts 0; the stat is absent when every component is null. */
  readonly columns: readonly string[];
  /** The line classes it is emitted for (plan 08 §3.4: the engine gates again by class). */
  readonly position_classes: readonly PositionClass[];
  /** `count` = a non-negative integer (anything else is reported); `measure` may be negative/fractional. */
  readonly kind: "count" | "measure";
  readonly note: string | null;
}

const O: readonly PositionClass[] = Object.freeze(["O"]);
const K: readonly PositionClass[] = Object.freeze(["K"]);

const m = (
  canonical: Canonical,
  columns: readonly string[],
  position_classes: readonly PositionClass[],
  kind: "count" | "measure",
  note: string | null = null,
): StatMapping =>
  Object.freeze({ canonical, columns: Object.freeze([...columns]), position_classes, kind, note });

/**
 * Offence and kicker mappings (plan 08 §3.2; ESPN ids in the notes are plan 08 §3.1's). Absent by
 * design: `kr_td`/`pr_td` (need pbp `play_type`; `ret_td_total` carries the player-level sum),
 * long-TD bonuses (per-play lengths — pbp), `fum_rec_td_off` (pbp), yardage bonuses and `per_n_*`
 * (the engine derives them from the raw yards against the league's bounds), the FG made/missed
 * buckets that need kick distances (fgBuckets below), and `turnovers` (73; a league union).
 */
export const NFLVERSE_STAT_MAP: readonly StatMapping[] = Object.freeze([
  m("pass_att", ["attempts"], O, "count"),
  m("pass_cmp", ["completions"], O, "count"),
  m("pass_yd", ["passing_yards"], O, "measure", "gross passing yards (sack yards not subtracted)"),
  m("pass_td", ["passing_tds"], O, "count"),
  m("pass_int", ["passing_interceptions"], O, "count"),
  m("pass_1d", ["passing_first_downs"], O, "count"),
  m("pass_2pt", ["passing_2pt_conversions"], O, "count", "ESPN 19"),
  m("sacked", ["sacks_suffered"], O, "count", "ESPN 64"),
  m("rush_att", ["carries"], O, "count"),
  m("rush_yd", ["rushing_yards"], O, "measure"),
  m("rush_td", ["rushing_tds"], O, "count"),
  m("rush_1d", ["rushing_first_downs"], O, "count"),
  m("rush_2pt", ["rushing_2pt_conversions"], O, "count", "ESPN 26"),
  m("targets", ["targets"], O, "count"),
  m("rec", ["receptions"], O, "count", "ESPN 53 — the PPR scoring item"),
  m(
    "rec_stat",
    ["receptions"],
    O,
    "count",
    "ESPN 41 — the receptions stat, scored only if a league does",
  ),
  m("rec_yd", ["receiving_yards"], O, "measure"),
  m("rec_td", ["receiving_tds"], O, "count"),
  m("rec_1d", ["receiving_first_downs"], O, "count"),
  m("rec_2pt", ["receiving_2pt_conversions"], O, "count", "ESPN 44"),
  m(
    "two_pt_total",
    ["passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions"],
    O,
    "count",
    "ESPN 62, the union — a league scores it OR 19/26/44 (plan 08 §3.1)",
  ),
  m(
    "fum_lost",
    ["sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"],
    O,
    "count",
    "ESPN 72; a QB's lost fumble on a sack counts [V-05 §3.1]",
  ),
  m("fum", ["sack_fumbles", "rushing_fumbles", "receiving_fumbles"], O, "count", "ESPN 68"),
  m(
    "ret_td_total",
    ["special_teams_tds"],
    O,
    "count",
    "ESPN 105 — player-level return TDs; the kr_td/pr_td split needs pbp (absent)",
  ),
  m("fg_0_39", ["fg_made_0_19", "fg_made_20_29", "fg_made_30_39"], K, "count", "ESPN 80"),
  m("fg_40_49", ["fg_made_40_49"], K, "count", "ESPN 77"),
  m("fg_50_59", ["fg_made_50_59"], K, "count", "ESPN 198"),
  m("fg_60p", ["fg_made_60_"], K, "count", "ESPN 201"),
  m(
    "fg_50p_legacy",
    ["fg_made_50_59", "fg_made_60_"],
    K,
    "count",
    "ESPN 74 — legacy 50+ incl. 60+",
  ),
  m("fg_made_total", ["fg_made"], K, "count", "ESPN 83"),
  m("pat_made", ["pat_made"], K, "count", "ESPN 86"),
  m("pat_att", ["pat_att"], K, "count", "ESPN 87"),
  m(
    "pat_miss",
    ["pat_missed", "pat_blocked"],
    K,
    "count",
    "ESPN 88; a blocked PAT counts as missed [U]",
  ),
]);

/** ESPN's FG distance buckets (plan 08 §3.1 fg_distance bounds): lower, upper (inclusive; null = ∞). */
export const ESPN_FG_BUCKETS: readonly {
  readonly suffix: string;
  readonly lower: number;
  readonly upper: number | null;
  readonly missed: readonly string[];
}[] = Object.freeze([
  {
    suffix: "0_39",
    lower: 0,
    upper: 39,
    missed: ["fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39"],
  },
  { suffix: "40_49", lower: 40, upper: 49, missed: ["fg_missed_40_49"] },
  { suffix: "50_59", lower: 50, upper: 59, missed: ["fg_missed_50_59"] },
  { suffix: "60p", lower: 60, upper: null, missed: ["fg_missed_60_"] },
]);

/** Every nflverse column some mapping reads (the made/missed bucket columns included). */
export const MAPPED_STAT_COLUMNS: readonly string[] = Object.freeze(
  [
    ...new Set([
      ...NFLVERSE_STAT_MAP.flatMap((x) => x.columns),
      ...ESPN_FG_BUCKETS.flatMap((b) => b.missed),
      "fg_missed",
      "fg_blocked",
      "fg_blocked_list",
    ]),
  ].sort(),
);

/** The columns of `available` no mapping reads (usage shares, air yards, fantasy points, …). */
export function unmappedStatColumns(available: readonly string[]): readonly string[] {
  const used = new Set(MAPPED_STAT_COLUMNS);
  return Object.freeze(available.filter((c) => !used.has(c)));
}

/** What a translation noticed (never fatal: the value is dropped or kept as documented). */
export interface TranslationIssue {
  readonly column: string | null;
  readonly issue: string;
}

/** A translated line plus its diagnostics; `line` is null when no position id could be found. */
export interface Translation {
  readonly line: StatLine | null;
  readonly issues: readonly TranslationIssue[];
}

/** Options for a translation. */
export interface TranslateOptions {
  /** Research 04 §B.1.6: any game of the period is not `statsOfficial` (default false). */
  readonly provisional?: boolean;
  /** The ESPN `defaultPositionId` (preferred — overrides key on it, plan 08 §3.4). */
  readonly position?: PositionId;
}

/**
 * nflverse `position` → ESPN position id (research 03 §B.2; mirrors src/providers/espn/types.ts
 * ESPN_POSITIONS, which src/sources may not import — tests hold the two equal).
 */
export const NFLVERSE_POSITION_TO_ESPN: Readonly<Record<string, number>> = Object.freeze({
  QB: 1,
  RB: 2,
  FB: 2,
  HB: 2,
  WR: 3,
  TE: 4,
  K: 5,
  PK: 5,
  P: 7,
  DT: 9,
  NT: 9,
  DE: 10,
  EDGE: 10,
  LB: 11,
  ILB: 11,
  MLB: 11,
  OLB: 11,
  CB: 12,
  DB: 12,
  S: 13,
  SS: 13,
  FS: 13,
  SAF: 13,
});

/** ESPN position id → scoring class (plan 08 §3.3; mirrors ESPN_POSITIONS' `class`). */
export const ESPN_POSITION_CLASS: Readonly<Record<number, PositionClass>> = Object.freeze({
  1: "O",
  2: "O",
  3: "O",
  4: "O",
  5: "K",
  7: "K",
  9: "IDP",
  10: "IDP",
  11: "IDP",
  12: "IDP",
  13: "IDP",
  14: "HC",
  15: "O",
  16: "DST",
});

/** The ESPN D/ST position id (16). */
export const DST_POSITION: PositionId = asPositionId(16);

/** The ESPN position id of an nflverse row (position, then a skill position_group), or null. */
export function espnPositionOf(position: unknown, positionGroup: unknown): PositionId | null {
  const norm = (v: unknown): string => (typeof v === "string" ? v.trim().toUpperCase() : "");
  const id =
    NFLVERSE_POSITION_TO_ESPN[norm(position)] ?? NFLVERSE_POSITION_TO_ESPN[norm(positionGroup)];
  return id === undefined ? null : asPositionId(id);
}

function numeric(v: unknown): { readonly value: number | null; readonly bad: string | null } {
  if (v === null || v === undefined) return { value: null, bad: null };
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? { value: n, bad: null } : { value: null, bad: "out of range" };
  }
  if (typeof v !== "number") return { value: null, bad: `not a number (${typeof v})` };
  if (!Number.isFinite(v)) return { value: null, bad: "not finite" };
  return { value: v, bad: null };
}

function sumColumns(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
  kind: "count" | "measure",
  issues: TranslationIssue[],
): number | null {
  let total: number | null = null;
  for (const col of columns) {
    const { value, bad } = numeric(row[col]);
    if (bad !== null) issues.push({ column: col, issue: bad });
    if (value === null) continue;
    if (kind === "count" && (value < 0 || !Number.isInteger(value))) {
      issues.push({ column: col, issue: `count is ${String(value)}` });
    }
    total = (total ?? 0) + value;
  }
  return total;
}

function buildLine(
  values: Record<string, number>,
  position: PositionId,
  positionClass: PositionClass,
  provisional: boolean,
): StatLine {
  return Object.freeze({
    values: Object.freeze(values),
    present: Object.freeze(Object.keys(values).sort()),
    position,
    position_class: positionClass,
    provisional,
    source: "nflverse",
  });
}

/** Longest `fg_*_list` accepted (a kicker attempts a handful of kicks a game). */
const MAX_KICK_LIST = 400;

/**
 * The kick distances of an nflverse `fg_made_list` / `fg_missed_list` / `fg_blocked_list` (`"51;43"`)
 * — the input for a league's own FG-distance brackets (plan 08 §4.1). Tokens that are not integers
 * 1–99 are skipped; a non-string or oversize value → [].
 */
export function kickDistances(list: unknown): readonly number[] {
  if (typeof list !== "string" || list.length > MAX_KICK_LIST) return [];
  const out: number[] = [];
  for (const tok of list.split(";")) {
    const t = tok.trim();
    if (!/^\d{1,2}$/.test(t)) continue;
    const n = Number(t);
    if (n >= 1) out.push(n);
  }
  return out;
}

/** The ESPN bucket suffix of a kick distance (the buckets cover [0, ∞)). */
function bucketOf(distance: number): string {
  if (distance <= 39) return "0_39";
  if (distance <= 49) return "40_49";
  return distance <= 59 ? "50_59" : "60p";
}

/**
 * The missed and attempted FG buckets (plan 08 §3.1 `fgm_*` missed / `fga_*` attempted, attempted =
 * made + missed per bucket). nflverse's per-bucket misses EXCLUDE blocked kicks (fg_att = made +
 * missed + blocked, verified on the 2026 file); a blocked kick counts as missed here [U], placed in
 * its bucket from `fg_blocked_list`. When that list does not account for every block, the blocks
 * stay out of the buckets (an issue says so) but are still in the totals.
 */
function fgBuckets(
  row: Readonly<Record<string, unknown>>,
  issues: TranslationIssue[],
): Record<string, number> {
  const out: Record<string, number> = {};
  const blocked = numeric(row.fg_blocked).value ?? 0;
  const blockedAt = kickDistances(row.fg_blocked_list);
  const placeBlocks = blockedAt.length === blocked;
  if (!placeBlocks) {
    issues.push({
      column: "fg_blocked_list",
      issue: "does not match fg_blocked; blocks left out of the buckets",
    });
  }
  const made = (suffix: string): number | null => {
    const mp = NFLVERSE_STAT_MAP.find((x) => x.canonical === `fg_${suffix}`);
    return mp ? sumColumns(row, mp.columns, "count", []) : null;
  };
  for (const b of ESPN_FG_BUCKETS) {
    const missedCols = sumColumns(row, b.missed, "count", issues);
    if (missedCols === null) continue;
    const blocks = placeBlocks ? blockedAt.filter((d) => bucketOf(d) === b.suffix).length : 0;
    const missed = missedCols + blocks;
    out[`fgm_${b.suffix}`] = missed;
    const mk = made(b.suffix);
    if (mk !== null) out[`fga_${b.suffix}`] = mk + missed;
  }
  const m50 = out.fgm_50_59;
  const m60 = out.fgm_60p;
  if (m50 !== undefined && m60 !== undefined) out.fgm_50p_legacy = m50 + m60;
  const a50 = out.fga_50_59;
  const a60 = out.fga_60p;
  if (a50 !== undefined && a60 !== undefined) out.fga_50p_legacy = a50 + a60;
  const missedTotal = sumColumns(row, ["fg_missed", "fg_blocked"], "count", issues);
  if (missedTotal !== null) out.fgm_total = missedTotal;
  const madeTotal = numeric(row.fg_made).value;
  if (madeTotal !== null && missedTotal !== null) out.fga_total = madeTotal + missedTotal;
  return out;
}

/**
 * Translates one nflverse `stats_player_week` row (or a `ds_stats_player_week` row — same column
 * names) into a canonical StatLine (plan 08 §2/§3.2). A null column is ABSENT (not 0); a sum is
 * present when any component is. Only the mappings for the line's class are emitted (IDP and HC:
 * none — plan 08 [U-5]). Non-numeric or non-finite values never reach the line (NaN-free by
 * construction) and are reported. `opts.position` (the ESPN id) wins over the nflverse position.
 */
export function translatePlayerWeek(
  row: Readonly<Record<string, unknown>>,
  opts: TranslateOptions = {},
): Translation {
  const issues: TranslationIssue[] = [];
  const position = opts.position ?? espnPositionOf(row.position, row.position_group);
  if (position === null) {
    issues.push({ column: "position", issue: "no ESPN position id for this row" });
    return { line: null, issues };
  }
  const cls = ESPN_POSITION_CLASS[position];
  if (cls === undefined) {
    issues.push({ column: "position", issue: `unknown ESPN position id ${String(position)}` });
    return { line: null, issues };
  }
  const values: Record<string, number> = {};
  if (cls === "IDP" || cls === "HC" || cls === "DST") {
    issues.push({ column: null, issue: `no player-week mapping for class ${cls}` });
  }
  for (const x of NFLVERSE_STAT_MAP) {
    if (!x.position_classes.includes(cls)) continue;
    const v = sumColumns(row, x.columns, x.kind, issues);
    if (v !== null) values[x.canonical] = v;
  }
  if (cls === "K") Object.assign(values, fgBuckets(row, issues));
  return { line: buildLine(values, position, cls, opts.provisional ?? false), issues };
}

/** `toStatLine(nflverse)` (plan 08 §3.2): the line only (null when no position id is known). */
export function toStatLine(
  row: Readonly<Record<string, unknown>>,
  opts: TranslateOptions = {},
): StatLine | null {
  return translatePlayerWeek(row, opts).line;
}

/** Options for a team-defence line. */
export interface DefenseOptions {
  /** The opponent's points (dst_pa_raw, definition [U-6]); null/absent → no dst_pa_raw. */
  readonly pointsAllowed?: number | null;
  /** Count blocked PATs in `dst_blk` (a league rule, plan 08 [U]); default false. */
  readonly includePatBlocks?: boolean;
  readonly provisional?: boolean;
}

/**
 * The D/ST StatLine of one `ds_team_defense_week` row (tables.ts READER_QUERIES
 * `PlayerWeekReader.defenseLines` mapping): dst_sack, dst_int, dst_ff, dst_fr, dst_int_td (def_tds),
 * dst_fr_td (the derived fumble-return TDs) — both disputed ids 103/104 (E9) —, dst_ret_td
 * (special_teams_tds), dst_safety, dst_blk (FG + punt blocks, + PAT blocks when asked), dst_kr_yd,
 * dst_pr_yd, dst_pa_raw (the scalar the engine brackets, plan 08 §4.1), dst_ya_raw = opponent passing
 * − sack yards + rushing (all three needed; ESPN's definition is [U]).
 */
export function toDefenseStatLine(
  row: Readonly<Record<string, unknown>>,
  opts: DefenseOptions = {},
): Translation {
  const issues: TranslationIssue[] = [];
  const values: Record<string, number> = {};
  const put = (canonical: string, cols: readonly string[], kind: "count" | "measure"): void => {
    const v = sumColumns(row, cols, kind, issues);
    if (v !== null) values[canonical] = v;
  };
  put("dst_sack", ["def_sacks"], "measure"); // half sacks are legitimate
  put("dst_int", ["def_interceptions"], "count");
  put("dst_ff", ["def_fumbles_forced"], "count");
  put("dst_fr", ["fumble_recovery_opp"], "count");
  put("dst_int_td", ["def_tds"], "count");
  put("dst_fr_td", ["fumble_recovery_tds_opp"], "count");
  put("dst_ret_td", ["special_teams_tds"], "count");
  put("dst_safety", ["def_safeties"], "count");
  put(
    "dst_blk",
    opts.includePatBlocks
      ? ["def_fg_blocks", "def_punt_blocks", "def_pat_blocks"]
      : ["def_fg_blocks", "def_punt_blocks"],
    "count",
  );
  put("dst_kr_yd", ["kickoff_return_yards"], "measure");
  put("dst_pr_yd", ["punt_return_yards"], "measure");
  const pa = numeric(opts.pointsAllowed);
  if (pa.bad !== null) issues.push({ column: "points_allowed", issue: pa.bad });
  if (pa.value !== null) values.dst_pa_raw = pa.value;
  const pass = numeric(row.opp_passing_yards).value;
  const sackYds = numeric(row.opp_sack_yards_lost).value;
  const rush = numeric(row.opp_rushing_yards).value;
  if (pass !== null && sackYds !== null && rush !== null) values.dst_ya_raw = pass - sackYds + rush;
  return { line: buildLine(values, DST_POSITION, "DST", opts.provisional ?? false), issues };
}

/**
 * The opponent's final score for `team` in a game row (`away_team`, `home_team`, `away_score`,
 * `home_score`) — dst_pa definition (a) of plan 08 §3.2 [U-6]; null when the team did not play in it
 * or a score is missing.
 */
export function pointsAllowedFor(
  team: string,
  game: Readonly<Record<string, unknown>>,
): number | null {
  const away = numeric(game.away_score).value;
  const home = numeric(game.home_score).value;
  if (away === null || home === null) return null;
  if (game.home_team === team) return away;
  if (game.away_team === team) return home;
  return null;
}
