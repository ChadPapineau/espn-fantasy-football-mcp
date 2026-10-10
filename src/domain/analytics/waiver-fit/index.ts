// index.ts — the waiver DP fitted to a league's own history (plan 10 §3.3 C5; plan 07 E5
// `premium_basis: "league_fitted"`; research 05 §1.6 evals 2–3): the surplus distribution and drift
// c from the league's feed, the re-solved premium and its band, the fitted-vs-cold comparison, and
// the P(clears_to_FA) calibration with its demand-scale fit. Pure. New here (Phase 3).
export {
  calibrateClearsToFa,
  clearProbability,
  fitDemandScale,
  type ClearsCalibration,
  type ClearsObservation,
  type ClearsOutcome,
  type DemandScaleFit,
  type ReliabilityBin,
} from "./calibration.js";
export { WAIVER_FIT } from "./constants.js";
export {
  driftFromAcquisitions,
  driftFromClaimRuns,
  fitDrift,
  type DriftEvidence,
  type DriftFit,
  type DriftObservation,
} from "./drift.js";
export { fitPremiumFromFeed, weekOfFromTransactions } from "./feed.js";
export {
  RESEARCH_W_COLUMNS,
  comparePremium,
  fitLeaguePremium,
  type LeaguePremiumFit,
  type PremiumCell,
} from "./fit.js";
export {
  fitSurplusDistribution,
  surplusObservationsFromRuns,
  surplusRate,
  type SurplusFit,
  type SurplusObservation,
} from "./surplus.js";
