# 02 — Prior-art lessons (architecture only)

**Author:** `repo-security-auditor` agent · **Date:** 2026-09-30 · Source of every claim:
`01-repo-security-audit.md` (file:line evidence lives there). Only repos with a **Safe**
or **Caution** verdict contribute to the matrices. A final section lists mistakes seen
in *rejected* repos, for avoidance only. **No code was copied from any repo and none
appears here** — these are design observations. Where the sibling program's
`02-prior-art-lessons.md` (Yahoo, 2026-09-29) already states a platform-agnostic lesson,
it is cited rather than repeated.

Passing set — ESPN MCP servers: mdanaher1/espn-ff-mcp (**M1**), mpsthedude (**MP**),
KBThree13/mcp_espn_ff (**KB**, caution), gagandaroach/fantasy-yolo (**FY**), HamCops/dodi
(**DO**, caution), tlo1216/espn-fantasy-mcp (**TL**), i-am-david-weinstein (**DW**,
caution, baseball), rrichardtang (**RR**, caution), saik0v0ur (**SK**, caution),
DanielTomaro13/sportsdata-mcp (**SD**, caution). CLI/wrappers: jwulff/fantasy-sports
(**JW**), cwendt94/espn-api (**CW**, caution), mkreiser (**MK**), eponerine (**EP**,
caution), ryanjadhav (**RJ**), stmorse (**SM**), ffscrapr ESPN adapter (**FF**).

## 1. Capability matrix — ESPN MCP servers

✓ present · ◐ partial · ✗ absent · — not applicable

| Capability | M1 | MP | KB | FY | DO | TL | DW | RR | SK | SD |
|---|---|---|---|---|---|---|---|---|---|---|
| League / settings read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Roster read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Lineup write | ✗ | ✗ | ✗ | ✓ preview/execute | ✓ `apply` flag | ✓ `dry_run` flag | ✓ `confirm` flag | ✗ | ✗ | ✓ opt-in group |
| Add / drop | ✗ | ✗ | ✗ | ✓ preview/execute | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| Waiver claim (+FAAB) / cancel | ✗ | ✗ | ✗ | ✓ claim + cancel | ✓ claim | ✓ claim + cancel | ✓ claim + cancel | ✗ | ✗ | ◐ claim |
| Trades (propose / accept / reject / cancel) | ✗ | ✗ analysis only | ✗ | ✗ | ✓ propose + respond | ✗ | ✓ all four | ✗ | ✗ | ✗ |
| Transactions / activity feed | ✓ | ✓ | ✗ | ✓ (+pending) | ✓ | ✓ (+pending) | ◐ pending only | ✓ | ✓ | ✓ (+pending) |
| Standings / scoreboard / matchups | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (+boxscore) | ✓ | ✓ | ✓ | ✓ |
| Player stats | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ESPN projections surfaced | ✓ | ✓ | ◐ | ✓ | ✓ (drives lineup) | ✓ | ✗ | ◐ | ◐ | ✓ |
| ESPN news / player notes | ✗ | ✗ (FantasyPros news instead) | ✗ | ✗ (forbidden by instructions) | ✗ (Sleeper/nflverse signals) | ✗ | ✗ | ✗ | ✗ | ✓ (news host) |
| Ownership % / ADP | ◐ | ✓ | ✗ | ◐ | ✓ | ✓ | ◐ | ◐ | ◐ | ✓ |
| Free-agent search (kona filter) | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Data cache | ✗ (TTL setting unused) | ✓ file caches (FP/SGO) | ✗ | ✗ | ✓ pool TTL + sources cache | ✗ | ✗ | ✓ 1-min league reload | ✓ 60 s response cache | ✓ short-lived GET cache |
| Confirmation gate | — | — | — | ✓ token bound to payload | ◐ opt-in phone approval (lineup exempt) | ✗ | ✗ | — | — | ✗ (group gate) |
| Write tools hidden unless enabled | — | — | — | ✓ not registered | ✗ | ✓ `WRITES_ENABLED` | ✗ | — | — | ✓ group excluded from `*` |
| Cookie storage | cwd `.env` / client env | env or app-home `credentials.json` | memory (from chat) | `~/.config/fantasy-yolo` file, 0600 enforced | repo-root `.env` | cwd `.env` | env / `.env` | Cloud Run env | env (+per-league JSON env) | env or `~/.sportsdata-mcp/*.yaml` 0600 |
| Cookie acquisition | manual DevTools (+closed-source extension suggested) | manual; optional tool arg | **tool argument (chat)** | manual paste to file | manual; draft scripts use a logged-in browser profile | manual | manual | manual, `read -rs` at deploy | manual | **Chrome cookie-DB read** (opt-in) or manual |
| Secret redaction in errors/logs | ✗ | ✓ stderr scrubber | ✗ | ✓ all outputs | ✓ errors + exception args | ✓ memberId only | ✗ | ✗ | ✗ | ✓ root-logger filter |
| Host pinning | via espn-api | own transport, 2 hosts | via espn-api | read/write hosts asserted | `.espn.com` cookie scope + URL allow-list | 2 hosts | via espn-api | via espn-api | 1 host | per-provider base URLs |
| Untrusted text labelled | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| MCP resources / prompts | ✓ 7 `espn://` resources | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ resources + prompts |
| Tool annotations | ✗ | ✓ fail-closed list | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ read-only | ✗ | ✓ |
| Input validation | type hints | transport validators | type hints | pydantic | type hints | zod in+out | type hints | pydantic Field | type hints | pydantic spec |
| Output format | JSON | mixed repr/dict | `str(dict)` | typed models | dict | typed JSON | JSON | JSON | JSON | JSON |
| Transport | stdio | stdio | stdio | stdio | stdio (+ loopback HTTP approval service) | stdio | stdio (+Smithery) | HTTP (Cloud Run) | stdio | stdio/HTTP |
| Tool count | 20 | ~52 | 8 | 20 | 30 | 17 | 16 | 9 | 13 | 27 + 2 (ESPN) |

Three facts fall straight out of the matrix:

- **Nobody labels untrusted text.** Team names, owner names, message-board posts and
  player notes arrive in the same JSON as system facts in every server. Only the CLI
  (JW) reserves an `untrusted` container in its output envelope and renders free text
  in a fence-proof block — and it is the one project not exposed to a model directly.
- **Every write gate but one is a boolean the model itself sets** (`apply`, `dry_run`,
  `confirm`). Only FY binds execution to a single-use code minted by a separate preview
  call and fingerprinted to the exact payload; DO adds an out-of-band human approval
  but exempts lineup changes and offers an auto-apply mode.
- **ESPN projections are free; ESPN news is not used.** Every server that reads
  `kona_player_info`/`mRoster` surfaces ESPN's projected points; none reads ESPN's
  news host (CW and SD know it). News, when present, comes from a second, declared
  source (MP: FantasyPros; DO: Sleeper trending + nflverse).

## 2. Capability matrix — wrappers, CLI and data adapters

| Capability | JW (CLI) | CW (Py lib) | MK (JS lib) | EP (JS + REST) | RJ (CLI) | SM (analysis) | FF (R) |
|---|---|---|---|---|---|---|---|
| ESPN reads (league/roster/matchups/players/transactions) | ✓ + `raw --view` | ✓ five sports | ✓ | ✓ (port of CW) | ✓ | ✓ | ✓ |
| ESPN writes | ✗ (research captures only) | ✗ | ✗ | ✗ | ✓ lineup + add/drop, `--dry-run` | ✗ | ✗ |
| ESPN news | ✗ | ✓ news endpoint | ✗ | ✓ | ✗ | ✗ | ✗ |
| Auth | env → Keychain → XDG config; `Secret` carrier | ctor args | ctor args, Cookie header | ctor args **or query string** | `~/.config/espn/cookies.json` (0600 by convention) | `config.ini` or env | function args (`Sys.getenv` pattern) |
| Persistence of cookies | XDG config, mode preserved | none | none | none | file | file | none |
| Redaction | errors, cache, cassettes, other members' SWIDs | ✗ (debug log to stdout) | ✗ | ✗ (debug log prints Cookie) | ✗ | ✗ | ✗ |
| Caching | SQLite HTTP cache, redacted, filter-aware key | ✗ | ✗ | ✗ | ✗ | JSON files | memoise + rate limiter |
| Health / drift detection | `doctor`, manifest, canary | ✗ | integration snapshots | ✗ | exit codes | ✗ | ✗ |
| Error classification | typed, honest (401 ≠ "expired") | typed exceptions | HTTP errors | HTTP errors | exit code 3 on auth | message | R conditions |

## 3. Architectural choices that work (adopt the idea, not the code)

1. **Credential chain with a secret carrier** (JW): resolve env → OS keychain → XDG
   config file, each link failing soft; wrap the value in a type that redacts itself in
   every string conversion so no traceback or f-string can print it; scrub every error
   message at construction rather than at each raise site. MP's stderr scrubber and
   DO's exception-argument scrubbing are the same idea applied later in the pipeline.
2. **Enforce the file mode, do not document it** (FY): refuse to load a credentials
   file that is group- or world-readable. RJ documents `chmod 600` and never checks it;
   FY checks and fails loudly. JW keeps the original mode on atomic rewrite.
3. **Pin the hosts in one place** (MP, DO, FY, TL): a single transport module that owns
   the two ESPN hosts, the cookie jar and the headers. DO goes furthest: cookies are
   `Secure` and domain-scoped to `.espn.com`, and every URL is checked against an
   allow-list before the request exists, so no future call site can leak the session
   on a redirect. FY asserts the read client never touches the write host.
4. **Preview/execute as two tools with a payload-bound, single-use, short-lived code**
   (FY): the execute tool recomputes the plan from a fresh read and refuses if the
   payload fingerprint changed; the token store persists only fingerprints; writes are
   never retried and a timeout is reported as UNKNOWN, not failed. Sibling §5 proposed
   exactly this; FY is the first implementation seen on either platform.
5. **Writes are absent unless enabled** (FY, TL, SD): do not register write tools at all
   when the operator has not turned them on — a model cannot call what it cannot see.
   Preferable to annotations alone.
6. **Annotate every tool, fail closed** (MP, FY, TL, RR, SD): a central list that must
   classify each registered tool as read-only or mutating before the server starts.
7. **Out-of-band human approval with a per-proposal capability token** (DO): queue the
   mutation with its preview, notify the human, execute only when the token for that
   one proposal is presented; expire proposals before kickoff. The design is right; the
   exemptions (lineup direct, auto-apply policy) are the cautions.
8. **Second data sources through one allow-listed fetcher that never sees credentials**
   (DO, MP): opt-in, declared hosts, separate HTTP client, API key in a header, no
   cookies. MP's provider docs state the trust boundary explicitly.
9. **Pseudonymise other people's identifiers before anything is written to disk**
   (JW): ESPN echoes every league member's SWID in roster payloads; a cache or fixture
   that stores them is a PII store. JW rewrites them to stable pseudonyms so join keys
   still work. CW and FY ship fixtures that did not.
10. **Reserve an `untrusted` container in the output envelope** (JW) and render ESPN
    free text in a container it cannot escape. This is the seam our tools need for
    team names, notes and messages.
11. **Operational commands** (JW `doctor`/health manifest/canary, DO `doctor`/`tick
    status`, MP `get_fantasy_brief`): let a user prove the cookie works and detect ESPN
    schema drift before it corrupts a decision. Sibling §3.8 said the same for Yahoo.
12. **League identity as MCP resources** (M1): `espn://leagues`, `espn://league/{id}/{year}`,
    `espn://teams/…` make the configured league discoverable without tool arguments.
13. **Exact-version pins or a lockfile with a zero-advisory gate**: only CW (0 advisories,
    narrow pins) and RR (exact pins) are clean today; every MCP-SDK-1.x lockfile carries
    3–5 HIGH advisories in `mcp` itself (sibling §3.10 found the same on the JS SDK).

## 4. Mistakes to avoid — with the symptom each one produces

| # | Mistake | Seen in | Symptom |
|---|---|---|---|
| 1 | **Cookies typed into the chat** as tool arguments | KB (only path), MP (optional) | The session cookie is in the LLM provider's transcript store, in the client's conversation history and on screen; "logout" cannot recall it |
| 2 | **`.env` or log path relative to the launch cwd** | M1, TL (`.env`, `logs/writes.jsonl`), DW | Works from the terminal, "unauthenticated" under the MCP client which launches elsewhere; a write log lands wherever the client's cwd was; a stray `.env` in that directory can swap the league or the cookies (DO's fixed path is the fix) |
| 3 | **Confirmation is a boolean the model sets** (`apply`, `dry_run`, `confirm`) | DO, TL, DW | A prompt-injected instruction can set the flag to true in the same call; the "preview" step never happened as far as the human is concerned |
| 4 | **Lineup writes exempt from the approval gate** / **auto-apply policy** | DO | The one write that runs every week is the one with no human in the loop; a wrong projection or an injected note changes the starting lineup silently |
| 5 | **Cookies in URL query parameters** | EP (REST wrapper); DO's draft-room URL carries the SWID by ESPN's own design | Access logs, proxies and browser history keep the session; the SWID in ESPN's draft-room URL is unavoidable there, but a wrapper must never offer cookies as query parameters |
| 6 | **Debug logger to stdout, headers included** | CW (`StreamHandler(sys.stdout)`), FY's vendored copy, EP (prints `Cookie`) | Any server that wraps the library with `debug=True` corrupts the stdio channel; EP's variant writes the cookie into the log |
| 7 | **Language-native `repr` as tool output** | KB, MP legacy tools | `{'key': True, 'x': None}` reaches the model; sibling §4.4 |
| 8 | **Upstream error body echoed into error text** | TL, SK (≤300 chars), CW (message includes league id) | ESPN's transaction responses echo `memberId`; HTML error pages land in context; sibling §4.6 |
| 9 | **File mode documented, not enforced** | RJ (`chmod 600` in README) | World-readable cookie file on a 022 umask; nobody notices until a backup agent or another user reads it |
| 10 | **Persistent logged-in browser profile inside the repo directory** | DO (`state/browser-profile/`) | A full Disney OneID session on disk with default permissions, next to code that gets zipped, synced or `git add .`-ed; attaching to the user's real browser over a CDP port exposes every open tab's session |
| 11 | **Reading the browser's cookie database** | SD (opt-in wizard) | Even done carefully (host-scoped, verified, 0600), the program now holds the Keychain-derived key that decrypts every cookie in the profile; one bug away from a general cookie reader; requires a Keychain prompt users learn to click through |
| 12 | **Cloud-hosted install path for a cookie-authenticated tool** | DW (Smithery), RR (Cloud Run env), SD/noahking (Render) | The session cookie is stored by a third party as "config"; rotation means re-deploying; the URL-embedded shared secret (RR) is the only lock |
| 13 | **Floating MCP SDK / FastMCP ranges without a lockfile** | DO (`mcp>=2.0.0`), DW (`fastmcp>=2.0.0`), SD (`fastmcp>=0.4,<4`), SK | Fresh installs resolve different majors; unauditable; sibling §4.8 |
| 14 | **`mcp[cli]` extra in a stdio server** | MP, FY, KB, ktrann24 | Drags `pyjwt` (10 advisories, 1 CRITICAL) and `python-multipart`/`starlette` into a process that never parses a JWT or an HTTP form |
| 15 | **One 10,000-line server file** | MP (612 KB), DO (2,700 lines), SK (1,168) | Every tool shares one error path; the transport, the analysis and the MCP glue cannot be tested apart; reviewers stop reading |
| 16 | **Squashed history on publication** | MP (4 commits) | The one check that finds leaked-then-removed secrets cannot run; the project must be trusted on its current tree alone |
| 17 | **Real members' names and SWIDs in committed fixtures** | CW, FY (vendored) | Strangers' identifiers in a public repo; every fork inherits them; JW's pseudonymisation is the fix |
| 18 | **Package-name collision with a rejected project** | MP (`fantasy-football-mcp`) | Users searching for the good one find the bad one; a future PyPI publish would squat or be squatted |
| 19 | **Unused configuration** | M1 (`CACHE_TTL_SECONDS` never read) | Users set it and believe responses are cached; every call hits ESPN |
| 20 | **Third-party LLM calls inside the MCP server** | (rejected JayMishra; latent in none of the passing set) | Roster and league data leave the host to whichever provider has a key set; sibling §6 |

## 5. What our design should do differently

- **Credential store = OS keychain first, then XDG config file, then env** for headless
  runs (JW's chain reversed only in priority for the interactive case), file mode
  enforced on read (FY), atomic rewrite preserving mode (JW), `doctor` verifies it. The
  server directory and the launch cwd are never consulted. The client config
  (`claude_desktop_config.json`) carries paths, never cookie values.
- **Cookies never enter the model channel.** No `authenticate(espn_s2, swid)` tool; the
  only acquisition is a paste into a local CLI prompt (hidden input) or the
  keychain. No browser cookie-DB reading, no Playwright profile, no extension.
- **One transport module** owns the two ESPN hosts, a domain-scoped `Secure` cookie jar,
  a URL allow-list evaluated before every request, the `x-fantasy-filter` header and
  the write headers captured in TL/JW/DO; errors never include upstream text; the
  redaction registry scrubs every error at construction and pseudonymises other
  members' SWIDs in anything persisted.
- **Preview/execute pairs with a payload-bound, single-use, short-lived code** (FY),
  execute re-reads and re-plans, never retries, reports UNKNOWN honestly, and is **not
  registered** unless the operator enables writes. No boolean gates. Lineup changes
  are not exempt. No auto-apply mode. Out-of-band approval (DO's queue) is a later
  option layered on the same journal.
- **Label untrusted fields** in every result with a reserved container (JW) and say so in
  the tool description; team names, owner names, message-board text and news are data.
- **ESPN projections are a first-class field; ESPN news is read from the news host with
  its own tool prefix and the untrusted label**; any second source is declared, opt-in,
  and reached through an allow-listed client that never carries the ESPN cookie (DO, MP).
- **JSON out, typed schema in and out (TL's zod in+out is the bar), one path builder
  with id validation** (MP's transport validators), tool annotations from a fail-closed
  list, MCP resources for league identity (M1).
- **Exact-pinned MCP SDK, lockfile, zero-advisory gate in CI, no `[cli]` extra, dev and
  runtime groups separated**; publish under a name that collides with nothing.
- **Health first**: `doctor` (cookie present, mode bits, ESPN reachable, league
  resolves), a drift canary against a public league (JW), and error classification that
  does not claim "expired" on a 401 it cannot distinguish (JW's finding).
- **Fixtures are pseudonymised before commit** (JW) — never a real member id or name.

## 6. API-knowledge pointers for the `espn-api-specialist` (paths only, no copying)

Clones live under the session scratchpad
`…/scratchpad/eff-research/vendor/<owner>__<name>/` at the SHAs in 01. Nothing below
should be copied; read for endpoint, view, filter and payload knowledge.

| Knowledge | Where |
|---|---|
| Read host, endpoints, view names, `x-fantasy-filter` shapes, 401 fallback to `leagueHistory` | `cwendt94__espn-api/espn_api/requests/espn_requests.py`, `…/requests/constant.py` (news host); `mpsthedude…/espn_transport.py` (fan API for league discovery, communication subresource, season/players endpoints) |
| Views actually used in the wild (counts across passing repos): `mTeam`, `mSettings`, `mRoster`, `mMatchupScore`, `kona_player_info`, `mTransactions2`, `mDraftDetail`, `proTeamSchedules_wl`, `mScoreboard`, `players_wl`, `mPendingTransactions`, `mMatchup`, `mStatus`, `mPositionalRatings`, `mBoxscore`, `kona_league_communication`, `mStandings` | grep the files in this table; `jwulff__fantasy-sports/docs/research/03-espn-api-surface.md` and `docs/samples/raw*.json`; `DanielTomaro13__sportsdata-mcp/documentation/ESPNFantasy.md` (27-tool view sweep incl. the undocumented `allon` mega-view) and `src/sportsdata_mcp/specs/espnfantasy.yaml` |
| Position / lineup-slot / pro-team / stat-id / activity / scoring-format maps | `cwendt94__espn-api/espn_api/football/constant.py` (`POSITION_MAP`, `PRO_TEAM_MAP`, `ACTIVITY_MAP`, `PLAYER_STATS_MAP`, `SETTINGS_SCORING_FORMAT_MAP`, `TRANSACTION_TYPES`); `mkreiser…/src/constants.js` (`slotCategoryIdToPositionMap`, `scoringItemToId`); `tlo1216…/src/espn/constants.ts` (`FOOTBALL_LINEUP_SLOT_MAP`, `IR_SLOT_ID`, `BENCH_SLOT_ID`, `INJURY_STATUSES`); `ffverse__ffscrapr/R/espn__helpers.R` (`.espn_stat_map`, `.espn_lineupslot_map`, `.espn_pos_map`); `mpsthedude…/espn_reference.py`; `saik0v0ur…/server.py` (`SLOTS`, `STARTING_SLOTS`, `SLOT_FILTERS`, `INJURY_SHORT`); `pseudo-r__Public-ESPN-Fantasy-API/docs/stat_ids.md`, `settings.md`, `players.md`, `response_schemas.md` |
| Free-agent / waiver filter (`filterStatus`, `filterSlotIds`, `sortPercOwned`, `filterRanksForScoringPeriodIds`) | `cwendt94…/espn_api/football/league.py` (free agents, player cards), `tlo1216…/src/espn/reads.ts:180-200,281`, `HamCops__dodi/src/espn_mcp/espn.py:360-385`, `mpsthedude…/espn_free_agent_read.py`, `ryanjadhav…/bin/espn_api.py:140-150` |
| **Write host and transaction envelope** (`lm-api-writes`, `POST …/transactions/`, `type` LINEUP/FREEAGENT/WAIVER/TRADE_PROPOSAL, `memberId`, `scoringPeriodId`, `executionType`, `items[]`, `bidAmount`, write headers) | `jwulff__fantasy-sports/docs/research/05-espn-write-surface.md` + `05-espn-write-surface/*.json` (23 probes, 2026-09-12: what happens with no cookies, SWID-only, espn_s2-only, no `memberId`, other team's roster, VALIDATE execution type, locked players, scoring-period bounds); `gagandaroach__fantasy-yolo/src/fantasy_yolo/write/payloads.py`, `write/errors.py`, `write/oracle.py`; `tlo1216…/src/espn/writes.ts`, `src/espn/client.ts:111-119` (headers captured live); `HamCops__dodi/src/espn_mcp/espn.py:142-230`; `i-am-david-weinstein…/src/espn_fantasy_mcp/espn_client.py` (nine transaction payloads incl. trade propose/accept/decline/cancel, IR moves); `DanielTomaro13__sportsdata-mcp/docs/ESPN-WRITES-PLAN.md`; `ryanjadhav…/docs/api.md` (§Writes, §Transactions shape) |
| Draft-room / live draft (separate SPA, OneID session, `memberId` in URL) | `HamCops__dodi/scripts/live_draft.py:36-45`, `README.md`; `mpsthedude…/espn_draft_read.py` |
| League discovery for a SWID (fan API) | `mpsthedude…/espn_transport.py:151-165`, `espn_league_discovery.py` |
| Error/status semantics (401 means nothing by itself; `X-Fantasy-Role`; non-JSON = auth redirect) | `jwulff…/docs/memory/espn-401-tells-you-nothing.md`, `src/fantasy_sports/providers/espn.py`; `gagandaroach…/src/fantasy_yolo/read/client.py:21-37`; `HamCops__dodi/src/espn_mcp/espn.py:92-114` |
| Historical seasons (`leagueHistory`, list-wrapped payloads) | `cwendt94…/espn_requests.py:46-53`, `saik0v0ur…/server.py` (`_league_data` fallback), `pseudo-r…/docs/historical_seasons.md` |
| Rate limiting observed in practice | `tlo1216…/src/espn/client.ts:33-58` (2/s reads, 1 per 5 s writes), `ffscrapr` `ratelimitr` use |

## 7. Mistakes observed only in rejected repos (avoidance only)

- `eval` over data fields and `npx`-spawning a third-party package at run time
  (JayMishra) — arbitrary code execution paths inside an MCP server.
- Roster data fanned out to four LLM vendors and three webhook services because keys
  were present (JayMishra) — sibling §6's "third-party LLM sink" again.
- A web form that takes the ESPN username and password, drives a headless browser
  through login and OTP, and writes cookie dumps to disk (darkonda) — the credential
  itself, not just the session, leaves the user's hands.
- A browser extension whose purpose is to POST `espn_s2`/`SWID` to a vendor
  (true-champion) — the cleanest possible implementation of the thing we must never do.
- Cookies over plain `http://` to a retired host (Possardt).
