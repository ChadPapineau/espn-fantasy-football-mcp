// faab.ts — E5 `mode: faab` bid sizing (plan 07 E5 P1 `faab: { b_star, p_win_curve[], lambda,
// dollars_per_point }`; sib research 05 §4.3: FAAB is a first-price sealed-bid auction — shade; the
// price of a point from the league's winning bids; the competition as P(rival bids) × the rival's
// bid distribution, capped by his remaining budget; λ, the marginal value of a dollar, rising as the
// budget shrinks and falling to 0 by the last run before the playoffs; `b* = argmax_b P(win | b) ×
// (value − λ·b)` reported with the curve; research 05 §1.4 on what does not transfer to a priority
// league). Deterministic: P(rival bid > b) from the gamma CDF, no sampling. Pure. New here.
import { FAAB } from "./marketConstants.js";
import { clamp, gammaCdfMeanCv, round } from "./math.js";

/** One past winning bid and the acquired player's value at the time (surplus points). */
export interface WinningBid {
  readonly bid: number;
  readonly value: number;
}

/** The league's price of a point: dollars per surplus point and the number of bids behind it. */
export interface PricePerPoint {
  readonly value: number;
  readonly n: number;
}

/**
 * The price of a point: the through-origin least-squares slope of winning bids on value, shrunk
 * toward the cold start (`budget / coldPointsPerBudget`) with `priceShrinkBids` pseudo-bids. Rows
 * with a non-positive value or a negative bid are ignored.
 */
export function pricePerPoint(history: readonly WinningBid[], budgetTotal: number): PricePerPoint {
  const cold = Math.max(budgetTotal, 1) / FAAB.coldPointsPerBudget;
  const rows = history.filter(
    (h) => Number.isFinite(h.bid) && Number.isFinite(h.value) && h.bid >= 0 && h.value > 0,
  );
  if (rows.length === 0) return { value: round(cold, 4), n: 0 };
  const sbv = rows.reduce((s, h) => s + h.bid * h.value, 0);
  const svv = rows.reduce((s, h) => s + h.value * h.value, 0);
  const slope = svv > 0 ? sbv / svv : cold;
  const k = FAAB.priceShrinkBids;
  const n = rows.length;
  return { value: round((n * slope + k * cold) / (n + k), 4), n };
}

/** A rival in the auction. */
export interface FaabRival {
  readonly team_id: number;
  /** P(the rival bids at all) — the demand model's q_i. */
  readonly q: number;
  /** The player's value to the rival (points); his bid centres on price × value × shading. */
  readonly value: number;
  /** Remaining budget; null → unknown (no cap). */
  readonly budget_remaining: number | null;
}

/** The auction for one candidate. */
export interface FaabInput {
  /** My surplus from the player (points) — `s` of E5. */
  readonly value: number;
  readonly my_budget: number;
  readonly min_bid: number;
  readonly price: PricePerPoint;
  readonly rivals: readonly FaabRival[];
  /** λ in points per dollar (`lambdaOf`). */
  readonly lambda: number;
}

/** P(win | b): no rival who bids outbids me (a rival bids b or more only below his cap). */
export function pWinAt(b: number, input: Pick<FaabInput, "price" | "rivals">): number {
  let p = 1;
  for (const r of input.rivals) {
    const q = clamp(r.q, 0, 1);
    if (q === 0) continue;
    const mean = input.price.value * Math.max(0, r.value) * FAAB.rivalShading;
    if (!(mean > 0)) continue;
    const cap = r.budget_remaining;
    const beat =
      cap !== null && b >= cap ? 0 : 1 - gammaCdfMeanCv(Math.max(0, b), mean, FAAB.rivalBidCv);
    p *= 1 - q * clamp(beat, 0, 1);
  }
  return clamp(p, 0, 1);
}

/**
 * λ — points per dollar a dollar is worth if kept (sib §4.3): the market rate 1/price, scaled by the
 * share of the season still ahead (0 after the last run: unspent budget is worthless), by scarcity
 * (league-average remaining budget / mine)^½, and by the playoff reserve when asked.
 */
export function lambdaOf(input: {
  readonly price: PricePerPoint;
  readonly weeks_remaining: number;
  readonly weeks_season: number;
  readonly my_budget: number;
  readonly rival_budgets: readonly (number | null)[];
  readonly reserve: "none" | "playoff_reserve";
}): number {
  if (!(input.price.value > 0) || !(input.weeks_remaining > 0) || !(input.weeks_season > 0))
    return 0;
  const time = clamp(input.weeks_remaining / input.weeks_season, 0, 1);
  const known = input.rival_budgets.filter(
    (b): b is number => b !== null && Number.isFinite(b) && b >= 0,
  );
  const avg =
    known.length === 0 ? input.my_budget : known.reduce((s, b) => s + b, 0) / known.length;
  const scarcity =
    input.my_budget > 0
      ? clamp((avg / input.my_budget) ** FAAB.scarcityExponent, FAAB.scarcityMin, FAAB.scarcityMax)
      : FAAB.scarcityMax;
  const reserve = input.reserve === "playoff_reserve" ? FAAB.reserveFactor : 1;
  return round((1 / input.price.value) * time * scarcity * reserve, 6);
}

/** The bid advice for one candidate. */
export interface FaabBid {
  readonly b_star: number;
  readonly p_win: number;
  /** P(win | b*) × (value − λ·b*). */
  readonly expected_net: number;
  readonly curve: readonly { readonly bid: number; readonly p_win: number }[];
}

function grid(minBid: number, budget: number): number[] {
  const lo = Math.max(0, Math.ceil(minBid));
  const hi = Math.max(lo, Math.floor(budget));
  const span = hi - lo;
  const step = Math.max(1, Math.ceil(span / (FAAB.maxGridPoints - 1)));
  const out: number[] = [];
  for (let b = lo; b <= hi; b += step) out.push(b);
  if (out[out.length - 1] !== hi) out.push(hi);
  return out;
}

/**
 * `b* = argmax_b P(win | b) × (value − λ·b)` over the integer bids min_bid..my_budget (thinned past
 * `maxGridPoints`), ties to the lower bid; a value ≤ 0 or no positive expectation → b* = 0 with
 * p_win at 0. The curve: P(win) at ×0.5/×1 /×1.5 of b* and at the first bids reaching 25/50/75 %.
 */
export function faabBid(raw: FaabInput): FaabBid {
  const finite0 = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);
  const input: FaabInput = {
    ...raw,
    value: Number.isFinite(raw.value) ? raw.value : 0,
    my_budget: finite0(raw.my_budget),
    min_bid: finite0(raw.min_bid),
    lambda: finite0(raw.lambda),
  };
  const bids = grid(input.min_bid, input.my_budget);
  const lambda = Math.max(0, input.lambda);
  let best = { b: 0, p: pWinAt(0, input), net: 0 };
  let found = false;
  if (input.value > 0)
    for (const b of bids) {
      const p = pWinAt(b, input);
      const net = p * (input.value - lambda * b);
      if (net > best.net + 1e-12) {
        best = { b, p, net };
        found = true;
      }
    }
  const b_star = found ? best.b : 0;
  const points = new Set<number>();
  for (const share of FAAB.curveShares) {
    const b = Math.round(b_star * share);
    if (b >= 0 && b <= input.my_budget) points.add(b);
  }
  for (const target of FAAB.curveTargets) {
    const hit = bids.find((b) => pWinAt(b, input) >= target);
    if (hit !== undefined) points.add(hit);
  }
  const curve = [...points]
    .sort((a, b) => a - b)
    .map((bid) => ({ bid, p_win: round(pWinAt(bid, input), 4) }));
  return {
    b_star,
    p_win: round(found ? best.p : pWinAt(0, input), 4),
    expected_net: round(found ? best.net : 0, 3),
    curve,
  };
}
