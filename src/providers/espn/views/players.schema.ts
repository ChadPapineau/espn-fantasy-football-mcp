// players.schema.ts — `kona_player_info`, `kona_playercard`, `players_wl`, `proTeamSchedules_wl`,
// `mPositionalRatings` (research 03 §A.2, §A.3, §B.5; plan 07 C1–C2, B2, D3; plan 01 §7). The season
// index is a root JSON ARRAY; the pro schedule's games sit under `proGamesByScoringPeriod{week}`.
import { z } from "zod/v4";
import { int, optBool, optInt, optNum, playerSchema, poolEntrySchema } from "./common.schema.js";

/** `positionAgainstOpponent.positionalRatings{posId: {average, ratingsByOpponent{proTeamId}}}`. */
export const positionalRatingsSchema = z.looseObject({
  positionalRatings: z.record(
    z.string(),
    z.looseObject({
      average: optNum,
      ratingsByOpponent: z
        .record(z.string(), z.looseObject({ average: optNum, rank: optNum }))
        .nullish(),
    }),
  ),
});

/** `kona_player_info`: a pool page (or a filterIds set) and the embedded ratings. */
export const konaPlayerInfoSchema = z.looseObject({
  players: z.array(poolEntrySchema),
  positionAgainstOpponent: positionalRatingsSchema.nullish(),
});
export type WireKonaBody = z.infer<typeof konaPlayerInfoSchema>;

/** `kona_playercard`: the same entries with weekly actual splits embedded. */
export const konaPlayercardSchema = z.looseObject({ players: z.array(poolEntrySchema) });
export type WirePlayercardBody = z.infer<typeof konaPlayercardSchema>;

/** `players_wl`: the season player index, a root array (research 03 §A.2 P23). */
export const playersWlSchema = z.array(playerSchema).min(1);
export type WirePlayersWlBody = z.infer<typeof playersWlSchema>;

/** One NFL game (research 04 §B.1.6: `validForLocking`, `statsOfficial`). */
export const proGameSchema = z.looseObject({
  id: int,
  scoringPeriodId: int,
  homeProTeamId: int,
  awayProTeamId: int,
  date: optNum,
  startTimeTBD: optBool,
  statsOfficial: optBool,
  validForLocking: optBool,
});

/** `proTeamSchedules_wl` (season route, keyless). */
export const proTeamSchedulesSchema = z.looseObject({
  settings: z.looseObject({
    proTeams: z.array(
      z.looseObject({
        id: int,
        abbrev: z.string(),
        byeWeek: optInt,
        proGamesByScoringPeriod: z.record(z.string(), z.array(proGameSchema)).nullish(),
      }),
    ),
  }),
});
export type WireProScheduleBody = z.infer<typeof proTeamSchedulesSchema>;

/** `mPositionalRatings` (+scoringPeriodId). */
export const mPositionalRatingsSchema = z.looseObject({
  positionAgainstOpponent: positionalRatingsSchema,
});
export type WirePositionalRatingsBody = z.infer<typeof mPositionalRatingsSchema>;
