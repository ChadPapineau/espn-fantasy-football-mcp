// observed-phase2.ts — what the real Phase-2 release files (and the prior-season files of the Phase-1
// datasets the history twins repeat) held when the Phase-2 dataset contract was grounded (2026-10-06,
// read with hyparquet 1.31.2; downloaded to a temp dir outside the repo and never committed). The
// contract's required upstream columns must be a subset of these per season (plan 01 §5.5; plan 10
// B1) and every codec an allowed one (plan 01 D9; ADV OBJ-19(d)). Generated from the files; edit
// only by re-grounding against a new release. Keys are `<current-season source>@<season>`.
import type { ObservedFile } from "./observed-columns.js";

/** One observed release file, with the content hash of the bytes read. */
export interface ObservedPhase2File extends ObservedFile {
  readonly sha256: string;
  /** Each column's parquet physical type (`/LOGICAL` when annotated), aligned with `columns`. */
  readonly types: readonly string[];
}

// prettier-ignore
const EP_WEEKLY_COLUMNS: readonly string[] = ["season", "posteam", "week", "game_id", "player_id", "full_name", "position", "pass_attempt", "rec_attempt", "rush_attempt", "pass_air_yards", "rec_air_yards", "pass_completions", "receptions", "pass_completions_exp", "receptions_exp", "pass_yards_gained", "rec_yards_gained", "rush_yards_gained", "pass_yards_gained_exp", "rec_yards_gained_exp", "rush_yards_gained_exp", "pass_touchdown", "rec_touchdown", "rush_touchdown", "pass_touchdown_exp", "rec_touchdown_exp", "rush_touchdown_exp", "pass_two_point_conv", "rec_two_point_conv", "rush_two_point_conv", "pass_two_point_conv_exp", "rec_two_point_conv_exp", "rush_two_point_conv_exp", "pass_first_down", "rec_first_down", "rush_first_down", "pass_first_down_exp", "rec_first_down_exp", "rush_first_down_exp", "pass_interception", "rec_interception", "pass_interception_exp", "rec_interception_exp", "rec_fumble_lost", "rush_fumble_lost", "pass_fantasy_points_exp", "rec_fantasy_points_exp", "rush_fantasy_points_exp", "pass_fantasy_points", "rec_fantasy_points", "rush_fantasy_points", "total_yards_gained", "total_yards_gained_exp", "total_touchdown", "total_touchdown_exp", "total_first_down", "total_first_down_exp", "total_fantasy_points", "total_fantasy_points_exp", "pass_completions_diff", "receptions_diff", "pass_yards_gained_diff", "rec_yards_gained_diff", "rush_yards_gained_diff", "pass_touchdown_diff", "rec_touchdown_diff", "rush_touchdown_diff", "pass_two_point_conv_diff", "rec_two_point_conv_diff", "rush_two_point_conv_diff", "pass_first_down_diff", "rec_first_down_diff", "rush_first_down_diff", "pass_interception_diff", "rec_interception_diff", "pass_fantasy_points_diff", "rec_fantasy_points_diff", "rush_fantasy_points_diff", "total_yards_gained_diff", "total_touchdown_diff", "total_first_down_diff", "total_fantasy_points_diff", "pass_attempt_team", "rec_attempt_team", "rush_attempt_team", "pass_air_yards_team", "rec_air_yards_team", "pass_completions_team", "receptions_team", "pass_completions_exp_team", "receptions_exp_team", "pass_yards_gained_team", "rec_yards_gained_team", "rush_yards_gained_team", "pass_yards_gained_exp_team", "rec_yards_gained_exp_team", "rush_yards_gained_exp_team", "pass_touchdown_team", "rec_touchdown_team", "rush_touchdown_team", "pass_touchdown_exp_team", "rec_touchdown_exp_team", "rush_touchdown_exp_team", "pass_two_point_conv_team", "rec_two_point_conv_team", "rush_two_point_conv_team", "pass_two_point_conv_exp_team", "rec_two_point_conv_exp_team", "rush_two_point_conv_exp_team", "pass_first_down_team", "rec_first_down_team", "rush_first_down_team", "pass_first_down_exp_team", "rec_first_down_exp_team", "rush_first_down_exp_team", "pass_interception_team", "rec_interception_team", "pass_interception_exp_team", "rec_interception_exp_team", "rec_fumble_lost_team", "rush_fumble_lost_team", "pass_fantasy_points_exp_team", "rec_fantasy_points_exp_team", "rush_fantasy_points_exp_team", "pass_fantasy_points_team", "rec_fantasy_points_team", "rush_fantasy_points_team", "pass_completions_diff_team", "receptions_diff_team", "pass_yards_gained_diff_team", "rec_yards_gained_diff_team", "rush_yards_gained_diff_team", "pass_touchdown_diff_team", "rec_touchdown_diff_team", "rush_touchdown_diff_team", "pass_two_point_conv_diff_team", "rec_two_point_conv_diff_team", "rush_two_point_conv_diff_team", "pass_first_down_diff_team", "rec_first_down_diff_team", "rush_first_down_diff_team", "pass_interception_diff_team", "rec_interception_diff_team", "pass_fantasy_points_diff_team", "rec_fantasy_points_diff_team", "rush_fantasy_points_diff_team", "total_yards_gained_team", "total_yards_gained_exp_team", "total_yards_gained_diff_team", "total_touchdown_team", "total_touchdown_exp_team", "total_touchdown_diff_team", "total_first_down_team", "total_first_down_exp_team", "total_first_down_diff_team", "total_fantasy_points_team", "total_fantasy_points_exp_team", "total_fantasy_points_diff_team"];
// prettier-ignore
const EP_WEEKLY_TYPES: readonly string[] = ["BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE"];

// prettier-ignore
const DEPTH_CHARTS_LEGACY_COLUMNS: readonly string[] = ["season", "club_code", "week", "game_type", "depth_team", "last_name", "first_name", "football_name", "formation", "gsis_id", "jersey_number", "position", "elias_id", "depth_position", "full_name"];
// prettier-ignore
const DEPTH_CHARTS_LEGACY_TYPES: readonly string[] = ["INT32", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING"];

// prettier-ignore
const DEPTH_CHARTS_SNAPSHOT_COLUMNS: readonly string[] = ["dt", "team", "player_name", "espn_id", "gsis_id", "pos_grp_id", "pos_grp", "pos_id", "pos_name", "pos_abb", "pos_slot", "pos_rank"];
// prettier-ignore
const DEPTH_CHARTS_SNAPSHOT_TYPES: readonly string[] = ["BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "INT32"];

// prettier-ignore
const INJURIES_2024_COLUMNS: readonly string[] = ["season", "game_type", "team", "week", "gsis_id", "position", "full_name", "first_name", "last_name", "report_primary_injury", "report_secondary_injury", "report_status", "practice_primary_injury", "practice_secondary_injury", "practice_status", "date_modified"];
// prettier-ignore
const INJURIES_2024_TYPES: readonly string[] = ["INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT64/TIMESTAMP"];

// prettier-ignore
const INJURIES_COLUMNS: readonly string[] = ["season", "season_type", "game_type", "team", "week", "gsis_id", "position", "full_name", "first_name", "last_name", "report_primary_injury", "report_secondary_injury", "report_status", "practice_primary_injury", "practice_secondary_injury", "practice_status"];
// prettier-ignore
const INJURIES_TYPES: readonly string[] = ["INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING"];

// prettier-ignore
const PBP_COLUMNS: readonly string[] = ["play_id", "game_id", "old_game_id", "home_team", "away_team", "season_type", "week", "posteam", "posteam_type", "defteam", "side_of_field", "yardline_100", "game_date", "quarter_seconds_remaining", "half_seconds_remaining", "game_seconds_remaining", "game_half", "quarter_end", "drive", "sp", "qtr", "down", "goal_to_go", "time", "yrdln", "ydstogo", "ydsnet", "desc", "play_type", "yards_gained", "shotgun", "no_huddle", "qb_dropback", "qb_kneel", "qb_spike", "qb_scramble", "pass_length", "pass_location", "air_yards", "yards_after_catch", "run_location", "run_gap", "field_goal_result", "kick_distance", "extra_point_result", "two_point_conv_result", "home_timeouts_remaining", "away_timeouts_remaining", "timeout", "timeout_team", "td_team", "td_player_name", "td_player_id", "posteam_timeouts_remaining", "defteam_timeouts_remaining", "total_home_score", "total_away_score", "posteam_score", "defteam_score", "score_differential", "posteam_score_post", "defteam_score_post", "score_differential_post", "no_score_prob", "opp_fg_prob", "opp_safety_prob", "opp_td_prob", "fg_prob", "safety_prob", "td_prob", "extra_point_prob", "two_point_conversion_prob", "ep", "epa", "total_home_epa", "total_away_epa", "total_home_rush_epa", "total_away_rush_epa", "total_home_pass_epa", "total_away_pass_epa", "air_epa", "yac_epa", "comp_air_epa", "comp_yac_epa", "total_home_comp_air_epa", "total_away_comp_air_epa", "total_home_comp_yac_epa", "total_away_comp_yac_epa", "total_home_raw_air_epa", "total_away_raw_air_epa", "total_home_raw_yac_epa", "total_away_raw_yac_epa", "wp", "def_wp", "home_wp", "away_wp", "wpa", "vegas_wpa", "vegas_home_wpa", "home_wp_post", "away_wp_post", "vegas_wp", "vegas_home_wp", "total_home_rush_wpa", "total_away_rush_wpa", "total_home_pass_wpa", "total_away_pass_wpa", "air_wpa", "yac_wpa", "comp_air_wpa", "comp_yac_wpa", "total_home_comp_air_wpa", "total_away_comp_air_wpa", "total_home_comp_yac_wpa", "total_away_comp_yac_wpa", "total_home_raw_air_wpa", "total_away_raw_air_wpa", "total_home_raw_yac_wpa", "total_away_raw_yac_wpa", "punt_blocked", "first_down_rush", "first_down_pass", "first_down_penalty", "third_down_converted", "third_down_failed", "fourth_down_converted", "fourth_down_failed", "incomplete_pass", "touchback", "interception", "punt_inside_twenty", "punt_in_endzone", "punt_out_of_bounds", "punt_downed", "punt_fair_catch", "kickoff_inside_twenty", "kickoff_in_endzone", "kickoff_out_of_bounds", "kickoff_downed", "kickoff_fair_catch", "fumble_forced", "fumble_not_forced", "fumble_out_of_bounds", "solo_tackle", "safety", "penalty", "tackled_for_loss", "fumble_lost", "own_kickoff_recovery", "own_kickoff_recovery_td", "qb_hit", "rush_attempt", "pass_attempt", "sack", "touchdown", "pass_touchdown", "rush_touchdown", "return_touchdown", "extra_point_attempt", "two_point_attempt", "field_goal_attempt", "kickoff_attempt", "punt_attempt", "fumble", "complete_pass", "assist_tackle", "lateral_reception", "lateral_rush", "lateral_return", "lateral_recovery", "passer_player_id", "passer_player_name", "passing_yards", "receiver_player_id", "receiver_player_name", "receiving_yards", "rusher_player_id", "rusher_player_name", "rushing_yards", "lateral_receiver_player_id", "lateral_receiver_player_name", "lateral_receiving_yards", "lateral_rusher_player_id", "lateral_rusher_player_name", "lateral_rushing_yards", "lateral_sack_player_id", "lateral_sack_player_name", "interception_player_id", "interception_player_name", "lateral_interception_player_id", "lateral_interception_player_name", "punt_returner_player_id", "punt_returner_player_name", "lateral_punt_returner_player_id", "lateral_punt_returner_player_name", "kickoff_returner_player_name", "kickoff_returner_player_id", "lateral_kickoff_returner_player_id", "lateral_kickoff_returner_player_name", "punter_player_id", "punter_player_name", "kicker_player_name", "kicker_player_id", "own_kickoff_recovery_player_id", "own_kickoff_recovery_player_name", "blocked_player_id", "blocked_player_name", "tackle_for_loss_1_player_id", "tackle_for_loss_1_player_name", "tackle_for_loss_2_player_id", "tackle_for_loss_2_player_name", "qb_hit_1_player_id", "qb_hit_1_player_name", "qb_hit_2_player_id", "qb_hit_2_player_name", "forced_fumble_player_1_team", "forced_fumble_player_1_player_id", "forced_fumble_player_1_player_name", "forced_fumble_player_2_team", "forced_fumble_player_2_player_id", "forced_fumble_player_2_player_name", "solo_tackle_1_team", "solo_tackle_2_team", "solo_tackle_1_player_id", "solo_tackle_2_player_id", "solo_tackle_1_player_name", "solo_tackle_2_player_name", "assist_tackle_1_player_id", "assist_tackle_1_player_name", "assist_tackle_1_team", "assist_tackle_2_player_id", "assist_tackle_2_player_name", "assist_tackle_2_team", "assist_tackle_3_player_id", "assist_tackle_3_player_name", "assist_tackle_3_team", "assist_tackle_4_player_id", "assist_tackle_4_player_name", "assist_tackle_4_team", "tackle_with_assist", "tackle_with_assist_1_player_id", "tackle_with_assist_1_player_name", "tackle_with_assist_1_team", "tackle_with_assist_2_player_id", "tackle_with_assist_2_player_name", "tackle_with_assist_2_team", "pass_defense_1_player_id", "pass_defense_1_player_name", "pass_defense_2_player_id", "pass_defense_2_player_name", "fumbled_1_team", "fumbled_1_player_id", "fumbled_1_player_name", "fumbled_2_player_id", "fumbled_2_player_name", "fumbled_2_team", "fumble_recovery_1_team", "fumble_recovery_1_yards", "fumble_recovery_1_player_id", "fumble_recovery_1_player_name", "fumble_recovery_2_team", "fumble_recovery_2_yards", "fumble_recovery_2_player_id", "fumble_recovery_2_player_name", "sack_player_id", "sack_player_name", "half_sack_1_player_id", "half_sack_1_player_name", "half_sack_2_player_id", "half_sack_2_player_name", "return_team", "return_yards", "penalty_team", "penalty_player_id", "penalty_player_name", "penalty_yards", "replay_or_challenge", "replay_or_challenge_result", "penalty_type", "defensive_two_point_attempt", "defensive_two_point_conv", "defensive_extra_point_attempt", "defensive_extra_point_conv", "safety_player_name", "safety_player_id", "season", "cp", "cpoe", "series", "series_success", "series_result", "order_sequence", "start_time", "time_of_day", "stadium", "weather", "nfl_api_id", "play_clock", "play_deleted", "play_type_nfl", "special_teams_play", "st_play_type", "end_clock_time", "end_yard_line", "fixed_drive", "fixed_drive_result", "drive_real_start_time", "drive_play_count", "drive_time_of_possession", "drive_first_downs", "drive_inside20", "drive_ended_with_score", "drive_quarter_start", "drive_quarter_end", "drive_yards_penalized", "drive_start_transition", "drive_end_transition", "drive_game_clock_start", "drive_game_clock_end", "drive_start_yard_line", "drive_end_yard_line", "drive_play_id_started", "drive_play_id_ended", "away_score", "home_score", "location", "result", "total", "spread_line", "total_line", "div_game", "roof", "surface", "temp", "wind", "home_coach", "away_coach", "stadium_id", "game_stadium", "aborted_play", "success", "passer", "passer_jersey_number", "rusher", "rusher_jersey_number", "receiver", "receiver_jersey_number", "pass", "rush", "first_down", "special", "play", "passer_id", "rusher_id", "receiver_id", "name", "jersey_number", "id", "fantasy_player_name", "fantasy_player_id", "fantasy", "fantasy_id", "out_of_bounds", "home_opening_kickoff", "qb_epa", "xyac_epa", "xyac_mean_yardage", "xyac_median_yardage", "xyac_success", "xyac_fd", "xpass", "pass_oe"];
// prettier-ignore
const PBP_TYPES: readonly string[] = ["DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "INT32", "INT32", "BYTE_ARRAY/STRING", "INT32", "INT32", "DOUBLE", "DOUBLE", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "INT32", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "INT32", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE"];

// prettier-ignore
const SNAP_COUNTS_COLUMNS: readonly string[] = ["game_id", "pfr_game_id", "season", "game_type", "week", "player", "pfr_player_id", "position", "team", "opponent", "offense_snaps", "offense_pct", "defense_snaps", "defense_pct", "st_snaps", "st_pct"];
// prettier-ignore
const SNAP_COUNTS_TYPES: readonly string[] = ["BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE"];

// prettier-ignore
const STATS_PLAYER_WEEK_COLUMNS: readonly string[] = ["player_id", "player_name", "player_display_name", "position", "position_group", "headshot_url", "season", "week", "season_type", "game_id", "team", "opponent_team", "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered", "sack_yards_lost", "sack_fumbles", "sack_fumbles_lost", "passing_air_yards", "passing_yards_after_catch", "passing_first_downs", "passing_epa", "passing_cpoe", "passing_2pt_conversions", "pacr", "passing_10", "passing_16", "passing_20", "passing_40", "carries", "rushing_yards", "rushing_tds", "rushing_fumbles", "rushing_fumbles_lost", "rushing_first_downs", "rushing_epa", "rushing_2pt_conversions", "rushing_10", "rushing_12", "rushing_20", "rushing_40", "receptions", "targets", "receiving_yards", "receiving_tds", "receiving_fumbles", "receiving_fumbles_lost", "receiving_air_yards", "receiving_yards_after_catch", "receiving_first_downs", "receiving_epa", "receiving_2pt_conversions", "receiving_10", "receiving_16", "receiving_20", "receiving_40", "racr", "target_share", "air_yards_share", "wopr", "special_teams_tds", "def_tackles_solo", "def_tackles_with_assist", "def_tackle_assists", "def_tackles_for_loss", "def_tackles_for_loss_yards", "def_fumbles_forced", "def_sacks", "def_sack_yards", "def_qb_hits", "def_interceptions", "def_interception_yards", "def_pass_defended", "def_tds", "def_fumbles", "def_safeties", "def_punt_blocks", "def_pat_blocks", "def_fg_blocks", "def_2pt_atts", "def_2pt_made", "misc_yards", "fumble_recovery_own", "fumble_recovery_yards_own", "fumble_recovery_opp", "fumble_recovery_yards_opp", "fumble_recovery_tds", "penalties", "penalty_yards", "fumbles_forced_by_opp", "fumbles_not_forced", "fumbles_out_of_bounds", "fumbles_total", "fumbles_lost_total", "punt_returns", "punt_return_yards", "kickoff_returns", "kickoff_return_yards", "fg_made", "fg_att", "fg_missed", "fg_blocked", "fg_long", "fg_pct", "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49", "fg_made_50_59", "fg_made_60_", "fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39", "fg_missed_40_49", "fg_missed_50_59", "fg_missed_60_", "fg_made_list", "fg_missed_list", "fg_blocked_list", "fg_made_distance", "fg_missed_distance", "fg_blocked_distance", "pat_made", "pat_att", "pat_missed", "pat_blocked", "pat_pct", "gwfg_made", "gwfg_att", "gwfg_missed", "gwfg_blocked", "gwfg_distance", "pt_att", "pt_blocked", "pt_long", "pt_yards", "pt_inside_20", "pt_out_of_bounds", "pt_downed", "pt_touchback", "pt_fair_caught", "pt_returned", "pt_return_yards", "pt_return_tds", "pt_net_yards", "fantasy_points", "fantasy_points_ppr"];
// prettier-ignore
const STATS_PLAYER_WEEK_TYPES: readonly string[] = ["BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "DOUBLE", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "DOUBLE"];

// prettier-ignore
const STATS_TEAM_WEEK_COLUMNS: readonly string[] = ["season", "week", "team", "season_type", "game_id", "opponent_team", "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered", "sack_yards_lost", "sack_fumbles", "sack_fumbles_lost", "passing_air_yards", "passing_yards_after_catch", "passing_first_downs", "passing_epa", "passing_cpoe", "passing_2pt_conversions", "passing_10", "passing_16", "passing_20", "passing_40", "carries", "rushing_yards", "rushing_tds", "rushing_fumbles", "rushing_fumbles_lost", "rushing_first_downs", "rushing_epa", "rushing_2pt_conversions", "rushing_10", "rushing_12", "rushing_20", "rushing_40", "receptions", "targets", "receiving_yards", "receiving_tds", "receiving_fumbles", "receiving_fumbles_lost", "receiving_air_yards", "receiving_yards_after_catch", "receiving_first_downs", "receiving_epa", "receiving_2pt_conversions", "receiving_10", "receiving_16", "receiving_20", "receiving_40", "special_teams_tds", "def_tackles_solo", "def_tackles_with_assist", "def_tackle_assists", "def_tackles_for_loss", "def_tackles_for_loss_yards", "def_fumbles_forced", "def_sacks", "def_sack_yards", "def_qb_hits", "def_interceptions", "def_interception_yards", "def_pass_defended", "def_tds", "def_fumbles", "def_safeties", "def_punt_blocks", "def_pat_blocks", "def_fg_blocks", "def_2pt_atts", "def_2pt_made", "misc_yards", "fumble_recovery_own", "fumble_recovery_yards_own", "fumble_recovery_opp", "fumble_recovery_yards_opp", "fumble_recovery_tds", "penalties", "penalty_yards", "timeouts", "fumbles_forced_by_opp", "fumbles_not_forced", "fumbles_out_of_bounds", "fumbles_total", "fumbles_lost_total", "punt_returns", "punt_return_yards", "kickoff_returns", "kickoff_return_yards", "fg_made", "fg_att", "fg_missed", "fg_blocked", "fg_long", "fg_pct", "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49", "fg_made_50_59", "fg_made_60_", "fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39", "fg_missed_40_49", "fg_missed_50_59", "fg_missed_60_", "fg_made_list", "fg_missed_list", "fg_blocked_list", "fg_made_distance", "fg_missed_distance", "fg_blocked_distance", "pat_made", "pat_att", "pat_missed", "pat_blocked", "pat_pct", "gwfg_made", "gwfg_att", "gwfg_missed", "gwfg_blocked", "gwfg_distance", "pt_att", "pt_blocked", "pt_long", "pt_yards", "pt_inside_20", "pt_out_of_bounds", "pt_downed", "pt_touchback", "pt_fair_caught", "pt_returned", "pt_return_yards", "pt_return_tds", "pt_net_yards"];
// prettier-ignore
const STATS_TEAM_WEEK_TYPES: readonly string[] = ["INT32", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "BYTE_ARRAY/STRING", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "DOUBLE", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32", "INT32"];

export const OBSERVED_PHASE2: Readonly<Record<string, ObservedPhase2File>> = {
  "ffopportunity:ep_weekly@2024": {
    url: "https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_2024.parquet",
    updated_at: "2025-02-24T02:02:07Z",
    bytes: 1125932,
    rows: 6005,
    codecs: ["SNAPPY"],
    sha256: "ed657898682e7750876beb8c8c35a32e9aa22a51108de0b0c8842ffe3ac9c6e6",
    columns: EP_WEEKLY_COLUMNS,
    types: EP_WEEKLY_TYPES,
  },
  "ffopportunity:ep_weekly@2025": {
    url: "https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_2025.parquet",
    updated_at: "2026-09-08T10:06:56Z",
    bytes: 1131935,
    rows: 6054,
    codecs: ["SNAPPY"],
    sha256: "7b8be943bd230fc5f93f561989761e4dcebf484c0e11ffba5fa4775186e53327",
    columns: EP_WEEKLY_COLUMNS,
    types: EP_WEEKLY_TYPES,
  },
  "ffopportunity:ep_weekly@2026": {
    url: "https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_2026.parquet",
    updated_at: "2026-10-06T12:14:49Z",
    bytes: 331526,
    rows: 1362,
    codecs: ["SNAPPY"],
    sha256: "38bb0e03dc39c92fceb6f04c96d2796f174547c8cebc1885b282ca01a20898d4",
    columns: EP_WEEKLY_COLUMNS,
    types: EP_WEEKLY_TYPES,
  },
  "nflverse:depth_charts@2024": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2024.parquet",
    updated_at: "2025-02-13T07:32:56Z",
    bytes: 482923,
    rows: 37312,
    codecs: ["SNAPPY"],
    sha256: "2b5e72fa37f6a498238da30d619cd5d2fe883ffbfdbaaf637301893ad6c22097",
    columns: DEPTH_CHARTS_LEGACY_COLUMNS,
    types: DEPTH_CHARTS_LEGACY_TYPES,
  },
  "nflverse:depth_charts@2025": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2025.parquet",
    updated_at: "2026-03-14T07:32:28Z",
    bytes: 2584724,
    rows: 554215,
    codecs: ["SNAPPY"],
    sha256: "14f74185b3c2c48df234ced284ba3596bda3333d0b2a8df40841f68cd34539fa",
    columns: DEPTH_CHARTS_SNAPSHOT_COLUMNS,
    types: DEPTH_CHARTS_SNAPSHOT_TYPES,
  },
  "nflverse:depth_charts@2026": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.parquet",
    updated_at: "2026-10-06T14:08:58Z",
    bytes: 2812797,
    rows: 613196,
    codecs: ["SNAPPY"],
    sha256: "eb3eb03833a2dc53f5a629aabba1ec513b50c0b102c47a4f0d40a3ddb666ee12",
    columns: DEPTH_CHARTS_SNAPSHOT_COLUMNS,
    types: DEPTH_CHARTS_SNAPSHOT_TYPES,
  },
  "nflverse:injuries@2024": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2024.parquet",
    updated_at: "2025-02-13T07:16:35Z",
    bytes: 139253,
    rows: 6215,
    codecs: ["SNAPPY"],
    sha256: "7ebabbba930a70bc7e4d257c7c41ca8708f147a4cdd4100956abcfbaf70f7fc1",
    columns: INJURIES_2024_COLUMNS,
    types: INJURIES_2024_TYPES,
  },
  "nflverse:injuries@2025": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2025.parquet",
    updated_at: "2026-09-07T12:23:41Z",
    bytes: 97472,
    rows: 6068,
    codecs: ["SNAPPY"],
    sha256: "c7637c2f6347194426a8582a984aac82a6bf8ab06af72cdd96666a2e0733ab24",
    columns: INJURIES_COLUMNS,
    types: INJURIES_TYPES,
  },
  "nflverse:pbp@2024": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2024.parquet",
    updated_at: "2026-08-13T12:26:27Z",
    bytes: 20597560,
    rows: 49492,
    codecs: ["SNAPPY"],
    sha256: "3fd2896bc0b911b615142d2f1fabae54a4bbba5ab7b73b28187b118ef8af6a3b",
    columns: PBP_COLUMNS,
    types: PBP_TYPES,
  },
  "nflverse:pbp@2025": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2025.parquet",
    updated_at: "2026-08-13T12:26:09Z",
    bytes: 20337029,
    rows: 48771,
    codecs: ["SNAPPY"],
    sha256: "c6ecedd6d678cc37ed316b23ef84ee1ec6abb69c514bb11868a7ebd5a367df29",
    columns: PBP_COLUMNS,
    types: PBP_TYPES,
  },
  "nflverse:pbp@2026": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2026.parquet",
    updated_at: "2026-10-06T15:53:37Z",
    bytes: 4849154,
    rows: 11155,
    codecs: ["SNAPPY"],
    sha256: "d1689918c262c5eaf2406ed341dedcbe3b849517c1dbe39bd3cab4a312463149",
    columns: PBP_COLUMNS,
    types: PBP_TYPES,
  },
  "nflverse:snap_counts@2024": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2024.parquet",
    updated_at: "2025-10-06T06:51:20Z",
    bytes: 240862,
    rows: 26615,
    codecs: ["SNAPPY"],
    sha256: "9ec66a0c755939b329d4eba3f90e716bb874b5a6544f325ba220f003991ff99f",
    columns: SNAP_COUNTS_COLUMNS,
    types: SNAP_COUNTS_TYPES,
  },
  "nflverse:snap_counts@2025": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2025.parquet",
    updated_at: "2026-09-24T12:50:31Z",
    bytes: 242046,
    rows: 26613,
    codecs: ["SNAPPY"],
    sha256: "47220218fecda7af7ee5b0272a8ecce7c1bfb1f4e1f0a2c8c90047571728ce20",
    columns: SNAP_COUNTS_COLUMNS,
    types: SNAP_COUNTS_TYPES,
  },
  "nflverse:snap_counts@2026": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2026.parquet",
    updated_at: "2026-10-06T11:01:47Z",
    bytes: 83636,
    rows: 5970,
    codecs: ["SNAPPY"],
    sha256: "51549f93e1e70999bc8964b686ce27f6db324513017d59253a3daf6fa05ae310",
    columns: SNAP_COUNTS_COLUMNS,
    types: SNAP_COUNTS_TYPES,
  },
  "nflverse:stats_player_week@2024": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2024.parquet",
    updated_at: "2026-08-13T16:49:10Z",
    bytes: 849243,
    rows: 18983,
    codecs: ["SNAPPY"],
    sha256: "847569d194ca3d96b5efcf91e6eac5e18780fc47568a713fd545a82d29d155c1",
    columns: STATS_PLAYER_WEEK_COLUMNS,
    types: STATS_PLAYER_WEEK_TYPES,
  },
  "nflverse:stats_player_week@2025": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.parquet",
    updated_at: "2026-08-13T16:51:22Z",
    bytes: 855077,
    rows: 19422,
    codecs: ["SNAPPY"],
    sha256: "2a461becaa9adb3c93a3074a3a31f1e960162a50163371a2d34e28393b5fff10",
    columns: STATS_PLAYER_WEEK_COLUMNS,
    types: STATS_PLAYER_WEEK_TYPES,
  },
  "nflverse:stats_team_week@2024": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2024.parquet",
    updated_at: "2026-08-13T16:49:13Z",
    bytes: 128118,
    rows: 570,
    codecs: ["SNAPPY"],
    sha256: "c95aca86417589edb34b5001c11ba4bab869394fd3d51e475ff0958dda1669fc",
    columns: STATS_TEAM_WEEK_COLUMNS,
    types: STATS_TEAM_WEEK_TYPES,
  },
  "nflverse:stats_team_week@2025": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2025.parquet",
    updated_at: "2026-08-13T16:51:24Z",
    bytes: 128766,
    rows: 570,
    codecs: ["SNAPPY"],
    sha256: "ec168d98ebbcb0d14d1049ba690e55a629fe6e4f00aaa8a700c309d9dad6d34d",
    columns: STATS_TEAM_WEEK_COLUMNS,
    types: STATS_TEAM_WEEK_TYPES,
  },
  "nflverse:stats_team_week@2026": {
    url: "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2026.parquet",
    updated_at: "2026-10-06T15:55:08Z",
    bytes: 74271,
    rows: 128,
    codecs: ["SNAPPY"],
    sha256: "428affe2a4f290ccd788a6b0d48e911fc71039aa410dbcc8331f9cc2871e81b1",
    columns: STATS_TEAM_WEEK_COLUMNS,
    types: STATS_TEAM_WEEK_TYPES,
  },
};
