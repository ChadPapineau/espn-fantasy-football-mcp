// project.ts — E1 `v2-opportunity` (plan 07 E1: `model_version: "v2-opportunity"`, `basis:
// "player_sim"`, `meta.estimate: true`; plan 10 §3.3; sibling research 05 §1): for each target, the
// expectation (expectation.ts), P(active) (availability.ts), `n` simulated lines (simulate.ts) scored
// by the engine's scoreSamples into the model's own player_sim Dist, then the ensemble — ESPN's mean
// × weight_espn + the own mean × (1 − weight_espn), weight_espn = WEIGHT_ESPN_V2 (1.0: ESPN's mean is
// the point estimate, ADV OBJ-02) — whose distribution is the opportunity simulation re-run at that
// mean (ensemble.ts: the volume carries the difference) and pinned to it; the 25 % flag compares the
// two means. One target week per call (the decision week — E1's player_sim precedent); the rest of a
// horizon is E1's to compose. Three cooperative phases — set-up one target per step, sampling
// sample-major (a deadline-stopped run leaves every player with the same count), scoring one target
// per step — each yielding every ≤ 12 ms (plan 01 §1.1; the 50 ms stall bound) under the 8 s CPU
// deadline (`partial` with the completed count, never cached — plan 07 E1, ADV OBJ-07). Samples are
// held as numbers until scored (SAMPLE_WIDTH per sample), so a 60-player call stays small. Pure:
// clock, rng, pacer injected. New here.
import type { Rng } from "../../clock.js";
import type { Dist, ScoringSettings, StatLine } from "../../scoring/types.js";
import { score } from "../../scoring/engine.js";
import { LIMITS, SIMS } from "../constants.js";
import { loopPacer, runCooperative } from "../cooperative.js";
import { AnalyticsError, ensure } from "../errors.js";
import { collectInputs, mergeInputs } from "../inputs.js";
import { gammaDist, round, zeroDist } from "../math.js";
import { positionCv } from "../projection.js";
import type { Assumption, Driver, Projection, ProjectionWeek } from "../types.js";
import { pActiveV2 } from "./availability.js";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
  MODEL_VERSION_V2,
  V2_DISAGREEMENT_PCT,
  V2_SIMS,
  WEIGHT_ESPN_V2,
} from "./constants.js";
import { activePoints, anchorExpectation } from "./ensemble.js";
import { expectV2, type ExpectationResult } from "./expectation.js";
import { espnRatingOf } from "./matchup.js";
import {
  expectedCounts,
  expectedLine,
  linesOf,
  SAMPLE_WIDTH,
  simDist,
  simulateInto,
} from "./simulate.js";
import type { TeamVolume } from "./team.js";
import { traceV2, type V2Trace } from "./trace.js";
import { turnoverTail } from "./turnover.js";
import type {
  V2ActiveEstimate,
  V2Expectation,
  V2Outcome,
  V2PlayerDetail,
  V2Request,
  V2Target,
} from "./types.js";
import { indexTeamGames } from "./window.js";

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });
const fin = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);

/** Samples per player-week for a request: n_sims shared down by the call's line budget. */
export function v2SampleCount(requested: number | undefined, simulations: number): number {
  const want = Math.round(requested ?? V2_SIMS.default);
  const capped = Math.min(V2_SIMS.max, Math.max(V2_SIMS.min, want));
  const budget = Math.floor(V2_SIMS.maxTotalLines / Math.max(1, simulations));
  return Math.max(V2_SIMS.min, Math.min(capped, budget));
}

/** The ensemble mean and the weight actually used (0 without an ESPN mean). */
export function ensembleMean(
  espn: number | null,
  own: number,
  weight: number,
): { readonly mean: number; readonly weight: number } {
  if (!fin(espn)) return { mean: own, weight: 0 };
  const w = Math.min(1, Math.max(0, weight));
  return { mean: w * espn + (1 - w) * own, weight: w };
}

/** A Dist's quantiles scaled by a positive factor (exact) with the mean set to `mean`. */
export function pinDist(d: Dist, mean: number): Dist {
  if (!(d.mean > 0) || !(mean > 0)) return d;
  const f = mean / d.mean;
  const s = (x: number): number => round(x * f);
  return {
    mean: round(mean),
    p10: s(d.p10),
    p25: s(d.p25),
    p50: s(d.p50),
    p75: s(d.p75),
    p90: s(d.p90),
    p_zero: d.p_zero,
    basis: d.basis,
  };
}

/** One target's plan (built in the set-up phase). */
interface Plan {
  readonly target: V2Target;
  readonly result: ExpectationResult | null;
  /** The tuning trace (plan 10 C9), when modelled. */
  readonly trace: V2Trace | null;
  readonly skipped: string | null;
  readonly active: V2ActiveEstimate;
  readonly rng: Rng;
  /** The own simulation's counts (SAMPLE_WIDTH per sample). */
  readonly buf: Float64Array;
  /** The ensemble's anchored expectation and its simulation, when it differs from the own. */
  readonly anchored: V2Expectation | null;
  readonly abuf: Float64Array;
  readonly arng: Rng;
  /** The ensemble's weight and whether anchoring was impossible (gamma fallback). */
  readonly weight: number;
  readonly anchor_failed: boolean;
  readonly assumptions: Assumption[];
}

/**
 * v2-opportunity for one target week. Throws AnalyticsError `no_settings` without S and
 * `invalid_request` on bounds. Targets v2 does not model (K, D/ST, no team, no game history) are not
 * in `data.projections`; their `details[]` row names why (E1 keeps v1 for them).
 */
export async function projectV2(req: V2Request): Promise<V2Outcome> {
  if (req.settings === null)
    throw new AnalyticsError("no_settings", "the league's scoring settings are not available");
  const settings = req.settings;
  ensure(
    req.targets.length >= 1 && req.targets.length <= LIMITS.maxTargets,
    "targets out of range",
    "players",
  );
  ensure(
    Number.isInteger(req.week) && req.week >= 1 && req.week <= LIMITS.maxWeeks,
    "week out of range",
    "week",
  );
  ensure(
    Number.isInteger(req.season) && req.season >= 1990 && req.season <= 2100,
    "season out of range",
    "season",
  );
  const requested = req.n_sims ?? V2_SIMS.default;
  ensure(
    Number.isInteger(requested) && requested >= V2_SIMS.min && requested <= SIMS.max,
    "n_sims out of range",
    "n_sims",
  );
  const weight = req.weight_espn ?? WEIGHT_ESPN_V2;
  ensure(fin(weight) && weight >= 0 && weight <= 1, "weight_espn out of range", "weight_espn");
  const params = req.params ?? DEFAULT_V2_PARAMS;
  const priors = req.priors ?? DEFAULT_V2_PRIORS;
  const anchoring = weight > 0 && req.targets.some((t) => fin(t.espn_mean));
  const n = v2SampleCount(requested, req.targets.length * (anchoring ? 2 : 1));
  const warnings: string[] = [];
  if (n < requested)
    warnings.push(`n_sims shared down to ${String(n)} over ${String(req.targets.length)} players`);
  const pacer = req.pacer ?? loopPacer(req.clock);
  const teamIndex = indexTeamGames(req.team_games);
  const memo = new Map<string, TeamVolume>();

  // phase 1 — set-up, one target per step
  const plans: Plan[] = [];
  await runCooperative(
    req.targets.length,
    (i) => {
      const t = req.targets[i];
      if (t !== undefined) plans.push(planOf(t, i));
    },
    { pacer, deadlineMs: null },
  );

  function planOf(t: V2Target, i: number): Plan {
    const assumptions: Assumption[] = [];
    const team = t.team;
    const out = expectV2(
      { position: t.position, position_id: t.position_id, team, games: t.games },
      {
        season: req.season,
        week: req.week,
        team_index: teamIndex,
        team_games: req.team_games,
        market: team === null ? null : (req.markets?.[team] ?? null),
        weather: team === null ? null : (req.weather?.[team] ?? null),
        opponent: team === null ? null : (req.opponents?.[team] ?? null),
        matchup: req.matchup ?? null,
        priors,
        params,
        volume_memo: memo,
      },
    );
    const active = pActiveV2(t.availability);
    const result = typeof out === "string" ? null : out;
    if (result?.market_missing === true)
      assumptions.push(
        A(
          "no market line for the game: team volume and touchdown rates use the trailing environment",
          "the game's spread and total are published",
        ),
      );
    if (result !== null && result.expectation.role_games < 3)
      assumptions.push(
        A(
          `the role is ${String(result.expectation.role_games)} game(s) old: the role draw is widened`,
          "the role holds another game",
        ),
      );
    if (active.p === 0)
      assumptions.push(
        A("the designation rules him out: the estimate is 0", "his status changes before kickoff"),
      );
    // the ensemble's anchor (ensemble.ts): the volume carries the difference to ESPN's mean
    const espn = fin(t.espn_mean) ? t.espn_mean : null;
    let anchored: V2Expectation | null = null;
    let anchorFailed = false;
    let w = 0;
    // the weight on ESPN's mean is reported whenever ESPN has one (E1's label, as v1 reports it —
    // a ruled-out player included); the anchored simulation runs only for a player who may play
    if (result !== null && espn !== null) {
      w = weight;
      if (w > 0 && active.p > 0) {
        const ownDet = activePoints(result.expectation, settings) * active.p;
        const a = anchorExpectation(
          result.expectation,
          active.p,
          ensembleMean(espn, ownDet, w).mean,
          settings,
          params.sim.anchor_role_scale,
        );
        if (a.expectation === null) anchorFailed = espn > 0;
        else if (a.expectation !== result.expectation) anchored = a.expectation;
      }
    }
    const key = `${String(t.player_id ?? t.gsis_id ?? i)}:${String(req.week)}`;
    return {
      target: t,
      result,
      trace:
        result === null ? null : traceV2(result, t.games, req.season, req.week, teamIndex, params),
      skipped: typeof out === "string" ? out : null,
      active,
      rng: req.rng.fork(`v2:${key}`),
      buf: new Float64Array(result === null ? 0 : n * SAMPLE_WIDTH),
      anchored,
      abuf: new Float64Array(anchored === null ? 0 : n * SAMPLE_WIDTH),
      arng: req.rng.fork(`v2_anchor:${key}`),
      weight: w,
      anchor_failed: anchorFailed,
      assumptions,
    };
  }

  // phase 2 — sampling, sample-major across the modelled targets
  const live = plans.filter((p) => p.result !== null);
  const run = await runCooperative(
    live.length === 0 ? 0 : n,
    (s) => {
      for (const p of live) {
        if (p.result === null) continue;
        simulateInto(p.result.expectation, p.active.p, params, p.rng, p.buf, s * SAMPLE_WIDTH);
        if (p.anchored !== null)
          simulateInto(p.anchored, p.active.p, params, p.arng, p.abuf, s * SAMPLE_WIDTH);
      }
    },
    { pacer, deadlineMs: req.deadline_ms },
  );
  const k = live.length === 0 ? n : run.completed;
  if (run.partial)
    warnings.push(`partial: ${String(k)} of ${String(n)} samples before the CPU deadline`);

  // phase 3 — scoring and assembly, one target per step
  const projections: Projection[] = [];
  const details: V2PlayerDetail[] = [];
  await runCooperative(
    plans.length,
    (i) => {
      const p = plans[i];
      if (p === undefined) return;
      const built = assemble(p, settings, k, req);
      if (built.projection !== null) projections.push(built.projection);
      details.push(built.detail);
    },
    { pacer, deadlineMs: null },
  );
  const skipped = details.filter((d) => d.skipped !== null).length;
  if (skipped > 0) warnings.push(`${String(skipped)} players not modelled by v2`);
  const inputs = mergeInputs(collectInputs(req.stamps ?? [], req.clock), req.inputs ?? []);
  return {
    data: { model_version: MODEL_VERSION_V2, projections, completed_samples: k, inputs },
    details,
    partial: run.partial,
    warnings: [...new Set(warnings)],
  };
}

/** Points of a canonical line under S (0 when the engine refuses it — never thrown here). */
function pointsOf(line: StatLine, settings: ScoringSettings): number {
  try {
    return score(line, settings).points_exact;
  } catch {
    return 0;
  }
}

/** The drivers of one expectation (signed points, sib §0's ranked contributions). */
function driversOf(
  e: V2Expectation,
  pActive: number,
  settings: ScoringSettings,
  espn: number | null,
  own: number,
  turnoverE: number,
): Driver[] {
  const base = pointsOf(expectedLine(e), settings);
  const tdFree = pointsOf(
    expectedLine({ ...e, td_per_att: 0, td_per_target: 0, td_per_carry: 0 }),
    settings,
  );
  const mm = e.market_mult;
  const noMarket = pointsOf(
    expectedLine({
      ...e,
      td_per_att: e.td_per_att / mm,
      td_per_target: e.td_per_target / mm,
      td_per_carry: e.td_per_carry / mm,
    }),
    settings,
  );
  const m = e.matchup_mult;
  const noMatchup = pointsOf(
    expectedLine({
      ...e,
      yards_per_cmp: e.yards_per_cmp / m,
      yards_per_rec: e.yards_per_rec / m,
      yards_per_carry: e.yards_per_carry / m,
      td_per_att: e.td_per_att / m,
      td_per_target: e.td_per_target / m,
      td_per_carry: e.td_per_carry / m,
    }),
    settings,
  );
  const out: Driver[] = [];
  const add = (name: string, c: number): void => {
    if (Number.isFinite(c) && Math.abs(c) >= 0.005) out.push({ name, contribution: round(c, 2) });
  };
  if (espn !== null) add("espn_projection", espn);
  add("opportunity_and_yardage", tdFree * pActive);
  add("touchdowns_location", (base - tdFree) * pActive);
  add("market_implied_total", (base - noMarket) * pActive);
  add("matchup_regressed", (base - noMatchup) * pActive);
  add("availability", -(1 - pActive) * base);
  add("turnover_tail", turnoverE * pActive);
  if (espn !== null) add("own_minus_espn", own - espn);
  return out.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

/** Builds one target's Projection (null when skipped) and detail. */
function assemble(
  p: Plan,
  settings: ScoringSettings,
  k: number,
  req: V2Request,
): { projection: Projection | null; detail: V2PlayerDetail } {
  const t = p.target;
  const espn = fin(t.espn_mean) ? t.espn_mean : null;
  if (p.result === null) {
    return {
      projection: null,
      detail: {
        player_id: t.player_id,
        gsis_id: t.gsis_id,
        own: null,
        dist: null,
        weight_espn: 0,
        p_active: p.active.p,
        p_active_basis: p.active.basis,
        expectation: null,
        opportunity: null,
        matchup: null,
        turnover: null,
        skipped: p.skipped,
      },
    };
  }
  const r = p.result;
  const e = r.expectation;
  const ruledOut = p.active.p === 0;
  const own: Dist =
    ruledOut || k === 0
      ? zeroDist("player_sim")
      : simDist(linesOf(p.buf, 0, k, e.position_id), settings);
  const ens = ensembleMean(espn, own.mean, p.weight);
  let served: Dist;
  const assumptions = [...p.assumptions];
  if (ruledOut || ens.mean <= 0) served = zeroDist("player_sim");
  else if (p.anchor_failed) {
    served = gammaDist(ens.mean, positionCv(t.position, t.position_id, settings), "position_cv");
    assumptions.push(
      A(
        "the opportunity simulation could not carry the ensemble mean: the positional CV spreads it",
        "the opportunity inputs and ESPN's projection agree more closely",
      ),
    );
  } else if (p.anchored !== null && k > 0)
    served = pinDist(simDist(linesOf(p.abuf, 0, k, e.position_id), settings), ens.mean);
  else served = pinDist(own, ens.mean);
  if (espn === null)
    assumptions.push(
      A(
        "no ESPN projection: the opportunity model's own mean is the estimate",
        "ESPN publishes a projection",
      ),
    );
  const touches = expectedCounts(e);
  const tail = turnoverTail(
    settings,
    e.position_id,
    { pass_att: e.pass_att, touches: (touches.rec ?? 0) + e.carries + (touches.sacked ?? 0) },
    { int_per_att: e.int_per_att, fumble_per_touch: e.fumble_per_touch },
  );
  const team = t.team;
  const opponent = team === null ? null : (req.opponents?.[team] ?? null);
  const implied = team === null ? null : (req.markets?.[team]?.implied ?? null);
  const pct = espn !== null && espn > 0 ? Math.abs(espn - own.mean) / espn : null;
  const week: ProjectionWeek = {
    week: req.week,
    points: served,
    p_active: p.active.p,
    opponent,
    implied_total: fin(implied) ? implied : null,
    inputs: {
      espn: espn === null ? null : round(espn),
      own: round(own.mean),
      weight_espn: ens.weight,
    },
    disagreement: {
      pct: pct === null ? null : round(pct, 3),
      flagged: pct !== null && pct > V2_DISAGREEMENT_PCT,
    },
  };
  const projection: Projection = {
    player_id: t.player_id,
    gsis_id: t.gsis_id,
    name: t.name,
    position: t.position,
    weeks: [week],
    ros_total: null,
    ...(req.include_stat_line === true ? { stat_line_expectation: expectedCounts(e) } : {}),
    drivers: driversOf(e, p.active.p, settings, espn, own.mean, tail.expected_points),
    role_confidence_games: e.role_games,
    assumptions,
  };
  return {
    projection,
    detail: {
      player_id: t.player_id,
      gsis_id: t.gsis_id,
      own,
      dist: served,
      weight_espn: ens.weight,
      p_active: p.active.p,
      p_active_basis: p.active.basis,
      expectation: e,
      opportunity: {
        pass_att: round(e.pass_att, 2),
        targets: round(e.targets, 2),
        carries: round(e.carries, 2),
        rz_share: r.rz_share,
      },
      matchup: {
        opponent,
        mult: round(e.matchup_mult, 4),
        afpa: r.matchup_cell?.afpa ?? null,
        espn_rating: espnRatingOf(req.espn_ratings, opponent, e.position),
      },
      turnover: tail,
      ...(req.include_stat_line === true ? { stat_line_expectation: expectedCounts(e) } : {}),
      ...(p.trace === null ? {} : { trace: p.trace }),
      skipped: null,
    },
  };
}
