// backtest.ts — the projection backtest harness (plan 10 C1; sibling research 05 §1-Evaluation;
// research 05 §8.4 #2 and "what good looks like"): weekly, under the league's own S, `v2-opportunity`
// against (a) the trailing-4-game average and (b) the season-to-date average — each a mean with the
// positional-CV distribution — and, where ESPN's weekly projection exists, (c) ESPN's mean-only
// projection with the same positional CV and the ensemble at any weight_espn (plan 10 B14's shadow
// weights). Strictly causal: a case of (season, week) reads only games before it, priors pooled from
// earlier seasons, the matchup table of the season's earlier weeks; the week's own market line,
// venue weather and final injury report are pre-game facts (the weather is the game's record — a
// forecast stand-in, said in the evals). The population (`backtestCases`): players with ≥ 1 earlier
// game whose team plays that week and who either played or carried a Questionable / Doubtful
// designation (OUT and undesignated absences are excluded: no model could be scored on them
// usefully) — `relevant` adds the trailing-opportunity floor of BACKTEST_V2. Pure (data in). New here.
import { seededRng } from "../../clock.js";
import { score } from "../../scoring/engine.js";
import type { ScoringSettings } from "../../scoring/types.js";
import { gammaQuantile } from "../math.js";
import { positionCv } from "../projection.js";
import { pActiveV2 } from "./availability.js";
import { BACKTEST_V2, DEFAULT_V2_PARAMS, V2_POSITION_IDS, V2_SIMS } from "./constants.js";
import { expectV2 } from "./expectation.js";
import { buildMatchupTable, type MatchupRow } from "./matchup.js";
import { covered, crpsGamma, crpsSorted, meanOrNull, pinball, spearmanWithin } from "./metrics.js";
import { buildV2Priors } from "./rates.js";
import { lineAt, SAMPLE_WIDTH, simulateInto } from "./simulate.js";
import type { TeamVolume } from "./team.js";
import { anchorExpectation } from "./ensemble.js";
import type {
  V2Availability,
  V2Expectation,
  V2Game,
  V2MatchupTable,
  V2Params,
  V2Position,
  V2Priors,
  V2TeamGame,
  V2Weather,
} from "./types.js";
import { indexTeamGames, isBefore, teamGameKey } from "./window.js";

/** A game with its actual points under the world's S. */
export interface ScoredGame extends V2Game {
  readonly points: number;
}

/** One player's full history in a backtest world. */
export interface BacktestPlayer {
  readonly gsis_id: string;
  readonly position: V2Position;
  /** Every game of every season held, any order. */
  readonly games: readonly ScoredGame[];
}

/** One final injury-report row. */
export interface BacktestReport extends V2Availability {
  readonly team: string | null;
}

/** Everything a backtest reads (built by the caller from the store or the committed excerpt). */
export interface BacktestWorld {
  readonly players: readonly BacktestPlayer[];
  readonly team_games: readonly V2TeamGame[];
  /** Venue weather by `teamGameKey`. */
  readonly weather: ReadonlyMap<string, V2Weather>;
  /** Final injury reports by `${gsis}|${season}|${week}`. */
  readonly reports: ReadonlyMap<string, BacktestReport>;
  readonly settings: ScoringSettings;
}

/** One case to project. */
export interface BacktestCase {
  readonly gsis_id: string;
  readonly position: V2Position;
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly played: boolean;
  /** The outcome scored against (points under the world's S, or an external actual). */
  readonly actual: number;
  readonly availability: V2Availability;
  /** The trailing-opportunity floor holds (BACKTEST_V2.relevance). */
  readonly relevant: boolean;
  /** ESPN's weekly projection under the world's S, where the case came from ESPN's record. */
  readonly espn_mean: number | null;
}

/** One projected case. */
export interface BacktestRecord extends BacktestCase {
  readonly p_active: number;
  readonly v2_mean: number;
  /** The v2 samples' points, ascending. */
  readonly v2_sorted: Float64Array;
  readonly t4_mean: number;
  readonly std_mean: number;
  /** The positional CV of the baselines. */
  readonly cv: number;
  /** The expectation simulated (the ensemble re-anchors it). */
  readonly expectation: V2Expectation;
}

/** Options of a backtest run. */
export interface BacktestOptions {
  readonly params?: V2Params;
  /** Priors; default: pooled from the world's seasons before each case's season. */
  readonly priors?: V2Priors;
  /** The P(active) table (default constants.ts P_ACTIVE_V2). */
  readonly availability_table?: Readonly<Record<string, number>>;
  readonly samples?: number;
  readonly seed?: number;
}

const KEY = (g: string, s: number, w: number): string => `${g}|${String(s)}|${String(w)}`;

/** The trailing opportunity per game the relevance floor reads (QB attempts; RB touches; targets). */
function opportunity(g: V2Game, pos: V2Position): number {
  if (pos === "QB") return g.pass_att;
  if (pos === "RB") return g.rush_att + g.targets;
  return g.targets;
}

/** Games before (season, week), most recent first. */
function before(p: BacktestPlayer, season: number, week: number): ScoredGame[] {
  return p.games
    .filter((g) => isBefore(g, season, week))
    .sort((a, b) => b.season - a.season || b.week - a.week);
}

/**
 * The C1 population of one season's weeks (see the header). Cases are ordered by week, then GSIS id.
 */
export function backtestCases(
  world: BacktestWorld,
  season: number,
  firstWeek: number = BACKTEST_V2.firstWeek,
  lastWeek: number = BACKTEST_V2.lastWeek,
): BacktestCase[] {
  const teamIdx = indexTeamGames(world.team_games);
  const out: BacktestCase[] = [];
  for (let week = firstWeek; week <= lastWeek; week++) {
    for (const p of world.players) {
      const prior = before(p, season, week);
      if (prior.length === 0) continue;
      const game = p.games.find((g) => g.season === season && g.week === week);
      const report = world.reports.get(KEY(p.gsis_id, season, week));
      const des = report?.designation ?? null;
      const listed = des === "Questionable" || des === "Doubtful";
      if (game === undefined && !listed) continue;
      const team = game?.team ?? report?.team ?? null;
      if (team === null || !teamIdx.has(teamGameKey(team, season, week))) continue;
      const recent = prior.slice(0, BACKTEST_V2.trailingGames);
      const opp = recent.reduce((s, g) => s + opportunity(g, p.position), 0) / recent.length;
      out.push({
        gsis_id: p.gsis_id,
        position: p.position,
        season,
        week,
        team,
        played: game !== undefined,
        actual: game?.points ?? 0,
        availability: {
          designation: des,
          practice: report?.practice ?? null,
        },
        relevant: opp >= BACKTEST_V2.relevance[p.position],
        espn_mean: null,
      });
    }
  }
  return out.sort((a, b) => a.week - b.week || a.gsis_id.localeCompare(b.gsis_id));
}

/** One externally scored player-week (ESPN's projection and ESPN's actual). */
export interface ExternalRow {
  readonly gsis_id: string | null;
  readonly season: number;
  readonly week: number;
  readonly espn_mean: number;
  readonly actual: number;
}

/** Why an external row could not become a case (counted, never silent). */
export interface ExternalDrops {
  readonly no_gsis: number;
  readonly no_history: number;
  readonly no_team_game: number;
}

/**
 * Cases from external rows (C1's ESPN comparison): every row whose player has ≥ 1 earlier game and
 * whose team plays that week — the team from the week's own game, else the injury report, else his
 * latest game. The outcome is the row's actual (ESPN's appliedTotal under the league's S). With
 * `game_day`, availability is ESPN's game-day status read from its recorded projection (0 exactly for
 * the players who were inactive — the information ESPN's own number carries); without it, the week's
 * final injury report.
 */
export function externalCases(
  world: BacktestWorld,
  rows: readonly ExternalRow[],
  opts: { readonly game_day?: boolean } = {},
): { readonly cases: BacktestCase[]; readonly drops: ExternalDrops } {
  const teamIdx = indexTeamGames(world.team_games);
  const byId = new Map(world.players.map((p) => [p.gsis_id, p]));
  const cases: BacktestCase[] = [];
  let noGsis = 0;
  let noHistory = 0;
  let noTeam = 0;
  for (const r of rows) {
    const p = r.gsis_id === null ? undefined : byId.get(r.gsis_id);
    if (p === undefined) {
      noGsis += 1;
      continue;
    }
    const prior = before(p, r.season, r.week);
    if (prior.length === 0) {
      noHistory += 1;
      continue;
    }
    const game = p.games.find((g) => g.season === r.season && g.week === r.week);
    const report = world.reports.get(KEY(p.gsis_id, r.season, r.week));
    const team = game?.team ?? report?.team ?? prior[0]?.team ?? null;
    if (team === null || !teamIdx.has(teamGameKey(team, r.season, r.week))) {
      noTeam += 1;
      continue;
    }
    const recent = prior.slice(0, BACKTEST_V2.trailingGames);
    const opp = recent.reduce((s, g) => s + opportunity(g, p.position), 0) / recent.length;
    cases.push({
      gsis_id: p.gsis_id,
      position: p.position,
      season: r.season,
      week: r.week,
      team,
      played: game !== undefined,
      actual: r.actual,
      // at game time ESPN's status alone decides (plan 07 D2): its recorded projection is 0 exactly
      // for the players who were inactive, so `game_day` reads it as that status
      availability:
        opts.game_day === true
          ? { designation: r.espn_mean > 0 ? "ACTIVE" : "OUT", practice: null, game_day: true }
          : { designation: report?.designation ?? null, practice: report?.practice ?? null },
      relevant: opp >= BACKTEST_V2.relevance[p.position],
      espn_mean: r.espn_mean,
    });
  }
  return { cases, drops: { no_gsis: noGsis, no_history: noHistory, no_team_game: noTeam } };
}

/**
 * The ensemble forecast of a record at `mean` (ensemble.ts: the simulation re-run with the volume
 * scaled to carry the mean, then pinned to it); the positional-CV gamma when it cannot anchor.
 */
export function anchoredForecast(
  world: BacktestWorld,
  r: BacktestRecord,
  mean: number,
  label: string,
  opts: BacktestOptions = {},
): Forecast {
  if (!(mean > 0) || r.p_active <= 0) return gammaForecast(Math.max(0, mean), r.cv, r.actual);
  const params = opts.params ?? DEFAULT_V2_PARAMS;
  const a = anchorExpectation(
    r.expectation,
    r.p_active,
    mean,
    world.settings,
    params.sim.anchor_role_scale,
  );
  if (a.expectation === null) return gammaForecast(mean, r.cv, r.actual);
  const n = Math.max(2, Math.round(opts.samples ?? BACKTEST_V2.samples));
  const rng = seededRng(opts.seed ?? 20_261_010).fork(
    `anchor:${label}:${r.gsis_id}:${String(r.season)}:${String(r.week)}`,
  );
  const buf = new Float64Array(SAMPLE_WIDTH);
  const pid = V2_POSITION_IDS[r.position];
  const pts = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    simulateInto(a.expectation, r.p_active, params, rng, buf, 0);
    pts[i] = score(lineAt(buf, 0, pid), world.settings).points;
    sum += pts[i] ?? 0;
  }
  const simMean = sum / n;
  if (!(simMean > 0)) return gammaForecast(mean, r.cv, r.actual);
  const f = mean / simMean;
  const sorted = pts.map((x) => x * f).sort();
  return {
    mean,
    crps: crpsSorted(sorted, r.actual),
    p10: q7(sorted, 0.1),
    p50: q7(sorted, 0.5),
    p90: q7(sorted, 0.9),
  };
}

/**
 * The ESPN comparison's models: ESPN's mean-only projection with the positional CV, v2's own, and
 * the ensemble at each weight (anchored — the served method); `ensemble_rescale_<w>` is the plain
 * point rescale of v2's own samples, a sensitivity row.
 */
export function espnModels(
  world: BacktestWorld,
  weights: readonly number[],
  opts: BacktestOptions = {},
): Readonly<Record<string, (r: BacktestRecord) => Forecast>> {
  const out: Record<string, (r: BacktestRecord) => Forecast> = {
    espn_position_cv: (r) => gammaForecast(r.espn_mean ?? 0, r.cv, r.actual),
    v2_own: (r) => v2Forecast(r),
  };
  for (const w of weights) {
    const target = (r: BacktestRecord): number =>
      w * (r.espn_mean ?? r.v2_mean) + (1 - w) * r.v2_mean;
    out[`ensemble_${w.toFixed(2)}`] = (r) =>
      w === 0 ? v2Forecast(r) : anchoredForecast(world, r, target(r), w.toFixed(2), opts);
    out[`ensemble_rescale_${w.toFixed(2)}`] = (r) => v2Forecast(r, target(r));
  }
  return out;
}

/** The matchup rows of a world (every player-game with its points). */
export function matchupRows(world: BacktestWorld): MatchupRow[] {
  const rows: MatchupRow[] = [];
  for (const p of world.players)
    for (const g of p.games)
      rows.push({
        season: g.season,
        week: g.week,
        team: g.team,
        opponent: g.opponent,
        position: p.position,
        points: g.points,
      });
  return rows;
}

/** Priors pooled from the world's seasons before `season` (the defaults when none exist). */
export function priorsBefore(world: BacktestWorld, season: number): V2Priors {
  const games = new Map<V2Position, V2Game[]>();
  for (const p of world.players) {
    const list = games.get(p.position) ?? [];
    for (const g of p.games) if (g.season < season) list.push(g);
    games.set(p.position, list);
  }
  return buildV2Priors(
    games,
    world.team_games.filter((t) => t.season < season),
  );
}

/**
 * Projects every case: v2 (`samples` simulated lines scored by the engine), the trailing-4 and the
 * season-to-date means. Deterministic for a seed (each case draws from its own forked stream).
 */
export function evaluateCases(
  world: BacktestWorld,
  cases: readonly BacktestCase[],
  opts: BacktestOptions = {},
): BacktestRecord[] {
  const params = opts.params ?? DEFAULT_V2_PARAMS;
  const n = Math.max(2, Math.round(opts.samples ?? BACKTEST_V2.samples));
  const root = seededRng(opts.seed ?? 20_261_010);
  const teamIdx = indexTeamGames(world.team_games);
  const byId = new Map(world.players.map((p) => [p.gsis_id, p]));
  const rows = matchupRows(world);
  const priorsMemo = new Map<number, V2Priors>();
  const tableMemo = new Map<string, V2MatchupTable>();
  const volumeMemo = new Map<string, Map<string, TeamVolume>>();
  const buf = new Float64Array(n * SAMPLE_WIDTH);
  const out: BacktestRecord[] = [];
  for (const c of cases) {
    const p = byId.get(c.gsis_id);
    if (p === undefined) continue;
    let priors = opts.priors ?? priorsMemo.get(c.season);
    if (priors === undefined) {
      priors = priorsBefore(world, c.season);
      priorsMemo.set(c.season, priors);
    }
    const wk = `${String(c.season)}|${String(c.week)}`;
    let table = tableMemo.get(wk);
    if (table === undefined) {
      table = buildMatchupTable(rows, c.season, c.week);
      tableMemo.set(wk, table);
    }
    let vm = volumeMemo.get(wk);
    if (vm === undefined) {
      vm = new Map();
      volumeMemo.set(wk, vm);
    }
    const tg = teamIdx.get(teamGameKey(c.team, c.season, c.week)) ?? null;
    const exp = expectV2(
      {
        position: c.position,
        position_id: V2_POSITION_IDS[c.position],
        team: c.team,
        games: p.games,
      },
      {
        season: c.season,
        week: c.week,
        team_index: teamIdx,
        team_games: world.team_games,
        market: tg === null ? null : { implied: tg.implied, spread: tg.spread, total: tg.total },
        weather: world.weather.get(teamGameKey(c.team, c.season, c.week)) ?? null,
        opponent: tg?.opponent ?? null,
        matchup: table,
        priors,
        params,
        volume_memo: vm,
      },
    );
    if (typeof exp === "string") continue;
    const active = pActiveV2(c.availability, opts.availability_table);
    const rng = root.fork(`bt:${c.gsis_id}:${String(c.season)}:${String(c.week)}`);
    const pts = new Float64Array(n);
    const pid = V2_POSITION_IDS[c.position];
    for (let i = 0; i < n; i++) {
      simulateInto(exp.expectation, active.p, params, rng, buf, i * SAMPLE_WIDTH);
      pts[i] = score(lineAt(buf, i * SAMPLE_WIDTH, pid), world.settings).points;
    }
    pts.sort();
    let sum = 0;
    for (const x of pts) sum += x;
    const prior = before(p, c.season, c.week);
    const t4 = prior.slice(0, BACKTEST_V2.trailingGames);
    const cur = prior.filter((g) => g.season === c.season);
    const std = cur.length > 0 ? cur : prior.filter((g) => g.season === prior[0]?.season);
    const mean = (gs: readonly ScoredGame[]): number =>
      gs.length === 0 ? 0 : gs.reduce((s, g) => s + g.points, 0) / gs.length;
    out.push({
      ...c,
      p_active: active.p,
      v2_mean: sum / n,
      v2_sorted: pts,
      t4_mean: mean(t4),
      std_mean: mean(std),
      cv: positionCv(c.position, pid, world.settings),
      expectation: exp.expectation,
    });
  }
  return out;
}

/** One model's scores over a set of records. */
export interface ModelScore {
  readonly n: number;
  readonly crps: number | null;
  readonly mae: number | null;
  readonly spearman: number | null;
  readonly spearman_groups: number;
  readonly coverage80: number | null;
  readonly pinball: {
    readonly p10: number | null;
    readonly p50: number | null;
    readonly p90: number | null;
  };
}

/** A forecast of one record for scoring: its mean, CRPS at the actual, and its p10/p50/p90. */
export interface Forecast {
  readonly mean: number;
  readonly crps: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
}

/** Type-7 quantile of an ascending sample. */
function q7(sorted: Float64Array, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const a = sorted[lo] ?? 0;
  const b = sorted[Math.min(lo + 1, n - 1)] ?? 0;
  return a + (h - lo) * (b - a);
}

/** The v2 forecast of a record (optionally rescaled to an ensemble mean). */
export function v2Forecast(r: BacktestRecord, mean?: number): Forecast {
  let s = r.v2_sorted;
  if (mean !== undefined && Number.isFinite(mean)) {
    const f = r.v2_mean > 0 ? mean / r.v2_mean : Number.NaN;
    if (f >= 1 / V2_SIMS.maxRescale && f <= V2_SIMS.maxRescale) s = s.map((x) => x * f);
    else return gammaForecast(mean, r.cv, r.actual, 1);
  }
  return {
    mean: mean ?? r.v2_mean,
    crps: crpsSorted(s, r.actual),
    p10: q7(s, 0.1),
    p50: q7(s, 0.5),
    p90: q7(s, 0.9),
  };
}

/** A gamma `position_cv` forecast around `mean`, mixed with a zero mass of 1 − pActive. */
export function gammaForecast(mean: number, cv: number, actual: number, pActive = 1): Forecast {
  const p = Math.min(1, Math.max(0, pActive));
  const qOf = (q: number): number => {
    if (!(mean > 0)) return Math.max(0, mean);
    // the mixture's quantile: 0 below the zero mass, else the gamma's (q − (1 − p)) / p quantile
    if (q <= 1 - p) return 0;
    const shape = 1 / (cv * cv);
    return (mean * gammaQuantile((q - (1 - p)) / p, shape)) / shape;
  };
  return {
    mean: mean * p,
    crps: crpsGamma(mean, cv, actual, p),
    p10: qOf(0.1),
    p50: qOf(0.5),
    p90: qOf(0.9),
  };
}

/** Scores a model over records (`forecast` maps a record to the model's forecast). */
export function scoreModel(
  records: readonly BacktestRecord[],
  forecast: (r: BacktestRecord) => Forecast,
): ModelScore {
  const crps: number[] = [];
  const abs: number[] = [];
  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  let cov = 0;
  const ranked: { group: string; forecast: number; outcome: number }[] = [];
  for (const r of records) {
    const f = forecast(r);
    crps.push(f.crps);
    abs.push(Math.abs(f.mean - r.actual));
    p10.push(pinball(0.1, f.p10, r.actual));
    p50.push(pinball(0.5, f.p50, r.actual));
    p90.push(pinball(0.9, f.p90, r.actual));
    if (covered(f.p10, f.p90, r.actual)) cov += 1;
    ranked.push({
      group: `${String(r.season)}|${String(r.week)}|${r.position}`,
      forecast: f.mean,
      outcome: r.actual,
    });
  }
  const sp = spearmanWithin(ranked);
  return {
    n: records.length,
    crps: meanOrNull(crps),
    mae: meanOrNull(abs),
    spearman: sp.mean,
    spearman_groups: sp.groups,
    coverage80: records.length === 0 ? null : cov / records.length,
    pinball: { p10: meanOrNull(p10), p50: meanOrNull(p50), p90: meanOrNull(p90) },
  };
}

/** The models of the nflverse backtest. */
export const BACKTEST_MODELS = Object.freeze({
  v2: (r: BacktestRecord): Forecast => v2Forecast(r),
  trailing4: (r: BacktestRecord): Forecast => gammaForecast(r.t4_mean, r.cv, r.actual),
  trailing4_active: (r: BacktestRecord): Forecast =>
    gammaForecast(r.t4_mean, r.cv, r.actual, r.p_active),
  season_to_date: (r: BacktestRecord): Forecast => gammaForecast(r.std_mean, r.cv, r.actual),
});

/** One season's C1 summary. */
export interface SeasonSummary {
  readonly season: number;
  readonly models: Readonly<Record<keyof typeof BACKTEST_MODELS, ModelScore>>;
  /** v2 vs trailing-4 by position and by week bucket (CRPS and Spearman). */
  readonly by_position: Readonly<
    Record<string, { readonly v2: ModelScore; readonly trailing4: ModelScore }>
  >;
  readonly early: { readonly v2: ModelScore; readonly trailing4: ModelScore };
  readonly late: { readonly v2: ModelScore; readonly trailing4: ModelScore };
  /** Weeks 1–3's share of the total CRPS gain over trailing-4 (null without a positive gain). */
  readonly early_gain_share: number | null;
}

/** Summarises one season's records (the relevant population). */
export function summarizeSeason(records: readonly BacktestRecord[], season: number): SeasonSummary {
  const rs = records.filter((r) => r.season === season);
  const models = Object.fromEntries(
    Object.entries(BACKTEST_MODELS).map(([k, f]) => [k, scoreModel(rs, f)]),
  ) as Record<keyof typeof BACKTEST_MODELS, ModelScore>;
  const pair = (sub: readonly BacktestRecord[]) => ({
    v2: scoreModel(sub, BACKTEST_MODELS.v2),
    trailing4: scoreModel(sub, BACKTEST_MODELS.trailing4),
  });
  const by_position: Record<string, { v2: ModelScore; trailing4: ModelScore }> = {};
  for (const pos of ["QB", "RB", "WR", "TE"])
    by_position[pos] = pair(rs.filter((r) => r.position === pos));
  const earlyRs = rs.filter((r) => r.week <= BACKTEST_V2.earlyWeeks);
  const lateRs = rs.filter((r) => r.week > BACKTEST_V2.earlyWeeks);
  const early = pair(earlyRs);
  const late = pair(lateRs);
  const gainOf = (x: { v2: ModelScore; trailing4: ModelScore }, n: number): number =>
    ((x.trailing4.crps ?? 0) - (x.v2.crps ?? 0)) * n;
  const gEarly = gainOf(early, earlyRs.length);
  const gTotal = gEarly + gainOf(late, lateRs.length);
  return {
    season,
    models,
    by_position,
    early,
    late,
    early_gain_share: gTotal > 0 ? gEarly / gTotal : null,
  };
}
