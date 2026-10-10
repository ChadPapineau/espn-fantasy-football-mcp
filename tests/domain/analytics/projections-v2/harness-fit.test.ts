// harness-fit.test.ts — the backtest harness (plan 10 C1; sib research 05 §1-Evaluation) and the fit
// / re-fit proposal (plan 10 C9: proposed, never applied here) on a small synthetic world: the C1
// population rule (played or Questionable/Doubtful; OUT and undesignated absences excluded; a case
// needs an earlier game and a team-game), strict causality (no case reads its own week), the
// models' forecasts, the season summary's week buckets and gain share, the ESPN comparison's cases
// and drops, and coordinate descent that only moves when the objective improves.
import { describe, expect, it } from "vitest";
import {
  anchoredForecast,
  BACKTEST_MODELS,
  backtestCases,
  espnModels,
  evaluateCases,
  externalCases,
  gammaForecast,
  matchupRows,
  priorsBefore,
  scoreModel,
  summarizeSeason,
  v2Forecast,
  type BacktestWorld,
} from "../../../../src/domain/analytics/projections-v2/backtest.js";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import {
  DEFAULT_TUNING,
  diffParams,
  fitV2Params,
  inBounds,
  objective,
  paramAt,
  proposeV2Refit,
  withParam,
} from "../../../../src/domain/analytics/projections-v2/fit.js";
import { lineFromCounts } from "../../../../src/domain/analytics/projections-v2/simulate.js";
import type { V2Game, V2Position } from "../../../../src/domain/analytics/projections-v2/types.js";
import { score } from "../../../../src/domain/scoring/engine.js";
import { settings, syntheticWorld } from "./helpers/synthetic.js";

const S = settings();
const pid: Record<V2Position, number> = { QB: 1, RB: 2, WR: 3, TE: 4 };
const points = (g: V2Game, pos: V2Position): number =>
  score(
    lineFromCounts(
      {
        pass_att: g.pass_att,
        pass_cmp: g.pass_cmp,
        pass_yd: g.pass_yd,
        pass_td: g.pass_td,
        pass_int: g.pass_int,
        sacks: g.sacks,
        rush_att: g.rush_att,
        rush_yd: g.rush_yd,
        rush_td: g.rush_td,
        targets: g.targets,
        rec: g.rec,
        rec_yd: g.rec_yd,
        rec_td: g.rec_td,
        fum_lost: g.sack_fum_lost + g.rush_fum_lost + g.rec_fum_lost,
        pass_2pt: 0,
        rush_2pt: 0,
        rec_2pt: 0,
      },
      pid[pos],
    ),
    S,
  ).points;
const world: BacktestWorld = syntheticWorld(points, S, 8);

describe("backtestCases", () => {
  it("takes players with an earlier game whose team plays, who played or were listed Q/D", () => {
    const cases = backtestCases(world, 2025, 1, 8);
    // 10 players × 8 weeks, every one has 2024 history and plays every week
    expect(cases).toHaveLength(80);
    expect(cases.every((c) => c.played)).toBe(true);
    expect(cases[0]?.week).toBe(1);
    expect(cases.map((c) => c.espn_mean).every((x) => x === null)).toBe(true);
  });

  it("keeps a listed absence (actual 0) and drops OUT and undesignated absences", () => {
    const rb = world.players.find((p) => p.position === "RB");
    if (rb === undefined) throw new Error("no RB");
    const games = rb.games.filter(
      (g) => !(g.season === 2025 && (g.week === 4 || g.week === 5 || g.week === 6)),
    );
    const reports = new Map(world.reports);
    reports.set(`${rb.gsis_id}|2025|4`, {
      designation: "Questionable",
      practice: "DNP",
      team: "AAA",
    });
    reports.set(`${rb.gsis_id}|2025|5`, { designation: "Out", practice: "DNP", team: "AAA" });
    reports.delete(`${rb.gsis_id}|2025|6`);
    const w2: BacktestWorld = {
      ...world,
      players: world.players.map((p) => (p === rb ? { ...p, games } : p)),
      reports,
    };
    const mine = backtestCases(w2, 2025, 1, 8).filter((c) => c.gsis_id === rb.gsis_id);
    expect(mine.map((c) => c.week)).toEqual([1, 2, 3, 4, 7, 8]);
    const q = mine.find((c) => c.week === 4);
    expect(q).toMatchObject({ played: false, actual: 0 });
    expect(q?.availability.designation).toBe("Questionable");
  });

  it("drops a case without an earlier game or without a team-game", () => {
    expect(backtestCases(world, 2024, 1, 1)).toHaveLength(0);
    const noTeams: BacktestWorld = {
      ...world,
      team_games: world.team_games.filter((t) => t.week !== 3 || t.season !== 2025),
    };
    expect(backtestCases(noTeams, 2025, 3, 3)).toHaveLength(0);
  });

  it("flags relevance by the trailing opportunity floor", () => {
    const cases = backtestCases(world, 2025, 2, 2);
    expect(cases.filter((c) => c.relevant).length).toBeGreaterThan(5);
    const qb = cases.find((c) => c.position === "QB");
    expect(qb?.relevant).toBe(true);
  });
});

describe("evaluateCases / models", () => {
  const cases = backtestCases(world, 2025, 1, 8);
  const recs = evaluateCases(world, cases, { samples: 60, seed: 3 });

  it("projects every case with its own sorted samples and the two baselines", () => {
    expect(recs).toHaveLength(cases.length);
    for (const r of recs) {
      expect(r.v2_sorted).toHaveLength(60);
      for (let i = 1; i < r.v2_sorted.length; i++)
        expect(r.v2_sorted[i] ?? 0).toBeGreaterThanOrEqual(r.v2_sorted[i - 1] ?? 0);
      expect(r.t4_mean).toBeGreaterThan(0);
      expect(r.std_mean).toBeGreaterThan(0);
      expect(r.cv).toBeGreaterThan(0);
      expect(r.expectation.position).toBe(r.position);
    }
  });

  it("is causal: changing a case's own week leaves its forecast unchanged", () => {
    const target = cases.find((c) => c.week === 5 && c.position === "WR");
    if (target === undefined) throw new Error("no case");
    const changed: BacktestWorld = {
      ...world,
      players: world.players.map((p) =>
        p.gsis_id === target.gsis_id
          ? {
              ...p,
              games: p.games.map((g) =>
                g.season === 2025 && g.week === 5 ? { ...g, targets: 40, points: 99 } : g,
              ),
            }
          : p,
      ),
    };
    const a = evaluateCases(world, [target], { samples: 40, seed: 9 })[0];
    const b = evaluateCases(changed, [{ ...target, actual: 99 }], { samples: 40, seed: 9 })[0];
    expect(b?.v2_mean).toBe(a?.v2_mean);
    expect(b?.t4_mean).toBe(a?.t4_mean);
  });

  it("is deterministic per seed", () => {
    const again = evaluateCases(world, cases.slice(0, 5), { samples: 60, seed: 3 });
    expect(again.map((r) => r.v2_mean)).toEqual(recs.slice(0, 5).map((r) => r.v2_mean));
  });

  it("scores every model and summarises a season with its week buckets", () => {
    const m = scoreModel(recs, BACKTEST_MODELS.v2);
    expect(m.n).toBe(recs.length);
    expect(m.crps).toBeGreaterThan(0);
    expect(m.coverage80).toBeGreaterThan(0);
    expect(m.spearman_groups).toBeGreaterThan(0);
    const s = summarizeSeason(recs, 2025);
    expect(Object.keys(s.models).sort()).toEqual([
      "season_to_date",
      "trailing4",
      "trailing4_active",
      "v2",
    ]);
    expect(s.early.v2.n + s.late.v2.n).toBe(recs.length);
    expect(Object.keys(s.by_position)).toEqual(["QB", "RB", "WR", "TE"]);
    expect(scoreModel([], BACKTEST_MODELS.v2)).toMatchObject({
      n: 0,
      crps: null,
      coverage80: null,
    });
    expect(summarizeSeason(recs, 1999).early_gain_share).toBeNull();
  });

  it("forecast helpers: gamma with a zero mass, v2 rescaled or on the gamma fallback", () => {
    const g = gammaForecast(10, 0.6, 4, 0.5);
    expect(g.p10).toBe(0);
    expect(g.mean).toBe(5);
    expect(gammaForecast(0, 0.6, 4)).toMatchObject({ p10: 0, p90: 0, crps: 4 });
    const r = recs[0];
    if (r === undefined) throw new Error("no record");
    expect(v2Forecast(r).mean).toBe(r.v2_mean);
    expect(v2Forecast(r, r.v2_mean * 2).mean).toBeCloseTo(r.v2_mean * 2, 9);
    expect(v2Forecast(r, r.v2_mean * 50).crps).toBe(
      gammaForecast(r.v2_mean * 50, r.cv, r.actual).crps,
    );
  });

  it("matchupRows and priorsBefore read the world", () => {
    expect(matchupRows(world)).toHaveLength(world.players.reduce((s, p) => s + p.games.length, 0));
    expect(priorsBefore(world, 2024)).toEqual(DEFAULT_V2_PRIORS);
  });
});

describe("externalCases / espnModels", () => {
  const rows = [
    {
      gsis_id: world.players[2]?.gsis_id ?? null,
      season: 2025,
      week: 3,
      espn_mean: 12,
      actual: 15,
    },
    { gsis_id: null, season: 2025, week: 3, espn_mean: 5, actual: 2 },
    { gsis_id: "00-0000000", season: 2025, week: 3, espn_mean: 5, actual: 2 },
    { gsis_id: world.players[2]?.gsis_id ?? null, season: 2024, week: 1, espn_mean: 9, actual: 1 },
    { gsis_id: world.players[2]?.gsis_id ?? null, season: 2025, week: 12, espn_mean: 9, actual: 1 },
  ];

  it("keeps rows with history and a team-game, counting every drop", () => {
    const ext = externalCases(world, rows);
    expect(ext.cases).toHaveLength(1);
    expect(ext.drops).toEqual({ no_gsis: 2, no_history: 1, no_team_game: 1 });
    expect(ext.cases[0]).toMatchObject({ espn_mean: 12, actual: 15, week: 3 });
  });

  it("scores ESPN's mean with the positional CV, v2's own, and the ensemble at each weight", () => {
    const ext = externalCases(world, rows);
    const recs = evaluateCases(world, ext.cases, { samples: 80, seed: 2 });
    const models = espnModels(world, [1, 0.5, 0], { samples: 80, seed: 2 });
    expect(Object.keys(models).sort()).toEqual(
      [
        "ensemble_0.00",
        "ensemble_0.50",
        "ensemble_1.00",
        "ensemble_rescale_0.00",
        "ensemble_rescale_0.50",
        "ensemble_rescale_1.00",
        "espn_position_cv",
        "v2_own",
      ].sort(),
    );
    const r = recs[0];
    if (r === undefined) throw new Error("no record");
    expect(models["ensemble_1.00"]?.(r).mean).toBeCloseTo(12, 9);
    expect(models["ensemble_0.00"]?.(r).mean).toBe(r.v2_mean);
    expect(models.espn_position_cv?.(r).mean).toBe(12);
    // ruled out / zero mean / unanchorable → the gamma forecast
    expect(anchoredForecast(world, { ...r, p_active: 0 }, 12, "x").crps).toBe(
      gammaForecast(12, r.cv, r.actual).crps,
    );
    expect(anchoredForecast(world, r, 0, "x").crps).toBe(gammaForecast(0, r.cv, r.actual).crps);
    expect(anchoredForecast(world, r, r.v2_mean * 40, "x").crps).toBe(
      gammaForecast(r.v2_mean * 40, r.cv, r.actual).crps,
    );
  });
});

describe("fit", () => {
  const cases = backtestCases(world, 2025, 3, 8);

  it("paramAt / withParam / inBounds address dotted paths", () => {
    expect(paramAt(DEFAULT_V2_PARAMS, "k.xtd")).toBe(DEFAULT_V2_PARAMS.k.xtd);
    expect(Number.isNaN(paramAt(DEFAULT_V2_PARAMS, "k.nope"))).toBe(true);
    expect(Number.isNaN(paramAt(DEFAULT_V2_PARAMS, "sim"))).toBe(true);
    const p = withParam(DEFAULT_V2_PARAMS, "sim.cv_share", 0.33);
    expect(p.sim.cv_share).toBe(0.33);
    expect(DEFAULT_V2_PARAMS.sim.cv_share).not.toBe(0.33);
    expect(Object.isFrozen(p.sim)).toBe(true);
    expect(() => withParam(DEFAULT_V2_PARAMS, "sim.nope", 1)).toThrow(RangeError);
    expect(() => withParam(DEFAULT_V2_PARAMS, "sim", 1)).toThrow(RangeError);
    expect(() => withParam(DEFAULT_V2_PARAMS, "half_life_games.x", 1)).toThrow(RangeError);
    expect(inBounds("half_life_games", 4)).toBe(true);
    expect(inBounds("half_life_games", 40)).toBe(false);
    expect(inBounds("matchup_beta.QB", 2)).toBe(false);
    expect(inBounds("k.xtd", 0)).toBe(false);
    expect(inBounds("sim.cv_eff", 3)).toBe(false);
    expect(inBounds("market_td_theta", 1)).toBe(true);
    expect(inBounds("prior_season_weight", 1.5)).toBe(false);
    expect(inBounds("change_point.pre_weight", 0.5)).toBe(true);
    expect(inBounds("team.half_life_games", 6)).toBe(true);
    expect(inBounds("max_games", 16)).toBe(true);
    expect(inBounds("k.xtd", Number.NaN)).toBe(false);
    for (const t of DEFAULT_TUNING)
      expect(Number.isFinite(paramAt(DEFAULT_V2_PARAMS, t.path))).toBe(true);
  });

  it("moves a parameter only when the objective improves, and proposes without applying", () => {
    const bad = withParam(DEFAULT_V2_PARAMS, "sim.cv_share", 1.2);
    const tuning = [{ path: "sim.cv_share", grid: [0.2, 1.2] }];
    const opts = { samples: 40, seed: 5, tuning, passes: 2, min_gain: 0 };
    const fit = fitV2Params(world, cases, bad, opts);
    expect(fit.crps_after).toBeLessThanOrEqual(fit.crps_before);
    expect(fit.steps.every((s) => s.crps < fit.crps_before)).toBe(true);
    expect(fit.evaluations).toBeGreaterThanOrEqual(2);
    if (fit.accepted) expect(fit.params.sim.cv_share).toBe(0.2);
    expect(objective(world, cases, fit.params, opts)).toBeCloseTo(fit.crps_after, 9);
    const refit = proposeV2Refit(world, cases, bad, opts);
    expect(refit.changes.every((c) => c.path === "sim.cv_share")).toBe(true);
    expect(bad.sim.cv_share).toBe(1.2);
  });

  it("refuses a proposal below the minimum gain; diffParams lists changed paths", () => {
    const fit = fitV2Params(world, cases, DEFAULT_V2_PARAMS, {
      samples: 30,
      seed: 5,
      tuning: [{ path: "k.share", grid: [1.0001] }],
      min_gain: 0.5,
    });
    expect(fit.accepted).toBe(false);
    expect(fit.params).toBe(DEFAULT_V2_PARAMS);
    expect(() =>
      fitV2Params(world, cases, DEFAULT_V2_PARAMS, { tuning: [{ path: "nope", grid: [1] }] }),
    ).toThrow(RangeError);
    expect(diffParams(DEFAULT_V2_PARAMS, withParam(DEFAULT_V2_PARAMS, "k.xtd", 7))).toEqual([
      { path: "k.xtd", current: DEFAULT_V2_PARAMS.k.xtd, proposed: 7 },
    ]);
  });
});
