// observed-columns.ts — what the real nflverse release files held when the dataset contract was
// grounded (2026-10-06, read with hyparquet 1.31.2; the files were downloaded to a temp dir outside
// the repo and never committed). The contract's required upstream columns must be a subset of these
// columns (plan 01 §5.5) and every codec must be an allowed one (plan 01 D9; ADV OBJ-19(d)).
// Generated from the files; edit only by re-grounding against a new release.

/** One observed release file. */
export interface ObservedFile {
  readonly url: string;
  /** The GitHub release asset's `updated_at`. */
  readonly updated_at: string;
  readonly bytes: number;
  readonly rows: number;
  readonly codecs: readonly string[];
  readonly columns: readonly string[];
}

export const OBSERVED_PARQUET: Readonly<Record<string, ObservedFile>> = {
  "nflverse:schedules": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.parquet",
    updated_at: "2026-10-06T05:46:38Z",
    bytes: 521703,
    rows: 7548,
    codecs: ["SNAPPY"],
    // prettier-ignore
    columns: ["game_id","season","game_type","week","gameday","weekday","gametime","away_team","away_score","home_team","home_score","location","result","total","overtime","old_game_id","gsis","nfl_detail_id","pfr","pff","espn","ftn","away_rest","home_rest","away_moneyline","home_moneyline","spread_line","away_spread_odds","home_spread_odds","total_line","under_odds","over_odds","div_game","roof","surface","temp","wind","away_qb_id","home_qb_id","away_qb_name","home_qb_name","away_coach","home_coach","referee","stadium_id","stadium"],
  },
  "nflverse:injuries": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.parquet",
    updated_at: "2026-10-06T06:02:04Z",
    bytes: 34788,
    rows: 1052,
    codecs: ["SNAPPY"],
    // prettier-ignore
    columns: ["season","season_type","game_type","team","week","gsis_id","position","full_name","first_name","last_name","report_primary_injury","report_secondary_injury","report_status","practice_primary_injury","practice_secondary_injury","practice_status"],
  },
  "nflverse:roster_weekly": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2026.parquet",
    updated_at: "2026-10-06T06:02:49Z",
    bytes: 744949,
    rows: 10612,
    codecs: ["SNAPPY"],
    // prettier-ignore
    columns: ["season","team","position","depth_chart_position","jersey_number","status","full_name","first_name","last_name","birth_date","height","weight","college","gsis_id","espn_id","sportradar_id","yahoo_id","rotowire_id","pff_id","pfr_id","fantasy_data_id","sleeper_id","years_exp","headshot_url","ngs_position","week","game_type","status_description_abbr","football_name","esb_id","gsis_it_id","smart_id","entry_year","rookie_year","draft_club","draft_number"],
  },
  "nflverse:players": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/players/players.parquet",
    updated_at: "2026-10-05T16:51:40Z",
    bytes: 3390504,
    rows: 24844,
    codecs: ["SNAPPY"],
    // prettier-ignore
    columns: ["gsis_id","display_name","common_first_name","first_name","last_name","short_name","football_name","suffix","esb_id","nfl_id","pfr_id","pff_id","otc_id","espn_id","smart_id","birth_date","position_group","position","ngs_position_group","ngs_position","height","weight","headshot","college_name","college_conference","jersey_number","rookie_season","last_season","latest_team","status","ngs_status","ngs_status_short_description","years_of_experience","pff_position","pff_status","draft_year","draft_round","draft_pick","draft_team"],
  },
  "nflverse:stats_player_week": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.parquet",
    updated_at: "2026-10-06T04:34:47Z",
    bytes: 306484,
    rows: 4449,
    codecs: ["SNAPPY"],
    // prettier-ignore
    columns: ["player_id","player_name","player_display_name","position","position_group","headshot_url","season","week","season_type","game_id","team","opponent_team","completions","attempts","passing_yards","passing_tds","passing_interceptions","sacks_suffered","sack_yards_lost","sack_fumbles","sack_fumbles_lost","passing_air_yards","passing_yards_after_catch","passing_first_downs","passing_epa","passing_cpoe","passing_2pt_conversions","pacr","passing_10","passing_16","passing_20","passing_40","carries","rushing_yards","rushing_tds","rushing_fumbles","rushing_fumbles_lost","rushing_first_downs","rushing_epa","rushing_2pt_conversions","rushing_10","rushing_12","rushing_20","rushing_40","receptions","targets","receiving_yards","receiving_tds","receiving_fumbles","receiving_fumbles_lost","receiving_air_yards","receiving_yards_after_catch","receiving_first_downs","receiving_epa","receiving_2pt_conversions","receiving_10","receiving_16","receiving_20","receiving_40","racr","target_share","air_yards_share","wopr","special_teams_tds","def_tackles_solo","def_tackles_with_assist","def_tackle_assists","def_tackles_for_loss","def_tackles_for_loss_yards","def_fumbles_forced","def_sacks","def_sack_yards","def_qb_hits","def_interceptions","def_interception_yards","def_pass_defended","def_tds","def_fumbles","def_safeties","def_punt_blocks","def_pat_blocks","def_fg_blocks","def_2pt_atts","def_2pt_made","misc_yards","fumble_recovery_own","fumble_recovery_yards_own","fumble_recovery_opp","fumble_recovery_yards_opp","fumble_recovery_tds","penalties","penalty_yards","fumbles_forced_by_opp","fumbles_not_forced","fumbles_out_of_bounds","fumbles_total","fumbles_lost_total","punt_returns","punt_return_yards","kickoff_returns","kickoff_return_yards","fg_made","fg_att","fg_missed","fg_blocked","fg_long","fg_pct","fg_made_0_19","fg_made_20_29","fg_made_30_39","fg_made_40_49","fg_made_50_59","fg_made_60_","fg_missed_0_19","fg_missed_20_29","fg_missed_30_39","fg_missed_40_49","fg_missed_50_59","fg_missed_60_","fg_made_list","fg_missed_list","fg_blocked_list","fg_made_distance","fg_missed_distance","fg_blocked_distance","pat_made","pat_att","pat_missed","pat_blocked","pat_pct","gwfg_made","gwfg_att","gwfg_missed","gwfg_blocked","gwfg_distance","pt_att","pt_blocked","pt_long","pt_yards","pt_inside_20","pt_out_of_bounds","pt_downed","pt_touchback","pt_fair_caught","pt_returned","pt_return_yards","pt_return_tds","pt_net_yards","fantasy_points","fantasy_points_ppr"],
  },
};
