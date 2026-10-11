// trace.ts — v2-opportunity's tuning trace of one player-week (plan 10 C9: the retrospective's weekly
// re-fit reads it; src/domain/reclog/attribution.ts ProjectionTrace is the structural contract, held
// assignable by a type test): the matchup multiplier as m = 1 + β·z (β the position's parameter, z the
// shrunk relative aFPA — sib §1 step 6), the weather multiplier applied (step 7), the per-game share
// history of the current role (step 2: the games since the change point, oldest first, with the
// half-life the window used) and each shrunk efficiency rate with its (n, observed, prior, k) (step
// 4), named in the retrospective registry's vocabulary. The realised side (`realised`, `realised_n`)
// is unknown when the projection is made and stays null/0 here — the retrospective fills it from the
// final week. Pure. New here.
import type { ExpectationResult } from "./expectation.js";
import type { V2Game, V2Params, V2Position, V2Shrinkage, V2TeamGame } from "./types.js";
import { playerWindow } from "./window.js";

/** A share the trace carries (the registry's share names v2 models). */
export type V2TraceShareName = "target_share" | "carry_share";
/** A rate the trace carries (the registry's rate names v2 has a counterpart for). */
export type V2TraceRateName =
  | "catch_rate"
  | "yards_per_reception"
  | "yards_per_carry"
  | "completion_rate"
  | "int_rate"
  | "td_rate";

/** One share window of the trace. */
export interface V2TraceShare {
  readonly name: V2TraceShareName;
  readonly history: readonly number[];
  readonly half_life: number;
  readonly realised: number | null;
}

/** One shrunk rate of the trace. */
export interface V2TraceRate {
  readonly name: V2TraceRateName;
  readonly n_obs: number;
  readonly observed: number;
  readonly prior: number;
  readonly k: number;
  readonly realised: number | null;
  readonly realised_n: number;
}

/** The trace (structurally reclog's ProjectionTrace). */
export interface V2Trace {
  readonly matchup: { readonly z: number; readonly beta: number } | null;
  readonly weather_mult: number | null;
  readonly shares: readonly V2TraceShare[];
  readonly rates: readonly V2TraceRate[];
}

/** Most games a share history keeps (reclog ATTRIBUTION_BOUNDS.shareHistory is 32). */
export const TRACE_HISTORY_MAX = 32;

/** v2's shrinkage names → the registry's rate names; the TD rate is the position's main one. */
function rateNameOf(rate: string, pos: V2Position): V2TraceRateName | null {
  switch (rate) {
    case "catch_rate":
      return "catch_rate";
    case "yards_per_rec":
      return "yards_per_reception";
    case "yards_per_carry":
      return "yards_per_carry";
    case "cmp_rate":
      return "completion_rate";
    case "int_per_att":
      return "int_rate";
    case "td_per_att":
      return pos === "QB" ? "td_rate" : null;
    case "td_per_carry":
      return pos === "RB" ? "td_rate" : null;
    case "td_per_target":
      return pos === "WR" || pos === "TE" ? "td_rate" : null;
    default:
      return null;
  }
}

const fin = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const unit = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The trace of one expectation. `games`, `season`, `week`, `teamIndex` and `params` must be the ones
 * the expectation was made with (the window is recomputed exactly as expectV2 did).
 */
export function traceV2(
  result: ExpectationResult,
  games: readonly V2Game[],
  season: number,
  week: number,
  teamIndex: ReadonlyMap<string, V2TeamGame>,
  params: V2Params,
): V2Trace {
  const e = result.expectation;
  const pos = e.position;
  const win = playerWindow(games, season, week, teamIndex, params);
  // the current role: the games since (and including) the change point, oldest first
  const role = win.games.slice(0, Math.max(1, win.role_games)).reverse();
  const shareHistory = (
    num: (g: V2Game) => number,
    den: (t: V2TeamGame) => number | null,
  ): number[] => {
    const out: number[] = [];
    for (const w of role) {
      const d = w.team === null ? null : den(w.team);
      if (!fin(d) || d <= 0) continue;
      out.push(r4(unit(num(w.game) / d)));
    }
    return out.slice(-TRACE_HISTORY_MAX);
  };
  const h = Math.max(0.25, params.half_life_games);
  const shares: V2TraceShare[] = [];
  if (pos !== "QB") {
    const t = shareHistory(
      (g) => g.targets,
      (tg) => tg.dropbacks,
    );
    if (t.length > 0)
      shares.push({ name: "target_share", history: t, half_life: h, realised: null });
  }
  const c = shareHistory(
    (g) => g.rush_att,
    (tg) => tg.rushes,
  );
  if (c.length > 0) shares.push({ name: "carry_share", history: c, half_life: h, realised: null });

  const rates: V2TraceRate[] = [];
  const seen = new Set<V2TraceRateName>();
  const addRate = (s: V2Shrinkage): void => {
    const name = rateNameOf(s.rate, pos);
    if (name === null || seen.has(name) || s.observed === null || !fin(s.observed)) return;
    if (!(s.n > 0) || !fin(s.prior) || !(s.k > 0)) return;
    seen.add(name);
    rates.push({
      name,
      n_obs: s.n,
      observed: s.observed,
      prior: s.prior,
      k: s.k,
      realised: null,
      realised_n: 0,
    });
  };
  for (const s of e.shrinkage) addRate(s);

  const cell = result.matchup_cell;
  const beta = Math.max(0, params.matchup_beta[pos]);
  const full = Math.max(1, params.matchup_full_games);
  const matchup =
    cell === null || !fin(cell.relative)
      ? null
      : { z: r4(Math.min(1, Math.max(0, cell.games) / full) * (cell.relative - 1)), beta };
  return {
    matchup,
    weather_mult: e.weather.applied ? r4(e.weather.yards_mult) : null,
    shares,
    rates,
  };
}
