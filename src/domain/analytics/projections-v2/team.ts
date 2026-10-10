// team.ts — team volume from the market and tendencies (sibling research 05 §1 step 1): a team's
// dropbacks and rushes per game are an exponentially weighted mean of its previous games shrunk
// toward the league mean, moved by the target week's spread against the window's mean spread (a
// favourite runs more and passes less — measured on the 2023 excerpt: dropbacks −0.094 and rushes
// +0.246 per point of team-side spread [V-data]); the implied total scales touchdown rates (the
// market anchor, applied in expectation.ts against the player's own window). Pure. New here.
import type { V2Market, V2Params, V2Priors, V2TeamGame } from "./types.js";
import { isBefore } from "./window.js";

/** A team's expected volume in the target week. */
export interface TeamVolume {
  readonly dropbacks: number;
  readonly rushes: number;
  /** The window's own means before the market adjustment. */
  readonly base_dropbacks: number;
  readonly base_rushes: number;
  /** The target spread and the window's weighted mean spread (null when either is unknown). */
  readonly spread: number | null;
  readonly window_spread: number | null;
  readonly games: number;
}

const fin = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;
const finAny = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);

/** The fewest share of its base a market adjustment may leave (a 30-point spread is not 0 rushes). */
const MIN_SHARE_OF_BASE = 0.5;

/**
 * A team's expected dropbacks and rushes for (season, week) from its games before it (most recent
 * first, at most 2 × max_games; older seasons discounted by prior_season_weight per season back).
 */
export function teamVolume(
  team: string,
  season: number,
  week: number,
  rows: readonly V2TeamGame[],
  market: V2Market | null | undefined,
  priors: V2Priors,
  params: V2Params,
): TeamVolume {
  const games = rows
    .filter((r) => r.team === team && isBefore(r, season, week))
    .sort((a, b) => b.season - a.season || b.week - a.week)
    .slice(0, Math.max(1, Math.round(params.max_games * 2)));
  const h = Math.max(0.25, params.team.half_life_games);
  let wDb = 0;
  let sDb = 0;
  let wRu = 0;
  let sRu = 0;
  let wSp = 0;
  let sSp = 0;
  games.forEach((g, i) => {
    const w =
      0.5 ** (i / h) * Math.max(0, params.prior_season_weight) ** Math.max(0, season - g.season);
    if (fin(g.dropbacks)) {
      wDb += w;
      sDb += w * g.dropbacks;
    }
    if (fin(g.rushes)) {
      wRu += w;
      sRu += w * g.rushes;
    }
    if (finAny(g.spread)) {
      wSp += w;
      sSp += w * g.spread;
    }
  });
  const k = Math.max(0, params.team.shrink_games);
  const baseDb =
    wDb + k > 0 ? (sDb + k * priors.team_dropbacks) / (wDb + k) : priors.team_dropbacks;
  const baseRu = wRu + k > 0 ? (sRu + k * priors.team_rushes) / (wRu + k) : priors.team_rushes;
  const spread = finAny(market?.spread) ? market.spread : null;
  const windowSpread = wSp > 0 ? sSp / wSp : null;
  let db = baseDb;
  let ru = baseRu;
  if (spread !== null) {
    const d = spread - (windowSpread ?? 0);
    db = Math.max(baseDb * MIN_SHARE_OF_BASE, baseDb - params.team.spread_db * d);
    ru = Math.max(baseRu * MIN_SHARE_OF_BASE, baseRu + params.team.spread_ru * d);
  }
  return {
    dropbacks: db,
    rushes: ru,
    base_dropbacks: baseDb,
    base_rushes: baseRu,
    spread,
    window_spread: windowSpread,
    games: games.length,
  };
}
