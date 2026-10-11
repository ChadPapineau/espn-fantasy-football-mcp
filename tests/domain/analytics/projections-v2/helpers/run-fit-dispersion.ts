// run-fit-dispersion.ts — fits the own simulation's per-position dispersion (Stage C; constants.ts
// DEFAULT_V2_PARAMS.sim.position, fit.ts DISPERSION_TUNING) on the TRAINING season only (2023 weeks
// 4–17 of the committed excerpt, the cases `run-fit.ts` tunes on; the held-out 2024–2025 never set a
// value) and prints, per position, the proposal and the 2023 coverage, tails and CRPS before and
// after — the source of docs/evals/phase3-projections.md "Per-position dispersion". Not a test and
// never run by CI; reads only the committed excerpt.
//
//   scripts/dev/with-node.sh npx tsx tests/domain/analytics/projections-v2/helpers/run-fit-dispersion.ts [samples] [positions]
import {
  backtestCases,
  BACKTEST_MODELS,
  evaluateCases,
  scoreModel,
  type BacktestRecord,
} from "../../../../../src/domain/analytics/projections-v2/backtest.js";
import { DEFAULT_V2_PARAMS } from "../../../../../src/domain/analytics/projections-v2/constants.js";
import { fitPositionDispersion } from "../../../../../src/domain/analytics/projections-v2/fit.js";
import type {
  V2Params,
  V2Position,
} from "../../../../../src/domain/analytics/projections-v2/types.js";
import { buildWorld, referenceLeagueSettings } from "./data.js";

const samples = Number(process.argv[2] ?? 1000);
const positions = (process.argv[3] ?? "QB,RB").split(",") as V2Position[];
const SEED = 20_261_010;
const world = buildWorld("reference", referenceLeagueSettings());
const train = backtestCases(world, 2023, 4, 17).filter((c) => c.relevant);

/** Coverage, the two tails and CRPS of one position's records. */
function tails(recs: readonly BacktestRecord[]) {
  let lo = 0;
  let hi = 0;
  for (const r of recs) {
    const f = BACKTEST_MODELS.v2(r);
    if (r.actual < f.p10) lo += 1;
    if (r.actual > f.p90) hi += 1;
  }
  const s = scoreModel(recs, BACKTEST_MODELS.v2);
  return {
    n: recs.length,
    crps: s.crps,
    coverage80: s.coverage80,
    below_p10: recs.length === 0 ? null : lo / recs.length,
    above_p90: recs.length === 0 ? null : hi / recs.length,
  };
}
const report = (params: V2Params, pos: V2Position) =>
  tails(
    evaluateCases(
      world,
      train.filter((c) => c.position === pos),
      { seed: SEED, samples, params },
    ),
  );

const t0 = performance.now();
const before = Object.fromEntries(positions.map((p) => [p, report(DEFAULT_V2_PARAMS, p)]));
const fit = fitPositionDispersion(world, train, positions, DEFAULT_V2_PARAMS, {
  seed: SEED,
  samples,
  passes: 2,
});
const after = Object.fromEntries(positions.map((p) => [p, report(fit.params, p)]));
console.log(
  JSON.stringify(
    {
      samples,
      cases: train.length,
      position: fit.params.sim.position,
      fits: fit.fits.map((f) => ({
        position: f.position,
        cases: f.cases,
        accepted: f.proposal.accepted,
        crps_before: f.proposal.crps_before,
        crps_after: f.proposal.crps_after,
        steps: f.proposal.steps,
        evaluations: f.proposal.evaluations,
      })),
      before,
      after,
      ms: Math.round(performance.now() - t0),
    },
    null,
    1,
  ),
);
