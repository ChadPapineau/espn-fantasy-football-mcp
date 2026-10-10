// observed-history.ts — what the real 2023 release files held when the third backtest season was
// grounded (2026-10-10, read with hyparquet 1.31.2; downloaded to a temp dir outside the repo and
// never committed) and what the seven history twins published over the real 2023–2025 files (plan 10
// §3.3 "≥ 3 historical seasons" [A-3], D9; docs/evals/phase3-data.md). The 2024 and 2025 files are
// byte-identical to Phase 2's grounding (tests/store/datasets/observed-phase2.ts, same sha256).
// Generated from the files; edit only by re-grounding against a new release. Keys are
// `<current-season source>@<season>`.

/** One observed 2023 release file, with the content hash of the bytes read. */
export interface ObservedHistoryFile {
  readonly url: string;
  readonly bytes: number;
  readonly rows: number;
  readonly row_groups: number;
  readonly codecs: readonly string[];
  readonly sha256: string;
  readonly created_by: string | null;
  /** nflverse's own `nflverse_timestamp` key-value stamp (absent on some files). */
  readonly nflverse_timestamp: string | null;
  readonly columns: readonly string[];
  /** Each column's parquet physical type (`/LOGICAL` when annotated), aligned with `columns`. */
  readonly types: readonly string[];
}

/** The 2023 files (the 2024/2025 ones: OBSERVED_PHASE2). */
export const OBSERVED_HISTORY_2023: Readonly<Record<string, ObservedHistoryFile>> = {
  "nflverse:stats_player_week@2023": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2023.parquet",
    bytes: 846050,
    rows: 18643,
    row_groups: 1,
    codecs: ["SNAPPY"],
    sha256: "ac776fbd7c9fefdb4069b72304f4c5fa05ae417acd49f6e4e27be14b9d7a4bbc",
    created_by: "parquet-cpp-arrow version 25.0.0",
    nflverse_timestamp: "2026-08-13 12:48:30 EDT",
    // prettier-ignore
    columns: ["player_id","player_name","player_display_name","position","position_group","headshot_url","season","week","season_type","game_id","team","opponent_team","completions","attempts","passing_yards","passing_tds","passing_interceptions","sacks_suffered","sack_yards_lost","sack_fumbles","sack_fumbles_lost","passing_air_yards","passing_yards_after_catch","passing_first_downs","passing_epa","passing_cpoe","passing_2pt_conversions","pacr","passing_10","passing_16","passing_20","passing_40","carries","rushing_yards","rushing_tds","rushing_fumbles","rushing_fumbles_lost","rushing_first_downs","rushing_epa","rushing_2pt_conversions","rushing_10","rushing_12","rushing_20","rushing_40","receptions","targets","receiving_yards","receiving_tds","receiving_fumbles","receiving_fumbles_lost","receiving_air_yards","receiving_yards_after_catch","receiving_first_downs","receiving_epa","receiving_2pt_conversions","receiving_10","receiving_16","receiving_20","receiving_40","racr","target_share","air_yards_share","wopr","special_teams_tds","def_tackles_solo","def_tackles_with_assist","def_tackle_assists","def_tackles_for_loss","def_tackles_for_loss_yards","def_fumbles_forced","def_sacks","def_sack_yards","def_qb_hits","def_interceptions","def_interception_yards","def_pass_defended","def_tds","def_fumbles","def_safeties","def_punt_blocks","def_pat_blocks","def_fg_blocks","def_2pt_atts","def_2pt_made","misc_yards","fumble_recovery_own","fumble_recovery_yards_own","fumble_recovery_opp","fumble_recovery_yards_opp","fumble_recovery_tds","penalties","penalty_yards","fumbles_forced_by_opp","fumbles_not_forced","fumbles_out_of_bounds","fumbles_total","fumbles_lost_total","punt_returns","punt_return_yards","kickoff_returns","kickoff_return_yards","fg_made","fg_att","fg_missed","fg_blocked","fg_long","fg_pct","fg_made_0_19","fg_made_20_29","fg_made_30_39","fg_made_40_49","fg_made_50_59","fg_made_60_","fg_missed_0_19","fg_missed_20_29","fg_missed_30_39","fg_missed_40_49","fg_missed_50_59","fg_missed_60_","fg_made_list","fg_missed_list","fg_blocked_list","fg_made_distance","fg_missed_distance","fg_blocked_distance","pat_made","pat_att","pat_missed","pat_blocked","pat_pct","gwfg_made","gwfg_att","gwfg_missed","gwfg_blocked","gwfg_distance","pt_att","pt_blocked","pt_long","pt_yards","pt_inside_20","pt_out_of_bounds","pt_downed","pt_touchback","pt_fair_caught","pt_returned","pt_return_yards","pt_return_tds","pt_net_yards","fantasy_points","fantasy_points_ppr"],
    // prettier-ignore
    types: ["BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","DOUBLE","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","DOUBLE","DOUBLE","DOUBLE","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","DOUBLE"],
  },
  "nflverse:stats_team_week@2023": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2023.parquet",
    bytes: 128136,
    rows: 570,
    row_groups: 1,
    codecs: ["SNAPPY"],
    sha256: "a155e2a9cb2a6bff1b254f747a33603c43aa5a1117c26d203b44e5bfb83339b1",
    created_by: "parquet-cpp-arrow version 25.0.0",
    nflverse_timestamp: "2026-08-13 12:48:37 EDT",
    // prettier-ignore
    columns: ["season","week","team","season_type","game_id","opponent_team","completions","attempts","passing_yards","passing_tds","passing_interceptions","sacks_suffered","sack_yards_lost","sack_fumbles","sack_fumbles_lost","passing_air_yards","passing_yards_after_catch","passing_first_downs","passing_epa","passing_cpoe","passing_2pt_conversions","passing_10","passing_16","passing_20","passing_40","carries","rushing_yards","rushing_tds","rushing_fumbles","rushing_fumbles_lost","rushing_first_downs","rushing_epa","rushing_2pt_conversions","rushing_10","rushing_12","rushing_20","rushing_40","receptions","targets","receiving_yards","receiving_tds","receiving_fumbles","receiving_fumbles_lost","receiving_air_yards","receiving_yards_after_catch","receiving_first_downs","receiving_epa","receiving_2pt_conversions","receiving_10","receiving_16","receiving_20","receiving_40","special_teams_tds","def_tackles_solo","def_tackles_with_assist","def_tackle_assists","def_tackles_for_loss","def_tackles_for_loss_yards","def_fumbles_forced","def_sacks","def_sack_yards","def_qb_hits","def_interceptions","def_interception_yards","def_pass_defended","def_tds","def_fumbles","def_safeties","def_punt_blocks","def_pat_blocks","def_fg_blocks","def_2pt_atts","def_2pt_made","misc_yards","fumble_recovery_own","fumble_recovery_yards_own","fumble_recovery_opp","fumble_recovery_yards_opp","fumble_recovery_tds","penalties","penalty_yards","timeouts","fumbles_forced_by_opp","fumbles_not_forced","fumbles_out_of_bounds","fumbles_total","fumbles_lost_total","punt_returns","punt_return_yards","kickoff_returns","kickoff_return_yards","fg_made","fg_att","fg_missed","fg_blocked","fg_long","fg_pct","fg_made_0_19","fg_made_20_29","fg_made_30_39","fg_made_40_49","fg_made_50_59","fg_made_60_","fg_missed_0_19","fg_missed_20_29","fg_missed_30_39","fg_missed_40_49","fg_missed_50_59","fg_missed_60_","fg_made_list","fg_missed_list","fg_blocked_list","fg_made_distance","fg_missed_distance","fg_blocked_distance","pat_made","pat_att","pat_missed","pat_blocked","pat_pct","gwfg_made","gwfg_att","gwfg_missed","gwfg_blocked","gwfg_distance","pt_att","pt_blocked","pt_long","pt_yards","pt_inside_20","pt_out_of_bounds","pt_downed","pt_touchback","pt_fair_caught","pt_returned","pt_return_yards","pt_return_tds","pt_net_yards"],
    // prettier-ignore
    types: ["INT32","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","INT32","INT32","INT32","INT32","INT32","INT32","DOUBLE","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32","INT32"],
  },
  "nflverse:pbp@2023": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2023.parquet",
    bytes: 20534088,
    rows: 49665,
    row_groups: 1,
    codecs: ["SNAPPY"],
    sha256: "bd3484731408def6b0ec93225bba2bd7b2c65769ca707a2b9444d891abdc6776",
    created_by: "parquet-cpp-arrow version 23.0.0",
    nflverse_timestamp: "2026-02-12 05:24:17 EST",
    // prettier-ignore
    columns: ["play_id","game_id","old_game_id","home_team","away_team","season_type","week","posteam","posteam_type","defteam","side_of_field","yardline_100","game_date","quarter_seconds_remaining","half_seconds_remaining","game_seconds_remaining","game_half","quarter_end","drive","sp","qtr","down","goal_to_go","time","yrdln","ydstogo","ydsnet","desc","play_type","yards_gained","shotgun","no_huddle","qb_dropback","qb_kneel","qb_spike","qb_scramble","pass_length","pass_location","air_yards","yards_after_catch","run_location","run_gap","field_goal_result","kick_distance","extra_point_result","two_point_conv_result","home_timeouts_remaining","away_timeouts_remaining","timeout","timeout_team","td_team","td_player_name","td_player_id","posteam_timeouts_remaining","defteam_timeouts_remaining","total_home_score","total_away_score","posteam_score","defteam_score","score_differential","posteam_score_post","defteam_score_post","score_differential_post","no_score_prob","opp_fg_prob","opp_safety_prob","opp_td_prob","fg_prob","safety_prob","td_prob","extra_point_prob","two_point_conversion_prob","ep","epa","total_home_epa","total_away_epa","total_home_rush_epa","total_away_rush_epa","total_home_pass_epa","total_away_pass_epa","air_epa","yac_epa","comp_air_epa","comp_yac_epa","total_home_comp_air_epa","total_away_comp_air_epa","total_home_comp_yac_epa","total_away_comp_yac_epa","total_home_raw_air_epa","total_away_raw_air_epa","total_home_raw_yac_epa","total_away_raw_yac_epa","wp","def_wp","home_wp","away_wp","wpa","vegas_wpa","vegas_home_wpa","home_wp_post","away_wp_post","vegas_wp","vegas_home_wp","total_home_rush_wpa","total_away_rush_wpa","total_home_pass_wpa","total_away_pass_wpa","air_wpa","yac_wpa","comp_air_wpa","comp_yac_wpa","total_home_comp_air_wpa","total_away_comp_air_wpa","total_home_comp_yac_wpa","total_away_comp_yac_wpa","total_home_raw_air_wpa","total_away_raw_air_wpa","total_home_raw_yac_wpa","total_away_raw_yac_wpa","punt_blocked","first_down_rush","first_down_pass","first_down_penalty","third_down_converted","third_down_failed","fourth_down_converted","fourth_down_failed","incomplete_pass","touchback","interception","punt_inside_twenty","punt_in_endzone","punt_out_of_bounds","punt_downed","punt_fair_catch","kickoff_inside_twenty","kickoff_in_endzone","kickoff_out_of_bounds","kickoff_downed","kickoff_fair_catch","fumble_forced","fumble_not_forced","fumble_out_of_bounds","solo_tackle","safety","penalty","tackled_for_loss","fumble_lost","own_kickoff_recovery","own_kickoff_recovery_td","qb_hit","rush_attempt","pass_attempt","sack","touchdown","pass_touchdown","rush_touchdown","return_touchdown","extra_point_attempt","two_point_attempt","field_goal_attempt","kickoff_attempt","punt_attempt","fumble","complete_pass","assist_tackle","lateral_reception","lateral_rush","lateral_return","lateral_recovery","passer_player_id","passer_player_name","passing_yards","receiver_player_id","receiver_player_name","receiving_yards","rusher_player_id","rusher_player_name","rushing_yards","lateral_receiver_player_id","lateral_receiver_player_name","lateral_receiving_yards","lateral_rusher_player_id","lateral_rusher_player_name","lateral_rushing_yards","lateral_sack_player_id","lateral_sack_player_name","interception_player_id","interception_player_name","lateral_interception_player_id","lateral_interception_player_name","punt_returner_player_id","punt_returner_player_name","lateral_punt_returner_player_id","lateral_punt_returner_player_name","kickoff_returner_player_name","kickoff_returner_player_id","lateral_kickoff_returner_player_id","lateral_kickoff_returner_player_name","punter_player_id","punter_player_name","kicker_player_name","kicker_player_id","own_kickoff_recovery_player_id","own_kickoff_recovery_player_name","blocked_player_id","blocked_player_name","tackle_for_loss_1_player_id","tackle_for_loss_1_player_name","tackle_for_loss_2_player_id","tackle_for_loss_2_player_name","qb_hit_1_player_id","qb_hit_1_player_name","qb_hit_2_player_id","qb_hit_2_player_name","forced_fumble_player_1_team","forced_fumble_player_1_player_id","forced_fumble_player_1_player_name","forced_fumble_player_2_team","forced_fumble_player_2_player_id","forced_fumble_player_2_player_name","solo_tackle_1_team","solo_tackle_2_team","solo_tackle_1_player_id","solo_tackle_2_player_id","solo_tackle_1_player_name","solo_tackle_2_player_name","assist_tackle_1_player_id","assist_tackle_1_player_name","assist_tackle_1_team","assist_tackle_2_player_id","assist_tackle_2_player_name","assist_tackle_2_team","assist_tackle_3_player_id","assist_tackle_3_player_name","assist_tackle_3_team","assist_tackle_4_player_id","assist_tackle_4_player_name","assist_tackle_4_team","tackle_with_assist","tackle_with_assist_1_player_id","tackle_with_assist_1_player_name","tackle_with_assist_1_team","tackle_with_assist_2_player_id","tackle_with_assist_2_player_name","tackle_with_assist_2_team","pass_defense_1_player_id","pass_defense_1_player_name","pass_defense_2_player_id","pass_defense_2_player_name","fumbled_1_team","fumbled_1_player_id","fumbled_1_player_name","fumbled_2_player_id","fumbled_2_player_name","fumbled_2_team","fumble_recovery_1_team","fumble_recovery_1_yards","fumble_recovery_1_player_id","fumble_recovery_1_player_name","fumble_recovery_2_team","fumble_recovery_2_yards","fumble_recovery_2_player_id","fumble_recovery_2_player_name","sack_player_id","sack_player_name","half_sack_1_player_id","half_sack_1_player_name","half_sack_2_player_id","half_sack_2_player_name","return_team","return_yards","penalty_team","penalty_player_id","penalty_player_name","penalty_yards","replay_or_challenge","replay_or_challenge_result","penalty_type","defensive_two_point_attempt","defensive_two_point_conv","defensive_extra_point_attempt","defensive_extra_point_conv","safety_player_name","safety_player_id","season","cp","cpoe","series","series_success","series_result","order_sequence","start_time","time_of_day","stadium","weather","nfl_api_id","play_clock","play_deleted","play_type_nfl","special_teams_play","st_play_type","end_clock_time","end_yard_line","fixed_drive","fixed_drive_result","drive_real_start_time","drive_play_count","drive_time_of_possession","drive_first_downs","drive_inside20","drive_ended_with_score","drive_quarter_start","drive_quarter_end","drive_yards_penalized","drive_start_transition","drive_end_transition","drive_game_clock_start","drive_game_clock_end","drive_start_yard_line","drive_end_yard_line","drive_play_id_started","drive_play_id_ended","away_score","home_score","location","result","total","spread_line","total_line","div_game","roof","surface","temp","wind","home_coach","away_coach","stadium_id","game_stadium","aborted_play","success","passer","passer_jersey_number","rusher","rusher_jersey_number","receiver","receiver_jersey_number","pass","rush","first_down","special","play","passer_id","rusher_id","receiver_id","name","jersey_number","id","fantasy_player_name","fantasy_player_id","fantasy","fantasy_id","out_of_bounds","home_opening_kickoff","qb_epa","xyac_epa","xyac_mean_yardage","xyac_median_yardage","xyac_success","xyac_fd","xpass","pass_oe"],
    // prettier-ignore
    types: ["DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","DOUBLE","DOUBLE","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","INT32","INT32","BYTE_ARRAY/STRING","INT32","INT32","DOUBLE","DOUBLE","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","INT32","BYTE_ARRAY/STRING","INT32","BYTE_ARRAY/STRING","INT32","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","INT32","DOUBLE","DOUBLE","DOUBLE","DOUBLE"],
  },
  "nflverse:snap_counts@2023": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2023.parquet",
    bytes: 237882,
    rows: 26540,
    row_groups: 1,
    codecs: ["SNAPPY"],
    sha256: "97873cab365dfb39286bc1de3ac772fa4b51f09cce52ae5f8317e006cc007f62",
    created_by: "parquet-cpp-arrow version 21.0.0",
    nflverse_timestamp: null,
    // prettier-ignore
    columns: ["game_id","pfr_game_id","season","game_type","week","player","pfr_player_id","position","team","opponent","offense_snaps","offense_pct","defense_snaps","defense_pct","st_snaps","st_pct"],
    // prettier-ignore
    types: ["BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","BYTE_ARRAY/STRING","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE"],
  },
  "nflverse:depth_charts@2023": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2023.parquet",
    bytes: 485941,
    rows: 37327,
    row_groups: 1,
    codecs: ["SNAPPY"],
    sha256: "44dbf02554d4a8a783f52d53b3c66ede8cc9886097518c56c7e1069f5e2d18ff",
    created_by: "parquet-cpp-arrow version 12.0.1",
    nflverse_timestamp: null,
    // prettier-ignore
    columns: ["season","club_code","week","game_type","depth_team","last_name","first_name","football_name","formation","gsis_id","jersey_number","position","elias_id","depth_position","full_name"],
    // prettier-ignore
    types: ["INT32","BYTE_ARRAY/STRING","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING"],
  },
  "nflverse:injuries@2023": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2023.parquet",
    bytes: 126566,
    rows: 5599,
    row_groups: 1,
    codecs: ["SNAPPY"],
    sha256: "5d8d881aabd613c3172231b33ac0b4397b3f383498f5e4509c31f3c77c3402a3",
    created_by: "parquet-cpp-arrow version 17.0.0",
    nflverse_timestamp: null,
    // prettier-ignore
    columns: ["season","game_type","team","week","gsis_id","position","full_name","first_name","last_name","report_primary_injury","report_secondary_injury","report_status","practice_primary_injury","practice_secondary_injury","practice_status","date_modified"],
    // prettier-ignore
    types: ["INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT32","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","INT64/TIMESTAMP"],
  },
  "ffopportunity:ep_weekly@2023": {
    url: "https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_2023.parquet",
    bytes: 1152618,
    rows: 6081,
    row_groups: 1,
    codecs: ["SNAPPY"],
    sha256: "40523f0b2c009ba2f9765f309d23b97878ac6ecfaedd540daf3ab8a696e307ca",
    created_by: "parquet-cpp-arrow version 17.0.0",
    nflverse_timestamp: null,
    // prettier-ignore
    columns: ["season","posteam","week","game_id","player_id","full_name","position","pass_attempt","rec_attempt","rush_attempt","pass_air_yards","rec_air_yards","pass_completions","receptions","pass_completions_exp","receptions_exp","pass_yards_gained","rec_yards_gained","rush_yards_gained","pass_yards_gained_exp","rec_yards_gained_exp","rush_yards_gained_exp","pass_touchdown","rec_touchdown","rush_touchdown","pass_touchdown_exp","rec_touchdown_exp","rush_touchdown_exp","pass_two_point_conv","rec_two_point_conv","rush_two_point_conv","pass_two_point_conv_exp","rec_two_point_conv_exp","rush_two_point_conv_exp","pass_first_down","rec_first_down","rush_first_down","pass_first_down_exp","rec_first_down_exp","rush_first_down_exp","pass_interception","rec_interception","pass_interception_exp","rec_interception_exp","rec_fumble_lost","rush_fumble_lost","pass_fantasy_points_exp","rec_fantasy_points_exp","rush_fantasy_points_exp","pass_fantasy_points","rec_fantasy_points","rush_fantasy_points","total_yards_gained","total_yards_gained_exp","total_touchdown","total_touchdown_exp","total_first_down","total_first_down_exp","total_fantasy_points","total_fantasy_points_exp","pass_completions_diff","receptions_diff","pass_yards_gained_diff","rec_yards_gained_diff","rush_yards_gained_diff","pass_touchdown_diff","rec_touchdown_diff","rush_touchdown_diff","pass_two_point_conv_diff","rec_two_point_conv_diff","rush_two_point_conv_diff","pass_first_down_diff","rec_first_down_diff","rush_first_down_diff","pass_interception_diff","rec_interception_diff","pass_fantasy_points_diff","rec_fantasy_points_diff","rush_fantasy_points_diff","total_yards_gained_diff","total_touchdown_diff","total_first_down_diff","total_fantasy_points_diff","pass_attempt_team","rec_attempt_team","rush_attempt_team","pass_air_yards_team","rec_air_yards_team","pass_completions_team","receptions_team","pass_completions_exp_team","receptions_exp_team","pass_yards_gained_team","rec_yards_gained_team","rush_yards_gained_team","pass_yards_gained_exp_team","rec_yards_gained_exp_team","rush_yards_gained_exp_team","pass_touchdown_team","rec_touchdown_team","rush_touchdown_team","pass_touchdown_exp_team","rec_touchdown_exp_team","rush_touchdown_exp_team","pass_two_point_conv_team","rec_two_point_conv_team","rush_two_point_conv_team","pass_two_point_conv_exp_team","rec_two_point_conv_exp_team","rush_two_point_conv_exp_team","pass_first_down_team","rec_first_down_team","rush_first_down_team","pass_first_down_exp_team","rec_first_down_exp_team","rush_first_down_exp_team","pass_interception_team","rec_interception_team","pass_interception_exp_team","rec_interception_exp_team","rec_fumble_lost_team","rush_fumble_lost_team","pass_fantasy_points_exp_team","rec_fantasy_points_exp_team","rush_fantasy_points_exp_team","pass_fantasy_points_team","rec_fantasy_points_team","rush_fantasy_points_team","pass_completions_diff_team","receptions_diff_team","pass_yards_gained_diff_team","rec_yards_gained_diff_team","rush_yards_gained_diff_team","pass_touchdown_diff_team","rec_touchdown_diff_team","rush_touchdown_diff_team","pass_two_point_conv_diff_team","rec_two_point_conv_diff_team","rush_two_point_conv_diff_team","pass_first_down_diff_team","rec_first_down_diff_team","rush_first_down_diff_team","pass_interception_diff_team","rec_interception_diff_team","pass_fantasy_points_diff_team","rec_fantasy_points_diff_team","rush_fantasy_points_diff_team","total_yards_gained_team","total_yards_gained_exp_team","total_yards_gained_diff_team","total_touchdown_team","total_touchdown_exp_team","total_touchdown_diff_team","total_first_down_team","total_first_down_exp_team","total_first_down_diff_team","total_fantasy_points_team","total_fantasy_points_exp_team","total_fantasy_points_diff_team"],
    // prettier-ignore
    types: ["BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","BYTE_ARRAY/STRING","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE","DOUBLE"],
  },
};

/** What a history twin published over the real 2023, 2024 and 2025 files (one run, CLI default seasons). */
export interface ObservedHistoryPublish {
  readonly tables: Readonly<Record<string, number>>;
  /** The publish warnings, verbatim (counts only, never upstream text). */
  readonly warnings: readonly string[];
  /** Upstream rows per season file. */
  readonly upstream_rows: Readonly<Record<string, number>>;
}

/** Per history twin, over the real files (2026-10-10). */
export const OBSERVED_HISTORY_PUBLISH: Readonly<Record<string, ObservedHistoryPublish>> = {
  "nflverse:stats_player_week_history": {
    tables: { ds_stats_player_week: 56982, ds_team_defense_week: 1710 },
    warnings: [
      "ds_stats_player_week: dropped 66 row(s) — null player_id",
      "ds_team_defense_week: 17 team-level row(s) without a player_id credited to their team",
    ],
    upstream_rows: { 2023: 18643, 2024: 18983, 2025: 19422 },
  },
  "nflverse:stats_team_week_history": {
    tables: { ds_stats_team_week: 1710 },
    warnings: [],
    upstream_rows: { 2023: 570, 2024: 570, 2025: 570 },
  },
  "nflverse:pbp_history": {
    tables: { ds_pbp: 129371 },
    warnings: [
      "ds_pbp: dropped 18557 row(s) — play_type not in PBP_KEPT_PLAY_TYPES (markers, no_play)",
    ],
    upstream_rows: { 2023: 49665, 2024: 49492, 2025: 48771 },
  },
  "nflverse:snap_counts_history": {
    tables: { ds_snap_counts: 79768 },
    warnings: [],
    upstream_rows: { 2023: 26540, 2024: 26615, 2025: 26613 },
  },
  "nflverse:injuries_history": {
    tables: { ds_injuries: 17880 },
    // both duplicates are 2024's (Phase 2 already dropped them); 2023 has none
    warnings: ["ds_injuries: dropped 2 row(s) — duplicate primary key"],
    upstream_rows: { 2023: 5599, 2024: 6215, 2025: 6068 },
  },
  "nflverse:depth_charts_history": {
    tables: { ds_depth_charts: 18254, ds_depth_charts_legacy: 73799 },
    // the OTHER labels and the ungrammatical ones are all 2023's (RS, ROT, LE, RE, LOT, WR2, J, WR1,
    // T → OTHER; "WR\8" → invalid); 2024 alone: 201 duplicates, 234 SBBYE rows
    warnings: [
      "ds_depth_charts_legacy: 252 row(s) — pos_abb label outside DEPTH_LABELS stored as 'OTHER'",
      "ds_depth_charts_legacy: dropped 384 row(s) — exact duplicate row collapsed",
      "ds_depth_charts_legacy: dropped 448 row(s) — week null (SBBYE rows)",
      "ds_depth_charts_legacy: dropped 8 row(s) — null pos_abb",
    ],
    upstream_rows: { 2023: 37327, 2024: 37312, 2025: 554215 },
  },
  "ffopportunity:ep_weekly_history": {
    tables: { ds_ep_weekly: 16860 },
    warnings: [
      "ds_ep_weekly: dropped 1280 row(s) — team-level row without a player_id (unattributed opportunity)",
    ],
    upstream_rows: { 2023: 6081, 2024: 6005, 2025: 6054 },
  },
};
