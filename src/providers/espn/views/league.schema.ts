// league.schema.ts — `mSettings`, `mNav`, `mTeam`, `mStandings` (research 03 §A.2, §B.1, §B.3, §B.6;
// plan 01 §7). Required: the REQUIRED_PATHS_BY_VIEW seed (src/drift/types.ts) plus what the league,
// rules, slots, scoring and standings normalisers read. `mNav` returns a SUBSET of settings (research
// 03 §B.1) — its schema never demands the full settings.
import { z } from "zod/v4";
import {
  int,
  leagueEnvelope,
  looseMap,
  num,
  optBool,
  optInt,
  optNum,
  optStr,
  statusSchema,
} from "./common.schema.js";

/** One `scoringItems[]` entry (research 03 §B.1): `pointsOverrides` keyed by POSITION id. */
export const scoringItemSchema = z.looseObject({
  statId: int,
  points: num,
  pointsOverrides: z.record(z.string(), num).nullish(),
  isReverseItem: optBool,
});

export const scoringSettingsSchema = z.looseObject({
  scoringType: z.string(),
  scoringItems: z.array(scoringItemSchema),
  matchupTieRule: optStr,
  playoffMatchupTieRule: optStr,
  homeTeamBonus: optNum,
  playoffHomeTeamBonus: optNum,
});

export const rosterSettingsSchema = z.looseObject({
  lineupSlotCounts: z.record(z.string(), num),
  positionLimits: z.record(z.string(), num).nullish(),
  lineupLocktimeType: optStr,
  isUsingUndroppableList: optBool,
  moveLimit: optNum,
});

export const acquisitionSettingsSchema = z.looseObject({
  acquisitionType: optStr,
  isUsingAcquisitionBudget: optBool,
  acquisitionBudget: optNum,
  minimumBid: optNum,
  waiverHours: optNum,
  waiverProcessDays: z.array(z.string()).nullish(),
  waiverProcessHour: optNum,
  waiverOrderReset: optBool,
  acquisitionLimit: optNum,
  matchupAcquisitionLimit: optNum,
  matchupLimitPerScoringPeriod: optBool,
});

export const scheduleSettingsSchema = z.looseObject({
  matchupPeriods: z.record(z.string(), z.array(int)).nullish(),
  matchupPeriodCount: optInt,
  matchupPeriodLength: optInt,
  playoffTeamCount: optInt,
  playoffSeedingRule: optStr,
  playoffSeedingRuleBy: optNum,
  playoffReseed: optBool,
  playoffMatchupPeriodLength: optInt,
  variablePlayoffMatchupPeriodLength: optBool,
  consolationLadderDisabled: optBool,
  divisions: z.array(z.looseObject({ id: int, name: optStr, size: optInt })).nullish(),
});

export const tradeSettingsSchema = z.looseObject({
  deadlineDate: optNum,
  revisionHours: optNum,
  vetoVotesRequired: optNum,
  max: optNum,
});

/** `mSettings`: the full settings object (the four seed paths are required). */
export const mSettingsSchema = z.looseObject({
  ...leagueEnvelope,
  status: statusSchema,
  settings: z.looseObject({
    name: z.string(),
    size: int,
    isPublic: optBool,
    scoringSettings: scoringSettingsSchema,
    rosterSettings: rosterSettingsSchema,
    acquisitionSettings: acquisitionSettingsSchema,
    scheduleSettings: scheduleSettingsSchema,
    tradeSettings: tradeSettingsSchema.nullish(),
    financeSettings: looseMap.nullish(),
  }),
});
export type WireSettingsBody = z.infer<typeof mSettingsSchema>;

/** `members[]` as `mNav` sends it: the id (owner matching) and the two commissioner flags. */
export const navMemberSchema = z.looseObject({
  id: z.string(),
  isLeagueCreator: z.boolean(),
  isLeagueManager: optBool,
});

/** A team's identity (mNav; the skeleton's slim team plus name). */
export const navTeamSchema = z.looseObject({
  id: int,
  owners: z.array(z.string()),
  abbrev: optStr,
  name: optStr,
  location: optStr,
  nickname: optStr,
});

/** `mNav`: members with the creator flag (the one key mNav adds), team identities. */
export const mNavSchema = z.looseObject({
  members: z.array(navMemberSchema),
  teams: z.array(navTeamSchema),
});
export type WireNavBody = z.infer<typeof mNavSchema>;

/** One `record.*` split (research 03 §B.3). */
export const recordSplitSchema = z.looseObject({
  wins: num,
  losses: num,
  ties: num,
  percentage: optNum,
  pointsFor: optNum,
  pointsAgainst: optNum,
  gamesBack: optNum,
  streakLength: optNum,
  streakType: optStr,
});

export const recordSchema = z.looseObject({ overall: recordSplitSchema });

/** `teams[]` with the mTeam/mStandings fields the standings normaliser reads. */
export const standingTeamSchema = z.looseObject({
  id: int,
  record: recordSchema,
  transactionCounter: z.looseObject({
    acquisitions: num,
    drops: num,
    trades: num,
    moveToIR: optNum,
    moveToActive: optNum,
    acquisitionBudgetSpent: optNum,
    matchupAcquisitionTotals: z.record(z.string(), num).nullish(),
  }),
  waiverRank: num,
  name: optStr,
  abbrev: optStr,
  location: optStr,
  nickname: optStr,
  divisionId: optInt,
  owners: z.array(z.string()).nullish(),
  playoffSeed: optNum,
  rankCalculatedFinal: optNum,
  currentProjectedRank: optNum,
  playoffClinchType: optStr,
  eliminated: optBool,
  isTransactionLocked: optBool,
  currentSimulationResults: z.looseObject({ playoffPct: optNum }).nullish(),
  /**
   * Member-authored (research 03 §B.5): `{}` when empty; the note, when set, at `note` (the fx-10h
   * `inj-tradeblock` shape, research 05 §6 case 4). Any shape is accepted — the normaliser reads a
   * string `note` or nothing (plan 01 §4.4: wrapped, source `espn.team.trade_block`, cap 500).
   */
  tradeBlock: z.unknown().optional(),
});

/** `mTeam` (composed with `mStandings` in one request — plan 01 §5.6). */
export const mTeamSchema = z.looseObject({
  ...leagueEnvelope,
  status: statusSchema,
  teams: z.array(standingTeamSchema),
});
export type WireTeamBody = z.infer<typeof mTeamSchema>;

/** `mStandings`: records on `teams[]` (not separable from mTeam — research 03 §A.2). */
export const mStandingsSchema = z.looseObject({
  teams: z.array(z.looseObject({ id: int, record: recordSchema })),
});
