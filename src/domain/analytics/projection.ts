// projection.ts — E1 `espn_project_players`, `v1-ensemble` (plan 07 E1; ADV OBJ-02: weight_espn =
// 1.0 — ESPN's mean is the point estimate; the trailing nflverse line, scored through the engine
// under the league's S, contributes only the distribution shape — the `position_cv` σ (research 05
// §3.2: the QB CV moves with the pass-TD value) and the turnover left tail (Poisson INT / fumble
// draws at a shrunk trailing rate) — and the 25 % disagreement flag; research 05 §5 Projections).
// Samples are drawn in cooperative batches under the 8 s CPU deadline (plan 01 §1.1; `partial`
// with the completed count). Pure: settings, engine, clock, rng and pacer are injected. New here
// (the sibling's v1-trailing had no native projection); its sampler shape is ported. P1 (plan 10
// §3.2): with `player_sim` an RB/WR/TE's first target week, when his trailing lines hold ≥ 3 games,
// takes the volume × efficiency simulation's distribution (playerSim.ts) around the same ESPN mean.
// Stage C: ESPN's rest-of-season total runs through the NFL season's last week (18), past the
// league's final scoring period, so it is shared over the player's games through that week and only
// the league's weeks are kept (espnRosLastWeek; research 04 §B.1.1). Round 2: its START moves with
// the games — a game already under way or played is out of the total (the recorded post-game state),
// ESPN's own game count (stat 210) wins when the provider carries it, and a D/ST's total spans the
// whole season (rosWindow; constants.ts ESPN_ROS).
import type { Clock, Rng } from "../clock.js";
import { GAME_DAY_WINDOW_MS } from "./types.js";
import {
  gamesOfWeek,
  kickoffMsOf,
  opponentOf,
  scheduledWeeks,
  teamGame,
} from "../league/schedule.js";
import type {
  BareText,
  InjuryStatus,
  PlatformPlayer,
  ProGame,
  ProSchedule,
  Week,
} from "../league/types.js";
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
  ESPN_ROS,
  LIMITS,
  MODEL_VERSION,
  NFL_REGULAR_SEASON,
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
import { opportunityFromLines, playerSimDist } from "./playerSim.js";
import { AnalyticsError, ensure, ensurePlayers } from "./errors.js";
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
  /**
   * ESPN's rest-of-season projection (split (1,0)): the player's games not yet played through the NFL
   * regular season's last week (18, NOT the league's final scoring period — espnRosLastWeek); a D/ST's
   * is a full-season figure (rosWindow).
   */
  readonly espn_ros: number | null;
  /**
   * ESPN's own count of the games in `espn_ros` (stat 210 of the split), when the provider carries
   * it: the total covers his last that-many games through week 18 (rosWindow). Absent/null → the
   * pro schedule's kickoffs at the clock decide.
   */
  readonly espn_ros_games?: number | null;
  /** ESPN weekly projections for further weeks, keyed by week, when the tool has them. */
  readonly espn_by_week?: Readonly<Record<string, number>>;
  /** Trailing lines; only `season`'s weeks before the first target week and the prior season count. */
  readonly trailing: readonly TrailingLine[];
}

/**
 * A target from a PlatformPlayer (the provider's normalised player) plus the crosswalk's gsis id.
 * `projection_ros_games_espn` (stat 210 of the ROS split) is carried when the provider has it.
 */
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
  > & { readonly projection_ros_games_espn?: number | null },
  gsisId: string | null,
  trailing: readonly TrailingLine[] = [],
): ProjectionTarget {
  const games = p.projection_ros_games_espn;
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
    ...(games === undefined ? {} : { espn_ros_games: games }),
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
  /**
   * The P1 `player_sim` basis (plan 10 §3.2 "E1's player_sim basis where the opportunity inputs
   * exist"; playerSim.ts): an RB/WR/TE's FIRST target week, with ≥ PLAYER_SIM.minGames trailing
   * games, gets the volume × efficiency simulation's distribution around the SAME mean (ESPN's —
   * weight_espn 1.0); later weeks and everyone else stay `position_cv`. Default false (the P0
   * `core` toolset is unchanged).
   */
  readonly player_sim?: boolean;
}

/** Samples of E1's `player_sim` simulation (one per player, the first target week). */
export const PLAYER_SIM_E1_SAMPLES = 1000;

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
  /**
   * The trailing window's expected canonical line (conditional on playing — nflverse rows are games
   * played), whether or not the caller asked for `stat_line_expectation`: what the projection store
   * keeps for the retrospective's attribution (plan 08 §5; plan 10 C9). Empty without a trailing line.
   */
  readonly expectation?: Readonly<Record<Canonical, number>>;
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

/**
 * The last week ESPN's rest-of-season total (split (1,0)) runs through: the NFL regular season's last
 * week — the pro schedule's last week with a game when it carries any, else 18 (17 before 2021) —
 * never the league's final scoring period (research 04 §B.1.1; constants.ts NFL_REGULAR_SEASON).
 * Capped at LIMITS.maxWeeks (a malformed schedule never widens a loop).
 */
export function espnRosLastWeek(schedule: Pick<ProSchedule, "games">, season: number): Week {
  const weeks = scheduledWeeks(schedule).filter((w) => Number.isInteger(w) && w >= 1);
  const last =
    weeks.length > 0
      ? (weeks[weeks.length - 1] ?? NFL_REGULAR_SEASON.lastWeek)
      : season >= NFL_REGULAR_SEASON.eighteenWeeksSince
        ? NFL_REGULAR_SEASON.lastWeek
        : NFL_REGULAR_SEASON.lastWeekBefore;
  return Math.min(LIMITS.maxWeeks, last);
}

/** One NFL week of a player's season as ESPN's rest-of-season total sees it (rosWindow's input). */
export interface RosWeek {
  readonly week: Week;
  /** He has a game: false on a bye or without an NFL team; a week the schedule lacks reads true. */
  readonly playing: boolean;
  /** His game has kicked off or is final at the clock (false: not yet, or unknown). */
  readonly started: boolean;
  /** His game's kickoff is known and still ahead of the clock. */
  readonly ahead: boolean;
}

/** How a player's ROS window was read: ESPN's own game count, a D/ST's season, or the clock. */
export type RosWindowBasis = "espn_games" | "full_season" | "remaining_games";

/** The weeks ESPN's rest-of-season total counts for one player. */
export interface RosWindow {
  readonly covered: ReadonlySet<Week>;
  readonly basis: RosWindowBasis;
}

/** A week's ROS state from his game (null: none in the week) at `nowMs` (rosWeeksOf, E1). */
function rosStateOf(
  g: ProGame | null,
  scheduled: boolean,
  noTeam: boolean,
  nowMs: number,
): Omit<RosWeek, "week"> {
  const k = g === null ? null : kickoffMsOf(g);
  const final = g?.stats_official === true;
  return {
    playing: !noTeam && (g !== null || !scheduled),
    started: final || (k !== null && k <= nowMs),
    ahead: !final && k !== null && k > nowMs,
  };
}

/**
 * A player's weeks 1..`last` from the pro schedule at `nowMs` — what rosWindow reads (exported for
 * the tools: weeklyValues's `ros_weeks`). Without an NFL team (null or 0) no week is playing.
 */
export function rosWeeksOf(
  schedule: Pick<ProSchedule, "games">,
  proTeamId: number | null,
  last: Week,
  nowMs: number,
): RosWeek[] {
  const teamId = proTeamId === null || proTeamId === 0 ? null : proTeamId;
  const out: RosWeek[] = [];
  const end = Math.min(LIMITS.maxWeeks, last);
  for (let w = 1; w <= end; w++) {
    const wg = gamesOfWeek(schedule, w);
    const g = teamId === null ? null : teamGame(wg, teamId);
    out.push({ week: w, ...rosStateOf(g, wg.length > 0, teamId === null, nowMs) });
  }
  return out;
}

/** ESPN's stat-210 game count when it is believable for this total (else null: the clock decides). */
export function rosGamesOf(games: number | null | undefined, total: number | null): number | null {
  if (games === undefined || games === null || !Number.isInteger(games)) return null;
  if (games < 0 || games > ESPN_ROS.maxGames) return null;
  // no game cannot carry points: a positive total with a 0 count is contradictory, never trusted
  if (games === 0 && total !== null && total > 0) return null;
  return games;
}

/**
 * The weeks ESPN's rest-of-season total (split (1,0)) counts for one player, from his season (weeks
 * 1..the NFL season's last week, ascending) — constants.ts ESPN_ROS:
 * - ESPN's own game count (stat 210, rosGamesOf) when the provider carries it: his LAST `games`
 *   games through the season's last week; an earlier game is out — played, or one ESPN projects him
 *   to miss (an injury: read as his next games, the only placement a count allows);
 * - else a D/ST's total spans the whole season (every playing week);
 * - else his games not yet started: from the as-of week `from` on, plus an earlier week whose
 *   kickoff is known to be ahead (asked about next week while this one is unplayed). A week with no
 *   known kickoff counts from `from` on: an unknown schedule never moves the start.
 */
export function rosWindow(
  weeks: readonly RosWeek[],
  o: {
    readonly from: Week;
    readonly games?: number | null;
    readonly full_season?: boolean;
  },
): RosWindow {
  const playing = weeks.filter((x) => x.playing);
  const g = o.games;
  if (g !== undefined && g !== null && Number.isInteger(g) && g >= 0 && g <= ESPN_ROS.maxGames)
    return {
      covered: new Set(playing.slice(Math.max(0, playing.length - g)).map((x) => x.week)),
      basis: "espn_games",
    };
  if (o.full_season === true)
    return { covered: new Set(playing.map((x) => x.week)), basis: "full_season" };
  return {
    covered: new Set(
      playing.filter((x) => (x.week >= o.from ? !x.started : x.ahead)).map((x) => x.week),
    ),
    basis: "remaining_games",
  };
}

/**
 * ESPN's per-game share of its rest-of-season total: what the total leaves after the weekly values
 * given for weeks it covers (the as-of week's projection, any further weekly projection), shared
 * evenly over its other covered weeks — never negative; null without a total or a week to share it
 * over. A weekly value for a week the total no longer counts (a played game) is never subtracted.
 */
export function rosShare(
  total: number | null,
  covered: ReadonlySet<Week>,
  explicit: ReadonlyMap<Week, number>,
): number | null {
  if (total === null || !Number.isFinite(total)) return null;
  let known = 0;
  let open = 0;
  for (const w of covered) {
    const v = explicit.get(w);
    if (v === undefined) open += 1;
    else known += v;
  }
  return open > 0 ? Math.max(0, total - known) / open : null;
}

/** ESPN's own game count leaves out this playing week's game though it is still to come. */
export function rosMissed(window: RosWindow, week: RosWeek): boolean {
  return (
    window.basis === "espn_games" && week.playing && !week.started && !window.covered.has(week.week)
  );
}

/**
 * ESPN's number for one playing week without a weekly value of its own: 0 where ESPN's own count
 * leaves out a game still to come (projected missed — rosMissed); else the share — the per-game value
 * where the total covers the week, and the neutral estimate for a game already played.
 */
export function rosWeekValue(
  window: RosWindow,
  week: RosWeek,
  share: number | null,
): number | null {
  return rosMissed(window, week) ? 0 : share;
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
 * E1 v1-ensemble. Throws AnalyticsError `no_settings` without S, `roster_empty` without a target,
 * `invalid_request` on bounds.
 */
export async function projectPlayers(req: ProjectionRequest): Promise<ProjectionOutcome> {
  if (req.settings === null)
    throw new AnalyticsError("no_settings", "the league's scoring settings are not available");
  const settings = req.settings;
  // no target: the engines that project a roster pass none only when it is empty — a league state
  // (before the draft), not an argument error (Stage C round 2); E1's own tool refuses an empty
  // selection itself (NOT_FOUND)
  ensurePlayers(req.targets.length, "players");
  ensure(req.targets.length <= LIMITS.maxTargets, "targets out of range", "players");
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

  // the season ESPN's ROS total is read against: weeks 1 through the NFL season's last week (18),
  // which runs past the league's final scoring period (17 in a 14 + 3 league) — the total is shared
  // over the games it still counts (rosWindow: ESPN's own count, a D/ST's season, else the games
  // not yet started) and only the horizon's weeks are kept, so week 18's game never leaks into weeks
  // ≤ 17 and a played game's points never leak into the weeks left (Stage C; research 04 §B.1.1)
  const shareEnd = Math.max(req.week, req.final_week, espnRosLastWeek(req.schedule, req.season));
  const seasonWeeks: Week[] = [];
  for (let w = 1; w <= shareEnd; w++) seasonWeeks.push(w);
  const gamesByWeek = new Map(seasonWeeks.map((w) => [w, gamesOfWeek(req.schedule, w)]));
  const tasks: Task[] = [];
  const planOf = (t: ProjectionTarget, pi: number) => {
    const assumptions: Assumption[] = [];
    const cv = positionCv(t.position, t.position_id, settings);
    const tr = trailingOf(t, req.season, req.week, settings);
    if (tr.skipped > 0) warnings.push(`${String(tr.skipped)} trailing lines could not be scored`);
    const cls = positionClassOf(t.position_id);
    const penInt =
      cls === "O" ? Math.min(0, eventPoints(settings, TURNOVER_STATS.int, t.position_id)) : 0;
    const penFum =
      cls === "O" ? Math.min(0, eventPoints(settings, TURNOVER_STATS.fum, t.position_id)) : 0;
    const team = t.pro_team_id === null || t.pro_team_id === 0 ? null : t.pro_team_id;
    const noTeam = team === null;
    // per-week ESPN means: the weekly projection, then any further weekly values, then the ROS total
    // shared evenly over the games it still counts through the NFL season's last week (past the
    // league's final week, whatever the horizon) — rosWindow
    const gameOf = new Map(
      seasonWeeks.map((w) => {
        const wg = gamesByWeek.get(w) ?? [];
        const g = team === null ? null : teamGame(wg, team);
        return [w, { week: w, g, ...rosStateOf(g, wg.length > 0, noTeam, nowMs) }] as const;
      }),
    );
    // the weekly values given: ESPN's projection for the first target week, then any further week's
    const explicit = new Map<Week, number>();
    if (t.espn_week !== null) explicit.set(req.week, t.espn_week);
    for (const w of seasonWeeks) {
      const v = t.espn_by_week?.[String(w)];
      if (!explicit.has(w) && v !== undefined && Number.isFinite(v)) explicit.set(w, v);
    }
    const window = rosWindow([...gameOf.values()], {
      from: req.week,
      games: rosGamesOf(t.espn_ros_games, t.espn_ros),
      full_season: ESPN_ROS.fullSeasonPositionIds.includes(t.position_id),
    });
    const perWeekRos = rosShare(t.espn_ros, window.covered, explicit);
    const espnMissing = explicit.size === 0 && t.espn_ros === null;
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
    // weeks of the horizon ESPN's own game count leaves out though his game is still to come
    const missed = weeks.filter((w) => {
      const x = gameOf.get(w);
      return x !== undefined && !explicit.has(w) && rosMissed(window, x);
    });
    if (missed.length > 0 && t.espn_ros !== null)
      assumptions.push(
        A(
          `ESPN's rest-of-season total counts ${String(window.covered.size)} of his games: week${missed.length === 1 ? "" : "s"} ${missed.map(String).join(", ")} read as missed (0)`,
          "ESPN's game count or his status changes",
        ),
      );
    const weeksOut: {
      w: Week;
      espn: number | null;
      mean: number;
      task: Task | null;
      info: Omit<ProjectedWeek, "dist">;
    }[] = [];
    weeks.forEach((w, wi) => {
      const x = gameOf.get(w);
      const g = x?.g ?? null;
      const kickoff = g === null ? null : kickoffMsOf(g);
      const oppId = g === null || team === null ? null : opponentOf(g, team);
      const impl = noTeam ? null : (implied.get(`${String(w)}:${String(t.pro_team_id)}`) ?? null);
      const isPlaying = x?.playing === true;
      const espn =
        x?.playing === true ? (explicit.get(w) ?? rosWeekValue(window, x, perWeekRos)) : null;
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
  };
  // (every horizon week lies inside the season read above: shareEnd ≥ the horizon's last week)
  // the per-player plans (trailing lines scored, weekly means, tasks) are built cooperatively too —
  // one target per step, in order, so the tasks and their streams are exactly as before — keeping a
  // 60-target call's set-up from running as one long macrotask (plan 10 A16a's 50 ms stall bound)
  const pacer = req.pacer ?? loopPacer(req.clock);
  const plans: ReturnType<typeof planOf>[] = [];
  await runCooperative(
    req.targets.length,
    (pi) => {
      const t = req.targets[pi];
      if (t !== undefined) plans.push(planOf(t, pi));
    },
    { pacer, deadlineMs: null },
  );

  // the sampler: sample-index-major, so a deadline-stopped run leaves every player-week with the
  // same number of samples; each task draws from its own forked stream (batching never shifts it)
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
    // the P1 player_sim basis (see ProjectionRequest.player_sim): E1's own trailing lines
    const opportunity =
      req.player_sim === true
        ? opportunityFromLines(
            t.position,
            t.position_id,
            t.trailing.filter(
              (l) => (l.season === req.season && l.week < req.week) || l.season === req.season - 1,
            ),
          )
        : null;
    // the first target week only (the decision week the trailing rates describe); one simulation
    // per player keeps E1 inside its CPU and stall budgets (~7 ms at 1 000 samples)
    const simOf = (x: (typeof weeksOut)[number]): Dist | null => {
      if (opportunity === null || x.task === null || k === 0 || x !== weeksOut[0]) return null;
      return (
        playerSimDist({
          opportunity,
          settings,
          espn_mean: x.mean,
          p_active: x.task.pShape,
          n_sims: Math.min(k, PLAYER_SIM_E1_SAMPLES),
          rng: req.rng.fork(`e1_sim:${String(t.player_id ?? t.gsis_id ?? "")}:${String(x.w)}`),
        })?.dist ?? null
      );
    };
    const weeksP: ProjectedWeek[] = weeksOut.map((x) => ({
      ...x.info,
      dist:
        x.task === null || k === 0
          ? x.mean === 0
            ? zeroDist("position_cv")
            : { ...zeroDist("position_cv"), mean: round(x.mean), p_zero: 0 }
          : (simOf(x) ?? distFromSamples(x.task.samples.subarray(0, k), "position_cv", x.mean)),
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
    return { target: t, projection, weeks: weeksP, expectation: tr.expectation };
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
