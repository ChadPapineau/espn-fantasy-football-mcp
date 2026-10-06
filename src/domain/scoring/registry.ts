// registry.ts — the canonical stat registry (plan 08 E2, §3.1): every canonical name the hub knows,
// the position classes it scores for, and — for the §4 families — its family, scalar and inclusive
// bounds. Platform-neutral (plan 08 §10: names and classes move to fantasy-core); the ESPN id table
// is stat_map.ts. Classes are fixture-evidenced where they differ from plan 08 §3.1 (decisions).
import type { BracketFamilyName, Canonical, PositionClass } from "./types.js";
import { CANONICAL_NAME_RE } from "./types.js";

/**
 * How a family's members relate to its scalar (plan 08 §4):
 * - `tier` — exclusive indicators over a partition (PA/YA tiers, HC margins): one member per game;
 * - `count` — per-bucket counts over a partition (FG distance buckets: a kicker can make two 40–49
 *   FGs and a 52 in one game — 13 recorded K weeks hit two buckets);
 * - `threshold` — cumulative indicators, a member pays when the scalar reaches its lower bound
 *   (yardage-game bonuses, plan 08 A-2);
 * - `length` — per-play length thresholds (long-TD bonuses): cumulative on ESPN (a single 50+ yd TD
 *   sets both the 40+ and the 50+ id — recorded), underivable from weekly totals except as zero;
 * - `per_n` — `max(0, ⌊scalar / N⌋)` with N in `lower` (recorded: every per-N id on 712 lines).
 */
export type FamilyKind = "tier" | "count" | "threshold" | "length" | "per_n";

/** Each family's kind. */
export const FAMILY_KIND: Readonly<Record<BracketFamilyName, FamilyKind>> = Object.freeze({
  fg_distance: "count",
  fg_attempt: "count",
  fg_miss: "count",
  dst_points_allowed: "tier",
  dst_yards_allowed: "tier",
  margin: "tier",
  yardage_bonus: "threshold",
  long_td_bonus: "length",
  per_n_yards: "per_n",
});

/** The lowest scalar any range can hold (yards allowed can be negative): a finite, JSON-safe −∞. */
export const SCALAR_FLOOR = -1_000_000_000;

/** A canonical's family membership: `lower`/`upper` inclusive; `upper` null = open-ended. */
export interface FamilyMembership {
  readonly name: BracketFamilyName;
  readonly scalar: Canonical;
  /** The inclusive lower bound — for `per_n`, the divisor N. */
  readonly lower: number;
  readonly upper: number | null;
}

/** One registry row. */
export interface CanonicalDef {
  readonly canonical: Canonical;
  /** The position classes whose lines this stat scores on (plan 08 §3.4 gate). */
  readonly classes: readonly PositionClass[];
  /** How a contribution of this stat is labelled in `explain`. */
  readonly kind: "linear" | "bracket" | "bonus";
  readonly family: FamilyMembership | null;
  /**
   * For a derived (non-ESPN, non-projection) line: the stat whose ZERO proves this one is zero.
   * When that stat is non-zero this one is underivable from weekly totals (kick- vs punt-return
   * split, blocked-kick TD — plan 08 §3.2; long TDs use their family scalar instead).
   */
  readonly zero_with: Canonical | null;
  /** Server-authored meaning (registry text, never third-party). */
  readonly meaning: string;
}

const O: readonly PositionClass[] = ["O"];
const K: readonly PositionClass[] = ["K"];
const DST: readonly PositionClass[] = ["DST"];
const HC: readonly PositionClass[] = ["HC"];
/** Return stats: offensive returners and D/ST (league-a scores 114/115 on RB/WR lines — recorded). */
const RET: readonly PositionClass[] = ["O", "DST"];
/** Defensive TDs: base points in every recorded league apply beyond D/ST (two-way players). */
const DEF_TD: readonly PositionClass[] = ["O", "DST", "IDP"];
/** Individual defensive counting stats: ESPN also carries them on O and K lines (recorded). */
const DEF: readonly PositionClass[] = ["O", "K", "DST", "IDP"];
/** Team results and games played: on every recorded O, K and D/ST line. */
const ALL: readonly PositionClass[] = ["O", "K", "DST", "HC", "IDP"];

const row = (
  canonical: Canonical,
  classes: readonly PositionClass[],
  kind: CanonicalDef["kind"],
  family: FamilyMembership | null,
  meaning: string,
  zero_with: Canonical | null = null,
): CanonicalDef =>
  Object.freeze({
    canonical,
    classes: Object.freeze([...classes]),
    kind,
    family: family === null ? null : Object.freeze(family),
    zero_with,
    meaning,
  });

const lin = (c: Canonical, classes: readonly PositionClass[], meaning: string): CanonicalDef =>
  row(c, classes, "linear", null, meaning);
const fam = (
  name: BracketFamilyName,
  scalar: Canonical,
  lower: number,
  upper: number | null,
): FamilyMembership => ({ name, scalar, lower, upper });
const tier = (
  c: Canonical,
  classes: readonly PositionClass[],
  name: BracketFamilyName,
  scalar: Canonical,
  lower: number,
  upper: number | null,
  meaning: string,
): CanonicalDef => row(c, classes, "bracket", fam(name, scalar, lower, upper), meaning);
const bonus = (
  c: Canonical,
  name: "yardage_bonus" | "long_td_bonus",
  scalar: Canonical,
  lower: number,
  upper: number | null,
  meaning: string,
): CanonicalDef => row(c, O, "bonus", fam(name, scalar, lower, upper), meaning);
const perN = (
  base: Canonical,
  classes: readonly PositionClass[],
  n: number,
  what: string,
): CanonicalDef =>
  row(
    `per_n_${base}_${String(n)}`,
    classes,
    "linear",
    fam("per_n_yards", base, n, null),
    `every ${String(n)} ${what}`,
  );
const perNs = (
  base: Canonical,
  classes: readonly PositionClass[],
  ns: readonly number[],
  what: string,
): CanonicalDef[] => ns.map((n) => perN(base, classes, n, what));

const N6 = [5, 10, 20, 25, 50, 100] as const;

/** Every registry row (plan 08 §3.1, made complete for the ids the recorded fixtures carry). */
export const CANONICAL_DEFS: readonly CanonicalDef[] = Object.freeze([
  // --- passing ---------------------------------------------------------------------------------
  lin("pass_att", O, "pass attempts"),
  lin("pass_cmp", O, "pass completions"),
  lin("pass_inc", O, "incomplete passes (attempts − completions; recorded on every line)"),
  lin("pass_yd", O, "passing yards"),
  lin("pass_td", O, "passing touchdowns"),
  ...perNs("pass_yd", O, N6, "passing yards"),
  ...perNs("pass_cmp", O, [5, 10], "completions"),
  ...perNs("pass_inc", O, [5, 10], "incomplete passes"),
  bonus("pass_td_40", "long_td_bonus", "pass_td", 40, null, "40+ yard TD pass"),
  bonus("pass_td_50", "long_td_bonus", "pass_td", 50, null, "50+ yard TD pass"),
  bonus("pass_yd_300", "yardage_bonus", "pass_yd", 300, 399, "300–399 yard passing game"),
  bonus("pass_yd_400", "yardage_bonus", "pass_yd", 400, null, "400+ yard passing game"),
  lin("pass_2pt", O, "2-point conversion pass"),
  lin("pass_int", O, "interceptions thrown"),
  lin("pass_ypg", O, "passing yards per game"),
  lin("pass_1d", O, "passing first downs"),
  lin("sacked", O, "times sacked"),
  // --- rushing ---------------------------------------------------------------------------------
  lin("rush_att", O, "rushing attempts"),
  lin("rush_yd", O, "rushing yards"),
  lin("rush_td", O, "rushing touchdowns"),
  lin("rush_2pt", O, "2-point conversion rush"),
  ...perNs("rush_yd", O, N6, "rushing yards"),
  ...perNs("rush_att", O, [5, 10], "rushing attempts"),
  bonus("rush_td_40", "long_td_bonus", "rush_td", 40, null, "40+ yard TD rush"),
  bonus("rush_td_50", "long_td_bonus", "rush_td", 50, null, "50+ yard TD rush"),
  bonus("rush_yd_100", "yardage_bonus", "rush_yd", 100, 199, "100–199 yard rushing game"),
  bonus("rush_yd_200", "yardage_bonus", "rush_yd", 200, null, "200+ yard rushing game"),
  lin("rush_ypg", O, "rushing yards per game"),
  lin("rush_1d", O, "rushing first downs"),
  // --- receiving -------------------------------------------------------------------------------
  lin("rec_stat", O, "receptions (the statistic; the scoring item is rec)"),
  lin("rec_yd", O, "receiving yards"),
  lin("rec_td", O, "receiving touchdowns"),
  lin("rec_2pt", O, "2-point conversion reception"),
  bonus("rec_td_40", "long_td_bonus", "rec_td", 40, null, "40+ yard TD reception"),
  bonus("rec_td_50", "long_td_bonus", "rec_td", 50, null, "50+ yard TD reception"),
  ...perNs("rec_yd", O, N6, "receiving yards"),
  lin("rec", O, "each reception (the PPR item)"),
  ...perNs("rec", O, [5, 10], "receptions"),
  bonus("rec_yd_100", "yardage_bonus", "rec_yd", 100, 199, "100–199 yard receiving game"),
  bonus("rec_yd_200", "yardage_bonus", "rec_yd", 200, null, "200+ yard receiving game"),
  lin("targets", O, "targets"),
  lin("rec_ypg", O, "receiving yards per game"),
  lin("rec_1d", O, "receiving first downs"),
  // --- other offence ---------------------------------------------------------------------------
  lin("two_pt_total", O, "total 2-point conversions (not a reliable union on ESPN lines)"),
  lin("fum_rec_td_off", O, "fumble recovered for a TD (offence)"),
  lin("fum", O, "fumbles"),
  lin("fum_lost", O, "fumbles lost"),
  lin("turnovers", O, "total turnovers (interceptions thrown + fumbles lost)"),
  // --- returns (offence and D/ST) --------------------------------------------------------------
  row("kr_td", RET, "linear", null, "kickoff return TD", "ret_td_total"),
  row("pr_td", RET, "linear", null, "punt return TD", "ret_td_total"),
  lin("ret_td_total", RET, "total return TDs"),
  lin("kr_yd", RET, "kickoff return yards"),
  lin("pr_yd", RET, "punt return yards"),
  lin("two_pt_ret", RET, "2-point return"),
  lin("one_pt_safety", RET, "1-point safety"),
  // --- kicking ---------------------------------------------------------------------------------
  tier("fg_50p", K, "fg_distance", "kick_distance", 50, null, "FG made 50+ (legacy, incl. 60+)"),
  tier("fg_att_50p", K, "fg_attempt", "kick_distance", 50, null, "FG attempted 50+ (legacy)"),
  tier("fg_miss_50p", K, "fg_miss", "kick_distance", 50, null, "FG missed 50+ (legacy)"),
  tier("fg_40_49", K, "fg_distance", "kick_distance", 40, 49, "FG made 40–49"),
  tier("fg_att_40_49", K, "fg_attempt", "kick_distance", 40, 49, "FG attempted 40–49"),
  tier("fg_miss_40_49", K, "fg_miss", "kick_distance", 40, 49, "FG missed 40–49"),
  tier("fg_0_39", K, "fg_distance", "kick_distance", 0, 39, "FG made 0–39"),
  tier("fg_att_0_39", K, "fg_attempt", "kick_distance", 0, 39, "FG attempted 0–39"),
  tier("fg_miss_0_39", K, "fg_miss", "kick_distance", 0, 39, "FG missed 0–39"),
  tier("fg_50_59", K, "fg_distance", "kick_distance", 50, 59, "FG made 50–59"),
  tier("fg_att_50_59", K, "fg_attempt", "kick_distance", 50, 59, "FG attempted 50–59"),
  tier("fg_miss_50_59", K, "fg_miss", "kick_distance", 50, 59, "FG missed 50–59"),
  tier("fg_60p", K, "fg_distance", "kick_distance", 60, null, "FG made 60+"),
  tier("fg_att_60p", K, "fg_attempt", "kick_distance", 60, null, "FG attempted 60+"),
  tier("fg_miss_60p", K, "fg_miss", "kick_distance", 60, null, "FG missed 60+"),
  lin("fg_made_total", K, "FG made (all distances)"),
  lin("fg_att_total", K, "FG attempted (all distances)"),
  lin("fg_miss_total", K, "FG missed, blocked included (all distances)"),
  lin("pat_made", K, "extra points made"),
  lin("pat_att", K, "extra points attempted"),
  lin("pat_miss", K, "extra points missed, blocked included"),
  lin("fg_yd", K, "made FG yardage"),
  lin("fg_yd_miss", K, "missed FG yardage"),
  lin("fg_yd_att", K, "attempted FG yardage (made + missed)"),
  ...perNs("fg_yd", K, N6, "made FG yards"),
  ...perNs("fg_yd_miss", K, N6, "missed FG yards"),
  ...perNs("fg_yd_att", K, N6, "attempted FG yards"),
  // --- D/ST ------------------------------------------------------------------------------------
  lin("dst_pa_raw", DST, "points allowed (raw)"),
  tier("dst_pa_0", DST, "dst_points_allowed", "dst_pa_raw", 0, 0, "0 points allowed"),
  tier("dst_pa_1_6", DST, "dst_points_allowed", "dst_pa_raw", 1, 6, "1–6 points allowed"),
  tier("dst_pa_7_13", DST, "dst_points_allowed", "dst_pa_raw", 7, 13, "7–13 points allowed"),
  tier("dst_pa_14_17", DST, "dst_points_allowed", "dst_pa_raw", 14, 17, "14–17 points allowed"),
  tier("dst_pa_18_21", DST, "dst_points_allowed", "dst_pa_raw", 18, 21, "18–21 points allowed"),
  tier("dst_pa_22_27", DST, "dst_points_allowed", "dst_pa_raw", 22, 27, "22–27 points allowed"),
  tier("dst_pa_28_34", DST, "dst_points_allowed", "dst_pa_raw", 28, 34, "28–34 points allowed"),
  tier("dst_pa_35_45", DST, "dst_points_allowed", "dst_pa_raw", 35, 45, "35–45 points allowed"),
  tier("dst_pa_46p", DST, "dst_points_allowed", "dst_pa_raw", 46, null, "46+ points allowed"),
  lin("dst_ya_raw", DST, "yards allowed (raw)"),
  tier("dst_ya_lt100", DST, "dst_yards_allowed", "dst_ya_raw", SCALAR_FLOOR, 99, "< 100 yards"),
  tier("dst_ya_100_199", DST, "dst_yards_allowed", "dst_ya_raw", 100, 199, "100–199 yards"),
  tier("dst_ya_200_299", DST, "dst_yards_allowed", "dst_ya_raw", 200, 299, "200–299 yards"),
  tier("dst_ya_300_349", DST, "dst_yards_allowed", "dst_ya_raw", 300, 349, "300–349 yards"),
  tier("dst_ya_350_399", DST, "dst_yards_allowed", "dst_ya_raw", 350, 399, "350–399 yards"),
  tier("dst_ya_400_449", DST, "dst_yards_allowed", "dst_ya_raw", 400, 449, "400–449 yards"),
  tier("dst_ya_450_499", DST, "dst_yards_allowed", "dst_ya_raw", 450, 499, "450–499 yards"),
  tier("dst_ya_500_549", DST, "dst_yards_allowed", "dst_ya_raw", 500, 549, "500–549 yards"),
  tier("dst_ya_550p", DST, "dst_yards_allowed", "dst_ya_raw", 550, null, "550+ yards allowed"),
  row("dst_blk_td", DEF_TD, "linear", null, "blocked kick returned for a TD", "ret_td_total"),
  lin("dst_ret_td", DEF_TD, "interception or fumble return TD (combined)"),
  lin("dst_int", DEF, "interceptions"),
  lin("dst_fr", DEF, "fumble recoveries"),
  lin("dst_blk", DEF, "blocked kicks (FG, punt and PAT — recorded)"),
  lin("dst_safety", DEF, "safeties"),
  lin("dst_sack", DEF, "sacks"),
  lin("dst_int_td", DEF_TD, "interception return TD (E9: ESPN 103 — settled)"),
  lin("dst_fr_td", DEF_TD, "fumble return TD (E9: ESPN 104 — settled)"),
  lin("dst_ff", DEF, "forced fumbles"),
  lin("dst_tk_ast", DEF, "assisted tackles"),
  lin("dst_tk_solo", DEF, "solo tackles"),
  lin("dst_tk", DEF, "total tackles"),
  lin("dst_pd", DEF, "passes defensed"),
  lin("dst_2pt_ret", DST, "defensive 2-point return"),
  // --- team results (HC) and games -------------------------------------------------------------
  lin("hc_win", ALL, "team win"),
  lin("hc_loss", ALL, "team loss"),
  lin("hc_tie", ALL, "team tie"),
  lin("hc_pts", ALL, "team points scored"),
  tier("margin_win_25p", HC, "margin", "team_win_margin", 25, null, "25+ point win margin"),
  tier("margin_win_20_24", HC, "margin", "team_win_margin", 20, 24, "20–24 point win margin"),
  tier("margin_win_15_19", HC, "margin", "team_win_margin", 15, 19, "15–19 point win margin"),
  tier("margin_win_10_14", HC, "margin", "team_win_margin", 10, 14, "10–14 point win margin"),
  tier("margin_win_5_9", HC, "margin", "team_win_margin", 5, 9, "5–9 point win margin"),
  tier("margin_win_1_4", HC, "margin", "team_win_margin", 1, 4, "1–4 point win margin"),
  tier("margin_loss_1_4", HC, "margin", "team_loss_margin", 1, 4, "1–4 point loss margin"),
  tier("margin_loss_5_9", HC, "margin", "team_loss_margin", 5, 9, "5–9 point loss margin"),
  tier("margin_loss_10_14", HC, "margin", "team_loss_margin", 10, 14, "10–14 point loss margin"),
  tier("margin_loss_15_19", HC, "margin", "team_loss_margin", 15, 19, "15–19 point loss margin"),
  tier("margin_loss_20_24", HC, "margin", "team_loss_margin", 20, 24, "20–24 point loss margin"),
  tier("margin_loss_25p", HC, "margin", "team_loss_margin", 25, null, "25+ point loss margin"),
  lin("gp", ALL, "games played"),
]);

/** The registry keyed by canonical name (a Map: a hostile name never reads Object.prototype). */
export const CANONICAL_REGISTRY: ReadonlyMap<Canonical, CanonicalDef> = new Map(
  CANONICAL_DEFS.map((d) => [d.canonical, d]),
);

/** The registry row of a canonical name, or undefined. */
export function canonicalDef(canonical: Canonical): CanonicalDef | undefined {
  return CANONICAL_REGISTRY.get(canonical);
}

/** True when every registry name is well formed and unique (asserted by the registry test). */
export function registryIsWellFormed(): boolean {
  return (
    CANONICAL_REGISTRY.size === CANONICAL_DEFS.length &&
    CANONICAL_DEFS.every((d) => CANONICAL_NAME_RE.test(d.canonical) && d.classes.length > 0)
  );
}
