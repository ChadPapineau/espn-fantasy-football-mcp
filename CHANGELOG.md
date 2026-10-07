# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0, a breaking change to a tool
name or schema, the store format, the manifest format, the config key or the plugin name bumps the
minor version (plan 04 §4.4; plan 09 K6). One version covers the server, the Skills and the plugin.

## [Unreleased]

### Added

- **Scaffold and supply chain (plan 04 §1–§2).** `.npmrc` (`ignore-scripts`, `save-exact`,
  `engine-strict`, `audit`), `.nvmrc` (Node 24.21.0; engines `>=24.15`), `package.json` with exactly
  four runtime dependencies pinned exactly — `@modelcontextprotocol/server` 2.2.0, `zod` 4.6.5 (the
  one zod the SDK resolves), `hyparquet` 1.31.2, `@napi-rs/keyring` 2.1.0 — and a committed
  lockfile; runtime tree of 6 packages held exactly by `scripts/ci/runtime-allowlist.json`.
- **TypeScript, lint, format, tests (plan 04 §3, plan 05 §1, §7).** Strict `tsconfig` (NodeNext,
  ES2023, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`);
  ESLint flat config with typescript-eslint `strictTypeChecked`, the plan 01 §1.1 layer table, the
  two ESPN zones (only `src/auth/keychain.ts` may import `@napi-rs/keyring`; only
  `src/providers/espn/` may import the wire schemas in `views/`), and bans on `eval`,
  `new Function`, shell-string `exec`; Prettier and EditorConfig; Vitest projects `unit` and
  `process` with the plan 05 §7 coverage gate (global 90/85/90/90, eleven 100 % entries as globs).
- **Secret and identifier protection (plan 04 §4.1 R11, §4.3; `CLAUDE.md`).**
  `scripts/dev/scan-secrets.mjs` with ESPN rules (named and bare `espn_s2`, SWID and brace-GUIDs
  outside the fixture range, league-id shapes, Cookie headers, `clientAddress`, IPv4, home paths,
  email) and a local deny-list that is never printed; `scripts/dev/commit-paths.sh` (private
  index, refuses `main`, scans blobs and message, GitHub no-reply identity only, pushes);
  `.githooks/pre-commit` and `.githooks/commit-msg`; `.gitleaks.toml` with the ESPN rules;
  generated (never committed) self-test fixtures in `scripts/ci/secret-fixtures.mjs`.
- **CI (plan 04 §4).** `ci.yml` (lint incl. commit messages, typecheck, test + coverage gate,
  supply-chain: `npm audit --omit=dev --audit-level=high`, no install scripts, licenses, full
  runtime tree; pack scan; process), `docs.yml` (Mermaid render with pinned mermaid-cli and an
  explicit `chrome-headless-shell` install, internal links, identifiers, plugin + Skills
  structure and `claude plugin validate --strict`), `secret-scan.yml` (workflow `secrets`; gitleaks pinned by version and
  sha256 over the full history and the tree, plus its self-test), Dependabot (monthly, grouped) and
  a pull-request template. Every action pinned by commit SHA; `contents: read`; no secrets.
- **Plugin root (plan 09 §4, K8).** `.claude-plugin/plugin.json` (`espn-fantasy-football`,
  `userConfig` for the league id and season) and `marketplace.json` (the repo is its own
  marketplace), `.mcp.json` launching `/bin/sh scripts/eff-launch.sh serve` with no
  `EFF_CONFIG_DIR`/`EFF_CACHE_DIR`, and the POSIX launch shim that resolves a Node >= 24.15 in a
  fixed order and prints the exact fix when none is found.
- **Phase 1a + 1b, read-only (plans 01–10).** The local stdio MCP server with the 18 P0 tools
  (league, roster, players, schedule, standings, matchups and box scores, injuries, transactions,
  status; E1 projections, E2 start/sit, E5 waiver priority with the K/D-ST slice, E12 record and
  E13 retrospective), the P0 resources and the 8 P0 prompts, every third-party string wrapped and
  path-listed in `meta.untrusted_fields`; the `eff` CLI (serve, doctor, setup, refresh, launchd and
  the rest); the ESPN provider (one path and filter builder, view schemas, classifier, cross-process
  limiter, cache, normalisers, in-call drift detector); the format-aware scoring engine with the
  per-stat golden over the recorded leagues; the `node:sqlite` store; nflverse and weather data
  sources; the crosswalk; the pure league model; the recommendation log; credential stores behind
  the lazy credential authority. No write tool exists: Phase W is not built and every seam it would
  use carries a `PHASE W SEAM — NOT IMPLEMENTED` marker.
- **The eight P0 Skills (plan 09).** `skills/*` with their shared references, `build:skills`,
  `check:skills` (Lane 1 items 1–6) and the Lane 1 dry run (item 7) that replays each Skill's
  `evals/tool_sequence.json` against the built server in fixture mode.
- **The derived Skills league `fx-10h` (plan 05 §3, class 2).** A ten-team league derived from the
  recorded probe leagues and re-scored by the engine under one reference scoring, with 25 variants
  as JSON patches (post-run, k10, ir-open, sunday-live, points-only seeding, drift, a stat-53
  mismatch, six injected-text variants and more); `fixtures:gen` / `fixtures:check`. Fixture mode
  serves it by route, view and filter, including the player-pool sorts and paging, at the
  manifest's clock.
- **Keyless ESPN season sources.** `espn:pro_schedule` and `espn:players` as `eff refresh` data
  sources (and installable launchd jobs): one keyless request each, recorded as a job request in
  the cross-process limiter, never with a cookie.
- **End-to-end proof (plan 10 §3.1).** `tests/e2e/` spawns `node dist/cli.js serve` over real
  stdio on `fx-10h` with a temp config and cache and no network: exactly the 18 P0 tools, every one
  called and its envelope checked against its schema, a clean exit within the drain deadline after
  stdin closes, and an orphaned server exiting on its own with stdin still open; drift,
  injected-text invariance, the A9a/A11a/A13a analytics checks and the latency
  bounds (startup, warm-cache reads, E1/E2/E5 budgets, event-loop stall). CI runs them in the
  `process` job, a `smoke` job drives the built server with the pinned Inspector CLI, and a weekly
  `process-macos` job runs the keychain process tests.
- **Phase 2 data sources (plan 10 §3.2).** nflverse `stats_team_week`, the play-by-play projected
  subset, `snap_counts` and the ESPN-keyed `depth_charts`; ffopportunity `ep_weekly`; Sleeper's
  trending adds and drops (a secondary signal); the RotoWire, ESPN and CBS RSS headlines (all text
  wrapped as `untrusted_text`, a deterministic player matcher, no entity expansion); and the two
  prior seasons of each nflverse / ffopportunity dataset in their own history files for the soft
  backtests. Each loads through `eff refresh` with its schema assertion (a renamed column fails
  naming it), shows its licence and age in `eff status`, and exits 0 without a request outside the
  season; the launchd jobs cover them. The HTTP allow-list gains exactly `api.sleeper.app`,
  `www.rotowire.com`, `www.espn.com` and `www.cbssports.com` (the cookie path still refuses them).
- **The Phase 2 dataset readers.** Depth charts (current snapshot runs; the 2024 legacy layout),
  expected points, news with player refs and match confidence, trending with gsis ids, the pbp team
  profile, and usage extras on the weekly player lines — snaps and snap share, red-zone and
  goal-line volume, the team's red-zone opportunities, carry share and a routes proxy. A prior
  season reads from its history file; Phase 2 and history files are validated against their
  contract on publish and on open.
- **The 16 P1 tools under `EFF_TOOLSET=full` (plan 07 P1).** Player stats, ESPN projections and
  outlooks, usage, depth charts, defence profiles (opponent-adjusted points allowed, pace, pass
  rate, PROE, sack and takeaway rates, EPA allowed), news, the matchup engine (pre, live and the
  fitted season), replacement level, trades (evaluation and partner search), the injury cascade,
  the schedule stress test, the roster audit, evidence weighing (the `rules_v1` claim extractor and
  hand-set reliability priors), league activity, and the recommendation log; waivers gain usage
  signals, rival demand, learned claim mechanics and FAAB bids; E1 gains the `player_sim` basis for
  RB/WR/TE weeks with three or more recent games (under `full` only — `core` is unchanged). `core`
  stays at 18 tools; no write tool in either set.
- **The five P1 Skills and prompts (plan 09 P1).** `trade`, `injury-cascade`, `schedule-plan`,
  `roster-audit`, `news-check`; `waivers`' usage and FAAB branches, `start-sit`'s live P(win); the
  five P1 prompts (13 under `full`); the plugin-eval suite generator (`npm run build:plugin-evals`,
  `--seed-datasets` to load the committed excerpts into the eval servers).
- **`scripts/run-weekly.ts`.** The weekly pre-run as a headless Agent SDK session against the
  server, write and shell tools denied by name.
- **End-to-end proof under `full`.** The built server over real stdio on a seeded `fx-10h` cache:
  34 tools in registry order, every one called and its envelope checked, the plan 10 B8 walk over
  every output on all six injected-text variants, every Skill's `full` tool sequence, the P1
  latency budgets and the event-loop stall bound; the SDK and Inspector smokes run under both
  toolsets.

### Fixed

- **Drift.** A composite read (several views in one request) is compared against the union of its
  views' observations, and integer-keyed maps no longer read as additive drift.
- **Event-loop stalls on large cached bodies.** JSON without `__proto__` or escapes parses on the
  native fast path, and the provider yields to the event loop before parsing a cached body over
  64 KiB and before building an envelope.
- **Record recommendation.** An onboarding record may cite the last final week's box score.
- **Bounds.** `n_sims` is capped at the measured `N_SIMS_MAX`.
- **Refresh spacing.** A release refresh no longer waits 15 minutes between its version poll and
  its downloads: the GitHub poll keeps its 15-minute limit and a run's assets are spaced 1 s apart.
- **Event-loop stalls in the P1 tools.** The provider's freshness context is reused for a second
  instead of re-reading the season's schedule on every read, a large fresh body yields between its
  parse, drift check, schema check and cache strip, and the heavier P1 tools yield between their
  synchronous steps (measured 37 ms worst case against the 50 ms bound).
