# espn-api-specialist — working notes

Role: ESPN unofficial-API specialist. Deliverable: `docs/research/03-espn-api.md`
(sections A–G). No credentials, no write endpoints, ≤30 unauthenticated GETs against
a public league id taken from community docs (the ffscrapr ESPN vignette's example
league), ≥1 s apart, everything anonymized before it lands here.

## RESUME HERE

- Status (2026-09-30 03:40Z): **research complete, probe budget exhausted (30/30)**;
  writing `docs/research/03-espn-api.md` section by section. If this file is the
  latest commit and `03-espn-api.md` is absent or partial, resume by writing the
  missing sections from the notes below and the raw probe bodies in the scratchpad
  (`.../scratchpad/espn-specialist/probes/b01..b30.json`, headers `h*.txt`;
  scratchpad is outside the repo and may be gone — the notes below are sufficient).
- Do NOT run more probes; the budget is spent. Everything needed is recorded here.
- Sections landed in `03-espn-api.md`: (update as they land) none yet.

## Sources gathered (all read statically; nothing executed)

- Clones in scratchpad (`espn-specialist/`): `cwendt94/espn-api` @ 663d726,
  its wiki @ 1c632cf, `mkreiser/ESPN-Fantasy-Football-API` @ 18b6bf2.
- Community files via `gh api repos/.../contents` (base64-decoded, read only):
  jwulff/fantasy-sports `docs/research/05-espn-write-surface.md` (write-surface
  capture study, 2026-09-12) and `docs/memory/commissioner-authority-is-two-flags-in-mnav.md`;
  DanielTomaro13/sportsdata-mcp `documentation/ESPNFantasy.md`;
  heyitaki/espn-fantasy-football-mcp `src/espn/constants.ts`;
  AbdulsaboorS/fantasybasketballbot `espn_lineup.py`; mcolen5050/FantasyFootballAutomation_public `main.py`;
  Ryan42062001/The-War-Room `extensions/espn-companion/espn-page-bridge.js`;
  zxqj/ff-api `sample-data/espn/getviews.py`; cole-wyman-1/keystone-fantasy `README.md`.
- Web: disneytermsofuse.com/english (Last Updated May 24, 2024 — fetched today);
  support.espn.com Fair Play and Conduct (Updated Aug 04, 2026); ffscrapr vignettes
  (espn_getendpoint, espn_authentication 2023-02-11); stmorse v3 article (2019-07-27,
  updated Sep 2024); pseudo-r/Public-ESPN-Fantasy-API README; thomaswildetech
  player-info views; cwendt94 issues #539 (403, 2024-04-23), PR #540 (host change,
  merged 2024-04-25), #549, discussions #128 (reCAPTCHA Sep 2020), #150 (cookie
  persistence, dtcarls 2020-11-19); mkreiser #133; jwulff/fantasy-sports issue #5;
  mykool223/CommissonersCartelFFL #5; finger-six/fantasy_bot #8; leagueloom.com/espn;
  gamedaybot help; Chrome Web Store "ESPN Cookie Finder" (5k users, v1.2 2025-08-25);
  npm registry via `npm view` (@napi-rs/keyring 2.1.0 2026-09-13; keytar 7.9.0, repo
  archived 2022-12-12); GitHub API for repo archived flags.
- www.espn.com rules pages (`page=fflruleslegal`, `page=fsrterms`, `page=terms`) and
  espn.co.uk: HTTP 202 with 0 bytes, `x-cache: Error from cloudfront` — bot-gated;
  could not read the ESPN fantasy-specific terms text today. Recorded as [U].

## Probe log (anonymized; 30/30 used; all GET; UA = desktop Chrome string unless noted)

Base R = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl`;
L = `R/seasons/2026/segments/0/leagues/[league-id]`. Times UTC 2026-09-30.

| # | time | URL | status | bytes | top-level keys / note |
|---|------|-----|--------|-------|-----------------------|
| 01 | 03:26:52 | `R/seasons/2020/segments/0/leagues/[league-id]?view=mSettings` | 200 | 9164 | draftDetail,gameId,id,scoringPeriodId,seasonId,segmentId,settings,status |
| 02 | 03:26:53 | `https://fantasy.espn.com/apis/v3/games/ffl/seasons/2020/segments/0/leagues/[league-id]?view=mSettings` | 302 | 13 | `Location: https://www.espn.com/fantasy/`, body "Redirecting" text/plain |
| 03 | 03:26:55 | `R/leagueHistory/[league-id]?seasonId=2020&view=mSettings` | 404 | 150 | messages,details → type GENERAL_NOT_FOUND |
| 04 | 03:26:56 | `L?view=mSettings` | 200 | 9004 | as 01; status.currentMatchupPeriod=4, latestScoringPeriod=4, previousSeasons 2018–2025 |
| 05 | 03:29:05 | `L?view=mTeam&view=mRoster&view=mMatchup&view=mSettings&view=mStandings` | 200 | 3,162,832 | + members,schedule,teams; hdr x-fantasy-filter-player-count: 951 |
| 06 | 03:29:06 | `L?view=mMatchupScore&scoringPeriodId=4` | 200 | 212,878 | schedule (75 rows); home has rosterForCurrentScoringPeriod, totalPointsLive, totalProjectedPointsLive, winProbability |
| 07 | 03:29:08 | `L?view=mBoxscore&scoringPeriodId=4` | 200 | 324,669 | schedule + settings + teams; home has rosterForCurrentScoringPeriod, rosterForMatchupPeriod, rosterForMatchupPeriodDelayed; NO winner/playoffTierType keys |
| 08 | 03:29:10 | `L?view=mScoreboard&scoringPeriodId=4` | 200 | 394,829 | draftDetail,id,schedule,settings,status,teams; schedule rows lack matchupPeriodId |
| 09 | 03:29:12 | `L?view=kona_player_info&scoringPeriodId=4` + filter FA/WAIVERS, slot 2, limit 5, sortPercOwned, sortDraftRanks | 200 | 67,400 | players(5),positionAgainstOpponent; hdr count 196 |
| 10 | 03:29:13 | `L?view=mPendingTransactions` | 200 | 964 | pendingTransactions: [] |
| 11 | 03:29:15 | `L?view=mTransactions2&scoringPeriodId=4` + filter FREEAGENT/WAIVER/WAIVER_ERROR/TRADE_ACCEPT | 200 | 1067 | transactions: []; hdr x-fantasy-filter-transaction-count |
| 12 | 03:29:16 | `L?view=mNav` | 200 | 5300 | members (with isLeagueCreator,isLeagueManager), teams (abbrev,id,logo,logoType,name,owners), settings subset |
| 13 | 03:30:37 | `L?view=mStatus` | 200 | 1049 | status (adds lastUpdateInfo) |
| 14 | 03:30:38 | `L?view=mLiveScoring&scoringPeriodId=4` | 200 | 2632 | schedule rows contain ONLY matchupPeriodId (no home/away) unauthenticated |
| 15 | 03:30:40 | `L?view=mPositionalRatings&scoringPeriodId=4` | 200 | 9381 | positionAgainstOpponent.positionalRatings{1,2,3,4,5,16}.ratingsByOpponent[32] |
| 16 | 03:30:41 | `L?view=mDraftDetail` | 200 | 42,389 | draftDetail{completeDate,drafted,inProgress,picks[150]} |
| 17 | 03:30:43 | `L?view=mSchedule` | 200 | 939 | skeleton only (no schedule key) |
| 18 | 03:30:44 | `L?view=modular` | 200 | 939 | skeleton only |
| 19 | 03:30:46 | `R/seasons/2026/players?view=players_wl` + `{"filterActive":{"value":true},"limit":5}` | 400 | 284 | type FILTER_LIMIT_MISSING_SORT |
| 20 | 03:30:47 | `R/seasons/2026?view=proTeamSchedules_wl` | 200 | 109,067 | display,settings.proTeams[33] |
| 21 | 03:32:51 | `L?view=kona_playercard` + filterIds[1], filterStatsForTopScoringPeriodIds | 200 | 13,114 | players[1] with seasonOutlook (739 chars), outlooks.outlooksByWeek{2,3,4}, lastNewsDate, transactions, waiverDate |
| 22 | 03:32:53 | `R/seasons/2026/segments/0/leagues/[wiki-example-id]?view=mSettings` | 404 | 150 | GENERAL_NOT_FOUND (id no longer exists) |
| 23 | 03:32:54 | `R/seasons/2026/players?view=players_wl` + `{"filterActive":{"value":true}}` | 200 | 663,713 | JSON ARRAY[2663]; hdr count 2663 |
| 24 | 03:32:57 | `L?view=kona_player_info&scoringPeriodId=4` + `{"players":{"limit":5000,"offset":0,"sortPercOwned":…}}` | 200 | 5,660,652 | players[951] (= hdr count 951; no ceiling hit) |
| 25 | 03:32:58 | as 09 with offset 5 | 200 | 66,078 | 5 players, 0 overlap with 09; hdr count 196 |
| 26 | 03:33:00 | `https://site.api.espn.com/apis/fantasy/v3/games/ffl/news/players?playerId=[player-id]` | 403 | 442 | HTML "Access Denied" (edge bot block) |
| 27 | 03:33:01 | `L/communication/?view=kona_league_communication` + topics filter | 401 | 304 | type AUTH_COMMUNICATION_NOT_VISIBLE |
| 28 | 03:33:03 | `L?view=mBogusViewName` | 200 | 2142 | skeleton: gameId,id,members,scoringPeriodId,seasonId,segmentId,settings{name},status,teams{abbrev,id,owners} |
| 29 | 03:34:37 | `R/seasons/2026/segments/0/leagues/[readme-example-id]?view=mSettings` | 404 | 150 | GENERAL_NOT_FOUND |
| 30 | 03:34:39 | `L?view=mSettings` with curl default User-Agent | 200 | 9004 | identical to 04 — no UA gating on the API host |

Headers on every 200 from lm-api-reads: `x-fantasy-role: NONE`, `x-fantasy-server-time`,
`x-fantasy-filter-player-count`, weak `etag`, `cache-control: must-revalidate`,
`expires: -1`, `pragma`, CloudFront `via`/`x-cache`. No rate-limit / retry-after
headers of any kind. `polling-interval` seen once (which probe: see 03-espn-api.md §A4).

Non-API page fetches (not counted as probes): 5 × www.espn.com / espn.co.uk (202, 0 B),
1 × support.espn.com (200), 1 × disneytermsofuse.com (200).

## Key facts (for the doc; every one tagged there)

- Public league answers every view anonymously; `mLiveScoring` and `/communication/`
  are the exceptions (stripped / 401).
- Unknown view → 200 skeleton (P28). Comma-joined views → skeleton [V-community].
- `limit` without a sort → 400 FILTER_LIMIT_MISSING_SORT (P19). `offset` works (P25).
  Header `x-fantasy-filter-player-count` = total matches regardless of limit.
- Error body shape: `{"messages":[str], "details":[{message, shortMessage, resolution,
  type, metaData}]}` for 401/404/400 (P03, P19, P22, P27).
- Old host `fantasy.espn.com/apis/v3` → 302 to www.espn.com/fantasy (P02).
- `leagueHistory` only serves seasons the modern route does not (≤2017) — 404 for 2020 (P03).
- Write host `lm-api-writes.fantasy.espn.com` (never probed) [V-community, jwulff capture].
