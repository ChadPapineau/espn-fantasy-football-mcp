// run-backtest.ts — prints the C1 backtest numbers as JSON (the source of docs/evals/
// phase3-projections.md's tables; the same seeds and procedure as tests/backtest/projections.test.ts).
// Not a test and never run by CI; reads only the committed excerpt and the recorded ESPN history.
//
//   scripts/dev/with-node.sh npx tsx tests/domain/analytics/projections-v2/helpers/run-backtest.ts
import {
  brierActive,
  pActiveV2,
} from "../../../../../src/domain/analytics/projections-v2/availability.js";
import {
  backtestCases,
  espnModels,
  evaluateCases,
  externalCases,
  scoreModel,
  summarizeSeason,
  type BacktestRecord,
  type ExternalRow,
} from "../../../../../src/domain/analytics/projections-v2/backtest.js";
import { P_ACTIVE_PRIOR } from "../../../../../src/domain/analytics/projections-v2/constants.js";
import { buildWorld, espnWeekRows, leagueBSettings, referenceLeagueSettings } from "./data.js";

const SEED = 20_261_010;
const HELD_OUT = [2024, 2025];
const out: Record<string, unknown> = {};

// C1 against trailing-4 under the reference league's S
const world = buildWorld("reference", referenceLeagueSettings());
for (const season of HELD_OUT) {
  const t0 = performance.now();
  const all = backtestCases(world, season);
  const cases = all.filter((c) => c.relevant);
  const recs = evaluateCases(world, cases, { seed: SEED });
  const summary = summarizeSeason(recs, season);
  // P(active): the fitted table vs the designation-only prior on the listed cases
  const listed = cases.filter(
    (c) => c.availability.designation !== null || c.availability.practice !== null,
  );
  const brier = {
    listed: listed.length,
    fitted_table: brierActive(
      listed.map((c) => ({ p: pActiveV2(c.availability).p, played: c.played })),
    ),
    designation_prior: brierActive(
      listed.map((c) => ({ p: pActiveV2(c.availability, P_ACTIVE_PRIOR).p, played: c.played })),
    ),
  };
  // the unfiltered population (no relevance floor), v2 vs trailing-4 only
  const recsAll = evaluateCases(world, all, { seed: SEED, samples: 100 });
  out[`nflverse_${String(season)}`] = {
    ...summary,
    population_all: summarizeSeason(recsAll, season).models,
    cases_all: all.length,
    brier_p_active: brier,
    ms: Math.round(performance.now() - t0),
  };
}

// C1 against ESPN's mean-only projection and the B14 shadow weights, under league-b's S
const worldB = buildWorld("league-b", leagueBSettings(2025));
const rows: ExternalRow[] = espnWeekRows(HELD_OUT).map((r) => ({
  gsis_id: r.gsis_id,
  season: r.season,
  week: r.week,
  espn_mean: r.projection,
  actual: r.actual,
}));
for (const [label, gameDay] of [
  ["espn_game_day", true],
  ["espn_pre_game", false],
] as const) {
  const ext = externalCases(worldB, rows, { game_day: gameDay });
  const recs = evaluateCases(worldB, ext.cases, { seed: SEED });
  const models = espnModels(worldB, gameDay ? [1, 0.75, 0.5, 0] : [1], { seed: SEED });
  const res: Record<string, unknown> = {
    rows: rows.length,
    cases: ext.cases.length,
    drops: ext.drops,
  };
  for (const season of HELD_OUT) {
    const rs = recs.filter((r) => r.season === season);
    res[String(season)] = Object.fromEntries(
      Object.entries(models).map(([k, f]) => [k, scoreModel(rs, f)]),
    );
    if (gameDay) {
      const by: Record<string, unknown> = {};
      for (const pos of ["QB", "RB", "WR", "TE"]) {
        const sub: BacktestRecord[] = rs.filter((r) => r.position === pos);
        const ens = models["ensemble_1.00"];
        const esp = models.espn_position_cv;
        if (ens !== undefined && esp !== undefined)
          by[pos] = { ensemble_1: scoreModel(sub, ens), espn_position_cv: scoreModel(sub, esp) };
      }
      res[`${String(season)}_by_position`] = by;
    }
  }
  out[label] = res;
}
console.log(JSON.stringify(out, null, 1));
