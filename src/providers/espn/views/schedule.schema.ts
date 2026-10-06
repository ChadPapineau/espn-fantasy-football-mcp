// schedule.schema.ts — `mRoster`, `mMatchup`, `mMatchupScore`, `mBoxscore`, `mScoreboard` (research 03
// §A.2, §B.3, §B.4, §B.7; plan 07 A3–A5, B1; plan 01 §7). A bye is `home` without `away`. The live
// fields (`totalPointsLive`, `winProbability`) exist on the CURRENT period's rows only — optional.
// `mMatchupScore` roster entries are slim (slot + stats, no player id): read for totals only.
import { z } from "zod/v4";
import {
  int,
  leagueEnvelope,
  num,
  optInt,
  optNum,
  optStr,
  playerSchema,
  rosterEntrySchema,
  statusSchema,
} from "./common.schema.js";

/** `mRoster`: every team's roster for the requested scoring period (requested alone). */
export const mRosterSchema = z.looseObject({
  ...leagueEnvelope,
  status: statusSchema,
  teams: z.array(
    z.looseObject({
      id: int,
      roster: z.looseObject({ entries: z.array(rosterEntrySchema), appliedStatTotal: optNum }),
    }),
  ),
});
export type WireRosterBody = z.infer<typeof mRosterSchema>;

const pointsByPeriod = z.record(z.string(), num).nullish();

/** One side of a season-schedule row (mMatchup). */
export const matchupSideSchema = z.looseObject({
  teamId: int,
  totalPoints: optNum,
  pointsByScoringPeriod: pointsByPeriod,
});

/** `mMatchup`: the whole season's schedule and results. */
export const mMatchupSchema = z.looseObject({
  ...leagueEnvelope,
  schedule: z.array(
    z.looseObject({
      id: int,
      matchupPeriodId: int,
      home: matchupSideSchema,
      away: matchupSideSchema.nullish(),
      winner: optStr,
      playoffTierType: optStr,
    }),
  ),
});
export type WireMatchupBody = z.infer<typeof mMatchupSchema>;

/** One side of an `mMatchupScore` row: live fields only on the current period. */
export const liveSideSchema = z.looseObject({
  teamId: int,
  totalPoints: optNum,
  totalPointsLive: optNum,
  totalProjectedPoints: optNum,
  totalProjectedPointsLive: optNum,
  winProbability: optNum,
  pointsByScoringPeriod: pointsByPeriod,
});

/** `mMatchupScore`: `playoffTierType` on every row (the seed path). */
export const mMatchupScoreSchema = z.looseObject({
  ...leagueEnvelope,
  schedule: z.array(
    z.looseObject({
      id: int,
      matchupPeriodId: int,
      playoffTierType: z.string(),
      home: liveSideSchema,
      away: liveSideSchema.nullish(),
      winner: optStr,
    }),
  ),
});
export type WireMatchupScoreBody = z.infer<typeof mMatchupScoreSchema>;

/** One box-score roster entry: the player with its `stats[]` (appliedStats — the golden's input). */
export const boxEntrySchema = z.looseObject({
  playerId: int,
  lineupSlotId: int,
  playerPoolEntry: z.looseObject({ player: playerSchema, appliedStatTotal: optNum }),
});

/** One side of a box score: `rosterForCurrentScoringPeriod` required (the seed path). */
export const boxSideSchema = z.looseObject({
  teamId: int,
  totalPoints: optNum,
  rosterForCurrentScoringPeriod: z.looseObject({
    entries: z.array(boxEntrySchema),
    appliedStatTotal: optNum,
  }),
});

/** `mBoxscore` (+ slim `teams[]` with names, `settings`). */
export const mBoxscoreSchema = z.looseObject({
  ...leagueEnvelope,
  schedule: z.array(
    z.looseObject({
      id: int,
      matchupPeriodId: int,
      home: boxSideSchema,
      away: boxSideSchema.nullish(),
    }),
  ),
  teams: z
    .array(
      z.looseObject({ id: int, name: optStr, abbrev: optStr, location: optStr, nickname: optStr }),
    )
    .nullish(),
  status: statusSchema.nullish(),
});
export type WireBoxscoreBody = z.infer<typeof mBoxscoreSchema>;

/** `mScoreboard` (no P0 tool reads it; the seed path only). */
export const mScoreboardSchema = z.looseObject({
  schedule: z.array(z.looseObject({ home: z.looseObject({ totalPoints: num }), id: optInt })),
});
