// turnover.ts — the turnover model (research 05 §3.2; sibling research 05 §1 step 9): interceptions
// per attempt and fumbles lost per touch are the player's weighted rates shrunk toward the positional
// prior (turnovers carry little forward signal — interception counts among starters are compressed,
// 7–17 a season — so `k` is large), drawn as Poisson counts on each simulated opportunity. Under a
// −2 INT / −2 fumble league they widen the QB's left tail (P(a negative-ish week)) more than they move
// his mean — a level shift, not a re-ranking (research 05 §3.2's clean negative). `turnoverTail`
// gives the exact P(turnover points ≤ −4) for the expected volume (a double Poisson sum). Pure. New here.
import { score } from "../../scoring/engine.js";
import { positionClassOf } from "../../scoring/stat_map.js";
import { asPositionId, type Canonical, type ScoringSettings } from "../../scoring/types.js";
import { PROJECTION_SOURCE_V2 } from "./constants.js";
import { shrinkRate } from "./rates.js";
import type { V2Params, V2PositionPriors, V2Shrinkage, V2TurnoverTail } from "./types.js";
import type { WindowGame } from "./window.js";
import { weightedSum } from "./window.js";

/** The shrunk turnover rates of one player's window. */
export interface TurnoverRates {
  readonly int_per_att: V2Shrinkage;
  readonly fumble_per_touch: V2Shrinkage;
}

/** Interceptions per attempt and fumbles lost per touch (receptions + carries + sacks), shrunk. */
export function turnoverRates(
  win: readonly WindowGame[],
  prior: V2PositionPriors,
  params: V2Params,
): TurnoverRates {
  const ints = weightedSum(win, (w) => w.game.pass_int);
  const att = weightedSum(win, (w) => w.game.pass_att);
  const fl = weightedSum(
    win,
    (w) => w.game.sack_fum_lost + w.game.rush_fum_lost + w.game.rec_fum_lost,
  );
  const touches = weightedSum(win, (w) => w.game.rec + w.game.rush_att + w.game.sacks);
  return {
    int_per_att: shrinkRate("int_per_att", ints.sum, att.sum, params.k.int_rate, prior.int_rate),
    fumble_per_touch: shrinkRate(
      "fumble_per_touch",
      fl.sum,
      touches.sum,
      params.k.fumble_rate,
      prior.fumble_rate,
    ),
  };
}

/** The points one event of `canonical` is worth for a position under S (≤ 0 for turnovers). */
export function eventPoints(
  settings: ScoringSettings,
  canonical: Canonical,
  positionId: number,
): number {
  return score(
    {
      values: { [canonical]: 1 },
      present: [canonical],
      position: asPositionId(positionId),
      position_class: positionClassOf(positionId),
      provisional: false,
      source: PROJECTION_SOURCE_V2,
    },
    settings,
  ).points_exact;
}

/** Poisson pmf vector 0..kmax (the remainder is folded into kmax). */
function poissonPmf(lambda: number, kmax: number): number[] {
  const out: number[] = [];
  if (!(lambda > 0)) {
    out.push(1);
    for (let k = 1; k <= kmax; k++) out.push(0);
    return out;
  }
  let p = Math.exp(-lambda);
  let acc = 0;
  for (let k = 0; k < kmax; k++) {
    out.push(p);
    acc += p;
    p *= lambda / (k + 1);
  }
  out.push(Math.max(0, 1 - acc));
  return out;
}

/** Counts summed exactly up to this many events of each kind (the rest folds into the last). */
const TAIL_KMAX = 12;

/**
 * The turnover tail of one player-week if active: E[turnover points] and P(turnover points ≤ −4)
 * for λ_int = attempts × INT rate and λ_fum = touches × fumble rate, at the league's penalties.
 */
export function turnoverTail(
  settings: ScoringSettings,
  positionId: number,
  expected: { readonly pass_att: number; readonly touches: number },
  rates: { readonly int_per_att: number; readonly fumble_per_touch: number },
): V2TurnoverTail {
  const penInt = Math.min(0, eventPoints(settings, "pass_int", positionId));
  const penFum = Math.min(0, eventPoints(settings, "fum_lost", positionId));
  const li = Math.max(0, expected.pass_att) * Math.max(0, rates.int_per_att);
  const lf = Math.max(0, expected.touches) * Math.max(0, rates.fumble_per_touch);
  const pi = poissonPmf(li, TAIL_KMAX);
  const pf = poissonPmf(lf, TAIL_KMAX);
  let tail = 0;
  for (let a = 0; a <= TAIL_KMAX; a++)
    for (let b = 0; b <= TAIL_KMAX; b++)
      if (a * penInt + b * penFum <= -4 + 1e-9) tail += (pi[a] ?? 0) * (pf[b] ?? 0);
  const r = (x: number): number => Math.round(x * 1e4) / 1e4;
  return {
    int_per_att: r(rates.int_per_att),
    fumble_per_touch: r(rates.fumble_per_touch),
    expected_points: r(li * penInt + lf * penFum),
    p_minus4: r(Math.min(1, Math.max(0, tail))),
  };
}
