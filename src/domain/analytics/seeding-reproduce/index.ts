// index.ts — the seeding reproduction (plan 10 §3.3 C4; research 05 §2.4 "Evaluation", §8.4 #5):
// reproduce a finished season's `playoffSeed` exactly with the simulator's own tiebreak chain under
// both readings, and say why when neither does. Pure. New here (Phase 3).
export {
  C4_MIN_SEASONS,
  RECORDS_TOLERANCE,
  isExplained,
  reproduceSeason,
  reproductionInputFrom,
  summarizeReproductions,
} from "./reproduce.js";
export {
  REPRODUCTION_FINDINGS,
  type ReadingReproduction,
  type ReproduceMatchup,
  type ReproducePlayoff,
  type ReproduceSide,
  type ReproduceTeam,
  type ReproductionFinding,
  type ReproductionFindingCode,
  type ReproductionSummary,
  type SeasonReproduction,
  type SeasonReproductionInput,
  type SeedMismatch,
} from "./types.js";
