// stats-team-week.ts — `nflverse:stats_team_week` and its history twin (plan 10 §3.2 sources; plan 06
// §1.3 `refresh nflverse:stats`; tables.ts DS_STATS_TEAM_WEEK): `stats_team/stats_team_week_{season}
// .parquet` (138 columns, one row per team-game, observed 2026-10-06) → `ds_stats_team_week`, the
// ids plus TEAM_WEEK_STAT_COLUMNS verbatim (92 kept). A row without a team is dropped and counted
// (the contract's row filter); a row of another season than its file's is dropped and counted.
import { DS_STATS_TEAM_WEEK } from "../../store/datasets/tables.js";
import { NFLVERSE_RELEASE_BASE } from "./release.js";
import {
  eachContractRow,
  makePhase2Sources,
  rowBuilder,
  rowInFileSeason,
  tableOf,
  type Phase2SourcePair,
} from "./phase2.js";
import { TableLoader, asInt } from "./rows.js";

const build = rowBuilder(DS_STATS_TEAM_WEEK);

/** `nflverse:stats_team_week` + `nflverse:stats_team_week_history`. */
export const statsTeamWeekSources: Phase2SourcePair = makePhase2Sources({
  id: "nflverse:stats_team_week",
  release: { base: NFLVERSE_RELEASE_BASE, tag: "stats_team", label: "nflverse stats_team" },
  file: (season) => `stats_team_week_${String(season)}.parquet`,
  seasonGate: "in_season",
  async publish(files, into, target) {
    const teams = new TableLoader(into, tableOf(target, DS_STATS_TEAM_WEEK.name));
    await eachContractRow(target, files, (raw, file) => {
      if (rowInFileSeason(teams, asInt(raw.season), file)) teams.add(build(raw));
    });
    return { loaders: [teams], warnings: [] };
  },
});

/** The weekly team stats DataSource. */
export const statsTeamWeekSource = statsTeamWeekSources.current;
