# fantasy-strategy-analyst — working notes

Role: fantasy-strategy analyst for the from-scratch ESPN Fantasy Football MCP server.
Brief: `docs/scratch/briefs/fantasy-strategy-analyst.md`.
Deliverable: `docs/research/05-strategy-and-analytics.md` (sections 1–8).

## RESUME HERE

- Status (2026-09-30): **DONE.** `docs/research/05-strategy-and-analytics.md` is complete (§0–§9, sections 1–8 of the
  brief plus a ledger/sources §9). Nothing is pending; no WIP patch exists or is needed.
- If reopened: the only follow-ups are the [U] items in 05 §9.1, which need the reference league's own `mSettings`/`status`
  (seeding mode, `waiverOrderReset`, process days) and one ESPN `mTransactions2` history (second-claim ordering).
- Budget used: 22/25 HTTP requests; downloads 17.2 MB / 30 MB. Scripts and CSVs live only in the session scratchpad;
  their logic is written out in 05 §1.2, §1.6, §2.4, §3.1 and their outputs are recorded below.

## Sibling citation

`yahoo-fantasy-football-mcp@7663b6ae47a1a19a30e8fa573ed006b0cde6cbb1 docs/research/05-strategy-and-analytics.md`
(1,394 lines; §1 projections … §19 architecture choices). Its worked example is N=12, INT −1, 6 BN.

## Source log (all fetched 2026-09-30)

ESPN Fan Support (support.espn.com/hc/en-us/articles/…), quoted verbatim in 05:
- 360012531592 Waiver Period (Updated 2026-08-18): "A waiver period is the length of time a player must spend on waivers before waiver claims are processed." "The Standard league waiver process begins daily between 3 a.m. and 5 a.m. ET." "1 Day – This is the default setting. Most players will clear Wednesday mornings." "2 Days – Most players will clear Thursday mornings." 1-day = "at the next waiver run that is at least a full 24 hours later". Same-day drop → immediately a free agent (Colts D/ST example).
- 360000041152 Waivers Overview (Updated 2026-08-11): "All unsigned players are put on waivers immediately following the league's draft." "The waiver period usually expires between 3 a.m. and 5 a.m. ET, all the claims from that period will be processed based on the waiver order." "…awarded to the team with the highest waiver priority that made a claim." "that team will move to the end of the waiver order." "all players not added via waivers become free agents, which can be acquired by any team on a first-come, first-served basis."
- 4669787227668 Waiver Order Overview and FAB Tiebreakers (Updated 2026-08-11): "The waiver order begins as the inverse of the draft order." "Once a team successfully makes a waiver claim, they move to the bottom of the waiver priority list." Two reset approaches: "Each Monday at 12:00 AM PT / 3:00 AM ET (when a new fantasy week begins), the order resets" (inverse standings) OR move-to-bottom on successful claim.
- 360000036711 Claim a Player Off Waivers (Updated 2026-08-11): "Reorder claims by dragging them into your preferred priority." "Waivers are typically processed daily around 3:00 AM ET." "If your roster is full, you will be prompted to drop a player." No statement on whether a second claim by the same team is processed at the team's NEW (bottom) position → [U].
- 360000036671 Waiver Order → 302 to a Zendesk access page (not readable anonymously).
- 360000041232 Change Acquisition and Waiver Settings (Updated 2026-09-22): setting names only: Lineup Changes, Player Signing System, Season Signing Limit, Waiver Period, Waiver Order.
- 115003849911 Players on IR (Updated 2026-08-18): "players with either the Out (O) or Injured/Reserve (IR) status may be placed into the IR slot"; "Suspended players (SSPD) are NOT eligible for IR on FFL."; "If a player in the IR slot has their status updated from OUT or IR to QUESTIONABLE or DOUBTFUL, the user's roster is NOT invalid."; "If a player goes from OUT to no longer having an injury designation, the user's roster becomes INVALID, and they must update it accordingly."
- 115003860512 Moving Players on/off IR (Updated 2026-08-18): "Only players with the (IR), (IL), or (O) tag can be placed on the IR…slot." "The system will automatically place the IR…tag on a player once ESPN receives the league report."
- 360035123032 IR impact on waivers/FA (Updated 2026-03-10): "If you have a healthy player in an IR/IL slot, you cannot add any new players to your roster." "…you will receive a message to clear your IR/IL before you can make a claim." "As long as the IR/IL player is eligible for the IR/IL slot, basic waiver offers and free agent pickups will remain unchanged." "If you have an open bench slot when you make a waiver claim but then activate an IR/IL player before the claim processes, your claim will fail."
- 360048828792 IR Settings (Updated 2023-10-09): only "As of October 7, 2020, League Managers are able to add IR slots…"; PUP/NFI never mentioned anywhere → [U].
- 360036952471 Playoff Seeding tiebreakers (Updated 2026-08-18): seeds by division winners then winning percentage; public-league tiebreak order "1. Points For 2. Head-to-head record 3. Intradivisional record 4. Points Against 5. Coin flip"; Points For "is the default first tiebreaker in all public leagues". No pure-points qualification option described.
- 47190901074708 H2H Points seeding tiebreakers (Updated 2026-08-11): "Division winners always occupy the top seeds"; LM order H2H → total points → division → points against → coin flip; LM Tools "Edit Playoffs" page.
- 115003883552 Playoff Schedule (Updated 2026-07-15): "Each round of the playoffs spans a two-week period starting in week 14 of the NFL regular season, unless adjusted by the League Manager." (internally inconsistent with the 14-week public regular season below — treat as stale; read `matchupPeriods`.) "Any BYEs replace the seed starting with the highest number, working in ascending order." 6 teams in an 8-team bracket → seeds #7/#8 empty → #1 and #2 have first-round BYEs. "The 5th through 10th-seeded teams in each league compete in the consolation bracket."
- 360004507992 Public league schedule (Updated 2026-08-11): "ESPN has set fourteen(14) weeks in the regular season for Public Leagues." "The top four teams in a league make the playoffs."

Community:
- cwendt94/espn-api `espn_api/football/league.py` (raw master, fetched today): `standings_weekly` builds the tiebreak hierarchy from `settings.playoff_seed_tie_rule` ∈ {TOTAL_POINTS_SCORED: win% → PF → h2h → div → PA → coin; H2H_RECORD: win% → h2h → PF → div → PA → coin; INTRA_DIVISION_RECORD: div → h2h → win% → PF → PA → coin}. Win% is ALWAYS first (or second) — none of the values is pure-points.
- Sleeper `GET https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=10` → 200, 368 B, JSON array of `{player_id (Sleeper id string), count}` sorted desc; counts today 6.16M, 2.64M, 2.39M for the top three.

Data: nflverse-data release `stats_player` assets `stats_player_week_2025.csv` (8,656,387 B; 19,422 rows; REG weeks 1–18) and `stats_player_week_2024.csv` (8,470,040 B; 18,983 rows). Columns used: position, week, season_type, passing_yards, passing_tds, passing_interceptions, sack/rushing/receiving_fumbles_lost, rushing_yards/tds, receptions, receiving_yards/tds, *_2pt_conversions, special_teams_tds, attempts, targets, team, player_id.

## Computed results (python3 stdlib, 2026-09-30) — all under reference scoring unless noted

Reference scoring used: pass yds 0.04, pass TD {4,5,6}, INT −2, rush/rec yds 0.1, rush/rec TD 6, rec 0.5, fumble lost −2, 2-pt 2, ST TD 6. REG weeks 1–17 (ESPN finalScoringPeriod=17). N=10, slots QB/2RB/2WR/TE/FLEX.

QB season totals (top 12 by season): 
- 2025: QB1 364.6/389.6/414.6 (4/5/6); QB5 313.1/340.9/366.9; QB10 285.2/312.9/338.9; QB12 258.7/283.7/308.7. VOR QB1−QB12 = 105.9 at all three (QB1 and QB12 both threw 25 TD — coincidence); QB5−QB12 54.4/57.2/58.2; QB10−QB12 26.5/29.2/30.2; ΣVOR(QB1..10 over QB12) 533.5/567.2/604.2 (+6.3 %, +13.3 %).
- 2024: QB1 407.4/446.4/485.4; QB5 344.2/376.6/401.6; QB10 282.5/308.2/333.2; QB12 266.9/286.4/303.4. VOR QB1−QB12 140.5/160.0/182.0; QB5−QB12 77.3/90.2/98.2; ΣVOR top10 669.3/787.3/930.3 (+17.6 %, +39 %).
Per game (≥8 GP): 2025 QB1−QB12 5.18/4.80/5.35, QB10−QB12 0.78/0.40/0.56; 2024 QB1−QB12 8.63/9.61/10.26, QB10−QB12 0.86/0.97/0.74.
Weekly baselines (5-pt): mean of each week's QB10 = 22.2 (2025) / 21.6 (2024); QB12 = 20.6 / 19.7; week's best QB 37.5 / 37.7.
Turnover penalty (INT −2, FL −2), 5-pt, among top-24 QBs: 2025 largest Darnold −40 (14 INT, 6 FL), Geno −36, Lawrence −30, Herbert −30, Young −28, Ward −28, Allen −26, Nix −26, Mayfield −26, Goff −24. 2024: Cousins −36, Mayfield −34, Darnold −32, Stroud −32, Maye −32, Purdy −30, Murray −30, Geno −30, Richardson −30, Burrow −26. Rank shift INT −2 vs −1 among top 24: max 1 place both seasons (clean negative: level shift, not re-ranking).
Replacement level, half-PPR, flex allocated (best unslotted):
- 2025 per game: RB 10.08, WR 10.18, TE 9.12, QB10 19.96, QB12 19.55; top: QB 24.35, RB 22.31, WR 19.30, TE 15.18; VOR rank1: QB 4.8, RB 12.2, WR 9.1, TE 6.1; flex fill RB7/WR3 (season totals RB6/WR4; last flex in = RB 149.9 season).
- 2024 per game: RB 11.07, WR 10.92, TE 8.29, QB10 19.26, QB12 18.29; top: QB 27.9, RB 21.17, WR 19.93, TE 13.85; VOR rank1: QB 9.6, RB 10.1, WR 9.0, TE 5.6; flex fill WR6/RB4 (season WR7/RB3).
- VOR curve per game 2025: RB 12.2/10.3/8.0/4.4/3.3/2.1 at rank 1/3/5/10/15/20; WR 9.1/5.3/5.2/3.4/1.2/0.3; TE 6.1/3.5/1.2/0.4/0.0 at 1/3/5/8/10; QB 4.8/3.3/2.4/0.8/0.4 at 1/3/5/8/10. 2024: RB 10.1/7.3/5.8/4.9/3.3/1.8; WR 9.0/5.3/4.3/3.3/1.8/1.3; TE 5.6/3.2/2.3/0.9/0.1; QB 9.6/6.8/5.2/2.7/1.0.
Stack correlation (team's primary QB vs WR1 by targets, weekly, n≈410 team-weeks): QB–WR1 0.342/0.353/0.361 (2025, 4/5/6), 0.341/0.355/0.365 (2024); QB–TE1 0.267/0.281/0.291 (2025), 0.265/0.273/0.277 (2024).
QB weekly CV (top-12): 0.391/0.401/0.411 (2025), 0.374/0.385/0.396 (2024).
Hindsight best-available surplus (ROS Σ max(0, pts−replacement) to wk17; available = prior per-game rank > RB36/WR38/TE14/QB14): across 26 season-weeks best p25/p50/p75/max = 54/62/86/156 pts (6.1/7.1/7.8/12.4 per week); 2nd 52/57/68/103; 5th 39/48/60/75. Many bests are QBs (Stafford, Goff, Lawrence) → 10-team leagues leave QB1-level QBs on waivers.
Waiver DP (N=10, r∈{0:.30,1:.30,2.5:.20,4.5:.12,7:.06,10:.02} pts/wk, q(r)=min(.85,.05+.08r), drift c=.25): Π(k,W) premium of position k over last, W usable weeks after this claim:
  W=1: 1.8,1.2,0.9,0.6,0.5,0.3,0.2,0.2,0.1,0.1 | W=5: 12.8,9.5,7.2,5.6,4.4,3.5,2.8,2.2,1.6,1.2 | W=9: 25.0,19.5,15.4,12.2,9.7,7.7,6.1,4.7,3.6,2.6 | W=13: 37.5,29.5,23.7,19.1,15.4,12.3,9.7,7.6,5.8,4.1 | W=15: 44.0,34.5,27.8,22.5,18.2,14.6,11.6,9.0,6.9,4.9.
  Per-week thresholds r*=Π/W at W=10: 2.50,1.95,1.54,1.22,0.97,0.77,0.61,0.47,0.36,0.26; at W=4: 1.71,1.23,0.93,0.72,0.56,0.44,0.34,0.26,0.19,0.13.
  V(k,16): 95.8 (k=1) … 48.5 (k=10). Sensitivity: c=.15/.35 → Π(1,9)=26.8/23.2; demand ×0.5/×1.5 → 19.9/27.2. Rates ×1.5 / ×0.5: see 05 §1.
Seeding MC (10 teams, μ 122…100 step ~2.4, σ 20, 14 wks, 6 spots, 2 byes; state after wk8; 20k paths):
  user T4 (μ112, 4-4, PF 908 = 3rd): (a) P(po)=.826 P(bye)=.068; +1 past win Δpo +.117 Δbye +.164; +40 PF +.024/+.021; +80 PF +.028/+.038; SD14 +.024/−.009; SD28 −.016/+.006; +3/wk mean +.057/+.031. (b) P(po)=.969 P(bye)=.090; +1 win −.002/+.004; +20 PF +.019/+.065; +80 PF +.031/+.376; SD14 +.022/−.037; SD28 −.049/+.049; +3/wk +.016/+.059. P(6th/7th tied on wins under (a)) = .561.
  (other users: see 05 §2 table.)

## Log

- 2026-09-30: created this file; read 03 and the sibling doc; fetched ESPN help pages; downloaded nflverse; ran all four computations; recorded results here.
- 2026-09-30: wrote 05 §0–§2 (02298c7), §3–§4 (1c8e1f3), §5–§7 (273cd70), §8–§9 (this commit). Done.
