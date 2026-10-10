// run-fit.ts — tunes the v2 parameters and the P(active) table on the TRAINING season (2023 weeks
// 4–17 of the committed excerpt; sib §1-Evaluation: tune on one season, test on another) and prints
// the proposal as JSON — the source of constants.ts' [fit] values and docs/evals/phase3-projections.md
// "Tuning". Not a test and never run by CI; reads only the committed excerpt.
//
//   scripts/dev/with-node.sh npx tsx tests/domain/analytics/projections-v2/helpers/run-fit.ts [samples] [passes] [start.json]
import { backtestCases } from "../../../../../src/domain/analytics/projections-v2/backtest.js";
import {
  fitAvailability,
  normalizeDesignation,
  normalizePractice,
} from "../../../../../src/domain/analytics/projections-v2/availability.js";
import {
  DEFAULT_TUNING,
  fitV2Params,
} from "../../../../../src/domain/analytics/projections-v2/fit.js";
import { readFileSync } from "node:fs";
import type { V2Params } from "../../../../../src/domain/analytics/projections-v2/types.js";
import { buildWorld, referenceLeagueSettings } from "./data.js";

const samples = Number(process.argv[2] ?? 100);
const passes = Number(process.argv[3] ?? 2);
const world = buildWorld("reference", referenceLeagueSettings());
const all = backtestCases(world, 2023, 4, 17);
const train = all.filter((c) => c.relevant);
const listed = train
  .filter((c) => c.availability.designation !== null || c.availability.practice !== null)
  .map((c) => ({
    designation: c.availability.designation,
    practice: c.availability.practice,
    played: c.played,
  }));
const table = fitAvailability(listed);
const counts: Record<string, { n: number; played: number }> = {};
for (const r of listed) {
  const key = `${normalizeDesignation(r.designation)}|${normalizePractice(r.practice)}`;
  const c = (counts[key] ??= { n: 0, played: 0 });
  c.n += 1;
  if (r.played) c.played += 1;
}
const t0 = performance.now();
const start =
  process.argv[4] === undefined
    ? undefined
    : (JSON.parse(readFileSync(process.argv[4], "utf8")) as { params: V2Params }).params;
const fit = fitV2Params(world, train, start, {
  samples,
  passes,
  availability_table: table,
  // prior_season_weight cannot be tuned on 2023 (the excerpt has no 2022): it stays at its default
  tuning: DEFAULT_TUNING.filter((t) => t.path !== "prior_season_weight"),
});
console.log(
  JSON.stringify(
    {
      cases: train.length,
      availability_table: table,
      availability_counts: counts,
      ...fit,
      ms: Math.round(performance.now() - t0),
    },
    null,
    1,
  ),
);
