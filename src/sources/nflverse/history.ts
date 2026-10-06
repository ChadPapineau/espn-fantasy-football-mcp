// history.ts — the history twins of the nflverse sources (plan 10 §3.2 "two prior nflverse seasons
// for the soft backtests" [A-3]; tables.ts HISTORY_DATASET_SOURCES: one `<source>_history` dataset
// file per dataset holding both prior seasons, so a current-season refresh never rewrites them).
// The Phase-2 twins come with their sources (phase2.ts `makePhase2Sources`); the two Phase-1 twins —
// weekly player stats (+ the derived team-defence lines) and injuries — reuse the Phase-1 loaders
// unchanged (`phase1HistorySource`). Every twin is versioned by month + seasons (phase2.ts
// `historyVersion`) and needs no network to know it is current.
import { depthChartsSources } from "./depth-charts.js";
import { injuriesSource } from "./injuries.js";
import { pbpSources } from "./pbp.js";
import { phase1HistorySource, type HistoryDataSource } from "./phase2.js";
import { snapCountsSources } from "./snap-counts.js";
import { statsPlayerWeekSource } from "./stats-player-week.js";
import { statsTeamWeekSources } from "./stats-team-week.js";

/** `nflverse:stats_player_week_history` (ds_stats_player_week + ds_team_defense_week, prior seasons). */
export const statsPlayerWeekHistorySource: HistoryDataSource = phase1HistorySource(
  "nflverse:stats_player_week_history",
  statsPlayerWeekSource,
);

/** `nflverse:injuries_history` (ds_injuries, prior seasons; the 2024 file has no season_type). */
export const injuriesHistorySource: HistoryDataSource = phase1HistorySource(
  "nflverse:injuries_history",
  injuriesSource,
);

/** The nflverse history ids (tables.ts HISTORY_DATASET_SOURCES minus ffopportunity's). */
export type NflverseHistoryId =
  | "nflverse:stats_player_week_history"
  | "nflverse:stats_team_week_history"
  | "nflverse:pbp_history"
  | "nflverse:snap_counts_history"
  | "nflverse:injuries_history"
  | "nflverse:depth_charts_history";

/** Every nflverse history DataSource, by id (ffopportunity's twin: src/sources/ffopportunity/). */
export const NFLVERSE_HISTORY_SOURCES: Readonly<Record<NflverseHistoryId, HistoryDataSource>> =
  Object.freeze({
    "nflverse:stats_player_week_history": statsPlayerWeekHistorySource,
    "nflverse:stats_team_week_history": statsTeamWeekSources.history,
    "nflverse:pbp_history": pbpSources.history,
    "nflverse:snap_counts_history": snapCountsSources.history,
    "nflverse:injuries_history": injuriesHistorySource,
    "nflverse:depth_charts_history": depthChartsSources.history,
  });
