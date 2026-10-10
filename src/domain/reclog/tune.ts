// tune.ts — the weekly re-fit of the projection parameters (plan 10 §3.3 "the weekly re-fit of the
// projection parameters proposed by retro and applied only by a human-run `eff tune --apply`", C9;
// plan 07 E13 `parameter_changes_proposed` — proposed, never applied, by the tool; sib research 05
// §12.4–§12.5 "re-fit the tuned parameters on a rolling window each week, with a floor on window
// size"; research 05 §8.4 "every claim of improvement must hold … not be concentrated"; plan 07 E1 /
// ADV OBJ-02: weight_espn moves only when the league-scored comparison shows the mixture beats ESPN
// alone). Four fits over the retrospective's attributed player-weeks (attribution.ts):
//   ewm_half_life_games      — the EWM share half-life h (sib §1 step 2): least squares of the
//                              realised share on the EWM of the window, h on a 0.5-game grid;
//   shrink_k.<rate>          — the stabilisation constant k per rate (step 4): weighted least squares
//                              of the realised rate on (n·obs + k·prior)/(n + k), k on a log grid;
//   matchup_beta.<POS>       — β_pos of the regressed matchup (step 6): closed-form least squares of
//                              realised engine points on base·(1 + β·z);
//   weight_espn              — the ESPN mixture weight (E1): mean absolute error of the mixture mean
//                              over the paired player-weeks, one 0.25 step at a time.
// Every proposal is shrunk toward the value in effect by its evidence (n / (n + n0)), capped at one
// step per apply, clamped to its bounds, and made only when its loss beats the current value's
// overall AND in both halves of the window. Also the tuned-parameters document (`eff tune --apply`
// writes it; the projection model reads its overrides) and the apply / revert plans. Pure. New here.
import { createHash } from "node:crypto";
import type { IsoInstant, Week } from "../league/types.js";
import type { PlayerWeekAttribution, RateName } from "./attribution.js";
import { RATE_NAMES } from "./attribution.js";
import { isMetricValue, stableSum } from "./metrics.js";
import { isIsoInstant } from "./record.js";
import {
  PARAMETER_NAME_RE,
  type ParameterChange,
  type ParameterEvaluation,
  type ParameterProposal,
  type ParameterProposalSet,
  type ProposalOutcome,
  type TuneFitKind,
} from "./types.js";

// --- the registry ----------------------------------------------------------------------------------

/** One tunable parameter. */
export interface TunableParameter {
  readonly name: string;
  readonly fit: TuneFitKind;
  /** The rate (shrinkage_k) or position (matchup_beta) the parameter is for. */
  readonly key: string | null;
  readonly min: number;
  readonly max: number;
  /** Largest move per apply: absolute (linear) or a factor (log). */
  readonly max_step: number;
  readonly scale: "linear" | "log";
  /** The resolution a proposal is rounded to (linear: a step; log: significant digits). */
  readonly resolution: number;
  /** Below this many evidence items no proposal (the window-size floor — sib §12.5). */
  readonly min_evidence: number;
  /** Pseudo-observations of the value in effect (the proposal's shrinkage toward it). */
  readonly prior_n: number;
  /** A proposal must move at least this far (linear: absolute; log: a factor). */
  readonly min_move: number;
}

/** The positions β_pos is fitted for (sib §1 step 6). */
export const MATCHUP_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"] as const);

/** The candidate ESPN weights (plan 10 B14's shadow weights and v1's 1.0). */
export const WEIGHT_ESPN_CANDIDATES = Object.freeze([0.5, 0.75, 1] as const);

/** The relative MAE gain a weight_espn move needs (overall and in both halves). */
export const WEIGHT_ESPN_MIN_GAIN = 0.02;

/** The tunable parameters, in report order (names satisfy PARAMETER_NAME_RE). */
export const TUNABLE_PARAMETERS: readonly TunableParameter[] = Object.freeze([
  {
    name: "ewm_half_life_games",
    fit: "ewm_half_life",
    key: null,
    min: 1,
    max: 8,
    max_step: 1,
    scale: "linear",
    resolution: 0.5,
    min_evidence: 100,
    prior_n: 100,
    min_move: 0.5,
  },
  ...RATE_NAMES.map((r): TunableParameter => ({
    name: `shrink_k.${r}`,
    fit: "shrinkage_k",
    key: r,
    min: 1,
    max: 5000,
    max_step: 2,
    scale: "log",
    resolution: 2,
    min_evidence: 100,
    prior_n: 100,
    min_move: 1.1,
  })),
  ...MATCHUP_POSITIONS.map((p): TunableParameter => ({
    name: `matchup_beta.${p}`,
    fit: "matchup_beta",
    key: p,
    min: 0,
    max: 1,
    max_step: 0.1,
    scale: "linear",
    resolution: 0.01,
    min_evidence: 150,
    prior_n: 200,
    min_move: 0.02,
  })),
  {
    name: "weight_espn",
    fit: "weight_espn",
    key: null,
    min: 0.5,
    max: 1,
    max_step: 0.25,
    scale: "linear",
    resolution: 0.25,
    min_evidence: 300,
    prior_n: 0,
    min_move: 0.25,
  },
]);

const REGISTRY = new Map<string, TunableParameter>(TUNABLE_PARAMETERS.map((p) => [p.name, p]));

/** The registry entry of a name this module itself builds (a missing one is a programming error). */
function param(name: string): TunableParameter {
  const p = REGISTRY.get(name);
  if (p === undefined) throw new Error(`tune: no registry entry ${name}`);
  return p;
}

/** The registry entry of a parameter name, or undefined. */
export function tunable(name: string): TunableParameter | undefined {
  return typeof name === "string" ? REGISTRY.get(name) : undefined;
}

/** Whether `v` is a legal value of `p` (finite, within its bounds). */
export function legalValue(p: TunableParameter, v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= p.min && v <= p.max;
}

/** Rounds a value to the parameter's resolution (log: significant digits). */
export function roundTo(p: TunableParameter, v: number): number {
  if (p.scale === "log") {
    const digits = Math.max(1, Math.floor(p.resolution));
    return Number(v.toPrecision(digits));
  }
  const r = Math.round(v / p.resolution) * p.resolution;
  return Number(r.toFixed(6));
}

/** Whether moving from `a` to `b` is within one step. */
export function withinStep(p: TunableParameter, a: number, b: number): boolean {
  if (p.scale === "log") {
    if (!(a > 0 && b > 0)) return false;
    return Math.max(a / b, b / a) <= p.max_step * (1 + 1e-9);
  }
  return Math.abs(b - a) <= p.max_step + 1e-9;
}

/** Whether `a` → `b` is a move at all (at least min_move). */
function moves(p: TunableParameter, a: number, b: number): boolean {
  if (p.scale === "log") return a > 0 && b > 0 && Math.max(a / b, b / a) >= p.min_move;
  return Math.abs(b - a) >= p.min_move - 1e-9;
}

/**
 * The proposal from the value in effect toward the fitted one: shrunk by n / (n + prior_n) (in log
 * space for a log parameter), capped at one step, clamped to the bounds and rounded.
 */
export function shrinkStep(
  p: TunableParameter,
  current: number,
  fitted: number,
  n: number,
): number {
  const w = n / (n + p.prior_n);
  let target: number;
  if (p.scale === "log") {
    const lc = Math.log(current);
    const lt = lc + (Math.log(fitted) - lc) * w;
    const cap = Math.log(p.max_step);
    target = Math.exp(Math.min(lc + cap, Math.max(lc - cap, lt)));
  } else {
    const t = current + (fitted - current) * w;
    target = Math.min(current + p.max_step, Math.max(current - p.max_step, t));
  }
  return roundTo(p, Math.min(p.max, Math.max(p.min, target)));
}

// --- the fits ---------------------------------------------------------------------------------------

/** The EWM of a window (oldest first) with half-life h games: weight 2^(−age / h). */
export function ewm(history: readonly number[], h: number): number {
  const n = history.length;
  const ws: number[] = [];
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = 2 ** (-(n - 1 - i) / h);
    ws.push(w);
    xs.push(w * (history[i] ?? 0));
  }
  return stableSum(xs) / stableSum(ws);
}

/** The shrunk rate (n·obs + k·prior) / (n + k). */
export function shrunkRate(nObs: number, observed: number, prior: number, k: number): number {
  return (nObs * observed + k * prior) / (nObs + k);
}

/** h's grid: 1, 1.5, …, 8 games. */
export const HALF_LIFE_GRID: readonly number[] = Object.freeze(
  Array.from({ length: 15 }, (_, i) => 1 + i / 2),
);
/** k's grid: 49 log-spaced values from 1 to 5000. */
export const K_GRID: readonly number[] = Object.freeze(
  Array.from({ length: 49 }, (_, i) => Math.exp((i / 48) * Math.log(5000))),
);

/** An evidence item with the week it belongs to (for the both-halves check). */
interface Item<T> {
  readonly week: Week;
  readonly x: T;
}

/** Splits items at the median week: weeks ≤ median vs later (both halves non-empty, else null). */
export function halves<T>(items: readonly Item<T>[]): [Item<T>[], Item<T>[]] | null {
  if (items.length === 0) return null;
  const weeks = [...new Set(items.map((i) => i.week))].sort((a, b) => a - b);
  if (weeks.length < 2) return null;
  const cut = weeks[Math.floor((weeks.length - 1) / 2)] ?? 0;
  const a = items.filter((i) => i.week <= cut);
  const b = items.filter((i) => i.week > cut);
  return a.length > 0 && b.length > 0 ? [a, b] : null;
}

/**
 * Whether a proposal holds: its loss beats the current value's overall and — when the window spans
 * two or more weeks — in both halves (research 05 §8.4: not concentrated in part of the window).
 */
export function holds<T>(
  items: readonly Item<T>[],
  loss: (xs: readonly Item<T>[], which: "current" | "proposed") => number,
  margin = 0,
): { readonly ok: boolean; readonly current: number; readonly proposed: number } {
  const current = loss(items, "current");
  const proposed = loss(items, "proposed");
  const better = (c: number, p: number): boolean => p < c * (1 - margin) - 1e-12;
  let ok = better(current, proposed);
  const h = halves(items);
  if (ok && h !== null)
    ok = h.every((part) => better(loss(part, "current"), loss(part, "proposed")));
  return { ok, current, proposed };
}

/** The value in effect: the applied override, else the newest week's reported value, else null. */
export function currentValue(
  applied: number | null,
  reported: readonly { readonly week: Week; readonly value: number }[],
): number | null {
  if (applied !== null) return applied;
  let best: { week: Week; value: number } | null = null;
  for (const r of reported) if (best === null || r.week > best.week) best = r;
  return best === null ? null : best.value;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : stableSum(xs) / xs.length);

/** One fit's outcome for one parameter. */
interface FitResult {
  readonly evaluation: ParameterEvaluation;
  readonly proposal: ParameterProposal | null;
}

function result(
  p: TunableParameter,
  n: number,
  outcome: ProposalOutcome,
  current: number | null,
  fitted: number | null,
  proposal: ParameterProposal | null = null,
): FitResult {
  return {
    evaluation: { parameter: p.name, fit: p.fit, evidence_n: n, outcome, current, fitted },
    proposal,
  };
}

/** The common tail: gates, shrinkage, the holds check and the proposal. */
function propose<T>(
  p: TunableParameter,
  items: readonly Item<T>[],
  current: number | null,
  fitted: number | null,
  lossAt: (xs: readonly Item<T>[], v: number | "current") => number,
  margin = 0,
): FitResult {
  const n = items.length;
  if (current === null || !legalValue(p, current))
    return result(p, n, "current_unknown", null, fitted);
  if (n < p.min_evidence || fitted === null) return result(p, n, "n_too_small", current, fitted);
  const proposed = shrinkStep(p, current, fitted, n);
  if (!moves(p, current, proposed)) return result(p, n, "no_change", current, fitted);
  const h = holds(
    items,
    (xs, which) => lossAt(xs, which === "current" ? "current" : proposed),
    margin,
  );
  if (!h.ok) return result(p, n, "not_held", current, fitted);
  return result(p, n, "proposed", current, fitted, {
    parameter: p.name,
    current,
    proposed,
    evidence_n: n,
    fit: p.fit,
    loss_current: h.current,
    loss_proposed: h.proposed,
  });
}

/** The argmin of `loss` over a grid (ties: the first). */
function argmin(grid: readonly number[], loss: (v: number) => number): number | null {
  let best: number | null = null;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const v of grid) {
    const l = loss(v);
    if (Number.isFinite(l) && l < bestLoss - 1e-12) {
      best = v;
      bestLoss = l;
    }
  }
  return best;
}

interface ShareItem {
  readonly history: readonly number[];
  readonly half_life: number;
  readonly realised: number;
}

/** ewm_half_life_games: least squares over every share window with a realised share. */
export function fitHalfLife(
  rows: readonly PlayerWeekAttribution[],
  applied: number | null,
): FitResult {
  const p = param("ewm_half_life_games");
  const items: Item<ShareItem>[] = [];
  for (const r of rows)
    for (const s of r.trace?.shares ?? [])
      if (s.realised !== null)
        items.push({
          week: r.week,
          x: { history: s.history, half_life: s.half_life, realised: s.realised },
        });
  const current = currentValue(
    applied,
    items.map((i) => ({ week: i.week, value: i.x.half_life })),
  );
  const sse = (xs: readonly Item<ShareItem>[], h: number | "current"): number =>
    mean(
      xs.map((i) => (i.x.realised - ewm(i.x.history, h === "current" ? i.x.half_life : h)) ** 2),
    );
  const fitted = items.length === 0 ? null : argmin(HALF_LIFE_GRID, (h) => sse(items, h));
  return propose(p, items, current, fitted, sse);
}

interface RateItem {
  readonly n_obs: number;
  readonly observed: number;
  readonly prior: number;
  readonly k: number;
  readonly realised: number;
  readonly w: number;
}

/** shrink_k.<rate>: weighted least squares (weight = realised opportunities). */
export function fitShrinkK(
  rows: readonly PlayerWeekAttribution[],
  rate: RateName,
  applied: number | null,
): FitResult {
  const p = param(`shrink_k.${rate}`);
  const items: Item<RateItem>[] = [];
  for (const r of rows)
    for (const t of r.trace?.rates ?? [])
      if (t.name === rate && t.realised !== null && t.realised_n > 0)
        items.push({
          week: r.week,
          x: {
            n_obs: t.n_obs,
            observed: t.observed,
            prior: t.prior,
            k: t.k,
            realised: t.realised,
            w: t.realised_n,
          },
        });
  const current = currentValue(
    applied,
    items.map((i) => ({ week: i.week, value: i.x.k })),
  );
  const wsse = (xs: readonly Item<RateItem>[], k: number | "current"): number => {
    const num: number[] = [];
    const den: number[] = [];
    for (const { x } of xs) {
      const hat = shrunkRate(x.n_obs, x.observed, x.prior, k === "current" ? x.k : k);
      num.push(x.w * (x.realised - hat) ** 2);
      den.push(x.w);
    }
    const d = stableSum(den);
    return d > 0 ? stableSum(num) / d : 0;
  };
  const fitted = items.length === 0 ? null : argmin(K_GRID, (k) => wsse(items, k));
  return propose(p, items, current, fitted, wsse);
}

interface MatchupItem {
  readonly base: number;
  readonly z: number;
  readonly beta: number;
  readonly y: number;
}

/** matchup_beta.<POS>: closed-form least squares of realised engine points on base·(1 + β·z). */
export function fitMatchupBeta(
  rows: readonly PlayerWeekAttribution[],
  position: string,
  applied: number | null,
): FitResult {
  const p = param(`matchup_beta.${position}`);
  const items: Item<MatchupItem>[] = [];
  for (const r of rows) {
    const m = r.trace?.matchup;
    if (!r.active || r.position !== position || m === undefined || m === null) continue;
    const mult = 1 + m.beta * m.z;
    if (!(mult > 0) || !(r.expected_points > 0)) continue;
    items.push({
      week: r.week,
      x: { base: r.expected_points / mult, z: m.z, beta: m.beta, y: r.realised_engine },
    });
  }
  const current = currentValue(
    applied,
    items.map((i) => ({ week: i.week, value: i.x.beta })),
  );
  const sse = (xs: readonly Item<MatchupItem>[], b: number | "current"): number =>
    mean(xs.map(({ x }) => (x.y - x.base * (1 + (b === "current" ? x.beta : b) * x.z)) ** 2));
  const num: number[] = [];
  const den: number[] = [];
  for (const { x } of items) {
    num.push(x.base * x.z * (x.y - x.base));
    den.push((x.base * x.z) ** 2);
  }
  const d = stableSum(den);
  const fitted = d > 0 ? stableSum(num) / d : null;
  return propose(p, items, current, fitted, sse);
}

interface WeightItem {
  readonly espn: number;
  readonly model: number;
  readonly y: number;
}

/**
 * weight_espn: MAE of w·ESPN + (1 − w)·model over the paired player-weeks; the best candidate sets
 * the direction and the proposal moves one 0.25 step toward it, only when that step beats the value
 * in effect by WEIGHT_ESPN_MIN_GAIN overall and in both halves (plan 07 E1, ADV OBJ-02).
 */
export function fitWeightEspn(
  rows: readonly PlayerWeekAttribution[],
  applied: number | null,
  shipped: number,
): FitResult {
  const p = param("weight_espn");
  const items: Item<WeightItem>[] = [];
  for (const r of rows)
    if (r.espn_mean !== null)
      items.push({
        week: r.week,
        x: { espn: r.espn_mean, model: r.model_mean, y: r.realised_points },
      });
  const current = applied ?? (legalValue(p, shipped) ? shipped : null);
  const mae = (xs: readonly Item<WeightItem>[], w: number): number =>
    mean(xs.map(({ x }) => Math.abs(x.y - (w * x.espn + (1 - w) * x.model))));
  const lossAt = (xs: readonly Item<WeightItem>[], w: number | "current"): number =>
    mae(xs, w === "current" ? (current ?? 1) : w);
  // ties go to the higher weight (closer to ESPN alone — the shipped default)
  let fitted: number | null = null;
  if (items.length > 0) {
    let bestLoss = Number.POSITIVE_INFINITY;
    for (const w of [...WEIGHT_ESPN_CANDIDATES].reverse()) {
      const l = mae(items, w);
      if (l < bestLoss - 1e-12) {
        fitted = w;
        bestLoss = l;
      }
    }
  }
  return propose(p, items, current, fitted, lossAt, WEIGHT_ESPN_MIN_GAIN);
}

// --- the proposal set ---------------------------------------------------------------------------------

/** Proposals the E13 wire carries (plan 07 E13 `parameter_changes_proposed` max 10). */
export const MAX_WIRE_PROPOSALS = 10;

/** Canonical JSON (sorted keys) for hashing. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** The set's content id: sha256 of (season, week, [parameter, current, proposed]…). */
export function proposalHash(
  season: number,
  week: Week,
  proposals: readonly ParameterChange[],
): string {
  const body = {
    season,
    week,
    proposals: proposals.map((x) => ({
      parameter: x.parameter,
      current: x.current,
      proposed: x.proposed,
    })),
  };
  return createHash("sha256").update(canonical(body), "utf8").digest("hex");
}

/** What the proposal fits read. */
export interface ProposalInput {
  readonly rows: readonly PlayerWeekAttribution[];
  /** The applied overrides (`eff tune --apply`); null = none (the model's own constants). */
  readonly tuned: TunedParameters | null;
  /** The shipped weight_espn (plan 07 E1; v1 1.0). */
  readonly weight_espn: number;
  readonly season: number;
  readonly week: Week;
  readonly created_at: IsoInstant;
}

/** Runs every fit in registry order and assembles the set (empty proposals are a valid set). */
export function proposeParameterChanges(input: ProposalInput): ParameterProposalSet {
  const applied = (name: string): number | null => tunedValue(input.tuned, name);
  const results: FitResult[] = [];
  for (const p of TUNABLE_PARAMETERS) {
    switch (p.fit) {
      case "ewm_half_life":
        results.push(fitHalfLife(input.rows, applied(p.name)));
        break;
      case "shrinkage_k":
        results.push(fitShrinkK(input.rows, (p.key ?? "") as RateName, applied(p.name)));
        break;
      case "matchup_beta":
        results.push(fitMatchupBeta(input.rows, p.key ?? "", applied(p.name)));
        break;
      default:
        results.push(fitWeightEspn(input.rows, applied(p.name), input.weight_espn));
    }
  }
  const proposals = results.flatMap((r) => (r.proposal === null ? [] : [r.proposal]));
  const weeks = input.rows.map((r) => r.week);
  const first = weeks.length === 0 ? input.week : Math.min(...weeks);
  return {
    schema: 1,
    created_at: input.created_at,
    season: input.season,
    week: input.week,
    window: { first_week: first, last_week: input.week },
    proposals,
    evaluated: results.map((r) => r.evaluation),
    hash: proposalHash(input.season, input.week, proposals),
  };
}

/** The wire form (plan 07 E13): the first MAX_WIRE_PROPOSALS as ParameterChange. */
export function wireProposals(set: ParameterProposalSet | null): ParameterChange[] {
  return (set?.proposals ?? []).slice(0, MAX_WIRE_PROPOSALS).map((x) => ({
    parameter: x.parameter,
    current: x.current,
    proposed: x.proposed,
    evidence_n: x.evidence_n,
  }));
}

/** A stored set re-validated on read (`eff tune` never trusts the store); null when malformed. */
export function validateProposalSet(v: unknown): ParameterProposalSet | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  const week = (x: unknown): x is number =>
    typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 18;
  const win = s.window as Record<string, unknown> | null | undefined;
  if (
    s.schema !== 1 ||
    !isIsoInstant(s.created_at) ||
    typeof s.season !== "number" ||
    !Number.isInteger(s.season) ||
    s.season < 2018 ||
    s.season > 2100 ||
    !week(s.week) ||
    typeof win !== "object" ||
    win === null ||
    !week(win.first_week) ||
    !week(win.last_week) ||
    typeof s.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(s.hash) ||
    !Array.isArray(s.proposals) ||
    s.proposals.length > TUNABLE_PARAMETERS.length ||
    !Array.isArray(s.evaluated) ||
    s.evaluated.length > TUNABLE_PARAMETERS.length
  )
    return null;
  const proposals: ParameterProposal[] = [];
  const seen = new Set<string>();
  for (const raw of s.proposals as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const x = raw as Record<string, unknown>;
    const p = typeof x.parameter === "string" ? tunable(x.parameter) : undefined;
    if (
      p === undefined ||
      seen.has(p.name) ||
      x.fit !== p.fit ||
      !legalValue(p, x.current) ||
      !legalValue(p, x.proposed) ||
      typeof x.evidence_n !== "number" ||
      !Number.isInteger(x.evidence_n) ||
      x.evidence_n < 0 ||
      !isMetricValue(x.loss_current) ||
      !isMetricValue(x.loss_proposed)
    )
      return null;
    seen.add(p.name);
    proposals.push({
      parameter: p.name,
      current: x.current,
      proposed: x.proposed,
      evidence_n: x.evidence_n,
      fit: p.fit,
      loss_current: x.loss_current,
      loss_proposed: x.loss_proposed,
    });
  }
  const outcomes: readonly string[] = [
    "proposed",
    "no_change",
    "n_too_small",
    "current_unknown",
    "not_held",
  ];
  const evaluated: ParameterEvaluation[] = [];
  for (const raw of s.evaluated as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const x = raw as Record<string, unknown>;
    const p = typeof x.parameter === "string" ? tunable(x.parameter) : undefined;
    if (
      p === undefined ||
      x.fit !== p.fit ||
      typeof x.evidence_n !== "number" ||
      !Number.isInteger(x.evidence_n) ||
      x.evidence_n < 0 ||
      !outcomes.includes(x.outcome as string) ||
      (x.current !== null && !legalValue(p, x.current)) ||
      (x.fitted !== null && !isMetricValue(x.fitted))
    )
      return null;
    evaluated.push({
      parameter: p.name,
      fit: p.fit,
      evidence_n: x.evidence_n,
      outcome: x.outcome as ProposalOutcome,
      current: x.current,
      fitted: x.fitted,
    });
  }
  // the id must be the content's: a set whose proposals were edited after hashing is refused
  if (proposalHash(s.season, s.week, proposals) !== s.hash) return null;
  return {
    schema: 1,
    created_at: s.created_at,
    season: s.season,
    week: s.week,
    window: { first_week: win.first_week, last_week: win.last_week },
    proposals,
    evaluated,
    hash: s.hash,
  };
}

// --- the tuned-parameters document ------------------------------------------------------------------

/** The document's file name, beside config.json in the config dir (written only by `eff tune`). */
export const TUNED_PARAMETERS_FILE_NAME = "tuned-parameters.json";
/** Largest document read. */
export const TUNED_PARAMETERS_MAX_BYTES = 256 * 1024;
/** History entries kept (oldest dropped first). */
export const TUNED_HISTORY_MAX = 100;

/** One applied change: null = the model's own constant (no override). */
export interface TunedParameterChange {
  readonly parameter: string;
  readonly before: number | null;
  readonly after: number | null;
}

/** One `eff tune --apply` (a proposal set) or `--revert` (the last entry undone). */
export interface TunedHistoryEntry {
  readonly applied_at: IsoInstant;
  readonly source: "proposal" | "revert";
  readonly proposal_hash: string | null;
  readonly changes: readonly TunedParameterChange[];
}

/** The applied overrides (the projection model reads `values`; absent = its own constant). */
export interface TunedParameters {
  readonly schema: 1;
  readonly updated_at: IsoInstant | null;
  readonly values: Readonly<Record<string, number>>;
  readonly history: readonly TunedHistoryEntry[];
}

/** A document that cannot be used (value-free message). */
export class TuneDocumentError extends Error {
  constructor(reason: string) {
    super(`${TUNED_PARAMETERS_FILE_NAME}: ${reason}`);
    this.name = "TuneDocumentError";
  }
}

/** The document before any apply. */
export function emptyTunedParameters(): TunedParameters {
  return { schema: 1, updated_at: null, values: {}, history: [] };
}

/** The override of a parameter, or null (the model's own constant). */
export function tunedValue(doc: TunedParameters | null, name: string): number | null {
  if (doc === null || !Object.hasOwn(doc.values, name)) return null;
  return doc.values[name] ?? null;
}

const DOC_KEYS = ["history", "schema", "updated_at", "values"];

function checkChange(raw: unknown): TunedParameterChange {
  if (typeof raw !== "object" || raw === null) throw new TuneDocumentError("a change is malformed");
  const x = raw as Record<string, unknown>;
  const p = typeof x.parameter === "string" ? tunable(x.parameter) : undefined;
  if (p === undefined) throw new TuneDocumentError("a change names an unknown parameter");
  for (const v of [x.before, x.after])
    if (v !== null && !legalValue(p, v))
      throw new TuneDocumentError("a change holds a value outside its bounds");
  return { parameter: p.name, before: x.before as number | null, after: x.after as number | null };
}

/** Parses and validates the document strictly (unknown keys, names or out-of-bounds values refused). */
export function parseTunedParameters(text: string): TunedParameters {
  if (typeof text !== "string" || text.length > TUNED_PARAMETERS_MAX_BYTES)
    throw new TuneDocumentError("too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TuneDocumentError("is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TuneDocumentError("is not a JSON object");
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !DOC_KEYS.includes(k)))
    throw new TuneDocumentError("holds an unknown key");
  if (o.schema !== 1) throw new TuneDocumentError("has an unsupported schema");
  if (o.updated_at !== null && !isIsoInstant(o.updated_at))
    throw new TuneDocumentError("updated_at is not an instant");
  const vals = o.values;
  if (typeof vals !== "object" || vals === null || Array.isArray(vals))
    throw new TuneDocumentError("values is not an object");
  const values: Record<string, number> = {};
  for (const [k, v] of Object.entries(vals)) {
    const p = PARAMETER_NAME_RE.test(k) ? tunable(k) : undefined;
    if (p === undefined) throw new TuneDocumentError("values names an unknown parameter");
    if (!legalValue(p, v)) throw new TuneDocumentError("a value is outside its bounds");
    values[p.name] = v;
  }
  const hist = o.history;
  if (!Array.isArray(hist) || hist.length > TUNED_HISTORY_MAX)
    throw new TuneDocumentError("history is malformed");
  const history: TunedHistoryEntry[] = [];
  for (const h of hist as unknown[]) {
    if (typeof h !== "object" || h === null) throw new TuneDocumentError("history is malformed");
    const e = h as Record<string, unknown>;
    if (
      !isIsoInstant(e.applied_at) ||
      (e.source !== "proposal" && e.source !== "revert") ||
      (e.proposal_hash !== null &&
        (typeof e.proposal_hash !== "string" || !/^[0-9a-f]{64}$/.test(e.proposal_hash))) ||
      !Array.isArray(e.changes) ||
      e.changes.length > TUNABLE_PARAMETERS.length
    )
      throw new TuneDocumentError("history is malformed");
    history.push({
      applied_at: e.applied_at,
      source: e.source,
      proposal_hash: e.proposal_hash,
      changes: (e.changes as unknown[]).map(checkChange),
    });
  }
  return { schema: 1, updated_at: o.updated_at, values, history };
}

/** The document as written: sorted value keys, two-space JSON, a trailing newline. */
export function serializeTunedParameters(doc: TunedParameters): string {
  const values = Object.fromEntries(
    Object.keys(doc.values)
      .sort()
      .map((k) => [k, doc.values[k]]),
  );
  return `${JSON.stringify(
    { schema: 1, updated_at: doc.updated_at, values, history: doc.history },
    null,
    2,
  )}\n`;
}

// --- apply / revert plans -----------------------------------------------------------------------------

/** A change the plan would write (null = the model's own constant). */
export interface TuneChange {
  readonly parameter: string;
  readonly before: number | null;
  readonly after: number | null;
  /** The value in effect before (the override, else the proposal's `current`). */
  readonly effective_before: number | null;
  readonly evidence_n: number | null;
}

/** Why a proposal is not applied (value-free, fixed vocabulary). */
export type TuneRefusalReason =
  "unknown_parameter" | "out_of_bounds" | "stale_current" | "step_too_large";

export interface TuneRefusal {
  readonly parameter: string;
  readonly reason: TuneRefusalReason;
}

/** What `eff tune` would write. */
export interface TunePlan {
  readonly kind: "apply" | "revert";
  readonly changes: readonly TuneChange[];
  readonly refused: readonly TuneRefusal[];
  /** The document after the plan (equal to the input when there is nothing to change). */
  readonly next: TunedParameters;
  readonly proposal_hash: string | null;
}

function withChanges(
  doc: TunedParameters,
  changes: readonly TuneChange[],
  entry: TunedHistoryEntry,
): TunedParameters {
  if (changes.length === 0) return doc;
  const next = new Map<string, number>(Object.entries(doc.values));
  for (const c of changes) {
    if (c.after === null) next.delete(c.parameter);
    else next.set(c.parameter, c.after);
  }
  const values: Record<string, number> = Object.fromEntries(next);
  return {
    schema: 1,
    updated_at: entry.applied_at,
    values,
    history: [...doc.history, entry].slice(-TUNED_HISTORY_MAX),
  };
}

/**
 * The plan of applying a proposal set: every proposal re-validated here (never trust the store): a
 * known parameter, the proposed value within bounds, the value in effect still the one the proposal
 * was computed from (`stale_current` otherwise — run retro again), and at most one step from it.
 */
export function planApply(
  doc: TunedParameters,
  set: ParameterProposalSet,
  nowIso: IsoInstant,
): TunePlan {
  const changes: TuneChange[] = [];
  const refused: TuneRefusal[] = [];
  for (const x of set.proposals) {
    const p = tunable(x.parameter);
    if (p === undefined) {
      refused.push({ parameter: x.parameter, reason: "unknown_parameter" });
      continue;
    }
    if (!legalValue(p, x.proposed) || !legalValue(p, x.current)) {
      refused.push({ parameter: p.name, reason: "out_of_bounds" });
      continue;
    }
    const before = tunedValue(doc, p.name);
    // already applied (a re-run over the same set): nothing to write, nothing to refuse
    if (before !== null && Math.abs(before - x.proposed) <= 1e-9) continue;
    if (before !== null && Math.abs(before - x.current) > 1e-9) {
      refused.push({ parameter: p.name, reason: "stale_current" });
      continue;
    }
    if (!withinStep(p, x.current, x.proposed)) {
      refused.push({ parameter: p.name, reason: "step_too_large" });
      continue;
    }
    if (Math.abs(x.proposed - x.current) <= 1e-12) continue;
    changes.push({
      parameter: p.name,
      before,
      after: x.proposed,
      effective_before: x.current,
      evidence_n: x.evidence_n,
    });
  }
  const entry: TunedHistoryEntry = {
    applied_at: nowIso,
    source: "proposal",
    proposal_hash: set.hash,
    changes: changes.map((c) => ({ parameter: c.parameter, before: c.before, after: c.after })),
  };
  return {
    kind: "apply",
    changes,
    refused,
    next: withChanges(doc, changes, entry),
    proposal_hash: set.hash,
  };
}

/** The plan of undoing the last history entry (a revert is itself recorded, so it can be undone). */
export function planRevert(doc: TunedParameters, nowIso: IsoInstant): TunePlan {
  const last = doc.history.at(-1);
  if (last === undefined)
    return { kind: "revert", changes: [], refused: [], next: doc, proposal_hash: null };
  const changes: TuneChange[] = [];
  const refused: TuneRefusal[] = [];
  for (const c of last.changes) {
    const now = tunedValue(doc, c.parameter);
    if (now !== c.after) {
      refused.push({ parameter: c.parameter, reason: "stale_current" });
      continue;
    }
    changes.push({
      parameter: c.parameter,
      before: now,
      after: c.before,
      effective_before: now,
      evidence_n: null,
    });
  }
  const entry: TunedHistoryEntry = {
    applied_at: nowIso,
    source: "revert",
    proposal_hash: last.proposal_hash,
    changes: changes.map((c) => ({ parameter: c.parameter, before: c.before, after: c.after })),
  };
  return {
    kind: "revert",
    changes,
    refused,
    next: withChanges(doc, changes, entry),
    proposal_hash: last.proposal_hash,
  };
}

/** A value for display: the number, or "model default" for no override. */
export function showValue(v: number | null): string {
  return v === null ? "model default" : String(v);
}

/** The human diff of a plan (one line per change / refusal; numbers and fixed words only). */
export function renderPlan(plan: TunePlan): string[] {
  const lines: string[] = [];
  for (const c of plan.changes) {
    const from =
      c.before === null && c.effective_before !== null
        ? `${String(c.effective_before)} (model default)`
        : showValue(c.before);
    const n = c.evidence_n === null ? "" : `  [evidence n=${String(c.evidence_n)}]`;
    lines.push(`  ${c.parameter}: ${from} -> ${showValue(c.after)}${n}`);
  }
  for (const r of plan.refused)
    lines.push(`  ${r.parameter}: not applied (${r.reason.replace(/_/g, " ")})`);
  return lines;
}
