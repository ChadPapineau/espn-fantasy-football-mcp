// projection.ts — E1 `espn_project_players`, `v1-ensemble` (plan 07 E1; ADV OBJ-02: weight_espn =
// 1.0 — ESPN's mean is the point estimate; the trailing nflverse line, scored through the engine
// under the league's S, contributes only the distribution shape — the `position_cv` σ (research 05
// §3.2: the QB CV moves with the pass-TD value) and the turnover left tail (Poisson INT / fumble
// draws at a shrunk trailing rate) — and the 25 % disagreement flag; research 05 §5 Projections).
// Samples are drawn in cooperative batches under the 8 s CPU deadline (plan 01 §1.1; `partial`
// with the completed count). Pure: settings, engine, clock, rng and pacer are injected. New here
// (the sibling's v1-trailing had no native projection); its sampler shape is ported.
import type { Clock, Rng } from "../clock.js";
import { GAME_DAY_WINDOW_MS } from "./types.js";
import { gamesOfWeek, kickoffMsOf, opponentOf, teamGame } from "../league/schedule.js";
import type { BareText, InjuryStatus, PlatformPlayer, ProSchedule, Week } from "../league/types.js";
import { score as engineScore } from "../scoring/engine.js";
import { positionClassOf } from "../scoring/stat_map.js";
import {
  asPositionId,
  type Canonical,
  type Dist,
  type ScoringSettings,
  type StatLine,
} from "../scoring/types.js";
import {
  DEFAULT_CV,
  LIMITS,
  MODEL_VERSION,
  P_ACTIVE_BY_STATUS,
  P_ACTIVE_SHAPE_FLOOR,
  POSITION_CV,
  PROJECTION_SOURCE,
  QB_CV,
  SIMS,
  TRAILING,
  TURNOVER_PRIOR,
  TURNOVER_SHRINK_K,
  TURNOVER_STATS,
} from "./constants.js";
import { loopPacer, runCooperative, type Pacer } from "./cooperative.js";
import { AnalyticsError, ensure } from "./errors.js";
import { type AnyStamp, collectInputs, mergeInputs } from "./inputs.js";
import {
  clamp,
  distFromSamples,
  gammaMultiplier,
  normalDraw,
  poissonDraw,
  round,
  zeroDist,
} from "./math.js";
import {
  DISAGREEMENT_FLAG_PCT,
  WEIGHT_ESPN_V1,
  type Assumption,
  type Driver,
  type InputFreshness,
  type PActiveBasis,
  type Projection,
  type ProjectionData,
  type ProjectionWeek,
} from "./types.js";

/** One trailing canonical line (nflverse through the scoring translator, plan 08 §3.2). */
export interface TrailingLine {
  readonly season: number;
  readonly week: Week;
  readonly line: StatLine;
}

/** Who to project (built by the tool from a PlatformPlayer and the crosswalk — `targetOf`). */
export interface ProjectionTarget {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  readonly name: BareText;
  /** ESPN display position (QB, RB, WR, TE, K, D/ST, TQB …). */
  readonly position: string;
  /** ESPN `defaultPositionId` — the scoring overrides key on it, never on the slot. */
  readonly position_id: number;
  /** NFL team id; null or 0 = no NFL team (no game). */
  readonly pro_team_id: number | null;
  readonly injury_status: InjuryStatus | null;
  /** ESPN's weekly projection for the first target week under this league's S (split (1,1)). */
  readonly espn_week: number | null;
  /** ESPN's rest-of-season projection (split (1,0)). */
  readonly espn_ros: number | null;
  /** ESPN weekly projections for further weeks, keyed by week, when the tool has them. */
  readonly espn_by_week?: Readonly<Record<string, number>>;
  /** Trailing lines; only `season`'s weeks before the first target week and the prior season count. */
  readonly trailing: readonly TrailingLine[];
}

/** A target from a PlatformPlayer (the provider's normalised player) plus the crosswalk's gsis id. */
export function targetOf(
  p: Pick<
    PlatformPlayer,
    | "ref"
    | "name"
    | "position"
    | "position_id"
    | "pro_team_id"
    | "injury_status"
    | "projection_week_espn"
    | "projection_ros_espn"
  >,
  gsisId: string | null,
  trailing: readonly TrailingLine[] = [],
): ProjectionTarget {
  return {
    player_id: p.ref.id,
    gsis_id: gsisId,
    name: p.name,
    position: p.position,
    position_id: p.position_id,
    pro_team_id: p.pro_team_id,
    injury_status: p.injury_status,
    espn_week: p.projection_week_espn,
    espn_ros: p.projection_ros_espn,
    trailing,
  };
}

/** One implied team total (nflverse `schedules` lines, joined to ESPN pro-team ids by the tool). */
export interface ImpliedTotal {
  readonly week: Week;
  readonly pro_team_id: number;
  readonly implied: number | null;
}

/** E1 horizons (plan 07 E1). `season` is read as the rest of the season (past weeks are actuals). */
export type ProjectionHorizonArg = "week" | "ros" | "season";

/** An E1 request (validated by the tool's zod schema; re-checked here). */
export interface ProjectionRequest {
  readonly targets: readonly ProjectionTarget[];
  readonly season: number;
  readonly horizon: ProjectionHorizonArg;
  /** The first target week (the as-of: no trailing line of it or later is read). */
  readonly week: Week;
  /** The league's last scoring period (`status.finalScoringPeriod`) — the ROS horizon's end. */
  readonly final_week: Week;
  /** Null when the league's S is not available: the engine refuses (plan 07 E1 degradation). */
  readonly settings: ScoringSettings | null;
  readonly schedule: Pick<ProSchedule, "games" | "teams">;
  readonly implied_totals?: readonly ImpliedTotal[];
  readonly clock: Clock;
  readonly rng: Rng;
  /** Defaults to the loop pacer over `clock`. */
  readonly pacer?: Pacer;
  readonly n_sims?: number;
  /** The CPU deadline (default 8 s); null disables it (determinism and invariance tests). */
  readonly deadline_ms?: number | null;
  readonly include_stat_line?: boolean;
  readonly stamps?: readonly AnyStamp[];
  readonly inputs?: readonly InputFreshness[];
}

/** What the other engines need from one projected week. */
export interface ProjectedWeek {
  readonly week: Week;
  readonly dist: Dist;
  readonly p_active: number | null;
  readonly p_active_basis: PActiveBasis;
  readonly espn: number | null;
  readonly own: number | null;
  readonly bye: boolean;
  readonly cv: number;
  readonly kickoff_ms: number | null;
  readonly opponent_pro_team_id: number | null;
  readonly implied_total: number | null;
  /** E[turnover points] if active (≤ 0) — the left tail's share of the mean. */
  readonly turnover_e: number;
}

/** One target's projection and the per-week detail. */
export interface ProjectedPlayer {
  readonly target: ProjectionTarget;
  readonly projection: Projection;
  readonly weeks: readonly ProjectedWeek[];
}

/** E1's outcome: the tool's `data`, the detail other engines consume, and envelope flags. */
export interface ProjectionOutcome {
  readonly data: ProjectionData;
  readonly players: readonly ProjectedPlayer[];
  /** The CPU deadline stopped the sampler (`completed_samples` < n): never cache (plan 07 E1). */
  readonly partial: boolean;
  /** Fixed-vocabulary envelope warnings (counts only — never third-party text). */
  readonly warnings: readonly string[];
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

/** The QB CV under the league's pass-TD value (research 05 §3.2). */
function qbCv(settings: ScoringSettings, positionId: number): number {
  const rule = settings.rules.find((r) => r.canonical === "pass_td");
  if (rule === undefined) return QB_CV.base;
  const pts = rule.overrides[String(positionId)] ?? rule.points;
  return clamp(QB_CV.base + QB_CV.perPoint * (pts - QB_CV.refPoints), QB_CV.min, QB_CV.max);
}

/** The weekly CV of a position under the league's S (format-aware for QBs). */
export function positionCv(
  position: string,
  positionId: number,
  settings: ScoringSettings,
): number {
  if (position === "QB" || position === "TQB") return qbCv(settings, positionId);
  return Object.hasOwn(POSITION_CV, position) ? (POSITION_CV[position] ?? DEFAULT_CV) : DEFAULT_CV;
}

/** P(active) and its basis from ESPN's status for the first target week (research 05 §3.5). */
export function pActiveOf(
  status: InjuryStatus | null,
  kickoffMs: number | null,
  nowMs: number,
): { readonly p: number; readonly basis: PActiveBasis } {
  const known = status !== null && Object.hasOwn(P_ACTIVE_BY_STATUS, status);
  const p = known ? (P_ACTIVE_BY_STATUS[status] ?? 1) : 1;
  const gameDay =
    kickoffMs !== null && kickoffMs - nowMs <= GAME_DAY_WINDOW_MS && kickoffMs > nowMs;
  const basis: PActiveBasis = gameDay
    ? "espn_gameday_status"
    : known && status !== "ACTIVE"
      ? "designation_base_rate"
      : "none";
  return { p, basis };
}

/** A one-stat line scored under S: the points one event is worth for this position (≤ 0 for turnovers). */
function eventPoints(settings: ScoringSettings, canonical: Canonical, positionId: number): number {
  const pid = asPositionId(positionId);
  const line: StatLine = {
    values: { [canonical]: 1 },
    present: [canonical],
    position: pid,
    position_class: positionClassOf(positionId),
    provisional: false,
    source: PROJECTION_SOURCE,
  };
  return engineScore(line, settings).points_exact;
}

interface Trailing {
  readonly own: number | null;
  readonly games: number;
  readonly lambdaInt: number;
  readonly lambdaFum: number;
  readonly expectation: Readonly<Record<Canonical, number>>;
  readonly skipped: number;
}

/** The trailing window scored through the engine (sibling research 05 §1 step 2 weights). */
function trailingOf(
  t: ProjectionTarget,
  season: number,
  week: Week,
  settings: ScoringSettings,
): Trailing {
  const usable = t.trailing
    .filter((l) => (l.season === season && l.week < week) || l.season === season - 1)
    .sort((a, b) => b.season - a.season || b.week - a.week)
    .slice(0, Math.min(TRAILING.maxGames, LIMITS.maxTrailing));
  let wSum = 0;
  let pSum = 0;
  let intSum = 0;
  let fumSum = 0;
  let skipped = 0;
  let games = 0;
  const exp = new Map<Canonical, number>();
  usable.forEach((l, i) => {
    let pts: number;
    try {
      pts = engineScore(l.line, settings).points_exact;
    } catch {
      skipped += 1;
      return;
    }
    const w =
      0.5 ** (i / TRAILING.halfLifeGames) * (l.season === season ? 1 : TRAILING.priorSeasonWeight);
    games += 1;
    wSum += w;
    pSum += w * pts;
    intSum += w * (l.line.values[TURNOVER_STATS.int] ?? 0);
    fumSum += w * (l.line.values[TURNOVER_STATS.fum] ?? 0);
    for (const [k, v] of Object.entries(l.line.values)) exp.set(k, (exp.get(k) ?? 0) + w * v);
  });
  const prior = Object.hasOwn(TURNOVER_PRIOR, t.position) ? TURNOVER_PRIOR[t.position] : undefined;
  const k = TURNOVER_SHRINK_K;
  const shrink = (sum: number, p: number): number => (sum + k * p) / (wSum + k);
  const expectation: Record<Canonical, number> = {};
  for (const [c, v] of [...exp.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
    expectation[c] = round(v / wSum, 3);
  return {
    own: wSum > 0 ? pSum / wSum : null,
    games,
    lambdaInt: prior === undefined ? 0 : shrink(intSum, prior.int),
    lambdaFum: prior === undefined ? 0 : shrink(fumSum, prior.fum),
    expectation: wSum > 0 ? expectation : {},
    skipped,
  };
}

/** The weeks a horizon covers (`season` = the rest of the season, decision recorded). */
function horizonWeeks(req: ProjectionRequest): Week[] {
  if (req.horizon === "week") return [req.week];
  const out: Week[] = [];
  for (let w = req.week; w <= req.final_week; w++) out.push(w);
  return out;
}

/** One player-week's sampling plan. */
interface Task {
  readonly player: number;
  readonly weekIndex: number;
  readonly rng: Rng;
  readonly mean: number;
  /** 0 → a point mass at zero (no samples drawn). */
  readonly pShape: number;
  readonly base: number;
  readonly cvG: number;
  readonly lambdaInt: number;
  readonly lambdaFum: number;
  readonly penInt: number;
  readonly penFum: number;
  readonly samples: Float64Array;
}

/** One sample of a task (the order of draws is fixed: active, multiplier, INTs, fumbles). */
function drawSample(t: Task): number {
  if (t.pShape <= 0) return 0;
  if (t.rng.next() >= t.pShape) return 0;
  if (t.base <= 0) {
    // a non-positive active mean (a D/ST projected below zero): additive noise around it
    return t.base + t.cvG * normalDraw(t.rng);
  }
  let x = t.base * gammaMultiplier(t.rng, t.cvG);
  if (t.lambdaInt > 0) x += t.penInt * poissonDraw(t.rng, t.lambdaInt);
  if (t.lambdaFum > 0) x += t.penFum * poissonDraw(t.rng, t.lambdaFum);
  return x;
}

/**
 * E1 v1-ensemble. Throws AnalyticsError `no_settings` without S, `invalid_request` on bounds.
 */
export async function projectPlayers(req: ProjectionRequest): Promise<ProjectionOutcome> {
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
    Number.isInteger(req.final_week) && req.final_week >= 1 && req.final_week <= LIMITS.maxWeeks,
    "final_week out of range",
    "final_week",
  );
  const weeks = horizonWeeks(req);
  ensure(weeks.length >= 1, "the horizon covers no week", "horizon");
  const nRequested = req.n_sims ?? SIMS.default;
  ensure(
    Number.isInteger(nRequested) && nRequested >= SIMS.min && nRequested <= SIMS.max,
    "n_sims out of range",
    "n_sims",
  );
  const nowMs = req.clock.nowMs();
  const taskCount = req.targets.length * weeks.length;
  const n = Math.max(SIMS.min, Math.min(nRequested, Math.floor(SIMS.maxTotalSamples / taskCount)));
  const warnings: string[] = [];
  if (n < nRequested)
    warnings.push(`n_sims shared down to ${String(n)} over ${String(taskCount)} player-weeks`);
  const teamAbbrev = new Map(req.schedule.teams.map((t) => [t.id, t.abbrev]));
  const implied = new Map<string, number | null>();
  for (const r of req.implied_totals ?? [])
    implied.set(`${String(r.week)}:${String(r.pro_team_id)}`, r.implied);

  const allWeeks: Week[] = [];
  for (let w = req.week; w <= Math.max(req.week, req.final_week); w++) allWeeks.push(w);
  const gamesByWeek = new Map(allWeeks.map((w) => [w, gamesOfWeek(req.schedule, w)]));
  const tasks: Task[] = [];
  const plans = req.targets.map((t, pi) => {
    const assumptions: Assumption[] = [];
    const cv = positionCv(t.position, t.position_id, settings);
    const tr = trailingOf(t, req.season, req.week, settings);
    if (tr.skipped > 0) warnings.push(`${String(tr.skipped)} trailing lines could not be scored`);
    const cls = positionClassOf(t.position_id);
    const penInt =
      cls === "O" ? Math.min(0, eventPoints(settings, TURNOVER_STATS.int, t.position_id)) : 0;
    const penFum =
      cls === "O" ? Math.min(0, eventPoints(settings, TURNOVER_STATS.fum, t.position_id)) : 0;
    const noTeam = t.pro_team_id === null || t.pro_team_id === 0;
    // per-week ESPN means: the weekly projection, then any further weekly values, then the ROS total
    // shared evenly over the remaining weeks (to the final week, whatever the horizon) with a game
    const gameOf = allWeeks.map((w) => {
      const wg = gamesByWeek.get(w) ?? [];
      const g = noTeam ? null : teamGame(wg, t.pro_team_id);
      return { w, g, scheduled: wg.length > 0 };
    });
    const playing = gameOf.map((x) => !noTeam && (x.g !== null || !x.scheduled));
    const explicit = allWeeks.map((w, i) => {
      if (i === 0 && t.espn_week !== null) return t.espn_week;
      const v = t.espn_by_week?.[String(w)];
      return v !== undefined && Number.isFinite(v) ? v : null;
    });
    const shareWeeks = allWeeks.filter(
      (_, i) => playing[i] === true && explicit[i] === null,
    ).length;
    const explicitSum = explicit.reduce<number>((acc, v) => acc + (v ?? 0), 0);
    const perWeekRos =
      t.espn_ros !== null && shareWeeks > 0
        ? Math.max(0, t.espn_ros - explicitSum) / shareWeeks
        : null;
    const espnMissing = explicit.every((v) => v === null) && t.espn_ros === null;
    if (espnMissing)
      assumptions.push(
        A(
          tr.own === null
            ? "no ESPN projection and no trailing line: projected at 0"
            : "no ESPN projection: the trailing line scored under this league's scoring is the point estimate",
          "ESPN publishes a projection for the player",
        ),
      );
    if (tr.games === 0)
      assumptions.push(
        A(
          "no trailing nflverse line: the spread is the positional CV alone",
          "the player plays a game",
        ),
      );
    if (noTeam)
      assumptions.push(A("the player has no NFL team: no game, 0 points", "an NFL team signs him"));
    const weeksOut: {
      w: Week;
      espn: number | null;
      mean: number;
      task: Task | null;
      info: Omit<ProjectedWeek, "dist">;
    }[] = [];
    gameOf.slice(0, weeks.length).forEach(({ w, g }, wi) => {
      const kickoff = g === null ? null : kickoffMsOf(g);
      const oppId = g === null || noTeam ? null : opponentOf(g, t.pro_team_id);
      const impl = noTeam ? null : (implied.get(`${String(w)}:${String(t.pro_team_id)}`) ?? null);
      const isPlaying = playing[wi] === true;
      const espn = !isPlaying ? null : (explicit[wi] ?? perWeekRos);
      const avail =
        wi === 0 ? pActiveOf(t.injury_status, kickoff, nowMs) : { p: 1, basis: "none" as const };
      const mean = !isPlaying ? 0 : (espn ?? (espnMissing ? (tr.own ?? 0) : 0));
      const ruledOut = isPlaying && wi === 0 && avail.p === 0;
      if (ruledOut && mean !== 0)
        assumptions.push(
          A(
            `ESPN's status rules him out for week ${String(w)}: the estimate is 0, not ESPN's ${String(round(mean, 1))}`,
            "his status changes before kickoff",
          ),
        );
      const finalMean = ruledOut ? 0 : mean;
      const pShape =
        !isPlaying || ruledOut || finalMean === 0
          ? 0
          : avail.p >= P_ACTIVE_SHAPE_FLOOR
            ? avail.p
            : P_ACTIVE_SHAPE_FLOOR;
      if (isPlaying && wi === 0 && avail.p > 0 && avail.p < P_ACTIVE_SHAPE_FLOOR && finalMean !== 0)
        assumptions.push(
          A(
            `P(active) ${String(avail.p)} is below ${String(P_ACTIVE_SHAPE_FLOOR)}: the spread's zero mass is held at ${String(1 - P_ACTIVE_SHAPE_FLOOR)} so ESPN's mean stays the estimate`,
            "his designation changes",
          ),
        );
      const mA = pShape > 0 ? finalMean / pShape : 0;
      const eTo = tr.lambdaInt * penInt + tr.lambdaFum * penFum;
      const vTo = tr.lambdaInt * penInt * penInt + tr.lambdaFum * penFum * penFum;
      let base = mA;
      let cvG = cv;
      let li = 0;
      let lf = 0;
      if (mA > 0 && mA - eTo > 0 && (penInt < 0 || penFum < 0)) {
        base = mA - eTo;
        cvG = Math.sqrt(Math.max(0, (cv * mA) ** 2 - vTo)) / base;
        li = tr.lambdaInt;
        lf = tr.lambdaFum;
      } else if (mA <= 0 && pShape > 0) {
        cvG = cv * Math.max(Math.abs(mA), 1);
      }
      const task: Task | null =
        pShape > 0
          ? {
              player: pi,
              weekIndex: wi,
              rng: req.rng.fork(`e1:${String(t.player_id ?? t.gsis_id ?? pi)}:${String(w)}`),
              mean: finalMean,
              pShape,
              base,
              cvG,
              lambdaInt: li,
              lambdaFum: lf,
              penInt,
              penFum,
              samples: new Float64Array(n),
            }
          : null;
      if (task !== null) tasks.push(task);
      weeksOut.push({
        w,
        espn,
        mean: finalMean,
        task,
        info: {
          week: w,
          p_active: !isPlaying ? null : wi === 0 ? avail.p : null,
          p_active_basis: !isPlaying ? "none" : avail.basis,
          espn,
          own: tr.own,
          bye: !noTeam && !isPlaying,
          cv,
          kickoff_ms: kickoff,
          opponent_pro_team_id: oppId,
          implied_total: impl,
          turnover_e: li > 0 || lf > 0 ? eTo : 0,
        },
      });
    });
    return { t, tr, assumptions, weeksOut, espnMissing };
  });

  // the sampler: sample-index-major, so a deadline-stopped run leaves every player-week with the
  // same number of samples; each task draws from its own forked stream (batching never shifts it)
  const pacer = req.pacer ?? loopPacer(req.clock);
  const run = await runCooperative(
    n,
    (s) => {
      for (const task of tasks) task.samples[s] = drawSample(task);
    },
    { pacer, deadlineMs: req.deadline_ms },
  );
  const k = run.completed;
  if (run.partial)
    warnings.push(`partial: ${String(k)} of ${String(n)} samples before the CPU deadline`);

  // post-processing (quantile sorts, ROS sums) is cooperative too: one player per step
  type Plan = (typeof plans)[number];
  const build = ({ t, tr, assumptions, weeksOut, espnMissing }: Plan): ProjectedPlayer => {
    const weeksP: ProjectedWeek[] = weeksOut.map((x) => ({
      ...x.info,
      dist:
        x.task === null || k === 0
          ? x.mean === 0
            ? zeroDist("position_cv")
            : { ...zeroDist("position_cv"), mean: round(x.mean), p_zero: 0 }
          : distFromSamples(x.task.samples.subarray(0, k), "position_cv", x.mean),
    }));
    const pw: ProjectionWeek[] = weeksP.map((w) => {
      const pct =
        w.espn !== null && w.own !== null && w.espn > 0 ? Math.abs(w.espn - w.own) / w.espn : null;
      return {
        week: w.week,
        points: w.dist,
        p_active: w.p_active,
        opponent:
          w.opponent_pro_team_id === null ? null : (teamAbbrev.get(w.opponent_pro_team_id) ?? null),
        implied_total: w.implied_total,
        inputs: {
          espn: w.espn === null ? null : round(w.espn),
          own: w.own === null ? null : round(w.own),
          weight_espn: espnMissing ? 0 : WEIGHT_ESPN_V1,
        },
        disagreement: {
          pct: pct === null ? null : round(pct, 3),
          flagged: pct !== null && pct > DISAGREEMENT_FLAG_PCT,
        },
      };
    });
    let ros: Dist | null = null;
    if (weeksP.length > 1) {
      const sums = new Float64Array(k);
      let meanSum = 0;
      for (const x of weeksOut) {
        meanSum += x.mean;
        if (x.task !== null)
          for (let s = 0; s < k; s++) sums[s] = (sums[s] ?? 0) + (x.task.samples[s] ?? 0);
      }
      ros =
        k === 0
          ? { ...zeroDist("position_cv"), mean: round(meanSum), p_zero: meanSum === 0 ? 1 : 0 }
          : distFromSamples(sums, "position_cv", meanSum);
    }
    const first = weeksP[0];
    const drivers: Driver[] = [];
    if (first !== undefined) {
      if (first.espn !== null)
        drivers.push({ name: "espn_projection", contribution: round(first.espn, 2) });
      if (first.turnover_e !== 0)
        drivers.push({
          name: "turnover_tail",
          contribution: round(first.turnover_e * (first.p_active ?? 1), 2),
        });
      if (first.own !== null && first.espn !== null)
        drivers.push({
          name: "trailing_minus_espn",
          contribution: round(first.own - first.espn, 2),
        });
    }
    const projection: Projection = {
      player_id: t.player_id,
      gsis_id: t.gsis_id,
      name: t.name,
      position: t.position,
      weeks: pw,
      ros_total: ros,
      ...(req.include_stat_line === true ? { stat_line_expectation: tr.expectation } : {}),
      drivers,
      role_confidence_games: tr.games,
      assumptions,
    };
    return { target: t, projection, weeks: weeksP };
  };
  const players: ProjectedPlayer[] = [];
  await runCooperative(
    plans.length,
    (i) => {
      const plan = plans[i];
      if (plan !== undefined) players.push(build(plan));
    },
    { pacer, deadlineMs: null },
  );

  const inputs = mergeInputs(collectInputs(req.stamps ?? [], req.clock), req.inputs ?? []);
  return {
    data: {
      model_version: MODEL_VERSION,
      projections: players.map((p) => p.projection),
      completed_samples: k,
      inputs,
    },
    players,
    partial: run.partial,
    warnings: [...new Set(warnings)],
  };
}
