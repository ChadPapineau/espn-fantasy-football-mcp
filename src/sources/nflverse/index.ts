// index.ts — the nflverse DataSources (plan 10 §3.1a: schedules, injuries, roster_weekly,
// stats_player_week; plus the crosswalk's players fallback, research 04 §C step 2) and the pure pieces
// other modules call (plan 08 §3.2 toStatLine(nflverse); the release timestamp parser).
import type { DataSource } from "../source.js";
import { injuriesSource } from "./injuries.js";
import { playersSource } from "./players.js";
import { rosterWeeklySource } from "./roster-weekly.js";
import { schedulesSource } from "./schedules.js";
import type { NflverseSourceId } from "./schemas.js";
import { statsPlayerWeekSource } from "./stats-player-week.js";

export { injuriesSource } from "./injuries.js";
export { playersSource } from "./players.js";
export { rosterWeeklySource } from "./roster-weekly.js";
export { gameLines, schedulesSource, type GameLinesView } from "./schedules.js";
export { statsPlayerWeekSource } from "./stats-player-week.js";
export { defensiveFumbleReturnTds } from "./team-defense.js";
export type { NflversePublishStats, NflverseSchemaReport } from "./base.js";
export {
  DST_POSITION,
  ESPN_FG_BUCKETS,
  NFLVERSE_STAT_MAP,
  espnPositionOf,
  kickDistances,
  pointsAllowedFor,
  toDefenseStatLine,
  toStatLine,
  translatePlayerWeek,
  type DefenseOptions,
  type StatMapping,
  type TranslateOptions,
  type Translation,
  type TranslationIssue,
} from "./columns.js";
export {
  NFLVERSE_RELEASE_BASE,
  NflverseSourceError,
  parseNflverseTimestamp,
  type NflverseFailure,
} from "./release.js";
export {
  EXPECTED_COLUMNS,
  NFLVERSE_SOURCE_IDS,
  isNflverseSourceId,
  type ColumnKind,
  type NflverseSourceId,
} from "./schemas.js";

/** Every nflverse DataSource, by id (the runner's registry for `eff refresh nflverse:*`). */
export const NFLVERSE_SOURCES: Readonly<Record<NflverseSourceId, DataSource>> = Object.freeze({
  "nflverse:schedules": schedulesSource,
  "nflverse:injuries": injuriesSource,
  "nflverse:roster_weekly": rosterWeeklySource,
  "nflverse:stats_player_week": statsPlayerWeekSource,
  "nflverse:players": playersSource,
});
