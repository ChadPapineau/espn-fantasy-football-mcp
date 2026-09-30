# 03 — ESPN Fantasy Football unofficial API: capability reference

**Author:** `espn-api-specialist` agent · **Researched:** 2026-09-29/30 · **Brief:** `docs/scratch/briefs/espn-api-specialist.md`
**Method:** the source of the two dominant wrappers and their wikis read statically (cloned into a scratchpad, never installed or executed), community capture studies and issue threads read on GitHub, the governing Disney/ESPN terms pages fetched today, and exactly 30 unauthenticated `GET` probes against one **public** league whose id is published as the example in ffscrapr's ESPN vignette. No cookies were used, no write endpoint was touched, and nothing identifying (league id, team names, member names or GUIDs, the last-updater IP that ESPN exposes) appears in this document.

## How to read this document

| Mark | Meaning |
|---|---|
| **[V-observed]** | Fetched 2026-09-30 in the probe log (§G); the text says what came back. Probe numbers `P01`–`P30` refer to §G. |
| **[V-docs]** | Stated on an official Disney/ESPN page fetched today; quoted. |
| **[V-community]** | Wrapper source, wiki, capture study or dated issue thread; cited by path or URL. Reliable in practice, silently changeable by ESPN. |
| **[U]** | Unverified. Collected by name in §G.1. |

### Sources

| Tag | What | Where |
|---|---|---|
| S-PY | `cwendt94/espn-api` (Python, the dominant wrapper) @ `663d726` | `espn_api/requests/constant.py`, `requests/espn_requests.py`, `football/constant.py`, `football/league.py`, `base_league.py`, `base_settings.py`, `football/{team,player,box_player,box_score,matchup,transaction,activity}.py` |
| S-WIKI | its GitHub wiki @ `1c632cf` | `Home.md`, `League-Class.md`, `Football-Intro.md` |
| S-JS | `mkreiser/ESPN-Fantasy-Football-API` (JS) @ `18b6bf2` | `src/client/client.js`, `src/constants.js`, `src/player/player.js`, `README.md` |
| S-HEY | `heyitaki/espn-fantasy-football-mcp` | `src/espn/constants.ts` |
| S-SDM | `DanielTomaro13/sportsdata-mcp` | `documentation/ESPNFantasy.md` (view sweep, decoder tables, error table, write envelope transcribed from ESPN's bundle) |
| S-JW | `jwulff/fantasy-sports` | `docs/research/05-espn-write-surface.md` (21-request write capture, 2026-09-12) and `docs/memory/commissioner-authority-is-two-flags-in-mnav.md` |
| S-FFS | ffscrapr vignettes | `espn_getendpoint.html`, `espn_authentication.html` (2023-02-11) |
| S-STM | S. Morse, "Using ESPN's new Fantasy API (v3)", 2019-07-27, updated Sep 2024 | https://stmorse.github.io/journal/espn-fantasy-v3.html |
| S-PSR | `pseudo-r/Public-ESPN-Fantasy-API` README (verified by its author 2026-03-26) | https://github.com/pseudo-r/Public-ESPN-Fantasy-API |
| S-TWT | Thomas Wilde, "Player Info JSON Views" | https://thomaswildetech.com/projects/espn/player-info-json-views/ |
| S-DTOU | Disney Terms of Use (United States), **Last Updated: May 24, 2024** | https://disneytermsofuse.com/english/ |
| S-FAIR | ESPN Fan Support, "Fair Play and Conduct", **Updated: August 04, 2026** | https://support.espn.com/hc/en-us/articles/115003845711-Fair-Play-and-Conduct |
| S-ISS | issue threads | cwendt94/espn-api #539 (2024-04-23), PR #540 (merged 2024-04-25), #549 (2024-07-27), discussions #128 (2020-09/2021-01), #150 (2020-11-19, 2025-08-20); mkreiser #133 (2019-09-10); jwulff/fantasy-sports #5 (2026-08-27); mykool223/CommissonersCartelFFL #5 (2026-08-21); finger-six/fantasy_bot #8 (2026-09-22) |
| S-MISC | other community | `cole-wyman-1/keystone-fantasy` README; `mcolen5050/FantasyFootballAutomation_public` `main.py`; `AbdulsaboorS/fantasybasketballbot` `espn_lineup.py`; `zxqj/ff-api` `sample-data/espn/getviews.py`; leagueloom.com/espn; gamedaybot.com help; Chrome Web Store "ESPN Cookie Finder" |
| S-NPM | package registries | `npm view @napi-rs/keyring`, `npm view keytar`; GitHub API repo metadata |

The vendor clones the security auditor is producing were not yet present when this research ran; the wrappers were cloned read-only into this agent's own scratchpad instead and are cited by path.

## Capability matrix

Product need → endpoint/view → verified? → notes. `L` = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}`.

| # | Product need | Endpoint / view | Verified | Notes |
|---|---|---|---|---|
| 1 | League settings (scoring, roster slots, waivers, FAAB, trades, playoffs, draft, fees) | `L?view=mSettings` | **[V-observed]** P04 | One 9 KB response; §B.1 maps every fact of the target league to a path. |
| 2 | Teams, records, standings, waiver order, projected ranks | `L?view=mTeam&view=mStandings` | **[V-observed]** P05 | `teams[]` with `record.overall`, `playoffSeed`, `waiverRank`, `draftDayProjectedRank`, `currentProjectedRank`, `transactionCounter`. |
| 3 | Rosters with slots, per-week | `L?view=mRoster&scoringPeriodId=N` | **[V-observed]** P05 | `teams[].roster.entries[]`; 3.2 MB combined with mTeam/mMatchup for 10 teams. |
| 4 | Full-season schedule and results | `L?view=mMatchup` | **[V-observed]** P05 | `schedule[]` 75 rows for 15 matchup periods × 5 games; `winner` ∈ HOME/AWAY/UNDECIDED. |
| 5 | Current matchup with live/projected totals and win probability | `L?view=mMatchupScore&scoringPeriodId=N` | **[V-observed]** P06 | `totalPointsLive`, `totalProjectedPointsLive`, `winProbability` present on the current period only. |
| 6 | Box scores (who started, per-player points) | `L?view=mBoxscore&scoringPeriodId=N` | **[V-observed]** P07 | `rosterForCurrentScoringPeriod.entries[]` with player + `stats[]`. |
| 7 | Free agents / waiver wire / player search with filters | `L?view=kona_player_info&scoringPeriodId=N` + `X-Fantasy-Filter` | **[V-observed]** P09, P24, P25 | `filterStatus`, `filterSlotIds`, `limit`/`offset`, sorts; total-count header. |
| 8 | Player projections (weekly and season) | `stats[]` with `statSourceId=1` on any player object | **[V-observed]** P05, P09, P21 | Native. Weekly (`statSplitTypeId=1`, per `scoringPeriodId`) and season (`=0`); a third split (`=2`) exists, meaning [U]. |
| 9 | Ownership %, change, % started, ADP, auction value | `player.ownership` | **[V-observed]** P05, P09 | Native. |
| 10 | Draft ranks / positional ranks | `player.draftRanksByRankType`, `player.rankings`, `playerPoolEntry.ratings` | **[V-observed]** P05, P09 | STANDARD / PPR / ELIMINATION / SUPERFLEX rank types. |
| 11 | Injury status | `player.injuryStatus`, `player.injured` | **[V-observed]** P05, P24 | Enumerated in §B.2. |
| 12 | Player news / outlook free text | `player.seasonOutlook`, `player.outlooks.outlooksByWeek`, `lastNewsDate` (league views); `kona_playercard` for weekly actual splits | **[V-observed]** P09, P21 | Free text — untrusted input for the model (§B.5). The separate news endpoint on `site.api.espn.com` returned **403 Access Denied** today (P26). |
| 13 | Draft results | `L?view=mDraftDetail` | **[V-observed]** P16 | `draftDetail.picks[]` (150 picks). |
| 14 | Transactions (adds, drops, waivers, trades) | `L?view=mTransactions2&scoringPeriodId=N` + filter | **[V-observed shape]** P11 | Returned an empty `transactions[]` anonymously; fields [V-community] §B.6. Whether anonymous callers ever see a public league's transactions: [U]. |
| 15 | Pending waiver claims / trades | `L?view=mPendingTransactions` | **[V-observed shape]** P10 | Empty anonymously; almost certainly owner-scoped with cookies [U]. |
| 16 | Members and commissioner flags | `L?view=mNav` | **[V-observed]** P12 | `members[].isLeagueCreator`, `isLeagueManager`; personal identifiers — anonymize. |
| 17 | Live scoring | `L?view=mLiveScoring&scoringPeriodId=N` | **[V-observed, stripped]** P14 | Anonymous response carries only `matchupPeriodId` per row; use #5/#6 instead. With cookies: [U]. |
| 18 | Position-vs-opponent ratings | `L?view=mPositionalRatings&scoringPeriodId=N` | **[V-observed]** P15 | Also embedded in every `kona_player_info` response. |
| 19 | NFL schedule, bye weeks, game start times, stats-official flag | `…/seasons/{season}?view=proTeamSchedules_wl` | **[V-observed]** P20 | No league id needed; CloudFront-cached 300 s. |
| 20 | Player universe (ids, positions, teams, % owned) | `…/seasons/{season}/players?view=players_wl` + root-level filter | **[V-observed]** P23 | 2,663 active players, 664 KB. `limit` requires a sort (P19). |
| 21 | League message board / activity feed | `L/communication/?view=kona_league_communication` | **[V-observed 401]** P27 | Anonymous → `AUTH_COMMUNICATION_NOT_VISIBLE`. With cookies [V-community S-PY]. |
| 22 | Historical seasons ≤ 2017 | `…/ffl/leagueHistory/{id}?seasonId=YYYY` | **[V-community]**; [V-observed 404] for 2020 (P03) | Returns a JSON **array**; the probe league has no pre-2018 season so the array shape is [V-community] (S-JS `client.js` L176, S-PY `league_get`). |
| 23 | Set lineup, add/drop, waiver claim, trade | `POST https://lm-api-writes.fantasy.espn.com/…/leagues/{id}/transactions/` | **[V-community]** S-JW capture, S-SDM, S-HEY, S-MISC | Never probed here. §E. |
| 24 | Rate limits | — | **Undocumented [V-observed negative]** | No rate-limit, quota or `Retry-After` header on any of 30 responses (§A.4). |
| 25 | Login-state probe | `x-fantasy-role` response header; `fan.api.espn.com` | Header **[V-observed]** (`NONE` anonymously); meaning with cookies [U] | §C.3. |

---

## A. How the API works today

### A.1 Hosts and routes

| Route | Status today | Evidence |
|---|---|---|
| `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{id}` | **Live.** Serves the current season (P04, 2026) and past seasons back to 2018 (P01, 2020) with identical top-level keys `draftDetail, gameId, id, scoringPeriodId, seasonId, segmentId, settings, status`. | [V-observed]; both wrappers switch to this route for `year >= 2018` (S-PY `espn_requests.py` L45–53; S-JS `client.js` L22–33) [V-community]. |
| `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/{id}?seasonId={season}` | **Live but only for seasons the modern route does not serve.** `seasonId=2020` → `404 {"messages":["Not Found"],"details":[{"type":"GENERAL_NOT_FOUND",…}]}` (P03). | [V-observed]. Wrappers use it for `year < 2018`; response is a one-element JSON array (S-JS `client.js` L176 "Data is an array instead of object"; S-PY `league_get` takes `response[0]`; S-PSR) [V-community]. S-PY retries the other route on a 401 (`checkRequestStatus`), i.e. a 401 can also mean "wrong route for that season" [V-community]. |
| `https://fantasy.espn.com/apis/v3/games/ffl/…` (the pre-2024 host) | **Dead for JSON.** `302 Location: https://www.espn.com/fantasy/`, body `Redirecting`, `content-type: text/plain` (P02). | [V-observed]. Community dates the move to ~April 2024: cwendt94/espn-api #539 "ESPN returned an HTTP 403" opened 2024-04-23, fixed by PR #540 "Update ESPN API Base Endpoint" merged 2024-04-25; S-STM update note "changed around April 2024"; S-PSR "fantasy.espn.com v1, v2, and v3 redirect to HTML regardless of headers" [V-community]. |
| `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}?view=proTeamSchedules_wl` and `…/seasons/{season}/players?view=players_wl` | **Live, no league id.** (P20, P23.) | [V-observed]. |
| `…/leagues/{id}/communication/?view=kona_league_communication` | Live; **401 anonymously** even on a public league (`AUTH_COMMUNICATION_NOT_VISIBLE`, P27). | [V-observed]. S-SDM: 404 "This Communication Group does not exist." when a league never used the board [V-community]. |
| `https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{id}/transactions/` | Write host. `GET` → `405 HTTP_METHOD_NOT_SUPPORTED`. **Not probed here.** | [V-community] S-JW §1.1, S-SDM "A different host", S-HEY `WRITES_BASE`, S-MISC `main.py` L129. |
| `https://site.api.espn.com/apis/fantasy/v3/games/ffl/news/players?playerId={id}` | The Python wrapper's news endpoint (S-PY `requests/constant.py` L2). **403 today** with an HTML "Access Denied" body (edge bot block) even with a browser User-Agent (P26). | [V-observed]. Treat as unavailable; rely on the outlook text embedded in league views (§B.5). |
| `fan.api.espn.com` (account preferences, `groupManager` flag) | Requires cookies; cited by S-JW memory doc only. | [V-community] → [U] for this project. |

Other observations that shape the design:

- **The API host does not gate on User-Agent.** The same URL with curl's default `User-Agent` returned a byte-identical 200 (P30 vs P04) [V-observed]. In contrast, every `www.espn.com` / `espn.co.uk` HTML page fetched today with a desktop-Chrome UA returned `HTTP 202` with a **0-byte body** and `x-cache: Error from cloudfront` — a bot gate on the website, not on the API (§D.2).
- **CORS is wide open** on the read host: `access-control-allow-origin: *`, `access-control-allow-methods: GET,PUT,POST,DELETE,OPTIONS,HEAD`, `access-control-allow-credentials: true`, and `access-control-expose-headers` enumerates the whole `X-Fantasy-*` family (P04) [V-observed]. That exposed list is itself documentation: `X-Fantasy-Filter-Player-Count`, `-Communication-Count`, `-Schedule-Count`, `-Transaction-Count`, `X-Fantasy-Role`, `X-Fantasy-Last-Update-League`, `X-Fantasy-Server-Time`, per-topic-type counts, `Polling-Interval`.
- Segment is always `0` in every wrapper and doc [V-community]; other segments [U].
- Game codes: `ffl` (NFL), `fba`, `fhl`, `flb`, `wfba` (S-PY `requests/constant.py`) [V-community].

### A.2 Views

`view` is a repeatable query parameter. Views compose additively into one JSON object whose base skeleton is `gameId, id, scoringPeriodId, seasonId, segmentId, status, draftDetail{drafted,inProgress}`. **Unknown view names are ignored silently**: `?view=mBogusViewName` → 200 with a 2 KB skeleton that even includes a slim `teams[]`, `members[]` and `settings{name}` (P28) [V-observed]. Comma-joining views (`view=mTeam,mRoster`) produces the same skeleton (S-SDM) [V-community]. Consequence for us: a typo or a renamed view never errors — the drift detector must check keys, not status codes (§F).

| View | What it adds (keys observed unless noted) | Probe / size (10-team league) | Verified |
|---|---|---|---|
| `mSettings` | `settings{acquisitionSettings, draftSettings, financeSettings, isAutoReactivate, isCustomizable, isPublic, name, restrictionType, rosterSettings, scheduleSettings, scoringSettings, size, tradeSettings}` | P04 · 9 KB | [V-observed] |
| `mTeam` | `teams[]` (28 keys, §B.3), `members[]{displayName, firstName, lastName, id, notificationSettings}` | P05 (combined) · ~15 KB alone (S-SDM) | [V-observed] |
| `mRoster` | `teams[].roster{appliedStatTotal, entries[], tradeReservedEntries}`; honours `scoringPeriodId` (S-PY `load_roster_week`) | P05 · dominates the 3.2 MB combined payload | [V-observed] |
| `mMatchup` | `schedule[]` for the whole season: `{id, matchupPeriodId, winner, home/away{teamId, totalPoints, cumulativeScore, gamesPlayed, pointsByScoringPeriod}}` | P05 | [V-observed] |
| `mMatchupScore` | `schedule[]` with `playoffTierType`; current-period rows add `totalPointsLive, totalProjectedPoints, totalProjectedPointsLive, winProbability, cumulativeScoreLive, rosterForCurrentScoringPeriod` (slim: `lineupSlotId` + `player.stats`), `rosterForMatchupPeriodDelayed, adjustment, tiebreak, eliminationMatchupPeriod` | P06 · 213 KB | [V-observed] |
| `mBoxscore` | `schedule[]` rows **without** `winner`/`playoffTierType`; `home/away{rosterForCurrentScoringPeriod{appliedStatTotal, entries[]}, rosterForMatchupPeriod{entries}, rosterForMatchupPeriodDelayed, cumulativeScore{wins, losses, ties, scoreByStat, statBySlot}, teamId, tiebreak, totalPoints}`; plus slim `teams[]` and `settings` | P07 · 325 KB | [V-observed] |
| `mScoreboard` | `schedule[]` rows `{away, home, id, winner}` — **no `matchupPeriodId`**; `home{cumulativeScore, teamId, tiebreak, totalPoints}`; plus `teams[]`, `settings` | P08 · 395 KB | [V-observed] |
| `mStandings` | records/standings on `teams[]` (not separable from `mTeam` in P05) | P05 | [V-community] S-PY `get_league` |
| `mStatus` | `status` + `lastUpdateInfo{clientAddress, platform, source}` — **`clientAddress` is an IP address** (personal data; never log or forward) | P13 · 1 KB | [V-observed] |
| `mNav` | `teams[]{abbrev, id, logo, logoType, name, owners}`, `members[]{displayName, firstName, lastName, id, isLeagueCreator, isLeagueManager}`, `settings` subset | P12 · 5 KB | [V-observed] |
| `mDraftDetail` | `draftDetail{completeDate, drafted, inProgress, picks[]}` + `settings` | P16 · 42 KB | [V-observed] |
| `mPendingTransactions` | `pendingTransactions[]` (empty anonymously) | P10 · 1 KB | [V-observed shape] |
| `mTransactions2` (+`scoringPeriodId`) | `transactions[]` (empty anonymously; `x-fantasy-filter-transaction-count: 0`) | P11 · 1 KB | [V-observed shape]; fields §B.6 [V-community] |
| `mPositionalRatings` (+`scoringPeriodId`) | `positionAgainstOpponent.positionalRatings{posId: {average, ratingsByOpponent{proTeamId: {average, rank}}}}` for position ids 1,2,3,4,5,16 | P15 · 9 KB | [V-observed]; in-season only (S-SDM) |
| `mLiveScoring` (+`scoringPeriodId`) | anonymously: `schedule[]` rows containing **only** `matchupPeriodId` | P14 · 2.6 KB | [V-observed]; "live point totals" with cookies (S-SDM) [U] |
| `mSchedule`, `modular` | nothing beyond the skeleton | P17, P18 · 0.9 KB | [V-observed] |
| `kona_player_info` (+`scoringPeriodId`, filter `players`) | `players[]{draftAuctionValue, droppedByEliminatedTeam, id, keeperValue, keeperValueFuture, lineupLocked, onTeamId, player{…}, ratings, rosterLocked, status, tradeLocked, waiverProcessDate}` + `positionAgainstOpponent` | P09 · 67 KB for 5; P24 · 5.7 MB for all 951 | [V-observed] |
| `kona_playercard` (+filter `players.filterIds`, `filterStatsForTopScoringPeriodIds`) | as above plus `appliedStatTotal, transactions, waiverDate`; `player` adds `invalid, laterality, stance` and **weekly actual** stat splits | P21 · 13 KB per player | [V-observed] |
| `players_wl` (season path `/players`, root-level filter) | JSON **array** of `{defaultPositionId, droppable, eligibleSlots, firstName, fullName, id, lastName, lastNewsDate, ownership{percentOwned}, proTeamId, universeId}` | P23 · 2,663 rows, 664 KB | [V-observed] |
| `proTeamSchedules_wl` (season path) | `settings.proTeams[33]{abbrev, byeWeek, id, location, name, proGamesByScoringPeriod{week: [{awayProTeamId, date, homeProTeamId, id, scoringPeriodId, startTimeTBD, statsOfficial, validForLocking}]}, teamPlayersByPosition, universeId}` | P20 · 109 KB, `cache-control: max-age=300` | [V-observed] |
| `kona_league_communication`, `kona_league_messageboard` | on `/communication/` only; activity feed / message board (`topics[]`) | P27 → 401 anonymously | [V-community] S-PY `recent_activity`, `message_board` |
| `mLeagueManager` | `members[].isLeagueManager` only (does **not** mark the creator) | — | [V-community] S-JW memory doc |
| `allon` | everything in one ~4 MB response (`settings, status, teams, members, schedule, draftDetail, players, playersHighlighted, creationInfo, lastUpdateInfo, lastAccessInfo`) | — | [V-community] S-SDM (found by sweep) |
| `mRosterSettings, mTeamsForWeek, player_wl, mSecondaryMatchupScore, mLiveScoringDetail, mNewspaper, mDraftDetailForLM, mPlayerHistory, mStandingsRankings, mLeagueHistory, mLeagueSettings` | **do nothing** (skeleton) despite appearing in blog posts | — | [V-community] S-SDM |
| `mTopPerformers` | used by S-JS on the `leagueHistory` route only | — | [V-community]; effect [U] |

### A.3 Query parameters and the `X-Fantasy-Filter` header

**Query parameters**

| Parameter | Meaning | Verified |
|---|---|---|
| `view` (repeatable) | selects payload sections (§A.2) | [V-observed] |
| `scoringPeriodId` | the NFL week. `0` = preseason, `18` = after the season (S-JS README). Selects which week's roster/stat slice `mRoster`, `mBoxscore`, `mMatchupScore`, `kona_player_info` return; required for `mTransactions2` (S-SDM: `transactions` key absent without it). The **top-level** `scoringPeriodId` in every response is the league's *current* period regardless of the parameter (P04–P28 all echo `4`). | param semantics [V-community]; echo [V-observed] |
| `matchupPeriodId` | **not used as a URL parameter by any wrapper**; matchups are selected with the filter `{"schedule":{"filterMatchupPeriodIds":{"value":[n]}}}` (S-PY `box_scores`) or client-side (S-JS `getBoxscoreForWeek`). As a URL parameter: [U]. | [V-community] |
| `seasonId` | only on the `leagueHistory` route | [V-community] |
| `forTeamId`, `rosterForTeamId` | appear in community code next to `mPendingTransactions` / `mRoster` (`zxqj/ff-api getviews.py` sends `rosterForTeamId`); semantics (server-side filtering to one team?) [U] | [V-community] |

**`X-Fantasy-Filter`** — a JSON document in a request header (header name is case-insensitive; wrappers send `x-fantasy-filter`, this research sent `X-Fantasy-Filter`). Nesting depends on the path: on league paths the filter is **entity-nested** (`{"players":{…}}`, `{"transactions":{…}}`, `{"schedule":{…}}`, `{"topics":{…}}`); on the game-level `/players` path it is **root-level** (`{"filterActive":{"value":true}}`) (P23 vs P09; S-SDM "wrong nesting → filter appears ignored"; S-TWT) [V-observed + V-community].

| Key (inside `players` unless noted) | Shape | Verified |
|---|---|---|
| `filterStatus` | `{"value":["FREEAGENT","WAIVERS","ONTEAM"]}` | [V-observed] P09 |
| `filterSlotIds` | `{"value":[slotId,…]}` (lineup-slot ids, §B.2) | [V-observed] P09 |
| `filterIds` | `{"value":[playerId,…]}` | [V-observed] P21 |
| `filterActive` (root-level, `/players`) | `{"value":true}` | [V-observed] P23 |
| `filterStatsForTopScoringPeriodIds` | `{"value":N,"additionalValue":["00YYYY","10YYYY",…]}` — selects which stat splits are embedded (S-PY `get_player_card`; S-FFS example `"002020"`) | [V-observed] P21 accepted it; semantics [V-community] |
| `limit`, `offset` | integers; **`limit` without a sort → `400 FILTER_LIMIT_MISSING_SORT`** ("Filter: Limit request must be accompanied by a sort", P19); `offset` pages correctly (P25: five new ids, zero overlap with P09) | [V-observed] |
| `sortPercOwned` | `{"sortPriority":1,"sortAsc":false}` | [V-observed] P09 |
| `sortDraftRanks` | `{"sortPriority":100,"sortAsc":true,"value":"STANDARD"}` (`"PPR"` also valid per S-PY) | [V-observed] P09 |
| `sortAppliedStatTotal`, `sortPercChanged` | sorts by projected/applied points, by ownership change | [V-community] S-HEY |
| `filterRanksForScoringPeriodIds`, `filterRanksForSlotIds`, `filterProTeamIds`, `filterInjured` | named in the brief / seen in the wild; not in any wrapper read here | [U] |
| `transactions.filterType` | `{"value":["FREEAGENT","WAIVER","WAIVER_ERROR","TRADE_ACCEPT",…]}` | [V-observed] P11 accepted; values [V-community] S-PY |
| `schedule.filterMatchupPeriodIds` | `{"value":[n]}` | [V-community] S-PY |
| `topics.filterType`, `filterIncludeMessageTypeIds`, `limitPerMessageSet`, `sortMessageDate`, `sortFor` | activity-feed filters on `/communication/` | [V-community] S-PY `recent_activity` |

**Limits and pagination.** `limit: 5000` returned all 951 players in the league pool — no ceiling below the pool size was hit (P24, 5.7 MB) [V-observed]. S-JS uses `limit: 3000` for drafts and `2000` for free agents; S-PY pages the pool at `500` [V-community]. The response header **`x-fantasy-filter-player-count` is the total number of matches irrespective of `limit`** (196 with `limit: 5` and again with `offset: 5`; 951 with `limit: 5000`; 2,663 on `players_wl`) [V-observed] — so paging is `offset += limit` until `offset >= count`, and the count is free. Always send a sort with a limit.

### A.4 Response conventions, errors, headers

- **`scoringPeriodId` vs `matchupPeriodId`.** A scoring period is one NFL week; a matchup period is one fantasy matchup and may span several weeks in the playoffs (S-JS README) [V-community]. The mapping lives in `settings.scheduleSettings.matchupPeriods` (`{"1":[1],"2":[2],…}`) with `matchupPeriodLength`, `playoffMatchupPeriodLength` (P04) [V-observed]. S-PY resolves a week to its matchup period by scanning that map (`box_scores`).
- **`seasonId`** is the calendar year the season started; leagues are **per-season objects**: the same id exists for every season in `status.previousSeasons` (`[2018,…,2025]` on the probe league) and 404s for others (S-SDM; P22/P29) [V-observed].
- **`status`** (P04, P13): `currentMatchupPeriod`, `latestScoringPeriod`, `finalScoringPeriod` (17), `firstScoringPeriod`, `transactionScoringPeriod`, `isActive`, `isExpired`, `isFull`, `isViewable` (was `false` on this *public* league — it is not the "public" flag; `settings.isPublic` is), `isToBeDeleted`, `isWaiverOrderEdited`, `isPlayoffMatchupEdited`, `teamsJoined`, `previousSeasons[]`, `activatedDate`, `standingsUpdateDate`, `waiverLastExecutionDate`, `waiverNextExecutionDate`, `waiverProcessStatus{ISO-8601 datetime: integer}`, `createdAsLeagueType`, `currentLeagueType`; `mStatus` adds `lastUpdateInfo{clientAddress, platform, source}` [V-observed]. All dates are **epoch milliseconds** [V-observed].
- **200-with-error-body was not observed.** Errors use the HTTP status and a constant JSON shape: `{"messages":["<prose>"],"details":[{"message","shortMessage","resolution":null,"type":"<TYPED_CODE>","metaData":null}]}` (P03, P19, P22, P27) [V-observed]. Known `type` values: `GENERAL_NOT_FOUND` (404: league does not exist for that season), `FILTER_LIMIT_MISSING_SORT` (400), `AUTH_COMMUNICATION_NOT_VISIBLE` (401) [V-observed]; `AUTH_LEAGUE_NOT_VISIBLE` (401: private league or stale cookie) (S-SDM), `AUTH_MISSING_CREDENTIALS` (401 on the write host), `HTTP_METHOD_NOT_SUPPORTED` (405), `TRAN_*` (409) (S-JW) [V-community]. One exception: a malformed write body gets `400 {"messages":["Invalid Input."]}` with **no** `details[]` (S-JW §5) [V-community].
- **Private league without cookies → 401** (S-PY `checkRequestStatus` raises `ESPNAccessDenied("espn_s2 and swid are required")`; S-SDM; S-JW "the read host's 401 is typed and constant"). Not reproduced today: the two published example ids tried were both 404 (P22, P29), so the exact read-host 401 body remains [V-community]; the write-host 401 body is captured verbatim in S-JW.
- **Headers on every 200 from the read host** (P01–P30) [V-observed]: `content-type: application/json;charset=utf-8`; a **weak `ETag`** that is **stable across identical requests** (P04 and P30, 2 min apart, same body and same `W/"…"` value) — so `If-None-Match` revalidation is plausible, but whether the host answers 304 was not probed ([U]); `cache-control: must-revalidate`, `expires: -1`, `pragma` on league paths; `cache-control: max-age=300` with CloudFront `Hit`/`age` on the season-level `proTeamSchedules_wl` and `players_wl` paths; `x-fantasy-server-time` (RFC 1123, UTC); `x-fantasy-role: NONE`; `x-fantasy-filter-player-count`; `x-fantasy-filter-transaction-count` on `mTransactions2`; `polling-interval: 10` on the `/communication/` response; `via`/`x-cache`/`x-amz-cf-pop` (CloudFront); `x-frame-options: DENY`, `x-content-type-options: nosniff`.
- **No rate-limit headers.** Across 30 responses there was no `RateLimit-*`, `X-RateLimit-*`, `Retry-After` or quota header of any kind [V-observed negative]. §D.3 designs around that.

---

## B. The data model we must validate against

### B.1 League settings — where each fact of the target league lives

The probe league is a 10-team H2H league with FAAB and standard (non-PPR) scoring; the paths below are observed on it (P04) and the target league's expected values are derived from the community stat/enum maps.

| Target-league fact | Path in `settings` | Observed on probe league | Expected for target | Verified |
|---|---|---|---|---|
| 10 teams | `size` (and `status.teamsJoined`) | `10` | `10` | [V-observed] |
| Head-to-head points | `scoringSettings.scoringType` | `"H2H_POINTS"` | `"H2H_POINTS"`; other values [U] | [V-observed] |
| Half-PPR | `scoringSettings.scoringItems[]` entry `{statId: 53, points: 0.5}` | absent (league is non-PPR; it has statIds 3, 4, 19, 20, 24, 25, 26, 42, 43, 44, 63, 72, …) | `statId 53` ("REC — Each reception", S-PY `SETTINGS_SCORING_FORMAT_MAP`; `receivingReceptions: '53'` S-JS) with `points: 0.5` | id [V-community, two sources]; shape [V-observed] |
| 5-pt passing TD | `scoringItems[]` `{statId: 4, points: 5}` | `{statId: 4, points: 4.0}` | `points: 5.0` | [V-observed] |
| Per-position overrides | `scoringItems[].pointsOverrides{positionId: points}` — keyed by **position id** (§B.2), e.g. `"16"` for D/ST, `"14"` for HC, `"1","2","3","4","15"` for QB/RB/WR/TE/TQB | e.g. `{statId: 89, points: 0, pointsOverrides: {"16": 5.0}}` | same shape | [V-observed]; S-PY reads override `"16"` |
| Other item fields | `isReverseItem`, `leagueRanking`, `leagueTotal` | present | — | [V-observed] |
| Waiver type: move-to-last | `acquisitionSettings.acquisitionType`, `isUsingAcquisitionBudget`, `waiverOrderReset` | `"WAIVERS_CONTINUOUS"`, `true` (FAAB), `waiverOrderReset: true` | `isUsingAcquisitionBudget: false`; the non-FAAB `acquisitionType` value and the exact meaning of `waiverOrderReset` are **[U]** (no wrapper decodes them) | [V-observed shape] |
| 1-day waiver period | `acquisitionSettings.waiverHours` | `24` | `24` | [V-observed] |
| Waiver processing | `acquisitionSettings.waiverProcessDays[]`, `waiverProcessHour` | `["THURSDAY","SUNDAY"]`, `12` | — | [V-observed] |
| Budget / limits | `acquisitionBudget` (200), `minimumBid` (1), `acquisitionLimit` (−1 = unlimited), `matchupAcquisitionLimit`, `matchupLimitPerScoringPeriod`, `transactionLockingEnabled`, `finalPlaceTransactionEligible` | present | — | [V-observed] |
| Playoff seeding by total points | `scheduleSettings.playoffSeedingRule`, `playoffSeedingRuleBy` | `"TOTAL_POINTS_SCORED"`, `0` | `"TOTAL_POINTS_SCORED"` | [V-observed] |
| Playoff structure | `playoffTeamCount` (4), `playoffMatchupPeriodLength` (1), `variablePlayoffMatchupPeriodLength`, `playoffReseed`, `consolationLadderDisabled` | present | — | [V-observed] |
| Season structure | `matchupPeriodCount` (15), `matchupPeriodLength` (1), `matchupPeriods{id: [weeks]}`, `periodTypeId`, `divisions[]{id, name, size}` | present | — | [V-observed] |
| Roster slots | `rosterSettings.lineupSlotCounts{slotId: count}` (e.g. `"20": 7` bench, `"21": 2` IR, `"23": 5` FLEX on the probe league), `positionLimits{positionId: max, −1 = unlimited}`, `isBenchUnlimited`, `lineupLocktimeType` (`"INDIVIDUAL_GAME"`), `rosterLocktimeType`, `moveLimit`, `isUsingUndroppableList`, `universeIds`, `lineupSlotStatLimits`, `autoPilotTypeSupported` | present | — | [V-observed] |
| Trades | `tradeSettings.deadlineDate` (epoch ms), `revisionHours` (24), `vetoVotesRequired` (0), `max` (−1), `allowOutOfUniverse` | present | — | [V-observed] |
| Draft | `draftSettings.type` (`"SNAKE"`), `orderType` (`"MANUAL"`), `pickOrder[]` (team ids), `date`, `availableDate`, `timePerSelection`, `auctionBudget`, `keeperCount`, `keeperCountFuture`, `keeperOrderType`, `leagueSubType`, `isTradingEnabled` | present | — | [V-observed] |
| Fees | `financeSettings.{entryFee, miscFee, perLoss, perTrade, playerAcquisition, playerDrop, playerMoveToActive, playerMoveToIR}` | all `0.0` | — | [V-observed] |
| Ties | `scoringSettings.matchupTieRule` (`"SLOT_POINTS"`), `matchupTieRuleBy` (20), `playoffMatchupTieRule` (`"NONE"`), `playoffMatchupTieRuleBy` | present | — | [V-observed] |
| Misc | `scoringSettings.playerRankType` (`"STANDARD"`), `homeTeamBonus`, `playoffHomeTeamBonus`, `allowOutOfPositionScoring`, `scoringEnhancementType`; top-level `isPublic`, `isCustomizable`, `restrictionType` (`"NONE"`), `name`, `isAutoReactivate` | present | — | [V-observed] |

`mNav` returns only a subset of `settings` (`acquisitionSettings, draftSettings, isCustomizable, isPublic, name, rosterSettings, scoringSettings`) (P12) [V-observed] — do not validate the full settings schema against an `mNav` response.

### B.2 Enumerations

**Lineup slot ids** (`lineupSlotId`, `eligibleSlots[]`, `filterSlotIds`, keys of `lineupSlotCounts`). Four independent maps agree — S-PY `POSITION_MAP`, S-JS `slotCategoryIdToPositionMap`, S-HEY `SLOT_BY_ID`, S-SDM — [V-community ×4]; ids 1, 16, 17, 20, 21, 23 observed in rosters (P05) [V-observed].

| id | slot | id | slot | id | slot |
|---:|---|---:|---|---:|---|
| 0 | QB | 9 | DE | 18 | P |
| 1 | TQB | 10 | LB | 19 | HC |
| 2 | RB | 11 | DL | 20 | **BE** (bench) |
| 3 | RB/WR | 12 | CB | 21 | **IR** |
| 4 | WR | 13 | S | 22 | (unnamed) |
| 5 | WR/TE | 14 | DB | 23 | **FLEX** (RB/WR/TE) |
| 6 | TE | 15 | DP | 24 | ER |
| 7 | OP | 16 | D/ST | 25 | Rookie |
| 8 | DT | 17 | K | | |

**Position ids** (`defaultPositionId`, keys of `positionLimits`, `pointsOverrides`, `positionalRatings`) are a **different numbering** from slots: 1 QB, 2 RB, 3 WR, 4 TE, 5 K, 7 P, 9 DT, 10 DE, 11 LB, 12 CB, 13 S, 14 HC, 16 D/ST (S-HEY `POSITION_BY_ID`) [V-community]; **15 = TQB** (inferred: roster entries with `defaultPositionId: 15` sit in slot 1 (TQB), exactly 32 such players exist in `players_wl`, and `pointsOverrides` for offensive stats use keys `"1","2","3","4","15"`, P04/P05/P23) [V-observed inference]. `positionalRatings` are keyed `1,2,3,4,5,16` (P09, P15) [V-observed]. **Trap:** S-JS decodes `defaultPositionId` with the *slot* map (`player.js` L103–106), which mislabels every QB as "TQB", every RB as "WR", etc.; S-PY sidesteps it by deriving position from `eligibleSlots` (`player.py` L30–34). We must keep two maps.

**Pro team ids** — observed complete list from `proTeamSchedules_wl` (P20): `0 FA, 1 ATL, 2 BUF, 3 CHI, 4 CIN, 5 CLE, 6 DAL, 7 DEN, 8 DET, 9 GB, 10 TEN, 11 IND, 12 KC, 13 LV, 14 LAR, 15 MIA, 16 MIN, 17 NE, 18 NO, 19 NYG, 20 NYJ, 21 PHI, 22 ARI, 23 PIT, 24 LAC, 25 SF, 26 SEA, 27 TB, 28 WSH, 29 CAR, 30 JAX, 33 BAL, 34 HOU` (31, 32 unused) [V-observed]; identical in S-PY `PRO_TEAM_MAP`, S-JS `nflTeamIdToNFLTeamAbbreviation`, S-SDM [V-community ×3]. S-JS adds a client-side `-1: Bye`.

**`injuryStatus`** (on `player`): observed `ACTIVE`, `QUESTIONABLE`, `DOUBTFUL`, `OUT`, `INJURY_RESERVE`, `DAY_TO_DAY`, `null` (P05, P24 over 951 players) [V-observed]; `SUSPENSION` [U]. `player.injured` is a separate boolean [V-observed]. The roster **entry** has its own `injuryStatus` (`"NORMAL"` observed) and `status` (`"NORMAL"`) [V-observed]; other entry values [U].

**Player pool `status`**: `FREEAGENT`, `WAIVERS`, `ONTEAM` (S-SDM, S-HEY, S-PY filters) [V-community]; observed `WAIVERS` (797) and `ONTEAM` (154) — no `FREEAGENT` at probe time on a continuous-waivers league (P24) [V-observed].

**Roster entry `acquisitionType`**: observed `DRAFT`, `ADD`, `TRADE` (P05) [V-observed]; others [U].

**Transaction `type`** (S-PY `TRANSACTION_TYPES`): `DRAFT, TRADE_ACCEPT, WAIVER, TRADE_VETO, FUTURE_ROSTER, ROSTER, RETRO_ROSTER, TRADE_PROPOSAL, TRADE_UPHOLD, FREEAGENT, TRADE_DECLINE, WAIVER_ERROR, TRADE_ERROR` [V-community]; S-HEY and S-JW agree on `FREEAGENT, WAIVER, TRADE_PROPOSAL, TRADE_ACCEPT, ROSTER, DRAFT`; S-SDM writes `TRADE_ACCEPTED` — **discrepancy, [U]**. Item `type`: `ADD`, `DROP`, `LINEUP` (S-HEY, S-JW, S-SDM) [V-community]. `executionType`: `EXECUTE`, `CANCEL` (S-HEY, S-SDM); `VALIDATE` is rejected (S-JW) [V-community]. Activity-feed `messageTypeId`: `178` FA added, `180` waiver added, `179`/`181`/`239` dropped, `244` traded (S-PY `ACTIVITY_MAP`) [V-community].

**`statSourceId` / `statSplitTypeId`** on every `stats[]` entry: `statSourceId` `0` = actual, `1` = projected; `statSplitTypeId` `0` = season, `1` = one scoring period (S-SDM, S-HEY; S-PY `box_player.py` L44–46) [V-community ×3]; observed combinations over 951 players: `(0,0)` 1,808, `(1,0)` 1,408, `(1,1)` 587, `(1,2)` 462 (P24) [V-observed]. **Split `2`** (projected only; id pattern `"12YYYY"`) is skipped by S-PY (`player.py` L69) and unnamed anywhere — probably rest-of-season projection, **[U]**. The `stats[].id` string encodes `"<source><split><season>"` for season splits (`"002026"` actual season, `"102026"` projected season, `"002025"` last season) and `"11<season><week>"` for weekly projections (`"1120264"` = 2026 week 4) (P05, P09; S-HEY `projectedStatId`) [V-observed + V-community]; weekly **actuals** carry a different, longer id (`"01401872951"`, source 0, split 1, then what looks like a game id) — [V-observed shape, meaning U].

**`draftRanksByRankType`** keys: `STANDARD`, `PPR`, `ELIMINATION`, `SUPERFLEX`, each `{auctionValue, published, rank, rankSourceId, rankType, slotId}`; `rankings{scoringPeriodId: [{rank, averageRank?, rankSourceId, rankType, slotId, published, auctionValue}]}` with several numeric `rankSourceId`s (`0` carries `averageRank`) (P05) [V-observed]; the source-id → analyst map is [U]. `ratings{"0": {positionalRanking, totalRanking, totalRating, statCategoryRanking}}` (P05) [V-observed]; the key `"0"` presumably = season, [U].

**Other enums observed** (P04–P08): `schedule[].winner` ∈ `HOME, AWAY, UNDECIDED`; `playoffTierType` `"NONE"` (bracket values [U]); `scoringType` `"H2H_POINTS"`; `matchupTieRule` `"SLOT_POINTS"`, `playoffMatchupTieRule` `"NONE"`; `playoffSeedingRule` `"TOTAL_POINTS_SCORED"` — with `"H2H_RECORD"` and `"INTRA_DIVISION_RECORD"` (S-PY `standings_weekly`) [V-community]; `acquisitionType` `"WAIVERS_CONTINUOUS"`; `lineupLocktimeType` `"INDIVIDUAL_GAME"`; `draftSettings.type` `"SNAKE"`, `orderType` `"MANUAL"`, `keeperOrderType` `"TRADITIONAL"`; `restrictionType` `"NONE"`; `record.overall.streakType` `"WIN"`/`"LOSS"` (S-HEY `STREAK_PREFIX`) [V-community]; `status.waiverProcessStatus` values are small integers whose meaning is [U].

**Stat ids.** S-PY carries two maps — `PLAYER_STATS_MAP` (136 ids, names) and `SETTINGS_SCORING_FORMAT_MAP` (235 ids, ESPN's abbreviation + label) — and S-JS carries `scoringItemToId` (162 ids). A programmatic diff run for this document: all 162 S-JS ids exist in S-PY and the names agree for every spot-checked id **except 103/104**, where S-PY says `103 = interceptionReturnTouchdowns, 104 = fumbleReturnTouchdowns` and S-JS the reverse — **[U] which is right**. The condensed table (S-PY abbreviation / meaning; ✓ = also in S-JS with the same meaning):

| id | abbr | meaning | ✓ | id | abbr | meaning | ✓ |
|---:|---|---|---|---:|---|---|---|
| 0 | PA | pass attempts | ✓ | 74–76 | FG50P/FGA50P/FGM50P | FG made/att/missed 50+ (incl. 60+) | ✓ |
| 1 | PC | completions | ✓ | 77–79 | FG40/FGA40/FGM40 | FG 40–49 | ✓ |
| 3 | PY | passing yards | ✓ | 80–82 | FG0/FGA0/FGM0 | FG 0–39 | ✓ |
| 4 | PTD | passing TD | ✓ | 83–85 | FG/FGA/FGM | FG totals | ✓ |
| 15/16 | PTD40/PTD50 | 40+/50+ yd TD pass bonus | ✓ | 86–88 | PAT/PATA/PATM | extra points | ✓ |
| 17/18 | P300/P400 | 300–399 / 400+ yd game | ✓ | 89–92 | PA0/PA1/PA7/PA14 | D/ST points-allowed tiers 0, 1–6, 7–13, 14–17 | ✓ |
| 19 | 2PC | 2-pt pass | ✓ | 121–125 | PA18/PA22/PA28/PA35/PA46 | tiers 18–21, 22–27, 28–34, 35–45, 46+ | ✓ |
| 20 | INTT | interceptions thrown | ✓ | 120 | PTSA | points allowed (raw) | ✓ |
| 23 | RA | rush attempts | ✓ | 93 | BLKKRTD | blocked kick returned for TD | ✓ |
| 24 | RY | rushing yards | ✓ | 94 | DEFRETTD | fumble/INT return TD (combined) | — |
| 25 | RTD | rushing TD | ✓ | 95 | INT | interception | ✓ |
| 26 | 2PR | 2-pt rush | ✓ | 96 | FR | fumble recovery | ✓ |
| 35/36 | RTD40/RTD50 | 40+/50+ yd rush TD bonus | ✓ | 97 | BLKK | blocked kick | ✓ |
| 37/38 | RY100/RY200 | 100–199 / 200+ yd game | ✓ | 98 | SF | safety | ✓ |
| 41 | RECS | receptions (stat) | — | 99 | SK | sack | ✓ |
| 42 | REY | receiving yards | ✓ | 101/102 | KRTD/PRTD | kick / punt return TD | ✓ |
| 43 | RETD | receiving TD | ✓ | 103/104 | INTTD/FRTD | INT / fumble return TD (**order disputed**) | ✗ |
| 44 | 2PRE | 2-pt reception | ✓ | 105 | TRTD | total return TD | ✓ |
| 45/46 | RETD40/RETD50 | 40+/50+ yd rec TD bonus | ✓ | 106 | FF | forced fumble | ✓ |
| **53** | **REC** | **each reception (the PPR scoring item)** | ✓ | 107–109 | TKA/TKS/TK | tackles | ✓ |
| 56/57 | REY100/REY200 | 100–199 / 200+ yd game | ✓ | 113 | PD | passes defensed | ✓ |
| 58 | RET | targets | ✓ | 114/115 | KR/PR | kick / punt return yards | ✓ |
| 62 | PTL | total 2-pt conversions | — | 127 | YA | yards allowed | ✓ |
| 63 | FTD | fumble recovered for TD (offense) | — | 128–136 | YA100…YA550 | yards-allowed tiers <100, 100–199, 200–299, 300–349, 350–399, 400–449, 450–499, 500–549, 550+ | ✓ |
| 64 | SKD | times sacked | — | 155–158 | TW/TL/TIE/PTS | head-coach: team win/loss/tie/points | ✓ |
| 68 | FUM | total fumbles | ✓ | 161–172 | WM25…LM25 | win/loss margin buckets | ✓ |
| 72 | FUML | fumbles lost | ✓ | 198–200 | FG50/FGA50/FGM50 | FG 50–59 (newer split) | ✓ |
| 73 | TT | total turnovers | — | 201–203 | FG60/FGA60/FGM60 | FG 60+ | ✓ |
| 5–14, 27–34, 47–52, 54–55 | PY5… | "every N yards / receptions" bucket items | ✓ | 205/206, 207–209 | D2PRET/2PRET, 1PSF | 2-pt returns, 1-pt safeties | — |
| 22, 40, 61 | PYPG/RYPG/REYPG | per-game averages (duplicates of 3/24/42 in S-PY, flagged TODO there) | ✓ | 210–216 | GP, PFD/RFD/REFD, FGY/FGMY/FGAY | games played, first downs, FG yardage | — |

Observed on the probe league (P04): scoring items use 3, 4, 19, 20, 24–26, 42–44, 63, 72, 79, 82, 86, 88–93, 95–99, 101–104, 114, 115, 124, 125, 128–130, 133–136, 161–166, 206, 209, 214 [V-observed] — consistent with the map.

### B.3 Teams and rosters

`teams[]` (`mTeam` + `mRoster` + `mStandings`, P05) [V-observed]: `id, abbrev, name, location?, nickname? (S-PY reads both), logo, logoType, divisionId, owners[] (member GUIDs), primaryOwner (GUID), isActive, playoffSeed, waiverRank, draftDayProjectedRank, currentProjectedRank, rankCalculatedFinal, rankFinal, points, pointsAdjusted, pointsDelta, playoffClinchType, eliminated, eliminationMatchupPeriod, isTransactionLocked, currentSimulationResults{playoffPct,…}, draftStrategy, tradeBlock, record{overall, home, away, division}{wins, losses, ties, percentage, pointsFor, pointsAgainst, gamesBack, streakLength, streakType}, transactionCounter{acquisitions, acquisitionBudgetSpent, drops, trades, moveToIR, moveToActive, misc, paid, teamCharges, matchupAcquisitionTotals{week: n}}, valuesByStat{statId: value}, roster{appliedStatTotal, entries[], tradeReservedEntries}`. `mNav`/`mBoxscore`/`mScoreboard` return slimmer `teams[]` (P07, P08, P12).

`roster.entries[]`: `acquisitionDate` (ms), `acquisitionType`, `injuryStatus` (`"NORMAL"`), `lineupSlotId`, `pendingTransactionIds` (null), `playerId`, `status` (`"NORMAL"`), `playerPoolEntry{appliedStatTotal, id, keeperValue, keeperValueFuture, lineupLocked, onTeamId, rosterLocked, tradeLocked, status ("ONTEAM"), ratings, player{…}}` [V-observed].

`player`: `id, fullName, firstName, lastName, defaultPositionId, eligibleSlots[], proTeamId, injuryStatus, injured, active, droppable, universeId, jersey, ownership{percentOwned, percentChange, percentStarted, averageDraftPosition, auctionValueAverage}, draftRanksByRankType{…}, rankings{…}, seasonOutlook, outlooks{outlooksByWeek}, lastNewsDate, lastVideoDate, stats[]` [V-observed]. In `kona_player_info` the `ownership` object is richer: adds `activityLevel, auctionValueAverageChange, averageDraftPositionPercentChange, date, leagueType` (P09) [V-observed]. `stats[]` entries: `id, externalId, seasonId, scoringPeriodId, statSourceId, statSplitTypeId, proTeamId, appliedTotal, appliedStats{statId: pts}, stats{statId: raw}` (+ `appliedAverage` on season splits, S-PY) [V-observed + V-community].

Personal identifiers here: `members[]` (`id` GUID, `displayName`, `firstName`, `lastName`, `notificationSettings`), `teams[].owners[]`, `primaryOwner`, and user-chosen `teams[].name/abbrev/location/nickname/logo` — the last group is **free text set by other league members** (§B.5). The probe league has 11 members for 10 teams (one co-owned team) [V-observed].

### B.4 Matchups and scoring

`schedule[]` (`mMatchup`, P05): `{id, matchupPeriodId, winner, home/away{teamId, totalPoints, gamesPlayed, cumulativeScore{wins, losses, ties, statBySlot}, pointsByScoringPeriod{week: pts}}}` [V-observed]. `mMatchupScore` (P06) adds `playoffTierType` and, on the **current** period only, `totalPointsLive`, `totalProjectedPoints`, `totalProjectedPointsLive`, `winProbability` (0–1, e.g. `0.62`), `cumulativeScoreLive`, `rosterForCurrentScoringPeriod` (slim entries: `lineupSlotId` + `playerPoolEntry.player.stats` only), `rosterForMatchupPeriodDelayed`, `adjustment`, `tiebreak`, `eliminationMatchupPeriod` [V-observed]. `mBoxscore` (P07) carries the full `rosterForCurrentScoringPeriod` (names, positions, stats) plus `rosterForMatchupPeriod` — which had **0 entries** while the current week's roster had 15, so it is presumably filled once the matchup completes ([U]) — and `cumulativeScore.scoreByStat{statId: {ineligible, rank, result, score}}` (category leagues; all zero here) [V-observed]. Byes are `home` without `away` (S-PY `_fetch_schedule` handles `away` missing) [V-community]. Both wrappers require **both** the scoring period and the matchup period to select a box score (S-JS `getBoxscoreForWeek` doc; S-PY `box_scores`) [V-community].

### B.5 Players — what ESPN exposes natively (no second source needed)

| Need | Where | Verified |
|---|---|---|
| Weekly projection for week N | `stats[]` entry with `statSourceId 1, statSplitTypeId 1, scoringPeriodId N` (`appliedTotal` = points under **this league's** scoring; `appliedStats` per stat) | [V-observed] P05, P09 (weeks 3 and 4 present in week 4) |
| Season projection / rest-of-season | `(1, 0)` `"10YYYY"`; `(1, 2)` `"12YYYY"` ([U] meaning) | [V-observed] |
| Season actuals, last season actuals | `(0, 0)` `"00YYYY"`, `"00YYYY-1"` | [V-observed] |
| Weekly actuals | embedded only via `kona_playercard` with `filterStatsForTopScoringPeriodIds` (weeks 1–3 and the prior season's week 18 came back, P21); in `mBoxscore` for the requested week | [V-observed] |
| Ownership % / change / % started / ADP / auction | `player.ownership` | [V-observed] |
| Ranks | `draftRanksByRankType`, `rankings`, `playerPoolEntry.ratings`, `positionAgainstOpponent` | [V-observed] |
| Injury | `injuryStatus`, `injured` | [V-observed] |
| News/outlook **free text** | `seasonOutlook` (739 chars on the sampled player), `outlooks.outlooksByWeek{"2","3","4": text}`, `lastNewsDate`/`lastVideoDate` (ms) — present in `mRoster`, `kona_player_info`, `kona_playercard` | [V-observed] P05, P09, P21 |
| News articles (headline/body) | `site.api.espn.com/apis/fantasy/v3/games/ffl/news/players` → **403 today** (P26) | [V-observed negative] |
| Bye week, game time, kickoff-lock, stats final | `proTeamSchedules_wl`: `byeWeek`, `proGamesByScoringPeriod[].date/startTimeTBD/validForLocking/statsOfficial` | [V-observed] P20 |

**Free-text fields = untrusted model input.** Every string below can reach the model verbatim and must be treated as data, never as instructions: `player.seasonOutlook`, `player.outlooks.outlooksByWeek[*]` (ESPN editorial), and — more dangerous because **other league members control them** — `teams[].name`, `abbrev`, `location`, `nickname`, `logo` (URL), `members[].displayName/firstName/lastName`, `tradeBlock`, `draftStrategy`, `settings.name`, `divisions[].name`, and every message-board/activity `topics[]` string. The server should length-cap and delimit them and the tool descriptions should say so.

### B.6 Transactions, pending moves, members

`mTransactions2` `transactions[]` (fields from S-PY `transaction.py` and the S-JW write capture) [V-community]: `id, teamId, type, status (e.g. EXECUTED / PENDING), scoringPeriodId, processDate | acceptedDate | proposedDate (ms), bidAmount (FAAB), relatedTransactionId, memberId (GUID), items[]{type ADD|DROP|LINEUP, playerId, fromTeamId, toTeamId, fromLineupSlotId, toLineupSlotId, isKeeper, overallPickNumber}`. The waiver-order field is `teams[].waiverRank` (P05) [V-observed]. S-PY builds its "offers report" (all bids incl. losing ones) from `mTransactions2` filtered to `WAIVER, WAIVER_ERROR` (`_get_offers`) [V-community] — implies bids and process dates are visible to the authenticated caller. `mPendingTransactions.pendingTransactions[]`: field names [U] (empty anonymously). Whether an anonymous caller ever sees a public league's transactions: [U] (empty at week 4 on a league whose `waiverProcessStatus` shows weekly runs).

`members[]` (`mTeam`: `id, displayName, firstName, lastName, notificationSettings`; `mNav`: `+ isLeagueCreator, isLeagueManager`) — all personal identifiers; commissioner authority = `isLeagueCreator OR isLeagueManager` (S-JW memory doc: the creator's flag is **not** mirrored into `isLeagueManager`) [V-community]. `status.lastUpdateInfo.clientAddress` is an IP address [V-observed]. Fixtures must strip all of these (§F.3).

### B.7 Live scoring and box scores

- `mLiveScoring` is stripped to `matchupPeriodId` per row anonymously (P14); what it adds with cookies is [U]. Community code that wants live totals uses `mMatchupScore` (`totalPointsLive`, `totalProjectedPointsLive`) and `mBoxscore`/`mScoreboard` with `scoringPeriodId` (S-PY `box_scores` sends `view=mMatchupScore&view=mScoreboard` plus the `filterMatchupPeriodIds` filter) [V-community].
- **"In progress" representation.** At probe time (Tuesday/Wednesday of week 4, before kickoff) every roster-entry stat for the current period was a projection (`statSourceId 1`; 79 of 79 entries in P06) and `totalPointsLive` was `0.0` while `totalProjectedPointsLive` was `100.8` [V-observed]. Once a game starts an actual entry (`statSourceId 0`, same `scoringPeriodId`) appears alongside the projection and `totalPointsLive`/`totalPoints` accumulate; S-PY picks the actual by `statSourceId == 0 and scoringPeriodId == week` (`box_player.py` L42–48) [V-community]. There is **no per-player "game in progress" flag** in the league payload: S-PY infers `game_played` from `proTeamSchedules_wl` game `date + 3 h` [V-community]; the per-game `statsOfficial` and `validForLocking` booleans in `proTeamSchedules_wl` (P20) are the closest server-side signals [V-observed field; semantics U].
- `playerPoolEntry.lineupLocked` / `rosterLocked` / `tradeLocked` booleans exist on every entry (P05) [V-observed]; `lineupLocked` presumably flips at kickoff ([U]).
- `polling-interval: 10` was returned on the `/communication/` endpoint (P27) — ESPN's own client polling hint, seconds presumably ([U]).

