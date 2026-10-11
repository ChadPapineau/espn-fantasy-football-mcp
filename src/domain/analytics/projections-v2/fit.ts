// fit.ts — parameter tuning and the weekly re-fit proposal (sibling research 05 §1-Evaluation: "tune
// h, k per stat, β_pos and the weather multipliers on one season, test on another"; plan 10 §3.3
// and C9: the re-fit is PROPOSED by the retrospective and applied only by a human-run
// `eff tune --apply` — nothing here writes anything). Coordinate descent over named parameters, each
// on a small grid inside V2_PARAM_BOUNDS, minimising the mean CRPS of v2 on a training set of cases
// (common random numbers: every evaluation draws each case's samples from the same stream, so a
// change in the objective is the parameters', not the dice's). A proposal carries the objective
// before and after and is refused when it does not improve by at least `min_gain`. Pure. New here.
import { DEFAULT_V2_PARAMS, V2_PARAM_BOUNDS } from "./constants.js";
import {
  BACKTEST_MODELS,
  evaluateCases,
  scoreModel,
  type BacktestCase,
  type BacktestOptions,
  type BacktestWorld,
} from "./backtest.js";
import type { V2Params, V2Position } from "./types.js";

/** A tunable parameter: a dotted path into V2Params and its candidate values. */
export interface TunableParam {
  readonly path: string;
  readonly grid: readonly number[];
}

/** The default search (sib §1-Evaluation's parameters plus the simulation's dispersions). */
export const DEFAULT_TUNING: readonly TunableParam[] = Object.freeze([
  { path: "half_life_games", grid: [3, 4, 6, 8, 10, 12] },
  { path: "prior_season_weight", grid: [0.3, 0.45, 0.6, 0.8] },
  { path: "change_point.pre_weight", grid: [0.1, 0.25, 0.5, 0.75, 1] },
  { path: "team.half_life_games", grid: [3, 6, 10] },
  { path: "k.share", grid: [0.5, 1, 2, 4] },
  { path: "k.catch_rate", grid: [10, 20, 30, 60] },
  { path: "k.yards_per_rec", grid: [10, 20, 30, 60] },
  { path: "k.yards_per_carry", grid: [30, 60, 100, 300] },
  { path: "k.cmp_rate", grid: [50, 150, 300] },
  { path: "k.yards_per_cmp", grid: [25, 50, 75, 150] },
  { path: "k.int_rate", grid: [100, 200, 400, 800] },
  { path: "k.sack_rate", grid: [50, 150, 300] },
  { path: "k.fumble_rate", grid: [100, 300, 1000] },
  { path: "k.xtd", grid: [40, 80, 160, 320] },
  { path: "market_td_theta", grid: [0.5, 1, 1.5, 2] },
  { path: "matchup_beta.QB", grid: [0, 0.25, 0.5, 0.75, 1] },
  { path: "matchup_beta.RB", grid: [0, 0.25, 0.5, 0.75, 1] },
  { path: "matchup_beta.WR", grid: [0, 0.25, 0.5, 0.75, 1] },
  { path: "matchup_beta.TE", grid: [0, 0.25, 0.5, 0.75, 1] },
  { path: "sim.cv_common", grid: [0.06, 0.12, 0.18] },
  { path: "sim.cv_pass", grid: [0.06, 0.12, 0.18] },
  { path: "sim.cv_share", grid: [0.1, 0.2, 0.3] },
  { path: "sim.share_role_games", grid: [1, 2, 4] },
  { path: "sim.cv_rush", grid: [0.1, 0.18, 0.28] },
  { path: "sim.cv_eff", grid: [0, 0.1, 0.15, 0.25] },
  { path: "sim.cv_yds_catch", grid: [0.5, 0.7, 0.9, 1.1] },
  { path: "sim.cv_yds_carry", grid: [0.9, 1.1, 1.4, 1.8] },
  { path: "sim.cv_yds_cmp", grid: [0.5, 0.6, 0.85, 1.1] },
]);

/**
 * The own simulation's per-position dispersion search (Stage C; `sim.position` — types.ts): the role
 * draw and the yardage CVs each position's line carries. Fitted per position on that position's
 * cases (`fitPositionDispersion`), on the training season only.
 */
export const DISPERSION_TUNING: Readonly<Record<V2Position, readonly TunableParam[]>> =
  Object.freeze({
    QB: Object.freeze([
      { path: "sim.position.QB.role", grid: [0.75, 1, 1.25, 1.5, 2] },
      { path: "sim.position.QB.yds_cmp", grid: [1, 1.5, 2, 2.5, 3] },
      { path: "sim.position.QB.yds_carry", grid: [0.6, 0.8, 1, 1.25] },
    ]),
    RB: Object.freeze([
      { path: "sim.position.RB.role", grid: [0.75, 1, 1.25, 1.5, 2] },
      { path: "sim.position.RB.yds_catch", grid: [0.75, 1, 1.5, 2, 2.5] },
      { path: "sim.position.RB.yds_carry", grid: [0.6, 0.8, 1, 1.25] },
    ]),
    WR: Object.freeze([
      { path: "sim.position.WR.role", grid: [0.75, 1, 1.25, 1.5, 2] },
      { path: "sim.position.WR.yds_catch", grid: [0.75, 1, 1.5, 2, 2.5] },
    ]),
    TE: Object.freeze([
      { path: "sim.position.TE.role", grid: [0.75, 1, 1.25, 1.5, 2] },
      { path: "sim.position.TE.yds_catch", grid: [0.75, 1, 1.5, 2, 2.5] },
    ]),
  });

/** A value at a dotted path of the parameters (NaN when the path does not name a number). */
export function paramAt(p: V2Params, path: string): number {
  let cur: unknown = p;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, k)) return Number.NaN;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "number" ? cur : Number.NaN;
}

/** The parameters with one dotted path set (a new frozen object; throws on an unknown path). */
export function withParam(p: V2Params, path: string, value: number): V2Params {
  const keys = path.split(".");
  const set = (obj: unknown, i: number): unknown => {
    if (obj === null || typeof obj !== "object") throw new RangeError(`fit: no parameter ${path}`);
    const k = keys[i] ?? "";
    if (!Object.hasOwn(obj, k)) throw new RangeError(`fit: no parameter ${path}`);
    const rec = obj as Record<string, unknown>;
    if (i === keys.length - 1) {
      if (typeof rec[k] !== "number") throw new RangeError(`fit: ${path} is not a number`);
      return Object.freeze({ ...rec, [k]: value });
    }
    return Object.freeze({ ...rec, [k]: set(rec[k], i + 1) });
  };
  return set(p, 0) as V2Params;
}

/** Whether a value lies inside the bounds of its parameter family. */
export function inBounds(path: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const b = V2_PARAM_BOUNDS;
  const range: readonly [number, number] =
    path === "half_life_games" || path === "team.half_life_games"
      ? b.half_life_games
      : path === "prior_season_weight" || path === "change_point.pre_weight"
        ? b.prior_season_weight
        : path === "market_td_theta"
          ? b.market_td_theta
          : path.startsWith("matchup_beta.")
            ? b.matchup_beta
            : path.startsWith("k.")
              ? b.k
              : path.startsWith("sim.position.")
                ? b.dispersion
                : path.startsWith("sim.")
                  ? b.cv
                  : [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  return value >= range[0] && value <= range[1];
}

/** One coordinate-descent step's record. */
export interface FitStep {
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly crps: number;
}

/** A tuning result (a proposal: nothing applies it here). */
export interface FitProposal {
  readonly params: V2Params;
  readonly crps_before: number;
  readonly crps_after: number;
  readonly steps: readonly FitStep[];
  readonly evaluations: number;
  /** False when the improvement is below `min_gain` (the proposal then equals the start). */
  readonly accepted: boolean;
}

/** Options of a fit. */
export interface FitOptions extends BacktestOptions {
  readonly tuning?: readonly TunableParam[];
  readonly passes?: number;
  /** The least relative CRPS improvement a proposal must show (default 0.2 %). */
  readonly min_gain?: number;
}

/** The mean v2 CRPS of the cases under params (the fit's objective). */
export function objective(
  world: BacktestWorld,
  cases: readonly BacktestCase[],
  params: V2Params,
  opts: BacktestOptions,
): number {
  const recs = evaluateCases(world, cases, { ...opts, params });
  return scoreModel(recs, BACKTEST_MODELS.v2).crps ?? Number.POSITIVE_INFINITY;
}

/**
 * Coordinate descent from `start` (default DEFAULT_V2_PARAMS) over `tuning`, `passes` times (default
 * 2). Only in-bounds grid values are tried; a step is taken only when it lowers the objective.
 */
export function fitV2Params(
  world: BacktestWorld,
  cases: readonly BacktestCase[],
  start: V2Params = DEFAULT_V2_PARAMS,
  opts: FitOptions = {},
): FitProposal {
  const tuning = opts.tuning ?? DEFAULT_TUNING;
  const passes = Math.max(1, Math.round(opts.passes ?? 2));
  let best = start;
  let evaluations = 1;
  const before = objective(world, cases, start, opts);
  let bestCrps = before;
  const steps: FitStep[] = [];
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const t of tuning) {
      const current = paramAt(best, t.path);
      if (Number.isNaN(current)) throw new RangeError(`fit: no parameter ${t.path}`);
      for (const v of t.grid) {
        if (v === current || !inBounds(t.path, v)) continue;
        const cand = withParam(best, t.path, v);
        const c = objective(world, cases, cand, opts);
        evaluations += 1;
        if (c < bestCrps - 1e-9) {
          steps.push({ path: t.path, from: paramAt(best, t.path), to: v, crps: c });
          best = cand;
          bestCrps = c;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  const minGain = opts.min_gain ?? 0.002;
  const accepted = before - bestCrps >= minGain * before;
  return {
    params: accepted ? best : start,
    crps_before: before,
    crps_after: accepted ? bestCrps : before,
    steps,
    evaluations,
    accepted,
  };
}

/** One position's dispersion fit (a proposal over that position's cases). */
export interface PositionDispersionFit {
  readonly position: V2Position;
  readonly cases: number;
  readonly proposal: FitProposal;
}

/**
 * Fits the own simulation's per-position dispersion (`DISPERSION_TUNING`), one position at a time on
 * that position's cases only (its multipliers move no other position's draws), each from the
 * previous position's result, so the returned parameters carry every accepted fit. A proposal: the
 * caller decides what to commit (constants.ts), and only training-season cases may be passed.
 */
export function fitPositionDispersion(
  world: BacktestWorld,
  cases: readonly BacktestCase[],
  positions: readonly V2Position[],
  start: V2Params = DEFAULT_V2_PARAMS,
  opts: FitOptions = {},
): { readonly params: V2Params; readonly fits: readonly PositionDispersionFit[] } {
  let params = start;
  const fits: PositionDispersionFit[] = [];
  for (const position of positions) {
    const own = cases.filter((c) => c.position === position);
    const proposal = fitV2Params(world, own, params, {
      ...opts,
      tuning: opts.tuning ?? DISPERSION_TUNING[position],
    });
    params = proposal.params;
    fits.push({ position, cases: own.length, proposal });
  }
  return { params, fits };
}

/** One proposed change for `eff tune` (C9: shown as a diff, applied only by a human). */
export interface ParamChange {
  readonly path: string;
  readonly current: number;
  readonly proposed: number;
}

/** The changed paths between two parameter sets (for the human-run `eff tune` diff). */
export function diffParams(
  current: V2Params,
  proposed: V2Params,
  paths: readonly string[] = DEFAULT_TUNING.map((t) => t.path),
): ParamChange[] {
  const out: ParamChange[] = [];
  for (const path of paths) {
    const a = paramAt(current, path);
    const b = paramAt(proposed, path);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b)
      out.push({ path, current: a, proposed: b });
  }
  return out;
}

/**
 * The weekly re-fit proposal the retrospective writes (plan 10 C9): one coordinate pass from the
 * current parameters over the recent cases. Returned for a human to review; never applied here.
 */
export function proposeV2Refit(
  world: BacktestWorld,
  recentCases: readonly BacktestCase[],
  current: V2Params,
  opts: FitOptions = {},
): { readonly proposal: FitProposal; readonly changes: readonly ParamChange[] } {
  const proposal = fitV2Params(world, recentCases, current, { passes: 1, ...opts });
  return {
    proposal,
    changes: diffParams(
      current,
      proposal.params,
      (opts.tuning ?? DEFAULT_TUNING).map((t) => t.path),
    ),
  };
}
