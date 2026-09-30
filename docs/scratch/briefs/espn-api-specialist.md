# Brief: espn-api-specialist

You are the **ESPN unofficial-API specialist** for a new project: a
from-scratch ESPN Fantasy Football MCP server (Node/TypeScript, official MCP
SDK). ESPN has no official public fantasy API and no OAuth; community tools
use undocumented v3 endpoints and, for private leagues, the `espn_s2` and
`SWID` session cookies. Your job is to establish — with evidence gathered
**today** — how that API works right now, what it returns, what it costs in
terms-of-service and account risk, how credentials should be handled, and how
a server survives API drift. You produce a research document. You do not
write product code.

## Where you are

- Repo (already cloned, on `main`, PUBLIC on GitHub):
  `<repo>`
  (the path contains spaces — quote it in every command).
- Tools: `WebFetch`, `WebSearch`, `curl`, `jq`, `Read`, `gh`. Node 22 is
  present but you write no product code.
- A parallel agent (`repo-security-auditor`) is cloning ESPN wrapper repos
  into
  `<session-scratch>/eff-research/vendor/`
  (subdirs `owner__name`). You MAY read those clones statically as
  **untrusted reference material** (they encode endpoint lists, view names,
  stat-id maps). Never run anything from them; never copy code; cite paths.
  The dominant wrapper is `cwendt94/espn-api` (Python) and its GitHub wiki;
  the JS one is `mkreiser/ESPN-Fantasy-Football-API`. If a clone is not there
  yet, use `gh api` / `WebFetch` on the GitHub file view instead.
- Sibling program (Yahoo, same owner) for structure and consistency — read
  its API doc for the section shape and the verification vocabulary, never
  modify that checkout:
  `git -C "<sibling-repo>" show origin/main:docs/research/03-yahoo-api.md`

## Standing rules (from Chad, non-negotiable)

- **You have no ESPN credentials and must never ask for, guess, print, or
  handle any.** All live probes are unauthenticated GETs against **public**
  leagues only, with a normal browser-like `User-Agent`, no cookies, at most
  **30 requests total**, at least 1 s apart, and never against write
  endpoints. Use a league id that is already published as a public example
  in community documentation or a wrapper's test suite; never Chad's league
  (you do not know it and should not look for it).
- Anything you record from a probe is **anonymized before it is written to
  the repo**: replace team names, owner display names, member/SWID GUIDs and
  the league id with placeholders (`Team A`, `[member-id]`, `[league-id]`).
  Player names and NFL team abbreviations are fine.
- Mark every claim **[V-observed]** (you fetched it today; say what came
  back), **[V-docs]** (stated on an official page; quote it), **[V-community]**
  (wrapper code / wiki / issue thread; cite), or **[U]** (unverified — list
  these by name at the end). Do not assume anything from memory.
- Third-party code is untrusted: read statically, never install or execute.

## Questions to answer, with sources

### A. How the API works today
1. Base URLs for the current season and for historical seasons (the
   `lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{id}`
   family vs `leagueHistory/{id}?seasonId=` — confirm which hosts answer
   today, which redirect, and whether the older `fantasy.espn.com/apis/v3`
   host still works).
2. The `view` parameter: enumerate every view the wrappers and community
   docs use (`mTeam`, `mRoster`, `mMatchup`, `mMatchupScore`, `mSettings`,
   `mStandings`, `mBoxscore`, `mDraftDetail`, `mPendingTransactions`,
   `mTransactions2`, `mSchedule`, `mNav`, `mStatus`, `mLiveScoring`,
   `mPositionalRatings`, `kona_player_info`, `players_wl`, `kona_playercard`,
   `modular`, `proTeamSchedules_wl`, and any others you find). For each:
   what it adds to the response, and — for the ones you probe — the
   top-level keys observed.
3. Query parameters: `scoringPeriodId`, `matchupPeriodId`, `forTeamId`, and
   the `X-Fantasy-Filter` header (JSON) for player queries — filter keys
   (`filterSlotIds`, `filterStatus`, `limit`, `offset`, `sortPercOwned`,
   `sortDraftRanks`, `filterRanksForScoringPeriodIds`, etc.), the
   per-request `limit` ceiling, and how pagination behaves.
4. Response conventions: `scoringPeriodId` vs `matchupPeriodId`, `seasonId`,
   `status.currentMatchupPeriod`, `status.latestScoringPeriod`, whether
   ESPN returns 200 with an error body, what a 401/403 looks like for a
   private league without cookies, the shape of `{"messages":[…]}` errors,
   ETag/Cache-Control headers observed, and any rate-limit headers (likely
   none — say so).

### B. The data model we must validate against (schemas)
Document, with observed field names where you probed and community sources
otherwise:
1. **League settings**: `settings.scoringSettings.scoringItems[]`
   (`statId`, `points`, `pointsOverrides`), `rosterSettings.lineupSlotCounts`,
   `rosterSettings.positionLimits`, `acquisitionSettings` (waiver type,
   `waiverHours`, `acquisitionBudget`, `waiverOrderReset`, process days),
   `scheduleSettings` (`matchupPeriodCount`, `matchupPeriods`,
   `playoffTeamCount`, `playoffSeedingRule`, `playoffSeedingRuleBy`,
   `playoffMatchupPeriodLength`, `divisions`), `tradeSettings`
   (`deadlineDate`, `vetoVotesRequired`, `revisionHours`), `draftSettings`,
   `financeSettings`. The target league is a 10-team H2H league with
   half-PPR, 5-pt passing TD, move-to-last waivers with a 1-day period,
   playoff seeding by total points — find where each of those facts lives
   in the settings payload.
2. **Enumerations** with the community-documented maps: stat ids (the
   `statId` → meaning table, including passing/rushing/receiving, 2-pt,
   fumbles, D/ST tiers, kicker distance buckets), lineup slot ids
   (QB=0 … FLEX=23, BE=20, IR=21 …), position ids (`defaultPositionId`),
   pro team ids, `injuryStatus` values, transaction types, `waiverProcessStatus`,
   `playoffSeedingRule` values, `acquisitionType` values, `statSourceId`
   (0 actual, 1 projected) and `statSplitTypeId` (0 season, 1 week, …).
   Say which maps you could cross-check against two independent sources.
3. **Teams / rosters**: `teams[].roster.entries[]` (`lineupSlotId`,
   `acquisitionType`, `playerPoolEntry.player.{id, fullName, defaultPositionId,
   eligibleSlots, proTeamId, injuryStatus, injured, stats[]}`,
   `playerPoolEntry.onTeamId`, `ratings`, `ownership.{percentOwned, percentChange,
   percentStarted, averageDraftPosition}`), `draftDayProjectedRank`, `currentProjectedRank`.
4. **Matchups / scoring**: `schedule[]` (`matchupPeriodId`, `home/away.{teamId,
   totalPoints, totalPointsLive, rosterForCurrentScoringPeriod,
   rosterForMatchupPeriod, cumulativeScore}`, `winner`, `playoffTierType`).
5. **Players**: `kona_player_info` with `X-Fantasy-Filter` — what ESPN
   exposes natively that we would otherwise need a second source for:
   weekly and season **projections** (`statSourceId=1`), actuals,
   **ownership %** and change, **draft ranks / positional ranks**
   (`draftRanksByRankType`), **injury status**, **player news/notes**
   (`kona_playercard`, `players_wl`, or the `news` view — find which endpoint
   returns free text), `seasonOutlook`, `lastNewsDate`, `outlook`s by week.
   Flag every free-text field: it is untrusted input for the model.
6. **Transactions and pending moves**: `mPendingTransactions`,
   `mTransactions2` — fields, waiver order (`waiverRank`), bid amounts,
   process dates. Also `mNav` / `members[]` (display names = personal
   identifiers; anonymize).
7. **Live scoring / box scores**: `mBoxscore` + `scoringPeriodId`,
   `mLiveScoring`; how "in-progress" games are represented.

### C. Credentials: obtaining, storing, expiring, recovering
1. How users obtain `espn_s2` and `SWID` today (browser DevTools → cookies
   for espn.com; the SWID braces `{…}` quirk; whether `espn_s2` must be
   URL-decoded or kept encoded). Cite the wrappers' instructions.
2. **Lifetime**: what is known about `espn_s2` expiry (community reports
   range widely — find the evidence: cookie `Expires` attribute observed in
   DevTools screenshots or wrapper issue threads, reports of forced
   re-login), whether SWID is stable per account, and whether ESPN rotates
   `espn_s2` on login or on password change.
3. **Expiry detection**: what a request with an expired/invalid `espn_s2`
   returns for a private league (status, body) vs a valid one, and whether
   a cheap "am I still logged in" probe exists (e.g., `mNav`/`members`, or
   `fan.api.espn.com`). Design the graceful-expiry behaviour: detect,
   surface a clear message, never retry in a loop, never log the cookie.
4. **Storage recommendation** for a local Node stdio server on macOS (also
   Windows/Linux): compare (a) macOS Keychain via the `security` CLI or a
   maintained native module (evaluate `@napi-rs/keyring` vs the deprecated
   `keytar` vs shelling out — maintenance status, prebuilt binaries, install
   scripts), (b) a `0600` JSON file in `~/.config/<app>/` inside a `0700`
   dir with atomic writes, (c) env vars in the MCP client config (why this
   is worst: the client config is world-readable JSON, iCloud-synced on this
   machine). Recommend one default and one fallback. Include a safe
   **setup procedure** the user can follow (hidden-input prompt or a local
   one-shot setup page on `127.0.0.1` with a random port and CSRF token —
   assess both; note that the repo directory is inside an iCloud-synced
   folder so nothing secret may live there).
5. **Browser cookie-store readers** (Chrome/Firefox cookie DB extraction, à
   la `browser_cookie3`, and "login with Selenium/Playwright" flows): assess
   and give a recommendation (expected: reject as too invasive / brittle /
   TOS-adverse; say why in two sentences).
6. **Rotation**: what "rotate" means when there is no OAuth — log out
   everywhere / change password invalidates `espn_s2`? Verify or mark [U].

### D. Terms of service, rate limits, account risk — report plainly
1. Find and quote the governing text: Disney Terms of Use (the clause on
   automated access / scraping / "data mining"), the ESPN Fantasy Games
   terms, and anything ESPN publishes about API use. Note the date of the
   version you read.
2. Search for **evidence** of enforcement: accounts suspended or IPs blocked
   for API use, Cloudflare/Akamai challenges, `User-Agent` blocking, the
   2024–2025 host migration to `lm-api-reads`. Distinguish verified reports
   from forum folklore.
3. Rate limits: any observed numbers (none documented — say so), what
   wrappers do (nothing, mostly), and a **polite-usage design**: cache
   TTLs per view (settings ≈ daily, rosters ≈ minutes in-week, live scoring
   ≈ 60 s on game days, players ≈ hourly), single-flight de-duplication,
   exponential backoff with jitter on 429/5xx, a hard per-minute request
   cap, and a request budget per tool call.
4. Give the risk assessment in plain language with the mitigations:
   personal, single-league, read-mostly, cached, throttled, own account.

### E. Write endpoints — document, then recommend
Community tools implement lineup changes, add/drop, waiver claims and trade
proposals via `POST`/`PUT` to `…/leagues/{id}/transactions/` (and lineup via
`…/leagues/{id}/transactions/` with `type: ROSTER`). Document the payload
shapes as the wrappers and MCP servers encode them (cite file paths; copy
nothing), the required headers, and the failure modes. Then recommend
whether this project should build a write module at all (opt-in, off by
default, explicit confirmation per action) and what the account-risk delta
is versus read-only. You must **not** probe any write endpoint.

### F. API-drift resilience — design input for the plan
1. Catalogue the changes the community has seen (host moves, view renames,
   field renames, the `leagueHistory` split, cookie-name changes if any) with
   dates — this calibrates how often drift happens.
2. Recommend the resilience design: zod schemas per view with
   `passthrough()` on unknown fields but **hard failure on missing required
   fields**; recorded-and-anonymized fixtures with contract tests; a
   **drift detector** (a cheap daily probe of a public league comparing
   observed top-level keys/enums against the fixture manifest, failing
   loudly with a diff); a `health`/`version` tool that reports the API host,
   last-successful-probe time, schema version, cookie validity (boolean
   only) and cache state; graceful degradation rules (which tools still work
   without which views).
3. A fixture-anonymization procedure (what to strip, how to make it
   deterministic).

### G. Verified / unverified ledger and probe log
List everything you could not verify by name. Append a probe log (method,
URL with `[league-id]`, status, size, top-level keys, timestamp) — ≤ 30 rows.

**A clean negative is a real result.** If no rate-limit header exists, say
so. If cookie lifetime cannot be established, say so and give the design
that does not depend on knowing it.

## Deliverables (you own these paths; touch nothing else)

1. `docs/research/03-espn-api.md` — sections A–G above, sources inline,
   unverified list at the end. Aim for completeness over prose; tables for
   enums and views.
2. `docs/scratch/espn-api-specialist.md` — working notes with `## RESUME HERE`.

**Do NOT touch**: `README.md`, `.gitignore`, `.env.example`,
`docs/research/00-*`, `01-*`, `02-*` (the auditor's), `04-*` or later,
`docs/scratch/roster.md`, `docs/scratch/program.md`, `docs/scratch/briefs/`.
Leave any file you did not create exactly as you find it.

## What a FAILED report looks like

- Endpoint or field claims from memory with no source tag.
- A probe log that includes cookies, a private league, or > 30 requests.
- Team/owner names or GUIDs from a public league written into the repo.
- "ESPN might ban you" without the actual ToS text and the evidence search.
- A storage recommendation that does not consider the iCloud-synced
  repo directory or the world-readable MCP client config.
- Findings that exist only in your reply and not in the pushed file.
- A reply without the pushed SHAs.

## COMMIT/PUSH DISCIPLINE — Chad's standing rule, non-negotiable

**No work you do may be lost.**
- **Your FIRST action is** `docs/scratch/espn-api-specialist.md` with a
  `## RESUME HERE` section — commit and push it before any real work, and
  keep it current.
- **Commit and push to `origin/main` at every natural checkpoint** — after
  each section A–G lands, not once at the end.
- **Before you are torn down, blocked, or run low on context, COMMIT AND
  PUSH FIRST, then reply.**
- **Track your remaining budget.** At roughly **20% context remaining**, stop
  taking on new scope: commit, push, update `## RESUME HERE`, reply.
- **Preserve unfinished work on `origin` as a PATCH, never as broken files**:
  `git diff -- <your paths> > docs/scratch/espn-api-specialist.wip.patch`
  (untracked files: `git diff --no-index /dev/null <file> >> …`), commit and
  push only that file. Refresh it every ~15 minutes of work. Retire it in
  your final commit.
- **Stage EXPLICIT PATHS ONLY.** Never `git add -A`, `git add -u`, or
  `git add <directory>`; never `git stash`; never `git checkout` a file with
  uncommitted work. Another agent shares this tree. If `git` reports an
  `index.lock`, wait a few seconds and retry — do not delete the lock.
- `git pull --rebase origin main` before every push. Never force-push. After
  each push run `git fetch && git rev-parse HEAD origin/main` and confirm they
  match.
- Commit messages: conventional style, e.g.
  `docs(research): espn api — views, filters, error shapes (A)`, ending with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commit identity is already configured locally in this repo. Do not change
  git config.

## Reply format

When done: (1) the pushed SHAs, (2) the five facts about the API that most
constrain our design, (3) the credential-storage recommendation in three
lines, (4) the ToS/account-risk verdict in three lines, (5) the unverified
list, by name.
