// xfp.ts — expected fantasy points from usage on the LEAGUE's scoring basis (sib research 05 §4.1 item
// 4: "compute expected fantasy points from usage (xFP) … under this league's S and the gap xFP −
// actual"; plan 08 §5: a league-scored xFP is Σ the `*_exp` components × the league's weights — the
// expected stat line scored by the engine; plan 07 D1 `xfp_ep`, `xfp_gap`; E5's `xfp_gap` signal).
// ffopportunity's own `total_fantasy_points_exp` is its own scoring — full PPR, 0.04 per passing yard,
// a 4-pt passing TD, −2 per interception (checked on every recorded excerpt row: tests/domain/
// analytics/xfp.test.ts) — so set against a half-PPR league's points it made a pass catcher who played
// exactly to expectation look under-produced by half a point per catch, and against 5-pt passing TDs
// a QB who played to expectation look a point per TD lucky (Stage C finding
// analytics-xfp-gap-scoring-basis). Here both sides of the gap are the same engine under the same S.
// The expectation has no fumbles, sacks, returns or TD lengths (ffopportunity models none), so they
// stay absent from the expected line — what they cost is the game's, as in ffopportunity's own gap.
// Pure. New here.
import { score } from "../scoring/engine.js";
import { positionClassOf } from "../scoring/stat_map.js";
import { asPositionId, type ScoringSettings, type StatLine } from "../scoring/types.js";
import { round } from "./math.js";
import type { EpExpected, EpWeeklyRow } from "./types.js";

/** The `ep_weekly` column each expected component is read from (the store keeps them verbatim). */
export const EP_EXPECTED_COLUMNS: Readonly<Record<keyof EpExpected, string>> = Object.freeze({
  // the opportunity itself: ffopportunity's expectation is conditional on the plays that happened
  pass_att: "pass_attempt",
  rush_att: "rush_attempt",
  targets: "rec_attempt",
  // the model's expectations
  pass_cmp: "pass_completions_exp",
  pass_yd: "pass_yards_gained_exp",
  pass_td: "pass_touchdown_exp",
  pass_int: "pass_interception_exp",
  pass_2pt: "pass_two_point_conv_exp",
  pass_1d: "pass_first_down_exp",
  rush_yd: "rush_yards_gained_exp",
  rush_td: "rush_touchdown_exp",
  rush_2pt: "rush_two_point_conv_exp",
  rush_1d: "rush_first_down_exp",
  rec: "receptions_exp",
  rec_yd: "rec_yards_gained_exp",
  rec_td: "rec_touchdown_exp",
  rec_2pt: "rec_two_point_conv_exp",
  rec_1d: "rec_first_down_exp",
});

/** A component's bound: a weekly count or yardage far past any game (a hostile row is refused). */
const MAX_COMPONENT = 10_000;

/**
 * ffopportunity's expected components of one `ep_weekly` row, `column` reading a cell by its upstream
 * name. Null when any component is missing, not finite or out of range: a league-scored xFP is never
 * built from part of the line (and never falls back to ffopportunity's own total).
 */
export function epExpectedOf(column: (name: string) => unknown): EpExpected | null {
  const out: Partial<Record<keyof EpExpected, number>> = {};
  for (const [k, col] of Object.entries(EP_EXPECTED_COLUMNS) as [keyof EpExpected, string][]) {
    const v = column(col);
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_COMPONENT) return null;
    out[k] = v === 0 ? 0 : v;
  }
  return Object.freeze(out as EpExpected);
}

/**
 * The expected stat line in the nflverse translator's shape (scoring/nflverse.ts: the same keys an
 * actual line carries, so S scores the two alike — the per-game yardage items, incompletions, total
 * 2-pt conversions, turnovers, a game played). Its source is a projection's, so the engine reads its
 * scalars as an expectation (bracket and per-N items from the expected yards).
 */
export function expectedLineOf(x: EpExpected, positionId: number): StatLine {
  const values: Record<string, number> = {
    pass_att: x.pass_att,
    pass_cmp: x.pass_cmp,
    pass_inc: Math.max(0, x.pass_att - x.pass_cmp),
    pass_yd: x.pass_yd,
    pass_ypg: x.pass_yd,
    pass_td: x.pass_td,
    pass_int: x.pass_int,
    pass_1d: x.pass_1d,
    pass_2pt: x.pass_2pt,
    rush_att: x.rush_att,
    rush_yd: x.rush_yd,
    rush_ypg: x.rush_yd,
    rush_td: x.rush_td,
    rush_1d: x.rush_1d,
    rush_2pt: x.rush_2pt,
    rec: x.rec,
    rec_stat: x.rec,
    targets: x.targets,
    rec_yd: x.rec_yd,
    rec_ypg: x.rec_yd,
    rec_td: x.rec_td,
    rec_1d: x.rec_1d,
    rec_2pt: x.rec_2pt,
    two_pt_total: x.pass_2pt + x.rush_2pt + x.rec_2pt,
    // interceptions are the only turnover with an expectation
    turnovers: x.pass_int,
    gp: 1,
  };
  return Object.freeze({
    values: Object.freeze(values),
    present: Object.freeze(Object.keys(values).sort()),
    position: asPositionId(positionId),
    position_class: positionClassOf(positionId),
    provisional: false,
    source: "projection:ffopportunity",
  });
}

/**
 * xFP under the league's S: ffopportunity's expected line scored by the engine (exact, before the
 * league's rounding — an expectation is not a scored game). Null without components, or when the
 * engine refuses the line (an invalid position id).
 */
export function leagueXfp(
  x: EpExpected | null | undefined,
  settings: ScoringSettings,
  positionId: number,
): number | null {
  if (x === null || x === undefined) return null;
  try {
    return round(score(expectedLineOf(x, positionId), settings).points_exact);
  } catch {
    return null;
  }
}

/**
 * One D1 game row's xFP pair (plan 07 D1): `xfp_ep`, the league-scored xFP, and `xfp_gap` = xfp_ep −
 * points_league on that one basis — null on each side that cannot be read. What D1's
 * `trailing.xfp_gap_sum` and E5's `xfp_gap` signal both read.
 */
export function xfpOf(
  ep: Pick<EpWeeklyRow, "expected"> | null | undefined,
  settings: ScoringSettings | null,
  positionId: number,
  pointsLeague: number | null,
): { readonly xfp_ep: number | null; readonly xfp_gap: number | null } {
  const xfp = settings === null ? null : leagueXfp(ep?.expected, settings, positionId);
  return {
    xfp_ep: xfp,
    xfp_gap:
      xfp === null || pointsLeague === null || !Number.isFinite(pointsLeague)
        ? null
        : round(xfp - pointsLeague),
  };
}
