// nflverse.ts — `toStatLine(nflverse)` (plan 08 §3.2, E8): ds_stats_player_week rows and
// ds_team_defense_week rows (src/store/datasets/tables.ts column names, verbatim) → canonical lines,
// with ESPN's conventions measured on the recorded fixtures (2026 weeks 1–3, every rostered
// player-week joined on espn_id): blocked FGs and blocked PATs count as MISSES; yards allowed is
// passing + rushing − |sack yards| (70/70 D/ST weeks; nflverse stores sack yards negative); points
// allowed nets out the opponent defence's INT/fumble-return TDs (6 each — the try after them still
// counts) and safeties but not kick/punt-return TDs (U-6 pinned 70/70 by plan 10 B13: seven
// discriminating weeks, docs/evals/phase2-engine-families.md). Phase 2 (plan 08 §4.3, plan 10 B13):
// long-TD counts from ds_pbp scoring plays (530/530 recorded player-weeks equal ESPN's 15/16/35/36/
// 45/46) and the points-/yards-allowed facts from the opponent's ds_stats_team_week row. Pure.
// Ported from sibling @cf3b015 (coercion, kick lists), adapted.
import { ScoringError } from "./errors.js";
import { finiteWithin, MAX_ABS_STAT } from "./numeric.js";
import { CANONICAL_DEFS } from "./registry.js";
import { positionClassOf } from "./stat_map.js";
import type { Canonical, StatLine } from "./types.js";
import { asPositionId } from "./types.js";

/** A row as a reader returns it: column → SQLite/parquet value (number, bigint, string, null). */
export type NflverseRow = Readonly<Record<string, unknown>>;

/** Plain decimal only: optional sign, digits with an optional fraction (no exponent, no hex). */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
/** Longest scalar string considered. */
const MAX_SCALAR_LEN = 32;

/**
 * A reader value as a stat (plan 08 §3.2): a finite number within ±MAX_ABS_STAT, a safe bigint, or
 * a plain decimal string; `null`, `undefined`, `""`, `"1e2"`, `"NaN"` and everything else → null
 * (NOT PRESENT — never 0, never NaN).
 */
export function coerceScalar(raw: unknown): number | null {
  let v: number;
  if (typeof raw === "number") v = raw;
  else if (typeof raw === "bigint") v = Number(raw);
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (s.length > MAX_SCALAR_LEN || !DECIMAL_RE.test(s)) return null;
    v = Number(s);
  } else return null;
  if (!finiteWithin(v, MAX_ABS_STAT)) return null;
  return v === 0 ? 0 : v;
}

function col(row: NflverseRow, column: string): number | null {
  return Object.hasOwn(row, column) ? coerceScalar(row[column]) : null;
}

/** Σ of the non-null columns, or null when every column is null/absent. */
function sumCols(row: NflverseRow, columns: readonly string[]): number | null {
  let total: number | null = null;
  for (const c of columns) {
    const v = col(row, c);
    if (v !== null) total = (total ?? 0) + v;
  }
  return total;
}

/** nflverse `position` → ESPN position id (QB 1, RB 2, WR 3, TE 4, K 5, P 7, IDP 9–13), or null. */
export function espnPositionForNflverse(position: unknown): number | null {
  const p = typeof position === "string" ? position.trim().toUpperCase() : "";
  const map: Readonly<Record<string, number>> = {
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
    DL: 9,
    DE: 10,
    EDGE: 10,
    LB: 11,
    ILB: 11,
    OLB: 11,
    MLB: 11,
    CB: 12,
    DB: 12,
    S: 13,
    SS: 13,
    FS: 13,
    SAF: 13,
  };
  // upper-cased keys never name an Object.prototype member
  return map[p] ?? null;
}

/** Longest `fg_*_list` string parsed (a team kicks far fewer than 50 FGs in a game). */
const MAX_LIST_LEN = 400;

/**
 * Parses an nflverse `;`-separated kick-distance list (`"51;43"`); null/"" → no kicks. Throws
 * `invalid_line` for a token that is not an integer distance in 0..120 or an absurd length.
 */
export function parseKickList(list: unknown): readonly number[] {
  if (list === null || list === undefined) return [];
  if (typeof list !== "string" || list.length > MAX_LIST_LEN) {
    throw new ScoringError("invalid_line", "kick list must be a short string");
  }
  if (list.trim() === "") return [];
  return list.split(";").map((tok) => {
    const v = coerceScalar(tok);
    if (v === null || !Number.isInteger(v) || v < 0 || v > 120) {
      throw new ScoringError("invalid_line", "kick distance is not an integer yardage", [
        tok.slice(0, 20),
      ]);
    }
    return v;
  });
}

/** The FG bucket canonicals of each kick family, with bounds (ESPN's fixed buckets). */
const FG_BUCKETS = (name: "fg_distance" | "fg_attempt" | "fg_miss") =>
  CANONICAL_DEFS.flatMap((d) =>
    d.family !== null && d.family.name === name
      ? [{ canonical: d.canonical, lower: d.family.lower, upper: d.family.upper }]
      : [],
  );
const MADE = FG_BUCKETS("fg_distance");
const MISSED = FG_BUCKETS("fg_miss");
const ATTEMPTED = FG_BUCKETS("fg_attempt");

function countInto(
  out: Record<Canonical, number>,
  buckets: readonly { canonical: Canonical; lower: number; upper: number | null }[],
  kicks: readonly number[],
): void {
  for (const b of buckets) {
    out[b.canonical] = kicks.filter(
      (d) => d >= b.lower && (b.upper === null || d <= b.upper),
    ).length;
  }
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** How a translated line is labelled. */
export interface LineOptions {
  /** Any game of the period is not final yet. Default false. */
  readonly provisional?: boolean;
  /** Provenance label. Default `nflverse`. */
  readonly source?: string;
}

/** Freezes a canonical line: null values are NOT present; `present` is the sorted key set. */
function makeLine(
  values: Readonly<Record<Canonical, number | null>>,
  position: number,
  opts: LineOptions,
): StatLine {
  const out: Record<Canonical, number> = {};
  for (const [k, v] of Object.entries(values)) if (v !== null) out[k] = v === 0 ? 0 : v;
  return Object.freeze({
    values: Object.freeze(out),
    present: Object.freeze(Object.keys(out).sort()),
    position: asPositionId(position),
    position_class: positionClassOf(position),
    provisional: opts.provisional === true,
    source: opts.source ?? "nflverse",
  });
}

/** Options for a player-week line. */
export interface PlayerWeekOptions extends LineOptions {
  /** The player's ESPN position id (crosswalked `defaultPositionId`); default from `row.position`. */
  readonly position?: number;
  /**
   * The player-week's long-TD counts (`longTdCounts` over its ds_pbp scoring plays — plan 08 §4.3,
   * Phase 2). Absent or null: the long-TD members stay absent and are underivable from the weekly
   * row unless the TD count is zero (the Phase-1 behaviour).
   */
  readonly long_tds?: LongTdCounts | null;
}

/**
 * `toStatLine(nflverse)` for a `ds_stats_player_week` row (plan 08 §3.2). Every mapped column with
 * a non-null value becomes present (a present 0 stays 0). Per-N items, yardage bonuses and a
 * league's tiers are left to the engine (it bracketizes the scalars); long-TD bonuses are present
 * only when `opts.long_tds` supplies the pbp counts (checked against the row's TD counts), and the
 * kick/punt-return split is absent (underivable from weekly totals unless their base is zero).
 * Kicks come from the distance lists (blocked counted as missed — recorded) when the row has
 * attempts. Throws `invalid_line` when no position can be resolved or `long_tds` is inconsistent.
 */
export function statLineFromPlayerWeek(row: NflverseRow, opts: PlayerWeekOptions = {}): StatLine {
  const position = opts.position ?? espnPositionForNflverse(row.position);
  if (position === null) throw new ScoringError("invalid_line", "row has no fantasy position");
  const att = col(row, "attempts");
  const cmp = col(row, "completions");
  const passYd = col(row, "passing_yards");
  const rushYd = col(row, "rushing_yards");
  const recYd = col(row, "receiving_yards");
  const rec = col(row, "receptions");
  const stTds = col(row, "special_teams_tds");
  const recTds = col(row, "fumble_recovery_tds");
  const own = col(row, "fumble_recovery_own") ?? 0;
  const v: Record<Canonical, number | null> = {
    pass_att: att,
    pass_cmp: cmp,
    pass_inc: att === null || cmp === null ? null : att - cmp,
    pass_yd: passYd,
    pass_ypg: passYd,
    pass_td: col(row, "passing_tds"),
    pass_int: col(row, "passing_interceptions"),
    sacked: col(row, "sacks_suffered"),
    pass_1d: col(row, "passing_first_downs"),
    pass_2pt: col(row, "passing_2pt_conversions"),
    rush_att: col(row, "carries"),
    rush_yd: rushYd,
    rush_ypg: rushYd,
    rush_td: col(row, "rushing_tds"),
    rush_1d: col(row, "rushing_first_downs"),
    rush_2pt: col(row, "rushing_2pt_conversions"),
    rec,
    rec_stat: rec,
    targets: col(row, "targets"),
    rec_yd: recYd,
    rec_ypg: recYd,
    rec_td: col(row, "receiving_tds"),
    rec_1d: col(row, "receiving_first_downs"),
    rec_2pt: col(row, "receiving_2pt_conversions"),
    two_pt_total: sumCols(row, [
      "passing_2pt_conversions",
      "rushing_2pt_conversions",
      "receiving_2pt_conversions",
    ]),
    fum: sumCols(row, ["sack_fumbles", "rushing_fumbles", "receiving_fumbles"]),
    fum_lost: sumCols(row, ["sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"]),
    turnovers: sumCols(row, [
      "passing_interceptions",
      "sack_fumbles_lost",
      "rushing_fumbles_lost",
      "receiving_fumbles_lost",
    ]),
    // [U] an own-fumble recovery TD by an offensive player (ESPN 63): capped at own recoveries
    fum_rec_td_off: recTds === null ? null : own > 0 ? Math.min(recTds, own) : 0,
    ret_td_total: stTds,
    kr_td: stTds === 0 ? 0 : null,
    pr_td: stTds === 0 ? 0 : null,
    kr_yd: col(row, "kickoff_return_yards"),
    pr_yd: col(row, "punt_return_yards"),
    gp: 1,
  };
  const fgAtt = col(row, "fg_att");
  if (fgAtt !== null) {
    const made = parseKickList(row.fg_made_list);
    const missed = [...parseKickList(row.fg_missed_list), ...parseKickList(row.fg_blocked_list)];
    const counts: Record<Canonical, number> = {};
    countInto(counts, MADE, made);
    countInto(counts, MISSED, missed);
    countInto(counts, ATTEMPTED, [...made, ...missed]);
    Object.assign(v, counts, {
      fg_made_total: made.length,
      fg_miss_total: missed.length,
      fg_att_total: fgAtt,
      fg_yd: sum(made),
      fg_yd_miss: sum(missed),
      fg_yd_att: sum(made) + sum(missed),
    });
  }
  const patAtt = col(row, "pat_att");
  if (patAtt !== null) {
    Object.assign(v, {
      pat_att: patAtt,
      pat_made: col(row, "pat_made"),
      pat_miss: sumCols(row, ["pat_missed", "pat_blocked"]),
    });
  }
  if (opts.long_tds !== undefined && opts.long_tds !== null) {
    Object.assign(v, checkLongTds(opts.long_tds, v));
  }
  return makeLine(v, position, opts);
}

// --- Phase 2: long-TD lengths from ds_pbp scoring plays (plan 08 §4.3; plan 10 B13) -------------

/** The registry's `long_td_bonus` members: canonical, the TD count it refines, the length bound. */
const LONG_TD_DEFS: readonly { canonical: Canonical; scalar: Canonical; lower: number }[] =
  Object.freeze(
    CANONICAL_DEFS.flatMap((d) =>
      d.family !== null && d.family.name === "long_td_bonus"
        ? [{ canonical: d.canonical, scalar: d.family.scalar, lower: d.family.lower }]
        : [],
    ).sort((a, b) => a.scalar.localeCompare(b.scalar) || a.lower - b.lower),
  );

/** Every long-TD member canonical (`pass_td_40`, …, `rec_td_50`), in registry-scalar order. */
export const LONG_TD_CANONICALS: readonly Canonical[] = Object.freeze(
  LONG_TD_DEFS.map((d) => d.canonical),
);

/** One player-week's long-TD counts, keyed by the long-TD member canonicals. */
export type LongTdCounts = Readonly<Record<Canonical, number>>;

/** The most plays one call reads (a season holds ~50,000 plays; one week's scoring plays far fewer). */
export const MAX_PLAYS = 60_000;
/** The longest gsis id / team abbreviation accepted (gsis `00-0012345`; teams are ≤ 3 letters). */
const MAX_ID_LEN = 32;

function checkPlays(plays: unknown): readonly NflverseRow[] {
  if (!Array.isArray(plays) || plays.length > MAX_PLAYS) {
    throw new ScoringError(
      "invalid_line",
      `plays must be an array of at most ${String(MAX_PLAYS)}`,
    );
  }
  for (const p of plays as unknown[]) {
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      throw new ScoringError("invalid_line", "every play must be an object");
    }
  }
  return plays as readonly NflverseRow[];
}

function checkId(id: unknown, what: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LEN) {
    throw new ScoringError("invalid_line", `${what} must be a non-empty short string`);
  }
  return id;
}

/** A ds_pbp text column (an id or a team): the string, or null for anything else. */
function textOf(row: NflverseRow, column: string): string | null {
  const v = Object.hasOwn(row, column) ? row[column] : null;
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN ? v : null;
}

/** A ds_pbp 0/1 indicator column: true only for a value that coerces to exactly 1. */
const flagOf = (row: NflverseRow, column: string): boolean => col(row, column) === 1;

/**
 * Long-TD counts of one player-week from ds_pbp scoring plays (plan 08 §4.3; `PbpReader.scoringPlays`
 * rows): a pass TD's length (`yards_gained`) counts for its passer (`pass_td_*`) and its scorer
 * `td_player_id` (`rec_td_*`); a rush TD's for its scorer (`rush_td_*`); each member counts the TDs
 * at least its bound long, so a 50+ yard TD sets both the 40+ and the 50+ member (cumulative, as
 * ESPN's raw lines show). Equals ESPN's raw 15/16/35/36/45/46 on 530/530 recorded player-weeks
 * (tests/golden/nflverse-phase2.test.ts). Returns null when one of the player's TDs has no integer
 * length (underivable, never a guess). Throws `invalid_line` on a malformed id or play list.
 */
export function longTdCounts(plays: readonly NflverseRow[], gsisId: string): LongTdCounts | null {
  const id = checkId(gsisId, "gsis id");
  const tds: { scalar: Canonical; yards: number }[] = [];
  for (const p of checkPlays(plays)) {
    const pass = flagOf(p, "pass_touchdown");
    const rush = flagOf(p, "rush_touchdown");
    const roles: Canonical[] = [];
    if (pass && textOf(p, "passer_player_id") === id) roles.push("pass_td");
    if (pass && textOf(p, "td_player_id") === id) roles.push("rec_td");
    if (rush && textOf(p, "td_player_id") === id) roles.push("rush_td");
    if (roles.length === 0) continue;
    const yards = col(p, "yards_gained");
    if (yards === null || !Number.isInteger(yards)) return null;
    for (const scalar of roles) tds.push({ scalar, yards });
  }
  return Object.freeze(
    Object.fromEntries(
      LONG_TD_DEFS.map((d) => [
        d.canonical,
        tds.filter((t) => t.scalar === d.scalar && t.yards >= d.lower).length,
      ]),
    ),
  );
}

/** The most TDs of one kind a player-week can carry (far above any NFL game). */
const MAX_TDS = 20;

/**
 * Validates supplied long-TD counts against the weekly row (`v`, the line's values so far): only
 * long-TD canonicals, each a whole number in 0..MAX_TDS, cumulative per TD kind (a longer bound never
 * counts more TDs than a shorter one), and never more than the row's TD count when it has one.
 */
function checkLongTds(
  counts: LongTdCounts,
  v: Readonly<Record<Canonical, number | null>>,
): Record<Canonical, number> {
  const raw: unknown = counts;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScoringError("invalid_line", "long_tds must be an object");
  }
  const out: Record<Canonical, number> = {};
  for (const [k, n] of Object.entries(raw as Record<string, unknown>)) {
    if (!LONG_TD_CANONICALS.includes(k)) {
      throw new ScoringError("invalid_line", "long_tds carries a non-long-TD stat", [k]);
    }
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_TDS) {
      throw new ScoringError("invalid_line", "a long-TD count must be a whole number 0..20", [k]);
    }
    out[k] = n;
  }
  let prior: { scalar: Canonical; count: number } | null = null;
  for (const d of LONG_TD_DEFS) {
    const n = out[d.canonical];
    if (n === undefined) continue;
    const base = v[d.scalar];
    if (prior !== null && prior.scalar === d.scalar && n > prior.count) {
      throw new ScoringError("invalid_line", "long-TD counts must be cumulative", [d.canonical]);
    }
    if (base !== undefined && base !== null && n > base) {
      throw new ScoringError("invalid_line", "more long TDs than TDs", [d.canonical]);
    }
    prior = { scalar: d.scalar, count: n };
  }
  return out;
}

/** Which points-allowed definition a D/ST line uses (plan 08 §3.2 U-6). */
export type PointsAllowedDefinition = "net_of_defense" | "final_score";

/** The game facts points allowed is computed from. */
export interface PointsAllowedInput {
  /** The opponent's final score. */
  readonly score: number;
  /** TDs the OPPONENT's defence scored on this team's offence: interception returns. */
  readonly opponent_int_tds?: number;
  /** … fumble returns. */
  readonly opponent_fumble_tds?: number;
  /** Safeties the opponent's defence scored. */
  readonly opponent_safeties?: number;
}

/**
 * Points allowed (plan 08 §3.2 U-6, pinned by plan 10 B13): `net_of_defense` (default — ESPN's stat
 * 120 on 70/70 recorded D/ST weeks with pbp-exact facts, `DST_POINTS_ALLOWED_EVIDENCE`) = score −
 * 6 × (opponent INT- and fumble-return TDs) − 2 × opponent safeties, floored at 0; the try after a
 * netted TD is NOT netted; `final_score` = the opponent's score (wrong on the 6 recorded weeks with
 * a defensive score). Kick- and punt-return TDs count against the D/ST under both. Throws
 * `invalid_line` on a negative or non-finite input.
 */
export function pointsAllowed(
  input: PointsAllowedInput,
  definition: PointsAllowedDefinition = "net_of_defense",
): number {
  const parts = [
    input.score,
    input.opponent_int_tds ?? 0,
    input.opponent_fumble_tds ?? 0,
    input.opponent_safeties ?? 0,
  ];
  if (!parts.every((p) => finiteWithin(p, MAX_ABS_STAT) && p >= 0)) {
    throw new ScoringError("invalid_line", "points-allowed inputs must be finite and non-negative");
  }
  const [score, ints, fums, safeties] = parts as [number, number, number, number];
  if (definition === "final_score") return score;
  return Math.max(0, score - 6 * (ints + fums) - 2 * safeties);
}

/** Options for a team-defence line. */
export interface DefenseLineOptions extends LineOptions {
  /** The game facts for points allowed, or null when the game has no final score (dst_pa absent). */
  readonly pointsAllowed: PointsAllowedInput | null;
  readonly definition?: PointsAllowedDefinition;
}

/**
 * The D/ST line (ESPN position 16) of a `ds_team_defense_week` row (plan 08 §3.2): sacks, INTs,
 * forced fumbles, recoveries, INT-return TDs (103 ← def_tds) and fumble-return TDs (104 ←
 * fumble_recovery_tds_opp) — both E9-verified 70/70 — their combined 94, safeties, blocked kicks
 * (FG + punt + PAT — 70/70), return yards, total return TDs (105 = special-teams + defensive TDs,
 * recorded), points and yards allowed as raw scalars (the engine bracketizes the league's tiers).
 */
export function statLineFromTeamDefense(row: NflverseRow, opts: DefenseLineOptions): StatLine {
  const intTd = col(row, "def_tds");
  const frTd = col(row, "fumble_recovery_tds_opp");
  const stTds = col(row, "special_teams_tds");
  const pass = col(row, "opp_passing_yards");
  const rush = col(row, "opp_rushing_yards");
  const sackYards = Math.abs(col(row, "opp_sack_yards_lost") ?? 0);
  const v: Record<Canonical, number | null> = {
    dst_sack: col(row, "def_sacks"),
    dst_int: col(row, "def_interceptions"),
    dst_ff: col(row, "def_fumbles_forced"),
    dst_fr: col(row, "fumble_recovery_opp"),
    dst_int_td: intTd,
    dst_fr_td: frTd,
    dst_td: sumCols(row, ["def_tds", "fumble_recovery_tds_opp"]),
    dst_safety: col(row, "def_safeties"),
    dst_blk: sumCols(row, ["def_fg_blocks", "def_punt_blocks", "def_pat_blocks"]),
    kr_yd: col(row, "kickoff_return_yards"),
    pr_yd: col(row, "punt_return_yards"),
    ret_td_total: sumCols(row, ["special_teams_tds", "def_tds", "fumble_recovery_tds_opp"]),
    kr_td: stTds === 0 ? 0 : null,
    pr_td: stTds === 0 ? 0 : null,
    dst_blk_td: stTds === 0 ? 0 : null,
    dst_pa_raw:
      opts.pointsAllowed === null ? null : pointsAllowed(opts.pointsAllowed, opts.definition),
    dst_ya_raw: pass === null || rush === null ? null : pass + rush - sackYards,
    gp: 1,
  };
  return makeLine(v, 16, opts);
}

// --- Phase 2: the points- and yards-allowed facts (plan 08 §3.2 U-6; plan 10 B13) ---------------

/**
 * U-6 pinned (plan 08 §3.2, §11; plan 10 B13), re-derived by tests/golden/nflverse-phase2.test.ts
 * from fixtures/espn/recorded (ESPN's stat 120) and fixtures/golden/nflverse-phase2-evidence.json
 * (nflverse games + pbp + stats_team_week, sha256-pinned): ESPN's points allowed is the opponent's
 * final score net of its defence's interception- and fumble-return TDs against this team's offence
 * (6 each; the try after them still counts) and of its safeties (2 each, a penalty safety included);
 * kick- and punt-return TDs are NOT netted. `final_score` misses every week with a defensive score.
 */
export const DST_POINTS_ALLOWED_EVIDENCE = Object.freeze({
  definition: "net_of_defense" as const,
  recorded_dst_weeks: 70,
  net_of_defense_matches: 70,
  final_score_matches: 64,
  /** Recorded D/ST weeks whose opponent scored each kind (the weeks that discriminate). */
  weeks_with: Object.freeze({
    int_return_td: 3,
    fumble_return_td: 2,
    safety: 1,
    punt_return_td: 1,
  }),
  /** Tries after a netted TD: counted against the D/ST (good) / nothing to count (failed). */
  tries_after_netted_td: Object.freeze({ good: 4, failed: 1 }),
  /** Never seen in a recorded week, so their treatment is the [U] reading named in pointsAllowed. */
  unobserved: Object.freeze([
    "kickoff_return_td",
    "blocked_kick_return_td",
    "defensive_conversion_return",
    "net_below_zero",
  ]),
});

/** Play types on which a defence's TD is a return TD against the OFFENCE (the ones ESPN nets). */
const SCRIMMAGE_PLAY_TYPES: ReadonlySet<string> = new Set(["pass", "run", "qb_kneel", "qb_spike"]);

/** What one defence scored against the other team in one game (plan 08 §3.2 U-6). */
export interface DefenseScores {
  /** Interception-return TDs on scrimmage plays. */
  readonly int_return_tds: number;
  /** Fumble-return (any non-interception) TDs by the defence on scrimmage plays. */
  readonly fumble_return_tds: number;
  /** Safeties credited to the defence (`defteam`), on any play — a penalty safety is a `no_play`. */
  readonly safeties: number;
}

/**
 * The scores `defence` made against the other team's offence, from one game's ds_pbp rows
 * (`posteam`/`defteam`/`td_team`/`touchdown`/`interception`/`safety`/`play_type`): a TD by the
 * defence on a scrimmage play (pass, run, kneel, spike) is an interception return when the play has
 * `interception = 1`, else a fumble return; punt, kickoff, FG and try plays are special teams (not
 * netted); a `no_play` row never carries a TD but can carry a penalty safety. Note: ds_pbp's
 * row filter drops `no_play` rows, so safeties from the store's pbp miss a penalty safety (1 of the
 * 70 recorded weeks) — `pointsAllowedFromTeamWeek` takes safeties from the team-week row instead.
 * Throws `invalid_line` on a malformed team or play list.
 */
export function defenseScoresFromPlays(
  plays: readonly NflverseRow[],
  defence: string,
): DefenseScores {
  const team = checkId(defence, "defence team");
  let ints = 0;
  let fums = 0;
  let safeties = 0;
  for (const p of checkPlays(plays)) {
    if (textOf(p, "defteam") !== team) continue;
    if (flagOf(p, "safety")) safeties += 1;
    const type = textOf(p, "play_type");
    if (
      flagOf(p, "touchdown") &&
      textOf(p, "td_team") === team &&
      type !== null &&
      SCRIMMAGE_PLAY_TYPES.has(type)
    ) {
      if (flagOf(p, "interception")) ints += 1;
      else fums += 1;
    }
  }
  return Object.freeze({ int_return_tds: ints, fumble_return_tds: fums, safeties });
}

/** A team-week count column: absent/NULL counts 0 (the dataset convention); else a whole number ≥ 0. */
function countCol(row: NflverseRow, column: string): number {
  const v = col(row, column);
  if (v === null) return 0;
  if (!Number.isInteger(v) || v < 0) {
    throw new ScoringError("invalid_line", "a team-week count must be a whole number ≥ 0", [
      column,
    ]);
  }
  return v;
}

function checkRow(row: unknown): NflverseRow {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new ScoringError("invalid_line", "a team-week row must be an object");
  }
  return row as NflverseRow;
}

/**
 * The facts `pointsAllowed` reads, from the OPPONENT's `ds_stats_team_week` row and its final score
 * (plan 08 §3.2 U-6; 70/70 recorded D/ST weeks): interception-return TDs ← `def_tds`, fumble-return
 * TDs ← min(`fumble_recovery_tds`, `fumble_recovery_opp`) when the defence recovered a fumble,
 * safeties ← `def_safeties` (a penalty safety included). The min() reading cannot tell an offensive
 * own-recovery TD from a defensive one (it over-counts on 5 of 1,268 team-games 2024–2026), so when
 * `plays` — that game's ds_pbp rows — are given, both TD counts come from `defenseScoresFromPlays`
 * (exact); safeties always come from the row. Returns null when the score is not a whole number
 * ≥ 0 (no final score: dst_pa stays absent). Throws `invalid_line` on a malformed row or count.
 */
export function pointsAllowedFromTeamWeek(
  opponent: NflverseRow,
  opponentScore: unknown,
  plays?: readonly NflverseRow[],
): PointsAllowedInput | null {
  const row = checkRow(opponent);
  const score = coerceScalar(opponentScore);
  if (score === null || score < 0 || !Number.isInteger(score)) return null;
  const safeties = countCol(row, "def_safeties");
  if (plays !== undefined) {
    const s = defenseScoresFromPlays(plays, checkId(textOf(row, "team"), "opponent team"));
    return Object.freeze({
      score,
      opponent_int_tds: s.int_return_tds,
      opponent_fumble_tds: s.fumble_return_tds,
      opponent_safeties: safeties,
    });
  }
  const recovered = countCol(row, "fumble_recovery_opp");
  return Object.freeze({
    score,
    opponent_int_tds: countCol(row, "def_tds"),
    opponent_fumble_tds:
      recovered > 0 ? Math.min(countCol(row, "fumble_recovery_tds"), recovered) : 0,
    opponent_safeties: safeties,
  });
}

/**
 * Yards allowed (ESPN stat 127) from the OPPONENT's `ds_stats_team_week` row: gross passing +
 * rushing − |sack yards lost| (70/70 recorded D/ST weeks); null when either yardage is absent.
 */
export function yardsAllowedFromTeamWeek(opponent: NflverseRow): number | null {
  const row = checkRow(opponent);
  const pass = col(row, "passing_yards");
  const rush = col(row, "rushing_yards");
  if (pass === null || rush === null) return null;
  return pass + rush - Math.abs(col(row, "sack_yards_lost") ?? 0);
}
