// waiverDp.ts — waiver priority as an option (research 05 §1.2 [V-data, waiver_dp.py]): a
// successful claim sends me to N, a failed one costs nothing, rivals ahead who win drop below me
// (D ~ Binomial(k−1, c)); P_k(s) = (1 − q(s))^(k−1);
//   claim ⇔ s ≥ Π(k, W) := V^pass(k, W) − V(N, W),
//   V(k, W+1) = V^pass(k, W) + E_s[P_k(s) × max(s − Π(k, W), 0)],  V(·, 0) = 0.
// The research table's W is the usable weeks AFTER this week's claim (the claim's value spans W + 1
// weeks — its own worked examples read Π(2, 12) for "weeks 5–17"), so Π_table(k, W) is the DP's
// threshold at horizon W + 1; that convention reproduces every cell (Π(2, 13) = 29.5, V(1, 16) =
// 95.8). The premium band re-solves at ×0.5 / ×1.5 surplus (plan 07 E5; ADV OBJ-03): the surplus
// values scale, the demand curve keeps reading the base rate (decision recorded). Pure; memoised.
// Phase 3 (plan 10 §3.3, C5; additive): `rates` re-solves the DP from a league's own surplus
// distribution (src/domain/analytics/waiver-fit/), with `drift` its fitted c.
// Stage C (changelog R6-3; additive): `demandCurve` re-solves it with the league's own demand curve
// (intercept and slope fitted from its previous seasons — waiver-fit/history.ts).
// New here (the sibling is a FAAB league).
import { WAIVER_DP } from "./constants.js";
import { PREMIUM_BAND_MULTIPLIERS } from "./types.js";

/** The DP's inputs (the cold-start defaults are WAIVER_DP's). */
export interface WaiverDpParams {
  /** League size N (2..20). */
  readonly teams: number;
  /** Multiplies every surplus value (the band's ×0.5 / ×1.5); 1 = the table. */
  readonly surplusScale?: number;
  /** Multiplies the demand curve (sensitivity checks only). */
  readonly demandScale?: number;
  /** Overrides the drift c (sensitivity checks; Phase 3: the league-fitted drift, waiver-fit/). */
  readonly drift?: number;
  /**
   * Overrides the per-week surplus-rate distribution of the best weekly claim (Phase 3, plan 10
   * §3.3 / C5: the league's own distribution, `premium_basis: "league_fitted"`; additive). Every
   * `r` finite and ≥ 0, every `p` finite and ≥ 0, Σ p = 1 within 1e-6; omitted = WAIVER_DP.rates.
   */
  readonly rates?: readonly { readonly r: number; readonly p: number }[];
  /**
   * Overrides the demand curve q(r) = min(qCap, q0 + q1·r) (Stage C, changelog R6-3: the league's
   * own curve fitted from its previous seasons; additive). Both finite and ≥ 0; omitted = the cold
   * start (WAIVER_DP.q0, WAIVER_DP.q1). `demandScale` still multiplies it.
   */
  readonly demandCurve?: { readonly q0: number; readonly q1: number };
}

/** Whether a rate distribution is usable by the DP (see WaiverDpParams.rates). */
export function isValidRateDistribution(
  rates: readonly { readonly r: number; readonly p: number }[],
): boolean {
  if (!Array.isArray(rates) || rates.length === 0 || rates.length > 64) return false;
  let sum = 0;
  for (const x of rates as readonly unknown[]) {
    if (typeof x !== "object" || x === null) return false;
    const { r, p } = x as { readonly r?: unknown; readonly p?: unknown };
    if (
      typeof r !== "number" ||
      typeof p !== "number" ||
      !Number.isFinite(r) ||
      r < 0 ||
      !Number.isFinite(p) ||
      p < 0
    )
      return false;
    sum += p;
  }
  return Math.abs(sum - 1) <= 1e-6;
}

/** Whether a value is a usable demand curve: an object with finite q0, q1 ≥ 0 (checked at run time). */
export function isDemandCurve(x: unknown): x is { readonly q0: number; readonly q1: number } {
  if (typeof x !== "object" || x === null) return false;
  const { q0, q1 } = x as { readonly q0?: unknown; readonly q1?: unknown };
  return (
    typeof q0 === "number" &&
    typeof q1 === "number" &&
    Number.isFinite(q0) &&
    Number.isFinite(q1) &&
    q0 >= 0 &&
    q1 >= 0
  );
}

/** A solved table: Π and V by position k (1..N) and the research's W (weeks after this one). */
export interface PremiumTable {
  readonly teams: number;
  /** Π(k, W) in ROS points; W may be fractional (linear interpolation) and is clamped to the table. */
  premium(k: number, W: number): number;
  /** V(k, W): the expected future surplus of holding position k with W weeks after this one. */
  value(k: number, W: number): number;
}

const CACHE = new Map<string, PremiumTable>();
/** Solved tables kept (fitted distributions add keys; the oldest is evicted past this — additive). */
const CACHE_MAX = 64;

function binomialRow(n: number, c: number): number[] {
  // P(D = d) for D ~ Binomial(n, c), d = 0..n
  const out: number[] = [];
  let coef = 1;
  for (let d = 0; d <= n; d++) {
    out.push(coef * c ** d * (1 - c) ** (n - d));
    coef = (coef * (n - d)) / (d + 1);
  }
  return out;
}

/** Solves the DP for horizons 0..WAIVER_DP.maxHorizon + 1 (memoised per parameter set). */
export function solvePremiumTable(params: WaiverDpParams): PremiumTable {
  const n = params.teams;
  if (!Number.isInteger(n) || n < WAIVER_DP.minTeams || n > WAIVER_DP.maxTeams)
    throw new RangeError("waiverDp: league size out of range");
  const scale = params.surplusScale ?? 1;
  const dScale = params.demandScale ?? 1;
  const c = params.drift ?? WAIVER_DP.drift;
  if (
    !(scale > 0 && Number.isFinite(scale)) ||
    !(dScale > 0 && Number.isFinite(dScale)) ||
    !(c >= 0 && c < 1)
  )
    throw new RangeError("waiverDp: bad sensitivity parameter");
  if (params.rates !== undefined && !isValidRateDistribution(params.rates))
    throw new RangeError("waiverDp: bad rate distribution");
  const curve = params.demandCurve;
  if (curve !== undefined && !isDemandCurve(curve))
    throw new RangeError("waiverDp: bad demand curve");
  const q0 = curve?.q0 ?? WAIVER_DP.q0;
  const q1 = curve?.q1 ?? WAIVER_DP.q1;
  const rates = params.rates ?? WAIVER_DP.rates;
  const ratesKey =
    params.rates === undefined
      ? ""
      : `:${params.rates.map((x) => `${String(x.r)}/${String(x.p)}`).join(",")}`;
  const curveKey = curve === undefined ? "" : `:q${String(q0)}/${String(q1)}`;
  const key = `${String(n)}:${String(scale)}:${String(dScale)}:${String(c)}${ratesKey}${curveKey}`;
  const hit = CACHE.get(key);
  if (hit !== undefined) return hit;

  const H = WAIVER_DP.maxHorizon + 1;
  const q = (r: number): number => Math.min(WAIVER_DP.qCap, (q0 + q1 * r) * dScale);
  const rows = Array.from({ length: n + 1 }, (_, k) => (k >= 1 ? binomialRow(k - 1, c) : []));
  // V[h][k], Pi[h][k] for h = 0..H (the DP's horizon: the claim's value spans h weeks); index 0 of
  // each row is unused (positions are 1-based)
  const rd = (a: readonly number[], i: number): number => a[i] ?? 0;
  const V: number[][] = [new Array<number>(n + 1).fill(0)];
  const Pi: number[][] = [];
  let vh = V[0] ?? [];
  for (let h = 0; h <= H; h++) {
    const vpass = rows.map((row, k) =>
      k === 0 ? 0 : row.reduce((s, pd, d) => s + pd * rd(vh, k - d), 0),
    );
    const pih = vpass.map((v) => v - rd(vh, n));
    Pi.push(pih);
    const next = vpass.map((v, k) => {
      if (k === 0) return 0;
      let e = 0;
      for (const { r, p } of rates) {
        const surplus = r * scale * h;
        e += p * (1 - q(r)) ** (k - 1) * Math.max(surplus - rd(pih, k), 0);
      }
      return v + e;
    });
    V.push(next);
    vh = next;
  }
  const look = (grid: number[][], k: number, W: number): number => {
    if (!Number.isInteger(k) || k < 1 || k > n)
      throw new RangeError("waiverDp: position out of range");
    const w = Number.isFinite(W) ? Math.min(Math.max(W, 0), WAIVER_DP.maxHorizon) : 0;
    const lo = Math.floor(w);
    const hi = Math.min(lo + 1, WAIVER_DP.maxHorizon);
    const a = rd(grid[lo + 1] ?? [], k);
    const b = rd(grid[hi + 1] ?? [], k);
    return a + (w - lo) * (b - a);
  };
  const table: PremiumTable = Object.freeze({
    teams: n,
    premium: (k: number, W: number) => look(Pi, k, W),
    value: (k: number, W: number) => look(V, k, W),
  });
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, table);
  return table;
}

/** Π(k, W) of the cold-start table for an N-team league (research 05 §1.2). */
export function priorityPremium(k: number, W: number, teams: number): number {
  return solvePremiumTable({ teams }).premium(k, W);
}

/** The premium and its band: the DP re-solved at ×0.5 and ×1.5 surplus (plan 07 E5; ADV OBJ-03). */
export function premiumBand(
  k: number,
  W: number,
  teams: number,
): { readonly low: number; readonly premium: number; readonly high: number } {
  return {
    low: solvePremiumTable({ teams, surplusScale: PREMIUM_BAND_MULTIPLIERS.low }).premium(k, W),
    premium: priorityPremium(k, W, teams),
    high: solvePremiumTable({ teams, surplusScale: PREMIUM_BAND_MULTIPLIERS.high }).premium(k, W),
  };
}

/** The cold-start demand curve q(r) of one rival for a per-week surplus rate r. */
export function demandOf(r: number, scale = 1): number {
  if (!Number.isFinite(r) || r <= 0) return Math.min(WAIVER_DP.qCap, WAIVER_DP.q0 * scale);
  return Math.min(WAIVER_DP.qCap, (WAIVER_DP.q0 + WAIVER_DP.q1 * r) * scale);
}
