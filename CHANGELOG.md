# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0, a breaking change to a tool
name or schema, the store format, the manifest format, the config key or the plugin name bumps the
minor version (plan 04 §4.4; plan 09 K6). One version covers the server, the Skills and the plugin.

## [Unreleased]

### Added

- **A logged recommendation's `note` read back (rulings R10-1, R10-13; `docs/plan/changelog.md`
  §R10).** `espn_list_recommendations` items, the `espn-ff://rec/week/{week}` items and
  `espn_analyze_retrospective`'s `calls[]` carry the entry's `note` (null when none was logged),
  path-listed as untrusted data (source `store.recommendation_log`) within the log's 200-character
  bound. The Skills quote it as a claim from the log and never follow it.
- **`espn_get_live_scoreboard` counts each side's starters by game state (plan 07 A4).**
  `players { final, live, pending }`: a starter on bye counts as final, an empty slot is not counted.
  The counts are null only when the week's rosters or the pro schedule could not be read, and the
  warnings say so.
- **Fixture-mode session states for the plugin eval (rulings R10-21, R10-27, R10-28, R10-33).**
  Three private variants of the `fx-10h` fixture league: `private-league` (its scripted session
  state governs every league read, with zero requests), `private-league-none` (no session stored)
  and `private-expiring` (a stored session ESPN rejects at the first read the cache does not serve,
  answered as ESPN's 401 would be). Pending claims follow the scripted state. The test-scope key
  `EFF_FIXTURE_SEED` (fixture mode only, read after the fixture guard) lets the eval seed's own
  server fill the cache; no eval run's server carries it, so an accepting probe never disarms the
  scripted 401. All of it is value-free, with no cookie and no network.
- **Reproducible property failures.** A failing fast-check property prints its seed, path and
  counterexample, and `FC_SEED` / `FC_PATH` replay it.
- **Scaffold and supply chain (plan 04 §1–§2).** `.npmrc` (`ignore-scripts`, `save-exact`,
  `engine-strict`, `audit`), `.nvmrc` (Node 24.21.0; engines `>=24.15`), `package.json` with exactly
  four runtime dependencies pinned exactly — `@modelcontextprotocol/server` 2.4.0, `zod` 4.6.7 (the
  one zod the SDK resolves), `hyparquet` 1.31.5, `@napi-rs/keyring` 2.1.2 — and a committed
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
- **CI (plan 04 §4).** `ci.yml` (lint incl. the commit identities and messages — every message the
  head reaches, merges and annotated tags included, scanned for secrets and identifiers; after the
  baseline, Conventional with no AI attribution trailer; a pull request's title as a squash merge
  publishes it, re-checked when it is edited —, typecheck, test + coverage gate,
  supply-chain: `npm audit --omit=dev --audit-level=high`, no install scripts, licenses, full
  runtime tree; pack scan; process), `docs.yml` (Mermaid render with pinned mermaid-cli and an
  explicit `chrome-headless-shell` install, internal links, identifiers, plugin + Skills
  structure and `claude plugin validate --strict`, and `docs-current` — `npm run check:docs`
  regenerates the README's config keys, test keys and registered tools from the config schema and
  the registry and fails on any difference, on a catalog Status the registry contradicts and on a
  cheat-sheet field the tool's output schema lacks; `npm run docs:gen` rewrites them), `secret-scan.yml` (workflow `secrets`; gitleaks pinned by version and
  sha256 over the full history and the tree, plus its self-test), `release.yml` (on a `v*` tag:
  the full gate — `ci.yml`, `secret-scan.yml` and `docs.yml`, each called on the tagged commit —,
  `scripts/ci/check-changelog.mjs` — the tag, `package.json` and a dated
  section here agree — the committed lockfile copied to `npm-shrinkwrap.json`, which `files`
  ships, the tarball scan with `--release` (the packed lock is that lockfile byte for byte),
  `npm pack`, `scripts/ci/check-release-install.mjs` — the README's release install, `npm ci
  --omit=dev --ignore-scripts` then `npm link --ignore-scripts`, run offline on that very tarball:
  exactly the lockfile's runtime tree, and the linked `eff` runs — all in a `contents: read` job,
  then a GitHub Release with the tarball and its sha256, created by the one job that holds
  `contents: write` and runs no dependency code: no checkout, Node or npm — it checks the files
  against the sha256 the build job reported and runs `gh release create`; never `npm publish`;
  `ci.yml`'s pack job rehearses the same steps on every push), Dependabot (monthly, grouped) and a
  pull-request template. Every action pinned by commit SHA; `contents: read` (the release job alone
  `contents: write`); no secrets.
- **Plugin root (plan 09 §4, K8).** `.claude-plugin/plugin.json` (`espn-fantasy-football`,
  `userConfig` for the league id, the season and the toolset — the season and the toolset empty
  by default, so the server reads the current NFL season like the `eff` CLI and the jobs, and
  `config.json`'s toolset or `core`; the toolset option set to `full` gives a plugin install the
  tools the five P1 Skills need) and `marketplace.json` (the repo is its own marketplace),
  `.mcp.json` launching `/bin/sh scripts/eff-launch.sh serve` with no
  `EFF_CONFIG_DIR`/`EFF_CACHE_DIR`, and the POSIX launch shim that resolves a Node >= 24.15 in a
  fixed order and prints the exact fix when none is found.
- **Phase 1a + 1b, read-only (plans 01–10).** The local stdio MCP server with the 18 P0 tools
  (league, roster, players, schedule, standings, matchups and box scores, injuries, transactions,
  status; E1 projections, E2 start/sit, E5 waiver priority with the K/D-ST slice, E12 record and
  E13 retrospective), the P0 resources and the 8 P0 prompts, every third-party string path-listed
  in `meta.untrusted_fields` — wrapped as `untrusted_text`, or a plain string for player names, the
  injury report's statuses and recommendation-log read-back; the `eff` CLI (serve, doctor, setup, refresh, launchd and
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
  `process-macos` job runs the keychain process tests — weekly on whatever branch is built: on the
  schedule (GitHub fires it from the default branch only), on demand, and on a push to a branch
  whose last macOS pass is more than 7 days old.
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

- **Phase 3 — the model wave (plan 10 §3.3; `docs/evals/phase3-summary.md`).** E1 under
  `EFF_TOOLSET=full` serves `model_version: "v2-opportunity"`: for every QB/RB/WR/TE with a game
  history, the first target week's distribution is the opportunity simulation (market-anchored team
  volume, shares with change points, shrinkage per rate, location-based touchdowns from
  ffopportunity, a regressed matchup with ESPN's rating as a comparator, outdoor weather, P(active)
  from the designation and practice trend, the turnover model) around ESPN's mean —
  `weight_espn` stays 1.0 because no backtest under the league's scoring showed a mixture beating
  ESPN alone; K, D/ST and players without history keep the v1 distribution and say why. Held out on
  2024 and 2025, v2 beats a trailing-4 baseline on CRPS (−11 %) and within-position Spearman with
  80 % intervals that cover 77.6–79.4 %. The injury cascade reads a redistribution prior table
  built from 145 historical starter absences (2023–2025 play-by-play). The waiver premium is re-solved from the
  league's own priced waiver runs once a season of them is logged (`premium_basis:
  "league_fitted"`). The seeding chain reproduces every team's `playoffSeed` on all nine recorded
  finished seasons. The K/D-ST model's rare events score every return-TD item a league uses. E10
  reads a per-source calibration table (the official practice report's 2023–2025 history plus the
  news claims the retrospective scores) and shows a posterior once 200 news claims are scored. The
  retrospective attributes each projection-backed call's error by layer (availability, opportunity,
  efficiency, touchdowns, turnovers, anchor, scoring) and stores weekly parameter proposals.
- **`eff tune [--apply] [--revert]` — human-only.** Shows the newest proposal set; `--apply` writes
  `<config>/tuned-parameters.json` (0600) only when the owner types the confirmation word in an
  interactive terminal — refused in an agent session, under launchd and off a terminal; never
  scheduled. The server reads the file once at its next start; `eff uninstall` removes it.
- **Store migration 002.** `parameter_proposal`, `waiver_run` and `scored_claim` (never pruned) and
  three attribution columns on `projection`; a v1 store migrates on the next start with a
  pre-migration backup.
- **`league.keepers` in `espn_get_league` (plan 07 A1; changelog §B7).** The league's keeper
  setting, read from ESPN's draft settings; a keeper league is said in `warnings[]`, and the onboard
  Skill restates it. A field of another shape reads as null, never as a failed settings read.
- **E3's `division_rule` (plan 07 E3; changelog §B8, ruling R8-4).** In a league with more than one
  division, the season simulator seeds division winners first under ESPN's rule reading, as before.
  `espn_analyze_matchup`'s `season` now also ranks every simulated path by record alone and returns
  `division_rule` (`divisions`, `p_playoffs_record_only`, `p_bye_record_only`; null with one
  division or without an ESPN rule reading), and `rec.assumptions[]` states both answers. The
  record-only answer is the stated alternative; every other reading is unchanged.
- **`eff refresh espn:drift` (plan 01 §7, plan 06 §1.2; changelog §B6).** Re-reads, once each,
  every view the stored drift row marks red, through the jobs' provider and limiter on the read
  host. It clears what ESPN serves again and exits 4 while a view stays red. `eff probe` prints the
  stored red diff (`--json`: `stored_red`, `recheck`), and doctor #9 names the command.
- **`eff smoke [--week N] [--json]` (plan 05 §5, plan 06 §1.5, plan 10 A1b).** The live smoke the
  plan documents, run by the owner and never by CI: the settings, one roster, one pool page, one
  completed week scored per stat and in total against ESPN's applied points, and the keyless probe
  diff, all through the one provider. It prints counts only and exits 0 on a pass, 1 on a failed
  check, 3 when credentials are not configured or rejected (a private league with no cookies
  stored included; plan 03 §1.3) and 4 on drift.
- **`eff transactions --backfill [--seasons …]` (ruling R6-3).** Stores the league's previous
  seasons' transactions (every scoring period; idempotent), so the waiver premium can be fitted from
  the league's own history on its first call. A season ESPN does not serve is skipped and said.
- **`eff refresh espn:settings` (plan 08 §6, §9).** Re-reads the league's settings now, once (one
  request, read host only), in place of waiting out their 24 h cache after a commissioner's scoring
  edit; a changed hash raises `settings_changed`. A box score whose per-stat golden finds a
  league-wide mismatch with a cached copy of the settings marks them dirty, and says so.
- **A10b's question set (plan 05 §6; changelog §B4).** `tests/evals/read-only.xml`: ten read-only
  questions over `fx-10h`; every push re-derives each answer from the built server under both
  toolsets. The model-graded run itself is manual and comes before a release.

### Changed

- **A missing or rejected ESPN session (rulings R10-7, R10-10, R10-11, R10-17 to R10-19, R10-23).**
  On a public league the transaction feed is read without cookies whenever no accepted session is
  at hand (nothing stored, or a session ESPN rejected), in the server and in the transactions job.
  Pending waiver claims are never read without a session, public league or not:
  `espn_list_transactions(pending: true)` answers `pending: null` with the reason and `eff setup`,
  and makes no request. With nothing stored, a league already known to be private answers
  `ESPN_REQUIRES_COOKIES` with no request (the private finding is trusted for 7 days, then checked
  again). A read the session cannot make spends none of the call's three-request budget and is never
  answered from stale cache. Under a rejected session the launchd jobs keep plan 06 §1.4 (only
  `eff transactions --force` reads a public league's feed without cookies), and
  `eff transactions --backfill` after `eff setup` first fills the weeks of this season the job
  missed; `--seasons` may name the current season.
- **A session refusal is said, never read as "unavailable" (rulings R10-11, R10-12).** When a tool
  goes without a read the session refused, the answer is `partial: true` with one fixed line naming
  what was not read, why, and `eff setup`, in every tool and resource (a 135-case sweep holds it). A
  refusal on a read the tool needs is still the call's coded error.
  `espn_analyze_league_activity` answers from the server's persisted history, labelled partial,
  when the session cannot read ESPN's feed on a league not known to be public.
- **`espn_analyze_trade` under `seeding_mode: "both"` (ruling R10-2).** `why_they_accept` gives the
  partner's standing once per reading, each line named and from that reading's own P(playoffs).
- **`espn_analyze_lineup` (rulings R10-22, R10-24, R10-29).** A `compare` pair is scored only as the
  direct swap it names (the outgoing player starting, the incoming one on the bench and eligible for
  the slot, neither locked); any other pair comes back as a warning with its reason and is never
  scored. The trim warnings name `swaps` and `rec.subjects`, never `rec.lineup`, which is the
  mean-optimal assignment. The option-value verdict is true in every case. `espn_cross_check`
  compares ESPN's projection with the own model's line (`espn_project_players` `inputs.own`). A
  swap whose interval only reaches 0 is no longer a coin flip.
- **`espn_analyze_evidence` (plan 07 E10; rulings R10-30, R10-32).** A health claim explains a usage
  drop while ESPN lists the player QUESTIONABLE, DOUBTFUL, OUT or IR, never a rise, and a mixed move
  (one measure up, another down) stays `quiet_role_change`. An injury reported against ESPN's
  ACTIVE is an availability conflict on `injury_status` unless the same clause says he plays in the
  coming game, with nothing else after the plays phrase but that game's day, its opponent or who
  reported it: a condition, a hedge, an alternative ("or sit"), a later week or "week N" leaves the
  conflict standing. "No ACL tear" reports no injury.
- **Truncation keeps whole items (rulings R10-20, R10-25).** `espn_analyze_retrospective` keeps the
  most whole calls that fit its 10 000-character cap (5 of 100 worst-case calls, was 3), and its
  warning gives the calls kept per kind and names `kinds` as the way to narrow it.
  `espn_list_recommendations` keeps the most whole entries that fit its budget (20 of 25 at the
  worst case, was 12); `next_offset` pages on.
- **`espn_analyze_schedule`.** A week's row is the same whatever other weeks are asked for; a week
  before the current one is dropped with a warning, and a call that asks only for such weeks is
  refused.
- **Injection flags.** `json_like` marks only text that opens like JSON; bracketed chat-role tags and
  tool tags (`[system]`, `[INST]`, `[TOOL_CALLS]`, `(system: …)` and the like) are `role_marker`.
- **The Skills (rulings R10-1 to R10-8, R10-10 to R10-15, R10-20 to R10-34).** A rejected session
  mid-procedure follows orient's split: on a public league the keyless reads go on; on a private or
  unknown league the Skill presents what was read, labelled partial, says what was not read, and
  hands over to `session-check` (guardrail 5 follows it). A positional reference ("my RB1") asks
  only when no rostered player at that position holds the rank. `trade` opens its recommendation
  with the devil's-advocate paragraph, then the tool's verdict, then its own; `start-sit` and
  `weekly` show the lineup from `rec.subjects` and read the live scoreboard's game-state counts;
  `retro` reads a truncated retrospective by its per-kind counts; `news-check` reads the evidence
  flag as the tool does; `injury-cascade` treats an injury as confirmed only by ESPN's status or the
  official report. A Δ interval that spans 0 is a coin flip; one whose best case is 0 is held as
  gaining nothing (R10-34). `check-skills` holds every fixed sentence, and the Skills listing is
  4 591 of 4 600 characters.
- **The plugin eval suite (rulings R10-3, R10-8, R10-14, R10-27, R10-28, R10-31, R10-33).** New
  cases on the private variants (the hand-off on a rejected private session, the probe that accepts
  after `eff setup`, a briefing whose session ESPN rejects mid-procedure), two retrospective
  truncation cases, and graders anchored to their claims: the build refuses a final-message grader
  that a reply's fixed lines, orient's opening lines or the case's own prompt satisfy.
  `--baselines` attaches a passing kept run, else the best-scoring one, and names how each base was
  chosen. A build without `--seed-datasets` lists the cases whose counts need the dataset excerpts
  as not testable.
- **Dependencies, reviewed under plan 04 §2 (Dependabot PRs 1–5, 2026-11-04 to 2026-11-05; ruling
  R10-35).** The MCP SDK 2.3.1 → 2.4.0 (`@modelcontextprotocol/server` and `core`, and the dev
  `client`; `espn_get_status` reports `sdk_version` 2.4.0): 2.4.0 adds the Skills extension on new
  subpaths this server never imports, and the stdio path and both protocol eras are unchanged.
  `@napi-rs/keyring` 2.1.0 → 2.1.2: the macOS binaries are Developer ID-signed and notarized, and
  each platform package ships its linked crates' licences (`LICENSE.third-party.md`), which
  `check:no-scripts` admits as a licence notice by name; a licence inside a prebuilt binary is
  decided in its Reviews row (R10-35). `hyparquet` 1.31.2 → 1.31.5 (parquet decoding fixes). The dev
  toolchain: vitest and `@vitest/coverage-v8` 5.0.5 (vite 8.3.5), eslint 10.13.0, prettier 3.9.10,
  typescript-eslint 8.72.1 and `@types/node` 24.19.2. CI actions: setup-node v7.1.0, upload-artifact
  v7.0.2, download-artifact v8.0.2. Declined: `@types/node` 26 (its types accept APIs Node 24 lacks)
  and TypeScript 7 (typescript-eslint does not support it yet); Dependabot skips `@types/node`
  majors and TypeScript 7.x until their re-check triggers (`docs/plan/changelog.md` "Reviews").
- **Skills on a public league with no stored session (rulings R9-1, R9-2; `docs/plan/changelog.md`
  §R9).** They say so in one Session line and answer keylessly instead of stopping at setup; a
  private or unknown league still hands over to `session-check`. "My RB1", "my WR2" and "my TE" name
  that position's starters by ESPN's week projection.
- **Every E1 call stores its first-week projections** (best-effort, deduplicated) — the
  retrospective's attribution input; analytics answers list each input in `data.inputs` once.
- **E2's `auto` objective** follows the committed regret-test record: `mean` (the held-out replay
  of what `full` serves — v2-opportunity — found too few lineups where `pwin` differs to switch).
- **The seeding simulator samples each team's strength.** A team modelled from its season to date
  (the cold start, or an E1 projection updated by it) now has its weekly mean drawn once per
  simulated season from its posterior (sd σ/√(n + 4)), so early-season P(playoffs) — and E2's
  points-for exchange rate — is no longer over-confident about the order; on nine recorded
  league-seasons the Brier score improves at weeks 4, 8 and 12.
- **The news matcher's shared names (plan 07 D6; rulings R8-6, R8-7, R8-8; changelog §B9).** When
  several players share a name, precision comes before recall. Only a label written next to the
  name picks a holder (0.95): a team or a position directly before it, in parentheses after it, or
  in the headline's name tag. The prominent holder takes the item (0.80) only when the item names no
  team and no position. Otherwise no player ref is given, and the news refresh counts the item as
  unresolved in its warnings. Names one player holds match as before, and matching time is linear in
  the item's length. A shared name's item that names a team but carries no label goes unlinked, with
  ESPN's own status still behind the player. The matcher is frozen for Stage C; its known
  limitations are listed in `docs/evals/stage-c-backlog.md` ("Known limitations of the news matcher
  (R8-8)").
- **E10's multi-player items (ruling R7-4; changelog §B5).** In a text that names more than one
  player, a claim is the subject's only when its clause names no other player, opens with his name
  and states the claim of him directly. Every other claim is listed under
  `ambiguous_multi_player[]`, wrapped, and is never logged, scored or weighed.
- **E2's no-move (ruling R7-1).** A swap inside the coin-flip band gives `no_move: true` and is
  logged as a no-move, which the retrospective scores as "keep". E2's mean-optimal assignment is
  unchanged.
- **A league 404 while the new season awaits renewal (research 03 §A.4).** From July 1 an unset
  `ESPN_SEASON` is the new season, which ESPN serves only once the league's manager renews the
  league. Until October 1 of the configured season, a 404 on that season now carries
  `reason: season_not_renewed` and a fixed hint (set `ESPN_SEASON` to last season until the renewal,
  then unset it) in place of "the league id may be wrong". The Skills' error table, `eff setup`,
  `eff check-auth`, `eff doctor --online` rows 16 and 17, the daily probe and the credential check
  say the same, and the two jobs send no failure notice for it. A past season's 404 reads as before.
- **STALE_ONLY's hint (plan 01 §4.3; changelog §B6).** One fixed hint per dataset source: "Retry
  with allow_stale: true, or run eff refresh `<id>` in a terminal."
- **The release install (plan 03 §4.3; changelog §B4).** `eff print-config`, `eff install-launchd`
  and `eff doctor` name the README's release install (an unpack, `npm ci`, `npm link`) where they
  used to say `npm install -g`.

### Fixed

- **The Linux CI stall (plan 10 A16a).** SQLite's automatic WAL checkpoint ran inside a commit on
  the event loop: on the Linux CI runner one cache `INSERT` held the loop 36–89 ms, waiting on I/O.
  `eff serve` now runs PASSIVE checkpoints on a worker thread with its own connection, at SQLite's
  1 000-frame threshold; if the worker fails, checkpoints return to the connection with a store
  warning. The CLI keeps SQLite's own checkpoints. Every CI run reports the stall evidence (the
  longest gap attributed to SQLite, synchronous file calls, `Atomics.wait`, GC and scheduling) and
  each P1 tool's longest CPU run as notices.
- **Long CPU runs split into steps (plan 03 §1.2; ruling R10-9).** `espn_analyze_evidence`,
  `espn_analyze_trade`, the large roster parse and cache strip, a tool result's serialisation and
  check, the claim-rule compile, the matchup season simulation, the replacement values, the
  injury cascade, league activity, player search and nflverse's weekly stat lines now give up the
  event loop once a step has spent 8 ms of CPU. Every P1 analytics tool's longest CPU run stayed
  under the 20 ms batch on three Linux CI runs in a row; answers are unchanged (compared byte for
  byte, cold and warm). A stall window the host set is judged by the server's own longest CPU run
  (R10-9). The news matcher's work is counted and held linear by count (R10-16).
- **Answers that changed with the clock alone.** The result budget counts every input's `age_s` at a
  fixed width, so an answer near its cap is trimmed the same way a second or a minute later.
- **The season simulation's clinched and eliminated flags** are exact when no game is left in a
  league with divisions and coin-flip ties (found by a property test).
- **A rejected cookie is never sent again** — not by a read already in flight, and not when another
  process (a launchd job, a second server, `eff doctor`) recorded the rejection; the credential
  authority adopts a rejection from the shared metadata without loading the rejected value.
- **E13's optional reads.** `espn_analyze_retrospective` absorbs only what an optional read may lose
  (an outage, a session refusal, a stale dataset, fixture mode's missing fixture); any other error
  now fails the call (a bug as `INTERNAL`) instead of reading as "unavailable".
- **Fixture mode's file reads.** Every fixture file, its manifests included, is read through one
  path resolver and one regular-file reader: an empty, absolute or `..` manifest path, an absolute
  or sideways root, a symlink out of the tree, a file over the size bound, and a FIFO, socket,
  device or directory are refused, before a byte is read; a FIFO had blocked the process inside
  fetch. A derived variant whose league settings cannot be read refuses to start.
- **The release-install check** pins npm's log level, so a run under a silent npm script still
  reports why `npm ci` failed.
- **§R10's other fixes.** Rulings R10-1 to R10-34 and their fix rounds (2026-11-04 to 2026-11-05)
  fixed many smaller defects in the tools, the Skills and the eval suite, each with a regression
  test that fails without it. They are not itemised here: the commits on `build/phase-1` record each
  one, and `docs/plan/changelog.md` §R10 the rulings.
- **The supply-chain checks in a checkout under a UUID-named directory.** npm prints a UUID-shaped
  run of a path as `***` in `npm ls`; `check:licenses` and `check:no-scripts` map such a path back
  to the installed package instead of failing ENOENT.
- **The hourly transactions job after the week's rollover (found on the owner's install,
  2026-11-03).** An `mTransactions2` answer on ESPN's recognised base (its own `draftDetail` object)
  without a `transactions` list is read as the empty week, unless ESPN's count header says there are
  moves. Before, such an answer (most likely a week nobody had moved in yet; ESPN's cookie-bearing
  shape is not recorded) failed the job `ESPN_DRIFT_DETECTED` at every run and turned drift red. `{}`, a 200 carrying ESPN's error envelope and the
  unrecognised-view answer stay drift, for both transactions views. The first such answer per view
  is logged at info with its key names and ESPN's count, and it clears no red row unless ESPN counts
  0. The job fails as drift when a period that listed executed moves later answers without the list.
  `eff refresh espn:drift` re-reads the job's recorded period (it sent no request for this view
  before).
- **`espn_analyze_league_activity` on a cold cache.** It reads the standings before the weekly feeds
  and answers partial, not NOT_FOUND, when no read named a team.
- **The ACL check as the Mac wakes.** An `ls -ledq` listing that did not complete (a timeout, a spawn
  error, a signal) is run once more; everything it refuses is unchanged, and two incomplete listings
  hold the second run off for 30 s.
- **Phase 3 event-loop stalls.** v2's scoring scores 128 samples per cooperative step
  (`V2_SIMS.scoreSlice`) and the matchup table scores a week in slices. The two stalls this entry
  left open are fixed under §R10 (above): a cold `espn_analyze_evidence` gives up the event loop
  every 8 ms of CPU, and Linux CI's `full` P1 analytics window stall was SQLite's WAL checkpoint,
  now on a worker thread.
- **Drift.** A composite read (several views in one request) is compared against the union of its
  views' observations, and integer-keyed maps no longer read as additive drift.
- **Event-loop stalls on large cached bodies.** JSON without `__proto__` or escapes parses on the
  native fast path, and the provider yields to the event loop before parsing a cached body over
  64 KiB and before building an envelope.
- **Record recommendation.** An onboarding record may cite the last final week's box score.
- **Bounds.** `n_sims` is capped at the measured `N_SIMS_MAX`.
- **Write host spelled once.** The keyless fixture and probe tooling refuses the ESPN write host by
  importing the one constant in `src/config/schema.ts`; the Phase W test scans `scripts/` too.
- **Refresh spacing.** A release refresh no longer waits 15 minutes between its version poll and
  its downloads: the GitHub poll keeps its 15-minute limit and a run's assets are spaced 1 s apart.
- **Event-loop stalls in the P1 tools.** The provider's freshness context is reused for a second
  instead of re-reading the season's schedule on every read, a large fresh body yields between its
  parse, drift check, schema check and cache strip, and the heavier P1 tools yield between their
  synchronous steps (measured 37 ms worst case against the 50 ms bound).
- **`espn_get_status` past 11.6 days of dataset age (plan 07 G1; changelog §B6).** A dataset
  source's and a freshness class's `age_s` are whole seconds with a wide bound; before, the output
  schema refused the whole answer as INTERNAL.
- **Holds after a backward clock step (plan 01 §6; changelog §B6).** The ESPN breaker's open window,
  ESPN's Retry-After hold and `espn_check_auth`'s once-a-minute gap last their own length at the
  most, never the clock's skew.
- **E6's ΔU horizon (plan 07 E6; changelog §B6).** A trade's regular-season points are divided by
  the weeks of my undecided regular-season matchups (`marginal_weeks`), not by the value weeks.
- **D6's id selection (plan 07 D6; changelog §B6).** Every asked id is matched by itself, whether or
  not the pool read returned the player; an id nobody knows is counted "not found".
- **Doctor #14 (plan 03 §5; changelog §B6).** The server time adds the `Age` a cache in front of
  ESPN reports, so a CDN copy's minutes-old `Date` no longer reads as clock skew.
- **The plugin's own `.mcp.json` in a clone (plan 03 §5 #2; changelog §B7).** Doctor row 2 lists it
  as the plugin's own file, never as a client registration, and `eff uninstall` leaves it instead of
  printing a `claude mcp remove --scope project` that would delete the plugin's server from the
  clone. A client entry that uses a plugin variable is a hard row-2 problem.
- **`eff transactions --backfill` past the 30-a-minute window (plan 01 §6; found at the owner's
  install, 2026-11-02).** The default run's ~37 reads met the limiter's full window part-way and
  died RATE_LIMITED. The run now paces itself at 24 reads a minute, waits out a full window or
  ESPN's Retry-After (one stderr line, the same read retried, within a bound), and stops on Ctrl-C
  (at once during a wait); a spent daily cap and repeated concurrency refusals fail as before. A
  re-run more than a day later waits the same way: the weeks it cached are then past their hard
  limit, and the stale-cache fallback had reported the refusal as STALE_ONLY, which the run did not
  wait on. A window that another process filled is now waited for before the read starts, so the
  request keeps its whole 20 s deadline (a wait ending in the deadline's last moments had made the
  request time out). After Ctrl-C no request is sent (a read waiting inside the limiter had sent up
  to 20 s later), and the run's share counts requests, retries included: at most 24 in any minute.
  Once its bound on waiting is spent, the run now stops (exit 1, RATE_LIMITED, saying what it
  stored) instead of sending past that share: beside a busy server it had filled the shared window.
  A read that Ctrl-C cuts is never counted as done, even when the stale cache answers it (a Ctrl-C
  during the last read had ended the run 0). Rows stamped ahead of the clock (a clock since set
  back) no longer hold the run waiting: only the next request re-stamps them.
- **Stage C's other fixes.** QA and penetration testing (rounds 0–3 and the final gate's fix
  rounds) fixed many smaller defects, each with a regression test. They are not itemised here: the
  commits on `build/phase-1` record each one, and `docs/plan/changelog.md` §B4–§B9 the records
  written back during Stage C.

### Security

- **`vite` 8.3.2 → 8.3.5** (dev only, through vitest 5.0.5; Dependabot PR 2): GHSA-698v-4r3x-3vcv,
  GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm, GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22 and
  GHSA-vfpm-58rq-9qcg, all in the dev server's HTTP paths, which vitest never starts here; the
  runtime audit was 0 throughout.
- **The recommendation log refuses text that becomes credential-shaped once read back** (entities
  decoded, tags dropped), not only text that is credential-shaped as written: `SWID&#61;&#123;…&#125;`
  used to pass and come back as `SWID={…}`. The same check covers every bounded model text (E12's
  text fields, E10's claim, prompt arguments).
- **The MCP SDK 2.2.0 → 2.3.1** (`@modelcontextprotocol/server` with `core`, and the dev
  `@modelcontextprotocol/client`): GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq
  and GHSA-6prh-2h8m-c8cw, all in HTTP-transport, bearer-auth or redirect code that this stdio
  server never runs. **`zod` 4.6.5 → 4.6.7**: GHSA-mrhx-c7xc-m3w5 (an over-long array, map or set
  was parsed element by element before its size check failed). Both bumps were reviewed statically
  (diff, install scripts, dependencies, provenance, licence) and are recorded in
  `docs/plan/changelog.md` "Reviews"; the runtime tree keeps its six names, and a test holds the
  lockfile out of the advisories' ranges offline.
- **`eff setup` keeps the cookie off the screen (ruling R7-3; changelog §B5).** Echo is off at the
  terminal for the whole of `eff setup`. Only a visible answer is drawn, by the prompt's own code;
  input that arrives before a question is dropped unshown and said; a hidden answer with a line
  break, or sharing a chunk with another answer, is refused and re-asked. A property test over
  random chunkings holds that no `espn_s2` byte is ever written.
- **No redirect from the read host is followed (plan 01 §4.3, §7).** Every 3xx the read host
  answers is ESPN_HOST_MOVED, wherever its `Location` points, in the CLI's HTTP client as in the
  provider. Before, the CLI followed a redirect to another path on the read host and re-sent the
  cookie, so `eff probe`, doctor row 15 and `eff smoke` judged green what every tool reports as a
  host move.
- **No ESPN request while certificate verification is off.** With `NODE_TLS_REJECT_UNAUTHORIZED=0`
  (often inherited from a shell), the provider and the CLI send nothing to ESPN, with or without a
  cookie, and `eff setup` refuses before it asks for the cookies, naming the fix
  (`NODE_EXTRA_CA_CERTS` for a proxy's CA). `eff status`, the server's start-up log and doctor say
  so.
- **The setup page holds no password field (plan 02 S1, §2.2).** `eff setup --page` takes both
  values in plain text areas, so no browser or password-manager extension offers to save `espn_s2`
  to a synced password store, and every POST is answered with a redirect, so the browser's history
  never keeps the posted values.
- **A league member's Markdown is inert (plan 02 §6.2).** A link, an image or a link definition in
  a team name, a trade block or any other text a member writes reaches every answer as text that no
  Markdown client renders as a link, entity-encoded and invisible-character forms included.
- **The `0700`/`0600` checks read macOS ACLs (plan 02 §2.2, §8 #1).** A file or directory whose
  access control list gives anyone but the owner access is refused and named by doctor, and one
  that cannot be read fails closed; the directories `eff` creates drop an entry their parent passes
  down. Before, an inherited ACL could expose the config, the session file and the store while their
  mode bits read private.
- **A prompt's undeclared argument key is refused (plan 07 §4.2; changelog §B8).** Every prompt's
  arguments are strict: a key the prompt does not take, `__proto__` included, answers -32602
  "unknown argument key (this prompt takes: …)" and is never quoted. Before, the prompt rendered
  with the key stripped.
