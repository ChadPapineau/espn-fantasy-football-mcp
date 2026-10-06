// phase2.ts — the public surface of the Phase-2 market engines (plan 10 §3.2; plan 07 E5 P1 usage
// signals + `faab` mode + the fitted demand model, E6 trade, E7 injury cascade, E10 evidence, E11
// league activity, E1's `player_sim` hook). A separate barrel so ./index.ts (the P0 surface) changes
// only by one re-export line; the contract types stay in ./types.ts.
export * from "./marketConstants.js";
export {
  detectSignals,
  hasNumericEvidence,
  usageWeekOf,
  type SignalInput,
  type UsageWeek,
} from "./usageSignals.js";
export {
  brier,
  claimRuns,
  demandCovariates,
  demandObservations,
  fitDemand,
  fittedQ,
  learnKickoffWaivers,
  learnWaiverMechanics,
  type ClaimRun,
  type DemandFeatures,
  type DemandFit,
  type DemandObservation,
  type LearnedMechanics,
  type RunClaim,
  type WaiverOrder,
} from "./demand.js";
export {
  faabBid,
  lambdaOf,
  pricePerPoint,
  pWinAt,
  type FaabBid,
  type FaabInput,
  type FaabRival,
  type PricePerPoint,
  type WinningBid,
} from "./faab.js";
export {
  analyzeWaiversP1,
  waiverActionText,
  type FaabContextInput,
  type RivalRoster,
  type WaiverP1Request,
} from "./waiversP1.js";
export {
  analyzeTrade,
  availability,
  positionGaps,
  weakestPosition,
  type DepthPlayer,
  type TradeOutcome,
  type TradePlayer,
  type TradeRequest,
  type TradeTeam,
} from "./trade.js";
export {
  analyzeInjuryCascade,
  expectedWeeks,
  redistribute,
  stillOut,
  type CascadeClaimInput,
  type CascadeInjured,
  type CascadeOutcome,
  type CascadeRequest,
  type CascadeTeammate,
  type Shares,
} from "./cascade.js";
export {
  analyzeEvidence,
  extractClaim,
  isEvidenceSource,
  type EvidenceOutcome,
  type EvidencePlayer,
  type EvidenceRequest,
  type EvidenceText,
} from "./evidence.js";
export {
  analyzeLeagueActivity,
  type ActivityOutcome,
  type ActivityRequest,
  type ActivityTeam,
} from "./leagueActivity.js";
export {
  hasOpportunityInputs,
  playerSimDist,
  type OpportunityInputs,
  type PlayerSimResult,
} from "./playerSim.js";
