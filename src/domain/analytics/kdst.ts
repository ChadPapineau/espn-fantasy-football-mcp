// kdst.ts — K and D/ST expectations for streaming (plan 07 C5, E5 K/D-ST slice; research 05 §5 K and
// D/ST streaming: ESPN encodes the kicker distance items and the D/ST points- and yards-allowed
// tiers as stat ids, so the league's own brackets in S decide; sibling research 05 §8: D/ST points
// allowed around the opponent's implied total, counts Poisson; kickers from the implied team total).
// Deterministic: tier probabilities from the gamma CDF, every point value from the scoring engine
// under the league's S (never a hard-coded tier table). Pure. Ported in spirit from sibling
// @f6ba81e (src/domain/analytics/kdef.ts); the ESPN brackets and the deterministic quadrature are new.
import { score as engineScore } from "../scoring/engine.js";
import {
  asPositionId,
  type Canonical,
  type ScoringSettings,
  type StatLine,
} from "../scoring/types.js";
import { KDST, PROJECTION_SOURCE } from "./constants.js";
import { gammaCdfMeanCv, round } from "./math.js";

/** A streaming position. */
export type KdstPosition = "K" | "D/ST";

/** One week's expectation for a K or D/ST (plan 07 E5 `kdst`). */
export interface KdstExpectation {
  /** Expected fantasy points under the league's S. */
  readonly e: number;
  /** Expected points from the bracket families (D/ST PA + YA tiers; K FG distance items). */
  readonly brackets_e: number;
  readonly sacks_e: number | null;
  readonly takeaways_e: number | null;
  /** Rare D/ST events (return TDs, safeties, blocks) as a constant (sibling research 05 §8.2). */
  readonly rare_c: number | null;
  /** The implied totals read (null → the league average was assumed). */
  readonly implied_total: number | null;
  readonly opp_implied_total: number | null;
}

const DST_POSITION = 16;
const K_POSITION = 5;
const MAX_PA = 80;
const YA_STEP = 10;
const MAX_YA = 800;

function lineOf(values: Readonly<Record<Canonical, number>>, positionId: number): StatLine {
  const keys = Object.keys(values).sort();
  return {
    values,
    present: keys,
    position: asPositionId(positionId),
    position_class: positionId === DST_POSITION ? "DST" : "K",
    provisional: false,
    source: PROJECTION_SOURCE,
  };
}

const scoreOf = (
  settings: ScoringSettings,
  values: Readonly<Record<Canonical, number>>,
  positionId: number,
): number => engineScore(lineOf(values, positionId), settings).points_exact;

const finitePositive = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0;

/** Points of every integer PA and every 10-yard YA step under one settings object (memoised). */
const TIER_POINTS = new WeakMap<
  ScoringSettings,
  { readonly pa: Float64Array; readonly ya: Float64Array }
>();
function tierPoints(settings: ScoringSettings): {
  readonly pa: Float64Array;
  readonly ya: Float64Array;
} {
  const hit = TIER_POINTS.get(settings);
  if (hit !== undefined) return hit;
  const pa = Float64Array.from({ length: MAX_PA + 1 }, (_, v) =>
    scoreOf(settings, { dst_pa_raw: v }, DST_POSITION),
  );
  const ya = Float64Array.from({ length: MAX_YA / YA_STEP + 1 }, (_, i) =>
    scoreOf(settings, { dst_ya_raw: i * YA_STEP + YA_STEP / 2 }, DST_POSITION),
  );
  const t = { pa, ya };
  TIER_POINTS.set(settings, t);
  return t;
}

/**
 * A D/ST's expectation against an opponent whose implied total is `oppImplied` (null → the league
 * average): points allowed ~ Gamma(mean = oppImplied, cv), integer-rounded by continuity; yards
 * allowed ~ Gamma(mean = base × (opp / league)^β, cv) in 10-yard steps; sacks and takeaways
 * Poisson at rates scaled (league / opp)^β; return TDs, safeties and blocks constant. Every tier's
 * points come from scoring a one-stat line under S, so the league's own brackets decide.
 */
export function dstExpectation(
  settings: ScoringSettings,
  oppImplied: number | null,
  teamImplied: number | null = null,
): KdstExpectation {
  const opp = finitePositive(oppImplied) ? oppImplied : KDST.leagueImplied;
  const tiers = tierPoints(settings);
  let brackets = 0;
  let prev = 0;
  for (let v = 0; v <= MAX_PA; v++) {
    const cdf = v === MAX_PA ? 1 : gammaCdfMeanCv(v + 0.5, opp, KDST.pointsAllowedCv);
    const p = cdf - prev;
    prev = cdf;
    if (p > 0) brackets += p * (tiers.pa[v] ?? 0);
  }
  const yaMean = KDST.yardsAllowedBase * (opp / KDST.leagueImplied) ** KDST.yardsAllowedBeta;
  prev = 0;
  for (let y = 0; y <= MAX_YA; y += YA_STEP) {
    const cdf = y === MAX_YA ? 1 : gammaCdfMeanCv(y + YA_STEP, yaMean, KDST.yardsAllowedCv);
    const p = cdf - prev;
    prev = cdf;
    if (p > 0) brackets += p * (tiers.ya[y / YA_STEP] ?? 0);
  }
  const scale = (KDST.leagueImplied / opp) ** KDST.eventBeta;
  const r = KDST.rates;
  const sacks = scoreOf(settings, { dst_sack: r.dst_sack * scale }, DST_POSITION);
  const takeaways = scoreOf(
    settings,
    { dst_int: r.dst_int * scale, dst_fr: r.dst_fr * scale },
    DST_POSITION,
  );
  const rare = scoreOf(
    settings,
    { dst_td: r.dst_td, dst_safety: r.dst_safety, dst_blk: r.dst_blk },
    DST_POSITION,
  );
  return {
    e: round(brackets + sacks + takeaways + rare, 3),
    brackets_e: round(brackets, 3),
    sacks_e: round(sacks, 3),
    takeaways_e: round(takeaways, 3),
    rare_c: round(rare, 3),
    implied_total: finitePositive(teamImplied) ? teamImplied : null,
    opp_implied_total: finitePositive(oppImplied) ? oppImplied : null,
  };
}

/**
 * A kicker's expectation with his team implied to score `implied` (null → the league average):
 * FG attempts ∝ (implied / league)^β over the distance mix (made / missed / attempted counts by
 * bucket, the legacy 50+ items included), PAT attempts ∝ implied — one expected line, scored under
 * S (every kicker item is linear in its count, so the score of the expectation is the expectation).
 */
export function kickerExpectation(
  settings: ScoringSettings,
  implied: number | null,
  oppImplied: number | null = null,
): KdstExpectation {
  const team = finitePositive(implied) ? implied : KDST.leagueImplied;
  const att = KDST.fgAttempts * (team / KDST.leagueImplied) ** KDST.fgAttemptsBeta;
  const fg: Record<Canonical, number> = {};
  const add = (k: Canonical, v: number): void => {
    fg[k] = (fg[k] ?? 0) + v;
  };
  let madeYd = 0;
  let missYd = 0;
  for (const b of KDST.fgMix) {
    const a = att * b.share;
    const made = a * b.make;
    const miss = a - made;
    const bucket =
      b.distance < 40 ? "0_39" : b.distance < 50 ? "40_49" : b.distance < 60 ? "50_59" : "60p";
    add(`fg_${bucket}`, made);
    add(`fg_miss_${bucket}`, miss);
    add(`fg_att_${bucket}`, a);
    if (b.distance >= 50) {
      add("fg_50p", made);
      add("fg_miss_50p", miss);
      add("fg_att_50p", a);
    }
    add("fg_made_total", made);
    add("fg_miss_total", miss);
    add("fg_att_total", a);
    madeYd += made * b.distance;
    missYd += miss * b.distance;
  }
  const brackets = scoreOf(settings, fg, K_POSITION);
  const patAtt = KDST.patPerPoint * team;
  const pat = {
    pat_att: patAtt,
    pat_made: patAtt * KDST.patMake,
    pat_miss: patAtt * (1 - KDST.patMake),
  };
  const total = scoreOf(
    settings,
    { ...fg, ...pat, fg_yd: madeYd, fg_yd_miss: missYd, fg_yd_att: madeYd + missYd },
    K_POSITION,
  );
  return {
    e: round(total, 3),
    brackets_e: round(brackets, 3),
    sacks_e: null,
    takeaways_e: null,
    rare_c: null,
    implied_total: finitePositive(implied) ? implied : null,
    opp_implied_total: finitePositive(oppImplied) ? oppImplied : null,
  };
}

/** The expectation of a streaming candidate (K: his team's implied total; D/ST: the opponent's). */
export function kdstExpectation(
  position: KdstPosition,
  settings: ScoringSettings,
  teamImplied: number | null,
  oppImplied: number | null,
): KdstExpectation {
  return position === "K"
    ? kickerExpectation(settings, teamImplied, oppImplied)
    : dstExpectation(settings, oppImplied, teamImplied);
}

/** Whether a display position streams (plan 07 C5). */
export const isKdst = (position: string): position is KdstPosition =>
  position === "K" || position === "D/ST";
