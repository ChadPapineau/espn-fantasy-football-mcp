// totals.ts — lineup totals under the normal approximation (research 05 §3.2 same-team correlations
// in this format; sibling research 05 §3.3, §11.1): μ = Σμ_i, σ² = Σσ_i² + 2Σ_{i<j} ρ_ij σ_i σ_j,
// cov(M, O) across rosters, P(win) = Φ((μ_m − μ_o) / sqrt(σ_m² + σ_o² − 2 cov)). Pure.
// Ported from sibling @f6ba81e (src/domain/analytics/totals.ts), adapted (ESPN player and pro-team
// ids; the ρ table at the 5-pt TD).
import { at } from "../scoring/numeric.js";
import type { Dist } from "../scoring/types.js";
import { LINEUP, SAME_TEAM_RHO, Z90 } from "./constants.js";
import { normalCdf, sigmaOf } from "./math.js";

/** What a total needs to know about one started player. */
export interface TotalMember {
  readonly player_id: number;
  /** ESPN display position (QB, RB, WR, TE, K, D/ST, …). */
  readonly position: string;
  /** NFL team id; null or 0 = no team (never correlated). */
  readonly pro_team_id: number | null;
  readonly points: Dist;
}

/** ρ between two players (same player → 1; same NFL team → the table; else 0). */
export function rho(a: TotalMember, b: TotalMember): number {
  if (a.player_id === b.player_id) return 1;
  if (a.pro_team_id === null || a.pro_team_id === 0 || a.pro_team_id !== b.pro_team_id) return 0;
  const key = [a.position, b.position].sort().join("|");
  return Object.hasOwn(SAME_TEAM_RHO, key) ? (SAME_TEAM_RHO[key] ?? 0) : 0;
}

/** μ and σ² of a lineup's total. */
export function lineupMoments(members: readonly TotalMember[]): { mu: number; v: number } {
  let mu = 0;
  let v = 0;
  const sig = members.map((m) => sigmaOf(m.points));
  members.forEach((m, i) => {
    mu += m.points.mean;
    v += at(sig, i) ** 2;
    for (let j = i + 1; j < members.length; j++)
      v += 2 * rho(m, at(members, j)) * at(sig, i) * at(sig, j);
  });
  return { mu, v: Math.max(0, v) };
}

/** cov(A, B) of two lineups' totals (shared players count with ρ = 1). */
export function lineupCov(a: readonly TotalMember[], b: readonly TotalMember[]): number {
  let c = 0;
  for (const x of a) {
    const sx = sigmaOf(x.points);
    if (sx === 0) continue;
    for (const y of b) c += rho(x, y) * sx * sigmaOf(y.points);
  }
  return c;
}

/** Everything the H2H formulas need about a pair of lineups. */
export interface PairMoments {
  readonly mu_m: number;
  readonly mu_o: number;
  readonly v_m: number;
  readonly v_o: number;
  readonly cov: number;
}

/** Moments of (me, opponent). */
export function pairMoments(me: readonly TotalMember[], opp: readonly TotalMember[]): PairMoments {
  const m = lineupMoments(me);
  const o = lineupMoments(opp);
  return { mu_m: m.mu, mu_o: o.mu, v_m: m.v, v_o: o.v, cov: lineupCov(me, opp) };
}

/** sd of M − O (never negative). */
export function diffSd(p: PairMoments): number {
  return Math.sqrt(Math.max(0, p.v_m + p.v_o - 2 * p.cov));
}

/** P(M > O) under the normal approximation; a degenerate spread gives 1 / 0 / ½. */
export function pWinNormal(p: PairMoments): number {
  const d = p.mu_m - p.mu_o;
  const s = diffSd(p);
  if (s === 0) return d > 0 ? 1 : d < 0 ? 0 : 0.5;
  return normalCdf(d / s);
}

/**
 * The P(win) interval from projection-mean uncertainty (sibling research 05 §11 pitfall: the
 * model's own error exceeds the sampling error): d ± z90·e with e = LINEUP.muErrorSdPerPlayer ·
 * √(started players on both sides).
 */
export function pWinInterval(p: PairMoments, nStarted: number): readonly [number, number] {
  const d = p.mu_m - p.mu_o;
  const e = LINEUP.muErrorSdPerPlayer * Math.sqrt(Math.max(0, nStarted));
  const s = diffSd(p);
  const cdf = (x: number): number => (s === 0 ? (x > 0 ? 1 : x < 0 ? 0 : 0.5) : normalCdf(x / s));
  return [cdf(d - Z90 * e), cdf(d + Z90 * e)];
}
