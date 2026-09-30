# 04 — Repository structure and CI

**Author:** `architecture-planner-core` · **Date:** 2026-09-30 · **Brief:** `docs/scratch/briefs/architecture-planner-core.md`
**Inputs:** plans 01–03 (module map §1.1, shared-core boundaries §0.2–0.3, supply chain plan 02 §7, doctor plan 03 §5); `docs/HANDOFF.md` (public repo; secret scanning + push protection on; Dependabot security updates off; no branch protection); `docs/research/02-prior-art-lessons.md` §4 #13–#18; `03-espn-api.md` §C.1 (cookie shapes), §F.3 (fixture rules); `00-tooling-inventory.md` (no `gitleaks`/`osv-scanner` installed locally); the sibling's repo plan `yahoo-fantasy-football-mcp@f3a0a48 docs/plan/04` (**[V-sib 04 §x]** — its tsconfig, lint, CI-job and release designs transfer almost verbatim and are cited; the deviations are the tree, the dependency list, and the secret-scanning rules); the mcp-builder `node_mcp_server.md` structure guidance (adapted, not copied — it targets SDK v1 and `Node16` resolution); the npm registry (read 2026-09-30).

Legend as in plan 01.

---

## 0. Decisions at a glance

| # | Decision | Why | Alternative considered | What would change it |
|---|---|---|---|---|
| R1 | **Single npm package, no workspaces** — but the tree keeps the shared-core candidates in directories that are already package-shaped (plan 01 §0.2) | one deployable, one lockfile to audit, one `npm ci`; the shared package is a later extraction (plan 01 D3), and a workspace with one member is ceremony | workspaces (`server`, `core`) from day one | the plan 01 §0.3 trigger firing → the candidate directories become `packages/core` in **their own repo**, not a workspace here |
| R2 | **TypeScript strict ESM, `module: NodeNext`, `target: ES2023`, Node ≥ 22.13** [V-sib 04 R2] | the SDK v2 is ESM with `zod/v4`; `NodeNext` is what Node resolves; matches the other local server's stack [V-00] | CommonJS; bundling | Nothing |
| R3 | **ESLint 9 flat config + typescript-eslint (type-checked), Prettier, import-boundary rules per directory** [V-sib 04 R3] with two ESPN-specific zones: nothing outside `src/auth` and `src/http` may import `@napi-rs/keyring`; nothing outside `src/providers/espn` may import `src/providers/espn/views/*` (wire schemas) | the plan 01 §1.1 boundaries must be mechanical; the credential store must have exactly two import sites | Biome | Biome gaining equivalent type-aware rules |
| R4 | **Conventional Commits checked by a 30-line script** [V-sib 04 R4] | changelog derives from it; `commitlint` is ~100 dev packages for a regex | commitlint | Nothing |
| R5 | **CI on every push and PR: ubuntu, Node 22 and 24 matrix; a macOS job weekly and on release** [V-sib 04 R5] | Linux covers everything but launchd/`osascript`/keychain; macOS covers those on a cadence — and the **keychain integration test can only run on macOS** | macOS every push | a macOS-only regression slipping through more than once |
| R6 | **Secret scanning = gitleaks (pinned by SHA) with ESPN-specific rules** (§4.3) **plus** GitHub push protection (already on [HANDOFF]) | a single binary, custom TOML rules, scans history; the two prior-art leaks (a 2020 cookie commit [V-01 #13]; a script echoing cookies into config [V-01 #12]) would both be caught; league ids and member GUIDs are identifiers this public repo must not carry [HANDOFF] | trufflehog | Nothing |
| R7 | **Mermaid validation with `@mermaid-js/mermaid-cli` pinned, on `docs/**` changes** [V-sib 04 R7] | the docs are the plan; a diagram that does not render is a failed deliverable (brief); this repo's README will carry 8 diagrams (HANDOFF) | `@mermaid-js/parser` | a lighter parser covering flowchart, sequence and state |
| R8 | **Release = tag `vX.Y.Z` → CI builds, tests, checks CHANGELOG, `npm pack --dry-run`, scans the tarball for identifiers, publishes a GitHub Release with the tarball**; npm publish is manual by Chad with `--provenance` [V-sib 04 R8] | no agent publishes; the tarball scan is the last line against shipping a fixture with a real id | automated `npm publish` | Chad choosing to publish to npm at all |
| R9 | **Branch protection on `main` via a ruleset: block force-push and deletion, required checks; PRs not yet required** [V-sib 04 R9] | the agent program pushes to `main` directly today | require PRs now | the moment product code exists → require PRs with CI green, no required reviewers (solo maintainer) |
| R10 | **Coverage gate lives in CI and is never lowered to pass** — values in plan 05 §7 | standing rule | — | — |
| R11 | **A `no-identifiers` CI job**: no absolute local paths (`/Users/`, `/home/`), no real league id shape outside placeholders, no brace-GUID outside the fixture pseudonym range, no IPv4 literal outside `127.0.0.1`/`0.0.0.0`, in any tracked file | the repo path contains a username [V-00]; ESPN payloads carry GUIDs and an IP [V-03 §B.3, §A.2]; gitleaks alone does not know an ESPN league id is sensitive | rely on gitleaks + review | Nothing |

---

## 1. Directory tree

```
espn-fantasy-football-mcp/
├── package.json                 # name: espn-fantasy-football-mcp · bin: eff · type: module · engines.node >=22.13
├── package-lock.json            # committed; npm ci only
├── .npmrc                       # save-exact=true · ignore-scripts=true · fund=false · audit=true
├── tsconfig.json · tsconfig.build.json
├── eslint.config.js · .prettierrc · .editorconfig
├── .gitleaks.toml               # custom rules (§4.3)
├── .gitignore                   # exists today — untouched by this plan (it already ignores *cookie*, *credentials*.json, *token*.json, .env*)
├── .env.example                 # exists today — untouched (documents names; the server reads no .env — plan 01 D16)
├── README.md · LICENSE · SECURITY.md   # docs-writer's files
├── CHANGELOG.md                 # Keep a Changelog; CI checks a tag has an entry
├── src/
│   ├── cli.ts                   # entry: `eff <subcommand>`; `serve` is the client's command
│   ├── config/
│   │   ├── schema.ts            # zod schema of every env/config key (README table generated from it)
│   │   ├── paths.ts             # XDG resolution, absolute-path assertions, iCloud xattr check
│   │   └── freshness.ts         # TTL / hard-limit constants (plan 01 §5.4)
│   ├── mcp/                     # MCP surface only
│   │   ├── server.ts · registry.ts · define.ts · envelope.ts · errors.ts · bounds.ts
│   │   ├── tools/ · resources/ · prompts/     # product planner fills
│   ├── domain/                  # pure — shared-core candidates (plan 01 §0.2)
│   │   ├── league/ · scoring/ · analytics/ · crosswalk/ · gate/ · reclog/
│   ├── providers/
│   │   ├── platform.ts          # FantasyPlatform interface (plan 01 §9)
│   │   └── espn/
│   │       ├── provider.ts
│   │       ├── path.ts          # the one path builder (view whitelist)
│   │       ├── filter.ts        # the one X-Fantasy-Filter builder (limit ≤ 100 + sort)
│   │       ├── views/           # one zod schema per view: mSettings.ts, mTeam.ts, mRoster.ts, … (wire types; import-restricted)
│   │       ├── normalize.ts     # wire → domain; wraps untrusted fields (plan 01 §4.4)
│   │       ├── ids.ts           # slot-id map AND position-id map (two numberings, 03 §B.2)
│   │       ├── stat_map.ts      # ESPN statId → canonical stat name
│   │       ├── errors.ts        # classifier: typed body → error code; 401/403 never retried
│   │       ├── limiter.ts       # cross-process bucket (SQLite), breaker, coalescing
│   │       └── cache.ts         # policy per data class
│   ├── drift/                   # manifest loader, key-set diff, skeleton detection, probe runner
│   ├── sources/
│   │   ├── source.ts            # DataSource interface
│   │   ├── espn_season/         # proTeamSchedules_wl, players_wl (keyless, cacheable)
│   │   ├── nflverse/ (schemas.ts holds expected columns per file) · ffopportunity/ · sleeper/ (trending only)
│   │   ├── news/ · weather/ · odds/
│   ├── store/
│   │   ├── db.ts · migrations/ (001_init.ts …) · repos/
│   ├── auth/
│   │   ├── store.ts             # CredentialStore interface
│   │   ├── keychain.ts          # @napi-rs/keyring (the only import site besides tests)
│   │   ├── security_cli.ts      # macOS `security` variant (plan 02 §7.2 fallback)
│   │   ├── file.ts              # 0700/0600, wx+fsync+rename, xattr check
│   │   ├── format.ts            # SWID / espn_s2 validators
│   │   └── state.ts             # not_configured | stored | validated | rejected
│   ├── http/
│   │   └── client.ts            # fetch wrapper: host allow-list per mode, timeouts, limiter hook, UA, redaction
│   └── cli/
│       ├── log.ts               # stderr JSON logger + redaction
│       ├── serve.ts · setup.ts · setup_page.ts · status.ts · doctor.ts · smoke.ts · probe.ts
│       ├── refresh.ts · snapshot.ts · print-config.ts · install-launchd.ts · uninstall.ts · confirm.ts (writes phase)
│       └── launchd/             # plist templates (absolute paths filled at install)
├── tests/                       # mirrors src/ (unit), plus:
│   ├── contract/                # recorded-fixture tests per ESPN view
│   ├── drift/                   # manifest vs fixture; probe diff logic
│   ├── fault/                   # 401 / 200-skeleton / 5xx / timeout / malformed / oversized injection
│   ├── property/                # fast-check: path + filter builders, scoring engine, envelope, redactor, limiter
│   ├── process/                 # spawn the real binary: shutdown, orphan, setup-page port, keychain (macOS only)
│   ├── smoke/                   # expected-tools.json for the Inspector run
│   └── evals/                   # 10-question read-only eval (plan 05 §6), run manually
├── fixtures/
│   ├── espn/                    # ANONYMISED only (03 §F.3): one JSON per view + the three error bodies + manifest.json
│   ├── nflverse/                # tiny csv.gz excerpts (≤ 50 rows) + ATTRIBUTION.md (CC-BY)
│   ├── news/                    # RSS samples incl. injection attempts
│   └── golden/                  # scoring-engine expected outputs (per-stat appliedStats)
├── skills/                      # the Skills bundle (product planner / skills researcher own content)
│   └── <skill-name>/SKILL.md (+ references/)
├── scripts/                     # zero-token tooling (plan 06): record-fixture, scrub-fixture, gen-manifest,
│   │                            # gen-config-docs, gen-tool-docs, check-commits, check-licenses, check-no-scripts,
│   │                            # check-mermaid, check-skills, check-identifiers, check-coverage, scan-tarball
├── docs/                        # research/, plan/, scratch/, HANDOFF.md (as today)
└── .github/
    ├── workflows/ci.yml · docs.yml · release.yml · scheduled.yml
    ├── dependabot.yml           # security updates only (currently off — HANDOFF item 1 asks Chad)
    └── PULL_REQUEST_TEMPLATE.md # checklist: no identifiers, tests, docs, changelog
```

`dist/` is built, git-ignored (already), and is what the launch config points at (plan 03 §4). Fixture file names avoid the `.gitignore`'s secret-shaped globs (`*cookie*`, `*credentials*.json`, `*token*.json`) by construction — a test asserts every fixture path is tracked.

---

## 2. Package layout and dependencies

**Runtime dependencies (the allow-list; adding one needs a row here with reason and rejected alternative):**

| Package | Pinned at (2026-09-30) | Why | Rejected alternative |
|---|---|---|---|
| `@modelcontextprotocol/server` | 2.2.0 [V-npm] | the SDK (plan 01 D2); brings `@modelcontextprotocol/core` 2.2.0 and `zod ^4.2.0` [V-npm] | v1 `@modelcontextprotocol/sdk` 1.31.0 (17 runtime deps) |
| `zod` | 4.6.5 exact (or the SDK's resolved version) [V-npm] | tool schemas, view schemas, config schema | valibot |
| `hyparquet` | 1.31.2 exact [V-npm: pure JS, MIT, zero deps; its `prepare` script runs only from a git checkout, not from the registry tarball] | nflverse/ffopportunity parquet (plan 01 D9) | `parquetjs`; DuckDB |
| `@napi-rs/keyring` | 2.1.0 exact — **pinned only after plan 02 §7.2 passes** [V-npm: no install script; 12 optional platform packages; `darwin-arm64` is one `.node` file] | OS keychain for the cookie (plan 01 D12) | `keytar` (archived 2022, `prebuild-install`/`node-gyp` at install [V-03 §C.4]); `security` CLI (macOS-only, argv on write) |

Four direct runtime packages (six names with `core` and the platform package). Everything else is Node built-ins: `node:sqlite`, `fetch`, `node:crypto`, `node:zlib`, `node:util.parseArgs`, `node:fs/promises`, `node:child_process` (`execFile` with argument arrays only, for `osascript`, `lsof`, `launchctl`, `security`, `xattr`).

**Dev dependencies:** `typescript`, `vitest` + `@vitest/coverage-v8`, `fast-check`, `eslint` + `typescript-eslint` + `eslint-plugin-import-x`, `prettier`, `tsx`, `@types/node`. Run via `npx` with pinned versions in CI only: `@modelcontextprotocol/inspector`, `@mermaid-js/mermaid-cli`.

`package.json` essentials: `"type": "module"`, `"bin": { "eff": "dist/cli.js" }`, `"engines": { "node": ">=22.13" }`, `"files": ["dist", "skills", "README.md", "LICENSE", "CHANGELOG.md"]` (fixtures and tests never ship), scripts: `build`, `typecheck`, `lint`, `format:check`, `test`, `test:coverage`, `test:process`, `smoke`, `eval` (manual, tokens), `check:commits`, `check:licenses`, `check:no-scripts`, `check:mermaid`, `check:skills`, `check:identifiers`, `check:docs`, `pack:scan`, `fixtures:record`, `fixtures:scrub`, `fixtures:manifest`.

---

## 3. TypeScript, lint, format, commits

**`tsconfig.json`** — identical to the sibling's [V-sib 04 §3] (`ES2023`, `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`, `outDir: dist`, `rootDir: src`, `sourceMap`). `noUncheckedIndexedAccess` is the one that matters most here: ESPN's `stats[]`, `teams[].roster.entries[]`, `schedule[]` and `pointsOverrides{"16"}` are index-accessed everywhere, and a bye is `home` without `away` [V-03 §B.4].

**ESLint (flat):** `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked`; `no-explicit-any: error` (inline disable with a reason is the only escape); `no-floating-promises: error`; `no-console: error` with an override under `src/cli/**`; **import boundaries** via `import-x/no-restricted-paths` mirroring plan 01 §1.1, plus: `src/**` except `src/auth/keychain.ts` may not import `@napi-rs/keyring`; `src/**` except `src/providers/espn/**` may not import `src/providers/espn/views/**`; `src/domain/**` and `src/mcp/**` may not import `src/auth/**`; `no-restricted-imports` bans `child_process`'s `exec`/`execSync` (argument-array `execFile` only) and `eval`. A boundary test imports the wrong module and expects a lint error (plan 05).

**Prettier**, **EditorConfig**, **Conventional Commits** (`feat|fix|docs|test|chore|refactor|perf|ci|build(scope): subject`), `scripts/check-commits.ts` on every PR commit and title; `Co-Authored-By` trailers allowed.

---

## 4. CI

All workflows: `permissions: contents: read` by default; actions pinned by **commit SHA**; `concurrency` cancels superseded runs; `npm ci` with the committed lockfile; Node from `.nvmrc`/matrix. **CI never holds ESPN credentials** — a standing rule, not a limitation (the repo is public; a cookie in a GitHub secret is the JayMishra pattern [V-01 #12]).

### 4.1 `ci.yml` — every push to any branch, every PR

| Job | Steps | Fails when |
|---|---|---|
| `lint` | `npm ci` → `lint` → `format:check` → `check:commits` (PRs) | any error |
| `typecheck` | `tsc --noEmit -p tsconfig.json` (includes tests) | any type error |
| `test` (matrix node 22, 24) | `test:coverage` → upload `coverage/` → `scripts/check-coverage.ts` against the gate (plan 05 §7) | any failure; coverage below gate; a 100 %-module below 100 % |
| `process` | `build` → `test:process` (startup < 1 s with network+keychain stubbed, stdin-EOF exit 0, SIGTERM exit 0, orphan exit, setup-page port fallback + close, two-process limiter race) | any process test fails |
| `smoke` | `build` → `npx -y @modelcontextprotocol/inspector@<pin> --cli node dist/cli.js serve --method tools/list` in **fixture mode** (`EFF_FIXTURE_DIR=fixtures/espn`, `ESPN_LEAGUE_ID=0`, no credentials) → assert the expected tool names and that **no `espn_commit_*`/`espn_prepare_*` tool is listed** | list ≠ `tests/smoke/expected-tools.json` |
| `supply-chain` | `npm audit --omit=dev --audit-level=high` (gate) · `npm audit` (report) · `check:no-scripts` (no `install`/`postinstall`/`preinstall`, no `binding.gyp`/`prebuild-install`/`node-gyp` in `npm ls --omit=dev`; **the `@napi-rs/keyring` platform package must be present as a prebuilt `.node` with no scripts**) · `check:licenses` (allow-list MIT, ISC, BSD-2/3, Apache-2.0, 0BSD, CC0-1.0, Unlicense) · `npm ls --omit=dev --depth=1` diff against §2 (depth 1 so the one platform package is visible and the other eleven are absent) | any high/critical runtime advisory; any install script; any license outside the list; any undeclared runtime dependency |
| `secrets` | gitleaks (pinned) with `.gitleaks.toml`, full history | any finding not allow-listed |
| `identifiers` (R11) | `scripts/check-identifiers.ts` over tracked files: `/Users/`, `/home/`, `C:\\Users` → fail; brace-GUIDs outside `{00000000-0000-4000-8000-0000000000NN}` and the `.env.example` placeholder → fail; IPv4 literals other than `127.0.0.1`, `0.0.0.0` → fail; `leagueId=\d{4,}`, `leagues/\d{4,}`, `ESPN_LEAGUE_ID=\d+` other than `0000000`/`0` → fail; `espn_s2=` followed by ≥ 40 non-space chars → fail | any hit |
| `pack` | `build` → `npm pack --dry-run --json` → `scripts/scan-tarball.ts`: only `files` globs; no `fixtures/`, `tests/`, `.env*`, `*.sqlite`; the `identifiers` rules over the tarball contents | any violation |

### 4.2 `docs.yml` — on changes under `docs/**`, `skills/**`, `README.md`

| Job | Steps |
|---|---|
| `mermaid` | `scripts/check-mermaid.ts` extracts every ```` ```mermaid ```` block to `tmp/*.mmd` → `npx -y @mermaid-js/mermaid-cli@<pin> -i <file> -o /dev/null` per block; a parse error fails with file + block index. **Can run today** on `docs/plan/*.md` (this plan's diagrams included) |
| `skills` | `scripts/check-skills.ts`: every `skills/*/SKILL.md` has frontmatter `name` (= directory, `[a-z0-9-]+`) and `description` (non-empty, ≤ 1 024 chars) **[A-1: rules finalised by `docs/research/06`]**; referenced files exist; no file > 200 KB; the plan 02 §6.3 sentence is present in each Skill that reads outlooks, names or news; tool references use `espn-fantasy-football-mcp-server:espn_<tool>`; no `espn_commit_*` reference outside the `apply` Skill (if/when it exists) |
| `docs-current` | `check:docs` — regenerates the README config table from `src/config/schema.ts` and the tool reference from `tools/list` in fixture mode; fails on diff |
| `links` | internal relative links resolve (no external link checking — flaky) |
| `identifiers` | the R11 job again (docs are where prose leaks happen) |

### 4.3 gitleaks rules (`.gitleaks.toml`, in addition to the defaults)

| Rule id | Pattern (sketch) | Why |
|---|---|---|
| `espn-s2-cookie` | `(?i)espn_s2\s*[=:]\s*["']?[A-Za-z0-9%+/=._-]{80,}` | the bearer cookie [V-03 §C.1]; 80 (not 100) to catch a truncated paste |
| `espn-s2-value-bare` | `\bAE[A-Za-z0-9%]{90,}` with entropy ≥ 4.5 **[A-2: the `AE` prefix is from two published examples (`AECt%2F…`) [V-03 §C.1]; a real cookie shape may differ — verify against Chad's own value locally, never committed]** | a value pasted without its name |
| `espn-swid` | `(?i)swid\s*[=:]\s*["']?\{?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}?` | the member id |
| `brace-guid` | `\{[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}` with allow-list `\{00000000-0000-4000-8000-0000000000[0-9A-F]{2}\}` (fixture pseudonyms) and the `.env.example` placeholder | every member GUID in any ESPN payload [V-03 §B.3] |
| `cookie-header` | `(?i)^\s*cookie:\s*.*espn_s2` | a captured header in a doc or fixture |
| `espn-league-id` | `(?i)(leagueId=|leagues/|ESPN_LEAGUE_ID=)\d{4,9}` with allow-list `0000000`, `/0`, `leagueId=0` | league ids are identifiers (HANDOFF) |
| `client-address` | `"clientAddress"\s*:\s*"(?!0\.0\.0\.0)` | the IP field in `mStatus` [V-03 §A.2] |
| `odds-api-key` | `ODDS_API_KEY\s*=\s*[0-9a-f]{32}` | optional key |

Push protection stays on (HANDOFF) — no CI can undo a pushed secret; only rotation can, and for `espn_s2` rotation is a manual re-login with an unverified invalidation path [V-03 §C.6], which is why prevention is the whole game.

### 4.4 `release.yml` — on tag `v*`

Build → full `ci.yml` jobs → `scripts/check-changelog.ts` → `npm pack` → `scan-tarball` → GitHub Release with tarball + sha256 and the changelog section as body. **No `npm publish` from CI** (R8). Semantic versioning: breaking changes to tool names/schemas, the store format or the manifest format bump major (pre-1.0: minor).

### 4.5 `scheduled.yml` — weekly (Monday 06:00 UTC) + manual

`npm audit` full report → `npm outdated --json` into the job summary → **macOS runner:** `test:process` (launchd plist generation, `osascript` path with a stub, `lsof` report, **the keychain round-trip: `eff setup` with a fake value from stdin → `eff doctor` #7 → `eff uninstall --yes`, asserting no item survives**) → Inspector smoke. Failures surface in the Actions summary (no bot tokens beyond `GITHUB_TOKEN`).

### 4.6 What can be built **before** the server exists

`docs.yml` (Mermaid + links + skills structure + identifiers), the `secrets` job with `.gitleaks.toml`, the `identifiers` script, `dependabot.yml`, `PULL_REQUEST_TEMPLATE.md`, the ruleset (§5) — all work on the current docs-only repo and land first (plan 06 marks them). The drift-probe **script** (`scripts/probe.ts` calling `proTeamSchedules_wl` and diffing against a checked-in key list) can also be built now as a standalone `npx tsx` script with zero dependencies, before `src/` exists.

---

## 5. Branch protection recommendation for `main`

Today: public, no protection, no rulesets; secret scanning + push protection on; Dependabot security updates off [HANDOFF item 1]. Recommended ruleset (Chad applies it; agents never touch repo settings):

| Now (docs phase) | When product code lands |
|---|---|
| Block force-pushes and deletion of `main` | same |
| Required checks `docs / mermaid`, `docs / identifiers`, `secrets` — **without** requiring a PR (the agent program pushes to `main` directly; a red check blocks the push) **[A-3: whether rulesets can require checks on direct pushes; if not, the checks run post-push and a red `main` is the orchestrator's obligation to fix before spawning the next agent]** | require a PR; required checks: all `ci.yml` jobs; linear history; **no required reviewers** (solo maintainer); admin bypass for Chad only |
| Keep push protection on; **turn Dependabot security updates on** | same; version updates monthly, grouped |

---

## 6. Docs that are generated, not written

- README config table ← `src/config/schema.ts` (`scripts/gen-config-docs.ts`), checked in CI.
- `eff print-config` output ← the same schema.
- The tool reference ← `tools/list` in fixture mode (`scripts/gen-tool-docs.ts`); `docs-writer` owns the prose around it.
- `fixtures/espn/manifest.json` ← `scripts/gen-manifest.ts` over the committed (anonymised) fixtures — never hand-edited (plan 01 §7).

---

## 7. What this plan does not decide

The tests inside each job (plan 05); the schedule and inputs of every zero-token job beyond CI (plan 06); the Skills' content and validation rules beyond structure (plans 09/10 and `docs/research/06`).

---

## 8. Assumptions and unverified, by name

| # | Assumption | Verify by |
|---|---|---|
| A-1 | Skills frontmatter rules (`name`, `description` ≤ 1 024) | `docs/research/06` |
| A-2 | Real `espn_s2` values start with `AE` (two published examples) | Chad checks his own value locally against the rule; the rule is loosened to entropy-only if not |
| A-3 | GitHub rulesets can require passing checks on direct pushes | GitHub docs at setup time; fallback stated in §5 |
| A-4 | `import-x/no-restricted-paths` expresses the plan 01 §1.1 zones plus the two ESPN-specific ones | the boundary lint test |
| A-5 | `hyparquet`'s `prepare` script does not run on `npm ci` from the registry tarball (npm runs `prepare` only for git deps and local installs) | `check:no-scripts` inspects `npm ls`; a registry tarball has no `prepare` effect — confirmed by npm's documented lifecycle at build time |
