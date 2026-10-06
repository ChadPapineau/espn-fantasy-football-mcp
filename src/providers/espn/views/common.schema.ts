// common.schema.ts — the shared ESPN wire entities (research 03 §B.2–§B.6; plan 01 §7; research 03
// §F.2 "one zod schema per view and per shared entity"): `status`, `stats[]`, `player`,
// `playerPoolEntry`, roster `entries[]`, ownership. Every object is LOOSE (unknown keys pass through
// — additive drift is counted by src/drift, never a failure); REQUIRED keys are only those a tool
// reads, and a missing one hard-fails naming the JSON path (never a silent default). Free text is
// typed `z.string()` here — it is wire; the normaliser wraps it.
import { z } from "zod/v4";

export const int = z.number().int();
export const num = z.number();
/** A value ESPN may omit or null — read as null by the normaliser. */
export const optNum = z.number().nullish();
export const optInt = z.number().int().nullish();
export const optStr = z.string().nullish();
export const optBool = z.boolean().nullish();
/** A numeric-keyed map whose values are read leniently (non-numbers are dropped by the normaliser). */
export const looseMap = z.record(z.string(), z.unknown());

/** `status` (research 03 §A.4): the league clock. */
export const statusSchema = z.looseObject({
  currentMatchupPeriod: int,
  latestScoringPeriod: int,
  isActive: z.boolean(),
  finalScoringPeriod: int,
  firstScoringPeriod: int,
  transactionScoringPeriod: optInt,
  isExpired: optBool,
  previousSeasons: z.array(int).nullish(),
  waiverLastExecutionDate: optNum,
  waiverNextExecutionDate: optNum,
  standingsUpdateDate: optNum,
  isPlayoffMatchupEdited: optBool,
  isWaiverOrderEdited: optBool,
});
export type WireStatus = z.infer<typeof statusSchema>;

/**
 * One `stats[]` entry (research 03 §B.2, §B.5). The four split keys are required — an entry whose
 * `(statSourceId, statSplitTypeId)` is unknown fails at the normaliser, not here (plan 01 §7).
 */
export const statEntrySchema = z.looseObject({
  seasonId: int,
  scoringPeriodId: int,
  statSourceId: int,
  statSplitTypeId: int,
  id: optStr,
  externalId: optStr,
  proTeamId: optInt,
  appliedTotal: optNum,
  appliedStats: looseMap.nullish(),
  stats: looseMap.nullish(),
});
export type WireStatEntry = z.infer<typeof statEntrySchema>;

/** `player.ownership` (plan 07 B1; research 03 §B.3). */
export const ownershipSchema = z.looseObject({
  percentOwned: optNum,
  percentStarted: optNum,
  percentChange: optNum,
  averageDraftPosition: optNum,
  auctionValueAverage: optNum,
  date: optNum,
});

/** `player` — on league views, in kona views and as the season index row (players_wl). */
export const playerSchema = z.looseObject({
  id: int,
  fullName: z.string(),
  defaultPositionId: int,
  eligibleSlots: z.array(int),
  proTeamId: int,
  firstName: optStr,
  lastName: optStr,
  injuryStatus: optStr,
  injured: optBool,
  active: optBool,
  droppable: optBool,
  jersey: optStr,
  ownership: ownershipSchema.nullish(),
  seasonOutlook: optStr,
  outlooks: z.looseObject({ outlooksByWeek: looseMap.nullish() }).nullish(),
  lastNewsDate: optNum,
  draftRanksByRankType: looseMap.nullish(),
  rankings: looseMap.nullish(),
  stats: z.array(statEntrySchema).nullish(),
});
export type WirePlayer = z.infer<typeof playerSchema>;

/** `playerPoolEntry` (roster entries) and `players[]` (kona views). */
export const poolEntrySchema = z.looseObject({
  id: int,
  player: playerSchema,
  onTeamId: optInt,
  status: optStr,
  lineupLocked: optBool,
  rosterLocked: optBool,
  tradeLocked: optBool,
  waiverProcessDate: optNum,
  appliedStatTotal: optNum,
});
export type WirePoolEntry = z.infer<typeof poolEntrySchema>;

/** One roster `entries[]` row (mRoster; research 03 §B.3). */
export const rosterEntrySchema = z.looseObject({
  playerId: int,
  lineupSlotId: int,
  playerPoolEntry: poolEntrySchema,
  acquisitionDate: optNum,
  acquisitionType: optStr,
  injuryStatus: optStr,
  status: optStr,
  pendingTransactionIds: z.array(z.unknown()).nullish(),
});
export type WireRosterEntry = z.infer<typeof rosterEntrySchema>;

/** The skeleton's league envelope keys every league view carries. */
export const leagueEnvelope = {
  id: int,
  seasonId: int,
  scoringPeriodId: int,
} as const;
