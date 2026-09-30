# data-source-evaluator — working notes

Role: NFL data-source evaluator for the ESPN Fantasy Football MCP server.
Brief: `docs/scratch/briefs/data-source-evaluator.md`. Deliverable:
`docs/research/04-data-sources.md` (sections A–H).

## RESUME HERE

**Status: COMPLETE (2026-09-30 ~04:20Z).** Deliverable `docs/research/04-data-sources.md`
(sections A–H) is on `origin/main`; this file carries the probe log (28 rows) and
raw counts. Nothing outstanding for this agent. No wip patch exists (the document
was written and committed whole).

If reopened, the follow-ups are §G of the deliverable; the three that most help
the plan: (1) run the retrospective ESPN-projection backtest from the embedded
2025 weekly splits (§B.1.1 step 1) to settle whether they are as-of-kickoff;
(2) observe `ownership.date` and `lastNewsDate` on a game day to fix the ESPN
refresh cadence; (3) map `rankSourceId` 3/5/6/7/9/10/11/12 to ESPN's eight
rankers.

**Owned paths:** `docs/research/04-data-sources.md`, `docs/scratch/data-source-evaluator.md`.
Nothing else was touched. `docs/scratch/repo-security-auditor.md` was dirty in
the shared tree at times (another agent's) and was left alone.

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
| 18 | WebFetch | fantasyfootballanalytics.net/2026/08/we-analyzed-12-seasons-of-fantasy-football-projections… | 200 | — | seasonal accuracy 2014–2025, 11 sources; ESPN QB last (86.7 MAE last 3 yrs), RB t-5th 53.4, WR 3rd 42.0, TE t-4th 31.9 |
| 19 | WebFetch | fantasyfootballanalytics.net/which-projections-are-most-accurate | 200 | — | same study, live page updated May 2026 |
| 20 | WebFetch | fantasypros.com/2026/01/2025-fantasy-football-rankings-most-accurate-experts/ | 200 | — | rankings accuracy wks 1–17, 159+ experts; top 10 has no ESPN ranker; ESPN site projections not evaluated |
| 21 | WebFetch | espn.com/fantasy/football/story/_/id/50005325/… (Clay playbook wk 3, 2026-09-24) | 200 | — | "projections will always be updated inside the game leading up to kickoff" |
| 22 | WebFetch | github.com/Lolindhir/fantasy-app/issues/669 | 200 | — | "Any claim such as 'ESPN updates within N minutes' would currently be unsupported" |
| 23 | WebFetch | support.sleeper.com/en/articles/2441282-stat-corrections | 200 | — | "update stats throughout live games"; corrections up to Thursday |
| 24 | WebFetch | espn.com/fantasy/football/story/_/page/FFWeeklyPlayerRank26-49804068/… (wk 4 RB ranks) | 200 | — | "published every Tuesday … updated throughout the week"; 8 authors (Bowen, Clay, Cockcroft, Dopp, Karabell, Loza, Moody, Yates); 2026-09-29 09:56 ET |
| 25 | WebFetch | support.espn.com/hc/en-us/articles/360000099732-Scoring-Stat-Corrections | 200 | — | updated 2026-08-18: "During the game, scores/stats are updated as they are received"; corrections "within minutes", "up to seven (7) days" |
| 26 | WebFetch | fantasyfootballanalytics.net/which-dfs-projections-are-most-accurate | 200 | — | weekly accuracy 2015–2025, 9 sources; ESPN QB 6.38/6.44 (bottom), RB 5.23/5.31, WR 5.05/5.18, TE 3.85 (best) / 3.71 |
| 27 | WebFetch | fantasyfootballanalytics.net/2026/09/we-analyzed-11-seasons-of-dfs-projections… | 200 | — | 2026-09-09, Kartes; "FFA Average … outperformed individual sources in 63% of head-to-head comparisons"; ESPN TE CV 35.50% worst |
| 28 | GET | lm-api-reads…/leaguedefaults/3?view=kona_player_info&scoringPeriodId=4 + limit 5 sortPercOwned | 200 | 235,344 | 04:13:50Z re-sample: wk4/wk5/ROS projections, percentOwned, ownership.date (03:30Z) and lastNewsDate identical to #11 for all 5; max-age=5 |

Total: 28 HTTP requests (17 curl + 11 WebFetch). Web searches (8) not counted. Sample-size breach: #11 at 11.6 MB (disclosed in the deliverable §H).

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

**Local follow-ups (no HTTP)**: TBD games = 24 (wk16 4, wk17 4, wk18 16), ESPN placeholder date 08:01Z vs nflverse 13:00 ET (−599 min). Weeks 19–22 projections = the 25 K only. (1,0,2026,0) == sum of weekly (1,1) wk4–18 within 0.2 for 272/299 → "season" split is ROS. Split 2 / ROS ratio min 0.008, median 1.137, max 4.24 → not ROS-derived; looks like a frozen preseason full-season projection [U]. (1,0,2025,0) == sum 2025 weeklies only 5/275; (0,0,2025,0) == sum 2025 weekly actuals 275/275. ownership.date min 01:30:21Z, max 03:30:19Z (two snapshots, 2 h apart). Latest lastNewsDate 02:52:57Z.

**Web evidence**: see probe rows 18–27. ESPN projections are Mike Clay's ("Mike Clay's projections power the ESPN Fantasy Football game" — search snippet of an ESPN page, [V-community]).

## Findings for the orchestrator

1. ESPN-native projections: real, continuously revised, every week 1–18 populated at once, expressed in the league's scoring; independent weekly accuracy (FFA, 2015–2025): best of 9 at TE, worst at QB, lower-middle RB/WR; averaging sources wins 63% of head-to-heads → grade Secondary, ensemble with own model, display labelled. No study covers this league's scoring → backtest design in 04 §B.1.1.
2. Crosswalk is a lookup: nflverse `espn_id` 497/500 active QB/RB/WR/TE (2026 rookies 75/77); 100% of ≥1%-owned ESPN players map; DP adds 0 (and is GPL-3.0); Sleeper 25%. Name matcher only for a 3-player residue.
3. `proTeamSchedules_wl` = nflverse `games.csv` exactly (byes 32/32, game ids 272/272 via `schedules.espn`, kickoffs 248/248 non-TBD); `statsOfficial` = final (48), `validForLocking` = kickoff known (248).
4. Live scoring: ESPN-native only real option ("updated as they are received"); Sleeper undocumented stats + ESPN site scoreboard as signals; nflverse post-game.
5. Licensing: Disney ToU §2.B.viii (no commercial use) is the binding constraint; Sleeper/Open-Meteo swappable; DP not needed.
