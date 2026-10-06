// stats-player-week.ts — `nflverse:stats_player_week` (plan 08 §3.2: the Phase-1 stat source; plan 10
// §3.1a): `stats_player/stats_player_week_{season}.parquet` → `ds_stats_player_week` (identity +
// PLAYER_WEEK_STAT_COLUMNS verbatim) and `ds_team_defense_week` aggregated from the same accepted
// rows (tables.ts DS_TEAM_DEFENSE_WEEK). Rows without a player_id (4 team-level rows in 2026) are not
// stored as players (dropped, counted), but their team-defence credits are aggregated — one carries
// BUF's week-2 safety (TeamDefenseAggregator.addTeamRow). Ported from sibling @521f9f3, adapted.
import { DS_STATS_PLAYER_WEEK, DS_TEAM_DEFENSE_WEEK } from "../../store/datasets/tables.js";
import type { DataSource } from "../source.js";
import { eachRow, inFileSeason, makeNflverseSource } from "./base.js";
import { TableLoader, asInt, buildRow } from "./rows.js";
import { TeamDefenseAggregator, hasDefenseCredit } from "./team-defense.js";

/** The weekly player stats DataSource. */
export const statsPlayerWeekSource: DataSource = makeNflverseSource({
  id: "nflverse:stats_player_week",
  tag: "stats_player",
  file: (season) => `stats_player_week_${String(season)}.parquet`,
  seasonGate: "in_season",
  async publish(files, into) {
    const players = new TableLoader(into, DS_STATS_PLAYER_WEEK);
    const defense = new TableLoader(into, DS_TEAM_DEFENSE_WEEK);
    const agg = new TeamDefenseAggregator();
    let teamCredits = 0;
    await eachRow("nflverse:stats_player_week", files, (raw, file) => {
      if (!inFileSeason(players, asInt(raw.season), file)) return;
      const row = buildRow(DS_STATS_PLAYER_WEEK, raw);
      if (players.add(row)) {
        // add() accepted it, so season, week and team are non-null
        agg.add(row.season as number, row.week as number, row.team as string, raw);
        return;
      }
      const season = row.season;
      const week = row.week;
      const team = row.team;
      if (
        row.player_id === null &&
        typeof season === "number" &&
        typeof week === "number" &&
        typeof team === "string"
      ) {
        agg.addTeamRow(season, week, team, raw);
        if (hasDefenseCredit(raw)) teamCredits++;
      }
    });
    for (const row of agg.rows()) defense.add(row);
    const warnings: string[] = [];
    if (agg.conflictCount > 0) {
      warnings.push(
        `ds_team_defense_week: ${String(agg.conflictCount)} team-week(s) named more than one game, opponent or season type`,
      );
    }
    if (teamCredits > 0) {
      warnings.push(
        `ds_team_defense_week: ${String(teamCredits)} team-level row(s) without a player_id credited to their team`,
      );
    }
    return { loaders: [players, defense], warnings };
  },
});
