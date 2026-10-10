// index.ts — the start/sit and win-probability calibration surface (plan 10 C2, C3): the held-out
// replay of one team-week (replay.ts), regret comparisons and the "did it matter" share (regret.ts),
// P(win) reliability per decile (reliability.ts), the auto-default switch rule and its committed
// record (objectiveSwitch.ts), and the comparison with ESPN's winProbability / playoffPct
// (espn.ts). E2 imports objectiveSwitch.ts directly (never this barrel — replay.ts imports E2).
export { START_SIT_RULES, type StartSitH2h, type StartSitRow, type StartSitRule } from "./types.js";
export { replayStartSit, type StartSitTeamWeek } from "./replay.js";
export {
  beatsInEverySeason,
  compareRegret,
  didItMatter,
  noWorseInEverySeason,
  regretOf,
  type DidItMatter,
  type RegretComparison,
  type RegretComparisonReport,
} from "./regret.js";
export {
  CALIBRATION,
  nToResolve,
  normalQuantile,
  reliabilityByDecile,
  wilsonInterval,
  type BinVerdict,
  type CalibrationStatus,
  type ReliabilityBin,
  type ReliabilityReport,
} from "./reliability.js";
export {
  OBJECTIVE_SWITCH_RECORD,
  SWITCH_RULE,
  autoObjectiveForPlayerSim,
  decideObjectiveSwitch,
  switchEvidenceOf,
  type ObjectiveSwitchDecision,
  type ObjectiveSwitchEvidence,
  type ObjectiveSwitchRecord,
  type ObjectiveSwitchSeason,
  type ObjectiveSwitchStatus,
} from "./objectiveSwitch.js";
export {
  attachEspn,
  compareWithEspn,
  espnNumbersOf,
  preWeekSnapshot,
  type ComparatorRow,
  type ComparatorStatus,
  type EspnComparison,
  type EspnSnapshotNumbers,
  type PeriodBrier,
} from "./espn.js";
