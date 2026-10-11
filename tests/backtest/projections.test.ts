// projections.test.ts — plan 10 C1 (hard): on the two held-out seasons (2024, 2025 — every v2
// parameter was fitted on 2023 alone, constants.ts [fit]/[V-data]; the excerpt is
// tests/domain/analytics/projections-v2/data), weekly under the reference league's own S (fx-10h:
// half-PPR, 5-pt pass TD), `v2-opportunity` beats the trailing-4 average (with the positional-CV
// distribution) on CRPS and on within-position Spearman; the gain is not concentrated in weeks 1–3
// (v2 also wins on weeks 4–17 alone, and weeks 1–3 carry at most half of the gain); the p10–p90
// interval covers 80 % ± 5 points; and, on league-b's recorded box scores where ESPN's weekly
// projection exists (under league-b's own S), the ensemble at the shipped weight beats ESPN's
// mean-only projection with the positional CV on CRPS and matches its Spearman (research 05 §8.4
// "what good looks like"). Plan 10 B14's design on history: the shadow weights 0.5 and 0.75 against
// 1.0 — weight_espn moves below 1 only if a mixture beats ESPN alone on CRPS and MAE in both seasons
// (ADV OBJ-02), and the shipped constant must agree with that rule. Deterministic (fixed seeds); the
// numbers are written to docs/evals/phase3-projections.md by helpers/run-backtest.ts.
import { beforeAll, describe, expect, it } from "vitest";
import {
  BACKTEST_MODELS,
  backtestCases,
  espnModels,
  evaluateCases,
  externalCases,
  scoreModel,
  summarizeSeason,
  type BacktestRecord,
  type ModelScore,
  type SeasonSummary,
} from "../../src/domain/analytics/projections-v2/backtest.js";
import {
  BACKTEST_V2,
  SHADOW_WEIGHTS,
  WEIGHT_ESPN_V2,
} from "../../src/domain/analytics/projections-v2/constants.js";
import {
  buildWorld,
  espnWeekRows,
  leagueBSettings,
  referenceLeagueSettings,
} from "../domain/analytics/projections-v2/helpers/data.js";

const HELD_OUT = [2024, 2025] as const;
const SEED = 20_261_010;
const POSITIONS = ["QB", "RB", "WR", "TE"] as const;
const summaries = new Map<number, SeasonSummary>();
/** The training season's records (2023 weeks 4–17, the cases every parameter was fitted on). */
let training: BacktestRecord[] = [];
const espn = new Map<number, Record<string, ModelScore>>();
let espnRecords: BacktestRecord[] = [];

beforeAll(() => {
  const world = buildWorld("reference", referenceLeagueSettings());
  training = evaluateCases(
    world,
    backtestCases(world, 2023, 4, 17).filter((c) => c.relevant),
    { seed: SEED },
  );
  for (const season of HELD_OUT) {
    const cases = backtestCases(world, season).filter((c) => c.relevant);
    summaries.set(season, summarizeSeason(evaluateCases(world, cases, { seed: SEED }), season));
  }
  const worldB = buildWorld("league-b", leagueBSettings(2025));
  const ext = externalCases(
    worldB,
    espnWeekRows([...HELD_OUT]).map((r) => ({
      gsis_id: r.gsis_id,
      season: r.season,
      week: r.week,
      espn_mean: r.projection,
      actual: r.actual,
    })),
    // ESPN's recorded projections are game-day values (0 exactly for every inactive player), so the
    // comparison is at game time and v2 reads ESPN's status as plan 07 D2's game-day rule says
    { game_day: true },
  );
  espnRecords = evaluateCases(worldB, ext.cases, { seed: SEED });
  const models = espnModels(worldB, [1, ...SHADOW_WEIGHTS], { seed: SEED });
  for (const season of HELD_OUT) {
    const rs = espnRecords.filter((r) => r.season === season);
    espn.set(
      season,
      Object.fromEntries(Object.entries(models).map(([k, f]) => [k, scoreModel(rs, f)])),
    );
  }
}, 600_000);

const crps = (m: ModelScore | undefined): number => m?.crps ?? Number.NaN;
const sp = (m: ModelScore | undefined): number => m?.spearman ?? Number.NaN;

describe("plan 10 C1 — v2-opportunity vs trailing-4 on the held-out seasons", () => {
  it("league-b's two recorded seasons share one S (the ESPN comparison scores both under it)", () => {
    expect(leagueBSettings(2024)).toEqual(leagueBSettings(2025));
  });

  for (const season of HELD_OUT) {
    it(`${String(season)}: v2 beats trailing-4 on CRPS and within-position Spearman`, () => {
      const s = summaries.get(season);
      expect(s?.models.v2.n).toBeGreaterThan(3000);
      expect(crps(s?.models.v2)).toBeLessThan(crps(s?.models.trailing4));
      expect(sp(s?.models.v2)).toBeGreaterThan(sp(s?.models.trailing4));
      // and against the stronger baselines reported beside it
      expect(crps(s?.models.v2)).toBeLessThan(crps(s?.models.trailing4_active));
      expect(crps(s?.models.v2)).toBeLessThan(crps(s?.models.season_to_date));
    });

    it(`${String(season)}: the gain is not concentrated in weeks 1–3`, () => {
      const s = summaries.get(season);
      expect(crps(s?.late.v2)).toBeLessThan(crps(s?.late.trailing4));
      expect(sp(s?.late.v2)).toBeGreaterThan(sp(s?.late.trailing4));
      expect(s?.early_gain_share).not.toBeNull();
      expect(s?.early_gain_share ?? 1).toBeLessThanOrEqual(BACKTEST_V2.maxEarlyGainShare);
    });

    it(`${String(season)}: the p10–p90 interval covers 80 % ± 5 points`, () => {
      const cov = summaries.get(season)?.models.v2.coverage80 ?? Number.NaN;
      expect(Math.abs(cov - BACKTEST_V2.coverageNominal)).toBeLessThanOrEqual(
        BACKTEST_V2.coverageTolerance,
      );
    });
  }
});

describe('Stage C — the per-position interval (docs/evals/phase3-projections.md "Per-position dispersion")', () => {
  it("on the training season the QB simulation's mean is on target (the centred drive cost) and every position's p10–p90 covers 80 % ± 5", () => {
    const qb = training.filter((r) => r.position === "QB");
    const bias = qb.reduce((a, r) => a + r.v2_mean - r.actual, 0) / qb.length;
    // uncentred, the simulation lost 1.28 points a QB-week (14.85 against an actual 16.00)
    expect(Math.abs(bias)).toBeLessThan(0.5);
    for (const pos of POSITIONS) {
      const cov = scoreModel(
        training.filter((r) => r.position === pos),
        BACKTEST_MODELS.v2,
      ).coverage80;
      expect(Math.abs((cov ?? 0) - BACKTEST_V2.coverageNominal), pos).toBeLessThanOrEqual(
        BACKTEST_V2.coverageTolerance,
      );
    }
  });

  for (const season of HELD_OUT)
    it(`${String(season)}: the SERVED distribution (the ensemble at the shipped weight, game time) covers 80 % ± 5 at every position`, () => {
      const served = espnModels(buildWorld("league-b", leagueBSettings(2025)), [WEIGHT_ESPN_V2], {
        seed: SEED,
      })[`ensemble_${WEIGHT_ESPN_V2.toFixed(2)}`];
      if (served === undefined) throw new Error("no served model");
      for (const pos of POSITIONS) {
        const rs = espnRecords.filter((r) => r.season === season && r.position === pos);
        expect(rs.length, pos).toBeGreaterThan(200);
        const cov = scoreModel(rs, served).coverage80 ?? 0;
        expect(Math.abs(cov - BACKTEST_V2.coverageNominal), pos).toBeLessThanOrEqual(
          BACKTEST_V2.coverageTolerance,
        );
      }
    });
});

describe("plan 10 C1 — the ensemble vs ESPN's mean-only projection (league-b's recorded box scores)", () => {
  it("compares thousands of recorded player-weeks per season", () => {
    for (const season of HELD_OUT)
      expect(espn.get(season)?.espn_position_cv?.n).toBeGreaterThan(1500);
  });

  for (const season of HELD_OUT) {
    it(`${String(season)}: at the shipped weight the ensemble beats ESPN + positional CV on CRPS and matches its Spearman`, () => {
      const m = espn.get(season) ?? {};
      const key = `ensemble_${WEIGHT_ESPN_V2.toFixed(2)}`;
      expect(crps(m[key])).toBeLessThan(crps(m.espn_position_cv));
      expect(sp(m[key])).toBeGreaterThanOrEqual(sp(m.espn_position_cv) - 1e-12);
    });
  }
});

describe("plan 10 B14 on history — the shadow weights", () => {
  it("weight_espn ships at 1.0 unless a mixture beats ESPN alone on CRPS and MAE in both seasons", () => {
    const beats = (w: number): boolean =>
      HELD_OUT.every((season) => {
        const m = espn.get(season) ?? {};
        const mix = m[`ensemble_${w.toFixed(2)}`];
        const alone = m[`ensemble_${(1).toFixed(2)}`];
        // a win must exceed the evaluation's Monte-Carlo noise (BACKTEST_V2.crpsNoise)
        return (
          crps(mix) < crps(alone) - BACKTEST_V2.crpsNoise &&
          (mix?.mae ?? Infinity) < (alone?.mae ?? -Infinity)
        );
      });
    const shipped: number = WEIGHT_ESPN_V2;
    expect(SHADOW_WEIGHTS.some(beats) ? shipped < 1 : shipped === 1).toBe(true);
  });

  it("the ensemble's mean at weight 1 is ESPN's, and every record carries ESPN's mean", () => {
    expect(espnRecords.every((r) => r.espn_mean !== null)).toBe(true);
    for (const season of HELD_OUT) {
      const m = espn.get(season) ?? {};
      expect(m["ensemble_1.00"]?.mae).toBeCloseTo(m.espn_position_cv?.mae ?? Number.NaN, 9);
    }
  });
});
