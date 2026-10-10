// index.ts — the `v2-opportunity` projection model's public surface (plan 07 E1 → model_version
// "v2-opportunity", basis "player_sim"; plan 10 §3.3 C1; sibling research 05 §1; research 05 §3.2).
// E1 calls `projectV2`; the backtest harness, the fit and the re-fit proposal serve plan 10 C1, B14
// and C9 (`eff tune` applies a proposal — a human does, never this module). Pure. New here.
export {
  brierActive,
  fitAvailability,
  normalizeDesignation,
  normalizePractice,
  pActiveV2,
} from "./availability.js";
export type { AvailabilityOutcome } from "./availability.js";
export {
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
} from "./backtest.js";
export type {
  BacktestCase,
  BacktestOptions,
  BacktestPlayer,
  BacktestRecord,
  BacktestReport,
  BacktestWorld,
  ExternalDrops,
  ExternalRow,
  Forecast,
  ModelScore,
  ScoredGame,
  SeasonSummary,
} from "./backtest.js";
export {
  BACKTEST_V2,
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
  MODEL_VERSION_V2,
  P_ACTIVE_V2,
  PROJECTION_SOURCE_V2,
  SHADOW_WEIGHTS,
  V2_POSITION_IDS,
  V2_POSITIONS,
  V2_SIMS,
  WEIGHT_ESPN_V2,
} from "./constants.js";
export { activePoints, anchorExpectation, scaleVolume } from "./ensemble.js";
export type { Anchor } from "./ensemble.js";
export { expectV2, isV2Position } from "./expectation.js";
export type { ExpectationContext, ExpectationResult, ExpectationSkip } from "./expectation.js";
export {
  DEFAULT_TUNING,
  diffParams,
  fitV2Params,
  objective,
  paramAt,
  proposeV2Refit,
  withParam,
} from "./fit.js";
export type { FitOptions, FitProposal, FitStep, ParamChange, TunableParam } from "./fit.js";
export { buildMatchupTable, espnRatingOf, matchupMult } from "./matchup.js";
export type { MatchupRow } from "./matchup.js";
export { applyTunedOverrides, TUNED_NAME_TO_V2_PATH } from "./overrides.js";
export type { TunedApplication } from "./overrides.js";
export { covered, crpsGamma, crpsSample, crpsSorted, pinball, spearmanWithin } from "./metrics.js";
export { ensembleMean, pinDist, projectV2, v2SampleCount } from "./project.js";
export { buildV2Priors, shrinkRate } from "./rates.js";
export {
  expectedCounts,
  expectedLine,
  lineAt,
  linesOf,
  SAMPLE_WIDTH,
  simDist,
  simPoints,
  simulateInto,
  simulateLine,
  simulateLines,
  zeroLine,
} from "./simulate.js";
export { teamVolume } from "./team.js";
export type { TeamVolume } from "./team.js";
export { eventPoints, turnoverRates, turnoverTail } from "./turnover.js";
export type { TurnoverRates } from "./turnover.js";
export type * from "./types.js";
export { weatherEffect } from "./weather.js";
export { detectChangePoint, indexTeamGames, playerWindow, teamGameKey } from "./window.js";
export type { ChangePoint, PlayerWindow, WindowGame } from "./window.js";
