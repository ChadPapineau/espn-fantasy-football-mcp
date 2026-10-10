// index.ts — the redistribution prior table's public surface (plan 10 §3.3 "the redistribution
// prior table from pbp history", C6; plan 07 E7 cascade v2). E7 takes `CASCADE_PRIORS` as its
// request's `priors`; the builders (usage → absences → table) and the C6 evaluation are pure and
// exported for the backtest and a future human-run re-fit. New here.
export { DEFAULT_ABSENCE_RULES, findAbsences } from "./absences.js";
export {
  EVAL_RECEPTION_POINTS,
  beneficiaryShare,
  cascadeMateOf,
  crossValidateCascade,
  evaluateCascade,
  opportunityMix,
  pairedHits,
  poolEvaluations,
  predictedOpportunity,
  predictions,
  realisedOpportunity,
} from "./evaluate.js";
export {
  BASE_STARTERS,
  DEPTH_NEXT_POSITIONS,
  cellFor,
  contextKey,
  contextOf,
  isInjuredPosition,
  isSkillPosition,
  mainComponent,
  priorSplit,
  rolesOf,
  type PriorSplit,
  type RoleInput,
  type RoleRule,
  type SplitMate,
} from "./predict.js";
export { CASCADE_PRIORS } from "./shipped.js";
export {
  TABLE_PARAMETERS,
  buildPriorTable,
  chooseShrink,
  heldOutError,
  type BuildOptions,
} from "./table.js";
export * from "./types.js";
export {
  KEPT_PLAY_TYPES,
  RED_ZONE_YARDLINE,
  isCarry,
  isRedZone,
  isTarget,
  usageFromPlays,
  usagePosition,
  type DepthListing,
  type PbpPlay,
} from "./usage.js";
