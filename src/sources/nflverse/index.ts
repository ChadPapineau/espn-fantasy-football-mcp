// index.ts — the nflverse DataSources (plan 10 §3.1a: schedules, injuries, roster_weekly,
// stats_player_week; plus the crosswalk's players fallback, research 04 §C step 2) and the pure pieces
// other modules call (plan 08 §3.2 toStatLine(nflverse); the release timestamp parser). Phase 2
// (plan 10 §3.2), additive: stats_team_week, the pbp subset, snap_counts, depth_charts and the
// history twins of every dataset the backtests read (NFLVERSE_PHASE_2_SOURCES,
// NFLVERSE_HISTORY_SOURCES; ffopportunity's are in src/sources/ffopportunity/). Phase 3 (plan 10 §3.3
// "≥ 3 historical seasons"), additive: the historical season selection (seasons.ts) — every history
// file and the schedules file hold the backtest seasons [current − 3, current − 1].
import type { DataSource } from "../source.js";
import { injuriesSource } from "./injuries.js";
import { playersSource } from "./players.js";
import { rosterWeeklySource } from "./roster-weekly.js";
import { schedulesSource } from "./schedules.js";
import type { NflverseSourceId } from "./schemas.js";
import { statsPlayerWeekSource } from "./stats-player-week.js";
import { depthChartsSource } from "./depth-charts.js";
import { pbpSource } from "./pbp.js";
import { snapCountsSource } from "./snap-counts.js";
import { statsTeamWeekSource } from "./stats-team-week.js";

export { injuriesSource } from "./injuries.js";
export { playersSource } from "./players.js";
export { rosterWeeklySource } from "./roster-weekly.js";
export { gameLines, schedulesSource, type GameLinesView } from "./schedules.js";
export { statsPlayerWeekSource } from "./stats-player-week.js";
export {
  DEPTH_DUPLICATE_SLOT,
  DEPTH_INVALID,
  DEPTH_NAME_MAX,
  DEPTH_OTHER_LABEL,
  LEGACY_DUPLICATE,
  LEGACY_NO_WEEK,
  depthChartsSource,
  depthChartsSources,
  depthSnapshotOf,
  legacyDepthRowOf,
  type LegacyDepthRow,
} from "./depth-charts.js";
export {
  NFLVERSE_HISTORY_SOURCES,
  injuriesHistorySource,
  statsPlayerWeekHistorySource,
  type NflverseHistoryId,
} from "./history.js";
export { PBP_NOT_KEPT, pbpSource, pbpSources } from "./pbp.js";
export {
  PHASE_2_HISTORY_TWIN,
  PHASE_2_PARQUET_CURRENT,
  expectedColumnsFor,
  historyBucket,
  historyFileSeasons,
  historyRefreshSeasons,
  historyRunSeasons,
  historyVersion,
  makePhase2Sources,
  phase1HistorySource,
  rowBuilder,
  tableOf,
  type HistoryDataSource,
  type Phase2ParquetId,
  type Phase2SourceDef,
  type Phase2SourcePair,
  type PublishTarget,
  type ReleaseRef,
} from "./phase2.js";
export { backtestSeasons, withBacktestContext, withBacktestSeasons } from "./seasons.js";
export { snapCountsSource, snapCountsSources } from "./snap-counts.js";
export { statsTeamWeekSource, statsTeamWeekSources } from "./stats-team-week.js";
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
  NFLVERSE_PHASE_2_TAGS,
  NFLVERSE_RELEASE_BASE,
  NflverseSourceError,
  PBP_MAX_FILE_BYTES,
  parseNflverseTimestamp,
  releaseAssetUrl,
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

/** The Phase-2 nflverse sources with a contract (plan 10 §3.2), by id. */
export type NflversePhase2Id =
  "nflverse:stats_team_week" | "nflverse:pbp" | "nflverse:snap_counts" | "nflverse:depth_charts";

/**
 * Every Phase-2 nflverse DataSource, by id (jobs, plan 06 §1.3: `nflverse:stats` → stats_team_week +
 * pbp; `nflverse:snaps` → snap_counts; `nflverse:daily` → depth_charts — each source's `job` field).
 */
export const NFLVERSE_PHASE_2_SOURCES: Readonly<Record<NflversePhase2Id, DataSource>> =
  Object.freeze({
    "nflverse:stats_team_week": statsTeamWeekSource,
    "nflverse:pbp": pbpSource,
    "nflverse:snap_counts": snapCountsSource,
    "nflverse:depth_charts": depthChartsSource,
  });
