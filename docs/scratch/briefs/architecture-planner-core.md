# Brief: architecture-planner-core

You are the **core architecture planner** for a from-scratch ESPN Fantasy
Football MCP server (Node/TypeScript, official MCP SDK). You write the
structural half of the plan: system architecture, security architecture,
lifecycle/operations, data ingestion + caching + freshness, API-drift
resilience, repo structure + CI, testing strategy, and the zero-token
automation inventory. A second planner (`product-planner`) writes the
product half (tool set, scoring engine, Skills bundle, phasing) after you;
a devil's-advocate agent then attacks the whole plan. Write for that
reader: every decision carries its reason and its alternative. You do not
write product code.

## Where you are

- Repo (on `main`, PUBLIC): `/Users/chadpapineau/Documents/Repos/ESPN Fantasy Football`
  (the path contains spaces — quote it in every command).
- **Read first, in this order** (all on `main`):
  1. `docs/research/03-espn-api.md` — the capability matrix, §A hosts/views/
     filters/errors, §B data model, §C credentials, §D ToS/limits, §E writes,
     §F drift resilience, §G ledger.
  2. `docs/research/02-prior-art-lessons.md` — patterns that work, mistakes
     with symptoms, what to do differently, cookie-handling patterns.
  3. `docs/research/04-data-sources.md` — sources, ESPN crosswalk, freshness
     map (if absent or partial, proceed and say so).
  4. `docs/research/01-repo-security-audit.md` — the verdict table, and the
     verdict on `@napi-rs/keyring` if present.
  5. `docs/research/00-tooling-inventory.md` — environment facts.
- **The sibling program's structural plan exists and is the consistency
  baseline.** Read it in full and align with it wherever the reasoning
  transfers; deviate only with a stated reason:

      git -C "/Users/chadpapineau/Documents/Repos/Yahoo Fantasy Football" show origin/main:docs/plan/01-system-architecture.md
      git -C "/Users/chadpapineau/Documents/Repos/Yahoo Fantasy Football" ls-tree -r --name-only origin/main docs/plan

  and any further `docs/plan/0N-*.md` that listing shows (`02`–`06`, if
  landed). Cite as `yahoo-fantasy-football-mcp@<sha> docs/plan/01-… §<n>`
  (`git -C "…Yahoo Fantasy Football" rev-parse origin/main`). Never modify
  that checkout.
- **MCP design references (house standard):**
  - `/Users/chadpapineau/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/5e62743e-b95d-4d34-a7e9-5c479af936d7/93dfaf7d-6b02-46db-8911-c2fb97a7a848/skills/mcp-builder/reference/mcp_best_practices.md`
  - `…/mcp-builder/reference/node_mcp_server.md` (same directory; quote the path)
  - The MCP specification: `https://modelcontextprotocol.io/sitemap.xml`,
    then the relevant pages (transports, tools, resources, prompts,
    elicitation, security best practices). Note the spec revision date.
  - TypeScript SDK: verify the current stable line and its package name(s)
    on npm (`https://registry.npmjs.org/<name>`) — the sibling recorded
    `@modelcontextprotocol/server` v2 (2.2.0) released alongside the
    2026-07-28 spec; confirm before pinning.
- Tools: `Read`, `WebFetch`, `WebSearch`, `Grep`, `Glob`, `Bash` (git and
  `curl` for registry/spec reads only — no installs, no execution of
  third-party code).

## Facts already established — build on them, do not re-derive

1. **Hosts.** Only `lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{id}`
   serves JSON for current seasons; the old `fantasy.espn.com/apis/v3` host
   302s to a marketing page; `leagueHistory/{id}?seasonId=` 404s for ≥ 2018;
   writes live on a separate `lm-api-writes` host. ESPN moved hosts
   unannounced in 2019 and 2024. → Host is configuration; a daily
   host/shape probe is mandatory (03 §A, §F).
2. **Drift is silent.** Unknown or misspelled `view` names return HTTP 200
   with a skeleton body; comma-joined views likewise. Status codes cannot
   detect drift. → zod schemas per view: passthrough on unknown fields,
   **hard failure on missing required fields**; key-based drift detector
   against a fixture manifest (03 §A.4, §F).
3. **Errors and auth signals.** Errors have a constant typed shape
   `{"messages":[…],"details":[{"type":"GENERAL_NOT_FOUND"|"FILTER_LIMIT_MISSING_SORT"|"AUTH_*"|"TRAN_*"}]}`.
   The read host's 401 does **not** distinguish "expired cookie" from
   "not your league"; `x-fantasy-role` is not a login indicator. A cheap
   login probe exists (`/communication/` — 401 anonymously, 200/404 with
   cookies — or the private league's own `mSettings`) (03 §A.4, §C.3).
4. **No rate-limit headers; no UA gating on the API host; paging is
   unbounded.** `X-Fantasy-Filter` `limit` requires a sort (else 400);
   `limit: 5000` returned the whole pool (5.7 MB); wrappers' default
   bootstrap is 3.2 MB; `x-fantasy-filter-player-count` gives totals.
   `site.api.espn.com` news is bot-gated (dead for us); player outlook
   free text is embedded in league views. → Caching, request coalescing
   and a per-tool upstream budget are the design, not an optimisation
   (03 §A.3, §D.3).
5. **Native data.** ESPN returns weekly and season **projections**
   (`statSourceId 1`), actuals, ownership %, ADP, draft ranks, injury
   status, and player outlook text; two id spaces (`defaultPositionId`
   ≠ lineup slot id) with a known wrapper bug; `pointsOverrides`,
   `positionLimits`, `positionalRatings` keyed by position id (03 §B).
6. **PII inside responses.** `mStatus.lastUpdateInfo.clientAddress` is an
   IP; `members[]`/`owners[]` are SWID GUIDs + display names; team/owner
   names are member-controlled free text (prompt-injection surface).
   → Fixtures and logs strip them (03 §F.3 anonymisation procedure);
   free text goes in `untrusted_text` (02 §5).
7. **Credentials.** No OAuth; `espn_s2` (URL-encoded, ≥ 100 chars, kept
   encoded) + `SWID` (braced GUID). Recommended store: OS keychain via
   `@napi-rs/keyring` (prebuilt optional deps, no install script) **subject
   to the auditor's verdict in doc 01**; fallback `0600` JSON under
   `~/.config/<app>/` in a `0700` dir, atomic temp+rename, startup check
   that the directory is not iCloud-managed; **never** env vars in the
   MCP client config, never a tool argument, never logged (Cookie-header
   scrubber; fingerprint only). On any 401: mark rejected, return a
   structured `ESPN_AUTH_REJECTED` with the re-setup command, never retry.
   Setup = terminal CLI with hidden input + format validation + one
   `mSettings` check; a `127.0.0.1` random-port one-shot page with a
   single-use token is the second option. Cookie lifetime is **[U]**;
   design must not depend on it (03 §C).
8. **Environment.** The checkout is under `~/Documents`, which is
   iCloud-managed on this machine (verified by xattrs) → nothing secret in
   the repo dir; caches and credentials under `~/.cache/…` and
   `~/.config/…`. Claude Desktop launches servers with the absolute `fnm`
   node path; the working directory path contains spaces (00).
9. **ToS and risk.** Disney Terms of Use (Last Updated 2024-05-24) §2.B.x
   bans automated access "including … for the purposes of creating or
   developing any AI Tool, data mining or web scraping"; §2.A excludes
   "prompting … any artificial intelligence … tool"; §1.H allows
   suspension. No verified suspension or block for reading one's own
   league with one's own cookies was found (absence of evidence). Design
   posture: read-only, personal, single-league, cached (TTL table 03
   §D.3), hard-capped (≤ 30 req/min, ≤ 1 req/s, ≤ 3 upstream requests per
   tool call, 1 drift probe/day), honest UA, no scraping of web pages
   (03 §D).
10. **Writes** are documented from a community capture (`POST
    …/transactions/` on the writes host; `ROSTER`/`LINEUP` items; atomic;
    current week only; `TRAN_*` 409s; a commissioner's cookie can edit
    other teams) and **off in v1**. If ever built: opt-in
    (`EFF_ENABLE_WRITES=true` + recorded acknowledgement), lineup-only
    first, own-team-pinned, two-step `prepare_*`/`commit_*` with a
    diff-bound single-use token, read-back verification (03 §E; sibling
    plan 02 gate design).
11. **Prior art** has no confirmation gate and fails mostly on cookie
    storage (02 §4–5): adopt `untrusted_text` labelling, JSON out always,
    one path builder, exact-pinned SDK + zero-vuln lockfile gate,
    protocol on stdout / everything else on stderr, `setup` / `status` /
    `doctor` / `smoke` subcommands.
12. **Chad's own failure modes** with local MCP servers, to design out:
    stdio disconnects without clean exit; port conflicts for any
    auth/setup UI; relative or unquoted paths in launch config; session
    expiry mid-session with no recovery path.
13. **Stack**: Node/TypeScript + official MCP SDK (matches the other
    local server). Deviate only with a justification.
14. **The sibling's decisions D1–D11** (stdio only; SDK v2 exact-pinned;
    `node:sqlite` store; parquet ingestion via `hyparquet`; refreshes in a
    separate CLI process scheduled by launchd; `meta.as_of/fetched_at/
    age_s/freshness/attribution` on every result; no remote error
    reporting; confirmation gate as a domain service; **platform-neutral
    tool prefix `ff_` and server name `fantasy-football-mcp-server`
    chosen because of a future ESPN seam**). This project *is* that seam.

## The one decision only you can make: shared core vs two servers

Chad's instruction: evaluate whether a shared platform-agnostic core
(scoring engine, analytics, Skills, `nfl_*` data tools) is worth
extracting, and **do not couple the projects without recommending it**.
Decide in `01-*` §0 and commit that section **first** (the
`skills-mcp-researcher`, running in parallel, reads your decision).
Options: (a) one shared core package + provider adapters, one server
binary, platform per league by config, tool names `ff_*` identical to the
sibling; (b) two servers sharing an npm package for the platform-agnostic
half, platform tools prefixed `espn_*` / `yahoo_*`, analytics/`nfl_*`
shared; (c) independent repos with conventions aligned by hand. Evidence
to gather: how Claude Desktop and Claude Code namespace tools when two
servers are installed (verify — name collisions?), `tools/list` size and
prompt-cache cost of one server exposing both platforms, Skill-trigger
ambiguity across leagues, release coupling and the two repos' different
maturity, and the fact that ESPN has native projections while Yahoo has
none (the seam must not pretend to unify what differs). Give the
recommendation with a migration path (what is built here now; what moves
to a shared package later; what never moves) so both projects can proceed
today without blocking each other.

## What to produce (one file per section; you own these paths)

`docs/plan/01-system-architecture.md`
- §0 Decisions at a glance (table: decision · why · alternative · what
  would change it), **including the shared-core decision and naming**.
- Component diagram in Mermaid (validate syntax mentally: quote labels
  with special characters). Layers: MCP surface (tools/resources/prompts),
  domain (league model, scoring engine placement, analytics), providers
  (ESPN provider behind a `FantasyPlatform` interface; Yahoo via the seam),
  data sources (each behind a `DataSource` interface), cache/store,
  credential store, drift detector, CLI/ops.
- Transport: stdio primary; whether/when Streamable HTTP is offered.
- Tool/resource/prompt conventions: naming, annotations, compact output
  contract (`content` + `structuredContent`; size budgets; pagination —
  note ESPN's unbounded paging must be bounded by us), error contract
  (typed, actionable, no raw upstream bodies, `ESPN_AUTH_REJECTED`,
  `ESPN_DRIFT_DETECTED`, `ESPN_UPSTREAM_UNAVAILABLE`), the
  `untrusted_text` envelope applied field-by-field inside ESPN responses.
- **Data ingestion + caching**: per data class (league settings, rosters,
  free-agent pool, projections, live scores in-game, transactions/waiver
  order, nflverse weekly, injuries, lines, weather, news) — source,
  cadence, TTL, invalidation trigger, storage, size, and what happens when
  a source is down. Freshness policy table; stale-data labelling rule;
  the ESPN request budget per tool call.
- Rate-limit handling: one global limiter for ESPN (constants from 03
  §D.3), in-flight coalescing, backoff on 429/5xx with jitter, cache-first
  reads; per-source limiters for the others.
- **Drift detector** placement: the daily probe, the fixture manifest, the
  loud failure path, and what degrades gracefully (which tools still work
  without which views).
- Observability: stderr structured logs, redaction rules (Cookie headers,
  GUIDs, IPs), a `status` snapshot; decide on remote error reporting
  (default no; say why).
- The provider seam: what the `FantasyPlatform` interface abstracts (ids,
  scoring-settings shape, roster slots, transactions, waiver systems:
  move-to-last vs FAAB) and what it must not pretend to unify.

`docs/plan/02-security-architecture.md`
- Credential lifecycle state machine (Mermaid `stateDiagram-v2`):
  not-configured → stored → validated → rejected → re-setup; where the
  format validation, the `mSettings` check, and the "never retry a 401"
  rule sit. Store spec (keychain default; file fallback; permissions;
  atomicity; iCloud check; env override for the path only). Redaction.
- Least privilege: read-only server by default; the write module is
  opt-in, off, and its tools are not registered unless enabled and
  acknowledged; commissioner-scope hazard (a commissioner's cookie can
  edit other teams) → own-team pinning.
- **Confirmation gate design** (align with the sibling's plan 02 if it
  exists; else specify): `prepare_*` returns a human-readable diff + an
  opaque token bound to the diff, a roster-state hash and an expiry;
  `commit_*` requires it; what elicitation adds where supported and the
  fallback; one rule stated plainly: **no roster change without an
  explicit human confirmation that the model cannot forge.**
- Input validation (zod on every tool; bounded ids/weeks/limits; one path
  builder; no raw-GET escape hatch), `X-Fantasy-Filter` construction at
  one place with a hard `limit` cap.
- Prompt-injection defences for ESPN free text (team/owner names, player
  outlooks) and news: envelope, length caps, "data not instructions" in
  tool descriptions, never feeding untrusted text into another tool's
  arguments without user review, how Skills are told to treat it.
- Trust-boundaries diagram (Mermaid): user ↔ client ↔ server ↔ ESPN ↔
  external sources ↔ news; where each untrusted input enters.
- Supply chain: exact pins, lockfile, `npm audit` gate, `npm ci`, no
  postinstall scripts (assess `@napi-rs/keyring`'s optional native deps
  honestly), dependency allow-list rationale.
- Threat model table: threat → mitigation → residual risk (include: cookie
  theft from disk, cookie in a transcript, cookie in logs, drift returning
  wrong data, injected instruction in a team name, commissioner-scope
  write, iCloud sync of a secret, a second process clobbering the store).

`docs/plan/03-lifecycle-and-operations.md`
- Process lifecycle: stdio EOF/SIGTERM/SIGINT → clean shutdown (flush,
  close SQLite, exit code); parent-death detection; no orphaned listeners.
- Setup: the CLI hidden-input flow; the optional one-shot local page —
  port selection (fixed default + fallback range + explicit override),
  conflict detection, URL reporting, timeout; both flows end with the
  `mSettings` validation.
- Launch config for Claude Desktop and Claude Code with **absolute,
  quoted paths** (the path has spaces; the `fnm` node path), env passing
  of non-secret settings only, and a `doctor` that checks: node version,
  absolute paths, credential store presence and mode bits, credential
  validity (boolean), league reachability, API host/shape probe age,
  cache dir writable, iCloud check, clock skew.
- Cookie expiry mid-session: detect once, surface the re-setup message
  through the tool result, keep the server alive, never loop.
- Upgrade/migration of the local store; uninstall/cleanup (including
  keychain item removal).

`docs/plan/04-repo-structure-and-ci.md`
- Directory tree consistent with the shared-core decision (`src/`,
  `tests/`, `skills/`, `docs/`, `scripts/`, `fixtures/` anonymized,
  `.github/workflows/`), package layout (single package vs workspaces —
  decide), TypeScript config (strict, ESM, Node 22), lint/format, commit
  conventions, no absolute local paths anywhere committed.
- CI on every push/PR: lint, type-check, unit tests + coverage gate,
  `npm audit` (fail on high/critical, runtime deps), secret scanning
  (pick and justify; ESPN cookie patterns as custom rules), Mermaid
  syntax validation for docs, Skills structural validation, license
  check. Release workflow. Branch-protection recommendation for `main`.

`docs/plan/05-testing-strategy.md`
- Unit (vitest), property tests for the scoring engine and id/filter
  builders, contract tests against **recorded, anonymized** ESPN
  fixtures (capture + scrub procedure per 03 §F.3), **drift tests**
  (manifest vs live probe), fault injection (401, 200-skeleton, 5xx,
  timeouts, malformed JSON, oversized responses), MCP Inspector smoke,
  model-driven evals (read `…/mcp-builder/reference/evaluation.md`; a
  10-question read-only eval from fixtures). Coverage gate and why. What
  runs with zero tokens vs with tokens.

`docs/plan/06-automation-inventory.md`
- Every job that can run with **zero model tokens**: tests, lint, audits,
  the daily ESPN host/shape drift probe (public league, no cookie),
  nflverse/injury/lines refreshes, roster and free-agent-pool snapshots +
  diff alerts (needs cookie), credential validity check, pre-release
  checks, fixture re-recording + scrub. For each: trigger
  (cron/launchd/GitHub Actions/manual), inputs, outputs, failure signal,
  and whether it needs ESPN credentials. Mark which can be built
  **before** the server exists (CI workflows, secret scanning, Mermaid
  lint, drift probe script) and which need it.

Also: `docs/scratch/architecture-planner-core.md` (working notes with
`## RESUME HERE`).

**Do NOT touch**: `README.md`, `.gitignore`, `.env.example`, anything in
`docs/research/`, `docs/scratch/roster.md`, `docs/scratch/program.md`,
`docs/scratch/briefs/`, and the product planner's files `docs/plan/07-*`
through `10-*`. Another agent (`skills-mcp-researcher`) is writing
`docs/research/06-*` in the same tree in parallel. Leave any file you did
not create exactly as you find it.

## Standard of the plan

- Every decision: **decision · why · alternative considered · what would
  change it**. The devil's advocate will attack anything without a reason.
- Mark what is **verified** (cite the research doc section) vs
  **assumed** (say so). Do not invent client support, API behaviour, or
  library features — check or mark unverified.
- Prefer simple over clever where the payoff is unclear; say when a
  component is deferrable.
- Mermaid diagrams must be syntactically valid (no unquoted `|`, `()` or
  `:` in node labels; use `["…"]`).

**A clean negative is a real result.** If something in the objective is
not achievable under the verified constraints, say so plainly and propose
the honest alternative.

## What a FAILED report looks like

- A plan that treats writes as a normal feature, or that stores a cookie
  in `.env` or the client config.
- Decisions without reasons or alternatives; the shared-core question
  answered by preference instead of evidence.
- Drift detection that relies on status codes.
- Diagrams that do not render.
- Re-deriving ESPN API facts instead of citing doc 03.
- Files that exist only in your reply and not on `origin`.
- A reply without the pushed SHAs.

## COMMIT/PUSH DISCIPLINE — Chad's standing rule, non-negotiable

**No work you do may be lost.**
- **Your FIRST action is** `docs/scratch/architecture-planner-core.md`
  with a `## RESUME HERE` section — commit and push it before any real
  work, and keep it current.
- **Your SECOND action is** `docs/plan/01-*` §0 with the shared-core and
  naming decision — commit and push it before the rest of the file.
- **Commit and push to `origin/main` at every natural checkpoint** — after
  each plan file lands, not once at the end.
- **Before you are torn down, blocked, or run low on context, COMMIT AND
  PUSH FIRST, then reply.**
- **Track your remaining budget.** At roughly **20% context remaining**, stop
  taking on new scope: commit, push, update `## RESUME HERE`, reply.
- **Preserve unfinished work on `origin` as a PATCH, never as broken files**:
  `git diff -- <your paths> > docs/scratch/architecture-planner-core.wip.patch`
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
  `docs(plan): system architecture — shared-core decision, layers, caching`,
  ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commit identity is already configured locally in this repo. Do not
  change git config.

## Reply format

When done: (1) the pushed SHAs, (2) the shared-core/naming decision in
three lines, (3) the ten most consequential decisions in one line each
with their reason, (4) anything from the objective that is not achievable
under the verified constraints, (5) the assumptions you had to make, by
name.
