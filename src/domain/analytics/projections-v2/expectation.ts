// expectation.ts — the deterministic half of `v2-opportunity` (sibling research 05 §1 steps 1–7):
// team volume from the market (team.ts), the player's shares over his weighted window with the
// change-point re-base (window.ts), expected opportunities, efficiency shrunk per rate (rates.ts),
// touchdowns from location — ffopportunity's expected TDs per opportunity, else pbp red-zone /
// goal-line counts at the league's TD rate per location, else the positional prior; never the
// player's own TD rate (step 5) — scaled by the implied total against the player's own window (the
// market anchor) and the regressed matchup (matchup.ts), the weather terms (weather.ts) and the
// turnover rates (turnover.ts). The simulator (simulate.ts) draws around these numbers. Pure. New here.
import { MULT_BOUNDS, V2_MIN_GAMES } from "./constants.js";
import { matchupMult } from "./matchup.js";
import { shrinkRate } from "./rates.js";
import { teamVolume, type TeamVolume } from "./team.js";
import { turnoverRates } from "./turnover.js";
import type {
  V2Expectation,
  V2Game,
  V2Market,
  V2MatchupCell,
  V2MatchupTable,
  V2Params,
  V2Position,
  V2Priors,
  V2Shrinkage,
  V2TeamGame,
  V2Weather,
} from "./types.js";
import { weatherEffect } from "./weather.js";
import { playerWindow, weightedSum, type ChangePoint, type WindowGame } from "./window.js";

/** What one expectation needs besides the player. */
export interface ExpectationContext {
  readonly season: number;
  readonly week: number;
  /** Team-games indexed by `teamGameKey` (window.ts). */
  readonly team_index: ReadonlyMap<string, V2TeamGame>;
  /** Every team-game (the team volume window reads them). */
  readonly team_games: readonly V2TeamGame[];
  readonly market: V2Market | null;
  readonly weather: V2Weather | null;
  readonly opponent: string | null;
  readonly matchup: V2MatchupTable | null;
  readonly priors: V2Priors;
  readonly params: V2Params;
  /** A memo of team volumes for the target week (the caller's; keyed by team). */
  readonly volume_memo?: Map<string, TeamVolume>;
}

/** Why no expectation was made. */
export type ExpectationSkip = "position_not_modelled" | "no_team" | "no_history";

/** An expectation with the window facts the output reports. */
export interface ExpectationResult {
  readonly expectation: V2Expectation;
  readonly change_point: ChangePoint | null;
  readonly matchup_cell: V2MatchupCell | null;
  readonly team_volume: TeamVolume;
  /** The player's red-zone share of his team's red-zone plays over the window (null: unknown). */
  readonly rz_share: number | null;
  /** The market line was missing: the implied-total and spread terms are neutral. */
  readonly market_missing: boolean;
}

const MODELLED: ReadonlySet<string> = new Set(["QB", "RB", "WR", "TE"]);

/** Whether a display position is modelled by v2. */
export function isV2Position(p: string): p is V2Position {
  return MODELLED.has(p);
}

const fin = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number): number =>
  Number.isNaN(x) ? lo : x < lo ? lo : x > hi ? hi : x;

/** Σw·num / Σw·den over the games where `den` is known and positive. */
function shareOf(
  win: readonly WindowGame[],
  num: (g: V2Game) => number,
  den: (w: WindowGame) => number | null,
): { sum: number; den: number; weight: number } {
  let s = 0;
  let d = 0;
  let weight = 0;
  for (const w of win) {
    const dv = den(w);
    if (dv === null || !Number.isFinite(dv) || dv <= 0) continue;
    s += w.weight * num(w.game);
    d += w.weight * dv;
    weight += w.weight;
  }
  return { sum: s, den: d, weight };
}

/** The location-based TD rate of one opportunity kind (step 5) and its basis. */
function tdRate(
  win: readonly WindowGame[],
  name: string,
  opp: (g: V2Game) => number,
  xtd: (g: V2Game) => number | null,
  location: ((g: V2Game) => number | null) | null,
  k: number,
  prior: number,
): { shrink: V2Shrinkage; basis: V2Expectation["td_basis"] } {
  const x = shareOf(
    win,
    (g) => xtd(g) ?? 0,
    (w) => (fin(xtd(w.game)) ? opp(w.game) : null),
  );
  if (x.den > 0)
    return { shrink: shrinkRate(name, x.sum, x.den, k, prior), basis: "ffopportunity" };
  if (location !== null) {
    const l = shareOf(
      win,
      (g) => location(g) ?? 0,
      (w) => (fin(location(w.game)) ? opp(w.game) : null),
    );
    if (l.den > 0)
      return { shrink: shrinkRate(name, l.sum, l.den, k, prior), basis: "pbp_location" };
  }
  return { shrink: shrinkRate(name, 0, 0, k, prior), basis: "prior" };
}

/**
 * The skips expectV2 decides before any work — a position v2 does not model, no NFL team, no game
 * at all — so a target the CPU deadline reached first keeps its own reason when it has one.
 */
export function quickSkipV2(player: {
  readonly position: string;
  readonly team: string | null;
  readonly games: readonly V2Game[];
}): ExpectationSkip | null {
  if (!isV2Position(player.position)) return "position_not_modelled";
  if (player.team === null || player.team.length === 0) return "no_team";
  if (player.games.length === 0) return "no_history";
  return null;
}

/**
 * The expectation of one player-week, or why none: a position v2 does not model, no NFL team in the
 * target week, or no game before it.
 */
export function expectV2(
  player: {
    readonly position: string;
    readonly position_id: number;
    readonly team: string | null;
    readonly games: readonly V2Game[];
  },
  ctx: ExpectationContext,
): ExpectationResult | ExpectationSkip {
  if (!isV2Position(player.position)) return "position_not_modelled";
  const pos = player.position;
  if (player.team === null || player.team.length === 0) return "no_team";
  const params = ctx.params;
  const window = playerWindow(player.games, ctx.season, ctx.week, ctx.team_index, params);
  if (window.games.length < V2_MIN_GAMES) return "no_history";
  const win = window.games;
  const prior = ctx.priors.positions[pos];

  // step 1 — team volume (memoised per team for the target week)
  let vol = ctx.volume_memo?.get(player.team);
  if (vol === undefined) {
    vol = teamVolume(
      player.team,
      ctx.season,
      ctx.week,
      ctx.team_games,
      ctx.market,
      ctx.priors,
      params,
    );
    ctx.volume_memo?.set(player.team, vol);
  }
  const wx = weatherEffect(ctx.weather, pos);

  // step 2 — shares over the window (team denominators from the team-game of each game)
  const db = (w: WindowGame): number | null => w.team?.dropbacks ?? null;
  const ru = (w: WindowGame): number | null => w.team?.rushes ?? null;
  const ks = Math.max(0, params.k.share);
  const tgtShare = shareOf(win, (g) => g.targets, db);
  const carShare = shareOf(win, (g) => g.rush_att, ru);
  const dbShare = shareOf(win, (g) => g.pass_att + g.sacks, db);
  // a share shrunk toward the positional share with k.share pseudo-games (role uncertainty)
  const shareShrink = (
    name: string,
    s: { sum: number; den: number; weight: number },
    priorShare: number,
  ): V2Shrinkage => {
    if (s.den <= 0 || s.weight <= 0) return shrinkRate(name, 0, 0, ks, priorShare);
    const perGame = s.den / s.weight;
    const out = shrinkRate(name, s.sum / perGame, s.den / perGame, ks, priorShare);
    return { ...out, n: Math.round(s.weight * 1e4) / 1e4 };
  };
  const tgtS = shareShrink("target_share", tgtShare, prior.target_share);
  const carS = shareShrink("carry_share", carShare, prior.carry_share);
  const dbS = shareShrink("dropback_share", dbShare, prior.dropback_share);
  const targetPerDb = tgtS.value;
  const carryShare = carS.value;
  const qbDbShare = dbS.value;

  // step 4 — efficiency, shrunk per rate
  const sum = (f: (g: V2Game) => number) => weightedSum(win, (w) => f(w.game)).sum;
  const shr: V2Shrinkage[] = pos === "QB" ? [dbS, carS] : [tgtS, carS];
  const push = (s: V2Shrinkage): number => {
    shr.push(s);
    return s.value;
  };
  const k = params.k;
  const sackRate = push(
    shrinkRate(
      "sack_rate",
      sum((g) => g.sacks),
      sum((g) => g.pass_att + g.sacks),
      k.sack_rate,
      prior.sack_rate,
    ),
  );
  const cmpRate = push(
    shrinkRate(
      "cmp_rate",
      sum((g) => g.pass_cmp),
      sum((g) => g.pass_att),
      k.cmp_rate,
      prior.cmp_rate,
    ),
  );
  const ypcmp = push(
    shrinkRate(
      "yards_per_cmp",
      sum((g) => g.pass_yd),
      sum((g) => g.pass_cmp),
      k.yards_per_cmp,
      prior.yards_per_cmp,
    ),
  );
  const catchRate = push(
    shrinkRate(
      "catch_rate",
      sum((g) => g.rec),
      sum((g) => g.targets),
      k.catch_rate,
      prior.catch_rate,
    ),
  );
  const ypr = push(
    shrinkRate(
      "yards_per_rec",
      sum((g) => g.rec_yd),
      sum((g) => g.rec),
      k.yards_per_rec,
      prior.yards_per_rec,
    ),
  );
  const ypc = push(
    shrinkRate(
      "yards_per_carry",
      sum((g) => g.rush_yd),
      sum((g) => g.rush_att),
      k.yards_per_carry,
      prior.yards_per_carry,
    ),
  );
  const to = turnoverRates(win, prior, params);
  push(to.int_per_att);
  push(to.fumble_per_touch);

  // step 5 — touchdowns from location
  const tdT = tdRate(
    win,
    "td_per_target",
    (g) => g.targets,
    (g) => g.x_rec_td,
    (g) =>
      fin(g.rz_targets)
        ? g.rz_targets * prior.td_rz_target +
          Math.max(0, g.targets - g.rz_targets) * prior.td_other_target
        : null,
    k.xtd,
    prior.xtd_per_target,
  );
  const tdC = tdRate(
    win,
    "td_per_carry",
    (g) => g.rush_att,
    (g) => g.x_rush_td,
    (g) =>
      fin(g.rz_carries) && fin(g.gl_carries)
        ? g.gl_carries * prior.td_gl_carry +
          Math.max(0, g.rz_carries - g.gl_carries) * prior.td_rz_carry +
          Math.max(0, g.rush_att - g.rz_carries) * prior.td_other_carry
        : null,
    k.xtd,
    prior.xtd_per_carry,
  );
  const tdA = tdRate(
    win,
    "td_per_att",
    (g) => g.pass_att,
    (g) => g.x_pass_td,
    null,
    k.xtd,
    prior.xtd_per_att,
  );
  shr.push(tdT.shrink, tdC.shrink, tdA.shrink);
  const basis: V2Expectation["td_basis"] =
    pos === "QB" ? tdA.basis : pos === "RB" ? tdC.basis : tdT.basis;

  // the market anchor: the target implied total against the player's window environment
  const implW = weightedSum(win, (w) => {
    const v = w.team?.implied;
    return fin(v) ? v : null;
  });
  const targetImplied = ctx.market?.implied;
  const marketMissing = !fin(targetImplied);
  let marketMult = 1;
  if (fin(targetImplied) && implW.weight > 0 && implW.sum > 0) {
    const ratio = targetImplied / (implW.sum / implW.weight);
    const [lo, hi] = MULT_BOUNDS.market;
    marketMult = clamp(ratio > 0 ? ratio ** Math.max(0, params.market_td_theta) : 1, lo, hi);
  }
  // step 6 — the regressed matchup (efficiency and touchdowns; volume is the market's)
  const mu = matchupMult(ctx.matchup, ctx.opponent, pos, params);

  // step 3 — expected opportunities
  const qbDb = pos === "QB" ? vol.dropbacks * qbDbShare : 0;
  const passAtt = pos === "QB" ? qbDb * (1 - sackRate) : 0;
  const targets = pos === "QB" ? 0 : vol.dropbacks * targetPerDb * wx.rb_target_mult;
  const carries = vol.rushes * carryShare;

  const rzT = shareOf(
    win,
    (g) => (g.rz_targets ?? 0) + (g.rz_carries ?? 0),
    (w) => (fin(w.game.rz_targets) && fin(w.game.rz_carries) ? (w.team?.rz_plays ?? null) : null),
  );

  const expectation: V2Expectation = {
    position: pos,
    position_id: player.position_id,
    team_dropbacks: vol.dropbacks,
    team_rushes: vol.rushes,
    att_per_dropback: pos === "QB" ? qbDbShare * (1 - sackRate) : 0,
    sack_per_dropback: pos === "QB" ? qbDbShare * sackRate : 0,
    target_per_dropback: pos === "QB" ? 0 : targetPerDb,
    carry_share: carryShare,
    pass_att: passAtt,
    targets,
    carries,
    cmp_rate: clamp(cmpRate + wx.cmp_delta, 0.05, 0.95),
    yards_per_cmp: Math.max(0, ypcmp * wx.yards_mult * mu.mult),
    catch_rate: clamp(catchRate + wx.cmp_delta, 0.05, 0.99),
    yards_per_rec: Math.max(0, ypr * wx.yards_mult * mu.mult),
    yards_per_carry: Math.max(0, (ypc + wx.ypc_delta) * mu.mult),
    td_per_att: Math.max(0, tdA.shrink.value * marketMult * mu.mult),
    td_per_target: Math.max(0, tdT.shrink.value * marketMult * mu.mult),
    td_per_carry: Math.max(0, tdC.shrink.value * marketMult * mu.mult),
    int_per_att: Math.max(0, to.int_per_att.value),
    fumble_per_touch: Math.max(0, to.fumble_per_touch.value),
    two_pt_per_td: Math.max(0, prior.two_pt_per_td),
    market_mult: marketMult,
    matchup_mult: mu.mult,
    weather: wx,
    role_games: window.role_games,
    games: win.length,
    shrinkage: shr,
    td_basis: basis,
  };
  return {
    expectation,
    change_point: window.change_point,
    matchup_cell: mu.cell,
    team_volume: vol,
    rz_share: rzT.den > 0 ? Math.round((rzT.sum / rzT.den) * 1e4) / 1e4 : null,
    market_missing: marketMissing,
  };
}
