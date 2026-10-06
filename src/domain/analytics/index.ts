// index.ts — the P0 analytics engines' public surface (plan 07 E1 projections v1-ensemble, E2 lineup,
// E3 the seeding simulator (domain code; the tool is P1), E5 waiver priority + the K/D-ST slice,
// E12/E13 hooks) and their shared kernels; the contract types live in ./types.ts.
export type * from "./types.js";
export {
  ANALYTICS_RESULT_CHARS,
  CLEARS_TO_FA_MIN_COLD_WIDTH,
  COARSE_BAND_CUTOFFS,
  COIN_FLIP_DPWIN,
  DISAGREEMENT_FLAG_PCT,
  EVIDENCE_POSTERIOR_MIN_N,
  GAME_DAY_WINDOW_MS,
  PF_PER_WIN_COLD_START,
  PREMIUM_BAND_MULTIPLIERS,
  WEIGHT_ESPN_V1,
  isCoinFlip,
  isValidClearsToFa,
  seedingStatus,
  toCoarseDelta,
} from "./types.js";
export * from "./constants.js";
export { AnalyticsError, ensure, type AnalyticsErrorCode } from "./errors.js";
export { collectInputs, mergeInputs, newestAsOf, type AnyStamp } from "./inputs.js";
export {
  loopPacer,
  runCooperative,
  type CooperativeOptions,
  type CooperativeResult,
  type Pacer,
} from "./cooperative.js";
export { FORBIDDEN, solveAssignment } from "./assignment.js";
export {
  diffSd,
  lineupCov,
  lineupMoments,
  pairMoments,
  pWinInterval,
  pWinNormal,
  rho,
  type PairMoments,
  type TotalMember,
} from "./totals.js";
export {
  pActiveOf,
  positionCv,
  projectPlayers,
  targetOf,
  type ImpliedTotal,
  type ProjectedPlayer,
  type ProjectedWeek,
  type ProjectionHorizonArg,
  type ProjectionOutcome,
  type ProjectionRequest,
  type ProjectionTarget,
  type TrailingLine,
} from "./projection.js";
export {
  analyzeLineup,
  bestLineup,
  compareWarnings,
  bestLineupMean,
  fastLineupValue,
  lineupPlayerOf,
  pfContextOf,
  seatPlan,
  type FastPlayer,
  type LineupPlayer,
  type LineupRequest,
  type LineupSeasonContext,
  type StandingRow,
} from "./lineup.js";
export {
  bracketOrder,
  simulateSeason,
  tiebreakChain,
  type PlayedGame,
  type PlayoffRound,
  type ScheduledGame,
  type SeasonSimOutcome,
  type SeasonSimRequest,
  type SeasonTeam,
  type TieLevel,
} from "./seeding.js";
export {
  demandOf,
  premiumBand,
  priorityPremium,
  solvePremiumTable,
  type PremiumTable,
  type WaiverDpParams,
} from "./waiverDp.js";
export {
  analyzeWaivers,
  roleHolds,
  weeklyValues,
  type WaiverCandidateInput,
  type WaiverOutcome,
  type WaiverPlayer,
  type WaiverRequest,
  type WaiverRival,
} from "./waivers.js";
export {
  dstExpectation,
  isKdst,
  kdstExpectation,
  kickerExpectation,
  type KdstExpectation,
  type KdstPosition,
} from "./kdst.js";
export {
  SHIPPED_WEIGHT_ESPN,
  espnBaselineInformative,
  espnComparatorDist,
  lineupAlternatives,
  pActiveForecastsOf,
  playerForecastOf,
  pPlayoffsForecastOf,
  pWinForecastOf,
  waiverAlternatives,
} from "./rec.js";
export {
  clamp,
  distFromSamples,
  gammaCdf,
  gammaDist,
  gammaDraw,
  gammaMultiplier,
  gammaQuantile,
  meanOf,
  normalCdf,
  normalDist,
  normalDraw,
  normalPdf,
  poissonDraw,
  quantileSorted,
  ranks,
  round,
  sigmaOf,
  spearman,
  zeroDist,
} from "./math.js";
