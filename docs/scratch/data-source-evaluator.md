# data-source-evaluator — working notes

Role: NFL data-source evaluator for the ESPN Fantasy Football MCP server.
Brief: `docs/scratch/briefs/data-source-evaluator.md`. Deliverable:
`docs/research/04-data-sources.md` (sections A–H).

## RESUME HERE

- Status (2026-09-30 ~04:05Z): reading done (03-espn-api.md; sibling
  `yahoo-fantasy-football-mcp@d10835c` 04 + scratch). Probes 1–17 done; raw
  counts below. Web evidence (accuracy, cadence, live latency) in flight.
- Next: write `docs/research/04-data-sources.md` sections A–H from the notes
  below; one more kona limit-5 re-sample near the end for intra-day cadence.
- Deliverable not yet created; nothing in the tree besides this file.

## Request budget (≤ 40)

| # | Method | URL (anonymized) | Status | Bytes | Note |
|---|--------|------------------|--------|-------|------|
| 1–4 | GET | api.github.com/repos/nflverse/nflverse-data/releases/tags/{stats_player,injuries,schedules,weekly_rosters} | 200 | — | 03:59:13Z; updated_at: stats_player_week_2026.csv 2026-09-29T15:45:48Z (1,487,226 B); injuries_2026.csv 2026-09-29T13:59:26Z (83,478 B); games.csv 2026-09-30T03:46:30Z (2,182,348 B); roster_weekly_2026.csv.gz 2026-09-29T14:03:35Z (445,121 B) |
| 5 | GET | github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2026.csv.gz | 200 | 445,121 | 1 redirect |
| 6 | GET | …/releases/download/schedules/games.csv | 200 | 2,182,348 | 1 redirect |
| 7 | GET | github.com/dynastyprocess/data/raw/master/files/db_playerids.csv | 200 | 2,633,236 | 1 redirect |
| 8 | GET | api.sleeper.app/v1/players/nfl | 200 | 2,572,742 on wire (14,661,297 decompressed) | s-maxage=600 |
| 9 | GET | lm-api-reads…/seasons/2026/players?view=players_wl + root filterActive | 200 | 663,713 | count header 2663; max-age=300 |
| 10 | GET | lm-api-reads…/seasons/2026?view=proTeamSchedules_wl | 200 | 109,067 | CloudFront hit, age 212 |
| 11 | GET | lm-api-reads…/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=4 + limit 300 sortPercOwned | 200 | 11,557,824 | **over the 5 MB sample cap** (38.5 KB/player — leaguedefaults embeds all 2025+2026 weekly splits); count header 1050; max-age=5 |
| 12 | GET | api.sleeper.app/v1/state/nfl | 200 | 211 | week 4, display_week 3 |
| 13 | GET | api.sleeper.com/stats/nfl/2026/4?season_type=regular&position[]=RB&order_by=pts_ppr | 200 | 2 | `[]` (no wk-4 games yet); s-maxage=4 |
| 14 | GET | site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard (bare) | 200 | 157,355 | week 3, 16 events, all STATUS_FINAL; max-age=4; no odds/weather |
| 15 | GET | api.github.com/repos/dynastyprocess/data/license | 200 | 49,370 | GPL-3.0 (repo LICENSE) |
| 16 | GET | api.github.com/repos/dynastyprocess/data/commits?path=files/db_playerids.csv | 200 | 10,165 | weekly Fri ~05:00Z: 09-25, 09-18, 09-11 |
| 17 | GET | api.sleeper.com/stats/nfl/2026/3?…position[]=RB | 200 | 24,920 | 177 items, company sportradar, category stat, last_modified epoch; s-maxage=300 |

## Notes (raw counts, observed 2026-09-30 03:59–04:02Z)

**nflverse roster_weekly_2026** (updated 2026-09-29T14:03:35Z): 10,562 rows, 36 cols, weeks 1–4. Week 4: 2,526 rows (ACT 1,692 / DEV 525 / RES 279 / RET 23 / EXE 5 / CUT 2).
- ACT QB/RB/WR/TE n=500: espn_id 497 (99.4%), gsis_id 500, yahoo_id 338, sleeper_id 490, pfr_id 497, sportradar_id 490. Missing espn_id = 3: Malik McClain NYJ WR (ry2026), Tanner Arkin NE TE (ry2026), Mark Redman GB TE (ry2025). 2026 rookies 77 → 75 with espn_id.
- ACT QB/RB/WR/TE/K n=532 (sibling's frame): espn_id 529, yahoo_id 362 (matches sibling), sleeper 519. 2026 rookies 80 → 78 with espn_id.
- 0 duplicate espn_id among ACT skill; 2,057 distinct espn_id across all 2026 rows; gsis→espn map 2,057 pairs.

**DynastyProcess db_playerids.csv** (last commit 2026-09-25T05:10:03Z; weekly Fridays; repo LICENSE GPL-3.0): 12,508 rows, 35 cols. Skill w/ team (excl. FA) 1,481: espn_id 1,100, gsis 1,084, yahoo 722, sleeper 982. 2026 rookies (draft_year=2026, skill w/ team) 121: espn_id 121/121, gsis 119. Join to nflverse ACT skill on gsis_id: agree 497, conflict 0, fills 0.

**Sleeper players/nfl** (12,229 players; s-maxage=600): active skill w/ team 824: espn_id 205 (25%), gsis_id 157, yahoo 212, sportradar 813, rotowire 812. years_exp=0: 150 → espn_id 0. Join to nflverse on gsis (trimmed): agree 103, conflict 0, fills 0.

**ESPN players_wl** (2,663 active; count header 2663): QB 131, RB 243, WR 381, TE 205, K 58, DST 32, TQB 32, HC 32, P 49, IDP ~1,500. QB/RB/WR/TE with proTeam ≠ 0: 621 → in nflverse 603, DP 613, Sleeper 160, union 613, unmatched 8 (all percentOwned 0.0: Jimmy Holiday, Thomas Odukoya, Mark Redman, Tanner Arkin, Patrick Herbert, Anthony Tyus III, Malik McClain, Kolbe Katsis). percentOwned ≥ 1%: 259/259 matched; ≥ 10%: 188/188; ≥ 50%: 139/139. nflverse ACT skill espn_ids absent from players_wl: 1. lastNewsDate present 2,459/2,663; <1d 106, <3d 403, <7d 557, <30d 1,080.

**Schedule**: ESPN proTeamSchedules_wl 33 proTeams, 272 games, weeks 1–18; startTimeTBD 24, statsOfficial 48 (= 3 weeks × 16), validForLocking 248. nflverse games.csv 2026: 272 REG. Bye mismatches 0/32. ESPN game id == nflverse `espn` column for 272/272; matchup+week identical 272/272; kickoff identical for 248, the 24 TBD games differ by −599 min. Lines filled 79/272 (wk4 16/16); temp 33/272.

**kona_player_info (leaguedefaults/3, top 300 by percentOwned)**: entry keys as 03 §A.2; positions WR 102 / RB 73 / QB 38 / TE 35 / DST 27 / K 25. Weekly projections (1,1,2026,w) present for w=1…18 on 298–299/300 (wk4 nonzero 264, wk5 nonzero 253) and w=19–22 on 25; season (1,0,2026,0) 299; split 2 (1,2,2026,0) 290; actuals (0,1,2026,1–3) 298–299; full 2025 weekly actuals+projections embedded. Top wk4 proj: Gibbs 26.18, Allen 22.26, Bijan 21.51, L. Jackson 21.14, JSN 20.97. ownership keys: activityLevel, auctionValueAverage(+Change), averageDraftPosition(+PercentChange), date, leagueType, percentChange, percentOwned, percentStarted; ownership.date = 2026-09-30T03:30:19Z on all 300 (29 min before fetch). draftRanksByRankType: ELIMINATION, PPR, STANDARD, SUPERFLEX. rankings weeks 0–4; rankSourceId ∈ {0,3,5,6,7,9,10,11,12}; wk4 rankings published:true. injuryStatus: ACTIVE 229, null 27, INJURY_RESERVE 19, QUESTIONABLE 15, OUT 5, DOUBTFUL 4, DAY_TO_DAY 1; injured 24. seasonOutlook 255/300 (median 697 chars); outlooksByWeek weeks 2,3,4 (252/252/242); lastNewsDate 273/300: <1d 53, <3d 228, <7d 253. positionAgainstOpponent absent on leaguedefaults. 38.5 KB/player.

**Sleeper stats wk3** (undocumented `api.sleeper.com/stats/nfl/2026/3`): 177 RB items, company sportradar, category stat, fields game_id/date/last_modified/updated_at/status/opponent/week_shard + stats (off_snp, tm_off_snp, rec_rz_tgt, rush_rz_att, rec_air_yd, pos_rank_*, pts_*), Gibbs 41.4 ppr. wk4 empty with s-maxage=4 (live week), wk3 s-maxage=300.

**ESPN site scoreboard** (bare): week 3, 16 events, status.type {state post, completed}, clock/period, linescores, competitors.score, leaders; max-age=4; no odds/weather keys on completed games.
