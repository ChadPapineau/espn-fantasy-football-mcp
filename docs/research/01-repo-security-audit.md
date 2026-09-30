# 01 — Repo security audit (prior-art vetting, ESPN)

**Author:** `repo-security-auditor` agent · **Date:** 2026-09-30 · **Status:** complete
for the brief's list plus 11 repos found by search. Companion: `02-prior-art-lessons.md`
(architecture lessons from the repos that pass).

Every repo was treated as **untrusted**. Nothing from any clone was installed or
executed. Findings come from `git` plumbing, `grep`, reading source, `gh api`,
`npm audit --package-lock-only --ignore-scripts` (reads the lockfile, runs nothing) and
the public OSV API. Secret **values** are never reproduced; a leak is cited by commit,
file and line with the value replaced by `[redacted]`. Sibling program overlap is reused
by citation: `ChadPapineau/yahoo-fantasy-football-mcp` `docs/research/01-repo-security-audit.md`
(2026-09-29).

## Method

1. Metadata via `gh api repos/<o>/<r>` (fork parent, archived, stars, language, SPDX
   license, `pushed_at`). Forks compared to parents with the compare API; identical or
   trivially-ahead forks skipped by name.
2. Clone `--depth 1` into the session scratchpad (outside the repo:
   `…/scratchpad/eff-research/vendor/<owner>__<name>`), then `git fetch --unshallow`
   for every repo except `ffverse/ffscrapr` (80 MB) so that history checks are real.
   Fetch runs no hooks; checkout was done with `core.hooksPath=/dev/null`.
3. One inventory script per clone (`inv.sh`, my own, kept in the scratchpad): tracked
   files, suspicious filenames, `.gitignore`, manifests and lockfiles, install-time
   hooks, secret-pattern greps (`espn_s2`, `SWID`, `Cookie:`, `Bearer`, GUID-shaped
   and ≥40-char opaque literals), full-history scans for GUID-shaped and
   `espn_s2=<long value>` additions, every outbound host literal, exec/obfuscation
   markers (`eval`, `new Function`, `subprocess`, `child_process`, `os.system`,
   dynamic import, pickle, base64 decode), stdout logging, log lines mentioning
   cookies/headers, env-var reads, file writes and permission bits, browser-cookie/
   automation markers, validation libraries, tool registrations, transport, write
   endpoints. Every output line passes through a masker that replaces GUID- and
   token-shaped strings before anything is printed.
4. Targeted reading of the credential, transport, write and logging paths of each
   repo that passed the inventory.
5. Dependency audit: `npm audit --package-lock-only --ignore-scripts --json` where a
   `package-lock.json` exists; OSV `querybatch` over every `uv.lock` (advisories
   de-duplicated by CVE, severity from the GHSA record); for repos without a
   lockfile, OSV at the pinned version or at today's latest PyPI release of each
   *direct* dependency (transitives cannot be resolved statically — stated per repo).

## Summary table

Verdicts: **S** = Safe to learn from · **C** = Learn from with caution · **X** = Do not
use · **—** = skipped (reason given).

| # | Repo | Reviewed SHA | Lang | License | Last commit | Stars | Maintained? | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | mdanaher1/espn-ff-mcp | `707a431f0e7531f78fff6062b14ed59fbe4a762d` | Python | MIT | 2025-09-16 | 1 | No (1 yr idle) | **S** (floating `mcp`; cwd `.env`) |
| 2 | mpsthedude/ESPN-Fantasy-Football-MCP | `0e9911af69e98dd2eb7aa0c87d9a9ae8ba19e80f` | Python | MIT | 2026-09-08 | 0 | Yes (4 squashed commits) | **S** (caution: unauditable history; 10.8k-line file; optional cookies-via-chat tool) |
| 3 | KBThree13/mcp_espn_ff | `153572e4e3ab065677e1caca97d685e073b2c246` | Python | MIT | 2025-12-19 | 48 | Slow | **C** — cookies only via a tool argument (chat transcript); `str(dict)` output |
| 3a | anthtogs/mcp_espn_ff (fork of #3, +0) | — | — | MIT | 2026-08-27 | 0 | — | **—** identical fork |
| 3b | jlumba79/mcp_espn_ff (fork of #3, +2) | `4e7a99d1` | Python | MIT | 2026-09-16 | 0 | — | **—** fork; adds `.env` defaults + a `/startsit` command only |
| 4 | gagandaroach/fantasy-yolo | `a4e1825087360532a16c6661859495da76194f5a` | Python (MCP SDK 2.x) | MIT (+ vendored espn-api MIT) | 2026-09-24 | 0 | New (16 days, 36 commits) | **S** (caution: brand-new; vendored logger → stdout when debug) |
| 5 | HamCops/dodi (= HamCops/espn-mcp, renamed) | `08c14bf9d910a23709e7910ed01756ff1fbd6ff8` | Python | MIT | 2026-09-30 | 0 | Yes (active) | **C** — model-set `apply` flag; opt-in auto-apply; persistent logged-in browser profile; no lockfile |
| 6 | tlo1216/espn-fantasy-mcp | `afebd2468d430a35f8d3ca7adeba216b136f93df` | TypeScript | MIT | 2026-09-10 | 1 | New (10 commits) | **S** (caution: cwd-relative `.env` and write log; model-set `dry_run`) |
| 6a | caleblwright/espn-fantasy-mcp (fork of #6) | `afebd246` (same) | — | MIT | 2026-09-20 | 0 | — | **—** identical fork |
| 7 | i-am-david-weinstein/espn-fantasy-mcp (PyPI `espn-fantasy-mcp` 0.2.0) | `a7ad4e8b211fec1f05985ab2185bddf3cbe01ade` | Python | MIT | 2026-08-23 | 1 | Slow | **C** — full write set behind a model-set `confirm`; no lockfile; Smithery hosting path; **baseball** server |
| 8 | rrichardtang/ESPN-fantasy-mcp | `23c42667a3503bc068bdda52f4a22a71a87dac5c` | Python | **none** | 2026-09-29 | 1 | New | **C** — no license; Cloud Run design puts cookies in hosted env |
| 9 | saik0v0ur/espn-fantasy-mcp | `6fa7bb4b585ce2ec15ccee6a3ea28f6ffec979a9` | Python | **none** | 2026-09-28 | 0 | New (2 commits) | **C** — no license; brand-new |
| 10 | ktrann24/espn-fantasy-mcp | `ff16085f04fb99e72549354b337a3c4fa5a13136` | Python | MIT | 2026-07-10 | 0 | No (1 commit) | **—** basketball, read-only, nothing football-specific (creds clean) |
| 11 | noahking0207-hash/espn-fantasy-mcp2, -mcp3 | `67b592c7`, `55679c68` | Python | none | 2026-09-29 | 0 | No | **—** 150-line "Add files via upload" Render deploys |
| 12 | JayMishra-source/Fantasy-Football-AI-CoManager | `8e5e7307c5a11d7fe8b67b1d85900571ff2443cc` | TypeScript | **none** | 2026-08-28 | 5 | Slow | **X** — `eval` on data; runtime `npx` spawn; undeclared LLM/webhook sinks |
| 13 | cwendt94/espn-api (PyPI 0.46.0) | `663d726c82acdcd1e1f42ecaef35b993ce9ce455` | Python | MIT | 2026-09-23 | 981 | Yes | **C** — 2020 session-cookie leak in history (expired); debug logger → stdout |
| 14 | mkreiser/ESPN-Fantasy-Football-API (npm 2.0.1) | `18b6bf2bc9344470e135102278d1b3ba7fdc36e8` | JavaScript | LGPL-3.0 | 2025-01-04 | 351 | Idle 21 mo | **S** (LGPL noted; read-only) |
| 15 | eponerine/espn-fantasy-football-api-node | `ced9fa8074b78ee9d8fa4bf565023979c6f1b97e` | JavaScript | MIT | 2026-09-14 | 0 | New (8 commits) | **C** — cookies accepted as URL query params; debug log prints Cookie header |
| 16 | Possardt/espn-ff-api (npm 1.0.9) | `8487e83f7472ea9c5e4f308171f5697aa82049a8` | JavaScript | none file (pkg: ISC) | 2018-10-04 | 12 | No (8 yr) | **X** — dead `games.espn.com` API over plain `http://` with cookies |
| 16a | ryanpag3/espn-ff-api-2 (fork of #16, +2) | — | — | none | 2018-09-22 | 0 | No | **—** fork of a rejected repo |
| 17 | ryanjadhav/espn-fantasy | `5b82318495bd4197c0d3e6880d380f902f35738d` | Python | MIT | 2026-09-23 | 0 | New (2 commits) | **S** (tiny; 0600 claim not enforced) |
| 18 | stmorse/espn_ff | `916db1432cfdd8da610f8623cc9fb307832fe7e9` | Python | MIT | 2026-09-23 | 0 | New (3 commits) | **S** (analysis library) |
| 19 | ffverse/ffscrapr — ESPN adapter only | `b6990181e125507a1b4642cea6bc9778d9acd6f3` | R | MIT | 2024-10-31 | 96 | Idle 23 mo | **S** (sibling verdict; adapter clean) |
| 20 | rbarton65/espnff | `e9480c32423d2683fa54c4d68ffcfbbaed921f55` | Python | none | 2017-08-07 | 258 | No (9 yr) | **—** dead v2 API; superseded by #13 |
| 21 | dtcarls/fantasy_football_chat_bot | `1ae2440916c2d55e6cf1fe25bf4ace5a852921f8` | Python | GPL-3.0 | 2026-09-07 | 307 | Yes | **—** chat bot consuming #13 (env cookies only); GPL; not architecture prior art |
| 22 | pseudo-r/Public-ESPN-Fantasy-API | `65818688f635fa7586123e9ebac7d441bf8c8a54` | Python (Django) | NOASSERTION | 2026-03-26 | 10 | Slow | **—** docs pointer only (see 02 §6) |
| 23 | darkonda/espn-cookies | `29e7dfb3a7187c04bf98218487a298ec68946dae` | TypeScript | **none** | 2026-01-07 | 3 | No (1 commit) | **X** — automated username/password login; cookie dumps to disk |
| 24 | shulman33/true-champion-extension | `4fd8c70b37a3786c341329cb473f3e2d1a0dde37` | TypeScript | MIT | 2026-09-18 | 0 | New | **X** for us — extension ships espn_s2/SWID to a third-party SaaS |
| 25 | pdroll/ESPN-Fantasy-Football-Scraper | `650bbe2b9bce10c340a37f9b214d896497484ed7` | JavaScript | BSD (pkg only) | 2015-11-10 | 37 | No | **—** not a cookie helper; scrapes dead `games.espn.go.com` |
| 26 | jpmayer/fantasy-chrome-extension | `6fdedde37bfafe6d4d320cf932a91fe29cfa981d` | JavaScript | MIT | 2021-09-04 | 39 | No | **—** page-UI extension; no cookie extraction |
| 27 | Chrome Web Store "ESPN Private League Setup" (recommended by #1) | — | — | — | — | — | — | **—** no public source; **not verifiable** |
| 28 | jwulff/fantasy-sports (added by coordinator) | `93830048b68a5c00bdae5af2970bcd50bd08ae11` | Python | MIT | 2026-09-12 | 2 | Yes (119 commits) | **S** — CLI, read-only; best credential/redaction/untrusted-output design seen |
| 29 | DanielTomaro13/sportsdata-mcp (added by coordinator) | `713f5a7a4746c34f270e3ead544dbf2a2ee7bba7` | Python | MIT | 2026-09-29 | 21 | Yes (259 commits) | **C** — opt-in Chrome cookie-DB reader; `fastmcp>=0.4,<4`, no lockfile; large commerce/OTA/telemetry surface (all opt-in) |
| — | carterfawson, derekrbreese, kYpranite, andrewrgoss, MichaelCrowcroft (multi-platform) | see sibling audit | — | — | — | — | — | **X** (sibling); no ESPN cookie code (see §"Multi-platform") |

Search coverage (2026-09-30): `gh search repos` for "espn fantasy mcp" (7 hits),
"espn_s2 mcp" (0), "ESPN-Fantasy-Football" sorted by stars (30), "espn cookie",
"espn private league setup", "espn_s2 chrome extension"; `gh search code` for
`browser_cookie3 espn_s2` (0). No `browser_cookie3`/Selenium cookie-DB readers for
ESPN exist on GitHub under those terms; the only cookie-acquisition helpers found are
#23, #24, the Playwright profile in #5, and the closed-source extension #27.

Two repos were added mid-audit by the coordinator on the ESPN API specialist's
recommendation (#28, #29); both audited under the same rules.

---

## Per-repo findings

Categories: **Cr** credentials · **Ck** cookie acquisition/storage/transmission ·
**N** network/exfiltration · **O** obfuscation/exec · **I** install-time execution ·
**P** prompt-injection surface & writes · **V** input validation · **D** dependencies ·
**L** license · **Lg** logging hygiene. Evidence is `file:line` in the clone at the SHA.

### 1. mdanaher1/espn-ff-mcp — Safe to learn from

- **Cr:** clean (tree and 18-commit history; test strings only, `tests/test_config.py:31-32`).
- **Ck:** env `ESPN_SWID`/`ESPN_S2` via `load_dotenv()` at import (`src/espn_ff_mcp/config.py:9,33-34`)
  → `.env` in the **launch cwd**; `.gitignore` covers `.env`/`.env.local`. Passed to
  `espn_api.League(**kwargs)` (`espn_client.py:56-58`); transmission is #13's. README
  recommends a closed-source Chrome extension for extraction (`README.md:69-75`) and the
  DevTools method.
- **N:** none of its own (all via #13 → `lm-api-reads.fantasy.espn.com`). **O:** none.
  **I:** none (setuptools, no custom commands).
- **P:** 20 read tools (`server.py:124-646`; two commented out), no writes. Team/owner
  names and message-board text returned verbatim in JSON, unlabelled
  (`get_message_board`). **V:** FastMCP type hints; pydantic only for config.
- **D:** `mcp>=1.0.0`, `espn-api>=0.45.1` floating; `uv.lock` (53 pkgs) → 32 advisories
  (§Dependency audit). **L:** MIT.
- **Lg:** `logging.basicConfig(INFO)` → stderr (`server.py:13`); no cookie values in log
  lines (`espn_client.py:60`); JSON output via `json.dumps` everywhere.

### 2. mpsthedude/ESPN-Fantasy-Football-MCP — Safe to learn from (cautions named)

- **Cr:** clean in tree; only 4 squashed commits exist ("Publish 0.4.1"), so earlier
  history **cannot be audited**. Package name `fantasy-football-mcp` collides with the
  rejected multi-platform servers' names; not on PyPI (404 on 2026-09-30).
- **Ck:** `ESPN_S2` + `ESPN_SWID` (or `SWID` alias) from env, resolved once per
  session (`app_config.py:226-263`, `espn_session.py:33-41`); optional
  `credentials.json` under an app-home dir (`app_config.py:41-65`, "read-only loader");
  registry/config validators reject secret-like keys (`league_registry.py:64-78`,
  `commissioner_config.py:43-44`). An `authenticate(espn_s2, swid)` tool exists as an
  **optional override** — cookies typed into chat end up in the transcript
  (`espn_fantasy_server.py:2857-2881`). Transmission: own transport keeps cookies in a
  `requests.Session` jar, hosts `lm-api-reads.fantasy.espn.com` and
  `fan.api.espn.com` only (`espn_transport.py:24-25,86-87`); SWID appears in the fan-API
  URL path by ESPN's design (`:156`). Error messages never include upstream text
  (`:137-149`).
- **N:** FantasyPros (`api.fantasypros.com`, `x-api-key`) and SportsGameOdds
  (`api.sportsgameodds.com`, `x-api-key`) — opt-in, declared, ESPN cookies never sent
  (`fantasypros_client.py:670-675`, `sportsgameodds_client.py:324`). FantasyPros key can
  also be read from `~/.orcha/secrets/…txt` (`fantasypros_client.py:464`).
- **O:** `__import__("re")` (`:6950`) is trivial; `subprocess` only in GitHub Actions
  YAML. **I:** none (hatchling).
- **P:** ~52 tools, all ESPN reads + analysis; `mcp_tool_annotations.py` is a
  fail-closed read-only allow-list; state-changing tools are `authenticate`, `logout`
  and local draft-strategy files only. No ESPN writes. Untrusted text unlabelled.
- **V:** transport validates ids/year (`espn_transport.py:89-105`); FastMCP type hints.
- **D:** `mcp[cli]>=1.7.0,<2`, `requests>=2.32.3`; `uv.lock` (42 pkgs) → 14 advisories,
  10 of them in `pyjwt` (pulled by `mcp[cli]`). **L:** MIT.
- **Lg:** stderr only, through `_redact_runtime_secrets` which strips every configured
  secret value before printing (`espn_fantasy_server.py:38-58`). Legacy tools still
  return `str(result)` (Python repr) for compatibility (`:2894,2905`); newer ones return
  dicts.

### 3. KBThree13/mcp_espn_ff — Learn from with caution

- **Cr:** clean (tree + 11 commits). `.DS_Store` committed; `.gitignore` has no `.env`.
- **Ck (the caution):** the **only** credential path is the `authenticate(espn_s2, swid)`
  tool (`espn_fantasy_server.py:77-94`): the user pastes both cookies into the chat, so
  they traverse the LLM provider and persist in the conversation log; held in memory
  after that; the league cache key embeds both values (`:45`). No file storage.
- **N:** via #13 only. **O:** none. **I:** none.
- **P:** 8 tools (`authenticate`, `get_league_info`, `get_team_roster`, `get_team_info`,
  `get_player_stats`, `get_league_standings`, `get_matchup_info`, `logout`); no writes.
  Output is `str(dict)` repr (`:119,166,211,259,298,339`).
- **V:** type hints; manual bounds on `team_id`, week hard-coded 1–17 (`:325`).
- **D:** `espn-api>=0.44.1`, `mcp[cli]>=1.5.0` floating; `uv.lock` (30 pkgs, `mcp==1.5.0`)
  → 27 advisories incl. 5 HIGH in `mcp` and CRITICAL `h11`. **L:** MIT.
- **Lg:** `print(..., file=sys.stderr)` helper (`:13`); no values logged.

### 4. gagandaroach/fantasy-yolo — Safe to learn from

- **Cr:** clean (tree + 36 commits; all GUID hits are placeholders or espn-api fixtures).
  `.gitignore` covers `.env*`, `*.cookies`, `secrets.yaml`, `audit.log`.
- **Ck:** manual paste into a JSON credentials file whose path comes from
  `~/.config/fantasy-yolo/config.json` (`config.py:16,48-49`); `load_credentials`
  **refuses a group- or world-readable file** (`creds.py:41-45`); `redact()` scrubs
  espn_s2, braced and unbraced SWID from every string leaving the process
  (`creds.py:53-60`), applied to the audit log (`policy/audit.py:33`). Reads via the
  vendored espn-api (`read/client.py:56-64`, `cookies=` per request), writes via an
  own client to `lm-api-writes` with `max_retries=0` (`write/client.py:24,43-48`);
  `assert_read_host` refuses the write host on the read path (`read/client.py:70-74`).
- **N:** ESPN reads/writes only. `registerdisney.go.com` appears only in commented-out
  legacy username/password code inherited from espn-api (`espn/requests/espn_requests.py:190-209`).
- **O:** none. **I:** none (`uv_build`).
- **P (the model):** 12 read tools, 4 `preview_*` + 4 `execute_*` write tools
  (`tools/moves.py`, `tools/lineup.py`). Preview issues a 4-byte single-use code bound
  to a SHA-256 fingerprint of the exact payload, TTL 600 s, file-backed 0600
  (`policy/tokens.py:26-27,42-70`); execute re-reads the roster, re-plans, and refuses
  if the payload changed (`tools/moves.py:117-149`); UNKNOWN outcome on timeout, never
  retried (`write/client.py:75-86`); writes are **not registered at all** unless the
  config says `write_enabled` (`mcp/server.py:53-60`); annotations `read_only_hint`/
  `destructive_hint` split by tool kind (`:28-39`). The docstring is honest that the
  token does not prove a human read the preview (`policy/tokens.py:11-14`). Audit log:
  intent-before, outcome-after, 0600 (`policy/audit.py`). Untrusted text unlabelled,
  but server `INSTRUCTIONS` forbid inferring news/recency (`mcp/server.py:13-25`).
- **V:** pydantic models throughout (37 `BaseModel`).
- **D:** `mcp>=2.2,<3` (SDK 2.x), `pydantic`, `requests`, `typer`; `uv.lock` (49 pkgs) →
  10 advisories, all `pyjwt==2.13.0`. **L:** MIT; vendored espn-api keeps its MIT
  `LICENSE-espn-api`.
- **Lg:** no `print` in `src/`; caution: the vendored espn-api logger attaches a
  `StreamHandler(sys.stdout)` when `debug=True` (`espn/utils/logger.py:15`) — off by
  default but a latent stdio hazard. Vendored fixtures (9–43 MB JSON) contain real
  member names and GUIDs of the 2015/2018 espn-api test league.

### 5. HamCops/dodi — Learn from with caution

- **Cr:** clean (tree + 32 commits; `.env.example` has a placeholder GUID).
  `HamCops/espn-mcp` is a GitHub redirect to this repo (rename); package name `espn-mcp`
  (a different `dodi` exists on PyPI — unrelated author).
- **Ck:** `ESPN_S2`/`SWID` from env or a `.env` at a **fixed path next to the package**,
  deliberately not the cwd (`config.py:10-13,16-29`); braces normalised (`:114-117`);
  `repr` masks secrets (`:32-36,86-90`); every error message and even `exc.args` are
  scrubbed (`espn.py:79-82,116-124`). Cookies are set as `Secure` cookies scoped to
  `.espn.com` in an `httpx.Cookies` jar (`espn.py:23-35,48-56,66-71`) and
  `host_allowed()` refuses any non-https, non-espn.com URL before a request is made
  (`:100-103`). Writes go to `lm-api-writes` with `X-Fantasy-Source: kona`
  (`:142-160`).
- **N:** declared, opt-in third parties through one allow-listed fetcher with no
  credentials: `api.sleeper.app`, `api.fantasycalc.com`, `site.api.espn.com`,
  `api.open-meteo.com` (`sources/http.py:10-11,44-56`), GitHub release CSVs
  (nflverse) via `fetch_text` (`:20-41`). **ntfy** push (`ntfy.sh` or self-hosted) receives
  proposal titles/summaries and a per-proposal Bearer token in the action buttons
  (`notify.py:16-34,37-58`). `GAMETIME_HOOK` runs a user-configured executable with
  fixed args (`gametime.py:225-246`, no shell).
- **O:** `subprocess.run([hook, …])` as above; `pickle` only in `research/*.py` offline
  scripts. **I:** none (hatchling).
- **P (the cautions):** 30 tools; writes `set_lineup`, `move_player`, `add_player`,
  `drop_player`, `propose_trade`, `respond_to_trade` take `apply: bool = False`
  (`server.py:1149,1594`) — **the model sets the flag**, so one call with `apply=true`
  writes. `ESPN_REQUIRE_APPROVAL` routes roster moves and trades through a sqlite
  proposal queue (0600, `proposals.py:111-120`, `token_urlsafe(32)`) approved from a
  phone via a loopback HTTP service (`approve.py:1-9`), but **lineup changes stay
  direct** (`config.py:48-50`). `ESPN_AUTO_APPLY` lets a policy apply adds/streamer
  swaps/trade offers with **no human** (`autopolicy.py:1-18,29-33`). Draft scripts
  (optional `browser` extra) keep a **persistent logged-in browser profile** in
  `state/browser-profile/` inside the repo dir with default permissions
  (`scripts/live_draft.py:44,281-304`) or attach to the user's own Brave over a CDP
  debugging port (`:379-395`); SWID goes into the draft-room URL query (`:41-42`).
- **V:** FastMCP type hints; cache keys are traversal-tested (`tests/test_sources.py:599`).
- **D:** `mcp[cli]>=2.0.0`, `httpx`, `starlette`, `uvicorn`, `python-multipart` — **no
  lockfile**; direct deps at today's latest: 0 advisories (transitives unknowable).
  **L:** MIT.
- **Lg:** server modules print only hook failures to stderr; CLI scripts print to
  stdout (fine, not the MCP process).

### 6. tlo1216/espn-fantasy-mcp — Safe to learn from

- **Cr:** clean (tree + 10 commits). Fork `caleblwright/espn-fantasy-mcp` is the same
  SHA → skipped.
- **Ck:** own `.env` parser; path is `ESPN_MCP_ENV` or **`.env` relative to cwd**
  (`src/env.ts:40-42`); cookies assembled into a `Cookie` header (`src/espn/client.ts:19-22`)
  sent to `lm-api-reads`/`lm-api-writes` only (`:6-7,78,111`); writes add
  `X-Fantasy-Source: kona`, `X-Fantasy-Platform`, `Origin`, `Referer` (`:112-119`). 401
  message tells the user "Do not paste them into chat" (`:24-31`). `memberId` (= SWID) is
  redacted from every write result and log line (`:137-164`).
- **N:** ESPN only. **O:** none. **I:** none (`scripts`: build/start/dev/test).
- **P:** 11 read tools + 6 write tools (`set_lineup`, `add_free_agent`, `waiver_claim`,
  `cancel_claim`, `move_to_ir`, `activate_from_ir`), every write `dry_run: true` by
  default and **the model flips it** (`src/index.ts:442-566`); global `WRITES_ENABLED`
  env gate, default off (`src/env.ts:51`); annotations on every tool. Writes are never
  retried; reads retried once on network error only (`client.ts:73-89`); serial limiter
  2/s reads, 1 per 5 s writes (`:33-58`). Non-401 error text embeds up to 300 chars of
  the upstream body (`:63-69`). Write log `logs/writes.jsonl` is **cwd-relative**
  (`:188-190`), gitignored.
- **V:** zod v3 input **and output** schemas for all 17 tools.
- **D:** `@modelcontextprotocol/sdk ^1.12.0`, `zod ^3.23.8` (floating carets) with
  lockfile → 2 MODERATE (transitive `fast-uri`, `ip-address`). **L:** MIT.
- **Lg:** `console.error` only (`src/index.ts:595-601`).

### 7. i-am-david-weinstein/espn-fantasy-mcp — Learn from with caution

- **Cr:** clean (tree + 37 commits; monkeypatched test strings only).
- **Ck:** env `ESPN_S2`/`ESPN_SWID` (+`python-dotenv`); `unquote()` applied to
  `espn_s2` so encoded or decoded pastes both work (`espn_client.py:42-46`); cookies
  passed per-request to `lm-api-writes` (`:90-93`, `requests.post` **without a
  timeout**). `smithery.yaml` defines a hosted-install path where both cookies become
  Smithery-side config (`smithery.yaml:3-14`). Published to PyPI as `espn-fantasy-mcp`.
- **N:** ESPN only (reads via #13). **O:** none. **I:** none.
- **P:** 16 tools; 9 writes (`modify_lineup`, `add_free_agent`, `drop_player`,
  `claim_waiver`, `cancel_waiver`, `propose_trade`, `cancel_trade`, `accept_trade`,
  `decline_trade`) with a `confirm: bool = False` preview step (`server.py:133-143`) —
  a model-set flag, no token binding. Note: this is a fantasy **baseball** server
  (`README.md:8`, `server.py:1`); the ESPN transaction envelope and cookie code are
  sport-generic, which is why it is kept.
- **V:** FastMCP type hints; roster membership checks before drops
  (`transaction_tools.py:205-215`).
- **D:** `fastmcp>=2.0.0` (the third-party FastMCP 2.x, not the SDK), `espn-api>=0.30.0`,
  `python-dotenv`, `rapidfuzz` — **no lockfile**; direct deps at latest: 0 advisories.
  **L:** MIT.
- **Lg:** `logging.basicConfig` in `__main__` (stderr by default); JSON output.

### 8. rrichardtang/ESPN-fantasy-mcp — Learn from with caution

- **Cr:** clean (11 commits; test SWID is a placeholder, `test_server.py:24`).
- **Ck:** env `ESPN_S2`/`SWID` (`server.py:26-27`) → #13. `deploy.sh` prompts with
  `read -rs` (hidden), writes both cookies to a temp env-vars file and ships them to
  **Google Cloud Run** as service env vars (`deploy.sh:21-33`); the service is
  `--allow-unauthenticated` and protected only by a `MCP_SECRET` embedded in the URL
  path (`:36-44`). This is a remote-hosting design, not a local one.
- **N:** ESPN via #13; Google Cloud at deploy time. **O:** none. **I:** none.
- **P:** 9 read tools with `ToolAnnotations(read_only_hint=True)`, JSON output, ESPN
  errors surfaced as `ToolError` (`server.py:56-70`); league reloaded at most once a
  minute (`:44-51`). No writes. **V:** pydantic `Field` annotations.
- **D:** pinned `espn-api==0.46.0`, `mcp==2.2.0`, `uvicorn==0.54.0` → 0 advisories (direct).
  **L: none** — all rights reserved; ideas may be learned from, nothing may be reused.
- **Lg:** none in the server path.

### 9. saik0v0ur/espn-fantasy-mcp — Learn from with caution

- **Cr:** clean (2 commits).
- **Ck:** env `ESPN_S2`/`ESPN_SWID`, or per-league `s2`/`swid` inside an `ESPN_LEAGUES`
  JSON env var (`server.py:153-182`); `Cookie` header to `lm-api-reads` only
  (`:214-235`); 60 s response cache keyed by alias+url+params (`:238-244`).
- **N:** ESPN only. **O/I:** none.
- **P:** 13 read tools (`list_leagues` … `find_trade_targets`); no writes. Error text
  echoes ≤300 chars of upstream body (`:268`). **V:** type hints.
- **D:** `mcp>=1.2.0`, `httpx>=0.27.0` — no lockfile; 0 advisories at latest.
  **L: none.** **Lg:** none.

### 12. JayMishra-source/Fantasy-Football-AI-CoManager — Do not use

- **O — disqualifiers:** `eval(p.condition.replace(...))` on data
  (`fantasy-engine/shared/src/tools/aiWorkflowOrchestrator.ts:287`); runtime
  `spawn('npx', ['@oevortex/ddg_search'])` — downloads and executes a third-party
  package at run time (`fantasy-engine/shared/src/services/webSearchLLM.ts:148`).
- **N:** LLM sinks OpenAI, Anthropic, Gemini, Perplexity (`mcp-server/src/services/llm/providers/*`),
  Slack/Discord webhooks, Pushover, scrapingdog, serper, newsapi, fantasydata,
  DuckDuckGo — roster data leaves the host by design; GitHub Actions workflows run the
  system with `ESPN_S2`/`ESPN_SWID` as repo secrets (5 workflow files).
- **Ck:** `get-claude-config.sh:38-47` echoes cookie values into a client config.
  **I:** `prepare: npm run build` (`mcp-server/temp_artifacts/package.json`).
- **Cr:** no cookie values in history (the GUID hits were bare UUIDs); committed
  tool-output captures of the author's own league (`mcp-server/league1_roster.json`
  etc.). **D:** lockfile → 9 advisories (5 HIGH incl. `@modelcontextprotocol/sdk ≤1.25.3`).
  **L:** none.

### 13. cwendt94/espn-api — Learn from with caution (the dominant wrapper)

- **Cr — historical leak:** commit `643feca` (2020-09-11, "…basketball…") added a
  top-level scratch file `transactions.py` containing two real `espn_s2='[redacted]'`
  and `swid='[redacted]'` literals for two leagues (diff lines 21–23). The file is not
  in HEAD. Both are ESPN session cookies (they expire in roughly a year): **treat as
  compromised and long expired**; no rotation is possible beyond ESPN's own expiry.
  Current tree: clean.
- **Ck:** library takes `espn_s2`/`swid` as constructor args (`base_league.py:24-38`) and
  passes them per request via `requests` `cookies=` (`requests/espn_requests.py:68-73,108,127,138`)
  to `lm-api-reads.fantasy.espn.com` (`requests/constant.py:1`) and the news host
  `site.api.espn.com` (`:2`). No persistence. Username/password login was removed
  (`bda5ad7`, 2022) and remains only as commented code.
- **N:** the two ESPN hosts above; `g.espncdn.com` for images. **O:** none.
  **I:** `setup.py` has no custom commands.
- **P/V:** library, not a server; raises typed errors (`ESPNAccessDenied`,
  `ESPNInvalidLeague`, `ESPNUnknownError`, `:8-17`), 401 handling retries the
  alternate endpoint once (`:55-90`).
- **D:** `requests`, `urllib3`, `idna` pinned to narrow ranges; `uv.lock` (27 pkgs) →
  **0 advisories**. **L:** MIT.
- **Lg — caution:** `Logger` attaches `StreamHandler(sys.stdout)` (`utils/logger.py:17`)
  and, at DEBUG, logs URL, params, headers and the full response body (`:32`); cookies
  are not in `headers` (sent via `cookies=`), but any server that wraps this library
  with `debug=True` writes to stdout and breaks stdio. Test fixtures carry real member
  names and GUIDs of a 2015/2018 league.

### 14. mkreiser/ESPN-Fantasy-Football-API — Safe to learn from

- **Cr:** clean (tree + 500 commits; GUIDs are test fixtures). CI integration tests use
  GitHub secrets (`.github/workflows/ci.yml:85`).
- **Ck:** `Client({ espnS2, SWID })`, `Cookie` header built in `src/client/client.js:361-362`;
  only host `lm-api-reads.fantasy.espn.com`; no persistence, no writes.
- **N:** ESPN only. **O/I:** none (webpack build; no install hooks).
- **D:** `axios ^1.6.0`, `lodash ^4.17.21` + lockfile → 33 advisories, **29 dev-only**
  (jsdoc/babel/webpack chain); runtime: `axios` HIGH, `lodash` HIGH, `form-data`
  CRITICAL, `follow-redirects` MODERATE — an idle project (21 months).
- **L:** **LGPL-3.0** — fine to read and learn from; would constrain us only if code were
  copied or linked, which we do not do.
- **Lg:** none in library code.

### 15. eponerine/espn-fantasy-football-api-node — Learn from with caution

- **Cr:** clean (8 commits). **L:** MIT (repo), `license: null` in package.json.
- **Ck (the cautions):** the Express wrapper accepts `espnS2`/`swid` as **URL query
  parameters** (`src/api/server.js:80-81`, `src/api/openapi.js:32-39`) — cookies land in
  access logs and browser history; the debug logger prints the merged request headers
  **including the `Cookie` header** (`src/requests/espnFantasyRequests.js:69-71,121`,
  `src/utils/logger.js:12`).
- **N:** `lm-api-reads`, `site.api.espn.com`. **O/I:** none. **P:** read-only REST.
- **D:** `express ^4.21.2`, `swagger-ui-express` + lockfile → **0 advisories**.

### 16. Possardt/espn-ff-api — Do not use

- Targets the retired v2 API at **`http://games.espn.com`** and sets both cookies on a
  plain-HTTP URL (`espn-request.js:9-20`). Deprecated `request`/`request-promise`
  stack: 17 advisories (6 CRITICAL, 5 HIGH), all runtime. No `LICENSE` file (package.json
  says ISC). Unmaintained since 2018. `ryanpag3/espn-ff-api-2` is its fork (+2/−3) and
  is skipped for the same reasons.

### 17. ryanjadhav/espn-fantasy — Safe to learn from

- Zero-dependency Python (`urllib`); cookies read from `~/.config/espn/cookies.json`
  (`bin/espn_api.py:92-99`); README says "chmod 600" but **the code does not check the
  mode** (no `stat` call). Reads `lm-api-reads`, writes `lm-api-writes` via
  `bin/espn_txn.py` with `--dry-run`; a `SKILL.md` describes the CLI for agents.
  Credentials clean (2 commits). MIT. Prints to stdout — it is a CLI, not a server.

### 18. stmorse/espn_ff — Safe to learn from

- Analysis library (pandas/matplotlib). Cookies from `config.ini` (gitignored) or env
  (`espn_ff/config.py:52-59`), `requests` `cookies=` to `lm-api-reads` only
  (`espn_ff/espn.py:101`); JSON file cache under `.cache/` (`:126`). Reads only. Clean.
  MIT. No lockfile; direct deps at latest: 0 advisories.

### 19. ffverse/ffscrapr — ESPN adapter (sibling verdict: Safe)

- `espn_connect(swid=, espn_s2=)` takes the cookies as arguments (README pattern reads
  them from `Sys.getenv`), builds an `httr` cookie set (`R/espn_connect.R:66-81`), and
  every ESPN call goes to `lm-api-reads.fantasy.espn.com` only. No persistence, no
  writes, no other hosts in `R/espn_*.R`. MIT. Shallow clone — history not checked here
  (same as the sibling).

### 23. darkonda/espn-cookies — Do not use (what it does, plainly)

A Next.js page with a username/password form; the server route launches **Puppeteer**,
logs into ESPN with those credentials, loops through an OTP prompt up to three times
(`app/api/login-espn/route.ts:157,460`), reads the `SWID` and `espn_s2` cookies from the
browser (`:513-525`), **writes a session dump to disk** (`:106`), returns both values to
the page which renders them (`app/page.tsx:164-165,309`), and has a
`debug-screenshots` route. It exists to hand ESPN account credentials to a server
process. 12 runtime advisories (2 CRITICAL). No license. One commit.

### 24. shulman33/true-champion-extension — Do not use for our purposes

A Chrome MV3 extension that reads `espn_s2` and `SWID` with `chrome.cookies.get`
(`src/popup.ts:20-21`, `src/connect.ts:83`), waits for a real login if they are absent
(`src/background.ts:85-89`), and **POSTs both to `www.truechampion.app`** with a
connect token (`src/connect.ts:86-90`). It is a consensual "connect my league" flow for
that SaaS and even tests its origin checks against `evil.example`; for a local tool it
is the pattern to avoid: an extension is a cookie-exfiltration channel by construction.
MIT. Clean. 2 dev-only advisories (vitest).

### 28. jwulff/fantasy-sports — Safe to learn from (CLI, not an MCP server)

- **Cr:** clean (tree + 119 commits). The three history hits for "espn_s2 value-shaped"
  strings are `FAKE_ESPN_S2` test constants; every GUID in `docs/samples/` and
  `tests/cassettes/` is `{SWID-REDACTED}` or a `{00000000-…}` pseudonym produced by the
  scrub hook; the write-surface research JSON carries `memberId: {SWID-REDACTED…}` and
  `id: <uuid>` only.
- **Ck (the model to copy):** credential chain **env → macOS Keychain (`keyring`) →
  XDG `config.toml` `[credentials]`**, each link failing soft (`src/fantasy_sports/auth/chain.py:1-30`);
  `auth login` (paste) / `auth logout`; the config rewrite is atomic and keeps the file's
  mode (`config/credentials.py:101-118`); XDG dirs forced on every platform
  (`config/paths.py`). Values travel in a `Secret` carrier that redacts itself in
  `repr`/`str`/`format`; every `FantasySportsError` scrubs its message at construction;
  pattern-based scrubbing pseudonymises **other members'** SWIDs before the HTTP cache is
  written to SQLite and before cassettes are saved (`core/redaction.py:1-45`). Cookies go
  to `lm-api-reads` via `requests` `cookies=`; the cache key keeps only `x-fantasy-filter`
  and never the `Cookie` header (`providers/espn.py:850-861`).
- **N:** `lm-api-reads`, `site.api.espn.com`; `lm-api-writes` appears **only** in
  `docs/research/05-espn-write-surface/` (23 captured probes, 2026-09-12: no-cookies,
  SWID-only, espn_s2-only, swap without memberId, other-team swap, `executionType`
  VALIDATE, locked players, scoring-period edge cases) — **zero write code in `src/`**.
- **O:** `subprocess` only in dev scripts (`gh`, `uv build`). **I:** none (hatchling).
- **P:** output envelope reserves an `untrusted` container (`output/envelope.py:13,220`)
  and `output/untrusted.py` renders ESPN free text as an *indented* markdown block so a
  hostile team name cannot close a fence (ADR-0007). `raw` is an explicit passthrough
  that requires `--view` and is host-pinned (`commands/raw.py`).
- **V:** typed models (`core/models.py`); honest error classification (ESPN 401 "tells
  you nothing", `docs/memory/`).
- **D:** `espn-api`, `typer`, `requests`, `keyring`, `tomli-w`; `uv.lock` (41 pkgs) → 6
  advisories, all `urllib3==2.2.3` (4 HIGH, 2 MODERATE). **L:** MIT.
- **Lg:** CLI prints; `doctor`, health manifest and a canary workflow that files drift
  issues via `gh` (`scripts/canary/`).

### 29. DanielTomaro13/sportsdata-mcp — Learn from with caution

- **Cr:** clean (tree + 259 commits; the only GUID in docs is an all-letters
  placeholder, `documentation/ESPNFantasy.md:63`). `.mcp.json` is a benign `uvx` launch
  entry.
- **Ck (what it does, plainly):** `ESPN_FANTASY_COOKIE` env holds the raw `Cookie`
  header string (`espn_s2=…; SWID=…`) and the spec's `static_header` auth attaches it
  only to the espnfantasy provider's base URLs (`auth/header.py`,
  `specs/espnfantasy.yaml:42-49`). The `connect espnfantasy` wizard **reads the Chrome-
  family cookie database directly** (`~/Library/Application Support/{Chrome,Brave,Edge,
  Vivaldi}/*/Cookies`, every profile), derives the AES key from the "Chrome Safe Storage"
  Keychain item via `security find-generic-password` + PBKDF2, decrypts `v10` values
  (`src/sportsdata_mcp/connect.py:131-210`), restricts itself to the one host named in
  the spec, verifies the cookie with a real call before saving, never prints a value,
  writes `~/.sportsdata-mcp/….yaml` 0600 in a 0700 dir, and offers `--manual` paste
  (`connect.py:1-38`). This is the brief's "browser cookie DB reader" category done as
  carefully as it can be — and it is still a process reading the browser's credential
  store, gated by one Keychain prompt.
- **N:** 64 providers (bookmakers, leagues, data vendors); a root-logger filter redacts
  every declared secret value from all logs including httpx URL logging (`redact.py`).
  Telemetry is local-only unless **both** `SPORTSDATA_TELEMETRY=1` and an endpoint env
  var are set; no default endpoint; tool names only, never arguments
  (`telemetry.py:1-40,209-220`). OTA spec updates fetch an Ed25519-signed bundle only on
  explicit `update-specs` (`ota.py:1-18`); dev builds without a baked key accept
  unsigned bundles with a warning. Opt-in licence gate fetches an entitlement from
  `sportsdata-entitlement.sportsdata.workers.dev` (`licence.py:35`). `follow_redirects=True`
  with a per-provider `strip_cookies` option (`http_client.py:133,153,285`).
- **O:** `subprocess` for `security` and `gh`; base64 only for signatures. **I:** none.
- **P:** ESPN fantasy: 27 read tools (five sports) plus 2 write ops (set lineup; add/drop
  or waiver claim) in an `espnfantasy.write` group excluded from `*`/`all`
  (`specs/espnfantasy.yaml:551-612`); tool annotations and a short-lived GET cache.
- **V:** pydantic spec schema; DoH transport opt-in per provider.
- **D:** `fastmcp>=0.4,<4` (third-party FastMCP, a four-major floating range),
  `httpx`, `pydantic`, `pyyaml`, `click`, `graphql-core` — **no lockfile**; direct deps at
  latest: 0 advisories. **L:** MIT (plus a commercial licence tier).
- **Lg:** logging with the redaction filter; prints only in scripts.

### Multi-platform servers from the sibling audit

`carterfawson/fantasy-football-mcp`, `kYpranite/fantasy-football-mcp-public`,
`andrewrgoss/fantasy-football-mcp`, `MichaelCrowcroft/fantasy-football-mcp`: `gh search
code espn` → 0 hits. `derekrbreese/fantasy-football-mcp-public`: hits only in
`src/utils/roster_configs.py`, `src/utils/constants.py`, `docs/BYE_WEEKS_FIX.md`
(roster-slot constants), no `espn_s2`/`SWID` anywhere. None handles ESPN cookies; the
sibling's "Do not use" verdicts stand unchanged.

---

## Rejected list (with the disqualifier)

| Repo | Reason |
|---|---|
| JayMishra-source/Fantasy-Football-AI-CoManager | `eval` on data; runtime `npx` package execution; undeclared LLM and webhook sinks; cookies echoed into config by a script; no license |
| Possardt/espn-ff-api (+ ryanpag3 fork) | dead `games.espn.com` API over plain HTTP with cookies; 17 runtime advisories; no license file; 8 years idle |
| darkonda/espn-cookies | automated username/password (+OTP) login through a server; cookie dumps written to disk and rendered in a page; no license |
| shulman33/true-champion-extension | ships the ESPN session to a third-party host by design |
| carterfawson, derekrbreese, kYpranite, andrewrgoss, MichaelCrowcroft | sibling verdicts (leaked history / proxy to third-party host); no ESPN support to add |

Skipped by name: anthtogs/mcp_espn_ff (identical fork), jlumba79/mcp_espn_ff (fork,
+2 trivial commits), caleblwright/espn-fantasy-mcp (identical fork),
ryanpag3/espn-ff-api-2 (fork of a rejected repo), ktrann24/espn-fantasy-mcp
(basketball, read-only, 1 commit — credentials clean), noahking0207-hash/espn-fantasy-mcp2
and -mcp3 (uploaded single files), rbarton65/espnff (dead v2 API, 2017),
pdroll/ESPN-Fantasy-Football-Scraper (2015 scraper, no cookie code),
jpmayer/fantasy-chrome-extension (page-UI extension, no cookie extraction),
dtcarls/fantasy_football_chat_bot (GPL chat bot; cookie sourcing is env-only),
pseudo-r/Public-ESPN-Fantasy-API (documentation; pointer in 02 §6).

**Credentials: clean** (tree and full history) by name: mdanaher1/espn-ff-mcp,
mpsthedude (tree; history squashed), KBThree13/mcp_espn_ff, gagandaroach/fantasy-yolo,
HamCops/dodi, tlo1216/espn-fantasy-mcp, i-am-david-weinstein/espn-fantasy-mcp,
rrichardtang/ESPN-fantasy-mcp, saik0v0ur/espn-fantasy-mcp, ktrann24/espn-fantasy-mcp,
JayMishra-source (no cookie values), mkreiser/ESPN-Fantasy-Football-API,
eponerine/espn-fantasy-football-api-node, Possardt/espn-ff-api, ryanjadhav/espn-fantasy,
stmorse/espn_ff, rbarton65/espnff, dtcarls/fantasy_football_chat_bot,
pseudo-r/Public-ESPN-Fantasy-API, darkonda/espn-cookies, shulman33/true-champion-extension,
pdroll, jpmayer, jwulff/fantasy-sports, DanielTomaro13/sportsdata-mcp. **Not clean:** cwendt94/espn-api (2020 history, expired session
cookies, see #13).

---

## Dependency audit — counts by severity

Node (`npm audit --package-lock-only --ignore-scripts`, 2026-09-30):

| Repo | total | critical | high | moderate | low | notes |
|---|---|---|---|---|---|---|
| tlo1216/espn-fantasy-mcp | 2 | 0 | 0 | 2 | 0 | transitive `fast-uri`, `ip-address`; 0 dev-only |
| mkreiser/ESPN-Fantasy-Football-API | 33 | 3 | 19 | 9 | 2 | 29 dev-only (jsdoc/babel/webpack); runtime: axios H, lodash H, form-data C, follow-redirects M |
| eponerine/espn-fantasy-football-api-node | 0 | 0 | 0 | 0 | 0 | |
| Possardt/espn-ff-api | 17 | 6 | 5 | 6 | 0 | all runtime (`request` stack) |
| darkonda/espn-cookies | 12 | 2 | 10 | 0 | 0 | all runtime (next, puppeteer) |
| shulman33/true-champion-extension | 2 | 0 | 0 | 2 | 0 | both dev-only (vitest) |
| JayMishra …/fantasy-engine/mcp-server | 9 | 0 | 5 | 4 | 0 | `@modelcontextprotocol/sdk ≤1.25.3` HIGH, axios HIGH |

Python with `uv.lock` (OSV `querybatch`, advisories de-duplicated by CVE; counts
include dev groups):

| Repo | lock pkgs | vulnerable pkgs | advisories | critical | high | moderate | low | unrated | main sources |
|---|---|---|---|---|---|---|---|---|---|
| mdanaher1/espn-ff-mcp | 53 | 12 | 32 | 1 | 14 | 10 | 5 | 2 | mcp 1.14.0 (3 H), python-multipart (7), starlette (6), urllib3 (6), anyio (C), black (dev) |
| KBThree13/mcp_espn_ff | 30 | 10 | 27 | 2 | 12 | 10 | 2 | 1 | mcp 1.5.0 (5 H), h11 (C), anyio (C), starlette (7), urllib3 (6) |
| mpsthedude/ESPN-Fantasy-Football-MCP | 42 | 4 | 14 | 2 | 5 | 5 | 1 | 1 | pyjwt 2.13.0 (10, via `mcp[cli]`), anyio (C) |
| gagandaroach/fantasy-yolo | 49 | 1 | 10 | 1 | 5 | 4 | 0 | 0 | pyjwt 2.13.0 only |
| ktrann24/espn-fantasy-mcp | 44 | 13 | 45 | 2 | 17 | 18 | 7 | 1 | pyjwt, cryptography, mcp 1.26.0, python-multipart, starlette, urllib3 |
| cwendt94/espn-api | 27 | 0 | **0** | 0 | 0 | 0 | 0 | 0 | |
| jwulff/fantasy-sports | 41 | 1 | 6 | 0 | 4 | 2 | 0 | 0 | urllib3 2.2.3 only |

Python without a lockfile (direct dependencies only; transitive resolution is not
possible statically): rrichardtang (pinned `espn-api==0.46.0`, `mcp==2.2.0`,
`uvicorn==0.54.0`) 0; HamCops/dodi (6 direct at latest) 0; i-am-david-weinstein (4) 0;
saik0v0ur (2) 0; stmorse (5) 0; noahking0207-hash (3) 0; sportsdata-mcp (6) 0.

Two patterns recur: (a) every server that pins or locks an MCP Python SDK **1.x** carries
3–5 HIGH advisories in `mcp` itself (DNS-rebinding/Origin checks on HTTP transports,
unverified session requests); only the SDK-2.x repos (fantasy-yolo, dodi, rrichardtang)
are clear of them; (b) `mcp[cli]` drags `pyjwt` into stdio servers that never verify a
JWT, and `pyjwt 2.13.0` carries 10 advisories (1 CRITICAL). Typosquat check: every
dependency name in the manifests above resolves to the expected upstream project on
PyPI/npm (`espn-api` → cwendt94, `espn-fantasy-football-api` → mkreiser,
`espn-fantasy-mcp` → i-am-david-weinstein); no look-alike names found.

---

## What could not be verified statically

- **cwendt94/espn-api**: whether the 2020 session cookies in commit `643feca` are still
  valid (not tested — never tested; assumed expired by ESPN's ~1-year cookie lifetime).
- **mpsthedude**: anything before the 4 squashed commits; runtime behaviour of the
  10.8k-line server (only the transport, session, redaction, annotations and tool
  registrations were read line by line).
- **HamCops/dodi**: whether `follow_redirects=True` could ever carry the `.espn.com`
  Secure cookies off-host in practice (the jar scoping says no); the exact contents of
  ntfy notifications at run time; what the persistent Playwright profile stores on
  disk (Chromium profile format, not inspected).
- **fantasy-yolo / cwendt94**: whether `requests` forwards per-call `cookies=` on a
  cross-host redirect from ESPN (library behaviour, not exercised).
- **tlo1216 / eponerine / saik0v0ur**: whether ESPN error bodies echoed into error text
  (≤300 chars) can contain the SWID — ESPN's transaction responses do echo `memberId`
  (tlo1216 redacts it; the other two do not send writes).
- **Chrome Web Store "ESPN Private League Setup"** (id `bjmalaafoepfooflcnhjejnopgefjgia`,
  recommended by mdanaher1's README): no public source; not inspected; must be treated
  as an unknown cookie-reading extension.
- **Lockfile-less repos** (dodi, weinstein, saik0v0ur, stmorse, noahking): transitive
  dependency trees and therefore the true advisory count.
- **sportsdata-mcp**: the Chrome cookie-DB decryption path and the OTA/licence fetches
  were read, not run; which Chrome profile it would pick on a given machine; whether
  `strip_cookies` defaults protect the ESPN cookie across a redirect.
- **jwulff/fantasy-sports**: the Keychain link of the auth chain is macOS-only and was
  not exercised; the write-surface captures are the author's, dated 2026-09-12.
- **Any runtime property** (rate limits, actual ESPN acceptance of the captured write
  headers, cache correctness): nothing was executed.
