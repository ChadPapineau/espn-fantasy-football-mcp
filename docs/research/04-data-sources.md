# 04 — NFL data sources for the ESPN product: evaluation, ESPN-native grades, crosswalk, freshness, licensing

**Observed 2026-09-30 03:59–04:20 UTC (Tuesday 2026-09-29, 23:59–00:20 ET) — 2026 NFL season, week 3 complete, week 4 kicks off Thu 2026-10-01 20:15 ET (PIT @ CLE).**
Author: `data-source-evaluator` (brief: `docs/scratch/briefs/data-source-evaluator.md`). Working notes and raw counts: `docs/scratch/data-source-evaluator.md`.

## How to read this document

| Mark | Meaning |
|---|---|
| **[V-observed]** | I fetched it today (`curl`, GitHub releases API, ≤ 5 MB samples except where disclosed) and report status, size, `updated_at`, row counts, field names. Probe numbers `P01`–`P28` refer to §H. |
| **[V-docs]** | Quoted from the provider's own page, fetched today. |
| **[V-community]** | Third-party report (wrapper source, issue thread, study); not confirmed against the provider. |
| **[U]** | Unverified; collected by name in §G. |
| **Y-04 §n** | Reused by citation from the sibling program: `yahoo-fantasy-football-mcp@d10835c docs/research/04-data-sources.md §n` (its live probes ran 2026-09-29, one day before mine). Its verdicts stand unless a row here says otherwise. |
| **03 §n** | `docs/research/03-espn-api.md` in this repo (the ESPN API capability reference; its probes `P01`–`P30` are that document's, not mine). |

**Method.** 28 HTTP requests (§H), a plain `User-Agent`, no cookies, no keys; python3 standard library only for counting; nothing installed or executed from third-party repos. One sample exceeded the 5 MB cap: the ESPN `kona_player_info` pull on the public default-league template returned 11.6 MB for 300 players (38.5 KB each, because that path embeds every 2025 and 2026 weekly split) — disclosed in §H, no further large samples were taken. Nothing identifying any league or person appears here; the ESPN probes used only league-id-free paths (`/players`, `/seasons/2026`, `leaguedefaults/3`).

**Grades:** *Primary* = use it; *Secondary* = cross-check, fill gaps, or one input among several; *Fallback* = only if the above fail; *Do not use* = ToS-prohibited, dead, or not worth its cost. A paid or ToS-restricted source is never graded Primary without saying so in the same cell. **ESPN-native** means a field the server already receives from the unofficial fantasy read host it uses for league data (03 §A), so its marginal ToS exposure is zero; its *quality* is what §B.1 establishes.

---

## A. Evaluation matrix (need → grade per source, ESPN-native column first)

| # | Need | **ESPN-native** (field · grade · why) | Primary | Secondary | Fallback | Do not use |
|---|---|---|---|---|---|---|
| 1 | Play-by-play, weekly player stats, EPA/efficiency | weekly **actuals under this league's scoring** (`stats[]` `statSourceId 0, statSplitTypeId 1`, via `mBoxscore` / `kona_playercard`, 03 §B.5) · **Secondary** — the league-scored points only; no pbp, no EPA | **nflverse `pbp` + `stats_player_week`** (Y-04 §A#1, §B1; `stats_player_week_2026.csv` re-verified today: `updated_at` 2026-09-29T15:45:48Z, 1,487,226 B, P01) | nflverse `stats_team_week` | — | old `player_stats` tag (frozen 2025-05-07, Y-04 §F); PFR direct |
| 2 | Snap counts | none | **nflverse `snap_counts`** (Y-04 §A#2) | — | Sleeper `stats` `off_snp`/`tm_off_snp` (undocumented, P17) | PFR direct (Y-04 §B12) |
| 3 | Routes run | none | **NONE free & current** (Y-04 §A#3) | proxy `snap_counts.offense_pct` × team dropbacks | PFF (paid, no API) | `participation` 2026 in-season (no file) |
| 4 | Target share, air yards, WOPR, RACR, aDOT | none | **nflverse `stats_player_week`** (Y-04 §A#4) | ffopportunity `ep_weekly` (Y-04 §B2) | NGS `ngs_receiving` | — |
| 5 | Red-zone / goal-line usage | none | **derive from nflverse `pbp`** (Y-04 §A#5) | ffopportunity `*_touchdown_exp` | Sleeper `stats` `rec_rz_tgt`, `rush_rz_att` (undocumented, P17) | — |
| 6 | Injuries + practice participation | `player.injuryStatus` (`ACTIVE / QUESTIONABLE / DOUBTFUL / OUT / INJURY_RESERVE / DAY_TO_DAY / null`), `injured` (03 §B.2; distribution in §B.1.4) · **Secondary** — the status the league UI shows and lineup rules act on, but an enum with no timestamp and no practice detail | **nflverse `injuries`** (official reports with practice status; `injuries_2026.csv` re-verified: 2026-09-29T13:59:26Z, 83,478 B, P02) | ESPN-native status; Sleeper `injury_status`/`injury_body_part` (Y-04 §B4) | — | Sleeper `practice_participation` (dead, Y-04 §B4); ESPN core `/injuries` (404, Y-04 §B5) |
| 7 | Depth charts | none direct (`proTeamSchedules_wl.teamPlayersByPosition` exists, not examined — [U]) | **nflverse `depth_charts`** — **ESPN-sourced and keyed by `espn_id`** (Y-04 §B1), so it joins to ESPN players without a crosswalk | Sleeper `depth_chart_order` | — | ESPN site scrape |
| 8 | Betting lines, spreads, totals, implied totals | none on the fantasy host | **nflverse `schedules` (`games.csv`)** — wk-4 lines 16/16 today, and its `espn` column is the ESPN game id (272/272 match, §B.1.6, P06) | The Odds API free tier (Y-04 §B6) | ESPN core `…/competitions/{id}/odds` (DraftKings; unofficial, Y-04 §B5) | DraftKings/FanDuel/Action Network endpoints (Y-04 §A#8) |
| 9 | Weather | none on the fantasy host | **Open-Meteo** (non-commercial) (Y-04 §B7) | **NWS** (Y-04 §B8) | ESPN core event `weather` (AccuWeather via ESPN; unofficial, Y-04 §B5); nflverse `temp/wind` = post-game actuals | — |
| 10 | Defensive matchup (DvP, pace, pass/run rate) | `mPositionalRatings` / `positionAgainstOpponent` (league path only; absent on `leaguedefaults`, P11) · **Secondary** — ESPN's own DvP average + rank per position × opponent, the number the league UI shows | **derive from nflverse `pbp`** (Y-04 §A#10) | nflverse `stats_team_week`; FTN `ftn_charting`; ESPN-native ratings | — | FTN/FO DVOA, PFF (paid) |
| 11 | NFL schedule, bye weeks, kickoff times, lock/final flags | `proTeamSchedules_wl` (no league id, no cookie, CloudFront `max-age=300`) · **Primary** — 272/272 games and 32/32 byes identical to nflverse, plus `startTimeTBD`, `validForLocking`, `statsOfficial` (§B.1.6) | ESPN-native | **nflverse `schedules`** for `roof`, `surface`, rest days, QB names, lines, actual weather — joined on ESPN game id (`games.csv` re-verified: 2026-09-30T03:46:30Z, 2,182,348 B, P03) | Sleeper `state/nfl` (`week`, `display_week`, P12) | — |
| 12 | Projections (weekly, rest-of-season) | `stats[]` `statSourceId 1` weekly (`statSplitTypeId 1`, every week 1–18 present at once) and rest-of-season (`statSplitTypeId 0` = sum of remaining weeks, §B.1.1), `appliedTotal` **under this league's scoring** · **Secondary** — a real, continuously revised, mid-pack source (TE best of 9 sources weekly; QB worst; RB/WR lower-middle, §B.1.1); the *label* "ESPN projection" is Primary for display because it is what the league sees; never the sole basis of a start/sit or waiver number | **Ensemble**: own usage model from nflverse + ffopportunity (Y-04 §A#12, §G-1) **plus** the ESPN-native projection as one input; averaging beats any single source in 63 % of head-to-heads (§B.1.1) | ESPN-native alone (labelled), FantasyPros API (paid, personal-use, Y-04 §B9) | Sleeper `projections` (undocumented, non-commercial, dev reference only, Y-04 §B4b) | numberFire (dead); scraping |
| 13 | Ownership %, % started, ownership change, ADP, auction values, trending | `player.ownership{percentOwned, percentStarted, percentChange, averageDraftPosition, auctionValueAverage, …, date}` · **Primary** — the ESPN population (the one the user's league is drawn from), snapshot timestamp on every player (`date` = 23:30 ET tonight; §B.1.2) | ESPN-native | Sleeper `trending/add|drop` (different population; non-commercial; Y-04 §A#13) | — | — |
| 14 | Weekly ranks / consensus | `player.rankings{week: [{rank, rankSourceId, rankType, published}]}` (8 analyst ids + id 0 with `averageRank`), `draftRanksByRankType{STANDARD, PPR, ELIMINATION, SUPERFLEX}`, `ratings` · **Secondary** — ESPN's eight named weekly rankers and their average; no accuracy evidence for them (no ESPN ranker in FantasyPros' 2025 top ten, §B.1.3); source-id → name map [U] | **ESPN-native rankings as the "what ESPN says" view** + own projection ensemble for decisions | FantasyPros ECR (paid, personal-use) | — | — |
| 15 | Player news / outlook text | `seasonOutlook` (median 697 chars), `outlooks.outlooksByWeek` (week-4 text on 242/300 top players by Tuesday night), `lastNewsDate` (228/300 within 3 days) · **Primary for per-player outlook** (editorial, weekly, per player, richer than any free feed) — **untrusted free text**, length-capped and delimited (03 §B.5); `lastNewsDate` is a free "something changed" signal | ESPN-native outlook + `lastNewsDate` | RotoWire RSS + ESPN RSS for breaking headlines (Y-04 §B10) | Sleeper `news_updated` timestamp; CBS RSS | Reddit, NBC/Rotoworld, FantasyPros RSS, NFL.com feeds (Y-04 §F); `site.api.espn.com` news (403, 03 §A.1) |
| 16 | Player-ID crosswalk (ESPN id ↔ gsis) | ESPN `id` is the key everything joins **to**; `players_wl` (2,663 active) is the universe | **nflverse `roster_weekly_2026.espn_id`** — 497/500 active QB/RB/WR/TE (99.4 %), 0 conflicts (§C) | DynastyProcess `db_playerids.csv` (identical 497, adds nothing; GPL-3.0 repo — §E) | name+team+position matcher for the 3-player residue; Sleeper `espn_id` (25 % fill, fills 0) | nflverse `players.csv` alone (it has `espn_id` but no `yahoo_id`/`sleeper_id`; fine for us, unnecessary) |
| 17 | **Live scoring during games** (new need) | `mMatchupScore` (`totalPointsLive`, `totalProjectedPointsLive`, `winProbability`) + `mBoxscore` per-player actuals (03 §B.7) · **Primary** — ESPN: "During the game, scores/stats are updated as they are received" (§B.1.7); cookies needed for a private league; `mLiveScoring` with cookies [U] | ESPN-native | ESPN site scoreboard (bare URL only, `max-age=4`, game `state pre/in/post`, clock, period — unofficial, P14); Sleeper `stats/nfl/{season}/{week}` (undocumented, Sportradar-sourced, `s-maxage=4` during the live week, P13/P17) | nflverse `pbp` (post-game, "within 15 minutes after a game has ended", Y-04 §E) for the authoritative record | — |
| 18 | Historical data for backtests | **2025 weekly projections *and* actuals for every player are embedded in the same `kona_player_info` payload** (`(1,1,2025,w)` and `(0,1,2025,w)` for w = 1–18 on ≥ 268/300 sampled players, P11) · **Secondary** — a free, ESPN-specific backtest corpus under this league's scoring (caveat: whether those 2025 projections are the as-of-kickoff values is [U]) | **nflverse** multi-season releases (Y-04 §A#16) | ESPN-native 2025 embeds; ffopportunity | ESPN `leagueHistory` for ≤ 2017 (03 §A.1) | — |

---

## B. Per-source evidence

### B.1 ESPN-native data (the new work) — quality, cadence, and what stays unverified

All fields below were observed today on the league-id-free paths (`P09`–`P11`), and their shapes match 03 §B.5. The sample for §B.1.1–§B.1.5 is the **top 300 players by `percentOwned`** on ESPN's public default-league template (`leaguedefaults/3`, `scoringPeriodId=4`): WR 102, RB 73, QB 38, TE 35, D/ST 27, K 25 [V-observed P11].

#### B.1.1 Projections — grade **Secondary** (one input; label it; ensemble it)

**Who makes them.** ESPN's game projections are Mike Clay's: his weekly "Fantasy playbook" (2026-09-24) says "rankings will be updated on the site and projections will always be updated inside the game leading up to kickoff" [V-docs, espn.com story id 50005325]; ESPN's rankings pages state "Mike Clay's projections power the ESPN Fantasy Football game" [V-community — search snippet of an ESPN page, not fetched verbatim].

**Published accuracy — the only independent, multi-season measurements found are Fantasy Football Analytics' (Jesse Kartes), both [V-docs, fetched today]:**

| Study | Design | ESPN's result |
|---|---|---|
| *"We Analyzed 12 Seasons of Fantasy Football Projections"* (2026-08-21) and the live page *"Which Projections Are Most Accurate?"* (updated May 2026) | **Seasonal** projections, 2014–2025, 11 sources (CBS, ESPN, NumberFire, FantasyPros, FFToday, FantasySharks, RTSports, NFL, WalterFootball, FFA Average, FFA Weighted); top projected players per position; MAE primary, R² and mean error secondary | **QB: last** — "strong early in the sample, fell to last"; "last among all sources over the last three seasons (86.7 MAE)" vs best 71.2 (NFL, recent) / 61.0 (best, full sample). **RB: tied 5th** (53.4 MAE; best CBS 52.2). **WR: 3rd** (42.0 MAE). **TE: tied 4th** (31.9; best FantasyPros 31.4), tied 3rd in the last three seasons (29.6), "all within a single point" of the leaders. |
| *"We Analyzed 11 Seasons of DFS Projections"* (2026-09-09) and the live page *"Which DFS Projections Are Most Accurate?"* (updated April 2026) | **Weekly** projections, 2015–2025, 9 sources (CBS, ESPN, NumberFire, FantasyPros, FFToday, FantasySharks, NFL, FFA Average, FFA Weighted); "top 20 quarterbacks and tight ends and the top 40 running backs and wide receivers each week, based on projected points"; "over 6,000 source and week combinations"; MAE, coefficient of variation, mean error; a source needs ≥ 8 weeks/season and ≥ 7 seasons | **QB: 6.38 MAE full / 6.44 last 3 seasons — bottom** (best: FantasyPros 6.20 full, CBS 6.13 recent). **RB: 5.23 / 5.31 — lower half** (best 5.20 / 5.06). **WR: 5.05 / 5.18 — lower-middle** (best FFA Weighted 4.94 / FantasyPros 4.84). **TE: 3.85 full — best of all nine sources**, 3.71 recent (still best), but "dead last" in week-to-week consistency (35.50 % CV). Headline: "The FFA Average, a simple average of all available projection sources, outperformed individual sources in 63% of head-to-head comparisons." |
| FantasyPros *"Most Accurate Experts (2025)"* (2026-01) | In-season **rankings** (not projections), weeks 1–17, 159+ experts, error vs actual finish; ESPN's site projections are **not** evaluated | Top ten: Boone (Yahoo), Thorman (ETR), Calandro (RotoBaller), Gimino, Ratcliffe (FTN), Del Don, Hanson, Waziak, Orginski, Zylak — **no ESPN-affiliated ranker** among them [V-docs]. |

Reading: the spread between sources is small (weekly QB 6.13 vs 6.44 MAE ≈ 5 %); ESPN is a legitimate mid-pack source whose weekly TE numbers are the best measured and whose QB numbers are the worst measured; and the best available "source" is an average. That is exactly the case for treating ESPN's projection as **one input to an ensemble, never the sole number**, while still displaying it verbatim as "ESPN's projection" because it is the figure every league member sees. **What no study measures:** accuracy under *this league's* scoring (half-PPR, 5-pt passing TD) — ESPN's `appliedTotal` is the only projection that is already expressed in it — and ESPN's rest-of-season figure. The backtest design that fills that gap is below.

**Cadence and semantics observed today** [V-observed P11]:

- **Every remaining week already has a projection.** Weekly projections `(statSourceId 1, statSplitTypeId 1, seasonId 2026, scoringPeriodId w)` exist for **w = 1 … 18 on 298–299 of 300** players (week 4: 299 present, 264 non-zero; week 5: 299 present, 253 non-zero); weeks 19–22 exist for the 25 kickers only. So "when do weekly projections first appear" is answered: they are all there from the start of the season; the operational question is when they are *revised*, and ESPN's own answer is "always … leading up to kickoff" [V-docs above]; rankings "will be published every Tuesday … and are updated throughout the week for news and emerging analysis" [V-docs, ESPN week-4 RB rankings page, 2026-09-29 09:56 ET, eight authors]. An intra-day drift measurement is in §B.1.8/P28.
- **The "season" projection is rest-of-season.** For 272/299 sampled players the `(1, 0, 2026, 0)` `appliedTotal` equals the sum of the weekly projections for weeks 4–18 to within 0.2 pt (e.g., Gibbs 365.71 vs 365.7; Bijan Robinson 294.05 vs 294.0). It is not a full-season figure. Season actuals `(0, 0, 2025, 0)` equal the sum of 2025 weekly actuals for 275/275 (sanity check passes).
- **`statSplitTypeId 2`** (`id "122026"`, 03 §B.2 [U]) is neither actual + ROS nor the weekly sum; its ratio to the ROS figure ranges 0.008–4.24 (median 1.14) — the pattern of a **frozen preseason full-season projection** (e.g., Gibbs 386.3, ADP 1.78). Stays [U] as a label; do not present it as ROS.
- Top week-4 projections in the sample: Gibbs 26.18, Josh Allen 22.26, Bijan Robinson 21.51, Lamar Jackson 21.14, Smith-Njigba 20.97 (PPR template scoring). The sibling saw Gibbs 26.2 on the same path 2026-09-29 evening (Y-04 §B5) — unchanged over ~7 hours on a Tuesday, consistent with revisions clustering around news and kickoff.
- Header `cache-control: max-age=5` on the `kona_player_info` response (vs `max-age=300` on `players_wl` and `proTeamSchedules_wl`) — ESPN itself treats the player pool as near-live.

**Backtest design the plan should include (because no published number covers this league's scoring):**

1. *Retrospective, this week:* page the full `leaguedefaults/3` pool (count header 1,050, `limit ≤ 100` with a sort, 03 §A.3); for every player take `(1,1,2025,w)` vs `(0,1,2025,w)` for w = 1–18 (both embedded, P11); compute MAE/R² by position under the template scoring, restricted to the top-N projected per week the way FFA does, and compare with FFA's published ESPN numbers to check the embedded 2025 projections are the as-of-kickoff ones ([U] until this agrees).
2. *Prospective, all season:* snapshot the league-path `kona_player_info` weekly projections (`appliedTotal` under **the league's** scoring) on Tuesday 06:00 ET, Thursday 18:00 ET and Sunday 11:00 ET; score each snapshot against actuals from nflverse `stats_player_week` (join `espn_id → gsis_id`, §C) re-scored with the league's rules, and against ESPN's own `(0,1)` actuals; report MAE by position and by snapshot age. This measures both accuracy and the value of ESPN's late revisions.
3. *Ensemble:* fit position-level weights for {ESPN, own usage/EP model} on the prospective set; default to the simple average until eight weeks of data exist (FFA's finding that equal weights match tuned weights).

#### B.1.2 Ownership, % started, ownership change, ADP, auction — grade **Primary**

`player.ownership` carries `percentOwned, percentStarted, percentChange, averageDraftPosition, averageDraftPositionPercentChange, auctionValueAverage, auctionValueAverageChange, activityLevel, leagueType, date` on all 300 sampled players [V-observed P11]. `date` is an epoch-ms snapshot timestamp: **`2026-09-30T03:30:19Z` (23:30 ET) on the 03:59Z pull; the earliest value in the sample was `01:30:21Z`** — two snapshots two hours apart, i.e., ESPN recomputes ownership at least every two hours on a Tuesday night (whether hourly on game days is [U]). Examples: Gibbs 99.94 % owned / 99.8 % started / −0.01 change / ADP 1.78. `players_wl` (2,663 active players, `max-age=300`) carries `percentOwned` for the whole universe in one 664 KB request (P09). This is the population the user's league is drawn from, which makes it strictly better than Sleeper's trending counts for "who is being added on ESPN"; Sleeper stays Secondary as an independent, differently-populated signal (Y-04 §B4, non-commercial).

#### B.1.3 Ranks — grade **Secondary**

`player.rankings` has keys for weeks `0` (season) and `1`–`4`; week-4 entries are `published: true` by Tuesday night; `rankSourceId ∈ {0, 3, 5, 6, 7, 9, 10, 11, 12}`; id 0 carries `averageRank` (the consensus), the other **eight** ids carry individual ranks — and ESPN's week-4 rankings page lists exactly **eight** named rankers (Bowen, Clay, Cockcroft, Dopp, Karabell, Loza, Moody, Yates) [V-observed P11 + V-docs rankings page]; the id → name mapping is [U]. `draftRanksByRankType` has `STANDARD, PPR, ELIMINATION, SUPERFLEX`; `ratings["0"]` gives `positionalRanking, totalRanking, totalRating` (Gibbs: 1 / 2 / 98.3) [V-observed]. No accuracy evidence exists for ESPN's rankers as a group (no ESPN name in FantasyPros' 2025 top ten, §B.1.1). Use them as "what ESPN's analysts say", cited by source id, next to the ensemble — not as the decision.

#### B.1.4 Injury status — grade **Secondary** (Primary for "what the league UI will do")

Over the top-300: `ACTIVE` 229, `null` 27, `INJURY_RESERVE` 19, `QUESTIONABLE` 15, `OUT` 5, `DOUBTFUL` 4, `DAY_TO_DAY` 1; `injured: true` on 24 [V-observed P11]. Enumeration matches 03 §B.2. It has **no timestamp** (cadence [U]; `lastNewsDate` co-moves in practice but that is an inference) and no practice-participation detail, so official Wed/Thu/Fri practice reports must come from nflverse `injuries` (daily 07:00 UTC / 03:00 ET, Y-04 §E). Keep ESPN's status as the authoritative view of *what the league's lineup/IR rules will enforce*, and nflverse for *why*.

#### B.1.5 News / outlook text — grade **Primary for per-player outlook; untrusted input**

`seasonOutlook` present on 255/300 (median 697 characters); `outlooks.outlooksByWeek` present for weeks 2, 3 and 4 on 252 / 252 / 242 players — the **week-4 paragraph already exists for 81 % of the top-300 on Tuesday night**; `lastNewsDate` present on 273/300, of which 53 within 24 h, 228 within 3 days, 253 within 7 days; the latest `lastNewsDate` in the sample was `2026-09-30T02:52:57Z` (22:52 ET), one hour before the pull [V-observed P11]. Across the whole 2,663-player `players_wl` universe, `lastNewsDate` is set on 2,459, with 106 in the last day, 403 in 3 days, 557 in 7 days, 1,080 in 30 days (P09). Style sample (week-4 outlook, Gibbs): a matchup-framed editorial paragraph ("…will look to keep his touchdown tear alive as the Lions travel to Carolina in Week 4…"). This is richer than any free feed the sibling found (RotoWire RSS: 5 items ≈ 200 chars; ESPN RSS: headlines only, Y-04 §B10), but it is **editorial free text under ESPN's control**: length-cap, delimit, never let it carry instructions (03 §B.5). Breaking news (a Sunday-morning inactive) is not what this field is for — pair it with `lastNewsDate` as a change signal and the RSS feeds for headlines. ESPN's article endpoint on `site.api.espn.com` remains 403 (03 §A.1); not retried.

#### B.1.6 Pro-team schedule and byes — grade **Primary** (and the join key to nflverse)

`…/seasons/2026?view=proTeamSchedules_wl` (P10; 109,067 B; CloudFront hit, `age 212`, `max-age=300`): 33 `proTeams` (32 + FA), each with `byeWeek` and `proGamesByScoringPeriod{week: [{id, date, homeProTeamId, awayProTeamId, scoringPeriodId, startTimeTBD, validForLocking, statsOfficial}]}` — **272 distinct games, weeks 1–18** [V-observed]. Compared with nflverse `games.csv` 2026 (272 `REG` games, P03/P06) [V-observed]:

| Check | Result |
|---|---|
| Bye weeks, 32 teams (ESPN `WSH`/`LAR` → nflverse `WAS`/`LA`) | **0 mismatches** |
| ESPN game `id` vs nflverse `espn` column | **272/272 match** — join by id, never by team + date |
| Home/away/week per game | **272/272 identical** |
| Kickoff time (`date` ms vs `gameday`+`gametime` ET) | identical for **248**; the **24 `startTimeTBD: true` games** (wk 16: 4, wk 17: 4, wk 18: 16) sit at a placeholder ≈ 10 h earlier than nflverse's `13:00` placeholder — never display an ESPN `date` when `startTimeTBD` is true |
| `statsOfficial: true` | exactly **48** = the 48 completed games of weeks 1–3 → "final and stats official" (inference from the count) |
| `validForLocking: true` | exactly **248** = 272 − 24 TBD → "kickoff time known, lineup lock computable" (inference from the count) |

This resolves the semantics 03 §G.1 #11 left open, by count rather than by documentation, so it stays an inference. nflverse adds what ESPN lacks — `roof`, `surface`, `away/home_rest`, `div_game`, QB names, lines (79/272 filled; all 16 week-4 games), actual `temp`/`wind` (33/272, played outdoor games only) — and, because the ids match, the join is exact. Week-4 example: ESPN `401872964` = nflverse `2026_04_PIT_CLE`, 2026-10-01 20:15 ET, spread −2.5, total 38.5.

#### B.1.7 Live scoring — grade **Primary** in-game

ESPN Fan Support, *Scoring & Stat Corrections* (updated 2026-08-18) [V-docs]: "During the game, scores/stats are updated as they are received. This information may change as the league reports more accurate data." Corrections: "Most of the time when inaccurate data is detected, the incorrect score/stat is corrected within minutes. Rarely, incorrect scores/stats may not be corrected until the next day. This type of stat correction can appear up to seven (7) days after the game was played." The wire shapes are in 03 §B.7 (`mMatchupScore` live totals and win probability; `mBoxscore` per-player actual `stats[]` entries appearing alongside the projection once a game starts) [V-observed there, before kickoff]. A per-play latency figure does not exist anywhere I could find; a community repository that audited "ESPN current scoring availability" concluded "Any claim such as 'ESPN updates within N minutes' would currently be unsupported" [V-community, Lolindhir/fantasy-app #669, Sept 2026]. Request cost: one `mMatchupScore` (213 KB) or `mBoxscore` (325 KB) per poll; 03 §D.3 proposes a 60 s TTL inside game windows computed from `proTeamSchedules_wl` `date`s — with `validForLocking`/`statsOfficial` now interpretable, "in progress" = `validForLocking && !statsOfficial && now ≥ date`. Compared alternatives [V-observed]: the ESPN site scoreboard (P14) returns game `status.type.state` (`pre/in/post`), clock, period, line scores and leaders with `cache-control: max-age=4` — useful as a game-state signal, but it is a second unofficial host that the sibling saw 403 with any query string (Y-04 §B5), and the bare URL still reports week 3 tonight; Sleeper's undocumented `stats/nfl/2026/{week}` (P13/P17) returned `[]` for week 4 with `s-maxage=4` (a live-week cache hint) and 177 Sportradar-sourced week-3 RB rows with `last_modified` epoch and `off_snp`, `rec_rz_tgt`, `rush_rz_att`, `pts_*` with `s-maxage=300`; Sleeper's support page says "Our data provider will update stats throughout live games and then run any stat corrections as needed over the next couple of days … Corrections can occur up to and including Thursdays" [V-docs]. nflverse is post-game only. So for a fantasy-points-during-the-game view there is one answer — ESPN's own league views — with the other two as independent game-state or sanity signals.

#### B.1.8 Intra-day drift check (P28)

See §H row 28: a second 5-player pull ~20 minutes after P11 to record whether `appliedTotal` (weeks 4 and 5) or `ownership.date` moved on a quiet Tuesday night. Result recorded in that row and in `docs/scratch/data-source-evaluator.md`.

#### B.1.9 What remains unverified about ESPN-native data

Collected in §G items 1–9: as-of-kickoff status of the embedded 2025 projections; `rankSourceId` names; `statSplitTypeId 2`; in-game latency and `mLiveScoring` with cookies; ownership cadence on game days; `injuryStatus` cadence; accuracy under this league's scoring; `teamPlayersByPosition`; the 27 sampled players whose ROS ≠ weekly sum.

### B.2 nflverse-data — the backbone (reused, plus what changes for ESPN)

Everything in Y-04 §B1 stands (licence CC-BY 4.0; releases, schemas, cadence, breaking-change history). Re-verified today via the releases API [V-observed P01–P04]:

| File | `updated_at` (UTC) | Size | Δ vs sibling's observation |
|---|---|---|---|
| `stats_player/stats_player_week_2026.csv` | 2026-09-29T15:45:48Z | 1,487,226 B | same build (sibling: 15:46Z, 1.49 MB) — no Tuesday-night rebuild |
| `injuries/injuries_2026.csv` | 2026-09-29T13:59:26Z | 83,478 B | same |
| `schedules/games.csv` | **2026-09-30T03:46:30Z** | 2,182,348 B | rebuilt again (sibling saw 02:36Z) — the 5-minute cadence is real; lines 79/272, week 4 16/16 |
| `weekly_rosters/roster_weekly_2026.csv.gz` | 2026-09-29T14:03:35Z | 445,121 B | same; weeks 1–4 |

ESPN-specific value that the sibling had no reason to stress: (a) `roster_weekly` `espn_id` is near-complete (§C); (b) `depth_charts` is ESPN-sourced and keyed by `espn_id` + `gsis_id` (Y-04 §B1) — a direct join; (c) `schedules.espn` is the ESPN game id (272/272, §B.1.6); (d) `espn_data/qbr_week_level` exists. GitHub API budget: unauthenticated 60 req/h, 56 remaining after four calls — poll `timestamp.txt` (24 B) instead.

### B.3 ffopportunity — Secondary for needs 4, 5, 12 (Y-04 §B2; CC-BY-SA 4.0). Not re-probed.

### B.4 DynastyProcess `db_playerids.csv` — Secondary for need 16, with a licence finding

[V-observed P07, P15, P16]: 2,633,236 B, 12,508 rows, 35 columns (schema as Y-04 §B3; `NA` literals; MFL-style team codes). Last three commits to the file: 2026-09-25T05:10:03Z, 09-18T04:57:58Z, 09-11T04:55:56Z — "Automated Player ID pipeline", Fridays ≈ 01:00 ET. **The repository's `LICENSE` is GPL-3.0** (GitHub licence API, `spdx_id: GPL-3.0`) — this resolves Y-04 §H #6 ("licence not stated") in the least convenient direction: the only stated terms are a copyleft software licence applied to a data file. Counts: skill players with a non-FA team 1,481 (the sibling's 1,549 included `FA`): `espn_id` 1,100, `gsis_id` 1,084, `yahoo_id` 722, `sleeper_id` 982; **2026 rookies (draft_year 2026): `espn_id` 121/121**, `gsis_id` 119. Joined to the nflverse active skill roster on `gsis_id`: **497 agree, 0 conflict, 0 fills** — for ESPN it is a mirror of nflverse, not an independent source. Recommendation in §E: do not ship it.

### B.5 Sleeper API — Secondary/Fallback (Y-04 §B4 terms and defects stand)

[V-observed P08, P12, P13, P17]: `players/nfl` 2,572,742 B on the wire (14,661,297 B decompressed), 12,229 players, `s-maxage=600`; among 824 active skill players with a team: `espn_id` **205 (25 %)**, `gsis_id` 157, `yahoo_id` 212, `sportradar_id` 813, `rotowire_id` 812; `years_exp = 0`: **0/150 have an `espn_id`**. Joined on trimmed `gsis_id`: 103 agree, 0 conflict, **0 fills**. `state/nfl`: `week 4, display_week 3, season_start_date 2026-09-09, season_has_scores true`. The undocumented `api.sleeper.com/stats/nfl/{season}/{week}` (§B.1.7) is Sportradar-sourced actuals with snap and red-zone counts — a useful sanity feed, never a dependency (undocumented, non-commercial).

### B.6 The Odds API — Secondary for need 8 (Y-04 §B6). Not re-probed.

### B.7 Open-Meteo and NWS — Primary/Secondary for need 9 (Y-04 §B7, §B8). Not re-probed.

### B.8 ESPN core and site APIs (`sports.core.api.espn.com`, `site.api.espn.com`) — Fallback, unofficial

The sibling verified on 2026-09-29 that the core API's week-4 events carry `weather` (AccuWeather-linked forecast with temperature, wind, gust, precipitation, `lastUpdated`) and an `odds` ref (DraftKings, spread and total, open/current) with no key, and that `site.api.espn.com` answers 403 to any query string from its network (Y-04 §B5) [V-observed there]. Today the bare site scoreboard returned 200 (P14). These hosts sit under the same Disney Terms of Use as the fantasy host (03 §D.1) but are separate infrastructure with their own edge rules (the news endpoint on `site.api` is already 403 to scripts, 03 §A.1). Verdict unchanged from the sibling: **not a production dependency**; for the ESPN product they are a convenience fallback for weather/odds/game state that adds nothing nflverse + Open-Meteo/NWS + The Odds API do not provide with clearer terms.

### B.9 FantasyPros — Secondary (paid, personal-use) for needs 12 and 14 (Y-04 §B9; pricing stands). Its 2025 accuracy results are cited in §B.1.1.

### B.10 News RSS — Secondary for headlines (Y-04 §B10). Not re-probed. Note that ESPN's RSS is also a Disney Product (same ToU as the API).

### B.11 Paid tiers, dead sources, do-not-use — Y-04 §B11–§B14 and §F stand unchanged.

---

## C. The ESPN player-ID crosswalk study (exact counts, file dates)

**Frame.** nflverse `roster_weekly_2026.csv.gz`, `updated_at` 2026-09-29T14:03:35Z (P04/P05): 10,562 rows, 36 columns, weeks 1–4; week 4 has 2,526 rows (`ACT` 1,692, `DEV` 525, `RES` 279, `RET` 23, `EXE` 5, `CUT` 2) [V-observed].

| Population (week 4, `status = ACT`) | n | `espn_id` | `gsis_id` | `sleeper_id` | `pfr_id` | `yahoo_id` (for comparison) |
|---|---:|---:|---:|---:|---:|---:|
| QB/RB/WR/TE | **500** | **497 (99.4 %)** | 500 | 490 | 497 | 338 |
| QB/RB/WR/TE/K (the sibling's frame) | **532** | **529 (99.4 %)** | 532 | 519 | 529 | 362 (= Y-04 §D) |

- **Missing `espn_id` = 3**, all deep-bench: two 2026 rookies (a NYJ WR, a NE TE) and one 2025-class TE (GB). **2026 rookies: 75 of 77 QB/RB/WR/TE (78 of 80 with K) have an `espn_id`** — the exact opposite of the Yahoo picture (0/80). No duplicate `espn_id` among active skill players; 2,057 distinct `espn_id`s across all 2026 roster rows, each with one `gsis_id` [V-observed].
- **DynastyProcess** (file dated 2026-09-25T05:10Z): on `gsis_id`, 497 agree / 0 conflict / **0 fills**; its 2026 rookies carry `espn_id` 121/121, but none of the three gaps (§B.4).
- **Sleeper** (`players/nfl`, 2026-09-30T03:59Z, 600 s CDN): `espn_id` on 25 % of active skill players, 0 % of rookies; 103 agree / 0 conflict / **0 fills** (§B.5).
- **From ESPN's side** (`players_wl`, 2,663 active players, count header 2,663, P09): 960 QB/RB/WR/TE, of which **621 have a pro team**. Of those 621: in nflverse 603, in DynastyProcess 613, in Sleeper 160, **union 613, unmatched 8 — every one of the 8 has `percentOwned` 0.0**. Restricted to players anyone owns: **`percentOwned ≥ 1 %`: 259/259 matched; ≥ 10 %: 188/188; ≥ 50 %: 139/139.** Only 1 active nflverse skill `espn_id` is absent from ESPN's active list.

**Recommended join strategy (replaces the sibling's matcher-first plan, Y-04 §D):**

1. **Canonical key stays `gsis_id`** (100 % of nflverse rows; ffopportunity, NGS, injuries, depth charts, Sleeper after trim, DynastyProcess). ESPN `player.id` is the *entry point* — every ESPN payload gives it — and the table `espn_id → gsis_id` is built from **nflverse `roster_weekly_{season}`** (all weeks, all statuses: 2,057 pairs today), refreshed daily after 07:00 UTC, persisted with `first_seen`, `source = nflverse`, `confidence = 1.0`. `depth_charts` and `schedules.espn` join on ESPN ids directly with no table at all.
2. **Fallback for a missing pair:** nflverse `players.csv` (`espn_id`, `gsis_id`, 24,834 rows, Y-04 §B1) for retired/inactive players a league might still roster on IR; then a **deterministic name + team + position match** against `roster_weekly` (normalise as Y-04 §D step 2: lowercase, strip punctuation and Jr/Sr/II/III/IV, ASCII-fold; ESPN `WSH`/`LAR` → `WAS`/`LA`; ESPN position ids 1–4 → QB/RB/WR/TE; jersey to break ties; never name-only), flagged `confidence = 0.8` and surfaced in `health` as "matched by name".
3. **Manual override file** for the residue (expected size: single digits — today it would hold 3 names, none rostered anywhere).
4. **Do not ship DynastyProcess** (adds 0 pairs; GPL-3.0, §E) and do not use Sleeper for ESPN ids (25 %). Sleeper's `sleeper_id` is still useful for its trending endpoint — take it from `roster_weekly` (490/500), not from Sleeper's `espn_id`.
5. **Alert rule:** count rostered or ≥ 1 %-owned ESPN players without a confidence-1.0 pair; today that count is 0, so any non-zero value is a data-quality event, not a routine gap.

Known defects to code around: Sleeper `gsis_id` leading space (Y-04 §B4); DynastyProcess `NA` literals; nflverse `depth_charts` has no `week` column (Y-04 §B1); ESPN position ids vs slot ids are different numberings (03 §B.2).

---

## D. Freshness map — when each source changes, in ET, in season

| When (ET) | What | Evidence |
|---|---|---|
| **Continuous, cache 5 s** | ESPN player pool (`kona_player_info`): projections "always … updated inside the game leading up to kickoff"; `lastNewsDate` moves through the evening (latest 22:52 ET Tue) | P11 headers; ESPN playbook [V-docs]; §B.1.5 |
| **Every 2 h (observed 21:30, 23:30 ET Tue); game-day rate [U]** | ESPN `ownership.*` snapshot (`ownership.date`) | P11 |
| **Tuesday morning, then "throughout the week"** | ESPN weekly rankings (`rankings[week]`, `published: true`) and weekly outlook paragraphs (week-4 text on 81 % of top-300 by Tue 23:59 ET) | ESPN rankings page [V-docs]; P11 |
| **As received during games; corrections "within minutes", up to 7 days** | ESPN fantasy points (`mMatchupScore`, `mBoxscore`) | ESPN Fan Support [V-docs]; 03 §B.7 |
| **Every 5 min (cache 300 s)** | ESPN `proTeamSchedules_wl` (kickoffs, `validForLocking`, `statsOfficial`), `players_wl` | P09/P10 headers |
| **Every ~5 min** | nflverse `schedules` (scores, lines, kickoffs) — rebuilt 22:36 and 23:46 ET tonight | P03; Y-04 §E |
| **Within ~15 min after each game; then nightly (observed 11:46 ET Tue)** | nflverse `pbp`, `stats_player_week`, `stats_team_week` | Y-04 §E; P01 |
| **~03:00 ET daily (observed 09:59–10:03 ET)** | nflverse `injuries`, `depth_charts`, `roster_weekly` (→ the `espn_id` table) | Y-04 §E; P02/P04 |
| **~20:00 / 02:00 / 08:00 / 14:00 ET** | nflverse `snap_counts`, `pfr_advstats`, `ftn_charting` | Y-04 §E |
| **Nightly 03–05 ET** | NGS | Y-04 §E |
| **~07:35 ET daily** | ffopportunity `ep_weekly` | Y-04 §E |
| **Every 10 min (CDN)** | Sleeper `players`, `state/nfl`, trending; undocumented `stats` 4 s during the live week, 300 s after | Y-04 §E; P12/P13/P17 |
| **Hourly at most per venue** | Open-Meteo / NWS forecasts | Y-04 §E |
| **Fridays ~01:00 ET** | DynastyProcess ids (not shipped) | P16 |
| **Wed/Thu/Fri practice, Fri/Sat game status** | NFL injury-report rhythm inside nflverse `injuries`; ESPN `injuryStatus` follows with no timestamp | Y-04 §E; §B.1.4 |
| **Once per season** | ESPN league settings (`mSettings`, 03 §B.1), `participation`, draft ids, stadium table | Y-04 §E; 03 |

Week boundary tonight: nflverse stats have weeks 1–3; `roster_weekly` has week 4; ESPN's default template is on `scoringPeriodId 4` with week-5 projections already populated; Sleeper says `week 4, display_week 3`; the ESPN site scoreboard still says week 3.

---

## E. Licensing / ToS table and the personal-vs-commercial constraints

| Source | Terms (evidence) | Personal, single-league tool (this project) | If ever distributed commercially |
|---|---|---|---|
| **ESPN fantasy read host** (and any `*.espn.com` API or RSS) | Disney Terms of Use, updated 2024-05-24: §2.B.x bars automated access "for the purposes of creating or developing any AI Tool, data mining or web scraping"; §2.A excludes "prompting … any artificial intelligence … tool"; **§2.B.viii bars "any commercial or business-related use or build a business utilizing the Disney Products … whether or not for profit"**; §1.H allows suspension (03 §D.1 [V-docs]) | Inside the literal text (03 §D.4). Accepted, mitigated risk: own account, own league, read-mostly, tens of requests/day, honest UA, no redistribution, no training (03 §D.3–D.4). No enforcement case found in seven years (03 §D.2). | **Hard stop.** §2.B.viii is explicit, independent of automation, and there is no ESPN licence or developer programme to buy (03 §D.1). A commercial ESPN-data product cannot be made ToS-clean; this dominates every other row. |
| nflverse-data | CC-BY 4.0 (`LICENSE.md`, Y-04 §B1) | Attribute in `README`/`health` | Attribute; otherwise free |
| FTN charting via nflverse; ffopportunity | CC-BY-SA 4.0, attribute "to FTN Data via nflverse" / ffverse (Y-04 §B1, §B2) | Attribute | Attribute; any *redistributed derived dataset* must stay CC-BY-SA (share-alike attaches to the data, not to the server code) |
| **DynastyProcess `db_playerids.csv`** | **GPL-3.0** repository licence (P15 [V-observed]); README says it exists "for the purpose of supporting apps and developers" (Y-04 §B3) | Fine to read locally; **not needed** (adds 0 ESPN pairs, §C) | Do not ship the file: distributing a GPL data file with a product invites copyleft arguments over the combined work ([U] legally) — moot if it is never used |
| Sleeper API | "free to use for non-commercial purposes"; commercial by arrangement (Y-04 §B4 [V-docs]) | Fine | Licence or drop; ESPN-native ownership already replaces its main use (§A #13) |
| Open-Meteo | CC-BY 4.0 data; free API "only … for non-commercial purposes" (Y-04 §B7 [V-docs]) | Fine | Switch to NWS (US venues) or a paid plan |
| NWS `api.weather.gov` | US-government, public domain; needs `User-Agent` (Y-04 §B8) | Fine | Fine |
| The Odds API | free 500 credits/mo; storing allowed; display "including for commercial use" OK; no resale as a data product (Y-04 §B6 [V-docs]) | Fine | Fine within its terms |
| FantasyPros API | Free tier "Non-production"; $8.99/mo "Personal-use license"; commercial custom (Y-04 §B9 [V-docs]) | Personal tier if ever adopted | Commercial contract |
| Sportradar (upstream of Sleeper `stats`) | not our counterparty; reached only through Sleeper's undocumented host | dev/sanity only | Do not use |
| Pro-Football-Reference direct | 20 req/min jail; no AI prompting; no competing data store (Y-04 §B12 [V-docs]) | Do not scrape (nflverse's release is the path) | Same |

**Restated for this repo.** As a personal, single-league tool the binding constraints are the ones the sibling named (Y-04 §G-3) *plus* the ESPN one: attribute nflverse/FTN/ffverse; keep Sleeper and Open-Meteo non-commercial; accept the Disney ToU exposure with the 03 §D mitigations. The moment the project is distributed commercially, the order of problems inverts: Sleeper and Open-Meteo are swappable (Sleeper's role is already covered by ESPN-native ownership; Open-Meteo by NWS), FTN/ffverse need attribution and share-alike on redistributed data, DynastyProcess should simply not be shipped — but **the ESPN data itself is not licensable under the published terms**, so "commercial ESPN Fantasy MCP" is not a product this stack can make honestly. Design consequence: keep ESPN-derived data and non-ESPN data in separable layers so the non-ESPN analytics (nflverse-based) could be reused elsewhere.

---

## F. Delta versus the sibling (what changed because this is ESPN)

1. **Projections: from "none free & legal" to "one free, zero-marginal-risk, mid-pack source that must be ensembled".** ESPN's weekly projection exists for every remaining week, is revised through kickoff, is expressed in the league's own scoring, and is measured (weekly) best-of-nine at TE and worst at QB (§B.1.1). The sibling had to build its number from scratch; here the plan builds the same usage/EP model and *averages it with ESPN's*, and can backtest ESPN's 2025 accuracy from ESPN's own payload before the season is out.
2. **The crosswalk is a lookup, not a matcher.** nflverse `espn_id` covers 497/500 active skill players and 100 % of anyone ≥ 1 %-owned; 2026 rookies are 75/77 covered. The sibling's name-matcher (needed for 32 % of players) becomes a 3-player fallback. DynastyProcess is unnecessary — which also sidesteps its GPL-3.0 licence.
3. **Bye weeks and schedule come from ESPN, verified identical to nflverse, with an exact game-id join.** `proTeamSchedules_wl` needs no league id or cookie, and `games.csv.espn` matches all 272 ESPN game ids, so lines, rest days, roof/surface and actual weather attach by id.
4. **Ownership/trending: ESPN's own population replaces Sleeper as Primary**, with snapshot timestamps every two hours — removing a non-commercial dependency from the critical path.
5. **Live in-game scoring is a new need, and ESPN-native is the only real answer**; Sleeper's undocumented stats and the ESPN site scoreboard are sanity/game-state signals; nflverse remains the post-game record.
6. **Per-player news text is ESPN-native** (weekly outlook paragraphs on 81 % of top-300 by Tuesday night, `lastNewsDate` as a change signal); RSS drops to breaking headlines. The injection surface grows accordingly (03 §B.5).
7. **Injury status: ESPN's enum is what the league enforces**, nflverse `injuries` is why — two sources with different jobs, not a Primary/Fallback pair.
8. **Licensing: the binding commercial constraint moves from Sleeper/Open-Meteo to Disney ToU §2.B.viii.** The non-commercial rows are swappable; the ESPN row is not.
9. **nflverse `depth_charts` is ESPN-keyed** — a free direct join the Yahoo program could not use.
10. Freshness re-verified: `stats_player_week_2026` and `injuries_2026` unchanged since the sibling's pull; `games.csv` rebuilt twice in an hour (5-minute cadence confirmed).

---

## G. Unverified — by name

1. Whether the **2025 weekly projections embedded** in `kona_player_info` are the as-of-kickoff values or regenerated (decides whether the retrospective backtest in §B.1.1 is valid; step 1 of that design tests it).
2. The **`rankSourceId` → analyst** map (8 ids ↔ 8 named rankers is a count coincidence until confirmed).
3. **`statSplitTypeId 2`** semantics (evidence points to a frozen preseason full-season projection; 03 §G.1 #7 stays open).
4. **ESPN in-game latency** in minutes (ESPN says "as they are received"; no measurement exists); what `mLiveScoring` adds with cookies (03 §G.1 #5).
5. **Ownership snapshot cadence on game days** (two snapshots two hours apart seen on a Tuesday night).
6. **`injuryStatus` update cadence** and whether `lastNewsDate` moves with it.
7. **ESPN projection accuracy under this league's scoring** (half-PPR, 5-pt passing TD) — every published number is under FFA's scoring; the prospective backtest is the remedy.
8. `proTeamSchedules_wl.teamPlayersByPosition` — not examined.
9. The 27 sampled players whose rest-of-season figure differs from the weekly sum by > 0.2 pt (K with weeks 19–22? injured? not inspected).
10. Whether the `leaguedefaults/3` pool (count 1,050) is representative of a real league's pool (951 in 03 P24).
11. **Sleeper `stats` in-game refresh rate** (`s-maxage=4` was seen only on the empty week-4 response) and whether it stays reachable (undocumented host).
12. **GPL-3.0 reach over DynastyProcess data** if it were redistributed (moot while unused).
13. ESPN core-API weather/odds **today** — cited from the sibling's 2026-09-29 probe, not re-probed.
14. Whether `startTimeTBD` games' placeholder `date` is always ~10 h before nflverse's placeholder or varies.
15. Carried over from Y-04 §H because this document relies on them: which sportsbook feeds nflverse lines (#1); The Odds API live payload (#4); parquet schemas assumed identical to CSV (#8); nflverse `stadium_id` coordinates (#7).
16. Carried over from 03 §G.1 and load-bearing here: `If-None-Match` → 304 (#10), when `lineupLocked` flips (#11), private-league 401 body (#1).

---

## H. Probe log (28 requests, anonymized; all `GET`, no cookies, `User-Agent: espn-ff-mcp-research/0.1 (+repo URL)`)

`R` = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl`. Times UTC, 2026-09-30. Redirect hops (GitHub → `objects.githubusercontent.com`, DynastyProcess → `raw.githubusercontent.com`) are counted inside the row.

| # | time | URL | status | bytes | note |
|---|---|---|---|---|---|
| 01 | 03:59:13 | `api.github.com/repos/nflverse/nflverse-data/releases/tags/stats_player` | 200 | — | `stats_player_week_2026.csv` 1,487,226 B, `updated_at` 2026-09-29T15:45:48Z; `timestamp.txt` 15:46:05Z; `x-ratelimit-remaining: 59` |
| 02 | 03:59:13 | `…/releases/tags/injuries` | 200 | — | `injuries_2026.csv` 83,478 B, 2026-09-29T13:59:26Z |
| 03 | 03:59:14 | `…/releases/tags/schedules` | 200 | — | `games.csv` 2,182,348 B, **2026-09-30T03:46:30Z** |
| 04 | 03:59:14 | `…/releases/tags/weekly_rosters` | 200 | — | `roster_weekly_2026.csv.gz` 445,121 B, 2026-09-29T14:03:35Z |
| 05 | 03:59:15 | `github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2026.csv.gz` | 200 | 445,121 | 1 redirect; 10,562 rows, 36 cols, weeks 1–4 |
| 06 | 03:59:15 | `…/releases/download/schedules/games.csv` | 200 | 2,182,348 | 1 redirect; 272 REG games 2026 |
| 07 | 03:59:15 | `github.com/dynastyprocess/data/raw/master/files/db_playerids.csv` | 200 | 2,633,236 | 1 redirect; 12,508 rows, 35 cols |
| 08 | 03:59:16 | `api.sleeper.app/v1/players/nfl` | 200 | 2,572,742 on wire (14,661,297 decompressed) | gzip; `s-maxage=600`; 12,229 players |
| 09 | 03:59:16 | `R/seasons/2026/players?view=players_wl` + `X-Fantasy-Filter: {"filterActive":{"value":true}}` | 200 | 663,713 | JSON array, 2,663 players; `x-fantasy-filter-player-count: 2663`; `max-age=300`; CloudFront miss |
| 10 | 03:59:18 | `R/seasons/2026?view=proTeamSchedules_wl` | 200 | 109,067 | 33 proTeams, 272 games; `max-age=300`; CloudFront hit, `age 212` |
| 11 | 03:59:20 | `R/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=4` + `{"players":{"limit":300,"offset":0,"sortPercOwned":{"sortPriority":1,"sortAsc":false}}}` | 200 | **11,557,824** | **exceeds the 5 MB sample cap** (38.5 KB/player: all 2025 + 2026 weekly splits embedded); `x-fantasy-filter-player-count: 1050`; `max-age=5`; no `positionAgainstOpponent` on this path |
| 12 | 03:59:20 | `api.sleeper.app/v1/state/nfl` | 200 | 211 | `week 4, display_week 3, season_start_date 2026-09-09` |
| 13 | 03:59:21 | `api.sleeper.com/stats/nfl/2026/4?season_type=regular&position[]=RB&order_by=pts_ppr` | 200 | 2 | `[]`; `s-maxage=4` |
| 14 | 03:59:21 | `site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` (bare) | 200 | 157,355 | week 3, 16 events all `STATUS_FINAL`; `max-age=4`; no `odds`/`weather` keys |
| 15 | 03:59:22 | `api.github.com/repos/dynastyprocess/data/license` | 200 | 49,370 | `spdx_id: GPL-3.0`, path `LICENSE` |
| 16 | 03:59:22 | `api.github.com/repos/dynastyprocess/data/commits?path=files/db_playerids.csv&per_page=3` | 200 | 10,165 | 2026-09-25T05:10:03Z, 09-18T04:57:58Z, 09-11T04:55:56Z |
| 17 | 04:01:39 | `api.sleeper.com/stats/nfl/2026/3?season_type=regular&position[]=RB&order_by=pts_ppr` | 200 | 24,920 | 177 items; `company: sportradar`, `category: stat`; `last_modified` epoch; `s-maxage=300` |
| 18 | ~04:05 | `fantasyfootballanalytics.net/2026/08/we-analyzed-12-seasons-of-fantasy-football-projections-heres-what-we-found.html` (WebFetch) | 200 | — | seasonal accuracy study, §B.1.1 |
| 19 | ~04:05 | `fantasyfootballanalytics.net/which-projections-are-most-accurate` (WebFetch) | 200 | — | seasonal, updated May 2026 |
| 20 | ~04:05 | `fantasypros.com/2026/01/2025-fantasy-football-rankings-most-accurate-experts/` (WebFetch) | 200 | — | rankings accuracy; no ESPN ranker in top 10 |
| 21 | ~04:05 | `espn.com/fantasy/football/story/_/id/50005325/…` (WebFetch) | 200 | — | Clay, 2026-09-24: "projections will always be updated inside the game leading up to kickoff" |
| 22 | ~04:05 | `github.com/Lolindhir/fantasy-app/issues/669` (WebFetch) | 200 | — | "Any claim such as 'ESPN updates within N minutes' would currently be unsupported" |
| 23 | ~04:05 | `support.sleeper.com/en/articles/2441282-stat-corrections` (WebFetch) | 200 | — | "update stats throughout live games"; corrections through Thursday |
| 24 | ~04:09 | `espn.com/fantasy/football/story/_/page/FFWeeklyPlayerRank26-49804068/…` (WebFetch) | 200 | — | "published every Tuesday … updated throughout the week"; 8 authors; 2026-09-29 09:56 ET |
| 25 | ~04:12 | `support.espn.com/hc/en-us/articles/360000099732-Scoring-Stat-Corrections` (WebFetch) | 200 | — | updated 2026-08-18; quotes in §B.1.7 |
| 26 | ~04:12 | `fantasyfootballanalytics.net/which-dfs-projections-are-most-accurate` (WebFetch) | 200 | — | weekly accuracy, updated April 2026 |
| 27 | ~04:12 | `fantasyfootballanalytics.net/2026/09/we-analyzed-11-seasons-of-dfs-projections-heres-what-we-found.html` (WebFetch) | 200 | — | weekly study, 2026-09-09 |
| 28 | see scratch | `R/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=4` + `limit 5` re-sample | — | — | intra-day drift check (§B.1.8); result recorded in `docs/scratch/data-source-evaluator.md` and below once run |

Web *searches* (not fetches of a provider) are not counted: six queries on accuracy studies, ESPN cadence, ESPN live scoring, Sleeper stats, ESPN projection authorship. Raw bodies were kept only in the session scratchpad outside the repo; the counts above are the record.
