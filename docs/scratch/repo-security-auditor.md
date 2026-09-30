# Working notes — repo-security-auditor

Brief: `docs/scratch/briefs/repo-security-auditor.md`. Deliverables I own:
`docs/research/01-repo-security-audit.md`, `docs/research/02-prior-art-lessons.md`,
this file. Clones live only under the session scratch dir
(`…/scratchpad/eff-research/vendor/<owner>__<name>`), never in the repo.
My inventory script: `…/scratchpad/eff-research/inv.sh` (read-only git + grep,
masks GUID- and token-shaped values before printing); reports in `…/eff-research/inv/`.

Standing rules applied: every clone `--depth 1` then `git fetch --unshallow` for
small repos (fetch runs no hooks; history checks are real for all but ffscrapr);
nothing installed or executed; credential values never printed (masked as
`[redacted-…]`); dependency audits via `npm audit --package-lock-only` (lockfile
only) or the OSV HTTP API.

## RESUME HERE

**Status (2026-09-30): COMPLETE.** 31 clones inventoried and read (29 from the
brief + discovery, 2 added by the coordinator: jwulff/fantasy-sports and
DanielTomaro13/sportsdata-mcp). Dependency audits done (npm lockfile-only ×7,
OSV over 7 uv.lock files + direct deps of 7 lockfile-less repos). Deliverables
written: `docs/research/01-repo-security-audit.md` (method, 31-row table,
per-repo findings, rejected list, severity counts, unverifiable list) and
`docs/research/02-prior-art-lessons.md` (two capability matrices, 13 working
choices, 20 mistakes with symptoms, design deltas, API-knowledge pointers).

**Nothing left to do.** If re-opened: the clones and inventory reports are in
the session scratchpad (`…/eff-research/vendor/`, `…/eff-research/inv/`,
`…/eff-research/audit/`); they are not committed and will vanish with the
session — re-clone at the SHAs in 01 if needed.

**Verdict tally:** Safe 9 (mdanaher1, mpsthedude, fantasy-yolo, tlo1216, mkreiser,
ryanjadhav, stmorse, ffscrapr-adapter, jwulff) · Caution 8 (KBThree13, dodi,
weinstein, rrichardtang, saik0v0ur, cwendt94, eponerine, sportsdata-mcp) · Do not
use 4 (JayMishra, Possardt, darkonda, true-champion) + 5 sibling multi-platform ·
Skipped 12 by name.

## Audit log (verdicts + key evidence; file:line refer to the clone at the SHA)

Legend: S = Safe to learn from · C = Learn from with caution · X = Do not use · — = skipped

### ESPN MCP servers
1. mdanaher1/espn-ff-mcp `707a431f` py MIT 1★ 2025-09-16, 18 commits — **S**.
   creds clean (tree+history). env ESPN_S2/ESPN_SWID via `load_dotenv()` (cwd
   `.env`, gitignored). 22 tools, all read; json.dumps output; logging→stderr;
   no values logged. Deps floating (`mcp>=1.0.0`, `espn-api>=0.45.1`), uv.lock.
   README recommends Chrome ext "ESPN Private League Setup" (id bjmalaa…) — not
   open source; not audited. Caution: cwd `.env`; floating mcp.
2. mpsthedude/ESPN-Fantasy-Football-MCP `0e9911af` py MIT 0★ 2026-09-08 (4
   squashed commits; pkg name `fantasy-football-mcp`, not on PyPI) — **S**
   (caution: history unauditable; 612 KB/10.8k-line single file; optional
   `authenticate(espn_s2, swid)` tool = cookies via chat). Best hygiene seen:
   own transport `espn_transport.py` (cookies in Session jar, hosts
   lm-api-reads + fan.api.espn.com only; error text never includes upstream
   text, lines 137-149); stderr redaction `_redact_runtime_secrets`
   (server.py:38-58); `mcp_tool_annotations.py` fail-closed read-only set;
   app-home dir for credentials.json/registry (`app_config.py`); registry
   validator rejects secret-like keys. Third-party: FantasyPros + SportsGameOdds
   (opt-in API keys, `x-api-key` only; ESPN cookies never sent). ~50 tools, no
   ESPN writes. `fetch_fan_profile` puts SWID in URL path (ESPN fan API design).
3. KBThree13/mcp_espn_ff `153572e4` py MIT 48★ 2025-12-19 — **C**. creds
   clean. `authenticate(espn_s2, swid)` is the ONLY way in: cookies typed into
   chat → LLM transcript (espn_fantasy_server.py:77-94); in-memory after; cache
   key embeds cookie values (:45). `str(dict)` output (:119). 8 read tools.
   `.DS_Store` committed; `.gitignore` lacks `.env`. stderr logging.
4. gagandaroach/fantasy-yolo `a4e18250` py MIT 0★ 2026-09-24 (36 commits,
   MCP SDK 2.x) — **S** (caution: 2 weeks old, single author; vendored espn-api
   logger writes to stdout if debug=True, espn/utils/logger.py:15). creds clean.
   Credentials JSON file path from `~/.config/fantasy-yolo/config.json`;
   `load_credentials` REFUSES group/world-readable file (creds.py:41-45);
   `redact()` scrubs all secrets from anything leaving the process. Writes:
   preview_*/execute_* pairs, file-backed single-use token bound to payload
   fingerprint, TTL 600 s (policy/tokens.py); re-read + re-plan before execute
   (tools/moves.py); `max_retries=0` write client, UNKNOWN outcome on timeout
   (write/client.py); write tools not registered unless config
   `write_enabled` (mcp/server.py:53-60); annotations read_only/destructive;
   append-only audit log 0600, redacted (policy/audit.py). Honest docstring:
   token ≠ human approval. Fixtures inherited from espn-api carry real member
   names/GUIDs of a 2015/2018 league.
5. HamCops/dodi (= HamCops/espn-mcp, renamed) `08c14bf9` py MIT 0★
   2026-09-30, 32 commits, pkg `espn-mcp`, NO lockfile — **C**. creds clean.
   `.env` at fixed repo-root path, not cwd (config.py:10-13); SWID braces
   normalised; secrets scrubbed from errors incl. exception args (espn.py:79,
   118-124); cookies scoped `.espn.com` + Secure; `host_allowed()` refuses any
   non-https non-espn.com URL before sending (espn.py:23-35, 116-118); external
   sources allow-listed, no credentials (sources/http.py:10-11, 44-56). 30
   tools incl. writes set_lineup/move_player/add_player/drop_player/
   propose_trade/respond_to_trade with `apply: bool=False` (model-set flag; one
   call with apply=true writes). Optional `ESPN_REQUIRE_APPROVAL` → proposals in
   sqlite 0600 + phone approval via loopback HTTP + ntfy push (roster text +
   per-proposal Bearer token in notification actions); lineup changes bypass
   approvals; `ESPN_AUTO_APPLY` policy applies some moves with no human
   (autopolicy.py). `GAMETIME_HOOK` runs a user-configured executable. Draft
   scripts (optional `browser` extra) use a persistent logged-in Playwright
   profile in `state/browser-profile/` (repo dir, default perms) or attach to
   the user's Brave over CDP; SWID in draft URL query. research/*.pkl = offline
   scripts only.
6. tlo1216/espn-fantasy-mcp `afebd246` TS MIT 1★ 2026-09-10, 10 commits
   (caleblwright = identical fork) — **S** (caution: `.env` and
   `logs/writes.jsonl` are cwd-relative, env.ts:40, client.ts:188; error bodies
   echoed ≤300 chars, client.ts:66; `dry_run` flag is model-set). creds clean.
   zod v3 input+output schemas on all 17 tools; annotations; `WRITES_ENABLED`
   env gate (default false); memberId/SWID redacted from results + log
   (client.ts:142-164); serial rate limiter (2/s reads, 1/5 s writes); writes
   never retried; SDK `^1.12.0` floating, lockfile present.
7. i-am-david-weinstein/espn-fantasy-mcp `a7ad4e8b` py MIT 1★ 2026-08-23,
   37 commits, PyPI `espn-fantasy-mcp` 0.2.0, Smithery config — **C**. Fantasy
   BASEBALL server (README:8) but ESPN cookie/transaction code is sport-generic.
   creds clean. env ESPN_S2/ESPN_SWID (+dotenv); `unquote()` on espn_s2. 16
   tools incl. full write set (modify_lineup, add/drop, claim/cancel waiver,
   propose/cancel/accept/decline trade) with `confirm: bool=False` preview
   pattern (model-set). No lockfile; deps floating (`fastmcp>=2.0.0`,
   `espn-api>=0.30.0`). `smithery.yaml` = cloud-hosted install path where the
   cookies become hosted config. `requests.post` without timeout.
8. rrichardtang/ESPN-fantasy-mcp `23c42667` py NO LICENSE 1★ 2026-09-29 —
   **C** (no license; remote-hosting design). Read-only single-file server for
   Cloud Run (`--allow-unauthenticated`, URL-embedded `MCP_SECRET`); deploy.sh
   reads cookies with `read -rs` and writes them to a temp env-vars file → Cloud
   Run env (deploy.sh:21-33). Pinned deps (espn-api==0.46.0, mcp==2.2.0).
   ToolAnnotations read_only; JSON output; ESPN errors surfaced via ToolError.
9. saik0v0ur/espn-fantasy-mcp `6fa7bb4b` py NO LICENSE 0★ 2026-09-28, 2
   commits — **C** (no license; new). Read-only, own httpx client, Cookie header
   to lm-api-reads only (server.py:220-235); multi-league `ESPN_LEAGUES` JSON env
   may carry per-league s2/swid; TTL cache; error text echoes ≤300 chars of body.
   13 tools. Floating deps, no lockfile.
10. ktrann24/espn-fantasy-mcp `ff16085f` py MIT 0★ 2026-07-10, 1 commit —
    **—** skipped: fantasy basketball, 7 read tools, nothing football-specific;
    creds clean; env vars; uv.lock.
11. noahking0207-hash/espn-fantasy-mcp2 / -mcp3 — **—** skipped: 150-line
    "Add files via upload" single files for Render hosting, no license, no history.
12. JayMishra-source/Fantasy-Football-AI-CoManager `8e5e7307` TS no license
    5★ 2026-08-28 — **X**. `eval(p.condition…)` on data
    (shared/src/tools/aiWorkflowOrchestrator.ts:287); runtime
    `spawn('npx', ['@oevortex/ddg_search'])` (shared/src/services/webSearchLLM.ts:148)
    = downloads+executes a third-party package at run time; undeclared LLM sinks
    (OpenAI/Anthropic/Gemini/Perplexity) + Slack/Discord/Pushover webhooks +
    scrapingdog/serper/newsapi; GitHub Actions run with ESPN cookies as secrets;
    `get-claude-config.sh` echoes cookie values into the client config;
    committed captures of the author's own league (league1_roster.json etc.);
    `prepare: npm run build` hook (temp_artifacts). creds: no espn_s2 values in
    history (GUID hits were bare UUIDs).

### ESPN API wrappers / libraries
13. cwendt94/espn-api `663d726c` py MIT 981★ 2026-09-23, 837 commits, PyPI
    0.46.0 — **C**. HISTORICAL LEAK: commit `643feca` (2020-09-11) added a
    top-level `transactions.py` with two real `espn_s2=` and `swid=` literals
    (lines 21-23 of the diff, values [redacted]) for two leagues; file absent
    at HEAD; cookies are session cookies (expire ~1 yr) → treat as compromised,
    long expired. Current tree clean. Reads only (lm-api-reads,
    site.api.espn.com news); cookies via requests `cookies=`; debug logger
    → STDOUT (utils/logger.py:17) and logs headers (x-fantasy-filter, not
    cookies). Deps pinned narrow, uv.lock; setup.py has no custom commands.
    Fixtures contain real member names/GUIDs of a 2015/2018 league.
14. mkreiser/ESPN-Fantasy-Football-API `18b6bf2b` JS LGPL-3.0 351★
    2025-01-04 (idle 21 mo), npm 2.0.1 — **S** (LGPL: fine to learn from; would
    constrain only if code were copied — none is). creds clean (500 commits).
    Cookie header built client.js:362; only lm-api-reads; no writes; axios+
    lodash; lockfile. CI integration tests use GH secrets.
15. eponerine/espn-fantasy-football-api-node `ced9fa80` JS MIT 0★
    2026-09-14, 8 commits — **C**. JS port of espn-api + Express REST wrapper
    that accepts `espnS2`/`swid` as QUERY-STRING params (api/server.js:80-81) →
    cookies in URLs/access logs; debug logger logs the merged headers incl.
    Cookie (requests/espnFantasyRequests.js:69-71,121). Read-only.
16. Possardt/espn-ff-api `8487e83f` JS no LICENSE file (pkg says ISC) 12★
    2018-10-04, npm 1.0.9 — **X**: targets dead `http://games.espn.com` over
    plain HTTP with cookies (espn-request.js:20); deprecated `request` deps;
    unmaintained 8 yr. ryanpag3/espn-ff-api-2 = fork +2 → skipped.
17. ryanjadhav/espn-fantasy `5b823184` py MIT 0★ 2026-09-23, 2 commits —
    **S** (tiny, new). Zero-dependency urllib CLI; cookies in
    `~/.config/espn/cookies.json` (README says chmod 600; NOT enforced in code,
    bin/espn_api.py:92-99); writes via `espn_txn.py` with `--dry-run`; SKILL.md
    for agents. Hosts reads+writes only.
18. stmorse/espn_ff `916db143` py MIT 0★ 2026-09-23, 3 commits — **S**
    (analysis lib; little architecture). config.ini (gitignored) or env; cookies
    via requests; JSON file cache `.cache/`; reads only.
19. ffverse/ffscrapr `b6990181` R MIT (sibling verdict S; shallow) — ESPN
    adapter only: `espn_connect()` takes swid/espn_s2 as args (README pattern
    `Sys.getenv`), sets httr cookies (R/espn_connect.R:66-81); host
    lm-api-reads only; no persistence. **S** (adapter clean).
20. rbarton65/espnff `e9480c32` py no license 258★ 2017-08-07 — **—**
    skipped: dead `games.espn.com` v2 API, unmaintained 9 yr, superseded by 13.
21. dtcarls/fantasy_football_chat_bot `1ae24409` py GPL-3.0 307★ 2026-09-07
    — consumer of espn-api (env `ESPN_S2`/`SWID`, gamedaybot/espn/env_vars.py);
    not audited beyond cookie sourcing (GPL; chat bot, not a library).
22. pseudo-r/Public-ESPN-Fantasy-API `65818688` py NOASSERTION 10★ 2026-03-26
    — Django ingest service + docs; cookies from settings/env; **—** skipped
    for architecture; docs/ useful to the API specialist (pointer only).

### Cookie-acquisition helpers (highest-risk category)
23. darkonda/espn-cookies `29e7dfb3` TS no license 3★ 2026-01-07, 1 commit —
    **X**. Next.js + Puppeteer AUTOMATED ESPN LOGIN with username/password (+OTP
    loop, route.ts:460), extracts espn_s2/SWID, writes session dumps to disk
    (route.ts:106), shows values in the page (page.tsx:309), debug-screenshots
    route. Archetype of what not to do.
24. shulman33/true-champion-extension `4fd8c70b` TS MIT 0★ 2026-09-18 — **X**
    for our purpose (works as designed for its SaaS): Chrome MV3 extension reads
    espn_s2+SWID via `chrome.cookies.get` (popup.ts:20-21, connect.ts:83) and
    POSTs them to `www.truechampion.app` with a connect token (connect.ts:90).
    Tests origin checks against `evil.example`. dev-key.json = public key.
25. pdroll/ESPN-Fantasy-Football-Scraper `650bbe2b` JS BSD(pkg) 37★ 2015 —
    **—** skipped: not a cookie helper; scrapes dead `games.espn.go.com`.
26. jpmayer/fantasy-chrome-extension `6fdedde3` JS MIT 39★ 2021 — **—**
    skipped: content-script UI extension using the page's own session; no cookie
    extraction; vendored minified libs; no .gitignore.
27. Chrome Web Store "ESPN Private League Setup" (recommended by #1 README) —
    no public source found; NOT audited; flag as unverifiable.
28. HamCops/dodi Playwright persistent profile (see #5) and `browser_cookie3`-
    style DB readers: none found on GitHub by search (`espn_s2 browser_cookie3`,
    `espn_s2 selenium`, `espn_s2 playwright` → 0 repos).

### Multi-platform servers from the sibling audit
carterfawson, kYpranite, andrewrgoss, MichaelCrowcroft: `gh search code espn`
→ 0 hits; derekrbreese: hits only in roster-slot constants/docs, no cookie
code. None handles espn_s2/SWID → nothing to add; verdicts cited from sibling.

### Added by the coordinator (2026-09-30)
29. jwulff/fantasy-sports `93830048` py MIT 2★ 2026-09-12, 119 commits — **S**.
    CLI (typer), reads only in src (0 write hits); write surface captured as
    research (`docs/research/05-espn-write-surface/`, 23 probes, all SWIDs
    `{SWID-REDACTED}`/pseudonymised). Auth chain env → Keychain (keyring) → XDG
    config.toml; `Secret` carrier; errors scrub at construction; SQLite HTTP
    cache redacted; `untrusted` output container + indented-block renderer.
    uv.lock → 6 advisories (urllib3 2.2.3: 4 H, 2 M). creds clean (FAKE_ constants).
30. DanielTomaro13/sportsdata-mcp `713f5a7a` py MIT 21★ 2026-09-29, 259 commits
    — **C**. Spec-driven, 841 tools/64 providers; ESPN: 27 reads + 2 writes in
    an opt-in `espnfantasy.write` group; cookie = `ESPN_FANTASY_COOKIE` raw
    Cookie header via static_header auth. `connect espnfantasy` reads the
    Chrome-family cookie DB (all profiles) and decrypts with the Chrome Safe
    Storage Keychain key (`connect.py:131-210`), host-scoped, verified, saved
    0600, never printed; manual fallback. Telemetry local-only unless two env
    vars set; OTA signed spec bundles on explicit command; opt-in licence gate
    → sportsdata-entitlement.sportsdata.workers.dev; root-logger secret filter.
    `fastmcp>=0.4,<4`, no lockfile; direct deps at latest: 0. creds clean (doc
    GUID is an all-letters placeholder).
