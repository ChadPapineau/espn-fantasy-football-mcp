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

---

## C. Credentials: obtaining, storing, expiring, recovering

There is no OAuth, no API key and no developer program. Access to a private league is two browser cookies from a logged-in `espn.com` session: **`espn_s2`** (the bearer secret, a few hundred characters, URL-encoded on the wire) and **`SWID`** (the account's member id, a braced GUID). This section is written so the design does not depend on the one fact nobody could establish — how long `espn_s2` lives.

### C.1 How users obtain the cookies today

The instructions are the same in every wrapper and help page read [V-community ×5]:

- S-JS README L93: "You need two cookies from ESPN: `espn_s2` and `SWID`. These are found at "Application > Cookies > espn.com" in the Chrome DevTools when on espn.com."
- cwendt94/espn-api discussion #150 (dtcarls, 2020-11-19): "Right click anywhere on the website and click inspect option. From there click Application on the top bar. On the left under Storage section click Cookies then http://fantasy.espn.com."
- ffscrapr `espn_authentication` (2023-02-11): visit the league page logged in, open DevTools ("Inspect Element"), Storage/Application → Cookies → fantasy.espn.com; SWID "about 38 characters" **with** the braces; its `espn_s2` example is URL-encoded (`AECt%2F…`).
- keystone-fantasy README: "Filter for `espn_s2`, double-click its Value, select all, copy. It is a few hundred characters long." / "Filter for `SWID`, copy its value including the curly braces: `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`."
- S-SDM: "Keep the braces on `SWID`. These are session credentials for your ESPN account — treat them like a password." S-PSR: `espn_s2` "200+ alphanumeric characters", `SWID` "in format `{UUID}`".

**Braces.** Keep them. The wiki's constructor example passes `swid='{03JFJHW-…}'` (S-WIKI `Home.md`) and every observed member id — `members[].id`, `teams[].owners[]`, `teams[].primaryOwner` — is a 38-character string that begins with `{` (P05) [V-observed]; the write capture shows ESPN echoing `memberId` as `{<swid>}` (S-JW §2.3) [V-community]. Whether ESPN accepts a brace-less SWID is [U]; store it exactly as the browser shows it and validate `^\{[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}$`.

**Encoding.** `espn_s2` is shown URL-encoded in DevTools (`%2F`, `%2B`, `%3D` sequences; S-FFS and S-SDM examples) and every wrapper sends it **verbatim** in the `Cookie` header (S-JS `client.js` L362 `Cookie: espn_s2=${espnS2}; SWID=${SWID};`; S-PY passes a `cookies` dict to `requests`, which sends values unchanged; S-SDM one cookie string). Keep it encoded — that is the wire form the browser itself sends. cwendt94 #549 (2024-07-27) asked "does espn_s2 need URL-decoding?" and got no visible answer; whether a decoded value is also accepted is [U]. Practical pitfalls: `.env` parsers, shells and JSON editors mangle `%`, `+` and `=`; validate the stored value against `^[A-Za-z0-9%+/=._-]{100,}$` and warn if it contains whitespace or quotes.

**Third-party helpers.** A Chrome/Firefox extension "ESPN Cookie Finder" (publisher Hashtag Fantasy Sports, 5,000 users, v1.2 dated 2025-08-25) copies the two values; dtcarls recommends it (#150, 2025-08-20) [V-community]. We should not recommend it: it is an unaudited extension that reads authentication cookies, and DevTools is enough.

**No username/password path.** ESPN's login API gained reCAPTCHA in September 2020 (`PALOMINO_CHECK_FAILED`; cwendt94 discussion #128, 2020-09-24) and S-PY's `authentication()` is commented out with "Username and password no longer works using their API without using google recaptcha" (`espn_requests.py` L282–283) [V-community]. Never implement a password flow.

### C.2 Lifetime — what is actually known

| Claim | Source | Standing |
|---|---|---|
| "It remains the same through different sessions." | dtcarls, cwendt94 #150, 2020-11-19 | [V-community] — persistence across browser sessions, not a lifetime |
| "`espn_s2` expires every few weeks to months." | keystone-fantasy README, 2026 | [V-community] — operator experience, no attribute quoted |
| "two manually-extracted cookies with no refresh path that expire silently after weeks" / "Silent expiry is the top operational failure in this space" | jwulff/fantasy-sports #5, 2026-08-27 | [V-community] |
| "espn_s2 is a session cookie and will expire." | mykool223/CommissonersCartelFFL #5, 2026-08-21 | [V-community] |
| "can expire or change if you log out or ESPN resets your session" | leagueloom.com/espn (a hosted connector) | [V-community] — vendor statement |
| A DevTools screenshot or `Set-Cookie` capture showing `espn_s2`'s `Expires` attribute | — | **not found**; the login flow cannot be observed without an account, and the anonymous `www.espn.com` fetch today set no `SWID`/`espn_s2` (only `region` and `_dcf` on the fantasy.espn.com redirect, P02) |
| Rotation of `espn_s2` on each login; invalidation on log-out, "log out everywhere", or password change | — | **[U]** (leagueloom asserts log-out invalidates; no primary evidence) |

**Verdict: the `espn_s2` lifetime is [U]; the consistent community range is "weeks to months".** `SWID` is the account's member id — it is the key used for `members[].id`, `owners[]`, `memberId` (P05, S-JW) — so it is stable per account [V-observed role + V-community]; it is an identifier, not a secret, but it is personal data and must still not be logged.

**Design that does not depend on the lifetime:** record `storedAt` with the credential; report age (days) in `health`; treat any 401 on a league that previously read fine as "credential rejected" (§C.3); recommend a re-paste every 30 days in the setup output (conservative against "weeks"); never guess an expiry date.

### C.3 Expiry detection and graceful behaviour

**What a rejected credential looks like.** Read host, private league, no/invalid `espn_s2` → `401` with the typed body (S-SDM: `AUTH_LEAGUE_NOT_VISIBLE` "the cookie is fine but this league is not yours (or the cookie went stale)"; S-PY raises `ESPNAccessDenied`) [V-community]. Write host → `401 AUTH_MISSING_CREDENTIALS` for no cookies, for `SWID` only, **and for an invalid `espn_s2` with a valid `SWID`** (S-JW §5.1, probes p1/p13/p14) [V-community]. The important negative from S-JW: "the read host's 401 is typed and constant" — the body does **not** distinguish *expired* from *not your league*. Valid credentials → `200` with the full payload. On a **public** league an expired cookie is invisible (cookies are irrelevant; P01–P30 all 200 anonymously), so expiry can only be detected against a private resource.

**Cheap "am I still logged in" probes, assessed.**

| Candidate | Result | Standing |
|---|---|---|
| `x-fantasy-role` response header | `NONE` on all 24 anonymous 200s (P01–P30); S-JW saw `NONE` on every cookie-bearing response, including a commissioner's | **Not a login indicator** [V-observed + V-community] |
| `mNav` / `members[]` | returned to anonymous callers on a public league (P12) | not a login probe [V-observed] |
| `L/communication/?view=kona_league_communication` + `{"topics":{"limit":1,"sortMessageDate":{…}}}` | `401 AUTH_COMMUNICATION_NOT_VISIBLE` anonymously even on a public league (P27); `200 {topics:[]}` with cookies per S-PY `recent_activity`; `404 COMMUNICATION_GROUP_NOT_FOUND` if the league never used the board (S-PY comment, S-SDM) | **Usable read-only probe**: 200 or 404 = cookies accepted; 401 = rejected [V-observed 401 + V-community 200] |
| `L?view=mSettings` on the user's private league | 200 vs 401; 9 KB | **The definitive check** for the league that matters [V-community] |
| `fan.api.espn.com` preferences | account-scoped; needs cookies | [U] |

**Graceful-expiry behaviour (design):**

1. Every upstream 401 (and 403) on a request that carried cookies sets `credentialState = { status: "rejected", at, httpStatus, type }` and the tool returns a structured error `ESPN_AUTH_REJECTED` whose message says: which league, that the stored cookies were not accepted, that this usually means `espn_s2` expired, and the exact command to re-run setup. It does **not** say the cookie value, its length, or its fingerprint.
2. **No retry, no loop.** A 401 is never retried; further cookie-bearing calls are short-circuited with the same error until the user re-runs setup or explicitly calls `auth_check` (one probe, rate-limited to once per minute).
3. `auth_check` / `health` report `cookiesPresent: boolean`, `cookieAgeDays`, `lastAcceptedAt`, `lastRejectedAt` — never the values.
4. Logging: cookie values are redacted at the transport layer (a `Cookie`-header scrubber on every log line and error object); the only identifier ever logged is a 6-hex-char fingerprint of `sha256(espn_s2)`, and only at debug level.
5. Setup performs the definitive check immediately (one `mSettings` request against the configured league) so a mis-pasted value fails at setup time, not mid-week.

### C.4 Storage recommendation (local Node stdio server, macOS first; Windows/Linux too)

**Facts about this machine that constrain the choice** [V-observed, metadata only, no contents read]:

- `~/Documents` is iCloud-managed (`com.apple.file-provider-domain-id … com.apple.CloudDocs.iCloudDriveFileProvider`, `com.apple.icloud.desktop` xattrs; `MobileMeAccounts` `CLOUDDESKTOP` `Enabled = 1`). The repo lives under it, so **any file in the repo directory — including an ignored `.env` — is uploaded to iCloud.** `.gitignore` protects git, not iCloud.
- MCP client configs: `~/Library/Application Support/Claude/claude_desktop_config.json` is mode `0600`; `~/.claude.json` `0600`; `~/.claude/settings.json` **`0644`**. `~/Library` is not iCloud-synced by default. So "world-readable" is true of one of the three today, and none of them is designed to hold secrets.

| Option | Assessment |
|---|---|
| **(a) OS keychain** — macOS Keychain, Windows Credential Manager, Linux Secret Service/keyutils | Best at-rest protection; encrypted, ACL'd to the user, excluded from iCloud Drive (login keychain sync is a separate, opt-in iCloud Keychain feature). Two ways in: **`security` CLI** (`add-generic-password -a <account> -s <service> -w <secret>`, `find-generic-password … -w`; man page on this Mac) — shelling out puts the secret in the child's argv (briefly visible to `ps` for the same user) and in no shell history if invoked from Node; acceptable for a one-shot setup, not elegant. **`@napi-rs/keyring`** 2.1.0 (published 2026-09-13, MIT; Rust `keyring-rs` binding; repo `Brooooooklyn/keyring-node` active, last push 2026-09-25) ships **prebuilt binaries as 12 optional per-platform packages and has no install script** (`npm view` shows none) [S-NPM]. **`keytar`** 7.9.0: GitHub repo **archived 2022-12-12**, installs via `prebuild-install \|\| node-gyp rebuild` (network download or compile at install), needs libsecret on Linux — reject [S-NPM]. Friction to document: the first read from a different binary (the MCP server launched by the client vs. the setup CLI) can trigger a Keychain "allow access" dialog; items written by the `security` CLI and by a native module have different partition lists ([U] exact behaviour on this macOS; test during implementation). |
| **(b) `0600` JSON file** in a `0700` directory under `$XDG_CONFIG_HOME`/`~/.config/espn-ff-mcp/` (Windows `%APPDATA%\espn-ff-mcp\`), written atomically (temp file in the same dir + `fsync` + `rename`), permissions re-checked on every read | Adequate and portable; plaintext at rest but outside iCloud (`~/.config` is not under Documents/Desktop — the server must **verify** at startup that the directory carries no file-provider xattr and refuse to store if it does) and outside the repo. Loses to (a) only on at-rest protection against same-user malware/backups. |
| **(c) env vars in the MCP client config** | **Worst.** Plaintext in a JSON file the user edits, pastes into chat and screenshots for support; copied into backups/Time Machine; one of the three configs here is `0644`; the values are inherited by every child process and appear in crash dumps; no rotation story; and the MCP host may log the launch environment. Also the wrong *place*: the same file configures unrelated servers. Reject. |

**Recommendation:** default **(a)** via `@napi-rs/keyring` once the repo-security auditor clears the package and its platform sub-package for this machine; fallback **(b)** behind an explicit `--storage file` opt-in with the iCloud/xattr and mode checks. Never (c). Never accept the cookie as an MCP tool argument (it would enter the model context and the client's transcript logs). The repo directory holds nothing secret, ever.

**Setup procedure (both variants run in a terminal, outside the MCP session):**

- *Hidden-input prompt (default):* `npx espn-ff-mcp setup` → prints the three DevTools steps → prompts for `SWID` (echoed, it is an id) and `espn_s2` with echo **off** (readline with a muted output stream or `@inquirer/password`) → validates both formats → stores → runs the definitive check (`mSettings` on the configured league; expects 200) → prints only `stored: SWID ok (38 chars), espn_s2 ok (N chars), league check 200, age 0d`. On 401 it deletes what it stored and says so. Simple, no network listener, no page holding a secret.
- *Local one-shot setup page (optional):* bind `127.0.0.1` on a random high port; URL contains a 32-byte random token; the form is POST-only, includes the same token as a hidden field and is accepted only when `Host` is `127.0.0.1:<port>`, `Origin`/`Referer` match, the token matches, and it is the **first** submission; the listener closes after one accepted POST or 120 s; responses carry `Cache-Control: no-store`; nothing is logged. Better UX (instructions with screenshots, paste fields), larger surface (a socket, a browser tab and the clipboard holding the secret). Acceptable if all of those properties hold; offer it second.

### C.5 Browser cookie-store readers and automated logins — rejected

`browser_cookie3`-style extraction reads the browser's cookie database directly (Chrome's `Cookies` SQLite is encrypted with a key in the login keychain, so reading it prompts for "Chrome Safe Storage" — the exact behaviour of credential-stealing malware; Safari's store is Full-Disk-Access-gated), and Selenium/Playwright logins (the accepted workaround in cwendt94 #128, 2021-01-13) drive a real browser through a reCAPTCHA-protected login. **Recommendation: reject both.** They are invasive and brittle — they touch the user's browser profile and keychain in a way indistinguishable from credential theft, and they break on cookie-encryption, profile-path and reCAPTCHA changes — and they move the project from "the user pastes their own session" to "software harvests credentials", which reads directly onto S-DTOU §2.B.ix ("bypass … circumvent any of the functions or protections") rather than only §2.B.x.

### C.6 Rotation without OAuth

"Rotate" can only mean: log out of ESPN in the browser (best-effort invalidation of the old `espn_s2`), log back in, copy the new cookies, re-run setup (which overwrites and re-checks). Whether log-out, "log out everywhere", or a password change actually invalidates an outstanding `espn_s2` is **[U]** (asserted by leagueloom, unverified anywhere primary); whether a new login issues a new `espn_s2` value is [U] (dtcarls' "remains the same through different sessions" suggests reuse while the browser keeps the cookie, not reissue). Emergency procedure if a cookie is exposed: change the Disney/ESPN password and use the account's sign-out-everywhere control, then re-run setup — expected to help, [U] that it is sufficient. `health` shows the credential age so the user can rotate on a schedule regardless.

---

## D. Terms of service, rate limits, account risk

### D.1 The governing text

**Disney Terms of Use (United States), "Last Updated: May 24, 2024"** (https://disneytermsofuse.com/english/, fetched 2026-09-30) [V-docs]. The agreement covers "websites, software, applications, content, products, and services … ('Disney Products')" from Disney and its affiliates; the ESPN fantasy site is one. The clauses that bear on this project, quoted verbatim:

- §2.B.x — you may not "access, monitor, copy or extract the Disney Products using a robot, spider, script, or other automated means, including, for the avoidance of doubt, for the purposes of creating or developing any AI Tool, data mining or web scraping or otherwise compiling, building, creating or contributing to any collection of data, data set or database (other than for a public search engine's use of spiders for creating search indices to the extent not disallowed by Disney, including through the applicable robots.txt files or NOINDEX or NOFOLLOW meta-tags)".
- §2.B.ix — "bypass, modify, defeat, tamper with or circumvent any of the functions or protections of the Disney Products".
- §2.B.viii — "use the Disney Products for any commercial or business-related use or build a business utilizing the Disney Products, or engage in any activity to enable third parties to engage in any of the foregoing activities, in each case whether or not for profit".
- §2.A (consumer licence) excludes use "in connection with any use, creation, development, modification, prompting, fine-tuning, training, testing, benchmarking or validation of any artificial intelligence or machine learning tool, model, system, algorithm, product or other technology ("AI Tool") … (except as may be expressly described within the Disney Product or used in a Disney Product in the manner for which it was intended)".
- §1.H (Termination or Suspension) — "We may terminate or suspend your access to any Disney Products, and/or terminate this Agreement … if we have objective reason to believe you have used the Disney Products in violation of any provision of this Agreement or any supplemental terms".

**ESPN Fantasy "Fair Play and Conduct" (support.espn.com, "Updated: August 04, 2026")** [V-docs]: governs one-person-one-team, collusion, cycling players through free agency, roster dumping and manager conduct; sanctions are "team cancellation and expulsion from the game" and being "prohibited from participating in future ESPN Fantasy Games". It says nothing about scripts, automation or the API. The fantasy-specific "Rules – Legal Restrictions" and "Terms & Conditions" pages on `www.espn.com` **could not be read today** — every fetch returned `202` with an empty body from CloudFront (bot gate) — so any automation clause specific to the fantasy game is **[U]**. There is no ESPN page about API use at all; no developer program, key or quota exists [V-observed negative; S-SDM "No API key exists for either"].

**Plain reading.** A script that reads a user's own league through the JSON API and hands the data to an AI assistant is inside the literal text of §2.B.x ("script, or other automated means … for the purposes of creating or developing any AI Tool") and §2.A ("prompting … any artificial intelligence … tool"). The frequently repeated community view — S-STM (2019): "To my knowledge there is nothing against ESPN's ToS about using your own cookies for personal use within your own league" — is folklore and is wrong on the current text. finger-six/fantasy_bot #8 (2026-09-22) reads the same terms and concludes "Disney's current U.S. terms restrict automated extraction and gameplay without written permission" [V-community].

### D.2 Enforcement evidence — verified vs folklore

Verified, dated events (none is an account action against a user):

| When | What | Evidence |
|---|---|---|
| Feb 2019 | v2 → v3 API migration broke every wrapper | S-JS README "ESPN API Changes" [V-community] |
| Sep 2020 | reCAPTCHA added to the Disney login API; username/password automation dead (`PALOMINO_CHECK_FAILED`) | cwendt94 #128 [V-community] |
| Apr 2024 | read host moved to `lm-api-reads.fantasy.espn.com`; the old host began answering 403/redirects to everyone | cwendt94 #539 (2024-04-23: "I have been working with the API for the past few weeks with no issues. However, when restarting my kernel … I was given a 403 error"), PR #540 merged 2024-04-25; S-STM update; S-PSR [V-community]; old host `302` today (P02) [V-observed] |
| 2026-09-30 | bot gating on ESPN's **web pages** and on `site.api.espn.com` for a scripted client: `202` empty (CloudFront) on every `www.espn.com` page; `403 "Access Denied"` HTML on the news endpoint (P26) — while the read API host served 30 requests, including one with curl's default User-Agent, with no challenge (P30) | [V-observed] |

Not found: any first-person, dated report of an ESPN/Disney account suspended or an IP blocked for reading one's own league through the API with one's own cookies — not in the issue trackers of S-PY or S-JS, not in the searches run today (`"espn_s2" … suspended OR banned OR "Access Denied"`, `"lm-api-reads" … 429 OR 403 rate limit`). Long-running cookie-based community services (GameDayBot's help page, keystone-fantasy, League Loom) publish these instructions openly. "ESPN might ban you" appears in forums without a case behind it. Absence of evidence is not evidence of absence: §1.H gives Disney the right, and the April 2024 change shows infrastructure moves happen without notice.

### D.3 Rate limits and the polite-usage design

**Observed numbers: none.** No documentation exists; no rate-limit, quota or `Retry-After` header appeared on any of 30 responses (§A.4) [V-observed negative]. S-PSR's "excessive requests may be blocked" is an assertion without a case. **What the wrappers do: nothing.** S-PY issues plain `requests.get` with no retry, no backoff and no cache, pulls the 2,663-row `players_wl` at construction, and `box_scores()` costs three requests (schedule, pro schedule, positional ratings); S-JS uses bare axios with no retry [V-community]. Sizes seen today: 3.2 MB for the wrappers' default five-view bootstrap (P05), 5.7 MB for a full-pool `kona_player_info` (P24) — neither belongs inside a tool call.

**Design (numbers are proposals calibrated to the observed sizes and `max-age`s):**

| Concern | Rule |
|---|---|
| Cache TTLs per view | `mSettings` 24 h (invalidate when `status.standingsUpdateDate`/`waiverLastExecutionDate` change); `mTeam`+`mStandings` 15 min in-week; `mRoster` 5 min in-week, 60 min off-season; `mMatchupScore`/`mBoxscore` **60 s inside game windows** (kickoff − 15 min to kickoff + 4 h, computed from `proTeamSchedules_wl` game `date`s), 10 min otherwise; `kona_player_info` free-agent lists 60 min; `kona_playercard` 6 h; `mTransactions2`/`mPendingTransactions` 10 min; `mDraftDetail` immutable once `draftDetail.drafted` is true; `players_wl` and `proTeamSchedules_wl` 24 h (server `max-age=300`, but the data changes weekly) |
| Conditional requests | send `If-None-Match` with the stored weak ETag (stable for identical bodies, P04/P30); benefit [U] until a 304 is observed |
| Single-flight | coalesce identical in-flight (URL + filter header) requests; compose views into one request the way the wrappers do (`mTeam&mRoster&mMatchup&mSettings&mStandings`) rather than five |
| Backoff | on 429 and 5xx: exponential 1 s, 2 s, 4 s, 8 s with ±25 % jitter, max 3 retries, honour `Retry-After` if it ever appears; on 400/401/403/404: **never retry** |
| Hard caps | token bucket **≤ 30 requests/min, ≤ 1 request/s sustained, ≤ 2 concurrent** per process; a global circuit breaker opens for 5 min after 3 consecutive 5xx/429 |
| Per-tool-call budget | ≤ 3 upstream requests per tool call (most tools need 1); a tool that would exceed it returns what it has plus an explicit "partial" flag |
| Drift probe | 1 request/day against the public fixture league (§F.2) |
| Identification | a fixed, honest `User-Agent: espn-ff-mcp/<version> (+<repo URL>)` — the API host does not gate on UA (P30), and spoofing a browser to get past a gate would be the §2.B.ix behaviour we must avoid; if the API host ever starts blocking that UA, stop and report rather than impersonate |
| Payload hygiene | never pull `allon`, never pull the full pool per call; page `kona_player_info` at ≤ 100 with a sort; request only the views a tool needs |

### D.4 Risk assessment in plain language

**What the text says:** the Disney Terms of Use, as updated May 24, 2024, prohibit automated access by script and use with AI tools, and let Disney suspend an account for it. This project is inside that text. Nothing in ESPN's fantasy fair-play rules addresses it, and the fantasy-specific legal pages could not be read.

**What happens in practice:** in seven years of public wrappers, MCP servers and hosted cookie-based services, no verified account suspension or IP block for reading one's own league was found; every documented breakage was ESPN changing infrastructure (2019, 2020, 2024) with no notice. The read API host today serves anonymous scripted clients without challenge; ESPN's web pages and its news host do not.

**The realistic risks, in order:** (1) silent breakage when ESPN moves a host or renames a field (§F); (2) leaking `espn_s2`, which is a password-equivalent for the whole ESPN/Disney account (§C.4); (3) a write mistake that changes a real lineup (§E); (4) an account action by ESPN — possible under §1.H, unobserved in the record.

**Mitigations that define the project:** personal use by the account owner on their own single league; read-mostly with writes off by default and confirmed per action; aggressive caching and hard request caps (tens of requests per day, not per minute); honest identification; no redistribution, resale or dataset-building; no model training on the data; secrets in the OS keychain, never in the repo or the client config; a `health` tool that says when the credential was last accepted. With those in place the exposure is one person's fantasy account, and the failure mode to design for is drift, not enforcement.

---

## E. Write endpoints — documented, not probed, and a recommendation

**Nothing in this section was exercised by this research.** It is assembled from a community capture study that executed 21 requests against its author's own league on 2026-09-12 (S-JW; ten executed, eleven rejected, every lineup change reversed), ESPN's own client code as transcribed by S-SDM, and three community implementations (S-HEY `constants.ts`; `mcolen5050/FantasyFootballAutomation_public` `main.py` L111–130; `AbdulsaboorS/fantasybasketballbot` `espn_lineup.py` L37–163). All of it is [V-community].

### E.1 Host, method, headers

- `POST https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{id}/transactions/` — same path family as reads, different host; `GET` on it → `405 HTTP_METHOD_NOT_SUPPORTED` (S-JW §1.1, S-SDM). S-PY v0.46.0 has no reference to the write host (S-JW §10).
- Required: `Content-Type: application/json` and the **`espn_s2` cookie**. Everything else is optional per S-JW's variation probes (§2.2): the `SWID` cookie, the body's `memberId`, and the `x-fantasy-source: kona` / `x-fantasy-platform: kona-PROD` headers that the browser sends (community scripts send `x-fantasy-platform: espn-fantasy-web`, `x-fantasy-source: kona` — S-HEY `WRITE_HEADERS`, AbdulsaboorS L41–45). Two scripts assert `memberId` is required (mcolen5050, AbdulsaboorS L109); the capture study shows it is not — a discrepancy worth a note, not a dependency.

### E.2 Payload shapes (as the community encodes them)

Envelope (S-JW §2.1 capture; S-SDM transcription of `createTransaction`): `type` (`ROSTER` for lineup moves; `FREEAGENT`, `WAIVER`, `TRADE_PROPOSAL`, `TRADE_ACCEPT`, `TRADE_DECLINE`, `DRAFT` also exist), `teamId`, `scoringPeriodId`, `executionType` (`EXECUTE`; `CANCEL` withdraws a pending claim; `VALIDATE` → `400 Invalid Input.` — **there is no dry-run mode**), `items[]`, optional `memberId` (`{SWID}`), `bidAmount` (FAAB, `WAIVER` only), `isLeagueManager` / `isActingAsTeamOwner` / `skipTransactionCounters` (leave `false`), `comment`, `expirationDate`, `relatedTransactionId`. Items: lineup `{playerId, type: "LINEUP", fromLineupSlotId, toLineupSlotId}`; add `{playerId, type: "ADD", toTeamId}`; drop `{playerId, type: "DROP", fromTeamId}` (S-SDM). The success response echoes the envelope with `status: "EXECUTED"` (or `PENDING` for a waiver claim), a UUID `id`, and items expanded with `fromTeamId, toTeamId, isKeeper, overallPickNumber` (S-JW §2.3). `mRoster` and `mTransactions2` reflected the change within ~1.5 s (S-JW §9).

### E.3 Rules and failure modes (S-JW §3–5, S-SDM)

| Rule | Wire behaviour |
|---|---|
| One POST, many items, **atomic** | a batch containing any rejected item applies nothing |
| Items must describe only slots that change | `fromLineupSlotId == toLineupSlotId` → `409 TRAN_ROSTER_SAME_SLOT` ("<player> is already in the RB slot") |
| A player whose game has started is locked | `409 TRAN_LINEUP_LOCKED` ("Lineup transaction could not be completed, <player> is locked") |
| Slot capacity | `409 TRAN_ROSTER_SLOT_LIMIT_EXCEEDED` ("Too many players in the WR slot (maximum 2)", `metaData: {"teamid": "1"}`) |
| Writes target only the league's **current** `scoringPeriodId` | `409 TRAN_INVALID_SCORINGPERIOD_NOT_CURRENT` for next week and for week 18 alike |
| Missing/invalid `espn_s2` | `401 AUTH_MISSING_CREDENTIALS` ("Unauthorized:  Credentials are missing.", two spaces) |
| Malformed body / unknown enum | `400 {"messages": ["Invalid Input."]}` with **no** `details[]` |
| Roster full, position limit, budget exceeded, drop of a non-owned player | `409` with a `TRAN_*` type — named by S-SDM (`TRAN_ROSTER_LIMIT_EXCEEDED*`, `TRAN_ROSTER_POSITION_LIMIT_EXCEEDED`), **not observed** by S-JW; [U] |
| Authority | the **session** confers authority, not the body: a commissioner's `espn_s2` with `isLeagueManager: false` executed a lineup change on **another manager's team** (`200 EXECUTED`, S-JW §6.1, immediately reversed). Commissioner = `isLeagueCreator OR isLeagueManager` from `mNav` (§B.6). |
| `X-Fantasy-Role` | read `NONE` on every write-host response, even the commissioner's — not an authority signal |

### E.4 Recommendation

**Do not ship a write module in v1.** If one is built later, it is a separate, opt-in module with these properties, each of which follows from a failure mode above:

1. Off by default (`ESPN_FF_WRITES=off`), enabled per session; every write tool is absent from the tool list when off.
2. **Lineup moves only** in the first version (`type: ROSTER`, `LINEUP` items). No add/drop, waiver claims or trades — those change the league's competitive state irreversibly (a waiver claim is `PENDING` and processes later; a drop cannot be undone if another team claims the player).
3. **Two-step confirmation per action**: `propose_lineup` computes the diff from the current `mRoster` (only changed slots, never a no-op item), pre-flights `lineupLocked`, slot counts (`rosterSettings.lineupSlotCounts`) and eligibility (`eligibleSlots`), and returns a human-readable diff plus a one-time token; `execute_lineup(token)` sends exactly that diff with `scoringPeriodId` = the league's current period from the bootstrap payload, then **re-reads `mRoster` and reports the actual result** — the `EXECUTED` status is not trusted on its own.
4. `teamId` is pinned to the team whose `owners[]` contains the stored `SWID`; any other target is refused client-side, because ESPN will not refuse it for a commissioner. `isLeagueManager` is never sent as `true`.
5. Hard cap (e.g. 5 writes per day), an anonymized local journal of every request/response, and no writes inside the 15 minutes before any kickoff of a player involved.
6. Every `TRAN_*` type is surfaced verbatim so an unknown code is visible, never mapped to "try again".

**Account-risk delta versus read-only.** A read looks like a page view and, if ESPN objects, costs at most the account. A write changes league state under the account's identity: a bug or a prompt-injected instruction could bench a starter, and with a commissioner's cookie could alter *another* team — which is precisely what the Fair Play rules police ("team cancellation and expulsion", S-FAIR) and what the rest of the league would see. Writes also live on a separately named host whose monitoring is unknown ([U]). The delta is from "possible terms exposure" to "possible competitive-integrity incident with a human audience", which is why the default is off and the first version is lineup-only with a confirmation step.

---

## F. API-drift resilience — design input

### F.1 What the community has seen, with dates

| When | Change | Evidence |
|---|---|---|
| Feb 2019 | v2 → v3 API; every wrapper rewritten | S-JS README "ESPN API Changes" [V-community] |
| by 2019-02-01 | ESPN deleted pre-2017 data (box scores gone); ≤2017 seasons moved to `leagueHistory/{id}?seasonId=` returning an array | S-JS README "ESPN Databases and Data Storage"; S-STM 2019-07-27 [V-community] |
| 2019-09-10 | "espn_s2 cookie no longer exists?" (mkreiser #133) — a user could not find it; no rename occurred: the names `espn_s2` / `SWID` are unchanged in every 2026 source | [V-community] |
| Sep 2020 | reCAPTCHA on the Disney login API; password automation dead | cwendt94 #128 [V-community] |
| Apr 2024 | read host → `lm-api-reads.fantasy.espn.com`; the old host began returning 403, now 302s to a marketing page | cwendt94 #539/#540; S-STM; S-PSR [V-community]; P02 [V-observed] |
| ≤ 2026-09 | read/write host split (`lm-api-writes`) — invisible to read-only wrappers | S-JW, S-SDM, S-HEY [V-community] |
| 2020 → 2026 | `status.finalScoringPeriod` 16 → 17 with the 17-game NFL season (`latestScoringPeriod` reached 18 in 2020) — constants like "18 = end of season" in S-JS README are stale | P01 vs P04 [V-observed] |
| 2026-09-30 | `site.api.espn.com` news endpoint (still hard-coded in S-PY) answers 403 to scripted clients; `www.espn.com` pages return empty 202s | P26, ToS fetches [V-observed] |
| undated | a dozen view names circulating in blog posts that do nothing (`player_wl`, `mLiveScoringDetail`, `mLeagueSettings`, …); S-PY's own TODOs on duplicate stat ids (22/3, 40/24, 61/42, 53/41, 187/120, 206/205) suggest ids were added over time; 103/104 disagree between wrappers; `TRADE_ACCEPT` vs `TRADE_ACCEPTED` | S-SDM, S-PY `constant.py` [V-community] |

**Cadence:** one breaking transport change roughly every 2–5 years (2019, 2024), unannounced; additive field/enum changes continuously and silently; view names never error when wrong. That is what the design below is sized for.

### F.2 Resilience design

- **Schemas.** One zod schema per view (and per shared entity: `team`, `rosterEntry`, `player`, `stats`, `scheduleItem`, `settings.*`, `status`), `.passthrough()` on every object so unknown fields flow through untouched; **required** fields are only those a tool actually reads, and a missing required field is a **hard failure** (`SCHEMA_DRIFT` error naming the JSON path and the view) — never a silent default. Enum fields are `z.string()` with a known-value set checked separately: an unknown value is accepted, counted and logged, except for `statSourceId`/`statSplitTypeId`, where an unknown value fails the stat entry (it changes meaning). Skeleton detection: a league response without the keys the requested views should add (e.g. `mRoster` without `teams[].roster`) is treated as drift, because ESPN returns 200 for unknown views (P28).
- **Fixtures.** The anonymized bodies of P04–P28 are the seed corpus (one file per view, plus the three error bodies); `fixtures/manifest.json` records, per view, the top-level key set, per-entity key sets, observed enum values, array lengths and the server date. Contract tests: every schema parses its fixture; every "required" set is a subset of the manifest's observed keys; the error-shape parser accepts the 400/401/404 fixtures.
- **Drift detector.** A daily job (also runnable as `health --probe`) makes **one** request — `mSettings` (plus `mNav`, same request) on the public fixture league — and diffs top-level keys, `settings.*`/`status` key sets and enum values against the manifest. Any difference fails loudly with an added/removed diff written to the health state and to stderr; the host is also checked (a 3xx or non-JSON body = "host moved" alert). It **never auto-adapts**; a human updates the manifest after reading the diff.
- **`health` / `version` tool** reports: API host in use; last successful probe (time, status); schema/manifest version (hash); `cookiesPresent`, `cookieAgeDays`, `lastAcceptedAt`, `lastRejectedAt` (booleans and timestamps only); cache state (entries, hit ratio, oldest entry, per-view TTLs); rate-limiter state (tokens, breaker open?); the current drift diff if any; the read-only/writes-off flag.
- **Graceful degradation.**

| Tool group | Needs | Works without cookies on a public league | Works with a private league and cookies | Degrades to |
|---|---|---|---|---|
| settings, teams, standings, schedule, draft | `mSettings`, `mTeam`, `mStandings`, `mMatchup`, `mDraftDetail` | yes (P04, P05, P16) | yes | — |
| rosters, box scores, matchup live totals | `mRoster`, `mBoxscore`, `mMatchupScore` | yes (P05–P07) | yes | without `mBoxscore`: totals only from `mMatchupScore` |
| free agents, player search, projections, outlooks | `kona_player_info`, `kona_playercard` | yes (P09, P21) | yes | without `kona_playercard`: no weekly actuals |
| NFL schedule, byes, player universe | `proTeamSchedules_wl`, `players_wl` | yes, no league id (P20, P23) | yes | — |
| transactions, pending claims, activity feed, live scoring | `mTransactions2`, `mPendingTransactions`, `/communication/`, `mLiveScoring` | **no** (empty / 401 / stripped) | yes [V-community] | tool reports "requires stored cookies" |
| player news articles | `site.api.espn.com` news | no (403) | no | `seasonOutlook` / `outlooksByWeek` from league views |
| seasons ≤ 2017 | `leagueHistory` | [V-community] | [V-community] | tool refuses seasons before 2018 unless the array route is implemented and tested |

### F.3 Fixture-anonymization procedure

Run by a script over raw captures kept **outside** the repo; only the output is committed.

1. **Strip or replace** — league `id` → `0`; `settings.name` → `"League"`; `divisions[].name` → `"Division <n>"`; `teams[].name/abbrev/location/nickname/logo` → `"Team <n>"`, `"T<n>"`, `""`, `""`, `""`; `members[].displayName/firstName/lastName` → `"Member <n>"`, `""`, `""`; `notificationSettings` removed; every member GUID (`members[].id`, `teams[].owners[]`, `teams[].primaryOwner`, `draftDetail.picks[].memberId`, `transactions[].memberId`) → a deterministic fake built from first-appearance order (`{00000000-0000-4000-8000-0000000000<nn>}`), one mapping applied everywhere; `status.lastUpdateInfo.clientAddress` → `"0.0.0.0"`; `tradeBlock`, `draftStrategy` → `{}`; any message-board/activity text removed; `player.seasonOutlook` and `outlooks.outlooksByWeek[*]` → `"[outlook <length> chars]"` (keeps the shape, avoids republishing editorial text, shrinks the file); `logo` URLs → `""`. Player names, ids and pro-team ids stay (public entities). Timestamps stay (they are league-level, not personal).
2. **Determinism** — stable key order (sorted), arrays sorted by `id` where an `id` exists, the GUID map by first appearance, a fixed `capturedAt` recorded in the manifest instead of the `x-fantasy-server-time` header; running the script twice on the same input yields byte-identical output.
3. **Verification** — a test greps every committed fixture for: brace-GUID patterns not in the fake range, IPv4 addresses, the real league id, and every string in a local, uncommitted denylist of the real team/member names captured at anonymization time; any hit fails CI.
4. **Manifest** — generated *after* anonymization from the committed fixtures, so the detector compares against exactly what the tests use.

---

## G. Verified / unverified ledger and probe log

### G.1 Unverified, by name

1. The read host's 401 body for a **private league** (community: `AUTH_LEAGUE_NOT_VISIBLE`); both published example ids tried were 404.
2. `espn_s2` lifetime (no `Expires` attribute observed anywhere); whether a new login reissues it; whether log-out, "log out everywhere" or a password change invalidates it.
3. Whether ESPN accepts a brace-less `SWID` or a URL-decoded `espn_s2`.
4. The `leagueHistory` array response shape for seasons ≤ 2017 (the probe league starts in 2018).
5. What `mLiveScoring` returns with cookies; whether anonymous callers ever see a public league's `mTransactions2`/`mPendingTransactions`; the field names of `pendingTransactions[]`.
6. `forTeamId` / `rosterForTeamId` semantics; `matchupPeriodId` as a URL parameter; segments other than `0`; the effect of `mTopPerformers`.
7. `statSplitTypeId = 2`; the id format of weekly-actual `stats[]` entries; the `rankSourceId` → source map; the meaning of the `ratings` key `"0"`.
8. The non-FAAB `acquisitionSettings.acquisitionType` value(s) and the meaning of `waiverOrderReset`; the integers in `status.waiverProcessStatus`; further values of `scoringType`, `matchupTieRule`, `playoffTierType`, `lineupLocktimeType`, roster-entry `acquisitionType`/`status`, and `injuryStatus` (`SUSPENSION`).
9. Stat ids 103 vs 104 (swapped between the Python and JS maps); `TRADE_ACCEPT` vs `TRADE_ACCEPTED`.
10. `x-fantasy-role` values other than `NONE`; whether `X-Fantasy-Last-Update-League` appears on reads; `polling-interval` units; whether `If-None-Match` yields 304.
11. When `rosterForMatchupPeriod` is populated; when `lineupLocked` flips; the semantics of `statsOfficial` and `validForLocking`.
12. Whether `limit` on the league path also requires a sort (every probe with `limit` included one).
13. The whole write surface (§E): never probed here; in particular the 409 types for budget-exceeded, position-limit, roster-full and drop-not-owned; the `CANCEL` and trade payloads; `isLeagueManager: true`; whether the write host is monitored differently.
14. Keychain behaviour between the `security` CLI and `@napi-rs/keyring` (partition lists; first-read prompt for the MCP server binary).
15. ESPN's fantasy-specific "Legal Restrictions" / "Terms & Conditions" text (pages bot-gated today).
16. `fan.api.espn.com` as a login probe; the filter keys `filterRanksForScoringPeriodIds`, `filterRanksForSlotIds`, `filterProTeamIds`, `filterInjured`.

### G.2 Probe log

All `GET`, unauthenticated, no cookies, ≥ 1.3 s apart, 2026-09-30 UTC. `User-Agent` = a desktop Chrome string except P30 (curl default). `R` = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl`; `L` = `R/seasons/2026/segments/0/leagues/[league-id]`. The league id is the public example in ffscrapr's ESPN vignette; the two other ids are the wiki's and the JS README's example ids (both 404 today).

| # | time | URL | status | bytes | top-level keys / note |
|---|------|-----|--------|-------|-----------------------|
| 01 | 03:26:52 | `R/seasons/2020/segments/0/leagues/[league-id]?view=mSettings` | 200 | 9,164 | draftDetail, gameId, id, scoringPeriodId, seasonId, segmentId, settings, status |
| 02 | 03:26:53 | `https://fantasy.espn.com/apis/v3/games/ffl/seasons/2020/segments/0/leagues/[league-id]?view=mSettings` | 302 | 13 | `Location: https://www.espn.com/fantasy/`; body "Redirecting", text/plain |
| 03 | 03:26:55 | `R/leagueHistory/[league-id]?seasonId=2020&view=mSettings` | 404 | 150 | messages, details → `GENERAL_NOT_FOUND` |
| 04 | 03:26:56 | `L?view=mSettings` | 200 | 9,004 | as 01; `status.currentMatchupPeriod` 4, `latestScoringPeriod` 4, `finalScoringPeriod` 17, `previousSeasons` 2018–2025 |
| 05 | 03:29:05 | `L?view=mTeam&view=mRoster&view=mMatchup&view=mSettings&view=mStandings` | 200 | 3,162,832 | + members, schedule, teams; `x-fantasy-filter-player-count: 951` |
| 06 | 03:29:06 | `L?view=mMatchupScore&scoringPeriodId=4` | 200 | 212,878 | schedule (75); current rows carry `totalPointsLive`, `totalProjectedPointsLive`, `winProbability`, `rosterForCurrentScoringPeriod` |
| 07 | 03:29:08 | `L?view=mBoxscore&scoringPeriodId=4` | 200 | 324,669 | schedule + settings + teams; rows lack `winner`/`playoffTierType` |
| 08 | 03:29:10 | `L?view=mScoreboard&scoringPeriodId=4` | 200 | 394,829 | draftDetail, id, schedule, settings, status, teams; rows lack `matchupPeriodId` |
| 09 | 03:29:12 | `L?view=kona_player_info&scoringPeriodId=4` + filter (FREEAGENT/WAIVERS, slot 2, limit 5, sortPercOwned, sortDraftRanks) | 200 | 67,400 | players (5), positionAgainstOpponent; count header 196 |
| 10 | 03:29:13 | `L?view=mPendingTransactions` | 200 | 964 | pendingTransactions: [] |
| 11 | 03:29:15 | `L?view=mTransactions2&scoringPeriodId=4` + filter (FREEAGENT, WAIVER, WAIVER_ERROR, TRADE_ACCEPT) | 200 | 1,067 | transactions: []; `x-fantasy-filter-transaction-count: 0` |
| 12 | 03:29:16 | `L?view=mNav` | 200 | 5,300 | members (+isLeagueCreator, isLeagueManager), teams (slim), settings (subset) |
| 13 | 03:30:37 | `L?view=mStatus` | 200 | 1,049 | status (+lastUpdateInfo{clientAddress, platform, source}) |
| 14 | 03:30:38 | `L?view=mLiveScoring&scoringPeriodId=4` | 200 | 2,632 | schedule rows contain only `matchupPeriodId` |
| 15 | 03:30:40 | `L?view=mPositionalRatings&scoringPeriodId=4` | 200 | 9,381 | positionAgainstOpponent.positionalRatings{1,2,3,4,5,16} × 32 opponents |
| 16 | 03:30:41 | `L?view=mDraftDetail` | 200 | 42,389 | draftDetail{completeDate, drafted, inProgress, picks[150]} + settings |
| 17 | 03:30:43 | `L?view=mSchedule` | 200 | 939 | skeleton only |
| 18 | 03:30:44 | `L?view=modular` | 200 | 939 | skeleton only |
| 19 | 03:30:46 | `R/seasons/2026/players?view=players_wl` + `{"filterActive":{"value":true},"limit":5}` | 400 | 284 | `FILTER_LIMIT_MISSING_SORT` |
| 20 | 03:30:47 | `R/seasons/2026?view=proTeamSchedules_wl` | 200 | 109,067 | display, settings.proTeams[33]; `cache-control: max-age=300`, CloudFront hit |
| 21 | 03:32:51 | `L?view=kona_playercard` + `filterIds` (1 id), `filterStatsForTopScoringPeriodIds` | 200 | 13,114 | players[1]: seasonOutlook (739 chars), outlooks.outlooksByWeek{2,3,4}, lastNewsDate, transactions, waiverDate, weekly actual splits |
| 22 | 03:32:53 | `R/seasons/2026/segments/0/leagues/[wiki-example-id]?view=mSettings` | 404 | 150 | `GENERAL_NOT_FOUND` |
| 23 | 03:32:54 | `R/seasons/2026/players?view=players_wl` + `{"filterActive":{"value":true}}` | 200 | 663,713 | JSON array, 2,663 players; count header 2663 |
| 24 | 03:32:57 | `L?view=kona_player_info&scoringPeriodId=4` + `{"players":{"limit":5000,"offset":0,"sortPercOwned":{…}}}` | 200 | 5,660,652 | players[951] = count header 951 (no ceiling hit) |
| 25 | 03:32:58 | as 09 with `offset: 5` | 200 | 66,078 | 5 players, zero overlap with 09; count header 196 |
| 26 | 03:33:00 | `https://site.api.espn.com/apis/fantasy/v3/games/ffl/news/players?playerId=[player-id]` | 403 | 442 | HTML "Access Denied" (edge bot block) |
| 27 | 03:33:01 | `L/communication/?view=kona_league_communication` + topics filter | 401 | 304 | `AUTH_COMMUNICATION_NOT_VISIBLE`; `polling-interval: 10` |
| 28 | 03:33:03 | `L?view=mBogusViewName` | 200 | 2,142 | skeleton: gameId, id, members, scoringPeriodId, seasonId, segmentId, settings{name}, status, teams{abbrev, id, owners} |
| 29 | 03:34:37 | `R/seasons/2026/segments/0/leagues/[readme-example-id]?view=mSettings` | 404 | 150 | `GENERAL_NOT_FOUND` |
| 30 | 03:34:39 | `L?view=mSettings`, curl default User-Agent | 200 | 9,004 | byte-identical to 04, same weak ETag |

Headers common to every 200 from the read host: `content-type: application/json;charset=utf-8`, weak `etag`, `cache-control: must-revalidate`, `expires: -1`, `x-fantasy-server-time`, `x-fantasy-role: NONE`, `x-fantasy-filter-player-count`, CloudFront `via`/`x-cache`, permissive CORS. **No rate-limit or `Retry-After` header on any response.**

Non-API page fetches made for §D (not probes, no league data): `www.espn.com` rules/terms pages ×3 and `www.espn.com/fantasy/football/` → `202`, 0 bytes, `x-cache: Error from cloudfront`; `espn.co.uk` rules page → `202`, 0 bytes; `support.espn.com` Fair Play article → 200; `disneytermsofuse.com/english/` → 200 (112 KB).

Raw probe bodies and headers were kept only in the session scratchpad outside the repo and are not committed; the anonymized shapes above and in §A–§B are the record.
