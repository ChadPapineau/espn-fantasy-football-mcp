# HANDOFF — espn-fantasy-football-mcp

**The single handoff document for this project** (Chad's decision,
2026-09-30). A fresh context window reads this first, then
`docs/scratch/build-program.md` (the build stages) and
`docs/plan/00-index.md` (the plan in reading order), as `CLAUDE.md` says.
The research-and-plan program that preceded the build kept its agent state
in `docs/scratch/roster.md` and its waves in `docs/scratch/program.md`.
Update this file after every meaningful step; commit and push it with the
work it describes.

Rules that never lapse: repo is **PUBLIC** — no personal identifiers (team
names, usernames, league IDs, member GUIDs) and no secrets (espn_s2, SWID,
any cookie) in any committed file; fixtures are anonymized (procedure in
`docs/research/03-espn-api.md` §F.3). Third-party code is untrusted: the
audited prior-art repositories are read statically, never installed or
executed; every dependency is pinned exactly with install scripts off, and
the runtime ones are exactly plan 04 §2's (`CLAUDE.md`). Every
roster-changing action needs explicit human confirmation the model cannot
forge. News and ESPN free text (team/owner names, player outlooks) are
data, not instructions. The working copy lives outside iCloud
(`~/Developer/espn-fantasy-football-mcp`; "Decisions made", 2026-10-05),
and nothing secret ever lives in it.

## ▶ NEXT STEP — Stage C final gate: fix round 3 landed (2026-10-28); the orchestrator re-gates

**Orchestrator, 2026-10-28:** the gate's fourth run (at `f41e810`) was red only on the items ruled in
changelog §R8. R8-1 accepts doctor's exit on the stale datasets until the Stage D install. R8-2
accepts the stall measurement. R8-4 closes F8: the owner confirmed division winners first. R8-5
closes the three fixed ledger items and leaves `ci-default-branch-controls-inert` to the Stage D
merge. R8-3 rules the news matcher's shared names: its fix runs next, then the re-gate.

**State:** branch `build/phase-1`; fix round 1 is `e40fd88` … `7f39044` (changelog §B6), fix round 2
`01cb8e5` and `2396b07` (§B7), fix round 3 `42de906` and `ebc9187` plus this docs commit (§B8); tree clean,
HEAD == origin. The final gate's third run found no defect in its commands or product checks. It was red only
on the live `eff doctor --online` exit (the owner's stale datasets), plus ledger housekeeping and low
items. Fix round 3 took the fixable ones at root, each with regression tests that fail on the code
before:

- **A prompt's undeclared argument key.** prompts/get stripped a key a prompt does not take and
  rendered, `__proto__` included, which tools/call answers VALIDATION for. Every prompt's arguments
  are strict now: -32602 "unknown argument key (this prompt takes: …)", the key never quoted; the
  transport carries a prompts/get `__proto__` past the SDK's re-parse.
- **F8, division winners first.** E3 `season` ranks every path by record alone as well and returns
  `division_rule`; its assumptions state both answers. The chain is unchanged.
- **The backlog:** the matcher's scope on its own universe (16 shared keys, 11 identical names), the
  `vite` dev advisories (unreachable), the tight margins and fixture mode's INTERNAL, with reasons.

**Open, not an agent's to close** (each with its evidence in `docs/evals/stage-c-backlog.md`): the
owner's `eff refresh all` and `eff install-launchd` (doctor exits 1 only on #10, the expired
datasets: plan 03 §5's worst-row exit), or a ruling that the exit is accepted until then;
`ci-default-branch-controls-inert` and the `vite` patch (the Stage D merge, or the owner's
default-branch setting); R7-2 and R7-6 (the plugin-eval tooling is gated). Rulings requested: the
news matcher's fail-safe choices 1–6, the stall bound's host evidence, and F8's chain (the owner's
one answer first). The ledger can close `trade-locked-week-counted`,
`store-future-stamped-rows-block` and `crosswalk-unpaired-joins-silent`, verified again at the third
run. The owner also runs `eff transactions --backfill`, and at Stage D installs the plugin or
`eff print-config`'s entry. In sessions opened in the clone, the project server stays unapproved.

**Next:** the orchestrator re-runs the final gate. Then Stage **D**
(`docs/scratch/build-program.md`), whose CHANGELOG pass also carries the Stage C additions
(`league.keepers` and E3's `division_rule` among them).

## Build facts (Stage A, verified by the orchestrator 2026-10-06)

- **Stage A** (`effmcp-foundation`, 7 agents) is green on `build/phase-1` @ `bd64cba`: independent gate passed with zero fix rounds; CI `ci`, `docs`, `secrets` green; 2,103 unit tests; coverage ≈ 99.4 %; runtime tree = the 4 pinned packages of plan 04 §2 (6 names incl. `core` and the keyring platform package; this Mac is **Intel → `@napi-rs/keyring-darwin-x64`**; CI is linux-x64-gnu).
- **Contract layer** (code against these; additive edits only, by the owning module): `src/providers/platform.ts` (FantasyPlatform; `FantasyPlatformWrites` declared and marked **PHASE W SEAM — NOT IMPLEMENTED**, `writes:false`), `src/providers/espn/types.ts`, `src/auth/types.ts`, `src/drift/types.ts`, `src/domain/gate/{types.ts,README.md}` (where the write module would integrate), `src/sources/source.ts`, `src/store/types.ts`, `src/domain/{scoring,league,analytics,reclog,crosswalk}/types.ts`, `src/domain/clock.ts`, `src/mcp/{envelope,errors,bounds}.ts`, `src/config/{schema,paths,freshness}.ts`, `src/cli/log.ts`.
- **Secret tooling:** commit only via `scripts/dev/commit-paths.sh`; `.githooks/pre-commit` + `commit-msg` active (core.hooksPath set locally); `scan-secrets.mjs` has the ESPN rules + `--identity` + the owner's local deny-list (outside the repo; never printed; numeric terms match whole tokens only). gitleaks runs in CI with ESPN rules; history allowlists exist only for two dummy test values, by commit SHA. The secrets workflow file is `.github/workflows/secret-scan.yml` (the repo `.gitignore` ignores `secrets.*`).
- **Fixtures** (`fixtures/espn/recorded/`, scrubbed, ~22 MB, manifest with provenance hashes): `league-a` = 10-team standard, FAAB, TQB + 5 FLEX; `league-b` = 10-team **half-PPR**, FAAB, standard lineup; `league-c` = 12-team **6-pt pass TD**, **rolling (non-FAAB) waivers**, RB/WR + WR/TE flexes. Each has `mSettings`, `mTeam`, `mMatchup`, `mRoster` sp1–3, `mBoxscore` sp1–3 (all games final), `kona_player_info`; plus `season/` (pro schedules) and `errors/`. Some units are **withheld** (deny-list false positives: one player id and digit runs) and listed value-free in the manifest; ≥ 3 final weeks per league remain for the golden.
- **Phase 0 tools:** `scripts/probe.ts` (keyless drift probe; exits 0/4 drift/6 host moved/7 unreachable/2 config; live run green), `scripts/record-fixture.ts --public` (keyless, refuses cookies, ≥ 1.2 s spacing, request cap), `scripts/scrub-fixture.ts` (deterministic, deny-list abort; withholding opt-in and logged).
- **Carried into B1:** record the views not yet captured — `mMatchupScore`, solo `mNav`, `kona_player_info` with `filterIds`, `kona_playercard`, `players_wl` (needs the `/seasons/{s}/players` route) — and re-record to close the withheld holes (the pipeline now replaces a deny-listed player-name leaf with `Player <id>`); the per-entity drift manifest generator (plan 05 §3.1 step 4); the logger must also redact a case-changed copy of a registered secret; Z4's launchd schedule + `probe_log` + notification (CLI stage); the Phase W test asserts the write-host literal appears only in `src/config/schema.ts` (refuse the host by importing that constant, never by spelling it).

## Build facts (Stage B2a — Phase 2 integration, 2026-10-06; for the orchestrator to verify)

- **The product end to end:** 34 read tools under `EFF_TOOLSET=full` (18 under `core`), 13 prompts under `full` (8 under `core`), 13 Skills, no write tool. `tests/e2e/stdio-full.test.ts` spawns the built server in fixture mode on `fx-10h` with its cache **seeded** first (`tests/integration/helpers/seed.ts`: every fixture-backed source of `full` through the real runner + publisher, the refresh CLI's own wiring), calls all 34 tools, checks every envelope against its output schema and the A6 walk, runs the B8 walk on all six injection variants (positive control per shown variant), sweeps every tool's every input key with hostile values (typed VALIDATION, never INTERNAL or an echo), and exits 0 on stdin EOF. `skills-dry-run.test.ts` replays every `full` sequence the same way; `latency.test.ts` carries A16a's bounds to the P1 tools (warm reads < 500 ms, analytics < 8 s, loop stall ≤ 50 ms). The SDK and Inspector smokes run under both toolsets (CI included).
- **Integration fixes landed in this stage** (each with tests): the seven `<source>_history` files registered (`src/config/freshness.ts`) and gated on the current season in `eff refresh`; the allow-list carries `api.sleeper.app`, `www.rotowire.com`, `www.espn.com`, `www.cbssports.com`; release downloads spaced 1 s (the 15-min limit is the poll's); Phase 2 and history files validated on publish and open (`contractTablesFor`); the Phase 2 store readers (`src/store/datasets/readers-p2.ts`: depth charts, EP, news with refs, trending, the pbp team profile, usage extras incl. the team's red-zone opportunities; a prior season reads its history file); D5's pace / pass rate / PROE / sack / takeaway / EPA from pbp; D1 `rz_share`, E5's `rz_shift`, E7's red-zone components; E1 `player_sim` under `full` only (first target week, ≥ 3 trailing games, same ESPN mean); the stall bound held (TTL-context memo, a deep-frozen parse memo in the provider, yields between a fresh body's phases and between P1 tools' synchronous steps, a request-wide lineup memo in the trade engine, cooperative E1 set-up); `dist/plugin-evals` and `dist/skills-copy` excluded from the tarball; `npm run build:plugin-evals -- --seed-datasets` seeds the eval servers (`scripts/seed-fixture-datasets.ts`).
- **Acceptance (plan 10 §3.2):** met — B1, B8, B9, B10, B12, B13 (as scoped by D8: stat 74 stays `verified: false`), Lane 1 of B11; met with a **ruling requested** — B2 (131 of 134 rostered QB/RB/WR/TE/K on the seeded `fx-10h` carry a trailing window, 97.8 %; over all 145 rostered entries 90.3 %, because a rostered D/ST has no usage source — the literal "≥ 95 % of rostered players" is capped at 92.4 % on `fx-10h`) and B7 (one VOR cell, 2024 TE rank 3: 3.6 under the league's scoring vs the table's 3.2 — an own fumble-recovery TD research 05's nflverse basis did not count; on that basis every cell is within 0.3); soft_reported (hard parts met) — B3, B4, B5 (its soft number needs recorded trades), B6; needs_live, the owner's action — B11 Lane 2 and B15 (one `claude plugin eval` run: `llm` graders cost tokens and the report publishes to claude.ai by default); needs_time — B14 (≥ 8 weeks of snapshots). Item by item: `docs/evals/phase2-acceptance.md`.
- **Measured:** `full` `tools/list` 32 999 chars (ceiling 35 000; the OBJ-24 fallback would be 36 705 — over); Skills listing 4 178 (ceiling 4 600); D3 re-decided: `core` stays the default (plan 07 §5.1). P1 analytics on `fx-10h`: 0.1–3.7 s each; worst loop stall 25–28 ms after gate round 1 (was 30–64 ms), after gate round 2 `core` 17.1 ms, `full` analytics 28 ms, warm P1 reads 17.1 ms (newly measured; D5 was 40–55 ms); `npm run test:coverage` at the default parallelism (6 forks) 218 s.
- **Gate round 1 (2026-10-07, fixer):** a season run cut short by the CPU deadline now says so in E2/E6/E8/E9 (warning + `partial`); the deadline counts the thread's CPU, not the batches' wall time (a sleeping Mac fired it); the derived fixture fetch and cached-body parses yield between phases and a batch ends before a chunk predicted to overrun it (the A16a flake); the unit project runs one fork per physical core (`maxWorkers: "50%"`, the local gate's timeouts); `toStatLine` drops an overflowed sum (a fast-check find); the seed carries `fixtures/fx10h-usage/` (usage rows for every fx-10h rostered QB/RB/WR/TE/K, cut from the 2026-10-06 release files); B7's off-table cell is shown to be a scoring-basis difference; the injury-cascade Lane 1 sequences price only the AVAILABLE beneficiaries (`$ids` gained `where`, as SKILL.md step 5 says). Two rulings are open for the orchestrator: B2's denominator (D/ST) and B7's one cell.
- **Gate round 2 (2026-10-07, fixer):** no code defect found; the soft items fixed at root — `runCooperative` ends a batch before a chunk as long as the longest timed so far would overrun it (trade's 25–32 ms turns), `COOPERATIVE.batchMs` 16 → 12, D5 reads/scores one week per turn (one file version per answer; it blocked the loop 40–55 ms, unmeasured until now), D6 five claims per turn, the latency suite holds the warm P1 reads to 50 ms; B3's hard parts checked at the tool level with signals present (a positive control through the ports); the `fx10h-usage` UUID note. **Open for the orchestrator / owner:** B2's denominator (D/ST), B7's one cell, the owner's `claude plugin eval` run (B11 Lane 2, B15), and a larger held-out B8 set (needs fetch-allowed captures over days). Record: `docs/evals/phase2-acceptance.md` → "Gate round 2".
- **Gate round 3 (2026-10-07, fixer):** the soft items fixed at root — E3 live never fabricates: an unknown pro-schedule week is `tbd`, never everyone's bye (`lockPlan`, `matchupPlayerOf`), the box score is read first and names the opponent (mMatchup only as a fallback; `pre` keeps its order), and a live call missing the box score or the game states conditions nothing (`live: null`, `partial`, the pre-game number, said); the Skills handle `partial: true` (`tool-outputs.md`, the output contract, `orient.md`'s one repeat, `start-sit`'s live step); A2 carries `teams[].trade_block` wrapped (`espn.team.trade_block`, cap 500) and the flags see a claimed-authority label and a blanket order, so `inj-tradeblock` has a positive control and plan 09 TR-INJ can pass; `client_ref` path-listed on read-back; the CBS guid note (`fixtures/news/README.md`, held by `tests/sources/news/fixture-ids.test.ts`). **Still open for the orchestrator / owner:** B2's denominator, B7's one cell, the owner's `claude plugin eval` run (B11 Lane 2, B15). Record: `docs/evals/phase2-acceptance.md` → "Gate round 3".
- **Still open (not this stage's to close):** waiver orders are not persisted before/after a run, so `learned.*` stays null on the live league; E7 has no cold-start share prior (no beneficiaries without usage); the trade partner search has no CPU deadline (1.9–3.7 s measured); E8's matchup multipliers are not wired; `PbpReader.scoringPlays` (long-TD counts for nflverse lines) and the opponent-team-week D/ST path (70/70) are not wired into the readers; README status is still "planned" (Stage D).

## Build facts (Stage B2b — Phase 3 integration, 2026-10-10; for the orchestrator to verify)

- **Acceptance (plan 10 §3.3), item by item in `docs/evals/phase3-summary.md`:** met — C1 (held out
  2024 / 2025: CRPS −11 % vs trailing-4, Spearman up, coverage 79.4 % / 77.6 %, the ensemble beats
  ESPN's mean-only CRPS at game time), C4 (9 of 9 seasons exact under reading (a)), C6 (MAE 0.1427 vs
  0.1718 / 0.1693; hits 52 vs 43 / 42 of 145), C7, C9 (wired end to end: every E1 call stores its
  first-week projection, E13 attributes the ones stored before kickoff, proposals persist, only
  `eff tune --apply` applies), C10 (10 negatives re-checked, a plan 06 §1.5 job); C2 met where it can
  hold, **two rulings requested** (regret vs ESPN — identical lineups on both toolsets at
  `weight_espn` 1.0; ±5 per decile unresolved on both bases — after gate round 1 the `full` basis is
  v2-opportunity); needs_time — C3 (no pre-week scoreboard snapshot exists yet), B14 (≥ 8 weeks of
  snapshots), C8's `table_n ≥ 200` and the live proposal evidence; soft_reported — C5 (after gate
  round 1: rule vs trending +18.2 % / +66.7 % on the Phase 3 forecast; P(clears) within ±2.4 points
  with the held-out fitted curve, off 47–49 points cold), C8 (practice channel: augmented Brier
  below designation-only both seasons).
- **Wired into the product:** E1 serves `v2-opportunity` under `full` (store inputs: nflverse
  player-weeks + usage, ffopportunity xTD, `stats_team_week` through a new optional `TeamWeekReader`
  port, schedules, weather, the practice report, a memoised matchup table; tuned overrides read at
  start); E5 `league_fitted` from 13 logged runs; E7 cascade v2 (`CASCADE_PRIORS` + depth ranks);
  E10 the calibration table and claim logging; E13 attribution, proposal persistence, claim scoring;
  store migration 002 (`parameter_proposal`, `waiver_run`, `scored_claim`, three `projection`
  columns); `eff uninstall` removes `tuned-parameters.json`; plan 06 §1.5 gains the negatives
  re-check and `eff tune` rows; README lists `eff tune` as human-only; the retro Skill and the
  cheat-sheet document the attribution keys and that proposals are applied only by the owner.
- **Measured (seeded fx-10h over real stdio):** worst main-loop stall 29.3 ms (`full` analytics),
  15.9 ms (P1 warm reads), 14.4 ms (`core`); P1 analytics 0.07–3.0 s; startup ≈ 0.54 s; E2's `full`
  answer 9,810 chars (budget 10,000).
- **Cross-module fixes recorded:** `projections-v2/project.ts` (the ruled-out label reads the shipped
  weight; scoring split across two cooperative steps; the trace attached), `analytics/projection.ts`
  (`ProjectedPlayer.expectation`, additive), `analytics/evidence.ts` (the calibration table, the
  posterior, `claims` in the outcome), `reclog/attribution.ts` (`ATTRIBUTION_KEY_RE`), `cli/tune.ts`
  (the repository seam), `cli/uninstall.ts`, `mcp/envelope.ts` (`toDataInputs` drops identical rows),
  the store's readers (xTD fields, the team-week port), the A6 walk helper (E13's attribution keys).
- **Open (not this stage's to close):** the per-position interval calibration (QB narrow), A1's
  `seeding_evidence` via `reproduceSeason` (and the provider's `mSettings`-only history read),
  `league-a`'s return yards in the D/ST line, a negatives runner over the store's history files, E5
  applying a league-fitted demand curve once the owner's claim feed exists.
- **Gate round 1 (2026-10-10, fixer):** the gate was RED on C2 (hard, waiting on rulings) and on
  C2's `full` evidence not testing the shipped model. Fixed at root, each with tests: C2's `full`
  basis replays v2-opportunity as `full` serves it (`tests/domain/analytics/calibration/helpers/
  v2-history.ts`; 4,044 v2 player-weeks incl. 484 QB weeks) — on v2, as on core, every served mean is
  ESPN's, so E2's lineup equals "start by ESPN's projection" in all 308 team-weeks (the earlier
  `full` margin was Phase 2's rescale clamp); P(win) per decile unresolved on both bases (5.6 / 8.5
  points on n = 49 / 47); the switch record re-derived from v2 (still `insufficient`). The seeding
  simulator draws each cold-start / E1-fitted team's mean from its posterior (Brier better at every
  checkpoint; one decile each at weeks 4 and 8 still inconsistent — the shrinkage constant). C5's
  replay ranks on v2's forecast: fitted rule vs trending +18.2 % / +66.7 % (met); the held-out
  demand curve (`fitDemandCurve`) calibrates P(clears) within ±2.4 points (the cold start does not).
  The fixture tooling imports the write-host constant; the Phase W test scans `scripts/`. **Open for
  the orchestrator (R6):** C2's ESPN-regret clause and ±5-per-decile clause, research 05 §1.3's
  demand intercept, research 05 §2.4's k = 4 — evidence in `docs/evals/phase3-summary.md` →
  "Rulings requested".
- **Gate round 2 (2026-10-11, fixer):** the gate stayed RED on C2 alone — hard, and blocked only on
  the R6 rulings above (no code can make `mean` differ from ESPN's projection at `weight_espn` 1.0,
  and ±5 per decile cannot be resolved on 47–49 forecasts); the C2/C3 backtests re-run green at
  HEAD, numbers unchanged. Its two minor transport findings fixed at root in `src/cli/serve.ts`,
  each with tests in `tests/mcp/serve.test.ts` (failing without the fix): a stdin line that is not
  JSON is answered -32700 Parse error with no id (JSON-RPC 2.0 §5.1; MCP's error response makes `id`
  optional and has no null), one reply per line, never an echo, a line over the read cap left to the
  transport, a multi-byte character split across chunks decoded whole; a tools/call argument key
  `__proto__` — which the SDK's zod-record re-parse of `arguments` dropped before the strict schema
  ran — is carried under a stand-in no tool declares (held for all 34 tools) and answers a coded
  VALIDATION `(root) (unknown key)` like any unknown key, top level and nested, no prototype touched.
  **Still for the orchestrator:** R6 (C2's two clauses; the two soft rulings) and this file's
  ▶ NEXT STEP, which still described the 2026-10-07 pause (rewritten in round 3).
- **Gate round 3 (2026-10-11, fixer):** the gate stayed RED on C2 alone (hard, a plan-text dispute,
  no R6 ruling yet) plus a stale ▶ NEXT STEP; no failed check. No code defect: the C2/C3 backtests
  and the calibration suite re-run green at `226f21f`, `tsc --noEmit` clean, numbers unchanged.
  Done at root: ▶ NEXT STEP rewritten to the B2b state (the R6 items with their evidence and options,
  the re-gate, then the owner stop); C2's ±5 evidence made test-held — `reliabilityByDecile` carries
  `reliability_if_calibrated`, the reliability term a perfectly calibrated forecaster issuing the same
  forecasts expects from sampling alone (exact cases, a seeded Monte-Carlo, a bound property in
  `tests/domain/analytics/calibration/reliability.test.ts`): the as-played P(win) term is 0.0020
  (`core`) / 0.0031 (`full`) against ≈ 0.0060 — below the floor, so the decile misses are consistent
  with sampling noise on this sample (E2's counterfactual `p_win_after` sits above it, 0.011, the optimiser's
  selection bias already named). `docs/evals/phase3-startsit.md` regenerated (only those lines
  change) and ruling 2 in `docs/evals/phase3-summary.md` now cites the floor and lists two options.
  No criterion, threshold or verdict changed. **For the orchestrator:** R6 (step 2 above).

## The findings that shape the product (verified by the orchestrator)

1. **ESPN's API is unofficial, cookie-authenticated, and drifts
   silently.** Only `lm-api-reads.fantasy.espn.com` serves JSON for
   current seasons (the old host redirects to marketing; hosts moved
   unannounced in 2019 and 2024). Unknown `view` names return HTTP 200
   with a skeleton body, so drift can never be detected from status
   codes — schemas must hard-fail on missing required keys and a daily
   probe is mandatory. No rate-limit headers exist. Details:
   `docs/research/03-espn-api.md` §A, §F.
2. **The Disney Terms of Use (Last Updated 2024-05-24) literally cover
   this project** — §2.B.x bans automated access "including … for the
   purposes of creating or developing any AI Tool, data mining or web
   scraping"; §2.A excludes "prompting … any artificial intelligence …
   tool". Quotes verified by the orchestrator on disneytermsofuse.com.
   No verified suspension or block for reading one's own league with
   one's own cookies was found (absence of evidence). Posture: read-only,
   personal, single-league, cached, hard-capped, honest User-Agent, no
   web-page scraping. `03` §D.
3. **ESPN returns projections, ownership %, ADP, draft ranks, injury
   status and outlook text natively** (`kona_player_info`, `statSourceId
   1`) — unlike Yahoo. Player outlook text and team/owner names arrive in
   the same JSON as facts and are prompt-injection surfaces; `mStatus`
   exposes an IP and `members[]` are SWID GUIDs — strip in fixtures and
   logs. `03` §B.
4. **Credentials: keychain by default.** `espn_s2` + `SWID` only; store in
   the OS keychain via `@napi-rs/keyring` 2.1.0 (no install script; **Safe**,
   `01` §30) with a `0600` file under `~/.config/…` as fallback;
   never `.env`, never the MCP client config, never a tool argument, never
   logged; on any 401 return `ESPN_AUTH_REJECTED` with the re-setup
   command and never retry. Cookie lifetime is unverified; the design
   must not depend on it. `03` §C.
5. **Prior art (29 repos audited, `01`)**: every write gate but one is a
   boolean the model sets; only `gagandaroach/fantasy-yolo` binds
   execution to a single-use, payload-fingerprinted code from a separate
   preview tool. `jwulff/fantasy-sports` has the best credential/redaction
   design (keychain-first chain, secret carrier, construction-time
   scrubbing, pseudonymised persistence). Nobody labels untrusted text.
   `cwendt94/espn-api` has a 2020 historical cookie leak (file gone at
   HEAD; cookies presumed expired; never tested). Three repos are "do not
   use" for exfiltration or automated-login patterns. `02` has the
   capability matrix and the mistakes-to-avoid list.
6. **Writes exist** (`POST …/transactions/` on a separate writes host;
   current week only; a commissioner's cookie can edit other teams) and
   are **off in v1**; if ever built: opt-in, lineup-only first,
   own-team-pinned, two-step confirmed, read-back verified. `03` §E.
7. **Data sources (`04`)**: the ESPN player-id crosswalk is a lookup, not
   a matcher — nflverse `roster_weekly_2026.espn_id` covers 497/500
   active skill players (100 % of anyone ≥ 1 %-owned; recounted by the
   orchestrator). ESPN weekly projections exist for every week and are
   expressed in the league's own scoring; independent accuracy studies
   rank ESPN best at TE, worst at QB. After adversarial round 1 (OBJ-02)
   v1 ships **ESPN's mean as the point estimate** (`weight_espn = 1.0`);
   the own nflverse-based line contributes the distribution shape and a
   disagreement flag, and the weight moves only when a backtest under the
   league's scoring shows the mixture beats ESPN alone. ESPN's own
   ownership data replaces Sleeper trending; live in-game scoring is
   ESPN-native only. The binding commercial constraint is Disney ToU
   §2.B.viii (no commercial use, "whether or not for profit" — verified),
   so ESPN-derived and nflverse-derived layers stay separable.
8. **Format strategy (`05`)**: waiver priority is an option — claim iff
   the player's rest-of-season surplus over the drop candidate exceeds
   the premium of holding position k (a failed claim costs nothing under
   move-to-last); the 1-day period makes the Wednesday free-agent scramble
   the larger market. Points-for seeding has **two readings**: ESPN's
   `playoffSeedingRule: TOTAL_POINTS_SCORED` is win% first with PF as the
   tiebreak; "qualify and seed by PF alone" has no ESPN field (it is a
   commissioner edit), so the server needs a `seeding_mode` switch and
   last-season detection — the same roster is a favourite under one
   reading and a bubble team under the other. 5-pt passing TDs raise
   QB1–10 value 6–18 % over 4-pt but the last starter stays at
   replacement (stream QB). IR eligibility is O or IR only (verified);
   a cleared IR player makes the roster INVALID and blocks every add.
9. **Skills and MCP design (`06`)**: 13 Skills ship (`onboard`, `weekly`,
   `start-sit`, `stream-kdef`, `retro`, `apply`, `session-check` and the
   priority branch of `waivers` at P0; `trade`, `injury-cascade`,
   `schedule-plan`, `roster-audit`, `news-check` at P1); `live` is folded
   into `start-sit` and `draft` is deferred to next August;
   names and procedures match the sibling where the procedure is the
   same, with format-specific branches (move-to-last claim rule, seeding
   reading) chosen by settings. Writes: an operator-controlled
   registration gate (env flag AND typed acknowledgement AND validated
   stored credential AND own team resolved) plus the prepare/commit execution
   gate; only the `apply` Skill may call commit tools. New evidence:
   plugin-hosted MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`,
   so Skill prose must use bare tool names — which makes the `espn_`
   prefix necessary beside the Yahoo server (`06` §C.1). No public ESPN
   fantasy Skills bundle exists.
10. **Product plan (`07`–`10`)**: **18** P0 tools under `EFF_TOOLSET=core`
   (16 P1 under `full`, 7 conditional writes, 4 later — round 1 OBJ-08), 10 resources, 13
   prompts; `espn_analyze_waivers` is priority-cost-aware at P0;
   `espn_analyze_lineup` picks its objective from the seeding reading;
   the scoring engine is validated per stat (≤ 0.005) and per total
   (≤ 0.01) against ESPN's `appliedStats`/`appliedTotal`. Phases 0 → 1a
   (fixtures + nflverse, no cookie) → 1b (live, gated on Chad's ToU
   acceptance — D0, given 2026-10-05) → 2 → 3, plus a conditional write
   phase with the verdict **"recommended: do not build yet"** (Phase W, not
   built — D11). The plan's first 2026 expectation (P0 tools mid-to-late
   November; `trade` past the 2026-12-02 deadline) came from a
   human-engineer effort scale and was withdrawn on 2026-10-05 (plan 10 §0
   rewritten): Phases 0 to 3 were built by 2026-10-11.

## Program status

| phase | status | artefacts |
|---|---|---|
| 0 — repo setup | ✅ done | `.gitignore` + `.env.example` first (`0408875`), `main` pushed, description + 15 topics via `gh`, tooling inventory (`docs/research/00-*`) |
| 1 — research | ✅ `00`–`06` verified (`01` incl. keyring §30) | `docs/research/01-*` … `06-*` |
| 2 — plan | ✅ `01`–`10` final after three adversarial rounds and the §R4 consistency programme (last plan commit `b8e22f2`) | `docs/plan/01-*` … `10-*` |
| 3 — adversarial review | ✅ closed at round 3 (`ae92d9a`); changelog §R1–§R3 + Summary; §R4 (post-docs consistency rulings and their verification pass) | `docs/plan/adversarial-log.md`, `changelog.md` |
| docs — README, LICENSE, SECURITY.md | ✅ `docs-writer` (`315ebe5`); aligned through the §R4 programme; 14 diagrams render | root + `docs/README.md` |
| build approval | ✅ 2026-10-05 — the full read-only scope, free services only; Phase W not built (D11) | "Decisions made"; `docs/scratch/build-program.md` |
| build — Stage A (scaffold, contract layer, Phase 0 tools) | ✅ gate green 2026-10-06 (`bd64cba`) | "Build facts (Stage A)" |
| build — Stage B1 (Phases 1a and 1b: the 18 P0 tools) | ✅ gate closed 2026-10-06 (rulings R5-1, R5-2) | `docs/evals/1a-*.md`; changelog §B1, §R5 |
| build — Stage B2a (Phase 2: the 16 P1 tools, 34 read tools in all) | ✅ 2026-10-07 (rulings R5-3 to R5-5) | "Build facts (Stage B2a)"; `docs/evals/phase2-acceptance.md` |
| build — Stage B2b (Phase 3: the model wave) | ✅ 2026-10-11 (rulings R6-1 to R6-5) | "Build facts (Stage B2b)"; `docs/evals/phase3-summary.md` |
| build — Stage C (QA and penetration testing) | 🚧 in progress — the final gate's fix round 3 landed (2026-10-28) | ▶ NEXT STEP; `docs/evals/stage-c-live.md`, `docs/evals/stage-c-plugin-eval.md`, `docs/evals/stage-c-backlog.md`; changelog §R7, §B4, §B5, §B6, §B7, §B8 |
| build — Stage D (the final gate, the merge to `main`, the owner's install) | next | `docs/scratch/build-program.md` |

## Decisions made

| date | decision | why |
|---|---|---|
| 2026-09-29 | Repo lives at the exact path Chad specified (contains spaces; under iCloud-managed `~/Documents`) | Chad's instruction. Consequence: credentials and caches live **outside** the repo dir (`~/.config/…`, `~/.cache/…`); every committed command quotes paths; no absolute local path is committed on `main` (history residual: item 13) |
| 2026-09-29 | Stack default: Node/TypeScript + official MCP SDK | matches Chad's other local MCP server (`strava-mcp`: ESM, SDK + zod, `tsc` → `dist/`, launched by Claude Desktop with the absolute `fnm` node path) |
| 2026-09-29 | Concurrency capped at two agents | Chad's credit-efficiency rule (2026-09-24, recorded in the sibling program) |
| 2026-09-29 | Sibling Yahoo research reused **by citation** where platform-agnostic; ESPN-specific work done here; the shared-core question is the architecture planner's first decision | Chad: evaluate a shared core, do not couple without recommending |
| 2026-09-29 | Env prefix `EFF_`; read-only default; `EFF_ENABLE_WRITES=false` | `.env.example` |
| 2026-09-30 | Handoff document = `docs/HANDOFF.md`, committed | Chad's answer ("Yes") to the Phase-0 question; mirrors the sibling |
| 2026-09-30 | Repo-local git identity set to the name/email used in Chad's other repos | no global identity was visible in the session shell; nothing else in git config touched |
| 2026-10-05 | **Build approved; full planned scope, no cuts; free services only; personal use** | Chad. The November estimate was withdrawn: it came from a human-engineer effort scale; the sibling's equivalent phase took ~12 hours (plan 10 §0 rewritten) |
| 2026-10-05 | **D0 accepted** — the Disney Terms of Use account risk for live, read-only use | Chad, on the orchestrator's recommendation |
| 2026-10-05 | **D2: three public probe leagues** named by Chad, all verified keyless on 2026-10-05 (public, active, finished box scores with `appliedStats`): one 10-team half-PPR FAAB league (daily drift probe), one 12-team 6-pt-pass-TD league with rolling non-FAAB waivers, one 10-team league with an unusual 5-flex lineup. **Their ids are kept in local config only, never committed** | the engine golden is recorded from all three (anonymised), covering half-PPR, a non-4 pass-TD override and odd slot structures |
| 2026-10-05 | **D1: the reference league uses ESPN's rule** — "Playoff Seeding Tie Breaker: Total Points For", reseeding off, 6 playoff teams, 1-week rounds, consolation ladder on (settings screenshot) → `EFF_SEEDING_MODE=espn_rule`; record first, points as the tiebreak | Chad |
| 2026-10-05 | **Runtime and development location: `~/Developer/espn-fantasy-football-mcp`** (outside iCloud; matches the sibling's `~/Developer` clone); Node 24.21.0 set as the fnm default | iCloud had evicted 10,026 files and made 132 conflict copies in the sibling's old `~/Documents` checkout |
| 2026-10-05 | **Shared core: option (c)** — two repos, `espn_` prefix, shared package only on the named trigger; the owner's sibling code may be ported where the plan's boundaries match | Chad |
| 2026-10-05 | **Writes not built**; the integration seam is declared and clearly marked in code | Chad (D11) |
| 2026-10-05 | **Repo stays PUBLIC** (no concrete legal issue found: Terms-of-Use exposure is the account's, the repo carries no ESPN code or content, comparable tools have been public for years). Applied: ruleset `protect-main` (no force-push, no deletion), private vulnerability reporting ON, Dependabot alerts + security updates ON; secret scanning + push protection already ON (generic-pattern and validity checks are not available on this plan) | Chad: go private only if there is a real legal concern |
| 2026-10-05 | **Git-history path residual accepted** after a full-history scan (123 commits): no credential, email, league or team name ever committed; only folder paths showing the macOS username (= the public GitHub handle) | the most secure option: a force-push rewrite would break 243 commit references and cannot reach existing clones |
| 2026-10-05 | **Commits use the GitHub no-reply address** from now on (`<id>+<login>@users.noreply.github.com`); earlier commits carry a machine-derived address | privacy; matches the sibling's rule |

## Decisions for Chad — consolidated at hand-off (2026-09-30), ranked

**Settled since:** items 1–9 on 2026-10-05 ("Decisions made"; item 9 was
passed to the Yahoo program that day), and the plan's approval accepted the
recommended defaults of plan `10` §5's other decisions; item 10 is still the
owner's option.

1. **D0 — accept the Disney Terms of Use account risk for live use.** The
   ToU text literally covers automated access and AI use; no enforcement
   against reading one's own league was found. Gates Phase 1b and every
   credentialed job. If not accepted, Phase 1a ships as a
   fixtures-and-nflverse product and the engine is validated only on the
   probe league's settings.
2. **D2 — name a public ESPN league** for the keyless drift probe and the
   recorded engine fixtures (`EFF_PROBE_LEAGUE_ID`, configured locally,
   never committed). A Phase 0 dependency.
3. **Your league's seeding reading (D1):** ESPN's rule (record first,
   total points as tiebreak) or commissioner seeding purely by points.
   Your brief says "seeded by total points for"; the two readings flip
   lineup variance, trade and deadline advice.
4. **Runtime install location:** outside iCloud (a clone under a non-synced
   path, or `npm install -g` from a release tarball). The research checkout
   stays where it is.
5. **Shared core with the Yahoo project:** recommended — two repos,
   `espn_` tool prefix, no shared package until a named trigger
   (plan `01` §0). Diverges from the sibling's `ff_` assumption.
6. **Write module:** recommended **do not build yet** (plan `10` §3.W).
7. **Repo settings:** PUBLIC is intended? Add the plan `04` R9 ruleset
   (block force-push/deletion); enable private vulnerability reporting
   (SECURITY.md relies on it); Dependabot security updates are off.
8. **Git-history residual:** early agent briefs carried an absolute local
   path (fixed on `main`; still in history). Removing it needs a history
   rewrite and force-push, which your rules forbid — accept or authorize.
9. **Pass on to the Yahoo program:** SQLite's 10-attachment limit breaks a
   one-`ATTACH`-per-dataset layout (reproduced here); that plan has it.
10. **Optional:** notify `cwendt94/espn-api` of its 2020 historical cookie
    leak (presumed expired; nothing sent).

Plan `10` §5's other decisions (D3–D15) carry recommended defaults;
approving the plan accepts them unless Chad says otherwise.

## Accumulated notes (history; superseded by the consolidated list above)

1. Repo visibility is **PUBLIC**, no branch protection, no rulesets.
   Secret scanning + push protection are **on**; Dependabot security
   updates are **off**. Intended? (Everything pushed is treated as public
   regardless.)
2. **Decision needed — where the runtime install lives** (plan `03` §4;
   adversarial OBJ-10). The checkout is iCloud-managed. Nothing secret
   lives in it by design, but the *runtime* (`dist/cli.js` and
   `node_modules`, which the client config and every launchd job launch)
   must not: iCloud's eviction and sync churn of `node_modules` breaks
   launches in the client's MCP log, where nobody looks. Options: a clone
   outside iCloud (e.g. `~/src/…`) or `npm install -g` from the release
   tarball; the research/plan checkout stays where Chad put it.
3. **The Disney Terms of Use literally prohibit what this project does**
   (finding 2). The plan proceeds on the "own account, own league,
   read-only, polite" posture with the risk disclosed in the README; Chad
   should confirm he accepts that account risk before the build.
4. **Write module**: the research recommends not building it in v1. The
   plan will carry it as an opt-in, off-by-default, late conditional
   phase with its own verdict; Chad decides whether it is ever built.
5. **A public repo (`cwendt94/espn-api`) contains a 2020 historical cookie
   leak** (file gone at HEAD; presumed expired; never tested). Notifying
   the owner is Chad's decision; nothing has been sent.
6. License recommendation will be **MIT** (matches the sibling); the docs
   phase justifies it.
7. **Shared core with the Yahoo project**: the architecture planner will
   recommend one of (a) one shared core + provider adapters, (b) two
   servers + a shared npm package, (c) independent repos. This needs
   Chad's sign-off because it couples release cycles.
8. **Handoff**: created 2026-09-30 per Chad's "Yes".
9. **Shared core — the planner's recommendation (plan `01` §0, D3/D4)**:
   two servers, two repos, **no shared package today**, with a written
   contract (same module boundaries, canonical stat hub, envelope,
   `DataSource` interface, mechanical name crosswalk `ff_*` ↔ `espn_*`)
   and a named trigger for extracting `fantasy-core` later (both engines
   pass golden tests **and** a shared module needs the same fix in both
   repos). Evidence: both clients namespace tools by config key, so
   collisions are avoided by keys, not names; one binary would put two
   contracts under one name (ESPN has native projections/ownership/live
   scoring, Yahoo none); both projects are pre-build. Needs Chad's
   sign-off (it diverges from the sibling's `ff_` prefix choice, which
   assumed one binary).
10. **D2 moves up — name the public probe league before Phase 0** (plan
    `10` §5 D2; adversarial OBJ-01). The Phase 1a engine gate now
    requires ≥ 3 *recorded* `mBoxscore` weeks; the public probe league
    (`EFF_PROBE_LEAGUE_ID` — configured, never committed) is the only
    keyless source of them, so it is a Phase 0 dependency, not a Phase 1
    detail.
11. **D0 moves up — it now decides what the engine is validated on**
    (plan `10` §5 D0; item 3 above). Accepting the ToU account risk for
    live use gates Phase 1b; if it is not accepted, the scoring engine is
    validated only on the probe league's settings (non-PPR, 4-pt passing
    TD), and the reference format's half-PPR, 5-pt-TD and −2 turnover
    items stay unverified.
12. **For Chad to pass to the sibling Yahoo program — SQLite's
    10-attachment limit applies to its per-source dataset layout too**
    (adversarial round 2, OBJ-22; its own round 3 did not catch it).
    SQLite allows 10 attached databases per connection and Node's bundled
    build does not raise it, so a server that `ATTACH`es one file per
    dataset source fails at the 11th ("too many attached databases" —
    reproduced here by the orchestrator). This plan's fix: one read-only
    connection per dataset file, no startup attach loop (plan `01` §5.5).

13. **An absolute local path was committed in the agent briefs** (orchestrator's
    error, found by the final scan): `docs/scratch/briefs/*.md` carried the
    checkout path and the session scratch path from commit `efd6f4b` until
    they were replaced by placeholders on 2026-09-30. Nothing secret was
    exposed (the username in the path equals the public GitHub handle), and
    every other tracked file was clean. The strings remain in **git
    history**; removing them needs a history rewrite and a force-push, which
    Chad's rules forbid — his call.
14. **GitHub private vulnerability reporting is off** on the repo;
    `SECURITY.md` names it as the reporting path and says it is a pending
    maintainer step. Enabling it is a repository setting (owner's action).
15. **Plan consistency fixes after the docs pass** (changelog §R4): the
    `waivers` prompt is P0 like its Skill; the confirmation code is carried
    in the notification only (no pending file); the dataset-read tools and
    `espn_list_recommendations` have named annotation families; the
    `permissions.deny` set for a reach session is enumerated as a Phase W
    prerequisite.

## Open items

- [x] Phase 0 complete
- [x] wave 1 complete and verified (`01`, `02`, `03`)
- [x] `04`, `05` verified
- [x] plan `01`–`10` verified · [x] keyring audit (Safe)
- [x] adversarial review closed (3 rounds; changelog §R1–§R3 + Summary)
- [x] README (8 validated Mermaid diagrams), LICENSE, SECURITY.md, indexes (`315ebe5`)
- [x] R4 consistency rulings (`2840a58`) and their verification pass (changelog §R4)
- [x] §R4 consistency programme (verification pass, V1–V8, loop-until-dry, R-1–R-8)
- [x] executive summary delivered to Chad (2026-09-30)
- [x] Chad's review and the decisions above → the build approved 2026-10-05 ("Decisions made"), Phase 0 first
- [ ] the build — Stage C in progress, then Stage D ("Program status"; ▶ NEXT STEP)

## Log

- 2026-09-29 — Phase 0 complete (clone via SSH, hardened `.gitignore` +
  `.env.example` first, `main` pushed, description + topics). No ESPN/NFL/
  fantasy connector exists in the MCP registry. Sibling Yahoo program found
  mid-research; its briefs adapted. Wave 1 spawned.
- 2026-09-29 — `espn-api-specialist` ✅ (`dd7cdec`…`c43704c`), 617 lines,
  30/30 anonymized probes. Orchestrator verified the Disney ToU quotes at
  the source; identifier scan clean. `data-source-evaluator` spawned.
- 2026-09-30 — `repo-security-auditor` ✅ (`7cf414e`…`879763f`), 29 repos
  (+2 added mid-task). Orchestrator: credential-shaped-string scan clean;
  the cwendt94 leak commit (2020-09-11, `transactions.py`) confirmed by
  metadata only. `fantasy-strategy-analyst` spawned. All remaining briefs
  (waves 3–6) written and pushed. `docs/HANDOFF.md` created per Chad.
- 2026-09-30 — `data-source-evaluator` ✅ (`38c778b`). Orchestrator recounted
  the crosswalk (497/500) and verified ToU §2.B.viii. `architecture-planner-core`
  spawned (wave 3, first slot).
- 2026-09-30 — `fantasy-strategy-analyst` ✅ (`31abd8f`). Orchestrator verified
  the IR-eligibility quotes at the source. `skills-mcp-researcher` spawned
  (wave 3, second slot).
- 2026-09-30 — `architecture-planner-core` ✅ (`965ee10`). Orchestrator re-checked
  the SDK and keyring pins on npm. Auditor resumed for the keyring review.
  Chad: report back when research and planning are complete; no build before review.
- 2026-09-30 — keyring audit ✅ (`5b6b0bb`, Safe). Provenance re-verified by the
  orchestrator on npm's attestations endpoint.
- 2026-09-30 — `skills-mcp-researcher` ✅ (`2696787`). Orchestrator spot-checked the
  plugin tool-naming sentence at code.claude.com. `product-planner` spawned (wave 4).
- 2026-09-30 — `product-planner` ✅ (`131ec10`). `devils-advocate` round 1 spawned
  with the 16 tensions as pre-filed objections.
- 2026-09-30 — Adversarial round 1: `devils-advocate` `e72afb5` (20 objections); defence
  `175fe2f` (all conceded, six with modified fixes); `plan-reviser` applied every edit
  (`18d6e32`…`5351241`; survived a usage-limit cutoff with nothing lost — resumed by id).
  Orchestrator verification: retired-phrase grep 0 hits, six diagrams render, identifier
  scan clean; changelog gained the keyring review row; HANDOFF findings 4, 7, 10 corrected.
- 2026-09-30 — Adversarial round 2: `ae7bb52` (all 20 R1 rulings accepted; 6 new + 10 nits);
  the orchestrator reproduced the SQLite 10-attachment limit locally; defence `07e4b37`
  (OBJ-21 option A — two fixture classes; all conceded); `plan-reviser` R2 edits
  `89debff`…`b4e0588`; verification clean. Round 3 and `docs-writer` running.
- 2026-09-30 — Adversarial review closed at round 3 (`ae92d9a`; nothing pressed, no new
  objections). Orchestrator note `073f4e4` took the five closing nits; `plan-reviser`
  applied them and wrote changelog §R3 + Summary (`7f36671`). `.env.example` realigned
  with plan 03 §3 (`88215ac`). Residual concerns (eight, ranked) are in the changelog
  Summary: D0/D2 are Chad's; the API is unofficial and recovery is human; v1 usefulness
  vs correctness; the calendar; the fixture law; build-time unknowns; reach-session
  detection is a heuristic; the plan is unbuilt.
- 2026-09-30 — `docs-writer` ✅ (`315ebe5`): README (8 Mermaid diagrams, rendered by the
  orchestrator), LICENSE, SECURITY.md, indexes. The final scan found the checkout path in
  the saved briefs → placeholders; `.env.example` write gate (four conditions); HANDOFF
  corrections (`480352c`; the git-history residual is item 13).
- 2026-09-30 — R4: four consistency rulings after the docs pass (`2840a58`; changelog §R4
  `39196fe`) — `espn.waivers` P0, the code in the notification only, the dataset-read
  annotation family, the `permissions.deny` set.
- 2026-09-30 — R4 verification pass: the surviving findings were re-read and minimal fixes
  landed in plans 01–10 (`7d03833`) and in the README, `.env.example`, indexes and the
  Summary (`ab04385`). The record, one row per fix, and the items left for Chad are in
  changelog §R4 → *Verification pass*. 14/14 Mermaid blocks render (Mermaid 11.17.2). The
  identifier scan's one hit is a GitHub-runner path in research 01 (left for Chad).
- 2026-09-30 — Session model switched to Opus 5.5 by Chad; ultracode on. §R4
  consistency programme run as four workflows (R4 apply + 10-agent audit; V1–V8
  rulings + 8-agent audit; loop-until-dry 12 agents; final residuals 4 agents);
  orchestrator-owned edits (audit-quote path elision `331dbf6`, closing-verdict
  annotation, research table pipes `c1f89e1`, `.env.example` gate wording).
  Final checks: 14 diagrams render, tables consistent, links resolve, identifier
  scan clean. **Planning complete; executive summary delivered; awaiting Chad.**
- 2026-10-05 — Chad approved the build (full scope, Extra for building, Ultracode for QA). Held items done: Node 24 default; clone at `~/Developer/espn-fantasy-football-mcp`; three public leagues verified keyless; Yahoo session notified (both earlier notes already handled there; 13 iCloud conflict copies flagged in its old checkout); repo ruleset + vulnerability reporting + Dependabot applied; plan 10 timing corrected; `CLAUDE.md` and `docs/scratch/build-program.md` written.
- 2026-10-06 — Stage B2a integration (Phase 2): the history files registered, the Phase 2 store readers, the feed hosts, the full-toolset stdio E2E (34 tools, B8 on all six variants, hostile-input sweep), the Skills' `full` dry run, P1 latency and stall bounds, smokes under both toolsets; acceptance B1–B15 in `docs/evals/phase2-acceptance.md`; facts in "Build facts (Stage B2a)". The B2a closing gate is the orchestrator's next step.
- 2026-10-07 — B2a gate round 1 RED → fixer: deadline honesty (E2/E6/E8/E9), CPU-counted deadline, stall headroom, unit-fork cap, the overflow fix, `fixtures/fx10h-usage/` (B2 131/134 modelled), B7's cell explained; rulings requested on B2's denominator and B7's cell; B11 Lane 2 / B15 stay the owner's `claude plugin eval` run.
- 2026-10-07 — B2a gate round 2 RED (no code defect; three hard items need rulings or the owner) → fixer: stall headroom at root (cooperative pacing, 12 ms batches, D5/D6 turns, the reads' stall bound), B3's tool-level positive control, the `fx10h-usage` UUID note; rulings still requested on B2's denominator and B7's cell; B11 Lane 2 / B15 stay the owner's run.
- 2026-10-07 — B2a gate round 3 RED (the same three hard items; five soft) → fixer: E3 live on a cold cache (unknown week = `tbd`, box score first, nothing conditioned without live facts — `partial`), the Skills' `partial: true` handling, A2's wrapped trade-block note (B8 positive control on every variant), `client_ref` path-listed, the CBS guid note; rulings still requested on B2's denominator and B7's cell; B11 Lane 2 / B15 stay the owner's run.
- 2026-10-07 — Stage B2a ✅: 17 agents (integration killed by the Mac sleeping after committing its fixes; the gate's 3 fix rounds completed the work); last gate round: no code defect; rulings R5-3 (B2 denominator), R5-4 (B7 basis), R5-5 (Lane 2/B15 to Stage C). Paused at Chad's request; resume steps in ▶ NEXT STEP.
- 2026-10-10 — Stage B2b integration (Phase 3): v2-opportunity in E1 under `full`, store migration 002, E5 `league_fitted`, E7 cascade v2, E10 calibration, E13 attribution and proposals, `eff tune` on the real store; C1–C10 in `docs/evals/phase3-summary.md`; facts in "Build facts (Stage B2b)". The B2b gate is the orchestrator's next step.
- 2026-10-10 — B2b gate round 1 RED (C2 waiting on rulings; C2's `full` evidence on Phase 2's model) → fixer: C2 replayed on v2-opportunity (identical-to-ESPN lineups on both bases, shown structural), the seeding simulator's posterior mean draw, C5 on the Phase 3 forecast (rule vs trending met) and the league-fitted demand curve, the fixture tooling's write-host import; rulings requested for R6 (C2 × 2, research 05 §1.3, research 05 §2.4's k).
- 2026-10-11 — B2b gate round 2 RED (C2 alone, waiting on R6) → fixer: the two transport findings (`-32700` for a non-JSON stdin line; a `__proto__` argument key reaches the strict schema).
- 2026-10-11 — B2b gate round 3 RED (C2 alone, waiting on R6; ▶ NEXT STEP stale) → fixer: ▶ NEXT STEP rewritten to the B2b state; C2's calibration evidence gains the reliability term's calibrated floor (test-held; the as-played term sits below it). Next: the orchestrator rules R6 and re-gates.
- 2026-10-11 — Stage B2b ✅: 16 agents (Phase 3 model wave; C1, C4, C6, C7, C9, C10 met; C3/B14 needs_time; C5/C8 soft); gate red only on C2 (plan text) → rulings R6-1 … R6-5. Stage C workflow saved (`docs/scratch/workflows/effmcp-qa-pentest.js`). OWNER STOP issued.
- 2026-10-14 — Stage C paused at 29 % weekly usage (safe point): round 1 at 62/93 fixed + re-verified, 29 open; R7-1, R7-2 ruled; the continuation workflow now costs each step per agent and routes twice-failed items to an any-file architect.
- 2026-10-18 — Stage C paused at 67 % weekly usage (safe point): round 1 closed at 89/93 fixed + re-verified; round 2 found 87 (40 verified: 37 confirmed, 13 high).
- 2026-10-19 — Stage C paused at 86 % weekly usage (safe point): round 2 at 43/79 fixed + re-verified; CI test job timeout raised 15 → 30 min (suite outgrew it).
- 2026-10-22 — Stage C paused at 57 % weekly usage at the round-2/3 boundary: 167/172 confirmed findings fixed + re-verified; CI red on a new MCP SDK advisory (stdio unaffected; 2.3.1 needs the dependency review).
- 2026-10-25 — Stage C resumed. The SDK 2.2.0 → 2.3.1 (server, core, dev client) and `zod` 4.6.5 → 4.6.7, each reviewed statically (diff, install hooks, dependencies, SLSA provenance and `npm audit signatures`, licence — the SDK's `license` field is Apache-2.0 from 2.3.0); rows in `docs/plan/changelog.md` "Reviews"; the runtime tree keeps its six names.
- 2026-10-25 — Stage C round 2, cross-cutting: rulings R7-3 (setup prompt), R7-4 (E10 attribution) and R7-5 (ROS wiring tests) carried out (changelog B5); re-verification next.
- 2026-10-25 — Stage C round 3, repo-root: `docs-prebuild-markers-remain` fixed — SECURITY.md's scope, `docs/README.md` (the approval, the changelog's build sections, `evals/`, the build program) and this file's intro, finding 10, Program status and Open items describe the build; `.env.example` comments out `ESPN_SEASON` (README row with it). Held by `tests/lint/status-docs.test.ts` (pre-build words; HANDOFF's state sections, its iCloud and reading-order lines, the build stages; plan 10 §0's withdrawn estimate; the `docs/` index) and `tests/lint/env-example.test.ts` (the file's set lines resolve to the defaults in every season).
- 2026-10-26 — Stage C paused at 90 % weekly usage in round 3: SDK 2.3.1 reviewed and pinned (CI green); R7-3–R7-5 fixed; 194 fixed + re-verified overall; round 3 found 80 (37 open, 15 awaiting re-verification).
- 2026-10-28 — Stage C final gate RED (5 ledger items open; G1 INTERNAL past 11.6 days of dataset age; a red drift row the CLI could not clear; timing flakes under load) → fix round 1 (`e40fd88` … `7f39044`): every gate problem fixed at root with tests, except `ci-default-branch-controls-inert` (the Stage D merge or a setting); `docs/evals/stage-c-backlog.md` tracks what stays open; changelog §B6.
- 2026-10-28 — Stage C final gate, second run RED on no agent-fixable defect (the owner's stale datasets, the default branch, rulings, the ledger) and three low items → fix round 2 (`01cb8e5`, `2396b07`): the clone's own `.mcp.json` is no registration in doctor row 2 or uninstall; `espn_get_league` restates keepers (F6); the news matcher's ruling list is complete (choices 5, 6); changelog §B7.
- 2026-10-28 — Stage C final gate, third run RED on the owner's stale datasets (doctor #10) and low items → fix round 3: every prompt's arguments strict (an undeclared key, `__proto__` included, is -32602 and never quoted); E3 `season` prices division winners first (`division_rule`, F8); the backlog's matcher scope, F8 options and informational items; changelog §B8.
- 2026-10-28 — Stage C final gate, fourth run RED on the news matcher's shared names (`news-match-universe-homonyms`) and the items changelog §R8 rules → R8-3 built (`cb2bcc7`): a loosely named team is never evidence for a shared name's holder, the cues cover result and play wording, position words from ESPN's `position_id` decide on both paths, and an item no single holder is left for is counted; the gate's four batteries are tests (battery 1: 10 misattributions → none), one roster-move title stays open for a ruling (`docs/evals/stage-c-backlog.md`); changelog §B9.
- 2026-10-28 — R8-3 fix round 2 (`91a8c1b`): the independent attack on `cb2bcc7` found 14 ways the matcher still broke R8-3 (a loose mention cancelled a ruled cue, another player's position was read as the subject's, the residual was read more widely than clause 6, cue-list gaps and idioms, a surname path without cues, an uncounted surname); each is fixed at root with the attack's texts as tests (`tests/sources/news/match-r83-round2.test.ts`; 52 of the 118 changed tests fail at `52796bf`), and battery 1 has no misattribution; the roster move to the star's own team stays open for a ruling, with two as-built limits (`docs/evals/stage-c-backlog.md`); changelog §B9 "Fix round 2".
- 2026-10-28 — R8-3 fix round 3 (`c16b9d8`): the independent attack on `7b9572c` found 16 ways the matcher still broke R8-3 or lost what `f41e810` had (another player's position in a headline topic's clause, own-team loss idioms in capitals or dashes read as games, "injured" read as a label, missing move and label forms and "at" between teams, a teammate taking the subject's cue, a no-person sentence's game dropped, plain play variants, two untested cue lists, initials read as positions, a surname path a written position could block or that gave what the full name refused, a position next to a surname ignored and uncounted, a quadratic pass); each is fixed at root with the attack's texts as tests (`tests/sources/news/match-r83-round3.test.ts`: 27 of its 35 fail at `7b9572c`, 32 at `f41e810`; `match.perf.test.ts` bounds the worst case), 23 deciding lists are held word for word and entry by entry, unique names still match as at `f41e810`, and the gate's batteries are unchanged; the roster move to the star's own team stays open for a ruling, with three new as-built limits (`docs/evals/stage-c-backlog.md`); changelog §B9 "Fix round 3".
