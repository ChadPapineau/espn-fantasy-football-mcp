// nflverse.ts — `toStatLine(nflverse)` (plan 08 §3.2, E8): ds_stats_player_week rows and
// ds_team_defense_week rows (src/store/datasets/tables.ts column names, verbatim) → canonical lines,
// with ESPN's conventions measured on the recorded fixtures (2026 weeks 1–3, every rostered
// player-week joined on espn_id): blocked FGs and blocked PATs count as MISSES; yards allowed is
// passing + rushing − |sack yards| (70/70 D/ST weeks; nflverse stores sack yards negative); points
// allowed nets out the opponent defence's INT/fumble-return TDs and safeties but not kick/punt-return
// TDs (U-6 settled, 69/70). Pure. Ported from sibling @cf3b015 (coercion, kick lists), adapted.
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
}

/**
 * `toStatLine(nflverse)` for a `ds_stats_player_week` row (plan 08 §3.2). Every mapped column with
 * a non-null value becomes present (a present 0 stays 0). Per-N items, yardage bonuses and a
 * league's tiers are left to the engine (it bracketizes the scalars); long-TD bonuses and the
 * kick/punt-return split are absent (underivable from weekly totals unless their base is zero).
 * Kicks come from the distance lists (blocked counted as missed — recorded) when the row has
 * attempts. Throws `invalid_line` when no position can be resolved.
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
  return makeLine(v, position, opts);
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
 * Points allowed (plan 08 §3.2 U-6): `net_of_defense` (default — ESPN's, 69/70 recorded D/ST weeks;
 * the 70th is 2 points off, a team safety no player row carries) = score − 6 × (opponent INT- and
 * fumble-return TDs) − 2 × opponent safeties, floored at 0; `final_score` = the opponent's score.
 * Kick- and punt-return TDs count against the D/ST under both. Throws `invalid_line` on a negative
 * or non-finite input.
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
