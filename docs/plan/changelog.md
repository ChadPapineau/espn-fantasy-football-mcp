# Changelog — what the adversarial process changed in the plan

The plan (`docs/plan/01-*` … `10-*`) is attacked by a devil's-advocate agent and defended by the orchestrator in `docs/plan/adversarial-log.md`. After each round the rulings are applied to the plan files and recorded here: one row per objection and per tension — **id · ruling · what changed (file §) · what survived unchanged**. Section references are to the plan files as they stand after the edits. Rulings: **CONCEDE** = accepted as stated; **CONCEDE-MODIFIED** = accepted, with a different fix from the one offered; **REJECT** = the plan stands.

---

## R1 — after adversarial round 1 (2026-09-30)

**Plan state attacked:** `131ec10`. **Round 1:** 20 objections (1 blocking, 9 significant, 10 marginal) → 14 CONCEDE, 6 CONCEDE-MODIFIED, 0 REJECT; 16 pre-filed tensions → 13 adopted (2 sharpened, 1 with one item replaced), 1 dismissed to a note, 1 merged, 1 already done. **Edits landed in:** `18d6e32` (OBJ-01–04), `d419983` (OBJ-05–08), `3e8b675` (OBJ-09), `22e80ef` (OBJ-10–14), `5973653` (OBJ-15–20, tensions), `e95f4de` (plan 10 §4 resolved table), `896a4db` (this file), `8a96156` (consistency pass), and the commit after it (the two `docs/HANDOFF.md` edits: item 2, items 10–11).

### Numbers that changed

| Quantity | Now | Was | Ruling |
|---|---|---|---|
| P0 tools under `EFF_TOOLSET=core` | 18 | 21 (C3, E3, E14 moved to P1) | OBJ-08 |
| P1 tools added by `full` | 16 (34 total, unchanged) | 13 | OBJ-08 |
| `tools/list` ceilings (chars) | `core` ≤ 20 000, `full` ≤ 35 000, token-derived and downward-only | more than twice as high — set above the design's size | OBJ-09(b) |
| Skills listing ceiling | ≤ 4 600 chars | unchanged | OBJ-09(b) |
| Node floor | ≥ 24.15 | the v22 line | T-15(a) |
| Per-call upstream deadline | ≤ 20 s, retries inside it | none (≈ 48 s worst case) | OBJ-20 |
| Main-loop stall during analytics | ≤ 50 ms (≤ 20 ms cooperative batches) | unbounded (3–5 s) | OBJ-07 |
| `espn_s2` length at setup | refuse < 40, warn 40–99, accept | refuse < 100 | OBJ-15 |
| v1 ensemble `weight_espn` | 1.0 | equal weights | OBJ-02 |
| `eff doctor` rows | 25 | 20 | T-08, OBJ-10 |
| 100 %-coverage modules | ten | eight | T-10 |
| Mandatory sentences per `tools/list` | 0 (once each, in the server `instructions`) | two per description | OBJ-09(b) |

### Objections

| id | severity · ruling | what changed (file §) | what survived unchanged |
|---|---|---|---|
| OBJ-01 | blocking · CONCEDE | The 1a engine gate now requires ≥ 3 **recorded** `mBoxscore` weeks (`statsOfficial: true`) from a real league — the public probe league keyless in 1a, the reference league in 1b; the golden's scoring fields come only from recordings, with a provenance test hashing them to a recorded original (the rule's wording and `gen-fixtures.ts`'s role were revised in R2 — OBJ-21); the keyless recording is a Phase 0 script; the reference-format assertions became `normalizeSettings` unit/property tests and the reference-format golden is A1b; D0-not-accepted lists what stays `verified: false`. **Files:** plan 10 §3.1a *Fixtures*, A1a, §6 A-1, §5 D0 and D2; plan 09 §4 (tree), §5.2, §7 A-2; plan 05 §3.1 step 1, §2 `domain/scoring`; plan 08 §6 steps 1 and 6 | the per-stat and per-total tolerances (0.005 / 0.01); engine decisions E1–E9; `fx-10h` as the Skills' fixture league (its `mSettings` hand-written) |
| OBJ-02 | significant · CONCEDE | v1 ships `weight_espn = 1.0`: ESPN's mean is the point estimate, the trailing nflverse line contributes the distribution shape and the `disagreement` flag only; A11a carries the gating rule for the shipped default; B14 moves the weight below 1 only on a backtest win; D15 gains "earned by backtest, not assumed". **Files:** plan 07 E1 (output, method, D/W/A/C); plan 10 A11a, B14; plan 01 D15 | the labelling (`meta.estimate: true`, `data.inputs[]`, the `_espn` suffix); `basis: position_cv`; `v2-opportunity` in Phase 3 |
| OBJ-03 | significant · CONCEDE | E5 returns `premium_band: { low, high }` (the DP re-solved at ×0.5 and ×1.5 surplus) and `verdict: "marginal"` inside it; `waivers` prints the band and calls marginal claims marginal; A9a gains the hard band assertion. **Files:** plan 07 E5 (output, method), E7, C9; plan 09 §3.8 (output contract, guardrails, WV-1), §3.2 (WK-1); plan 10 A9a, A12b | the DP and its cold-start table; `premium_basis: cold_start_table` until the league's feed re-solves Π; the 29.5 reproduction as a regression |
| OBJ-04 | significant · CONCEDE | The daily `credential check` job is the one job exempt from the `rejected` short-circuit (one probe per run, ≤ 2/day); its 200 is a third `Rejected → Validated` edge; the notification names the next probe time; status shows `rejected_since` / `next_probe_at`. **Files:** plan 06 §1.4 (`credential check`, `snapshot roster`, closing rule), §3; plan 02 §2.1 (diagram, table), S3; plan 01 §4.3, §8; plan 03 §5 #6, §6; plan 07 G1; plan 10 A2b | never retry a 401 per request; the short-circuit for every tool call and every other job |
| OBJ-05 | significant · CONCEDE-MODIFIED (option (a); the `security`-CLI variant deferred until `doctor` #7 has observed prompt-free reads) | One credential store per install, decided at `eff setup` by a launchd-context test; the two-store state is forbidden and `doctor` #6 fails on it; `uninstall` deletes both, always; A-1 reworded as the thing the test verifies. **Files:** plan 06 §2, §5 A-2; plan 02 §2.2 (row, friction paragraph), §8 #21, §10 A-1; plan 03 §2.1 step 4, §5 #6, §8 step 2 | the keychain as the default store; the `0600` file fallback; the §7.2 fallback if the addon fails review |
| OBJ-06 | significant · CONCEDE-MODIFIED (both halves) | An operator override `EFF_ESPN_READ_HOST`, accepted only under `^[a-z0-9-]+\.fantasy\.espn\.com$` (the allow-list is derived from it), is the emergency path; the permanent fix is stated as a release; during `host_moved` ESPN-fact tools honour `allow_stale` and suspend their hard limit; `orient.md` routes `host_moved`. **Files:** plan 03 §3, §5 #15; plan 02 S12, §5, §7.1; plan 01 §4.3, §7 (row and recovery paragraph); plan 09 §2, §3.7 | "never auto-adapts"; the per-mode allow-list and refused redirects; the write host as a constant |
| OBJ-07 | significant · CONCEDE-MODIFIED (cooperative batching; a worker pool is the named fallback) | `scoreSamples`, E1's sampler and the seeding simulator yield every ≤ 20 ms of CPU; the bar "main-loop stall ≤ 50 ms during any analytics call" is measured by a heartbeat timer; `n_sims` is bounded by `N_SIMS_MAX` with `partial: true` on a per-call CPU deadline. **Files:** plan 01 §1.1; plan 03 §1.2; plan 10 A16a, §6 A-2; plan 07 E1, E3 (inputs) | the latency targets; refreshes out of process (D10); the pure domain |
| OBJ-08 | significant · CONCEDE | `core` = 18: `espn_get_projections`, `espn_analyze_matchup` (as a tool) and `espn_list_recommendations` moved to P1; the seeding simulator stays Phase 1a domain code and A10a became a domain unit test. **Files:** plan 07 C3, §2 Toolset, §3 C3/E3/E14, E2, §5.1, §7 A-4; plan 10 Ph1, §1, §3.1a (Analytics, Tools), A3a, A7a, A10a, §3.1b, §3.2, B10, D3 | 34 read tools in v1; the `espn-ff://rec/*` resources; `EFF_TOOLSET` itself |
| OBJ-09 | significant · CONCEDE | **(a)** datasets live in per-source database files published by atomic `rename()` and read by the server read-only (the read mechanism was revised in R2 — OBJ-22); the main store never receives a dataset write — plan 01 D6, §1 (diagram), §5.1, §5.5; plan 02 §8 #8; plan 03 L7, §1.1, §7; plan 05 §2 `store`; plan 06 J3, §2; plan 10 A5a, A15a. **(b)** ceilings token-derived and downward-only; both mandatory sentences once in the server `instructions`, a ≤ 40-char pointer per description, asserted by `smoke` — plan 01 §4.1; plan 02 §6.3; plan 05 §5; plan 07 legend, C10, §5.1, §7 A-4; plan 10 A3a, A7a, B12. **(c)** "cannot forge" names the session condition; `doctor` #13 warns on other `mcpServers` entries — plan 02 opening rule, §1, §4.2, §8 #14; plan 03 §5 #13; plan 09 §6; plan 10 §3.W. Sibling citations name rounds 1–2 (plans 07, 09, 10 headers) | SQLite in WAL for the main store; the wording of the two sentences; the three confirmation channels and the gate design |
| OBJ-10 | significant · CONCEDE | The runtime install lives outside any file-provider directory; `print-config` warns; `doctor` #2 checks the directory that holds code (xattr, dataless placeholders); new rows #24 (stale `dist/`) and #25 (client MCP-log tail); the launchd jobs share the requirement; HANDOFF item 2 became a decision for Chad. **Files:** plan 03 §4.1–§4.3, §5 #2, #24, #25, §7, §10 A-9; plan 06 §2; plan 05 §2 `cli/print-config`; `docs/HANDOFF.md` item 2 | the repository's location; config and cache directories outside iCloud with xattr checks |
| OBJ-11 | marginal · CONCEDE | `doctor` #2 compares the config's `command` with `process.execPath`; the upgrade path lists `eff print-config` and `eff install-launchd`. **Files:** plan 03 §4.1, §5 #2, §7 | absolute, generated launch paths (L4) |
| OBJ-12 | marginal · CONCEDE-MODIFIED (a deterministic shim rather than "node on PATH") | The plugin's `.mcp.json` launches a POSIX shim — relocated to `scripts/eff-launch.sh` in R2, OBJ-23 — (`EFF_NODE` → `fnm`/`nvm` default → `/opt/homebrew/bin` → `command -v node`, ≥ the floor); `doctor` #2 runs the same resolution; A15b verifies from the Desktop Code tab. **Files:** plan 09 §4, §6, K8; plan 04 §1; plan 03 §5 #2; plan 10 A15b | copy-install; `eff print-config` with absolute paths |
| OBJ-13 | marginal · CONCEDE-MODIFIED (default = what ESPN's settings say, flagged unconfirmed; no "unset means refuse") | `EFF_SEEDING_MODE ∈ { espn_rule, points_only }`, default `espn_rule`, `seeding.confirmed: false` until `onboard` records the answer; `both` only as an explicit argument; the `Y−1` request is `onboard`'s one-time evidence. **Files:** plan 07 C12, A1, C9, E2, E3, §6, G1; plan 09 §3.1, §3.3, §3.11; plan 03 §3; plan 10 D1, B5 | the seeding reading as an operator act; the two-reading simulator |
| OBJ-14 | marginal · CONCEDE | On a public league the credential probe is the `/communication/` board probe (`topics.limit: 1`; 200/404 accepted, 401 rejected; body discarded); `mSettings` otherwise. **Files:** plan 07 G2; plan 02 S2, §2.1; plan 03 §2.1 step 5, §5 #16–#17; plan 09 §3.7 (SC-3), §3.1 (ON-5-E); plan 06 §1.4; plan 10 D2 | `mSettings` as the probe on a private league; no board text stored or returned |
| OBJ-15 | marginal · CONCEDE | The redactor registers both the pasted and the `decodeURIComponent` form; setup refuses < 40 chars and warns at 40–99. **Files:** plan 02 §2, §2.1, §2.3; plan 01 §8, §10; plan 03 §2.1 step 3; plan 05 §2 `auth/format`, `cli/log` | the gitleaks floor (80); values stored exactly as pasted |
| OBJ-16 | marginal · CONCEDE | Kickoff-relative jobs run on a fixed game-day cadence and self-select from `ds_pro_schedule` epoch-ms dates; waiver-relative jobs from `status.waiverNextExecutionDate`; `waiverProcessHour` (as ET) is a fallback with a `doctor` warning; nothing is baked into a plist. **Files:** plan 06 §1.4 (four triggers, budget line), §2; plan 03 §5 #11 | the fixed nightly jobs; the Skills' guardrail 7 |
| OBJ-17 | marginal · CONCEDE | With any `ff_*` tool set visible and no platform named, the Skill asks which league before any recommendation; the sibling is never named by config key; A16b tests the question. **Files:** plan 09 §2; plan 10 A16b | separate bundles and config keys |
| OBJ-18 | marginal · CONCEDE-MODIFIED (per-Skill toolset check now; the default is re-decided in Phase 2) | Every P1 Skill's Step 0 reads `server.toolset` and tells a `core` user to set `EFF_TOOLSET=full`; Lane 1 states its toolset (P0 under `core`, P1 under `full`). **Files:** plan 09 §2, §5.1 item 3; plan 10 D3, B10, B11 | `core` as today's default |
| OBJ-19 | marginal · CONCEDE | (a) the keyring review is cited (research 01 §30, Safe) with item 5 as the one open item — plan 02 header, S1, §7.2, §10; plan 01 D12; plan 04 §2. (b) `@modelcontextprotocol/client` is a devDependency — plan 04 §2; plan 05 §10 A-2; plan 09 §5.1. (c) A6's schema is provisional and a community-shape mismatch is `partial`/`stale`, not drift — plan 07 A6. (d) the parquet codec is asserted at load — plan 05 §2 `sources/*`; plan 01 D9, §5.5. (e) the nflverse file's sha256 is pinned beside the excerpt — plan 08 §6 step 5. (f) T-16 already done | the pins themselves; A6's field list |
| OBJ-20 | marginal · CONCEDE | A per-call upstream deadline of ≤ 20 s with retries inside it; past it the call returns stale/partial and the breaker counts the attempt; `ENOTFOUND`/`ECONNREFUSED` never retried. **Files:** plan 01 §6; plan 05 §4.1 (two rows); plan 10 A5a | the 15 s per-attempt timeout; the breaker; no retry on 4xx |

### Tensions (plan 10 §4)

| id | ruling | what changed (file §) | what survived unchanged |
|---|---|---|---|
| T-01 | adopted, sharpened (the runtime is found by the OBJ-12 shim) | plugin files, the launch shim, `evals/` and the scripts in plan 04 §1 and §2 `files`; `check-skills` runs `claude plugin validate --strict` (plan 04 §4.2); plan 03 §4.2 reworded to "no secrets and no absolute user paths"; plan 09 §4, K8 | the plugin manifest ships with the first commit (K8) |
| T-02 | adopted | bare `espn_*` names in Skill bodies validated against `tools/list`; the eight strings in non-`apply` frontmatter — plan 04 §4.2; plan 03 §4.2; plan 07 §1 | the eight `disallowed-tools` strings |
| T-03 | adopted (T-13 merged in) | `EFF_TOOLSET` and `EFF_SEEDING_MODE` in plan 03 §3; plan 01 §3.1 → "decided at process start"; plan 01 §4.1/§5.6 examples use the final names; plan 07 §2, C1, §1 | the config precedence (env > `config.json` > defaults) |
| T-04 | adopted | a sixth family "local-store write" for `record`/`prepare`/`cancel` — plan 01 §4.1; plan 02 §4.1 step 1; plan 07 §2, E12 | the other five families and their annotations |
| T-05 | adopted, sharpened | the zod `outputSchema` stays in code and is omitted only from the wire for the named list tools; no doc-URL escape — plan 01 §4 (intro); plan 05 §2 `mcp/envelope`; plan 07 C10 | `outputSchema` on every tool in code; the `untrusted_text` walk |
| T-06 | adopted | the echo spike decides; if both copies are forwarded, list tools omit `structuredContent` — plan 01 §4.2; plan 07 §5.1 | "no Markdown mode" |
| T-07 | adopted (+ the OBJ-04 note) | every table named in plan 01 §9.2; the never-prune list in plan 06 §1.3; `snapshot roster` stores `scoreboard_snapshot`; `snapshot projections` writes `espn_projection` (plan 06 §1.4); plan 08 §9; plan 07 A4, E12, E13 | 30-day pruning of roster/pool snapshots and raw cache rows |
| T-08 | adopted | doctor rows #21–#23 (plan 03 §5); `snapshot roster` computes the IR-validity and golden checks (plan 06 §1.4); plan 07 E9; plan 08 §6 step 2 | `ir-slot-management` stays a tool validation plus a job, not a Skill |
| T-09 | adopted, sharpened (session, not client; the pty caveat carried) | as OBJ-09(c) — plan 02 opening rule, §1, §4.2, §8 #14; plan 03 §5 #13; plan 09 §6; plan 10 §3.W verdict (4), prerequisites (a)–(b), W10 | the three channels; the Phase W verdict "do not build yet" |
| T-10 | adopted | `metrics.ts` and `scoring/verify.ts` at 100 %; the two Skills-lane rows and the injection-invariance row — plan 05 T8, §1, §2, §7 | the 90/85/90 global gate |
| T-11 | dismissed as a tension — **note only** | one line in plan 02 §5 (selectors are the sanctioned way past 25 ids); plan 07 legend | the bound of 25 ids |
| T-12 | adopted | after A7a's measurement, `player.fullName` → a bare string listed in `meta.untrusted_fields[]` — plan 01 §4.4 | wrappers for member-, commissioner- and editor-authored text |
| T-13 | merged into T-03 | see T-03 | — |
| T-14 | adopted | drift (refuse) vs mismatch (degrade per player; refuse above 10 %) — plan 01 §7 (`mSettings` row) | plan 08 E6 |
| T-15 | (a), (b), (d), (e) adopted; (c) **replaced** by OBJ-09(a); (f)–(h) = OBJ-09(a)(b)(c) | (a) Node ≥ 24.15, `doctor` #1, `fnm install 24` in the quickstart — plan 01 D2; plan 03 §4.1, §4.3, §5 #1–#2; plan 04 R2, R5, §1, §2, §4.1; plan 06 §1.1. (b) `VACUUM INTO` under the process lock — plan 03 L7, §7; plan 05 §2 `store`; plan 06 §1.3. (d) an explicit `puppeteer browsers install` step — plan 04 §4.2. (e) no required checks during the docs phase — plan 04 §5, §8 A-3 | the SDK pin; `ignore-scripts=true`; required checks once PRs are required |
| T-16 | **already done** | none — HANDOFF item 9 already reads "13 Skills ship" | 13 Skills; `live` folded into `start-sit` |

Also adopted from the log's §1.5: plan 01 §7 now states which views the daily probe covers (`proTeamSchedules_wl`, `mSettings`, `mNav`, `mTeam`), which the nightly jobs exercise (`mRoster`, `kona_player_info`, `mTransactions2`) and which are in-call-only (`mBoxscore`, `mMatchupScore`, `kona_playercard`).

### Survived unchanged (what the devil's advocate did not attack, and why — log §1.5)

- **Layering, the store, the provider seam, the shared-core decision (D3, c→b).** The domain/provider/source/store split is the right size; SQLite in WAL is right (OBJ-07 and OBJ-09(a) changed how it is used, not the choice); separate repos with a named extraction trigger stand.
- **Read-only by default and the Phase W verdict.** Operator-gated registration, the typed acknowledgement, the never-retry journal, and "recommended, do not build yet" with its six reasons.
- **Own-team pinning.** `teamId` derived from the SWID, never an argument.
- **`untrusted_text` applied field by field** inside ESPN fact objects, the injection flags and the invariance tests (T-12 changes only the cost of platform-authored player names).
- **In-call drift detection.** Zod hard-fail on required keys plus skeleton detection (the probe-coverage line above is an honesty addition, not a change).
- **D15's labelling.** ESPN's numbers labelled ESPN's, the `_espn` suffix discipline (OBJ-02 changed the weight, not the label).
- **Sunday caching and the cross-process limiter.** The 60 s class inside a game window, in-flight coalescing, `force_refresh` once per 60 s per key, the 30/min bucket shared through SQLite.
- **The setup UX.** Hidden input, the definitive check, delete-on-401, the one-shot page as the second option.
- **The 5-pt passing-TD analysis** (its regression test gained a pinned hash — OBJ-19(e)).
- **The calibration loop** and its honest sample-size table.
- **Skills vs tools.** Every shipped Skill owns a procedure a tool cannot; the two eval lanes.

### Narrow readings the reviser made (for round 2 to check)

- **OBJ-01** — the ruling names `scripts/record-fixtures.ts --public`; the plan already had `scripts/record-fixture.ts`, so the keyless recording is that script's `--public` mode rather than a second script — standalone in Phase 0 (like `scripts/probe.ts`), because no provider code exists yet. With no probe league named (D2), 1a has no keyless recording source and its golden waits for D0.
- **OBJ-07** — "`n_sims` max bounded to what fits" is a named constant (`N_SIMS_MAX` in `src/mcp/bounds.ts`) set on the first A16a measurement, not a number invented here.
- **OBJ-09(a)** — the ruling lists "plan 10 A4a/A15a"; A4a is in-call drift, so the dataset-file assertion sits in A5a (the `store` rows) and A15a.
- **OBJ-09(c)** — "plan 02 §1/§8 #2/#5" read as the forgeability sentences: the opening rule, §1's boundary paragraph, §4.2 and §8 #14 (§8 rows 2 and 5 do not speak of forging).
- **OBJ-13** — `onboard` obtains the one-time `Y−1` evidence through an opt-in `include: ["seeding_evidence"]` on `espn_get_league`; it is absent from the default response.
- **OBJ-16** — "schedule from `waiverNextExecutionDate` read at the previous run" is implemented as the same fixed-cadence, self-selecting pattern the ruling gives the kickoff-relative jobs (launchd calendars cannot be re-timed per run).
- **T-15(a)** — the CI matrix became Node 24 only, since 22 is below the new floor.
- **Not applied:** the defence's §1.F item 1 (a separate acceptance row for the D0-not-accepted product) is a suggestion, not a §1.E edit.

### Orchestrator follow-ups after the reviser (2026-09-30)

| item | what changed |
|---|---|
| Defence §1.F (1) — the D0-not-accepted product | No new row needed: plan 10 §5 D0 now states what ships (Phase 1a: engine, projections v1, K/D-ST by implied totals, the waiver DP on a pasted roster), that its acceptance criteria are Phase 1a's own (A1a–A16a), and which scoring families stay `verified: false` on the probe league's settings |
| Example tool name `espn_get_player` (plan 01 §5.6, §7) | replaced by plan 07's final name `espn_get_player_stats` (same kind of nit as T-13) |
| Diagrams | all six plan diagrams re-rendered after the R1 edits with Mermaid 11.4.1 in a browser: 6 ok, 0 failed |
| Independent consistency grep | the orchestrator re-ran the retired-phrase grep over plans 01–10 and this file: 0 hits for every retired phrase; positive controls present |

## R2 — after adversarial round 2 (2026-09-30)

**Plan state attacked:** `784b1b9`. **Round 2:** all 20 round-1 objections conceded-by-defence (0 pressed, 0 withdrawn); 6 new objections (1 significant, 5 marginal) → 6 CONCEDE, OBJ-21 under option (A); 10 nits → all taken. **Edits landed in:** `3c18e09` (OBJ-21, nit 7), `0420837` (OBJ-22, OBJ-23), `5216555` (OBJ-24–26), `5661da1` (nits 1–6, 8–10), and the commits that add this section and the HANDOFF item.

### Numbers and names that changed

| Quantity | Now | Was | Ruling |
|---|---|---|---|
| Fixture classes | two — `fixtures/espn/recorded/**` (evidence) and `fixtures/espn/fx-10h/**` (`derived: true`, plumbing) | one class | OBJ-21 |
| The fixture rule | "the golden never reads a derived scoring field" | a ban on any non-recorded scoring field in any fixture | OBJ-21 |
| Dataset access | one read-only connection per dataset file; on-demand join attachments ≤ 8 | every dataset file attached to one connection at startup (SQLite allows 10; `full` has 11 sources) | OBJ-22 |
| Dataset file name | `datasets/<source>.sqlite`, replaced by `rename()` onto the same path | a versioned file name | OBJ-22 |
| Plugin launch | `/bin/sh` running `scripts/eff-launch.sh` | a shim in a plugin-root `bin/` directory | OBJ-23 |
| Description pointer | "Untrusted text: see server instructions." (40 chars) | a 42-char string under a "≤ 40" label | OBJ-24 |
| Launchd-context test | a throwaway item read under a 10 s timeout; `ok` / `timeout` / `error` | a read of an item that does not exist yet | OBJ-25 |
| Board-probe result on a public league | `accepted: true \| false \| null` (null when the anonymous control shows the probe does not discriminate) | 200/404 always "accepted" | OBJ-26 |
| Per-call CPU deadline | 8 s | unnumbered | nit 1 |
| B14 shadow weights | 0.5 and 0.75, beside the shipped 1.0 | none named | nit 2 |
| Phase 0 acceptance rows | Z1–Z7 (Z7 gated on D2) | Z1–Z6 | nit 7 |

### Objections

| id | severity · ruling | what changed (file §) |
|---|---|---|
| OBJ-21 | significant · CONCEDE, option (A) | Two fixture classes. `fixtures/espn/recorded/**` is recorded with its league's own `mSettings`, its scoring fields hash to a recorded original, and it is the only input the golden test, A1a, `verify`'s tests and plan 08 §6 read — a path guard enforces it. `fixtures/espn/fx-10h/**` is the reference-format Skills league: scoring fields re-scored by the engine under the reference `S` from the recorded raw `stats{}`, every file `derived: true` in the manifest with the engine version and `settings_hash`; `gen-fixtures.ts` refuses to run unless the recorded golden is green; final-week lineups are not mutated unless totals are re-derived. The rule is reworded to "the golden never reads a derived scoring field"; a test asserts `match: true` for every player on base `fx-10h` (plumbing, never engine evidence) and that `mismatch-53` differs from the base on stat 53 only; plan 05 §3 opens with the three-line fixture law. **Files:** plan 10 §3.1a *Fixtures*, A1a, A14a, §6 A-1; plan 09 §4 (tree, two lines), §3.1 (ON-3), §5.1 #7, §5.2, §7 A-2; plan 05 §3 (the box), §3.1 steps 1, 2 and 4, §2 `domain/scoring`, §5; plan 08 §6 step 1; plan 01 §9.1; plan 04 §1, §4.1 |
| OBJ-22 | marginal (verified) · CONCEDE | No startup attach loop: each dataset file is its own read-only connection (`new DatabaseSync(path, { readOnly: true })`); cross-source joins happen in the domain layer, and a query family that needs a SQL join attaches on demand on a short-lived connection with a hard ceiling of 8; read-only is enforced by the open mode and tested by a statement trace (zero `ds_*` DML from the server); `refresh` publishes by `rename()` onto the same path, so no unlink owner is needed; `store prune` removes dataset files `refresh_log` no longer names; the `store` test opens all eleven sources. **Files:** plan 01 D6, §1 (diagram node), §5.1, §5.5 (new paragraph), §14 A-13; plan 03 §1.1 step 3; plan 05 §2 `store`; plan 06 §1.3 (intro, `store prune`); plan 10 §4 T-15 |
| OBJ-23 | marginal · CONCEDE | The shim is `scripts/eff-launch.sh`, launched as `"command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/eff-launch.sh", "serve"]`; no `bin/` directory at the plugin root; the `eff` CLI name still comes from `package.json` `bin` on a normal install. **Files:** plan 09 §4 (tree), §6 (Code-tab row), K8; plan 04 §1, §2 `files`; plan 03 §4.2, §5 #2; plan 10 §4 T-01, A15b |
| OBJ-24 | marginal · CONCEDE | A client's delivery of `instructions` to the model is stated as [U]; the A11b spike gains an `instructions` nonce per client; both sentences are also carried verbatim by `espn-ff://docs/tool-outputs` (and already by the prompts and every Skill's guardrail text); the named fallback is a ≤ 120-char short form of the rule in each tool description, re-measured against the same ceilings; the pointer is 40 characters. **Files:** plan 01 §4.1, §14 A-14; plan 02 §6.3, §8 #5, §10; plan 07 §5.1, §4.1; plan 09 §2 (`tool-outputs.md`); plan 10 A11b, §3.1b, §2 ledger |
| OBJ-25 | marginal · CONCEDE | The launchd-context test writes a throwaway keychain item (service suffix `-selftest`, random value), a one-shot agent reads it under a 10 s timeout, the outcome is `ok` / `timeout` / `error`, anything but `ok` selects the file store for the whole install, the item is deleted, and the outcome is recorded in `config.json` and shown by `doctor` #7. **Files:** plan 03 §2.1 step 4, §5 #7; plan 06 §2, §5 A-2; plan 02 §2.2, §10 A-1 |
| OBJ-26 | marginal · CONCEDE | At setup on a public league, one anonymous control request to the board probe, cached with the league settings: anonymous 401 → 200/404 with cookies = accepted, 401 = rejected; anonymous non-401 → the probe does not discriminate and the result is `accepted: null` with the reason; `session-check` says which case applies. **Files:** plan 07 G2; plan 02 S2, §2.1 (diagram label, table); plan 03 §2.1 step 5, §5 #16; plan 09 §3.7 (tools, SC-3, guardrail), §3.1 (ON-5-E); plan 06 §1.4; plan 10 §5 D2 |

### Nits

| # | ruling | what changed (file §) |
|---|---|---|
| 1 | taken | The per-call CPU deadline is 8 s ([A], re-measured at A16a); `partial: true` results carry the completed sample count and are never cached; invariance and determinism tests run with the deadline disabled — plan 07 E1, E3, §7 A-7; plan 10 A16a, A8a, §6 A-2; plan 08 §7 P12 |
| 2 | taken | At `weight_espn = 1.0` the "start by ESPN's projection" regret is identically zero and `retro` says "not informative in v1"; B14 evaluates shadow weights 0.5 and 0.75 beside the shipped 1.0 — plan 07 E13; plan 09 §3.5; plan 10 A11a, B14 |
| 3 | taken | `marginal` candidates do not enter `claim_list[]`; they are returned in a separate `marginal[]` and presented as "your call" — plan 07 E5 (output, method); plan 09 §3.8; plan 10 A9a |
| 4 | taken | `orient.md` prints one line while `seeding.confirmed` is false, pointing to `onboard` — plan 09 §2 |
| 5 | taken | `snapshot pool` wakes hourly every day in season; a run with nothing due makes no request — plan 06 §1.4 |
| 6 | taken | The host override covers only a move within `*.fantasy.espn.com`; anything else is the release path — plan 01 §7; plan 03 §3 |
| 7 | taken | Phase 0 row Z7: ≥ 3 recorded final `mBoxscore` weeks of the probe league, scrubbed and committed with provenance hashes, gated on D2 — plan 10 §3.0, §1 |
| 8 | taken | "until the seeding simulator has run" — plan 07 E2 (objective, degradation), §7 A-3 |
| 9 | taken | The first lever under the 20 000-char ceiling is `wireOutputSchema: false` generalised beyond the five list tools, shapes documented in `espn-ff://docs/tool-outputs` — plan 07 C10, §5.1; plan 10 A7a; plan 01 §4 (intro) |
| 10 | taken | "Every latency or size bound names the dataset it is measured on and the test that measures it"; the 500 ms warm bound names its fixture — plan 05 §0; plan 10 A16a |

### Narrow readings the reviser made in R2 (for round 3 to check)

- **OBJ-21** — with two classes, the golden paths in plan 01 §9.1, plan 08 §6 and the scrub script's output moved under `fixtures/espn/recorded/`, and the two Inspector-smoke invocations (plan 04 §4.1, plan 05 §5) point at `fixtures/espn/fx-10h` — the directory plan 09 already used for fixture mode — instead of the bare parent directory.
- **OBJ-22** — the ruling puts the `readOnly` [A] in "plan 01 §13"; §13 is "What this plan does not decide", so the line is A-13 in the assumptions table (§14). Dataset files are named `datasets/<source>.sqlite` with the version in `refresh_log`, which is what "rename onto the same path" requires.
- **OBJ-23** — plan 04 §2 `files` drops `bin` and lists `scripts/eff-launch.sh`, so a tarball install is still a plugin root.
- **OBJ-24** — the pointer is the advocate's 40-character candidate, "Untrusted text: see server instructions."; the [U] is named in both plan 01 §14 (A-14) and plan 02 §10.
- **OBJ-25** — the ruling names the throwaway item only by its suffix; the service is written as `espn-fantasy-football-mcp-selftest`. The advocate's extras that the ruling does not carry (a `store_decided_by` key, a setup warning text, `doctor` re-running the test) were not added.
- **OBJ-26** — on a public league whose board probe does not discriminate, setup keeps the value and the state stays `stored`; the daily `credential check` then yields `accepted: null` and changes no state. *(Superseded by R3 nit (c): on such a league the daily check probes the view whose 401 caused the rejection.)*
- **Nit 2** — E13's output shape is unchanged; "not informative in v1" is what `retro` says (a guardrail in plan 09 §3.5), noted in E13's method. *(Superseded by R3 nit (d): E13 now returns `informative: false`.)*
- **Nit 10** — the 500 ms bound names `fx-10h` in fixture mode and "the process test"; no test file name was invented.

## R3 — after adversarial round 3 (2026-09-30)

**Plan state attacked:** `b4e0588`. **Round 3:** the 6 round-2 objections conceded-by-defence and all 10 round-2 nits taken; nothing pressed, no new objection; the devil's advocate closed with five line-level nits (log §3.1), all taken in the orchestrator's note. **Edits landed in:** `1b2af1e` and the commit that adds this section.

| nit | ruling | what changed (file §) |
|---|---|---|
| (a) | taken | `refresh` writes each dataset file with `journal_mode=DELETE` and closes it before `rename()`, so no `-wal`/`-shm` sidecar can be left behind the published file — plan 01 §5.5 |
| (b) | taken | `gen-fixtures.ts` re-derives every aggregate of a re-scored field in `fx-10h` (team totals, `winner`, records, points for/against), so the scoreboard, the standings and the seeding simulator agree with the box scores — plan 05 §3 (fixture law, line 2); plan 09 §5.2; plan 10 §3.1a |
| (c) | taken | On a public league whose board probe does not discriminate, the daily credential check probes the view whose 401 caused the rejection, once a day, so `rejected` can flip back — plan 06 §1.4; plan 02 §2.1 (the definitive-check row); plan 07 G2 |
| (d) | taken | `espn_analyze_retrospective` returns `baselines.espn_projection_lineup.informative: false` while `weight_espn = 1.0` — a field, not prose (plan 07 C9's own rule) — plan 07 E13 (output, method), C9; plan 09 §3.5 |
| (e) | taken | `eff setup` prints one sentence before the launchd-context test that a Keychain dialog may appear — plan 03 §2.1 step 4 |

Reviser's notes on R3: (c) changes what the daily job probes on such a league, not `espn_check_auth`, which still reports `accepted: null` there; (d) supersedes the R2 narrow reading that left E13's shape unchanged; no diagram was touched.

## R4 — consistency fixes after the docs pass (2026-09-30)

**Trigger:** the docs pass (README, SECURITY.md, indexes) found four places where the plan disagreed with itself after the adversarial review had closed. These are not objections and add no design: the orchestrator ruled on each (the four R4 rulings), and the reviser applied them exactly. **Plan state:** `480352c`. **Edits landed in:** `2840a58` and the commit that adds this section.

| item | ruling | what changed (file §) |
|---|---|---|
| (1) `waivers` prompt priority | A Skill's prompt has its Skill's priority: `waivers` ships at P0 (plan 09 §1), so `espn.waivers` is a P0 prompt — eight P0 prompts, five P1 | plan 07 §4.2 (P0 and P1 prompt lists); plan 10 §1 (row 1a), §3.1a (*Prompts*), A3a, §3.2 (*Skills*: the five P1 prompts); README unchanged — its prompt list states no priorities |
| (2) Channel-2 pending file | Plan 10 §3.W prerequisite (c) is right: the one-time code travels in the notification only, and nothing about a pending confirmation is written to disk in plaintext | plan 02 §1 (diagram node → `NOTIF["macOS notification"]`), §4.2 (channel 2 row); plan 03 §8 step 4 (uninstall no longer mentions pending confirmations); plan 10 §3.W prerequisite (c) and §4 T-09 (wording only). *(Refined by V1: no plaintext copy of the code is written anywhere; the journal row holds the diff and the keyed hash.)* |
| (3) Annotation families for D1–D5 and E14 | One new family, "Dataset reads (local store: nflverse and other ingested sources)" — `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` — for D1–D5; a D-tool whose own catalog entry makes an ESPN request says so and keeps `openWorldHint: true`; E14 joins the Ops / local-read family (`readOnlyHint: true`, `openWorldHint: false`) | plan 01 §4.1 (family table: the new row; the Ops row gains `espn_list_recommendations`); plan 07 §2 (*Annotations*), D1–D5 (an annotations line each — D2, D3 and D5 with `openWorldHint: true`), E14; README (annotation-family table: `DS` and `DS+E` replace the unnamed-family marker; rows D1–D5 and E14) |
| (4) The `permissions.deny` set | Enumerated once in plan 10 §3.W prerequisite (a), marked [A] until checked against the client's permission-rule syntax: the three commit tools in both install-path forms, `Bash(eff confirm:*)`, `Bash(eff setup:*)`, and `Read` of the config directory; plan 03 §5 #13 points to it | plan 10 §3.W prerequisite (a); plan 03 §5 #13 (fix column); README unchanged — it never said that no set is defined |

Reviser's notes on R4: the D-tools that keep `openWorldHint: true` are the three whose own entries name an ESPN request — D2 (ESPN's injury enum, from cache or one `kona_player_info` request), D3 (the keyless `proTeamSchedules_wl` view when the store is empty) and D5 (`mPositionalRatings`); D1 and D4 read only the store. Plan 07 §2's "the sixth family" became "the local-store write family", because a positional count stops being right once a family is added; the plan 01 Ops row is labelled "Ops (local reads)" to carry the ruling's name. The config directory in the deny set is named by its path (plan 01 D16), not by a guessed rule string. The "file store" in the forgeability sentences (plan 02 §4.2, §8 #14; plan 10 §4 T-09) is the credential file-store fallback, not a file of one-time codes, and was left as it stands. No objection, tension or nit total changes; no Mermaid block other than plan 02 §1 was touched.

### Verification pass

**Scope and result (2026-09-30).** After R4, a verification pass cross-read the plan, the README, `SECURITY.md`, `.env.example`, the indexes and HANDOFF against the canonical facts. Each finding that survived adversarial verification was re-read at its cited text and then fixed with a minimal text edit, skipped as not a defect, or left for the owner when a fix would need a design decision. No ruling, objection, tension or nit total changes. **Edits landed in:** `7d03833` (plans 01–10), `ab04385` (README, `.env.example`, indexes, the Summary) and the commit that adds this record (this section, HANDOFF). **Checks run:** all 14 Mermaid blocks (README diagrams 1–8; plan 01; plan 02 ×3, incl. §1; plan 03; plan 08) parse and render with Mermaid 11.17.2 at `ab04385`, and this pass edited none of them. An identifier scan of every tracked file finds no member GUID outside the fake range, no IPv4 literal other than `127.0.0.1`/`0.0.0.0`, no league id and no cookie value. It finds one absolute path, a GitHub-runner home-directory build path quoted in research 01 (F21, below).

| key | file § | what changed |
|---|---|---|
| F1 | plan 10 §3.W prerequisite (a) | the deny set's `Read` rule names the configured config directory: `EFF_CONFIG_DIR` (default `~/.config/espn-fantasy-football-mcp/`); under the plugin install it covers `${CLAUDE_PLUGIN_DATA}` and also the default directory, which still holds the file-store fallback (plan 09 §4). *(Superseded by V6: one config directory under every install path.)* |
| F4, F15, F26, F29, F48 | HANDOFF ▶ NEXT STEP, Program status, Open items, Log | the plan state after R4 and this pass; `docs-writer` ✅ (`315ebe5`); the README item ticked; the R4 and verification-pass entries logged |
| F5, F17, F39 | plan 00-index (Review record); `docs/README.md` (plan list); changelog Summary | the changelog is described as §R1–§R3 plus §R4 |
| F6 | plan 10 §6 (new A-8), §3.W (a); plan 03 §5 #13 | the `permissions.deny` syntax assumption is ledger row A-8, and both pointers cite it |
| F8 | plan 02 S4, §3.2 | S4 names four registration gates (it adds the validated stored credential); §3.2 says that Env, Acknowledgement, Own team and Credential are the registration gates and that Scope and Cap are per-write limits; the Credential row is checked at registration too |
| F9 | plan 04 §1 tree; plan 08 §8 | `fixtures/golden/` → `fixtures/engine-edge/`: hand-built engine unit-test inputs, never golden evidence; the golden's expected `appliedStats` live only in `recorded/` |
| F10, F30, F42 | plan 10 A16a | the tarball holds exactly plan 04 §2's `files`, so it adds `scripts/eff-launch.sh`, `.claude-plugin` and `.mcp.json` |
| F11 | changelog Summary item 5; plan 07 C3 | `espn_search_players` is named as the one P0 tool without a P0 Skill caller; it stays P0 as the only path from a name to an id |
| F12, F32 | `.env.example`; README Configuration row | `EFF_SETUP_PORT` is commented out. Unset: 8790, then 8790–8799. Set: that exact port, no fallback (plan 03 §2.2) |
| F14, F54 | plan 07 §5.4; plan 01 §3.1 | "never changes mid-session" now applies to v1 only; in the writes phase a gate turning false unregisters the write tools and sends `list_changed` (plan 02 §3.2). *(Superseded by V4: the tool set changes only at process start, in the writes phase too.)* |
| F16, F31 | changelog §R4 | this record replaces the placeholder; the render results are in *Checks run* above |
| F18 | HANDOFF finding 9 | "stored credential" → "validated stored credential" |
| F20 | plan 06 §1.4 budget line | per-day arithmetic: 7 projection requests on a snapshot day (21 a week), ≈ 10–24 requests on a day with a pool run. *(Superseded by V7: two caps; the projection term is 0–7 a day.)* |
| F22 | plan 09 §3.7 (evals), §5.2 | the variant `cookie-rejected` → `auth-rejected`, because the `.gitignore` glob `*cookie*` would ignore that directory (plan 04 §1). Research 06 keeps the old name |
| F23 | `docs/README.md` (Conventions) | "no absolute local path in any file on `main`", with the git-history residual disclosed (HANDOFF item 13) |
| F24 | README Security model; FAQ | the non-affiliation statement is added to both |
| F25 | README Safe credential setup §3 | discloses the runtime Keychain prompt and the `security`-CLI variant, which plans 02 §2.2 and 06 §2 say the README carries |
| F38, F55 | plan 04 R3 | the keyring's only import site is `src/auth/keychain.ts` (plus tests), as §3 and the tree say |
| F40 | plan 05 §7 | the coverage exclusion is `src/cli.ts` |
| F43 | plan 05 §5 | the smoke `jq` paths follow plan 07 A1/G1 and plan 10 A3a |
| F44 | plan 02 §2.1 (Short-circuit), §2.2 (Multiple processes) | a rejected server compares `storedAt` and reloads after `eff setup`, with no restart (plan 03 §6; L6) |
| F45 | plan 09 §2 (`orient.md`), §5.1 #3 | a P1-labelled step in a P0 Skill runs only under `full` and is validated under `full`; the rest of the body is validated under `core` |
| F46 | plan 09 §3.8 | `espn_get_depth_chart` is labelled P1 |
| F50 | plan 10 exit gates (1a; Phase 2) | the parts of A9a, A11a, A12a and B3–B6 marked hard are now gated |
| F51 | plan 05 §6 Q3 | the stat is 77 (made FG, 40–49) |
| F52 | plan 07 E2; plan 10 C2 | E2 cites C2; C2 no longer says "A7-style" |
| F53 | plan 01 §0.1 row 1, §0.4; plan 10 T-02 | Skill prose uses bare names; qualified forms appear only in frontmatter |
| F57 | plan 07 A1; plan 10 B13 | the families enum matches plan 08 `BracketFamily` (nine values); `fg_50p_legacy` is a member of `fg_distance` |
| F59 | plan 01 §11; plan 04 §1 `src/cli` | one subcommand per plan 06 job, plus `tune --apply` (Phase 3) and `journal reconcile` (writes phase) |
| F60 | plan 07 G2; README Ops table | the probe vocabulary is `settings` / `board` |
| F61 | plan 02 §5 | `scoringPeriodId` 0–22 is the outer bound; a tool's `week` is 1–18 (plan 07 §2) |
| F62 | plan 04 §1 tree; plan 05 §9 | `tests/backtest/` now exists for plan 10 §2's backtests |

**Parked items — resolved by orchestrator rulings V1–V8 (2026-09-30).** The pass left each of these for a design decision; each is now resolved, and its row is in [*Orchestrator rulings on the parked items*](#orchestrator-rulings-on-the-parked-items) below.
- **F3** — resolved by **V1**. The `PreparedWrite` row and an unkeyed `sha256` of a 6-digit code were written to disk; narrowing the sentence and keying the hash was a design change.
- **F41** — resolved by **V4**. How the Credential and Own team gates are known when the tools register: neither was known on the no-network startup path. The options were late registration or persisted evidence; the ruling is persisted evidence, and doctor #13 follows it.
- **F47** — resolved by **V6**. The plugin server's `${CLAUDE_PLUGIN_DATA}` config and cache directory differed from the defaults that `eff setup`, `eff refresh` and launchd use.
- **F49** — resolved by **V5**. L5 said doctor "never modifies the credential store", but doctor #16 updated the `meta` timestamps.
- **F13, F56** — resolved by **V2**. The launcher-only `EFF_NODE` and the test-only keys conflicted with a README table generated from `schema.ts`.
- **F58** — resolved by **V7**. On a game day, the job fleet's keyless and credentialed requests together exceeded the "≤ 40 per day" line.
- **F59 (remainder)** — resolved by **V8**. Plan 05 §4.2 used the `--service-name` test flag, which plan 03 §2.1 did not define.
- **F21, F37, F64** — resolved by **V3** (the orchestrator, `331dbf6`). Research 01 line 687 quoted a GitHub-runner home-directory path that plan 04 R11 fails; the prefix is now elided there.

**Skipped as not a defect:**
- **F7:** plan 07's legend applies family annotations "unless stated". G2 states its own annotations, and the README reproduces them.

### Orchestrator rulings on the parked items

**Trigger:** the eight parked items above and ten residuals (C1–C10) that a recheck of the verification pass found. The orchestrator ruled on each (2026-09-30), and the reviser applied the rulings exactly, taking the narrowest reading where a ruling was ambiguous. These are rulings, not an adversarial round: no objection, tension or nit total changes. **Plan state:** `331dbf6`. **Edits landed in:** `34a88e8` (plans 01–10), `5e56254` (README, `SECURITY.md`, the indexes) and the commit that adds this section.

| id | ruling | what changed (file §) |
|---|---|---|
| V1 (F3) | The one-time code is kept on the `PreparedWrite` as `HMAC-SHA256(gate_key, code)` — never an unkeyed hash, which enumeration reverses; no plaintext copy of the code is written anywhere, and the journal row holds the diff and the keyed hash | plan 02 §4.2 (channel 2 row); plan 10 §3.W prerequisite (c) and §4 T-09 (the same channel-2 wording); the wrong-code cap already stood in plan 02 §4.2 ("3 attempts, then voided"), so no line was added |
| V2 (F13, F56) | Plan 03 §3 lists every key the code reads by scope — server, launcher (`EFF_NODE`), test (`EFF_FIXTURE_DIR`, `EFF_FIXTURE_RECORD`, `EFF_TEST_STUBS`); `schema.ts` declares each with a `scope`; the README Configuration table carries the server and launcher keys, the README Testing section the test keys, `.env.example` the server and launcher keys only; `docs-current` covers all three scopes | plan 03 §3; plan 04 §1 (tree: `schema.ts`), §4.2 (`docs-current`), §6; plan 05 §3.1 step 5 (names the test keys); README Configuration (the note, the closing line) and Testing (a test-only settings table); `.env.example` unchanged — it already lists the server and launcher keys only |
| V3 (F21, F37, F64) | Done by the orchestrator: the research 01 quote's runner path elided at `331dbf6` | this changelog only; `docs/README.md` Conventions names no residual absolute path on `main`, so it is unchanged |
| V4 (F41) | The four registration gates are evaluated at process start from persisted evidence, with no network and no keychain read: Env = `EFF_ENABLE_WRITES`; Acknowledgement = the typed acknowledgement in `config.json`; Credential = the `store.sqlite` `credential_state` row says `validated`; Own team = `ESPN_TEAM_ID` recorded in `config.json` by `eff setup`. No late registration, no `list_changed`; a credential rejected mid-session makes the listed `prepare_*`/`commit_*` tools refuse through the short-circuit until restart | plan 02 S4, §3.2 (the Own team and Credential rows, the paragraph), §4.1 (one sequence-diagram message); plan 03 §1.1 step 6, §5 #13, §6 (the write-host row); plan 07 §3.F (heading), §5.4; plan 10 §3.W W2; plan 01 §3.1 (the list-TTL sentence); README Writes, the `EFF_ENABLE_WRITES` row, Security model (*Least privilege*); `SECURITY.md` *Writes and the confirmation gate* |
| V5 (F49; the recheck residual on the reload signal) | Credential observations (`credential_state`, `lastAcceptedAt`, `lastRejectedAt`, `rejected_since`, `next_probe_at`) live in a `credential_state` table in `store.sqlite`; the credential store holds only the secret and its setup metadata (`storedAt`, `format_version`, `fingerprint`) and is read-only after setup in both backends; the reload signal compares the recorded `storedAt` field, not the file's modification time; doctor never modifies the stored secret or its setup metadata, and `--online` records its observation exactly as `espn_check_auth` does | plan 01 D6, §1.1 (Auth row), §5.1, §9.2 (the table list gains `credential_state`), §10; plan 02 §2.1 (a paragraph under the state diagram; the Short-circuit row), §2.2 (Location, Multiple processes, a new *Credential observations* row); plan 03 L5, §1.1 step 4, §5 #6, #7, #16, §6; plan 06 §1.4 (`credential check` outputs); README Ops table (`eff doctor`), Safe credential setup §3 |
| V6 (F47) | Every entry point — the server launched by the plugin or by a client config, the `eff` CLI, the launchd jobs — uses one config and one cache directory: the defaults, or the same explicit `EFF_CONFIG_DIR`/`EFF_CACHE_DIR` values that `eff print-config` and `eff install-launchd` write; the plugin's `.mcp.json` sets neither, and the plugin data variable is not used (plan 09 §4 says so once, with the reason) | plan 01 D16; plan 03 §4.1 (a new bullet); plan 06 §2 (`EnvironmentVariables`); plan 09 §4 (the `.mcp.json` comment; the shared-location bullet), §6 (Claude Code row); plan 10 §3.W prerequisite (a) (the `Read` rule names the one config directory); README launch configuration (the two env lines removed; a new bullet) |
| V7 (F58; plan 06 arithmetic) | The job fleet's ESPN budget is two daily caps, both enforced by the global limiter: ≤ 40 cookie-bearing and ≤ 30 keyless requests (drift probe, pro-team schedule, player index); the projection term is 0–7 a day (7 on each of the three snapshot days, 21 a week); every range equals the sum of its terms; a game-day estimate for each cap | plan 06 principle, §1.2 and §1.3 budget lines, §1.4 budget paragraph (cookie-bearing ≈ 10–24 on a pool day and ≈ 3–18 on a game day; keyless ≤ 27 on a game day, 7–8 otherwise); plan 10 A5b; README Ops table (the zero-token automation row) |
| V8 (F59 remainder) | `eff setup --service-name <name>` is a test-only flag: it changes the keychain service name so the macOS integration test never touches the real item, and it is refused unless the name starts with `eff-test-` | plan 03 §2.1 (the flags paragraph); plan 05 §4.2 already used it — unchanged |
| C1 | The tarball holds exactly plan 04 §2's `files` plus `package.json` (which npm always includes), and nothing else | plan 04 §4.1 (`pack` row); plan 10 A16a |
| C2 | Covered by V5 or already done by the orchestrator (ruled together with C5, C6, C7 and C9) | no separate edit: V5's row above, or `331dbf6` (roster, research 01 elision, HANDOFF wording, closing-verdict annotation) |
| C3 | The README Ops table names all three snapshot kinds | README Ops table: `eff snapshot <roster\|pool\|projections>` |
| C4 | Covered by V7 | V7's row |
| C5 | As C2 | as C2 |
| C6 | As C2 | as C2 |
| C7 | As C2 | as C2 |
| C8 | Covered by V4: doctor #13's pass condition names all four gates | plan 03 §5 #13 |
| C9 | As C2 | as C2 |
| C10 | Plan 03's input citation says the Node on this machine is below the floor | plan 03 header (*Inputs*): "Node 22.23.2 via `fnm` today — below the ≥ 24.15 floor, doctor #1" |

Reviser's notes on the rulings (narrow readings):
- **V1:** plan 02 §4.2 already capped wrong codes ("3 attempts, then voided", as plan 05 §4.3 and plan 10 W1 test), so the ruling's conditional line was not added and the existing `voided` outcome was not renamed. Plan 10 §3.W (c) and T-09 restated the old channel-2 wording, so they now carry the new one.
- **V4:** plan 01 §3.1 was not in the ruling's file list but restated the run-time unregister, so it was aligned. Plan 02 §3.2's "second owner appearing" now makes `prepare_*` refuse at the own-team re-check that already ran on every `prepare_*`; the [V-sib 02 §3.4] citation went with the run-time unregister it supported. The plan 02 §4.1 sequence message changed its wording only and adds no `:` `;` `|` or parentheses.
- **V5:** the state-diagram labels were left as they are — they name the observations, not where they live; the location is a paragraph under the diagram, so no Mermaid label changed. The `fingerprint` in the setup metadata is plan 02 §2.3's 6-hex fingerprint; status and doctor still never show it. Plan 07 G1/G2 name no storage location and are unchanged; `SECURITY.md` names none either.
- **V6:** the plists carry `EFF_CONFIG_DIR`/`EFF_CACHE_DIR` only when the user has overridden them (the defaults need no entry). Plan 03 §8 (uninstall) still names the default directories.
- **V7:** the game-day cookie-bearing pool term is 0–6, not 0–12, because the Tuesday 06:00 run never falls on a game day. The keyless game-day figure counts the 05:00 schedule run and the host probe separately, so 27 is an upper bound.
- **V8:** plan 05 §4.2 also passes `--service-name` to `eff uninstall`, and doctor #7 reads the item; the ruling defines the flag for `eff setup` only, so those uses were left as they are — a question for the build.
- **Summary:** it names no parked item (its owner decisions are D0 and D2, which no ruling touches), so it is unchanged.

Follow-up fixes from the audit:
- **G1** · plan 02 §2.1 (the definitive-check row) · a 401/403 means delete + `NotConfigured` in `eff setup` only; in `eff doctor --online` #16, `espn_check_auth` and the daily job it means `Rejected`, with `lastRejectedAt` recorded in the `store.sqlite` `credential_state` table and the stored secret untouched (L5); a 404 means the league id is wrong (setup deletes the value; elsewhere `ESPN_LEAGUE_NOT_FOUND`, not a credential observation).
- **G2** · plan 02 §2.2 (file location), plan 03 §1.1 step 1, plan 04 §1 (`paths.ts`) · `$XDG_*` is not read: the directories are the two fixed defaults or explicit `EFF_CONFIG_DIR`/`EFF_CACHE_DIR` values (V6, plan 01 D16).
- **G5, G32** · plan 05 §4.2 (keychain round trip), plan 03 §2.1 · the test checks and cleans up the test items with `security find-generic-password`/`delete-generic-password -s eff-test-…`; `--service-name` stays on `eff setup` only (V8) and the step 4 throwaway item follows it (`<name>-selftest`); the test no longer runs `eff doctor` #7 or `eff uninstall`, which use the real service name.
- **G7, G40** · plan 06 §1.2 (budget), §1.4 (keyless sum) · the drift probe is 2 requests a run, so 4 on Tuesdays; other days 1–4 + 4 + 1 = 6–9 (the lower bound is the merged case of G19); game days 1–2 + ≤ 24 + 1 ≤ 27.
- **G9** · plan 02 §4.2 (channel 2), §4.4; plan 05 §4.3; plan 10 W1 · three wrong codes end the prepared write in a terminal journal state, `voided_code`; the user must prepare again.
- **G13** · plan 01 §10 · the keychain accounts are `espn_s2`, `SWID` and `meta` (setup metadata only).
- **G15** · plan 07 G2 · on a private league `mSettings` 200 = accepted, 401/403 = rejected, 404 = `ESPN_LEAGUE_NOT_FOUND` (not a credential observation).
- **G16** · plan 03 §1.1 step 4, §10 A-3; plan 05 §4.2 · startup takes the state from the `credential_state` row (plus a `stat` of `session.json` for the file store) and never reads the keychain; the `meta` item is read with the secret on the first cookie-bearing call, which corrects the label; the `unknown` state is removed; `EFF_TEST_STUBS` exits 99 on any keychain read.
- **G18** · plan 03 §2.1 (`--storage`), §3, §5 #6; plan 02 §2.2 (env override); plan 06 §2 (plists); `.env.example`; README Configuration · the store `eff setup` records in `config.json` is authoritative (the one exception to env > `config.json`); an env `EFF_CREDENTIAL_STORE` that disagrees is not used and doctor #6 fails on it; the plists no longer carry the key; `--storage keychain` runs the launchd-context test and is refused unless it is `ok`; the `.env.example` line is commented out.
- **G19** · plan 06 §1.2, §1.4 (`credential check`); plan 01 §7 (the daily probe) · the shape probe is merged with the credential check only on a private user league, on one schedule (daily 05:00, plus Sun 08:00 in season; the Tuesday 12:00 run is then the host probe only); on a public user league the shape probe runs without cookies and the credential check stays the board probe.
- **G20** · plan 02 §2.1 diagram; README Architecture §4 · new edge `Stored --> Rejected` for any cookie-bearing 401/403 after setup (the value is kept).
- **G23** · plan 01 §3.1, plan 07 §5.4, plan 10 W2, README Writes · after a mid-session rejection the write tools refuse through the short-circuit while the credential stays rejected and stay listed until restart (V4, as plan 02 §3.2 says).
- **G24** · plan 10 §3.1a · migration 001's table list names `job_lock` and `credential_state`.
- **G31** · plan 03 §5 #17 · anonymous only: 200 = public, 401 = private (cookie acceptance is #16), 404 = wrong id or season.
- **G34** · plan 09 §3.7 `session-check` · `stored` on any league → `espn_check_auth` once (the `mSettings` probe on a private league).
- **G37, G38, G39, G41, G42** · plan 03 §5 #16; plan 04 §4.3 (`espn-league-id`); plan 08 §7 P9, P15; plan 06 §1.3 (`sleeper:trending`); plan 08 §3.1 (the `fga_*`/`fgm_*` row) · table rows repaired so each has its header's cell count: pipes inside code spans escaped as `\|`, and the merged names-and-ids cell split in two.
- **Not fixed here (outside this pass's editable files):** G4, G35, G36 — `docs/HANDOFF.md` ▶ NEXT STEP, Program status and Open items still list the parked items and the research 01 runner path as open; G43 — four research table rows with unescaped pipes (research 03 line 385, 04 line 39, 05 line 97, 06 line 157).

#### Loop-until-dry pass

- **L1** · plan 04 §4.5 (`scheduled.yml`, macOS runner) · the keychain round trip is restated as plan 05 §4.2 has it: `eff setup --storage keychain --service-name eff-test-<random>` with a fake value, then the items are checked and deleted with `security find-generic-password`/`delete-generic-password -s eff-test-<random> -a <account>`; the `eff doctor` #7 and `eff uninstall --yes` steps are removed, because both would touch the real service name.
- **L2** · README Testing (levels table, keychain round-trip row) · "`eff setup` under a throwaway `eff-test-…` service name, then the items are checked and deleted with macOS's `security` tool; the real service name is never touched" replaces "Setup → doctor → uninstall".
- **L3** · plan 02 §2.1 diagram; README Architecture §4 diagram · new edge `Stored --> Validated` for an `espn_check_auth` or daily credential-check probe 200 (`lastAcceptedAt` set); the README's setup `401 or 403` edge (`Stored --> NotConfigured`) now says "setup check", as plan 02's does. The §2.1 table already agreed (the definitive-check row sends a 200 to `Validated` from every place it runs).
- **L4** · plan 06 §0 J5 · the daily credential check is the shape probe's request only when no public probe league is configured and the user's league is private (§1.2); on a public user league it is the separate board probe.
- **L5** · README Testing (test-only settings, `EFF_TEST_STUBS`) · "any network call or keychain read", as plan 05 §4.2 says.
- **L6** · plan 03 §2.1 (the `--service-name` flag); plan 05 §4.2 (keychain round trip) · a setup run given `--service-name eff-test-…` skips step 5, and with it the step 6 request, and prints that it did; a throwaway test item holding a fake value is never sent to ESPN, so the test makes no network call (plan 05 §8). The test asserts the items exist, then deletes them with the `security` CLI. When the launchd-context self-test outcome that setup records is not `ok`, the test is skipped and logs that outcome.
- **L7** · plan 02 §4.4; plan 07 F7; plan 05 §4.3; plan 10 W1 · `espn_cancel_prepared` leaves the journal row in the terminal state `voided_cancelled`, beside `voided_code`. The gate tests add: cancel → `voided_cancelled`, then commit → zero POSTs.
- **C1-1** · plan 02 §2.1 diagram; README Architecture §4 diagram · the `Stored --> Validated` edge added by L3 now reads "`espn_check_auth`, `eff doctor --online` or daily credential-check probe accepted" — the result, not a status code, as the §2.1 table defines it (a 404 from an informative board probe is accepted; a 200 from a board probe that cannot tell is `accepted: null` and stays `Stored`), with doctor #16 listed.
- **C1-2** · README Architecture §4 diagram · the 404 edge is limited to setup: `Stored --> NotConfigured: setup check found no such league id - the stored value is deleted` (elsewhere a 404 is `ESPN_LEAGUE_NOT_FOUND`, plan 02 §2.1).
- **C1-3** · plan 06 §1.4 (`credential check`) · the reference by edge position ("third edge") becomes a reference by name: the `Rejected --> Validated` daily credential-check edge.
- **C1-5** · plan 02 §2.1 diagram · the four labels with parentheses after the ':' separator are rewritten with commas and ' - '; the two `Rejected --> Validated` edges say "accepted" rather than "200", as C1-1 and the README do.
- **C1-6** · plan 04 R5; plan 06 §1.1 (process/lifecycle row) · the macOS job runs weekly only (`scheduled.yml`, plan 04 §4.5), as plan 05, the README and `release.yml` already had it; "and on release" / "+ release" are dropped.
- **C1-7** · plan 02 §2.1 (Short-circuit row); plan 03 §6; plan 05 §2 (`auth/state`), §4.1 (fault matrix); plan 10 A2b · in `Rejected` the short-circuit also re-reads the `store.sqlite` `credential_state` row (no keychain read, no network); when another process (the daily job, `eff doctor --online`, `espn_check_auth` in a second server) has recorded `validated` with a later `lastAcceptedAt`, the running server reloads the secret and goes to `Validated` without a restart. A fault test and A2b assert it.
- **C1-8** · plan 02 §2.1, §2.2 (credential observations); plan 03 §1.1 step 4; plan 07 G1; plan 01 §9.2 · option (a): `eff setup` writes `stored_at`, a non-secret copy of the setup `storedAt`, into the `credential_state` row (and a row the first cookie-bearing call recreates carries it), so `espn_get_status` fills `stored_at`, `age_days` and `stale_warning` with zero credential-store reads; they are `null` when there is no row.
- **C1-11** · plan 03 §2.1 step 4, §3, §5 #6; plan 02 §2.2 (env override); plan 06 §2 (plists); `.env.example`; README Configuration · the file store's resolved `session.json` path is recorded by `eff setup` in `config.json` as `EFF_CREDENTIAL_FILE` and is authoritative like `EFF_CREDENTIAL_STORE` (two exceptions to env > `config.json`); a disagreeing env value is not used and doctor #6 fails on it, so the server and the jobs read the same file.
- **C1-12** · README Architecture §4 diagram · the same edit as C1-2 (the duplicate finding).
- **C1-13** · plan 03 §2.1; plan 05 §4.2; plan 04 §4.5 · plan 03 now states the Phase W non-TTY refusal of `eff setup` (exit 2; no flag exempts a run, `--service-name` included), and the macOS keychain round trip feeds the fake value through a pty instead of a pipe.
- **C2-1** · plan 02 §2.1 diagram; README Architecture §4 diagram · the tool's `Rejected --> Validated` edge now reads "espn_check_auth or eff doctor --online probe accepted, the tool at most once per minute", identically in both, as the §2.1 table and the short-circuit row already had it.
- **C2-2** · plan 10 A2b; plan 01 §4.3 (`ESPN_AUTH_REJECTED`); README error-code row, Security §4 · `eff doctor --online` joins the list of ways out of `rejected`.
- **C2-4** · plan 05 §4.2; plan 03 §2.1 (non-TTY stdin) · every process test that spawns `eff setup` — the `--page` port, POST and SIGINT tests and the keychain round trip — runs it under a pty (util-linux `script -qec` on ubuntu, `script -q /dev/null` on macOS); from Phase W prerequisite (c) on, one more case spawns setup with piped stdin and asserts exit 2 with the TTY message.
- **C2-6** · plan 02 S3, §2.1 diagram; plan 06 §3 (`credential_state = rejected`); plan 07 G2 Method; README diagram 4 · `eff doctor --online` is named as a way back from `Rejected` wherever the ways are listed (the plan 01 §4.3, plan 10 A2b and README rows are C2-2's).
- **C2-8** · plan 01 D6 · the truncated clause is completed: credential observations are in the store, as the `credential_state` row with `stored_at` (§9.2; plan 02 §2.1).
- **C2-10** · plan 01 D16; plan 03 §4.1, §5 #4; plan 09 §4; README launch configuration · option (a): the plugin's fixed `.mcp.json` sets neither directory variable, so the plugin install supports the default directories only; an override needs a client-config launch, and `doctor` #4 warns when `EFF_CONFIG_DIR` or `EFF_CACHE_DIR` is set.
- **C2-11** · plan 02 §1 diagram · `store.sqlite` no longer lists datasets (it now names `credential_state`); a new node for the per-source dataset files, read-only to the server, receives the data sources' edge.
- **C2-13** · plan 02 §2.1 diagram; README diagram 4 · new edges `Stored --> NotConfigured` (`eff setup --reset` or `eff uninstall`) and `Validated --> Stored` (setup run again with a new value).
- **C2-14** · plan 02 §3.2 (Own team gate) · the team is resolved in setup's team-resolution step, the `mTeam` request that follows the definitive check, not during the check.
- **C2-15** · plan 02 S7 · the ticket's HMAC input list gains `period`, matching §4.3.
- **Not fixed here (outside this pass's editable files):** C2-7 — `docs/HANDOFF.md` ▶ NEXT STEP still lists F3, F41, F47, F49, F13/F56, F58 and the `--service-name` flag as decisions for Chad, though V1–V8 resolved them, and says the research 01 runner path remains, though `331dbf6` (V3) elided it.

#### Final residuals (orchestrator rulings)

Each row: id · ruling · file § · change.

- **R-1** (C3-1, C3-2) · `EFF_CONFIG_DIR`/`EFF_CACHE_DIR` overrides are supported for client-config installs only; a plugin install uses the default directories, because the plugin's `.mcp.json` cannot carry per-user values for them and a GUI-launched plugin does not reliably inherit the user's shell environment; `EFF_NODE` for the plugin shim is optional for the same reason · plan 01 D16; plan 03 §4.1; plan 09 §4; README launch configuration · the opening clauses now name the server, the CLI and the jobs on the default directories, scope the overrides to a client-config install (`eff print-config` into the client config, `eff install-launchd` into the plists) and state the plugin's default-only rule with its two reasons and the optional `EFF_NODE`; no sentence says the plugin's server uses override values. `doctor` #4 (plan 03 §5) already warned for the same reason and is unchanged.
- **R-2** (C3-5) · the refresh process, not the server, downloads and writes the datasets · plan 02 §1 diagram · a new node `REFRESH` ("eff refresh - separate process, launchd") outside the server-process subgraph; the T3 download edge to nflverse moves to it; it is the only writer of the per-source dataset files node; the data-sources component's edge to that node reads "reads only".
- **R-3** (C3-6) · setup is not the only way out of `rejected` · plan 01 §4.3 (the `ESPN_AUTH_REJECTED` example) · the hint now reads "In a terminal run: eff setup — then retry here. This usually means espn_s2 expired; cookie-bearing calls stay paused until setup or a successful re-check (espn_check_auth, eff doctor --online, or the daily check).", matching the error-code row below it.
- **R-4** (C3-7) · the non-TTY refusal starts with Phase W · plan 04 §4.5 (`scheduled.yml`, keychain round trip) · the parenthetical reads "setup refuses a non-TTY stdin from plan 10 §3.W prerequisite (c) on, plan 03 §2.1"; its second clause (the test service name skips the ESPN check) is kept.
- **R-5** (C3-8) · an acceptance is recorded only from a discriminating observation: on a private league any cookie-bearing 200; on a public league only the board probe when its anonymous control answered 401; after a rejection on a public league whose board probe does not discriminate, a cookie-bearing 200 on the view whose 401 caused the rejection (R3 nit (c); this case added by K1 below); any other cookie-bearing 200 on a public league records nothing · plan 02 §2.1 (diagram; the definitive-check row); README Architecture §4 diagram · the `Validated --> Validated` edge reads "cookie-bearing 200 on a private league or an informative board probe" in both diagrams; the definitive-check row states what counts as an acceptance for every process and request.
- **R-6** (C3-9) · `eff probe` is keyless when a public probe league is configured; with none configured and a private user league, the shape probe is the cookie-bearing credential check (one request), as plan 06 §1.2 row 2 and plan 01 §7 already said · plan 06 J4, §1.2 heading; plan 05 §1 (live-probe row), §8 (`eff probe` row); README diagram 1 (the jobs' drift-probe edge), diagram 5 (the probe subgraph label), Testing (live-probe row); `docs/plan/00-index.md` (row 06) · the unconditional "no cookies" statements become "keyless when a public probe league is configured (plan 06 §1.2)", or inside Mermaid labels "keyless with a probe league".
- **R-7** (C3-16) · the drift probe runs daily, with a second run on Tuesdays · plan 01 D7 · "1 drift probe/day" becomes "a daily drift probe (a second run on Tuesdays, plan 06 §1.2)".
- **R-8** (C3-17, C3-18) · no change: the Mermaid authoring-rule violations render correctly, and the authoritative gate is rendering (plan 04 R7's mermaid-cli job in CI; the orchestrator renders every block before hand-off) · — · none; recorded here only.
- **K1** (follow-up to R-5) · R-5's rule keeps the R3 nit (c) recovery path: after a rejection on a public league whose board probe does not discriminate, a cookie-bearing 200 on the view whose 401 caused the rejection is discriminating by construction and counts as an acceptance, so the daily `credential check` can still flip `Rejected → Validated` · plan 02 §2.1 (the definitive-check row); this subsection's R-5 row · the acceptance definition gains that third case; "any other cookie-bearing 200 on a public league records nothing" stays for everything else. Plan 06 §1.4 and plan 07 already describe the path and are unchanged.
- **K2** (follow-up to R-2) · README diagram 6 follows plan 02 §1: a separate refresh process downloads and writes the datasets, and the server only reads them · README Architecture §6 diagram · a node `REFRESH` ("eff refresh - separate process, launchd") inside the Mac subgraph and outside the server-process subgraph; the T3 and T4 edges end at it instead of the in-process loaders; `REFRESH` writes the dataset files by atomic rename as their only writer, and the loaders' edge to the store reads "reads the dataset files only". Both labels name the dataset files rather than the whole store node, because that node also holds `store.sqlite`, which the provider writes.
- **K3** (follow-up to R-2) · every download from an external data source starts at the refresh process (plan 06 §1.3: `refresh news`, `refresh weather`, `refresh odds`) · plan 02 §1 diagram · the T4 news edge and the weather-and-odds edge start at `REFRESH` instead of the server's data-sources component, which now has only its "reads only" edge to the dataset files.
- **K4** (follow-up to R-6) · the drift probe is keyless only when a public probe league is configured · README Architecture §5 caption; README FAQ ("What happens when ESPN changes the API?") · "a keyless daily probe" becomes "a daily probe (keyless when a public probe league is configured)", and "a daily keyless probe" becomes "a daily probe — keyless when a public probe league is configured —".
- **K5** (follow-up to R-6) · as K4 · plan 01 §1.1 (the `src/drift/` rationale) · "without cookies and without the server" becomes "without the server (and keyless when a public probe league is configured, §7, plan 06 §1.2)".
- **K6** (follow-up to R-2) · `eff refresh` stays the only writer of every dataset file, `ds_pro_schedule` included, as plan 01 §5.5 and README's CLI table already say · plan 06 §1.2 (the host probe), §1.3 (`refresh espn:schedule`) · the shared 05:00 host request is made by the `refresh espn:schedule` run, which writes `ds_pro_schedule` and runs the probe's host diff on the same response; `eff probe` never writes a dataset file. Plan 02 §1's "the only writer" label is unchanged. The §1.2 budget line still counts that one request under the probe as well as under the schedule job, so it stays an upper bound and is unchanged.
- **K7** (follow-up to R-1) · with an override set, the config directory differs by install path · plan 10 §3.W prerequisite (a) (the `Read`-deny rule) · the directory reads "`EFF_CONFIG_DIR` in a client-config install, else the default `~/.config/espn-fantasy-football-mcp/`, always the default for a plugin install; the CLI and launchd use the same one" instead of "the same directory under every install path".
- **K8** (follow-up to R-6) · with no probe league configured, the shape probe runs on the user's own league (plan 01 §7) · plan 05 §1 (the live-probe row); README Architecture §5 diagram (the shape-probe node) · "the CLI against the public probe league, else the user's league"; the node reads "on the probe league, else your league".

## Summary — what the adversarial process changed and what survived

For a reader who reads nothing else. The full record is `docs/plan/adversarial-log.md`; the row-by-row edits are §R1–§R3 above, plus §R4's consistency fixes after the docs pass.

**Totals.** Three rounds. **26 objections** — 1 blocking, 10 significant, 15 marginal (round 1: 20; round 2: 6; round 3: none) — all conceded by the defence and landed: 20 as ruled, 6 with a modification the devil's advocate accepted (OBJ-05, 06, 07, 12, 13, 18). **16 pre-filed tensions**, all resolved (one dismissed to a note, one merged, one already done). **15 nits** (10 in round 2 §2.4, 5 in round 3 §3.1), all taken (the advocate's closing paragraph says "twenty-five nits"; the itemised lists total 15). Nothing withdrawn, nothing rejected, **nothing pressed at close**.

### Changed

1. **The engine's gate can no longer pass vacuously.** Phase 1a's golden reads only recorded ESPN weeks (the public probe league, keyless), scored under the league that was recorded; the Skills' fixture league is a separate, labelled, derived class that is never engine evidence; the recording is a Phase 0 row (Z7) and the probe league (D2) a Phase 0 decision. Under D0-not-accepted the plan says exactly which scoring families stay unverified.
2. **The v1 numbers claim only what they have earned.** The point estimate is ESPN's (`weight_espn = 1.0`) until a backtest under this league's scoring shows a mixture is better, with shadow weights named; the waiver premium carries its ×0.5–×1.5 band and a `marginal` verdict kept off the claim list; the seeding reading is an operator answer with an unconfirmed flag rather than a detector; the retrospective says which comparisons are not informative.
3. **The fleet recovers without a human where it can, and says so where it cannot.** The daily credential probe is exempt from the short-circuit; one credential store per install is decided by a real launchd-context test; a host move has an operator override restricted to `*.fantasy.espn.com` and an honest "then a release"; a black-holed network costs 20 seconds, not 48; jobs schedule from the API's epoch-ms fields, not from a calendar baked into a plist.
4. **The store and the loop do what their tests assert.** Node ≥ 24.15; backups by `VACUUM INTO`; datasets in per-source files published by `rename()` and opened as separate read-only connections — under SQLite's verified limit of ten attachments; simulations yield every 20 ms under a measured 50 ms stall bound, with an 8 s deadline and a worker pool as the named fallback.
5. **The per-turn cost is budgeted where it is paid.** Eighteen P0 tools instead of twenty-one (every one with a P0 Skill caller except `espn_search_players`, kept at P0 as the only path from a name to a player id — plan 07 C1, C3); 20 000 / 35 000-character ceilings that can only go down; the two mandatory sentences once in the server `instructions`, with the delivery of that field to the model spiked per client and a fallback named; `outputSchema` kept in code and removable from the wire.
6. **The runtime lives where it can run.** Outside any file-provider directory, with `doctor` checking the directory that holds code, a stale `dist/`, the client's MCP log and a Node path that still matches; the plugin launches through `/bin/sh` and a shim instead of a bare `node` or a `bin/` directory.
7. **Every security "cannot" names the session for which it holds.** The confirmation channels are unforgeable only where the model has no shell or filesystem reach as the user — a property of the session, not the client — and the README and SECURITY.md say "unsupported" for the rest. The public-league credential check uses a probe that discriminates, and reports `null` where none does.
8. **The sibling's rulings are carried through its round 3**, and one finding went the other way: the attachment limit applies to the sibling's dataset layout too.

### Survived unchanged

- **The architecture:** one Node process, stdio only; the domain / provider / source / store layering with lint-enforced import boundaries; SQLite through `node:sqlite` for the main store; one path builder and one `X-Fantasy-Filter` builder with a view whitelist and `limit ≤ 100` plus a mandatory sort; the cache-first cross-process limiter with coalescing and a breaker; the envelope's `meta` (as-of, freshness, provisional, attribution, `estimate`); the error contract with fixed messages and no upstream body; per-view zod schemas that pass unknown fields through and hard-fail on missing required keys; skeleton detection; the daily keyless probe.
- **The shared-core decision** (two repos, a written contract, a named extraction trigger) and the `espn_` prefix.
- **The credential design's spine:** cookies only through a terminal prompt — never a tool argument, the client config or a log line; the keychain behind a seam with a `0600` fallback; "never retry a 401" per request; redaction of cookies, GUIDs, IPs and the league id.
- **Read-only as the product:** the operator-gated write module, own-team pinning, the prepare/commit gate's mechanics, and the verdict "recommended, do not build yet".
- **`untrusted_text` applied field by field** inside ESPN's fact objects, the deterministic injection flags and the invariance tests.
- **The scoring engine in full:** the canonical hub, the id-keyed ESPN table, bracket families, the property set P1–P16, and the per-stat golden against `appliedStats`.
- **The priority-waiver DP** and its cold-start table, the two-reading seeding simulator, ESPN's numbers labelled as ESPN's.
- **The thirteen Skills** and their two eval lanes.
- **The phasing shape** (0 → 1a → 1b → 2 → 3, W conditional, 4 later) and the honest expected-value paragraph for 2026.

### Residual concerns, ranked (from the closing verdict)

1. **Two decisions sit in front of everything and are Chad's.** D0 (the Disney Terms of Use literally cover this project; Phase 1b and every credentialed job wait on his accepting that account risk) and D2 (naming a public probe league — without it Phase 0's Z7 stays open and the 1a golden waits for D0). The plan cannot make either.
2. **The API is unofficial and the recovery is human.** A cookie of unknown lifetime with no refresh; a host move outside `*.fantasy.espn.com` or a renamed view is a release measured in days, in season. The plan degrades honestly; it cannot degrade gracefully past the cache's hard limits.
3. **Whether v1 is useful, not merely correct.** With ESPN's mean as the point estimate, a position-level spread, a cold-start premium table and hand-set role priors, the MVP's added value is the assignment, the priority rule with its band, the engine check and the discipline of labelled numbers. That may be thin until Phase 2's usage data and a season of the league's own feed; the retrospective is built to show it either way.
4. **The calendar.** Phase 1a is "L" with no measurement behind it, starting after a review at NFL week 4; the plan's own reading is late-season use and a corpus for 2027. The first two weeks of building will say whether that was optimistic.
5. **The fixture law is one path guard and one manifest flag.** It is the rule a builder under time pressure is most likely to bend; the aggregate re-derivation (R3 nit (b)) is in the plan before `gen-fixtures.ts` is written.
6. **Build-time unknowns, each worth up to a day, all named with a fallback:** Keychain behaviour under launchd; whether clients deliver `instructions` and forward `structuredContent`; `readOnly` on the Node 24 floor; the Desktop Code tab's environment; the never-observed transaction fields; 103/104; ESPN's rounding; the private-league 401 body.
7. **Reach-session detection is a heuristic.** Bounded because writes are unbuilt — but the sentence must keep saying "unsupported", never "safe".
8. **The plan is unbuilt.** Its acceptance criteria are tests, and the tests are the next adversary.

## B1 — measurements and records written back during the build (2026-10-06)

Not adversarial rulings: the numbers and pointers the plan said the build would write back.

- **A7a sizes** · plan 07 §5.1 (a "Measured" table after the per-turn paragraph) and plan 10 §2 (the token-sizes row) · `tools/list` under `core` 17 669 chars ≈ 4 418 tokens (ceiling 20 000), 19 631 with the ≤ 120-char fallback in every description, the Skills listing 2 597 chars (ceiling 4 600), and the per-tool result sizes; consequences recorded there: no C10 lever, `core` stays the default, the ceilings stay.
- **A2a list** · plan 10 §2 (the translator-agreement row: the producer is `tests/golden/translator-agreement.test.ts`; the list lives in `docs/evals/1a-translator-agreement.md`) · the row said "CI" only while A2a asks for the list in `docs/evals/`; both now hold.

## R5 — build-time rulings (2026-10-06)

**Trigger:** closing Stage B1's gate, two acceptance criteria (A9a, A10a) turned out to assume facts that neither the fixture league nor the research record can carry, and three minor defects surfaced. The orchestrator ruled on each (2026-10-06) and the B1 closeout engineer applied the rulings exactly. These are build-time rulings, not an adversarial round: no objection, tension or nit total changes; each supersedes the older text it names. **Plan state:** `cf275e4`. **Edits landed in:** `37d89c8` (the three minor items: code and tests), `a4b4830` (R5-1, R5-2: plan 10, plan 07 E5, the evals report, the A9a tool-level test, the test labels, and this section) and the commit that records these SHAs.

| id | ruling | what changed (file §) |
|---|---|---|
| R5-1 (A9a) | Research 05 §1.2 defines `W` as the usable weeks remaining **after** this week's claim; `src/domain/analytics/waiverDp.ts` follows it and reproduces the research table cell for cell (`Π(2, 13)` = 29.5). A9a's text assumed `fx-10h`'s clock gives `W = 13`; it gives `W = 12` (claim week 5, final week 17). The hard regression is now (i) the domain test reproduces `Π(2, 13)` within 0.5 of 29.5 (kept); (ii) `espn_analyze_waivers(mode: priority)` on `fx-10h` returns a premium equal to the DP table value at the tool's own reported `(k, W)` within 0.5, with `W` computed per the research definition from the league clock (a new tool-level test); (iii) the band and marginal clauses, unchanged. `W`'s definition is stated in plan 07 E5 | plan 10 A9a (rewritten as (i)–(iii): `(k = 2, W = 13)` dropped; on `fx-10h` `k = 2`, `W = 12`, `Π(2, 12) ≈ 27.0`, the cell research 05 §1.6 example A reads for the same state); plan 07 E5 (a `W` bullet after *Output `data`*); `tests/mcp/a9a-premium.test.ts` (new: `W` computed from `fx-10h`'s own `mSettings`, the tool's `k`, `W` and premium checked against the DP and against the research table read at that cell, and the claim-week-counted cell ruled out); `tests/domain/analytics/waiver-dp.test.ts`, `tests/domain/analytics/waivers.test.ts` (labels only); `docs/evals/1a-analytics.md` (the open question closed). No engine change: the implementation already followed the research |
| R5-2 (A10a) | Research 05 §2.4's ten-team table came from one unpublished seeded draw of the other seven teams' week 1–8 results (`seeding_mc.py`, never committed; a Python RNG cannot be reproduced from JS), so the `T4/T8/T2` cells cannot be a hard 0.03 regression. Hard: the hand-computed 3-team toy within 0.02 under both readings; `pf_per_win` finite under (a) and null under (b); the qualitative claims (the variance sign flips with the cutoff; T2 a favourite under (a), a bubble team under (b)). The ten-team reconstruction is **soft**, reported in `docs/evals/1a-analytics.md` with the reason, and its test is relabelled a reconstruction sanity bound (0.05 kept), not the plan tolerance | plan 10 A10a (rewritten: the hard and soft parts named, the reason given); `tests/domain/analytics/seeding.test.ts` (header and test titles: the two 0.05 checks labelled "soft — reconstruction sanity bound, not the plan tolerance", the populated table / `pf_per_win` and the qualitative findings labelled hard; no assertion changed); `docs/evals/1a-analytics.md` (the seeding section: hard and soft parts, the reason, the open-issue note removed) |
| R5-m1 | `espn_analyze_lineup` warns — a `warnings[]` entry naming the player id — for every `compare` pair it cannot evaluate (a player not on the roster, a locked player, the same player out and in) instead of dropping it silently | `src/domain/analytics/lineup.ts` (`compareWarnings`; one predicate shared with the solve, so a pair is evaluated or warned, never both, never neither); `src/domain/analytics/index.ts` (the export); `src/mcp/tools/analytics.ts` (E2 adds them to the envelope's warnings; ids only, no third-party text); `tests/domain/analytics/lineup.test.ts` (the cases and an evaluated-XOR-warned property); `tests/mcp/lineup-compare.test.ts` (new, tool level) |
| R5-m2 | `initialize` and `server/discover` advertise `listChanged: false` for tools, resources and prompts: the sets are fixed at process start (plan 01 §3.1, plan 02 §3.2, plan 03 §1.1 step 6, plan 07 §5.4) | `src/mcp/server.ts` (`SERVER_CAPABILITIES`, declared at construction — the SDK otherwise sets the bit to `true` on the first registration, which both eras advertised until now); `tests/mcp/capabilities.test.ts` (new: both eras, both toolsets) |
| R5-m3 | A CPU-deadline switch usable only by tests, and plan 10 A8a's injection-invariance test run with the deadline disabled | `src/mcp/services.ts` (`McpServerOptions.cpuDeadlineMs`, additive: omitted = `ANALYTICS_CPU_DEADLINE_MS`, null = off); `src/mcp/tools/analytics.ts` (E1 and the seeding simulator receive `deadline_ms` from it); `src/services/index.ts` (the composition root sets null only under `EFF_TEST_STUBS=1` in fixture mode — both test-scope keys — and logs `services.cpu_deadline_off`); `tests/e2e/injection.test.ts` (every server's log must show the switch before answers are compared); `tests/mcp/cpu-deadline.test.ts` (new: 0 ms → `partial: true` after one sample; off and 8 s give identical answers; only stubs + fixture mode set it); `docs/evals/1a-analytics.md` (the sampler section) |

Implementer's notes on R5: the switch adds no configuration key — a new test-scope key would change plan 03 §3, plan 05 §3.1's "three test-scope keys", the README Testing table and the schema test — so it rides `EFF_TEST_STUBS`, which already exists only for tests and, with fixture mode, already makes every network call or keychain access exit; every stubbed fixture-mode run (the e2e and smoke suites) therefore runs without the deadline, which changes no answer there (the worst `fx-10h` call is far below 8 s; `tests/mcp/cpu-deadline.test.ts` shows off and on agree) and removes a flake source. The README Testing row for `EFF_TEST_STUBS` does not yet mention this side effect (a docs follow-up). The A9a tool-level test runs in process (the real composition root in fixture mode on `fx-10h`, under coverage on every push); the stdio leg of the same assertion stays in `tests/e2e/acceptance.test.ts`.

| R5-3 (B2) | The ≥ 95 % usage-coverage bar counts the rostered players D1 models (QB/RB/WR/TE); D/ST and K have no snap or target usage. Measured independently over stdio on fx-10h: 131/134 = 97.8 % (met); 131/145 = 90.3 % if D/ST and K were counted | plan 10 B2 annotation; no code change |
| R5-4 (B7) | The replacement-level regression is checked on research 05 §4.1's computation basis, where all 36 VOR cells reproduce within 0.3 ppg and the flex splits are exact; under the shipped league scoring 35/36 match and the 2024 TE rank-3 cell (3.593 vs 3.2) differs only by scoring basis, shown cell for cell | plan 10 B7 annotation; `tests/backtest/replacement.test.ts` (already present) |
| R5-5 (B11 Lane 2, B15) | Every Lane 2 and plugin-eval grader — free or llm — grades a real `claude plugin eval` agent run, which plan 10 D7 makes a manual, pre-release lane; they run in Stage C (QA, owner's Ultracode session), not in the B2a gate. Lane 1 (all 13 Skills) stays hard and is green | plan 10 B11, B15, Phase 2 exit gate |

**Stage B2a outcome (2026-10-07):** after these rulings the B2a gate's round-4 run found no code defect; every command and checks (1)–(8) passed at `b72a917`; CI green. The integration agent was killed by the Mac sleeping, after committing its last fixes (`7b4786b`, `9375366`); the gate's three fix rounds carried the integration work to completion.

## B2 — measurements and records written back during the build (2026-10-06)

Not adversarial rulings: the numbers the plan said Phase 2 would write back, and the integration's
build-time choices where the plan was silent (each also in `docs/HANDOFF.md` → "Build facts (Stage B2)").

- **B12 sizes** · plan 07 §5.1 (a second "Measured" table, Phase 2) · `tools/list` under `full` 32 999 chars ≈ 8 250 tokens (ceiling 35 000); the ADV OBJ-24 short-form fallback would be 36 705 under `full` (over — it would need C10's `outputSchema` lever); the Skills listing over all 13 Skills 4 178 chars (ceiling 4 600); `compact`/`full` ≈ 0.98 on the three-week excerpt; D3 re-decided: `core` stays the default.
- **History files** · plan 10 §3.2 "two prior nflverse seasons" · the seven `<source>_history` files are registered dataset sources (licence, attribution, freshness and job of their current source) and refresh with their current job, gated on the CURRENT season being in progress (B1: outside the season every job exits 0 with no request); `--seasons` runs them regardless.
- **Release politeness** · plan 01 §6 · the 15-minute GitHub limit is the `timestamp.txt` poll's; a run's asset downloads are spaced 1 s apart (before, every request of a run waited 15 minutes for the previous one).
- **E1 `player_sim`** · plan 10 §3.2 · registered under `EFF_TOOLSET=full` only (an RB/WR/TE week with ≥ 3 trailing games; the same ESPN mean), so the P0 `core` projections are unchanged; E2's reporting stays sign-and-band because K and D/ST never take the basis.
- **Main-loop stall** · plan 10 A16a, ADV OBJ-07 · the bound holds for the P1 tools too (worst measured 37 ms): the provider's freshness context is reused for 1 s, a large fresh body yields between its phases, and the heavier P1 tools yield between their synchronous steps.

## B3 — measurements and records written back during the build (2026-10-10)

Not adversarial rulings: the numbers Phase 3 writes back and the integration's build-time choices where
the plan was silent (each also in `docs/HANDOFF.md` → "Build facts (Stage B2b)"; item by item in
`docs/evals/phase3-summary.md`). Rulings the stage requests are listed last, for R6.

- **C1 → E1** · plan 07 E1, plan 10 §3.3 · under `EFF_TOOLSET=full` E1 answers `model_version:
  "v2-opportunity"`: the first target week of every QB/RB/WR/TE with a game history is v2's
  `player_sim` distribution around ESPN's mean; K, D/ST, byes and players without history keep v1
  (said per player); `core` is unchanged. `weight_espn` ships 1.0 (B14's rule: no mixture beat ESPN
  alone beyond Monte-Carlo noise on the held-out seasons); a human-applied tuned weight is read at
  start. The bulk callers use v2's smallest sample count (200).
- **Store migration 002** · plan 01 §9.2, plan 06 §1.3, plan 08 §9 · `parameter_proposal` (C9),
  `waiver_run` (C5), `scored_claim` (C8), all never pruned; `projection` gains `p_active`,
  `reported_mean`, `trace_json`. Every E1 call stores each projected player's first-week projection
  (v2 with its trace, else v1's trailing expectation), so E13 attributes every call E1 backs.
- **E5 `league_fitted`** · plan 07 E5, plan 10 C5 · E5 logs each priority run it prices (the newest
  call before the run wins); Π is re-solved from the league's own feed at 13 logged runs (one regular
  season), the cold-start table below that with the reason said.
- **E10 calibration** · plan 07 E10, plan 10 C8 · E10 reads the calibration table (the official
  practice report's 2023–2025 history plus the league's scored claims), logs each scorable news claim
  value-free, and E13 scores the logged claims once final; the posterior shows at 200 scored news
  claims.
- **E2 `auto`** · plan 07 E2, plan 10 C2 · follows the committed switch record: `insufficient` →
  `mean`. (Fix round 1: the record is re-derived from the replay of what `full` serves —
  v2-opportunity — 8 differing team-weeks; still `insufficient`.)
- **Plan 06 §1.5** · two rows: the pre-season negatives re-check (C10, a recurring job) and `eff tune`
  (owner only, never launchd).
- **The C8 budget** · plan 07 C8 · analytics `data.inputs[]` lists identical rows once (v2's re-reads
  had pushed E2's answer to 10 793 chars; 9 810 now).
- **Main-loop stall** · plan 10 A16a · v2's scoring scores one sample set per cooperative step; worst
  measured over stdio 29.3 ms under `full`.
- **Research 04 §G item 1** · ESPN's stored weekly projections on finished seasons are game-day values
  (0 exactly for inactives); C1's ESPN clause is evaluated at game time.

**B2b gate, fix round 1 (2026-10-10)** — records, each with tests:

- **C2's `full` basis is the shipped model** · plan 10 C2 · the held-out start/sit replay's `full`
  basis overlays v2-opportunity's served first-week Dist for every QB/RB/WR/TE it models (the merge
  `analytics.ts` performs), its request assembled from the committed C1 excerpt the way the store
  assembles it, availability at game time (ESPN's game-day projections); 4,044 v2 player-weeks over
  2024–2025, 484 of them QBs. On v2, as on core, every served mean is ESPN's, so E2's lineup equals
  "start by ESPN's projection" in all 308 team-weeks (asserted as the reason).
- **The seeding simulator's posterior mean draw** · plan 07 E3 Method (silent on it), research 05
  §2.4, §8.4 #5 · every cold-start team's weekly mean is drawn once per path from its posterior,
  sd σ/√(n + 4) — the normal–normal model the shipped n/(n + 4) shrinkage implies (no new
  parameter); an E1-fitted team carries the same sd (`SeasonTeam.weekly.mean_sd`); a plain E1 weekly
  model keeps a known mean. P(playoffs) Brier on the nine recorded league-seasons 0.214 / 0.159 /
  0.094 → 0.209 / 0.155 / 0.094 at weeks 4 / 8 / 12.
- **C5's replay forecast** · plan 10 C5, research 05 §8.4 #4 · the rule's `s` is v2-opportunity's
  week-ahead expected points over replacement (the trailing-4 forecast reported beside it): fitted
  rule vs trending +18.2 % / +66.7 % per successful claim.
- **The demand curve fit** · plan 10 C5 · `fitDemandCurve` (intercept and slope separately) beside
  `fitDemandScale`; held out on league-b's drops it is within ±2.4 points; reported, not applied to E5.
- **The fixture tooling's write host** · CLAUDE.md, plan 10 §3.W · `scripts/espn-fixture/http.ts`
  imports `ESPN_WRITE_HOST`; the Phase W test scans `scripts/` as well as `src/`.

**B2b gate, fix round 2 (2026-10-11)** — records, each with tests (`tests/mcp/serve.test.ts`):

- **A stdin line that is not JSON** · plan 01 §3.1 (silent on it), JSON-RPC 2.0 §5.1 ·
  `src/cli/serve.ts` answers it -32700 Parse error, one reply per line, with **no** `id` (its id
  cannot be read; MCP's error response makes `id` optional and its RequestId has no null — the SDK's
  own message schema rejects `id: null`); never an echo of the line. Until now it was logged only.
- **A tools/call argument key `__proto__`** · plan 02 §5 (`__proto__` keys are rejected by the
  schemas' `.strict()`), plan 01 §4 · the SDK re-parses `arguments` as a zod record, which drops a
  `__proto__` key, so the strict input schema never saw it and the call answered as if it were absent.
  The transport now carries that key under a stand-in no tool declares (held for all 34 tools), so it
  answers a coded VALIDATION `(root) (unknown key)` like any unknown key; nested keys were already
  rejected by the nested strict objects (now tested). No prototype is touched; the key is never echoed.

**B2b gate, fix round 3 (2026-10-11)** — no code defect; one evidence record, with tests
(`tests/domain/analytics/calibration/reliability.test.ts`):

- **The reliability term's calibrated floor** · plan 10 C2, sib research 05 §12.1 (the Brier
  decomposition) · `reliabilityByDecile` carries `reliability_if_calibrated` = (1/N) Σ_k (1/n_k)
  Σ_{i∈k} p_i(1 − p_i), the reliability term a perfectly calibrated forecaster issuing the same
  forecasts expects from sampling alone (additive field; no verdict reads it). On the held-out replay
  the as-played P(win) term is 0.0020 (`core`) / 0.0031 (`full`) against ≈ 0.0060 — below the floor;
  E2's counterfactual `p_win_after` 0.0114 / 0.0110 against ≈ 0.0059 (`docs/evals/phase3-startsit.md`,
  regenerated; ruling 2 in `docs/evals/phase3-summary.md` now cites it and lists two options). No
  criterion, threshold or verdict changed.

**Rulings requested (for R6)** — ruled 2026-10-11, see **R6** below (evidence in `docs/evals/phase3-summary.md` → "Rulings requested"):
C2's regret vs "start by ESPN's projection" — identical lineups on **both** toolsets as shipped at
`weight_espn` 1.0 (the A11a / R2 nit 2 structure; Phase 3 changes the distribution's shape, not its
mean); C2's ±5-per-decile criterion — unresolved on both bases (5.6 on n = 49 under `core`, 8.5 on
n = 47 under `full`; ≈ 355 per decile needed); research 05 §1.3's cold-start demand intercept
(league-b's real drops cleared 94–96 % against the curve's 63 %; the curve fitted on the other season
puts q0 at 0.004–0.007 per rival); research 05 §2.4's shrinkage constant k = 4 in the seeding
simulator (the recorded seasons imply k 2.5–58; one decile each at weeks 4 and 8 still inconsistent
after the posterior draw); C1's ESPN clause at game time (accepted by the gate).

## R6 — build-time rulings (2026-10-11)

**Trigger:** closing Stage B2b's gate (run of 2026-10-10/11, three fix rounds), the gate stayed red on C2 alone; its last two rounds found no code defect, every command and check (1)–(8) passed at `787c463`, CI green. The orchestrator ruled on the five requests in B3 (2026-10-11), after re-running `tests/backtest/lineup-history.test.ts`, `tests/backtest/winprob-history.test.ts`, `tests/domain/analytics/calibration/**` and `tests/domain/analytics/seeding-reproduce/**` independently (12 files, 102 tests, all pass). Build-time rulings, not an adversarial round; each supersedes the older text it names. Rulings that need code are assigned to Stage C's first remediation round, where QA re-verifies them.

| id | ruling | what changed (file §) |
|---|---|---|
| R6-1 (C2, ESPN clause) | R2 nit 2 applies to C2 exactly as it applies to A11a. At `weight_espn = 1.0` (ADV OBJ-02, kept by B14's rule on the held-out seasons) every served mean is ESPN's, so E2's `mean`/`auto` lineup **is** ESPN's: the "start by ESPN's projection" comparison is identically zero (308 of 308 team-weeks, both toolsets) and is reported **not informative in v1**. Hard: regret below "start by last week's points" (met, ≈ 13.4 points per team-week, both seasons, both bases) **and never above** ESPN's (held by `tests/backtest/lineup-history.test.ts`, `pooled.diff = 0`). The strict "below ESPN" clause re-arms the moment the served mean differs from ESPN's — a tuned `weight_espn` below 1.0 applied by `eff tune --apply`, or `auto` switching to `pwin` — and the retrospective then reports it as informative | plan 10 C2 annotation; no code change |
| R6-2 (C2, ±5 per decile) | Two ten-team seasons put 47–70 forecasts in each central decile; resolving ±5 at 95 % needs ≈ 355. Hard: every checked decile (n ≥ 30) family-wise (Bonferroni) consistent **and** the primary family's (P(win) of the lineups as played) reliability term at or below the calibrated-forecaster floor on the same forecasts (`reliability_if_calibrated`) — met on both bases (0.0020 / 0.0031 vs ≈ 0.0060). The literal ±5 stays the target, reported beside it: `unresolved` → **needs_time** until a central decile holds ≥ 355 forecasts (the in-season retrospective accrues them), then hard; `not_met` on any resolvable miss or inconsistent decile. **Named for Stage C (not waived):** E2's own `p_win_after` — the number the tool shows — sits about twice its floor (0.0114 / 0.0110 vs ≈ 0.0059) and its sparse tails run the wrong way (0.2–0.3 forecast 0.27, won 0.58, n = 12; mirrored at 0.7–0.8); the report attributes it to the optimiser's selection bias on both best-by-mean lineups. Stage C investigates it as a finding and fixes it at the root if it reproduces, without refitting on the held-out seasons | plan 10 C2 annotation; Stage C backlog (`docs/HANDOFF.md` ▶ NEXT STEP) |
| R6-3 (C5, cold-start demand) | Research 05 §1.3's cold-start intercept stays the **fallback**: the only contrary evidence is one public league's drops, dominated by low-value players, and the curve fitted on them has no value slope — adopting it would call a starter-calibre drop near-certain to clear, the one case the tool must get right. Whenever E5 serves the cold start it says so and states the measured miss. **Stage C, first remediation round:** a league's previous-season transactions count as "the league's own feed" (plan 07 E5) — fit the demand curve from the owner's league's prior seasons where ESPN serves them, so `league_fitted` applies from the first call instead of after 13 logged runs; the cold start remains only where no history exists. Verified live in Stage C | plan 10 C5 annotation; Stage C backlog |
| R6-4 (C3, seeding `k`) | Keep research 05 §2.4's shrinkage constant `k = 4`. The recorded seasons imply `k` from 2.5 to 58 (one season shows no persistence) — nine league-seasons cannot estimate it, and the one-off empirical-Bayes `k` did not clear week 4. The inconsistent decile at each of weeks 4 and 8 is reported soft; no new bound is added. Revisit on the owner's league history | plan 10 C3 annotation; no code change |
| R6-5 (C1, ESPN clause) | ESPN's stored weekly projections on finished seasons are game-day values (0 exactly for inactives; resolves research 04 §G item 1). C1's ESPN clause is evaluated at game time, and C2's replay reads the same game-day availability on every side — the reading the B2b gate accepted | plan 10 C1 annotation; no code change |

**Stage B2b outcome (2026-10-11):** after these rulings, C1–C4, C6, C7 and C9 are met (C2 under R6-1/R6-2; C3 needs_time with the code path proven — finished seasons carry no pre-week `winProbability` or `playoffPct`); C5 and C8 soft, reported with numbers; B14 needs_time (`weight_espn` stays 1.0). As at B2a, no re-gate: the rulings change no code, the last gate round verified `787c463` with every check passing, and Stage C's independent QA re-verifies the whole product.

## R7 — Stage C rulings (2026-10-13/14)

**Trigger:** Stage C's round-1 remediation (QA + penetration testing; `docs/evals/stage-c-live.md`, `docs/evals/stage-c-plugin-eval.md`). Build-time rulings; each supersedes the older text it names.

| id | ruling | what changed (file §) |
|---|---|---|
| R7-1 (lineup no-move) | Plan 09 guardrail 9 governs what the user is told and what is logged: a swap inside the coin-flip band is `no_move: true` and is logged as a no-move, which the retrospective scores as "keep". E2's mean-optimal assignment (the `lineup` field) is unchanged, so C2's replay of E2's assignment and R6-1's identity with ESPN's lineup still hold; the regret of the "keep unless outside the band" policy is reported beside it (soft) | plan 09 guardrail 9 and plan 10 C2 read together; E2 and the reclog (Stage C remediation) |
| R7-2 (B11 Lane 2, B15) | `claude plugin eval` refuses to start on this account ("currently in early access"), so no Lane 2 case or B15 grader can run here; the gate is not worked around. Lane 1 (all 13 Skills, offline) stays hard and green; the static findings the lane produced (H1–M5, L1–L4) are fixed as ordinary Stage C findings. If the owner's own `claude update` + `claude plugin eval` shows the feature enabled, the suite runs before release; otherwise B11 Lane 2 and B15 are recorded as not runnable (tooling gated), not as met | plan 10 B11, B15 (status at Stage D); `docs/evals/stage-c-plugin-eval.md` |
| R7-3 (setup prompt echo) | After three attempts each closing one paste pattern, the approach changes: echo is off at the terminal for the whole of `eff setup`, visible answers are echoed by our own code, pending input is discarded before the `espn_s2` question, and a hidden answer with a line break or sharing a chunk with another answer is refused and re-asked; a property test over random chunkings holds that no `espn_s2` byte is ever written | `src/cli/prompt.ts`, `src/cli/setup.ts` (Stage C) |
| R7-4 (news attribution) | Fail safe instead of smarter parsing: a status claim in a multi-player item that cannot be tied to the subject with certainty is labelled `ambiguous_multi_player`, shown wrapped, and never logged, scored or used as the subject's claim | E10 (Stage C) |
| R7-5 (ROS window) | The root fix is accepted; the remaining work is wiring tests for the six untested call sites | tests (Stage C) |
| R7-6 (ON-1 graders) | Moved to the backlog: Skill-scoring cannot run on this account (R7-2) | backlog |

## B4 — records written back during Stage C (2026-10-17)

These are not rulings. They record what Stage C built where the plan names an artefact that did not exist.

- **A10b's question set** · plan 05 §6, plan 10 A10b, README Testing · The set is `tests/evals/read-only.xml`: ten `qa_pair`s in mcp-builder's `evaluation.md` format, over `fx-10h` at N = 4 under the default toolset, built from the tools in fixture mode.
  - Plan 05 §6's drafts 3, 4, 5 and 9 are unchanged.
  - Drafts 1 and 10 are reworded so that each has one reading.
  - Drafts 2, 6, 7 and 8 are adapted under that section's own rule ("read-only, independent, stable, single-answer"). As drafted, 6 has three correct answers; 7 comes to 0, which an empty search also gives; and 8 asks for a season-to-date split that no tool serves on the fixture.
  - The reasons, question by question, are in `docs/evals/model-driven-evals.md`.
  - On every push, `tests/e2e/model-evals.test.ts` re-derives every answer from the built server under both toolsets, started as the documented run starts it, and refuses an answer that is not unique. `tests/evals/read-only.test.ts` holds the file's format.
  - The run (≥ 8/10) has not happened: it is manual, comes before a release and spends model tokens.
  - Three things are open for the owner before the runner can be trusted, in `docs/evals/model-driven-evals.md` → *Running it*: it needs an Anthropic API key, and CLAUDE.md allows free services only; it needs a current model id; and read statically, it has a defect in how it encodes tool results.
- **Lane 2's suite and its runner** · plan 04 §1, plan 05 §1, plan 09 §4, §5.1 items 6 and 9, §5.2, plan 10 B15 · The plan put the suite in a committed `evals/` directory at the root, answered by mocks, and ran it with `claude plugin eval .` and a `--trust-plugin` option. No such directory, mock or option exists (Stage C finding docs-trust-plugin-flag-rejected).
  - The suite is a build output and is never committed. `npm run build:plugin-evals` (`scripts/skills/build-plugin-evals.mjs`, built in B2a) writes it to `dist/plugin-evals/` from every Skill's `evals/`.
  - The harness of Claude Code 2.1.238 has no MCP mock layer. So the "mocks" are eval plugins: each has one server, the built binary in fixture mode on the case's `fx-10h` variant, with no network and no cookie.
  - The runner is the command the suite's generated `README.md` gives. Its target is that directory, and it adds `--allow-tools` for the plugin's tools and `--no-publish`. The CLI answers `--trust-plugin` with "unknown option" and exit 1.
  - `tests/lint/plugin-eval-docs.test.ts` already held the README to the build and to the pinned CLI's options. It now holds the plan's runner, its layout trees and its Lane 2 statements in the same way.
- **The release tarball and its install** · plan 04 §2 (`files`), §4.4, R8; plan 03 §4.1, §4.3; plan 02 §7.1 ("Lockfile": the integrity hashes are the provenance) · Stage C finding ci-release-workflow-missing.
  - `release.yml` copies the committed `package-lock.json` to `npm-shrinkwrap.json` before packing, and `package.json` `files` names that file. With a `files` allow-list npm 11 ships `npm-shrinkwrap.json` only when `files` names it, and it never ships `package-lock.json`. Without that entry, the tarball carried no lockfile.
  - `scan-tarball.mjs --release` refuses a tarball whose packed `npm-shrinkwrap.json` is missing, differs from the committed lockfile by a byte, or names another version.
  - Plan 03 §4.3's global install from the release tarball is built as an unpack, then `npm ci --omit=dev --ignore-scripts` in the unpacked folder, then `npm link --ignore-scripts`. npm never reads the `npm-shrinkwrap.json` of a `.tgz` it installs by path. `npm install -g <tarball>` resolves the dependencies from the registry; a tampered integrity hash in the tarball's shrinkwrap installs without complaint (npm 11.19.0, checked offline). `npm ci` installs exactly the shrinkwrap's tree and refuses that hash. `npm link` installs nothing.
  - `scripts/ci/check-release-install.mjs` runs that install, offline, on the tarball `release.yml` publishes. It requires the lockfile's runtime tree (path, version, resolved URL and integrity; no dev dependency; the runtime allow-list), a link that installs nothing, and a linked `eff` that reports the version. `ci.yml`'s pack job rehearses the same steps on every push.
  - The README's "Install from a release" documents these commands, and `tests/lint/release-install-docs.test.ts` holds them to the check. `eff print-config`, `eff install-launchd` and `eff doctor` name this install where they used to say `npm install -g`.

## B5 — what rulings R7-3, R7-4 and R7-5 built (Stage C round 2, 2026-10-25)

These are not rulings: they record how the three rulings at the attempt cap were carried out, each with tests that fail on the code before it.

- **R7-3 (setup prompt echo)** · plan 03 §2.1 step 3, plan 02 §2.3, README "Safe credential setup" · `src/cli/prompt.ts` was rewritten. On a terminal there is no `node:readline` (no redraw, undo, kill ring or history): the prompt reads the bytes in raw mode, taken when `eff setup` starts and given back when it ends, and still read and dropped after Ctrl-C until then, so nothing typed is left for the shell. Only a visible question draws, character by character; the SWID question draws only while the line can still be a SWID (`src/auth/format.ts` `swidEchoShape`: the cookie alphabet has no brace, so an `espn_s2` pasted there is not drawn either). Every question is asked on a quiet input: what arrived before it is dropped unshown and said, and so is anything that arrives until the input has been quiet for 250 ms (Node has no `tcflush`; this drains the terminal's buffer). A hidden answer that is empty, or holds more than blanks after its line break in the same read or within 250 ms, is refused and asked again. Consequences: a SWID and `espn_s2` pasted together need `espn_s2` pasted again at its own question (setup says so), and a terminal question no longer takes typed-ahead answers (a piped stdin still queues lines). Residual, unchanged: keys typed before the process exists are echoed by the terminal driver; setup says so (`TYPED_AHEAD_NOTE`). Tests: `tests/cli/setup-parts.test.ts` (the prompt), `tests/cli/setup-echo.test.ts` (every scenario of the earlier verifications' pty driver replayed through `runSetup` on fake time, and a fast-check property over random reads and pauses of a SWID and `espn_s2` pasted together: no run of `espn_s2` and no `%` ever reaches the screen), `tests/cli/setup.test.ts` (the CLI end to end); `tests/process/cli.test.ts` under a real pty. Against the old prompt, 28 of the 72 setup-echo tests fail, the property among them. The last verification's own pty driver, replayed on the built CLI: 56 of its 57 scenarios put no fragment of `espn_s2` on the terminal, all 17 that leaked at `66d6d9e` among them; the 57th types before the process exists (the residual above).
- **R7-4 (news attribution)** · plan 07 E10 (output `ambiguous_multi_player[]` added), plan 10 C8 · `src/domain/evidence/attribution.ts`: in a text that names more than one player, a claim is the subject's only when its clause names no other player, opens with his name and states the claim of him directly (an injury in parentheses, a colon and auxiliary verbs may stand between). Every other claim is listed under `ambiguous_multi_player`, wrapped, and is never an evidence item, never logged (so never scored) and never weighed in the flag, the disagreement or the posterior. The phrase split, the joiner list and the pronoun check are gone. The players around the subject also come from nflverse's weekly roster of his team and his opponent (every position). Tests: `tests/domain/evidence/attribution.test.ts` (every wording of the three verification rounds, the controls, and the property: a claim whose clause names another player is never tied to the subject), `tests/domain/analytics/evidence.test.ts`, `tests/mcp/evidence-scope.test.ts`. Against the old logic, 8 of 9 round-3 wordings and the property fail.
- **R7-5 (ROS window)** · tests only · `tests/mcp/ros-window-wiring.test.ts` reaches E6's free-agent wire (the offer and the partner search), E7's claim verdicts and E9's handcuff values on `fx-10h` and asserts first that each sub-path ran. Each of the seven call sites the last verification found untested, the verification's other 26 wiring mutations and the four inner helper sites fail the file when reverted.

## B6 — what the final gate's fix round 1 built (Stage C, 2026-10-28)

These are not rulings. They record what the fixes to the independent final gate's problems added,
each with tests that fail on the code before (commits `e40fd88` … `7f39044`). What no agent change
closes is in `docs/evals/stage-c-backlog.md`.

- **G1's ages** · plan 07 G1 · A dataset source's and a freshness class's `age_s` are `ageSeconds`
  (an integer up to the first second of 2100), never `count` (≤ 1 000 000). Past 11.6 days of
  dataset age the output schema refused the whole answer as INTERNAL; that was live on the owner's
  install. Test: `tests/mcp/status-age.test.ts`.
- **In-process holds after a backward clock step** · plan 01 §6 (a rate, never a blackout), plan 07
  G2 · The ESPN breaker's open window, ESPN's Retry-After hold (in process, and the copy other
  processes read, which is written back) and `espn_check_auth`'s once-a-minute gap are re-stamped
  as set just now when they were set under a clock since set back (`config/freshness.ts`
  `heldWindow`). They last their own length at the most, never the skew. The store's rows already
  followed the rule (`src/store/repos/skew.ts`). Tests: `tests/mcp/clock-step-back.test.ts` and the
  unit files.
- **E6's ΔU horizon** · plan 07 E6, research 05 §2.4 · The season simulator reports
  `marginal_weeks`: the scoring periods of my undecided regular-season matchups, the week in progress
  among them. ΔU divides the trade's regular-season points by it, not by the value weeks.
- **D6's id selection** · plan 07 D6 · Every asked ESPN id is matched by itself, whether or not the
  pool read returned the player. An asked gsis id is matched as given. An id nobody knows is counted
  "not found", as in every selector tool.
- **The news matcher's evidence** · plan 07 D6, plan 02 §6.4 · A cue word between two teams names a
  game the subject plays in (`TeamMention.pair`). A roster move ties its team to the name
  (`movedTeams`). A team attached to the name blocks holders on other teams. Evidence contradicting
  every holder gives no ref. The choices are listed for a ruling in the backlog.
- **`eff refresh espn:drift`** · plan 01 §7, plan 06 §1.2 · It re-reads, once each, every view the
  stored drift row marks red, through the jobs' provider and limiter (read host; the stored
  credential when the league needs it). It clears what ESPN serves again and exits 4 while a view
  stays red; a read that failed, or that the cache served because ESPN failed, is named not re-read
  for every view it serves. `eff probe` prints the stored red diff (`--json`: `stored_red`, `recheck`). Doctor #9
  names the command for a red view the probe never reads. README CLI table, `eff help`.
- **Doctor #14** · plan 03 §5 #14 · The server time adds the `Age` a cache in front of ESPN reports
  (RFC 9111 §5.1). A CDN copy's minutes-old Date read as clock skew on a correct clock.
- **STALE_ONLY's hint** · plan 01 §4.3 · There is one fixed hint per dataset source
  (`STALE_ONLY_SOURCE_HINTS`): "Retry with allow_stale: true, or run eff refresh `<id>` in a
  terminal."
- **Timing tests on a loaded host** · plan 10 A16a, plan 05 §4.2 · The bounds are unchanged. The
  heartbeat also reports its longest timer gap's own CPU time and involuntary context switches. A
  window over the bound is repeated only on evidence that the host set it (`tests/e2e/helpers.ts`
  `measureStall`, `hostSetStall`, `StallControl`). The trade-block invariance compares complete runs
  (the CPU deadline off, as in R5-m3).

## B7 — what the final gate's fix round 2 built (Stage C, 2026-10-28)

These are not rulings. They record what fix round 2 added for the problems of the final gate's
second run, each with tests that fail on the code before (commits `01cb8e5` and `2396b07`). That run
found no defect in the gate's commands or product checks. It was red on what
`docs/evals/stage-c-backlog.md` records (the owner, the Stage D merge, rulings), and on three low items.

- **The plugin's own `.mcp.json` in a clone** · plan 03 §5 #2, §8 step 5; plan 09 §4 · A Claude
  Code session opened in the clone reads that file as a project server, and it cannot start there:
  `${CLAUDE_PLUGIN_ROOT}` and `${user_config.*}` expand only in a plugin install.
  - `src/cli/client-config.ts` marks a project-scope entry that uses `${CLAUDE_PLUGIN_ROOT}` in a
    copy of this plugin (`.claude-plugin/plugin.json` names it) as the plugin's own
    (`pluginSource`). Row 3 still scans its env.
  - Doctor row 2 lists it and counts it as no registration. Before, alone it read "1 client
    registration with absolute, existing paths", and beside the enabled plugin it was a second
    registration.
  - `eff uninstall` leaves it. Before, it printed a `claude mcp remove --scope project` that deletes
    the plugin's server from the clone.
  - Any client entry that uses a plugin variable is a hard row-2 problem. A `/bin/sh` entry needs
    the absolute path of an existing `scripts/eff-launch.sh`, as row 2 asks of every registration's
    `args[0]`.
  - README "What to get right". Tests: `tests/cli/client-registrations.test.ts`,
    `tests/cli/doctor.test.ts`.
- **A1's keepers** · plan 07 A1 (`league.keepers` added; a keeper league said in `warnings[]`);
  research 03 §B.1; research 05 §5 · Stage C live finding F6: every item of the owner's format but
  keepers was restated, so a keeper league went unnoticed. Two of the three recorded public leagues
  keep players.
  - `normalizeKeepers` reads `draftSettings` from the passthrough settings. A field of another
    shape is null, never a failed settings read.
  - The field is on `League`, not `LeagueRules`. The store compares stored rules across snapshots,
    so a field new to this build would have read as the commissioner's edit after the upgrade.
  - The onboard Skill restates it. Tests: `tests/providers/espn/normalize.test.ts`,
    `tests/mcp/league-keepers.test.ts`.
- **The news matcher's ruling list** · `docs/evals/stage-c-backlog.md` · No rule changed. Two
  choices were missing from the list: 5 (a namesake's team named loosely blocks the prominent
  holder) and 6 (an attached namesake's team never gives the namesake the name past him). They are
  added with the gate's titles, the counter-examples, the bare-surname inconsistency, the options and
  the measured scope (16 shared full names; Justin Jefferson, Byron Young and Marcus Harris).
  `tests/sources/news/match-universe.test.ts` holds both as built.

## B8 — what the final gate's fix round 3 built (Stage C, 2026-10-28)

These are not rulings. They record what fix round 3 added for the problems of the final gate's third
run, each with tests that fail on the code before (commits `42de906` and `ebc9187`). That run found no defect in its commands or
product checks; it was red on the owner's stale datasets (doctor #10, by design until
`eff refresh all`) and listed low items. What stays open is in `docs/evals/stage-c-backlog.md`.

- **A prompt's undeclared argument key** · plan 07 §4.2 (a sentence added), plan 02 §5 · A
  prompts/get argument key the prompt does not take was stripped by its non-strict object and the
  prompt rendered. A `__proto__` key never reached it at all: the SDK's `arguments` record drops it,
  as on tools/call before changelog §B3's fix round 2. tools/call answers VALIDATION for the same key.
  - Every prompt's argument object is strict (`src/mcp/prompts/index.ts`), and every prompt registers
    its schema, the argument-less five too: without one the SDK never shows the handler the
    arguments. prompts/list now lists their `arguments` as `[]`.
  - An undeclared key is refused -32602 "unknown argument key (this prompt takes: …)". The message
    names the keys the prompt takes and never quotes the caller's key; zod's own message quotes it
    (`unknownArgumentMessage`).
  - `src/cli/serve.ts` `withProtoKeyCarried` carries a prompts/get `__proto__` key past the SDK's
    re-parse, as it does for tools/call, and logs the method. A value that is not a string fails the
    SDK's own record first: -32602 "Invalid params". No prototype is touched.
  - Tests: `tests/mcp/prompt-args.test.ts` (all 13 prompts, both eras, the schema's coded issue, an
    asynchronous schema), `tests/mcp/serve.test.ts` (over stdio: string and object values, beside a
    valid argument, an argument-less prompt, no echo, the log line; the carry's unit cases and
    property; no prompt declares the stand-in). Against the code before, 35 of them fail.
- **E3's division-winners-first step, stated and priced** · plan 07 E3 (`division_rule` added; the
  Method sentence); research 05 §2.1; Stage C live finding F8 · Under the ESPN rule reading the
  simulator seeds division winners first in a league with more than one division. That is ESPN's
  documented rule, but no league field is known to confirm a league applies it (`playoffSeedingRuleBy`
  is [U]), and the owner's two-division league states "record first, then Total Points For".
  - `simulateSeason` also ranks every path by record alone, with the same chain without that step:
    one more ranking on the base variant's paths, no extra draw, so every reading is unchanged.
    E3 `season` returns `division_rule` (`divisions`, `p_playoffs_record_only`, `p_bye_record_only`;
    null with one division or without an ESPN rule reading), and `rec.assumptions[]` states both
    answers to three decimals with the revisit trigger. The cheat-sheet's E3 row names the field.
  - Which chain the owner's league uses stays open (backlog: F8 — the owner's one answer, or a
    ruling).
  - Tests: `tests/domain/analytics/seeding.test.ts` (the five-team league where a 1-3 division
    winner takes a seed record order denies him; one division and points-only alone are null; a
    property: record alone equals the same league's plain chain on the same paths),
    `tests/mcp/season-division-rule.test.ts` (the four-division `league-c` and the one-division
    `league-a` through the composition root). Against the code before, all 6 fail.
- **The backlog** · `docs/evals/stage-c-backlog.md` · the ledger's three closable findings re-verified
  at the third run; the news matcher's scope measured on its own universe (2 574 persons, 16 shared
  keys, 11 of them the identical full name); F8's evidence and options; the dev-only `vite`
  advisories (unreachable: no listener; Dependabot after the Stage D merge); the two tight margins and
  fixture mode's INTERNAL for an unrecorded period, recorded with the reasons they stay.

## R8 — Stage C final-gate rulings (2026-10-28)

**Trigger:** the final gate stayed red after its three fix rounds (its fourth run, at `f41e810`). R8-6 was added after R8-3's own three fix rounds did not converge. R8-7 (2026-10-29) bounds R8-6 after its second build. R8-8 (2026-10-29, the owner's choice) sets one targeted round, then a freeze.
Every gate command, product check and CI job passed. It was red on the owner's stale datasets, on
the news matcher's shared names, on two items only the Stage D merge or the owner can close, and on
the ruling requests in `docs/evals/stage-c-backlog.md`. The owner answered F8 on 2026-10-28. These
rulings supersede the older text they name.

| id | ruling | what changed (file §) |
|---|---|---|
| R8-1 (doctor exit, stale datasets) | `eff doctor --online` exiting 1 because #10 fails (every dataset source expired) and #11 warns (no launchd jobs) is the product reporting the install truthfully (plan 03 §5: the exit is the worst row's). It is not a defect. At the Stage C gate the live doctor check is met when doctor completes and prints every row, every ESPN and credential row is ok, and #10 and #11 are the only rows that are not ok, for those reasons. Stage D's install closes it: the owner runs `eff refresh all` and `eff install-launchd`, and then `eff doctor --online` must exit 0 | plan 10 live smoke at the Stage C gate; Stage D's install acceptance |
| R8-2 (A16a stall measurement) | The host-evidence repeat is accepted as built. The 50 ms bound and the heartbeat measurement are unchanged. A window over the bound is repeated (at most three windows) only with evidence that the host set it. A JavaScript block over the bound is never excused, and a host that sets every window fails as "cannot be measured", never as a pass | plan 10 A16a; `tests/e2e/helpers.ts` `measureStall` (as built) |
| R8-3 (news matcher, shared names) | When a name has more than one holder, precision comes before recall. A namesake's item put on a star gives E10 a false injury or transaction claim; a star's lost item still has ESPN's own status behind it. (1) Backlog choices 1–5 stand as built. (2) For a shared name, a team named loosely (not attached to the name, not tied to it by a roster move) is never evidence FOR a holder. It can only rule a holder out, and `full_name_team` (0.95) on a shared name needs an attached team or a roster-move tie. (3) A team named as the other side of a game or a play is the opponent. The cue vocabulary covers result and play wording ("win over", "loss to", "lost to", "beat", "fell to", "against", "past", "sacks the `<team>` QB", "picks off a `<team>` pass" and the like) as a closed, tested list. (4) Choice 6(c): a position word or abbreviation written next to the name, or describing the subject, is evidence like an attached team. It comes from ESPN's `position_id` joined into the matcher's universe and rules out every holder of another position. The full-name and bare-surname paths follow the same rule. (5) When the evidence leaves no single holder, no one takes the name, and the item is counted where unmatched items are counted (plan 07 D6), never dropped in silence. (6) Accepted residual: an item that names no team, no position and no cue goes to the prominent holder at `full_name` (0.80), as built. No verb parsing beyond the cue list (R7-4's precedent) | `src/sources/news/match.ts`, `teams.ts`, `UNIVERSE_SQL`; plan 07 D6 (Stage C) |
| R8-4 (F8, division winners first) | The owner confirmed that the league's division winners take the top seeds. The shipped chain, division winners first whenever a league has more than one division under ESPN's rule reading, is right for every observed league. The owner's league (`playoffSeedingRuleBy` 0, two divisions, division winners first) refutes the hypothesis that 0 means "by record". E3's `division_rule` stays as built: the record-only answer is shown as the stated alternative | none (§B8 stands) |
| R8-5 (ledger) | `trade-locked-week-counted`, `store-future-stamped-rows-block` and `crosswalk-unpaired-joins-silent` are closed as fixed, verified at the gate's third and fourth runs. `ci-default-branch-controls-inert` is closed by the Stage D merge of `build/phase-1` into `main` and does not block the gate before it. R7-2 and R7-6 stand | the orchestrator's ledger |
| R8-6 (news matcher, shared names: fail closed) | Supersedes R8-3 clause 3, clause 4's "describing the subject" reading, and choice 3 (a roster move ties its team) for a name more than one universe player holds. Three fix rounds that grew the cue and description wording did not converge (15, 16 and 16 violations against `52796bf`, `7b9572c` and `dbe9686`), several cases regressed against `f41e810`, and a crafted item slowed the news build past its budget. The matcher now fails closed for a shared name. (a) Only a label written next to the name picks a holder: a team or a position directly before it ("Browns LB Justin Jefferson", "Browns' Justin Jefferson", "LB Justin Jefferson"), in parentheses directly after it ("(CLE)", "(CLE - LB)", "(LB, Browns)"), or in the headline's name tag before the colon ("Justin Jefferson, CLE:", "Justin Jefferson LB:"). The label forms, the team forms (nickname, city, abbreviation, common short name, any case) and the position forms are closed lists, and every entry is held by a test. A label must fit exactly one holder; labels for one name that fit different holders pick none. (b) The prominent holder takes the item at `full_name` (0.80) only when a broad scan finds no team and no position anywhere in the title or blurb. The scan finds a team in every form and any case, handles and whole-word abbreviations included, and a position in every written form, hyphenated and abbreviated ones included. An ambiguous token ("OT", "corner") counts as found: the scan only ever takes the residual away. (c) Nothing else picks or raises a holder for a shared name: not cue wording, games, describing sentences, topic clauses or roster moves. The cue reading added for shared names after `f41e810` is removed. A roster move on a shared name with no label next to it gets no ref ("Ravens sign Lamar Jackson to practice squad"). (d) Otherwise no one takes the name, and the item is counted as unresolved (R8-3 clause 5). The bare surname follows (a) and (d) and never takes the residual. Names one universe player holds match exactly as at `f41e810`. Matching time is linear in the item's length. Accepted residual (R8-3 clause 6): a namesake's item that names no team and no position goes to the prominent holder. Accepted recall loss: a shared name's item that names a team but carries no label goes unlinked, with ESPN's own player status still behind the star. Matching an item's opponent against that week's schedule would recover much of that loss; it is a later improvement and is not built | `src/sources/news/match.ts`, `positions.ts`, `cues.ts` (removed or reduced to the scan); `teams.ts` unchanged for unique names; plan 07 D6 (Stage C) |
| R8-7 (news matcher, shared names: what R8-6's scan and labels cover) | Bounds R8-6 so its attacks can converge; every other part of R8-6 stands. Its second build (`66bb2a2`) left 11 violations, five of them forms the scan's lists lacked. R8-6's "every form, any case" has no end, and read literally it takes the residual from nearly every item ("Jackson was limited" holds WAS). (1) **The scan's lists are complete** when they hold, for each of the 32 teams: the nickname, singular and plural; the city or state and its common short names; every abbreviation ESPN, PFR, MFL, the legacy codes and the feeds use, dotted forms ("L.A.", "K.C.") included; the postal and AP abbreviations of the home state ("Minn.", "Tenn."); the current stadium and every name it has had since 2015; the training facility, its town and the camp town; the official hashtag; and the fans' names and nicknames on a closed list that holds at least every form an attack has reported. Positions: every ESPN position, its standard abbreviations and the alignment words ("weakside", "strongside", "Mike", "Will", "Sam"), each written glued, hyphenated or with a space, singular or plural. A form outside these categories leaves the accepted residual (R8-3 clause 6) and is not a violation. (2) **Abbreviations that are ordinary words.** An abbreviation whose lower case is an ordinary English word or part of a name (a closed, test-held list: "NO", "WAS", "TEN", "MIN", "SEA", "CAR", "DEN", "PIT", "LA", "WILL", "MIKE", "SAM" and the rest) counts as found in capitals outside an all-caps segment, and in any case, all-caps segments included, directly after a game or move word ("vs", "vs.", "v.", "@", "at", "against", "by", "from", "for", "to", "with", "visits", "hosts", "faces"). Every other abbreviation counts in any case. (3) **One set of forms.** Any form the scan reads as a team or a position is a label form when it stands next to the name where (a) places a label. (4) **Surnames.** A surname that a full name in the item ends with is a mention of that name: a label next to it is that name's label, so labels that fit different holders pick none. A bare shared surname with no full name in the item reads its labels as (a) does, in the same forms (a possessive, a two-word position in title case, a capitalised word after it, a surname that is also a team word). When no label picks it, it is counted unresolved, beside other refs too. (5) **Spelled suffixes.** A generational suffix written in the item ("II", "Jr.") narrows the holders a label can fit; it never makes the spelled holder the residual's taker. The residual goes only to the name's prominent holder, and only when no spelling in the item excludes him; otherwise the name is counted unresolved | `src/sources/news/labels.ts`, `match.ts`, `positions.ts`; plan 07 D6 (Stage C) |
| R8-8 (news matcher: one targeted round, then a freeze) | R8-6 and R8-7 stay the matcher's rules. Six fix rounds under R8-3, R8-6 and R8-7 did not converge: attacks of up to 200,000 titles kept finding further ways to write a team or a position, and each round's added guards cost recall elsewhere (19 violations against `08524ff`). The owner chose, on 2026-10-29, one targeted round and then a freeze. (1) **The targeted round** fixes these, at their root, against `08524ff`: a suffix written after a surname mention (R8-7 (5)); the label and count losses caused by round 3's guards (the first-name reading, the capitalised word after a surname, the possessive home-and-nickname label, an ordinary-word abbreviation in a label after a game or move word, a team-word surname); the label reader's reading of a word's period and of a compound hashtag (R8-7 (3)); the all-caps possessive; the crafted item that slows the build (linear time, within the perf tests' bounds, on the attack's item too); a behaviour test for every LEAD_WORDS, STAFF_WORDS, multi-team and code entry the attack found untested; the exported helper whose output grows exponentially; and the forms the attack named inside R8-7 (1)'s categories. (2) **After it the matcher is frozen for Stage C.** The gate checks it for: no exception and linear time on hostile input; no wrong holder picked by a label (0.95) in realistic RSS items; unique names exactly as at `f41e810`; every shared name left to no one counted. (3) **Known limitations, not gate failures**, recorded in the Stage C backlog: a residual (0.80) taken because a rarer team or position form is missing from the lists; a label lost (recall); and the readings the R8-6 and R8-7 judges rejected (a contrast across title and blurb, a labelled star's namesake, a coach on a team with one sharer, lookalike letters). Matching against the week's schedule (R8-6) stays the later improvement | `src/sources/news/`; plan 07 D6; `docs/evals/stage-c-backlog.md` (Stage C) |

## B9 — what ruling R8-3 built (Stage C, 2026-10-28)

These are not rulings. They record how ruling R8-3 was carried out (commit `cb2bcc7`), each clause with
tests that fail on the code at `f41e810`, how fix round 2 (commit `91a8c1b`, below) answered the
independent attack on that build, and how fix round 3 (commit `c16b9d8`, below) answered the attack on
fix round 2. What stays open is in `docs/evals/stage-c-backlog.md` ("Ruled R8-3"). The bullets fix
round 2 changed say so. Ruling R8-6 then replaced the shared-name reading these rounds built ("R8-6 —
the matcher fails closed" below, and its fix round 2, the last part).

- **The universe carries ESPN's position** · R8-3 clause 4 · `src/sources/news/match.ts`
  `universeFromEspnPlayers` and `UNIVERSE_SQL` read `ds_players.position_id` into
  `NewsUniversePlayer.position_id` (left out when unknown, as an unknown share is); `source.ts`
  `universePlayerOf` carries it through the run's temp file; `ds_news_players.espn_id` names it, and
  `percent_owned`, among its sources. No column changed.
- **Two readings of the cues** · clauses 2 and 3; plan 07 D6 · `teams.ts`: each mention also carries
  `shared`, the reading a shared name's holders are told apart with, over closed lists the tests hold
  word for word: the old words (against, vs, vs., versus, facing; "`<team>` matchup"), `RESULT_CUES`
  (26: "win over", "loss to", "lost to", "beat", "fell to", "past", "matchup with" …; no cue before
  the team's possessive, as in "beats the Browns' sack record"), `PLAY_CUES` (36: "sacks", "intercepts",
  "picks off", "brought down", "torches" …) and, between two teams only, `GAME_CUES` (those, and
  "host", "visit", "face"). "at", "tops", "visits" and "faces" alone stay no cue: each can stand before
  the subject's own team. A name one universe player holds keeps the old reading (`cue`, `pair`).
  Fix round 2 moved this reading to `cues.ts` and widened it (below).
- **A team named loosely is never evidence FOR a holder** · clause 2 · `match.ts` `sharedHolder`:
  `full_name_team` on a shared name needs a team written next to it or tied to it by a roster move.
  A game's teams and a loosely named team rule holders out; they never raise one, nor support a
  holder left by elimination ("Browns vs. Bengals: Justin Jefferson records two sacks" gets no ref;
  it gave the Browns LB 0.95). A loosely named team that rules no holder out leaves the item to
  prominence as before: choice 5 blocks only on a namesake's team, and choice 3's exclusion keeps a
  traded star's own news from being blocked by the team he joined. Fix round 2 withdrew that last
  reading: such an item is no residual, so it gets no ref (below).
- **Positions** · clause 4, choice 6(c) · `src/sources/news/positions.ts` (new). A closed vocabulary of 79
  forms (abbreviations in capitals, words in any case) maps each to the ESPN ids a player it describes
  may carry: DL words DT or DE, edge and linebacker words DE or LB, defensive-back words CB or S,
  "defender" any defender, offensive-line words none. It is read next to the name (right before it,
  a closing appositive, parentheses) or in a sentence describing the subject ("| The Browns
  linebacker led the team.", "…: Ravens QB dealing with …"). The subject must be the last person named
  before that sentence, and the sentence must name no one after it; "safety", "edge" and "kicker" are
  never read there. A written position rules out every holder of another position and is the
  holder's own evidence. Several must all fit; one that several holders fit picks none. A name
  written several times in one item is decided once, over all its evidence. Fix round 2: a describing
  sentence never rules a holder out or places one; only a position written next to the name does
  (below).
- **The bare surname follows the same rules** · clauses 2 and 4 · a surname several universe players
  share (302 of 1,604) takes a ref only from a team written next to it or tied to it by a move. A
  position filters its sharers, and a sharer who outshines the one left and is not ruled out blocks
  him. "Browns LB Jefferson" is the Browns LB's. "Cleveland's Jefferson", "Browns WR Jefferson" and
  "Jefferson: Questionable for Vikings" get no ref. "Ravens QB Jackson" is the Ravens QB's (it had none).
- **No single holder: no ref, counted** · clause 5; plan 07 D6 · `PlayerMatcher.matchItem` returns
  `unresolved`. The news build counts `unmatched` (kept items with no ref) and `unresolved` (kept items
  a shared name was left out of), and the publish step returns both as warnings (`eff refresh news`).
  Every item is stored and listed by `espn_get_news` as before.
- **The residual** · clause 6 · no team of a holder's, no position, no cue: the prominent holder at
  `full_name` (0.80), never 0.95. Fix round 2: no team at all, as clause 6 says (below).
- **Unique names are matched as before.** A one-holder name takes the code path it took, with the
  old cue reading; a property holds that R8-3's words leave a unique name's ref as a neutral word does.
  Over the 219 recorded and gate titles the matcher's output changed on 48, none of them for a unique
  name. Of the 71 labelled real titles two changed, both Lamar Jackson items: "Sources: Ravens QB
  Jackson has ankle sprain …" gains his surname ref, and "Lamar Jackson injury update: Ravens QB …" drops
  from `full_name_team` to `full_name`.
- **Expectations R8-3 changed** (`tests/sources/news/match-universe.test.ts`; none weakened, each
  commented where it stands): a cue now names what was a loose mention, so the star takes his own
  item — "…in a win over the Browns." and "…27-20 win over the Browns." (the Vikings WR), "Byron Young:
  Records two sacks in win over Eagles" (the Rams DE), "Marcus Harris: … in loss to Chiefs" (the Titans
  CB), "Quiet in loss | … loss to the Browns.", "Torches Browns' secondary", "… matchup with Cleveland."
  (the WR), "Michael Carter: Gets more work in loss to Eagles" (the Titans RB), and the synthetic "Sam
  Twin: Out in loss to Dolphins" (the Bills holder), each no ref before; a written position decides —
  "Browns LB Justin Jefferson: Records sack" (the LB at 0.95), "Chiefs DT Marcus Harris: Records sack"
  (the Chiefs DT), "Bengals CB Lamar Jackson: Signed to practice squad" and "Bengals sign CB Lamar
  Jackson" (the free-agent CB at 0.80), each no ref before; a loose team no longer raises —
  "Lamar Jackson: Ravens vs. Steelers moved to Monday", "… the Ravens visit the Bengals Sunday." and
  "Michael Carter II: … in the Eagles' win." drop from `full_name_team` to `full_name`; and "Browns vs.
  Bengals: Justin Jefferson records two sacks" goes from the Browns LB at 0.95 to no ref. The choice-6
  test keeps its blocking rule with the attached team alone ("Cleveland's Justin Jefferson", and two
  more). In `tests/cli/refresh.test.ts` the refresh wiring's universe carries the row's
  `position_id`: clause 4 joins it.
- **Tests** · `tests/sources/news/match-r83.test.ts` (each clause; every title of the gate's four
  batteries with its label; fast-check properties: an item whose evidence points to one holder never
  goes to another, also run over all 21,600 such items while building, and an item with no evidence
  follows clause 6), `positions.test.ts`, `source.test.ts`, `match-universe.test.ts`. Against the code
  at `f41e810`, 51 of the 111 tests of those four files fail: 29 of the 34 in `match-r83.test.ts` (the
  five that pass hold choices 3–5, the measured scope and two controls as built), all 10 of
  `positions.test.ts`, the 3 new source tests and the 9 changed above; so does the refresh wiring's
  universe test. The full unit suite passes (11,724 tests) and the coverage gate holds. The gate's first
  battery had 10 misattributions and 20 right refs; it now has none and 34, plus the open item below.
- **Open** · one battery title still reaches the star by the ruled evidence: "Lamar Jackson: Signs
  with Ravens practice squad" (the Ravens QB at 0.95; choice 3: a roster move to his own team ties it to
  him). The backlog lists it with the options.

### Fix round 2 — the independent attack on `cb2bcc7` (commit `91a8c1b`)

The attack found 14 ways the first build still broke R8-3: a namesake's injury, play or transaction
item reached the star, a star's item reached a namesake, or clear evidence lost its ref. Each is fixed
at root, and `tests/sources/news/match-r83-round2.test.ts` holds each one with the attack's texts.

- **The shared-name reading has its own file** · clauses 2 and 3 · `src/sources/news/cues.ts` (new)
  `sharedMentions`. A team's full name is one mention ("the Minnesota Vikings", "the Los Angeles
  Rams"): a cue before its first word holds, and its home is no second, loose mention. A team written
  in capitals (an all-caps headline) is read, and so are the short names feeds write
  (`TEAM_SHORT_NAMES`: "Vikes", "Pack" …). An abbreviation (`TEAM_ABBREVIATIONS`) counts where a
  context makes it a team: after a cue ("vs. MIN", "@ MIN"), in a tag after a name ("Justin Jefferson,
  CLE:", "(CLE - LB)"), or on a game's first side. `teamMentions` keeps exactly `f41e810`'s reading for
  unique names.
- **A cue is never cancelled, and is about its own person** · clauses 2 and 3 · `match.ts`. A loose
  mention of a team no longer cancels a cue on it. Before, "…in Sunday's win over the Minnesota
  Vikings" and "…loss to the Vikings. Minnesota converted 8 of 13 third downs." gave the star the
  namesake's injury. A cue or a game is about the person named last before it in its sentence. An
  uncued team between them is the cue's subject ("as Minnesota's offense torched …"). A play word
  must follow the name directly. A title's lead is about the first person it names ("Bills vs. Ravens:
  Lamar Jackson …"). So a shared name later in an item reads its own sentence's cue ("Denzel Ward: … |
  Justin Jefferson added a sack in the win over the Vikings."), and the surname path reads its own
  cues.
- **The cue list: closed, guarded, held entry by entry** · clause 3 · `RESULT_CUES` (29) gains "win
  at", "wins at", "victory at", "loss at", "losses at", "shutout of" and "blowout of". Two lists are
  new: `PLAY_OBJECT_CUES` (28: "strips", "forces", "blocks", "drops", "gets to" …) and
  `PASSIVE_PLAY_CUES` (15, before "by": "Sacked five times by Steelers"). "@" joins the against words.
  `TEAM_RESULT_CUES` ("fell to" …) names a game between two teams only; after a player it is the
  draft. A cue holds only where the words after the team read as the game or the play. A play word
  needs the team's player, ball or unit (`PLAY_OBJECTS`) or "for" and a number. The other words need
  punctuation, a number, the end, a unit or a word of `CUE_CONTINUATIONS`. The idioms that use a
  result word for a team's loss of its own player are no cue:
  - "for" after a result ("lost to the Browns for the season");
  - a passive or a participle "lost to" ("is lost to the Chiefs");
  - a copula's or an appositive's "loss to" ("is a big loss to the Eagles", "…, a big loss to the
    Browns");
  - the draft ("in the fifth round", "No. 150");
  - a dispute before "against" ("grievance against the Browns");
  - the team's own thing after it ("Beats Browns teammate", "Facing Eagles discipline",
    "Browns-imposed").
- **The residual, as clause 6 words it** · clauses 5 and 6 · prominence decides only for an item that
  names no team and no position word (a plural or a possessive one included). Positions that label
  another person do not count, nor does a sentence a pronoun gives to another player. An item that
  names either and leaves several holders gets no ref and is counted. This withdraws round 1's reading
  (a): "Lamar Jackson: Works out for Bengals" is no residual.
- **A describing sentence never picks** · clause 4 · `positions.ts`. "| The cornerback jumped the
  route." may describe the player the subject faced, and no rule short of parsing tells it from "| The
  linebacker did not practice Wednesday.". So such a sentence no longer rules holders out or places
  one. It counts as written about the subject when he is named last before it, no one is named after
  it in its sentence, and no pronoun makes it plainly another's ("him" within three words of the
  position, or "he" right after it). Then it keeps a pick it contradicts from being made, and it
  supports a holder a cue left. It is never read past a team or a position written next to the name.
  This withdraws round 1's reading (c).
- **Next to the name, at every mention and in every label form** · clause 4 · a position or a team
  written next to the name decides at each mention of him, his surname alone included ("Jefferson, a
  second-year linebacker,"). The forms: right after the name ("Justin Jefferson LB:"); a tag with an
  abbreviation, in either order ("(CLE - LB)", "Justin Jefferson, WR, Minnesota:"); an appositive with
  modifiers or an age ("the Ravens' newest cornerback"); the clause a headline's topic colon opens
  ("Lamar Jackson injury update: Ravens QB …"); and label words between a team and the name ("Rams
  edge rusher Byron Young", which attaches the Rams). "corner" joins the vocabulary, and "pass rusher"
  now fits ESPN's DT (the Chiefs' Chris Jones).
- **Both paths, one rule** · clause 4 · a shared surname is decided by the full name's function
  (`sharedHolder`), pooled over its mentions and reading its own cues. "Cleveland's Jefferson: Sacks
  Vikings QB twice" and "Eagles' Young: Sacks Rams QB" are the namesakes' at 0.60, as their full-name
  twins are theirs at 0.95.
- **Counted** · clause 5 · a shared surname that an item naming a team leaves to no one is counted,
  even when the item has another ref.
- **A roster move is a move** · clause 2 · "joins" or "lands on" a team ties it only when the move ends
  its clause there or names a roster. "Joins Ravens for workout" and "Lands on Vikings' radar" tie
  nothing.
- **Expectations fix round 2 changed** (each commented where it stands; none moves to the other
  holder). These items name a team loosely and leave two holders, so each gets no ref and is counted
  (clauses 5 and 6). Each was the star at `full_name` before.
  - "Justin Jefferson: Leads Vikings to win | …", "…: Notches 100 yards as Vikings roll" and "…:
    Catches TD as Vikings rally late";
  - "Lamar Jackson: Signs extension with Ravens", "Ravens' John Harbaugh: Lamar Jackson day-to-day"
    and "Lamar Jackson: Limited ahead of Bengals game | …";
  - "Lamar Jackson: Traded to Bengals in blockbuster" and "…: Cut through Bengals defense";
  - battery 2's "…: Works out for Bengals" and "…: Visits Bears", relabelled namesake (the gate's own
    label);
  - Lamar Jackson in "Ja'Marr Chase: … against Ravens | Chase outdueled Lamar Jackson.", and "…; the
    Ravens visit the Bengals Sunday." (a game in a sentence about no one).

  A describing sentence no longer picks (clause 4). Each of these had its holder before and now gets
  no ref: "…: Dealing with knee injury | The linebacker did not practice Wednesday.", "… The defender
  has started every game.", "…: Notches 11 tackles in Vikings loss | The linebacker led all
  defenders.", "…: Practices fully | The Vikings wideout faces Cleveland on Sunday." (and its battery-1
  twin), "Lamar Jackson (ankle) limited | The Ravens quarterback was limited.", "Lamar Jackson: Claimed
  off waivers by Ravens | The cornerback joins Baltimore's secondary." and "Cleveland's Jefferson: Placed
  on IR | The linebacker will miss four games.". Three more changed:
  - "Justin Jefferson: Catches TD | Denzel Ward covered him. The linebacker was beaten twice." loses the
    WR: it names a position, so it is no residual;
  - "WR Justin Jefferson: Questionable | The linebacker did not practice Wednesday." is the WR: his
    label decides (no ref before);
  - the tags "Justin Jefferson, WR, Minnesota:" and "…, LB, Cleveland:" attach their team and rise to
    `full_name_team`.

  The cue-list tests moved from `teamMentions`' `shared` field to `sharedMentions`, and each reads
  its words in their own form.
- **Tests** · `match-r83-round2.test.ts` (new) holds every violation with the attack's texts, the
  game words entry by entry, the fixer's further attacks, and four fast-check properties: a loose
  mention never cancels a cue, a describing sentence alone never picks, a loosely named team alone
  gives no ref, and the two paths agree. `match-r83.test.ts`, `positions.test.ts` and
  `match-universe.test.ts` hold the changed expectations. Against `52796bf`, 52 of the 118 tests of
  those four files fail, 23 of them among the 28 new ones; against `f41e810`, 86 fail. A mutation run
  removed or weakened 36 of the new rules one at a time, and a test caught each. The hyphen guard,
  which none caught, was dead code the continuation rule covers, so it is gone. The full unit suite
  passes (11,762 tests), the coverage gate holds, and the news perf tests pass (worst case 3.3 s of
  15 s).
- **Measured** · the gate's battery 1 has no misattribution: 28 right refs and the open item; round 1
  had 34, and the 6 lost are the clause-5 and describing-sentence recall above. The 71 labelled real
  titles match as at `52796bf`, and unique names as at `f41e810`; two 11-name roundups gain their
  eleventh ref where the star's slot freed under the 10-ref cap. 27,552 generated items with a known
  owner (cue, team and label forms, loose mentions, pronoun sentences) give no ref to the other holder.
- **Open** · the roster move to the star's own team above, and two limits the fixer's own attack found,
  both of which stay as built. A game written about the subject but not his own ("Jefferson watched
  the Vikings host the Bengals from the stands") rules his namesake out (choice 2). An item naming no
  team and no position is clause 6's residual even when its verbs are the namesake's ("Justin
  Jefferson: Burned for touchdown | The receiver beat him deep." gives the WR 0.80, as accepted).

### Fix round 3 — the independent attack on `7b9572c` (commit `c16b9d8`)

The attack found 16 ways fix round 2 still broke R8-3, or lost what `f41e810` had for no clause's
sake. Another player's position in a headline topic's clause was read as the subject's. Idioms for a
team's loss of its own player were read as games once written in capitals, with a dash or before
"until". "injured" before a name read as a label for the opponent's hit. The lists missed roster
moves and label forms in some voices, "at" between two teams, and plain variants of play wording. A
teammate named after the subject took his cue, and a game in a sentence naming no one went to no
one. Two cue lists had no test. Initials read as positions. On the surname path a written position
could block its own holder, the surname gave what the full name refused, and a position next to it
was ignored and left uncounted. One pass was quadratic. Each is fixed at root, and
`tests/sources/news/match-r83-round3.test.ts` holds each one with the attack's texts.

- **A topic's clause is his label only when it names one player** · clause 4 · `positions.ts`
  `positionPhrasesNextTo`: the clause after "<name> injury update:" labels him only when the rest of
  its sentence names no team, no position word, no word of `SECOND_PLAYER_WORDS` (23: "also",
  "teammate", "star", "him" …) and no person. "…: Steelers cornerback fined for hit on Ravens QB",
  "…: Ravens' top cornerback also ruled out for Week 9" and the six others the attack named get no ref
  (the other holder at `7b9572c`). The captured "…: Ravens QB dealing with ankle sprain; Week 5 status
  still unknown, per report" stays the QB's.
- **Idioms of a team's loss of its own player, in any case** · clause 3 · `cues.ts` `cueHolds`.
  Each case-insensitive, so Title Case and all-caps headlines read alike:
  - "loss to" after a copula (`COPULAS`, 13), a contraction, a clause's opening with an article or with
    `LOSS_DEGREE_WORDS` (27: "big", "huge" …), or a word that is no preposition and an article
    ("Injury a big loss to Eagles"); a preposition (`GAME_PREPOSITIONS`, 32) or a score keeps it a
    game ("in a big loss to the Browns", "…, a 24-20 loss");
  - "lost to" after a copula or at a clause's opening ("…: Lost to Browns until December", "Is Lost To
    Browns");
  - "until" and "till" join "for" (`DURATION_WORDS`);
  - "to" or "into" after a passive play's team is a demand ("Pressured by Browns to take pay cut",
    `PASSIVE_PURPOSE_WORDS`);
  - `DISPUTE_WORDS` (37) gains "holds out", "rules", "decides" … ("Arbitrator rules against Browns").
- **"injured" before a name** · clause 2 · `VERB_LIKE_LABELS` (lead, top, injured) read as a label
  only after a possessive, and "injured" before another label word. "A hit by the Vikings injured
  Justin Jefferson" attaches no team (the WR at 0.95 at `7b9572c` and at `f41e810`).
- **Roster moves in every voice** · clause 2 · `sharedMovedTeams`: a team that reinstates him
  (`SHARED_TEAM_MOVE_WORDS`) or places him on a reserve list (`PLACE_WORDS` with `RESERVE_LISTS`, 16,
  the list after the name), and his clause's "activated", "reinstated" (`SHARED_PLAYER_MOVE_WORDS`),
  "activated off IR", "placed on IR by". "Justin Jefferson: Activated by Vikings" and the ten other
  forms the attack named are the star's at 0.95 again. The namesake's team's move is still blocked by
  the star (choice 6). `teams.ts`, the unique names' reading, is unchanged.
- **Label forms** · clause 2 · `sharedAttachedTeams`: "<name> of [the] <team>", role nouns
  (`LABEL_ROLE_NOUNS`: "superstar", "playmaker", "pass-catcher", "MVP" …), a rank ("No. 1"), "top" and
  "lead" after a possessive, plural labels (`LABEL_PLURALS`, 39), and `sharedListTeams`: a plural
  label attaches its team to every name of the list it heads ("Vikings WRs Jordan Addison and Justin
  Jefferson"). A list is names joined by "," or "and", with an "and" ("A, B and C"); a bare comma is
  none.
- **"at" between two teams** · clause 3 · `GAME_CUES` gains "at": "Vikings at Bears: Justin Jefferson
  questionable" is the WR's at 0.80 (no ref at `7b9572c`). After one team "at" names no opponent, as
  before.
- **A cue is about the sentence's subject** · clause 3 · `match.ts` `about`: a result, an against word,
  a game or "<team> matchup" is about the first person its sentence names before it (a possessive one
  with another person after him is that person's), with the names of a list he heads; a play word
  still needs his name right before it. Another person named between him and a result or an against
  word anchors the game: it is that person's team's against the cued team, which he plays in on
  either side. That person may be the cued team's own player, and then the cue stands. A person of no
  known team leaves the cue no evidence. So "Jackson found Zay Flowers twice in the win over the
  Bengals" is the QB's again, and "Jackson and Derrick Henry ran wild…" too. "Bijan Robinson ran past
  Justin Jefferson in the win over the Browns" no longer gives the WR the Browns LB's item (it did at
  `7b9572c`), and the anchor keeps "Unlike Justin Jefferson, Bijan Robinson starred in the win over
  the Browns" and "…was no match for Bijan Robinson…" from doing so.
- **A game in a sentence that names no one is the item's subject's** · clause 1, choice 2 as built ·
  "Lamar Jackson: Limited | Jackson (ankle) was limited; the Ravens visit the Bengals Sunday." gives
  the QB 0.80 whatever the punctuation (no ref at `7b9572c`, which turned on ";" against ", and").
- **Play wording, its plain variants** · clause 3 · `PLAY_OBJECTS` (100) gains the singular and plural
  forms it lacked ("cornerback", "CB", "safety", "linebacker", "defender" …), never one that only
  modifies a noun after it ("the Browns' linebacker depth": positions.ts `POSITION_COMPOUND_HEADS`).
  "for" takes a number word (`NUMBER_WORDS`). `PASSIVE_PLAY_CUES` gains "burned", "torched",
  "gashed", "shredded", "strip-sacked" and "stuffed".
- **Every deciding list is held** · clause 3 · 23 lists are held by one literal in the test, compared
  word for word with the source: the two the attack named (`PLAY_OBJECTS`, `CUE_CONTINUATIONS`), the
  new ones, `PLAY_GAP_WORDS`, and positions.ts' `POSITION_COMPOUND_HEADS`, `HEADLINE_TOPICS` and
  `POSITION_MODIFIERS`. Each entry of 19 of them also runs through a behaviour, from the same literal,
  so a deleted entry fails both. A mutation run deleted each of those 439 entries one at a time:
  434 fail a behaviour test, and the 5 that do not are entries a shorter one covers
  ("front seven", "pass rush", "pass defense", "pass rusher", "pass rushers"), which only the word-for-word test holds.
- **Initials and times are no positions** · clause 6 · `positions.ts`: a letter before a period and
  a letter ("1 P.M.", "P.J. Walker", "K.J. Osborn"), or a one-letter abbreviation before a period
  ("S. Smith"), is no position word, and a word inside a person's name never counts against the
  residual. The QB keeps clause 6's 0.80 in the five items the attack named.
- **Prominence is judged before the evidence** · clause 4 · `sharedHolder`: the prominent holder is
  found over every holder the spelling leaves, and blocks only while he is not ruled out. "Vikings S
  Smith" is Harrison Smith's, as "Vikings' Smith" is (no ref at `7b9572c`: among the safeties left,
  Tykee Smith was prominent). The attack's sweep found 78 such pairs; all 559 holders the property
  checks keep their ref when their own position is written.
- **The surname never gives what the full name refuses** · clause 4 · the surname path also blocks a
  sharer whose own full name's prominent holder is another, not ruled out. "Eagles' Young",
  "Philadelphia's Young", "Chiefs' Harris" and three more get no ref, as their full names do (the
  namesakes at 0.60 at `7b9572c`).
- **A position next to a shared surname is evidence** · clauses 4 and 5 · with no team written or
  moved to, a position written next to a shared surname takes the one sharer it leaves, never a free
  agent: "LB Jefferson", "Linebacker Jefferson" and "QB Jackson" at 0.60 (no ref at `7b9572c` and at
  `f41e810`). One several sharers fit ("DT Harris", "WR Jefferson") gets no ref and is counted, beside
  another ref too. A position word may stand before a shared surname ("Linebacker Jefferson").
- **Linear** · robustness · `sharedMentions` reads each abbreviation against the next team only (a
  farther one cannot pair: the gap would hold the nearer), in one pass; `about` and the actor check
  use binary searches; `notAName` remembers `mergeName`. The attack's capped item takes 2.7 ms
  (`f41e810` 2.6, `7b9572c` 33.9); a full file of it builds in 9.3 s (`f41e810` 10.9 s; `7b9572c` about
  170 s by the attack's measure).
- **Expectations fix round 3 changed** (each commented where it stands; none weakened):
  - `match-r83.test.ts`, the word-for-word lists: `PASSIVE_PLAY_CUES` gains its six plain variants and
    `GAME_CUES` gains "at" (clause 3, "and the like"; the attack's own items);
  - `match-universe.test.ts`, "…was limited; the Ravens visit the Bengals Sunday.": back to round 1's
    `[[QB_LAMAR, "full_name"]]`. Fix round 2 had written no ref; choice 2 as built reads the game as
    the item subject's (clause 1).
- **Tests** · `match-r83-round3.test.ts` (new, 35 tests) holds every violation with the attack's
  texts, the controls that keep each fix from overreaching, the 23 lists word for word and entry by
  entry, three fast-check properties (an item whose round-3 evidence points to one holder never goes
  to another; an own-team idiom is evidence for no holder off that team; clause 6 past initials and
  times) and two exhaustive checks (a written own position never costs a ref, 559 holders; a surname
  never gives what the full name refuses, 15 refusals). `match.perf.test.ts` (new, process project)
  bounds the worst case: the attack's item at most 12 times a benign near-cap one (3.4 now, 4.8 at
  `f41e810`, 56 at `7b9572c`), and 1,000 of them in under 15 s. Against `7b9572c`, 27 of the
  35 new unit tests fail, and both perf tests; against `f41e810`, 32 fail, at least one
  per clause on its outcome. The full unit suite passes (11,797 tests) and the coverage gate holds.
- **Measured** · the gate's four batteries give exactly `7b9572c`'s output: battery 1 has no
  misattribution beyond the open roster move, with 28 right refs. The 71 labelled real titles match as
  at `7b9572c`. Unique names match as at `f41e810` over 37,701 items (every recorded, test and probe
  title, and generated items with every list word around unique names); three roundups differ only
  through the 10-ref cap. 1,160 generated items with a known owner in this round's forms give the other
  holder no ref (132 at `7b9572c`), and the owner 844 refs (220); round 2's 27,552 still give none.
- **Open** · the roster move to the star's own team, as before. Two limits are new, both fail safe. A
  topic's clause about him that names the player he hit is no label either ("Chris Jones injury
  update: Chiefs DT fined for hit on Broncos QB" gets no ref). A free agent named as the subject's
  teammate leaves his cue no evidence ("Jackson found Van Jefferson twice in the win over the
  Bengals"). One limit stays as built: a cue about a free-agent namesake still rules him out (he plays
  no games), so a namesake signed since the universe was read gives the star his game item by
  elimination. "Lamar Jackson: Carted off with ankle injury | Jackson was hurt covering a punt in
  Sunday's loss to the Steelers." gives the QB 0.80, as at `f41e810`.

### R8-6 — the matcher fails closed (commit `154838b`)

R8-3's three fix rounds grew the cue and description wording and did not converge (15, 16 and 16
violations). Ruling R8-6 (§R8) makes the matcher fail closed for a name more than one universe
player holds. The shared-name path is rebuilt at the root and is linear in the item's length. Names
one universe player holds take `f41e810`'s code path, unchanged.

- **What reads a shared name now** · `src/sources/news/labels.ts` (new) and `match.ts`. The item is
  read for two things only. (a) The label written next to the name: a team or a position directly
  before it (whitespace only between; a team's possessive allowed), in parentheses directly after it,
  or in the headline's name tag before the colon. A word that is no team and no position ends the
  label ("Vikings star Justin Jefferson" labels no team), and so does any punctuation but the
  possessive. A word of another person's name is no label word. The label must fit exactly one
  holder: a team fits a holder the universe lists on it (a free agent fits none), a position a holder
  whose ESPN `position_id` it allows. Labels that fit different holders pick none. The label must be
  on the name's first mention. A later mention may be the other holder ("Lamar Jackson: Throws pick to
  CB Lamar Jackson"; "Justin Jefferson: Mistaken for Vikings' Justin Jefferson | The Browns
  linebacker …"), so a label written only there picks no one. Choice 6 stands: a team-only label for a
  namesake is blocked by a prominent holder whom no position of the label rules out. (b) The broad
  scan, for the residual: any team in every form and any case, and any position in every written form,
  anywhere in the title or blurb outside the persons' names. The text is read NFKC, with accents
  stripped, zero-width marks removed, curly apostrophes and dashes folded, and Cyrillic, Greek and
  odd Latin lookalikes folded. An abbreviation whose lower-case form is an ordinary word or a name
  counts only in capitals, so an all-caps headline's "NO" counts and "No timetable" does not. Only
  when the scan finds nothing does the prominent holder take the item at `full_name` (0.80). A
  generational suffix stays spelling, as at `f41e810`: one that leaves one holder writes his name
  alone. Everything else gives the name no ref and counts it (`unresolved`). The bare shared surname
  follows (a) and (d): its first mention's label must fit one sharer, choice 6 blocks him on the
  surname's and on his full name's prominent holder, and it never takes the residual. "Jefferson MLB:"
  and "Jackson QB2:" are labels now, and an unlabelled shared surname in an item naming a team or a
  position is counted.
- **The closed lists** · `labels.ts` `SHARED_HOMES`, `TEAM_SHORT_NAMES` (12), `TEAM_ABBREVIATIONS`
  (40, with PFF's ARZ, BLT, CLV and HST and NY), `CAPS_ONLY_ABBREVIATIONS` (17), `TEAM_SINGULARS` (23,
  scan only), `TEAM_CITIES` (10, scan only: "Nashville", "Foxborough" …), `CONFUSABLES` (57),
  `POSSESSIVE_MARKS`, `LABEL_SEPARATORS`; with `teams.ts`' nicknames and homes. `positions.ts`
  `POSITION_ABBREVIATIONS` (32, IDL, RCB, LCB, NCB, NB, WLB and SLB new), `RANKED_ABBREVIATIONS`,
  `POSITION_WORDS` (36, "d-lineman", "d-tackle", "d-end", "3-technique", "edge-rusher" and
  "place-kicker" new), `SCAN_ONLY_ABBREVIATIONS` (8) and `SCAN_ONLY_WORDS` (22: "edge", "tackle",
  "guard", "center", "rusher", "backer", "nickel", "o-line" …). The scan-only forms are verbs or
  common nouns before a name ("Browns edge Justin Jefferson, Vikings"), or roles. An ambiguous token
  counts as found and never labels. Plurals are read by rule. A two-word position stays listed only
  where its last word alone reads otherwise ("offensive lineman" is not "lineman"'s DL). The ones that
  added nothing went ("wide receiver", "free safety", "left tackle" …), and so did "EDGE", "Jax",
  "long snapper" and "pass-catcher": each was covered by another entry, so no behaviour test could
  hold it.
- **What was removed** · `cues.ts`, whole: the cue, play, game, idiom, dispute, label and move lists
  and their readers (`sharedMentions`, `sharedAttachedTeams`, `sharedListTeams`, `sharedMovedTeams`).
  Also `positions.ts`' describing sentences, topic clauses, `positionWordSpans` and sentence bounds,
  `match.ts`' `sharedHolder`, `cuesAbout`, `about`, `listAround`, `describedAbout`, `residualFor` and
  `PLAY_GAP_WORDS`, and `teams.ts`' `LEGACY_CUES` and its exported move patterns. `teams.ts` is
  `f41e810`'s code again, plus a header note. Its shared-reading data (`TEAM_ABBREVIATIONS`,
  `TEAM_SHORT_NAMES`, `SHARED_HOMES`) moved to `labels.ts`. `match.ts` went from 1,190 lines to 689,
  `positions.ts` from 577 to 169, and `labels.ts` is 483.
- **Tests** · `tests/sources/news/match-r86.test.ts` (34) holds each clause, every closed list word for
  word and entry by entry, and two fast-check properties over the universe's 16 shared names. First:
  with no label next to the name, a holder takes it only when no team and no position is written
  anywhere, and then only the prominent one at 0.80. Second: writing any form of the closed lists
  anywhere in a residual item takes the residual away. Both were also run at 100,000 runs. The file
  also checks that unique names equal the frozen `f41e810` matcher (`tests/sources/news/f41e810/`,
  its code with the import paths re-pointed), over all 142 fixture news items and a 3,000-item
  generated corpus. `match-r86-cases.test.ts` (17) holds each case at its R8-6 outcome: the gate's four
  batteries with their labels, the 16 violations left open at `dbe9686` with every variant they named,
  the 443 misattributions the attacks on R8-3's three rounds found (each with whose item it is, and
  checked never to reach the other holder), and the 366 texts of the R8-3 test files.
  `positions.test.ts` is rewritten for the reduced module. `match.perf.test.ts` adds the last attack's
  4,000-character item over the recorded universe. It costs 1.3 times a benign near-cap item (bound 6;
  `dbe9686` about 210 times), 1.8 ms against 203 ms at `dbe9686`, and 1,000 of them build in 0.9 s
  (bound 15 s). Against `dbe9686`, 38 of the 51 tests in the two new files fail, and the 13 that pass
  hold behaviour R8-6 keeps. Against `f41e810`, 47 fail. Each clause has tests whose refs differ from
  both: (a) 6 of its 7, (b) 3 of 5, (c) 3 of 3, (d) 2 of 3, plus the counts. A mutation run deleted
  each of the 337 closed-list entries one at a time, with the word-for-word test skipped, and a
  behaviour test caught every one. An earlier run found two dead entries ("pass-catcher" and
  `HANDLE_MIN_FORM`), and both are gone.
- **Expectations R8-6 changed** (each commented where it stands; none moves to the other holder).
  `match-r83.test.ts`, `-round2` and `-round3` are replaced. Their position-id, counting and battery
  tests moved, and their texts are held at their R8-6 outcomes. In `match-universe.test.ts`, the
  star's own items that name a team with no label lose their ref: a cue, a game, "<team> matchup", a
  roster move. "Bengals CB Lamar Jackson" gets none, because the Bengals list no Lamar Jackson; "Eagles
  DT Byron Young: Records sack against the Rams" gets none; "Ravens activate QB Lamar Jackson" falls to
  `full_name`; and the one labelled real title that loses its ref is the CBS "Lamar Jackson injury
  update: Ravens QB …". In `match.test.ts`, "Bijan Robinson, Dolphins" with no colon is no label.
- **Measured** · Gate battery 1 has no misattribution and 19 right refs. The gate counted 20 right and
  10 wrong; `dbe9686` had 28 right and the open one wrong. The earlier batteries' 1,167 labelled texts
  misattribute 3 times now, all accepted residuals naming no team and no position ("Justin Jefferson:
  Sacks Carson Wentz twice in win", "Joe Burrow: Picked off by Lamar Jackson", "Chris Jones: Punts six
  times for 280 yards"). They misattributed 237 times at `dbe9686` and 383 at `f41e810`. None of the 443
  misattribution texts reaches the other holder.
- **The recall cost** (refs to a shared name's holders, against each build; the batteries by their
  labels). Over the 1,167 labelled battery texts:
  - against `dbe9686`, 158 right star refs and 52 right namesake refs are lost and 8 namesake refs
    gained, while 234 wrong refs go;
  - against `f41e810`, 191 star and 24 namesake refs are lost and 4 star and 114 namesake refs gained,
    while 380 wrong refs go;
  - texts with their right holder's ref: 327, from 529 at `dbe9686` and 424 at `f41e810`.

  Over the 142 recorded fixture news items, one real item loses its star ref against both builds: the
  CBS "Lamar Jackson injury update: Ravens QB dealing with ankle sprain …", in the capture and in the
  labelled set. Against `f41e810`, "Sources: Ravens QB Jackson has ankle sprain …" gains the QB's
  surname ref, in both. Unique names differ from `f41e810` on none of the 142.
- **Kept as accepted, or a reading for the re-gate** · the residual: a namesake's item that names no
  team and no position goes to the star (the 3 above). The recall loss: a shared name's item that
  names a team or a position but carries no label gets no ref, counted (the 158 star refs above;
  matching an item's opponent against the week's schedule would recover much, not built). Choice 6's
  block of a team-only namesake label ("Cleveland's Justin Jefferson", "Philadelphia's Byron Young").
  The first-mention reading of (a). A free agent fits no team label ("Bengals CB Lamar Jackson", a
  namesake signed since the universe was read). Two holders on one team at one position ("Jaylon
  Jones", both Titans CBs) are never told apart. Over-detection costs some star recall ("leads the
  pack", "OT", "medical bills"), as the ruling accepts.

### R8-6 fix round 2 — the attack on the first build (commit `1ca78bf`)

The independent attack on `154838b` (its docs at `6ba7bb1`) found 23 violations of R8-6. Fourteen
were forms the scan missed: team-site domains, every rank, the unit and alignment forms, depth-chart
names, hyphenated spellings, roles, plurals in capitals, cities, singulars, other sites' and legacy
abbreviations, hashtags, short names and lower-case abbreviations. Five were label readings that broke
adjacency or ESPN's position id: a team ending an introductory phrase, a line or paragraph break, a
closing quotation mark, positions read wider than ESPN's id, and the two-word forms the first build
dropped. The rest were the first-mention reading, a spelling that bypassed the scan, and
character-set entries no test held. Each is fixed at its root.

- **One folded reading** · `src/sources/news/labels.ts` `sharedReading`, `foldText`. The item is
  folded one code point at a time, with a map back to the sanitised text's offsets: an apostrophe-like
  mark or a lookalike letter first (APOSTROPHES, CONFUSABLES), else NFKD with the combining marks
  stripped, then each piece's dash (Unicode's Pd and the minus sign, DASHES) or lookalike. The label
  and the scan both read the folded text, so one set of characters decides both. The first build had
  five sets, and 35 of their 51 entries changed no behaviour. The scan's zero-width set went:
  sanitizeText removes those characters before the matcher reads.
- **Adjacency as written** · `labels.ts`, `match.ts`, `feeds.ts`. A line or a paragraph break breaks a
  label. `markBreaks` marks every newline and every HTML tag of the raw item (entity-encoded ones too),
  a second sanitizeText keeps the marks, and `breakOffsets` aligns them with the sanitised text. Only
  the labels read them, only for a shared name, and only when the raw item holds a line break, "<" or
  "&". The stored title and blurb now keep each line break as one "\n" (`collapseLines`;
  sanitizeText makes it a space for every reader, and the promo filter reads it as one), so the news
  build sees what the item wrote. An
  apostrophe that closes a quotation opened in its segment is no possessive ("'Beat the Vikings'
  Justin Jefferson tells …"). Three rules take labels away and never add one. A label of teams alone
  (no possessive, no position) must open its clause: a word right before it makes the team that
  word's object or modifier ("Against the Vikings Justin Jefferson recorded …", "Week 9 at Vikings
  …", "Browns beat Vikings Justin Jefferson …"; a period ends the clause, but after
  CLAUSE_ABBREVIATIONS' "vs" and "v"). An AMBIGUOUS_LABEL_WORDS word ("safety", "corner") right after
  a LABEL_BLOCKERS word (54 articles and prepositions) is the ordinary word ("After safety Lamar
  Jackson leads …"). In a segment all in capitals, the forms that are also ordinary words
  (CAPS_ONLY_ABBREVIATIONS, and HEADLINE_ORDINARY_WORDS' "EDGE") label no name before it.
- **Labels: ESPN's position, every mention** · `positions.ts`, `match.ts`. ESPN's own position,
  abbreviated or spelled out, fits only its own id: DT, NT and "defensive tackle" an ESPN DT; DE an
  ESPN DE; LB, ILB, MLB and "linebacker" an ESPN LB; CB a CB; S, FS, SS and "safety" an S. A writer's
  group form spans its ids (DL, EDGE, OLB, DB, NB, "edge rusher", "pass rusher", "defender"). So
  "Vikings CB Smith" is no Vikings S's and "Chiefs DE Jones" no Chiefs DT's, and "Eagles DT Byron
  Young" is the Eagles DT's: choice 6(c) works again. The two-word forms the first build dropped are
  labels again ("wide receiver", "slot receiver", "defensive lineman", "inside", "middle" and "outside
  linebacker", "free" and "strong safety"), and so is "EDGE" in capitals. A rank may follow any
  abbreviation ("LB1"), and a label word may be written hyphenated or glued ("edge-rusher",
  "wide-out"). The labels of every mention count: "Lamar Jackson: Limited | Ravens QB Lamar Jackson
  (ankle) …" is the QB's, and the first-mention reading went. A segment that writes the name both with
  a label and without one picks no one ("Lamar Jackson: Throws pick to CB Lamar Jackson"; "Lamar
  Jackson, not the Ravens QB Lamar Jackson, signs …").
- **A spelling picks no one** · `match.ts`. A written suffix narrows the holders to those ESPN spells
  with it. The name stays shared, so a label decides among them, and the one spelled holder takes the
  residual only when the scan finds nothing, as the prominent one does. "Michael Carter II: Waived by
  Titans | The running back was released." and "Byron Murphy II: Vikings CB ruled out" get no ref and
  are counted.
- **The scan, every form** · `labels.ts`, `positions.ts`. Teams: Pro Football Reference's and
  MyFantasyLeague's abbreviations (TEAM_ABBREVIATIONS, 52); the legacy ones and D.C.
  (SCAN_ONLY_TEAM_ABBREVIATIONS, 7); every singular, the ordinary-word ones included (TEAM_SINGULARS,
  40); the places a team plays or trains, its city's nicknames and its stadium (TEAM_CITIES, 64); the
  short names several teams or words share, and the fans' and legacy names (SCAN_ONLY_TEAM_NAMES,
  19); and the teams' own hashtags (TEAM_HASHTAGS, 13); each word form in its hyphenated and glued
  spellings. A compound (a handle, a hashtag, a dotted word, a camel-cased word) is read for its
  segments ("CLE", "KC", "Bear", "12s") and for any word form of four letters or more inside it
  ("clevelandbrowns.com"); a hashtag for three-letter ones too. Positions: every rank and plural by
  rule ("CB2", "WR10", "LBS"), techniques by rule ("1-tech", "9-technique", "4i"), and the units,
  roles, alignments and depth-chart names (SCAN_ONLY_WORDS, 41; SCAN_ONLY_ABBREVIATIONS, 14). A
  lower-case abbreviation counts unless CAPS_ONLY_POSITION_ABBREVIATIONS (13) lists it: "cb", "olb"
  and "idl" count, "lb", "will" and "s" do not. The round's scan-sweep of 223 team forms misses none
  (31 at the first build).
- **What was removed** · `RANKED_ABBREVIATIONS` (a rank follows any abbreviation), `POSSESSIVE_MARKS`
  (one mark after the fold), `SCAN_POSITION_KEYS` and `SCAN_POSITION_ABBREVIATIONS` (now
  `positionFound`), the scan's zero-width set, `positions.ts`' own dash fold, "edge" in SCAN_ONLY_WORDS
  (the EDGE abbreviation reads it in any case), the entries their spellings now cover
  ("signal-caller", "place-kicker", "edge-rusher", "pass-rusher", "nickelback"), and `match.ts`'
  first-mention reading and spelled-holder shortcut.
- **Tests** · `tests/sources/news/match-r86.test.ts` (45), `match-r86-cases.test.ts` (21),
  `positions.test.ts` (13, rewritten), `feeds.test.ts` (one more), `match-universe.test.ts` and
  `match.perf.test.ts` (two more). Every list is held word for word and entry by entry. The dash fold
  is held over every Pd character Unicode lists (the test enumerates them), each apostrophe by a label
  and by the scan's "TEAM'S", and each line-break character and tag form by a label. A mutation run
  deleted each of the 580 closed-list entries and 46 character-class and alternation entries
  one at a time (626 mutants), with the word-for-word tests removed: a behaviour test caught every
  one. The cases file holds the 23 violations with every variant and the triage's texts (142 rows),
  and the round's batteries (274 more titles), each with whose item it is. None reaches another holder
  of the name, except the readings below. The properties now write every list's forms in every
  spelling, and the frozen `f41e810` oracle still matches the unique names over the 142 fixture items
  and the generated corpus. Of the 98 tests in the four files this round rewrote or extended, 41 fail
  at `6ba7bb1`, 67 at `dbe9686` and 77 at `f41e810`. Each clause has a test that fails at all three:
  (a) "adjacency as written", "a label must fit exactly one holder", "labels … pick none; so does a
  segment …" and "a label of teams alone must open its clause"; (b) "every form the attack on the
  first build found missing"; (c) and (d) "a spelled name is a shared name still".
- **Expectations this round changed** (each commented where it stands; none moves to the other
  holder). "DE Byron Young" and "Eagles DT Byron Young" now pick the holder of that ESPN position
  (`match-r86.test.ts`, `match-universe.test.ts`, the R8-3 texts). "Michael Carter II: Records
  interception | … in the Eagles' win." loses the residual: it names a team. The R8-3 texts' two-word
  labels ("Rams outside linebacker Byron Young", "Chiefs defensive lineman Chris Jones", "Vikings slot
  receiver …", "Minnesota Vikings wide receiver …") give `full_name_team`. "EDGE Byron Young" and
  "Byron Young (Eagles DT)" pick their holder.
- **Measured** · the gate's battery 1 still has no misattribution and 19 right refs. The last attack's
  4,000-character item and the round's hostile items (compounds, domains, tags, unclosed tags, nested
  entities, quotes, hyphens, camel-cased pairs, labels) each cost at most 2.8 times a benign near-cap
  item (about 2.4 ms), and 1,000 of them build in about 2.5 s (bound 15 s).
- **The recall cost** (refs to a shared name's holders; the batteries by their labels):
  - Over the earlier batteries' 1,167 labelled texts, 318 carry their right holder's ref (326 at
    `6ba7bb1`, 529 at `dbe9686`, 424 at `f41e810`) and 3 a wrong one, the accepted residuals (3, 237
    and 383). Against `6ba7bb1`, 4 star and 12 namesake refs are lost, and 1 star and 7 namesake refs
    gained. Against `dbe9686`, 162 star and 58 namesake refs are lost and 9 namesake refs gained,
    while 234 wrong refs go. Against `f41e810`, 195 star and 29 namesake refs are lost and 4 star and
    114 namesake refs gained, while 380 wrong refs go.
  - Over the round's own batteries (289 texts on a shared name), 68 carry their right holder's ref
    (69, 80 and 60) and 6 a wrong one (115, 136 and 166). Against `6ba7bb1`, 14 star and 2 namesake
    refs are lost and 4 star and 11 namesake refs gained, while 109 wrong refs go; against `dbe9686`,
    20 and 5 lost, 4 and 9 gained, 130 wrong gone; against `f41e810`, 29 and 1 lost, 2 and 36 gained,
    160 wrong gone.
  - Over the 142 recorded fixture items, nothing changes against `6ba7bb1`. Against `dbe9686` and
    `f41e810` the CBS "Lamar Jackson injury update: Ravens QB …" still loses its star ref, and
    against `f41e810` "Sources: Ravens QB Jackson has ankle sprain …" still gains the QB's surname
    ref. Unique names differ from `f41e810` on none.
  - The star refs lost against `6ba7bb1` are items that name a form the scan now finds ("WR4",
    "split end", "per TitansOnline.com", "Minneapolis"), a writer's position ESPN does not give him
    ("Chiefs DE Chris Jones", "Rams linebacker Byron Young"), or a team after a blocker word ("Browns
    at Vikings Justin Jefferson props"). The new forms that are also ordinary words take the star's
    residual away where they stand ("throws a dime", "a roster slot", "(nose)", "per CBS Sports",
    "Brown" as a surname), as the ruling accepts.
- **Kept as accepted, or a reading for the re-gate** · the residual (the 3 above, and gate battery 2's
  "Lamar Jackson: Inks reserve/future contract"); the recall loss; choice 6; a free agent fits no team
  label; two holders on one team at one position. Readings: a label written next to the name picks him
  even where the item is his namesake's ("Ravens QB Lamar Jackson's namesake signs with Bengals", the
  round's B3 rows, as at every earlier build); a name the title writes alone and the blurb labels takes
  the blurb's label, even where the blurb contrasts the other holder ("Justin Jefferson: Released by
  Browns | Not to be confused with Vikings' Justin Jefferson"; within one segment such a contrast
  picks no one); an inline tag inside a label breaks it ("Vikings<b> WR</b> Justin Jefferson"); and a
  newline a feed writes inside a field is kept as a break (CBS's padding around a field is not one).

### R8-6 fix round 3 — the first under R8-7 (commits `93f8843`, `a35e5fe`)

The independent attack on `66bb2a2` (its docs) found 11 violations. Ruling R8-7 (§R8, `c2a631d`)
bounds what R8-6's scan and labels must read: (1) the lists, complete per team in named categories;
(2) the case of an abbreviation that is an ordinary word; (3) one set of forms for the scan and the
labels; (4) a surname's label and count; (5) a spelled suffix. Each violation is fixed at its root as
R8-7 settles it, in `src/sources/news/labels.ts`, `positions.ts` and `match.ts`. Names one universe
player holds still take `f41e810`'s path: no difference over the 142 fixture items, the generated
corpus or the earlier batteries.

- **Violation 1, a surname's label (R8-7 (4))** · `match.ts`. A surname written alone that a full name
  in the item ends with is a mention of that name, and its label is the name's label. So labels that
  fit different holders pick none: "Chiefs DT Harris: Placed on IR | Harris is no relation to Titans
  CB Marcus Harris." gets no ref and is counted (the Titans CB at 0.95 at `66bb2a2`). So do the eight
  star-to-namesake variants the attack named. The recall rows give the labelled holder ("Justin
  Jefferson: Questionable | Vikings WR Jefferson (hamstring) …" is the WR's at 0.95; no ref at
  `66bb2a2`). The one-segment guard reads surname mentions too. A surname alone written before a
  labelled mention in its segment may be the other holder, so no label picks ("Justin Jefferson:
  Catches TD | Jefferson beat Browns LB Jefferson, his namesake, deep."). One written after a labelled
  mention refers back to him ("Vikings WR Justin Jefferson … Jefferson is expected to play"). A
  labelled surname that two full names in the item end with may belong to either name, so neither
  name takes its label.
- **Violation 2, a spelled suffix (R8-7 (5))** · `match.ts`. A written suffix excludes every holder
  ESPN spells otherwise (one no holder carries excludes them all). It narrows the holders a label can
  fit and never makes the spelled holder take the residual. The residual goes only to the name's
  prominent holder, and only when no spelling excludes him. "Byron Murphy II: Ruled out for Sunday |
  …", "Michael Carter II: Questionable", "DJ Turner II", "Chris Smith II" and "Tony Brown II" get no
  ref and are counted (each the spelled holder at 0.80 at `66bb2a2`). So do the four items where a
  suffix on another occurrence re-spelled the subject. "Seahawks DT Byron Murphy II" still picks his
  holder.
- **Violation 3, a bare shared surname's label in every form (R8-7 (4))** · `match.ts`,
  `labels.ts` `formBefore`, `inForm`. The first-name gate asks the label reader whether a form stands
  right before the surname, possessive cut. So "MIN's Jefferson", "LA's Young", "Pack's Johnson",
  "Cincy's Taylor", "Los Angeles' Young" and "New York's Wilson" are labels, and so is a two-word
  position in title case ("Chiefs Defensive Tackle Jones"). A capitalised word after a shared surname
  no longer drops it ("Rams DE Young Records Two Sacks"). A surname that is also a team word reads its
  labels ("Jaguars WR Washington"). Each was no ref and uncounted at `66bb2a2`. Three rules keep this
  fail-closed. A first name before the surname makes it another person's name: a capitalised word
  that is no lead word and no label word, or a one-word team form that may be a first name, written
  without a possessive ("Van Jefferson", "Bill Johnson", "Charlotte Jones"). So does a universe
  surname or a full name right after it ("Eagles' Lane Johnson", "Burns Denzel Ward"), and so does a
  form of several words it stands in ("Allen Park", "Gang Green", "Ralph Wilson"). A team word with
  no label is the team. A team it names right after it is the team's own name ("Washington
  Commanders:").
- **Violation 4, dotted abbreviations (R8-7 (3))** · `labels.ts`. An initialism's period is part of
  the word in the label reader, before the name and in a tag. So "L.A.'s Byron Young", "Byron Young
  (L.A.)", "Byron Young, L.A.:", "K.C.'s Chris Jones" and "L.A. DE Byron Young" give `full_name_team`
  (no ref, or 0.80, at `66bb2a2`).
- **Violation 5, the unlabelled surname (R8-7 (4))** · `match.ts`. A shared surname that no label
  picks is counted, beside other refs too ("Jordan Addison: Two TDs | Addison and Jefferson combined
  for 200 yards." is Addison's with `unresolved` 1). The news build counts it.
- **Violations 6, 7, 9 and 10, the lists (R8-7 (1))** · `labels.ts`, `positions.ts`. The triage's
  `scan.out` finds 82 of its 83 forms now: the towns, facilities and stadiums, the nicknames, fans'
  names, city names and state abbreviations, and the alignment words and spaced position forms. The
  one left is "Wash." alone in title case. It is listed, but its lower case is an ordinary word, so
  R8-7 (2) counts it only in capitals ("WASH.") or after a game or move word ("to Wash.").
- **Violation 8, ordinary-word abbreviations (R8-7 (2))** · `labels.ts`. "vs. Sea", "by Den", "@
  Min", "for Pit", "at Will" and "Traded to Ten" take the residual away. "Jackson was limited", "No
  timetable" and "He will play" keep it.
- **Violation 11, the closing tag** · `tests/sources/news/match-r86.test.ts`, `match-r87.test.ts`. A
  closing tag alone ("Vikings</p>Justin Jefferson") is a break the tests hold. Deleting `TAG_RE`'s
  closing alternative fails them.

What each clause of R8-7 built:

- **(1) Complete lists.** Each team's forms in every category the ruling names. `TEAM_CITIES` (77)
  holds the city or state, its short names and nicknames, and New Jersey. `TEAM_STADIUMS` (56) holds
  the current stadium by every name since 2015, by the words a writer keeps ("Lincoln Financial",
  "the Linc", "US Bank", "Bank of America", "M&T Bank"), and some former homes. `TEAM_FACILITIES` (91)
  holds the training facility, its town and the camp town. `TEAM_HASHTAGS` (15) holds the official
  hashtags no other form finds. `TEAM_FAN_NAMES` (41) holds every form an attack has reported, and
  more. `TEAM_LEGACY_NAMES` (8). `TEAM_SHORT_NAMES` (18) adds "Jints", "Brownies", "Stillers",
  "Commies", "Donkeys" and "Bungles". `TEAM_ABBREVIATIONS` (58) adds PFR's franchise codes CRD, RAV,
  HTX, CLT, OTI and RAI. `TEAM_LEGACY_ABBREVIATIONS` (8) adds PHO and BOS. `TEAM_STATE_ABBREVIATIONS`
  (35) holds each home state's postal and AP abbreviations, and D.C. Louisiana's "LA" and "La." read
  as the Rams' LA, and New York's "NY" as either New York team: one form, one reading. Dotted forms
  hold by rule ("N.O.", "C.L.E."). Each word form is read in each spelling: its words joined by a
  space, a hyphen or nothing, each join chosen apart, with its possessive "'s" written or not. A
  spaced spelling never opens with "a" ("A-Town"). Positions: `POSITION_ABBREVIATIONS` (58; G, IOL and
  SAF new) and `POSITION_WORDS` (83). Each compound is listed with a space at its joins ("half back",
  "line backer", "d line", "weak side", "strong side") and read glued, hyphenated or spaced, singular
  or plural. The scan reads forms of up to four words in a row, a period allowed inside one ("St.
  Louis", "U.S. Bank"), and runs of three or four parts inside one hyphenated word. It finds the forms
  inside a compound through a trie. A test table holds each of the 32 teams in all nine categories.
- **(2) Ordinary-word abbreviations.** `ORDINARY_WORD_ABBREVIATIONS` (47: the teams', the states' and
  the positions', EDGE and LT among them) replaces `CAPS_ONLY_ABBREVIATIONS`,
  `CAPS_ONLY_POSITION_ABBREVIATIONS` and `HEADLINE_ORDINARY_WORDS`. Such a form counts in capitals
  outside a segment written all in capitals, and in any case right after a `GAME_MOVE_WORDS` word (14:
  "vs", "vs.", "v.", "@", "at", "against", "by", "from", "for", "to", "with", "visits", "hosts",
  "faces"). Every other abbreviation counts in any case ("lb", "ne", "cle", "minn"), and so does every
  dotted one.
- **(3) One set of forms.** The label reader and the scan share `formAt`, so every form the scan
  reads labels a name where (a) places a label: a place, a stadium, a singular, a fans' name, a
  hashtag after "#", a state abbreviation, a plural or ranked position. The scan-only lists are folded
  into the label lists. Each position form has the ids of the players it may describe, wide rather
  than narrow: "tackle" the defensive line, "returner" a back, receiver or defensive back, and an
  offensive-line form or "snapper" no one. So "Nashville's Marcus Harris" is the Titans CB at 0.95,
  and "Vikings pass-catcher Justin Jefferson" the WR. The rules that take a label away read every
  form. An ordinary-word form (`AMBIGUOUS_LABEL_WORDS`, 13, and every ordinary-word abbreviation)
  right after a `LABEL_BLOCKERS` word or a game or move word labels no one ("at WILL Justin
  Jefferson"). `LABEL_BLOCKERS` (46) loses the eight words `GAME_MOVE_WORDS` holds.
- **(4) Surnames** and **(5) spelled suffixes**: violations 1, 3, 5 and 2 above.
- **Also** · the unused exports went (`labelPartsNextTo`, `namesTeamOrPosition`, `isLabelForm`,
  `labelTeams`, `breakOffsets`, `foldText`, `isCaps`, `positionFound`, `positionLabelIds`). So did the
  scan-only and caps-only lists, and four hashtags another form finds (`OnePride`, `DUUUVAL`,
  `BirdGang`, `RuleTheJungle`). "Hollywood" stays out: it is a player's nickname, "Hollywood Brown",
  and as a label it would pick a Brown. The `CONFUSABLES` and `APOSTROPHES` comments say what the
  lists hold.
- **Tests** · `tests/sources/news/match-r87.test.ts` (25) holds each violation with the variants the
  attack named, each clause, the 32-team table, and three fast-check properties. One property is
  R8-7 (2)'s case rule, one any one-team form labelling with a possessive, and one a team's
  possessive before a shared surname. `tests/sources/news/forms.ts` writes every list once for the
  tests. `match-r86.test.ts` (43) iterates it, so each entry is held word for word and entry by entry:
  found in every case and spelling, and a label to its team or ids. Its two properties write every
  list's forms, dotted abbreviations included. The news suite has 226 tests (202 at `66bb2a2`). Of
  `match-r87.test.ts`'s 25, 20 fail at `66bb2a2` on refs or counts. The five that pass are controls or
  guards: the out-of-category residual, the anaphora rule, a label among the spelled holders, the
  possessive property, and the closing tag, which the mutation holds. A mutation run deleted each of
  the 854 list entries in turn in a copy of the modules and compared the texts its entry-by-entry
  tests derive. The first run's 13 survivors were redundant entries and went: "@" was read by hand,
  eight `LABEL_BLOCKERS` words were also game words, "3 technique" was a technique by rule, and
  "center", "centre" and "guard" as ambiguous words could change no outcome. The rerun had none. 84
  code mutants (character classes, regex alternatives, and each rule this round added) ran against
  the news suite, and two more for the surname-after rule added since. Five of the first run's six
  survivors gained tests or went (a redundant clause); the rerun kills them. The one kept is
  `headNear`, a speed pre-check that by design never changes a result. Unique names still equal the
  frozen `f41e810` oracle.
- **Expectations R8-7 changed** (each commented where it stands; none moves to another holder).
  "LAMAR JACKSON: NO TIMETABLE FOR RETURN", "The edge was released" and "Will Justin Jefferson play
  Sunday?" keep the residual (R8-7 (2)). "Jefferson: Catches TD" and "Jackson: Limited" are counted
  (R8-7 (4), the `match-r86.test.ts` pin at 66bb2a2's line 520). The spelled holders' residuals go
  (R8-7 (5)): seven `match-r86-cases.test.ts` rows, `match-universe.test.ts`' suffix test, and "Lamar
  Jackson Jr.", which excludes both holders. Lower-case "lb", plural "QBs" and "receivers", and
  "pass-catcher" label their holder (R8-7 (2), (3)). The closed-list tests are rewritten: every form
  labels, the case rule is the ordinary-word list, and three-letter ordinary abbreviations in a
  lower-case hashtag are not found.
- **Measured** · the gate's four batteries are unchanged from `66bb2a2`: battery 1 has 19 right refs,
  33 recall losses and no misattribution, battery 2 its five accepted residuals, and batteries 3 and
  4 no ref. At `93f8843` one long hyphenated or dotted word cost 14 times a benign near-cap item,
  because the multi-word reading built every prefix and suffix of its parts. `a35e5fe` bounds them to
  the longest form and reads the game-word context only when an ordinary-word abbreviation asks; the
  results are unchanged. Speed against `66bb2a2`, at `a35e5fe`: the 5,000-item build takes 4.4 s
  (4.6 s; bound 15 s), and 1,000 of the last attack's capped items build in 1.5 s (1.4 s).
  `match.perf.test.ts` adds four capped items: a long hyphenated word, a long dotted word, a run of
  words that may each open a form, and a run of bare shared surnames. Each costs at most 6 times a
  benign item, and 1,000 of the costliest build in 3.6 s.
- **The recall cost** (refs to a shared name's holders; the batteries by their labels):
  - Over the earlier batteries' 1,167 labelled texts, 318 carry their right holder's ref (318 at
    `66bb2a2`, 424 at `f41e810`) and 3 a wrong one, the accepted residuals (3; 383). Against
    `66bb2a2`, 1 namesake ref is lost (a spelled suffix's) and 1 star ref gained; no wrong ref is
    added or removed. Against `f41e810`, 194 star and 30 namesake refs are lost and 4 star and 114
    namesake refs gained, while 380 wrong refs go.
  - Over the attack on `6ba7bb1`'s 289 battery texts, 61 carry their right holder's ref (68 at
    `66bb2a2`, 60 at `f41e810`) and 6 a wrong one, the readings below (6; 166). The 7 lost against
    `66bb2a2` are all spelled suffixes' residuals, as R8-7 (5) writes. Against `f41e810`, 29 star and
    8 namesake refs are lost and 2 star and 36 namesake refs gained, while 160 wrong refs go.
  - Over the attack on `66bb2a2`'s 187 misattribution-battery texts, 42 carry their right holder's
    ref (40; 47) and 24 a wrong one (83; 92). Against `66bb2a2`, 2 star refs are gained, none is
    lost, and 59 wrong refs go. The 24 left are the judge's rejected classes: the cross-segment
    contrasts, the namesakes of a labelled star, the lookalike letters and the apostrophe-like
    letters.
  - Over the 142 recorded fixture items, the refs equal `66bb2a2`'s, and unique names `f41e810`'s.
    The `unresolved` count rises from 2 to 8: bare shared surnames now counted ("Daniels set to
    practice in full", "Reid ranks the top 50 prospects …: Smith at No. 1?", in the capture and the
    labelled set).
- **Kept as accepted, or a reading for the re-gate** · the residual; the recall loss; choice 6; the
  judge's rejected classes. Readings:
  - R8-7 (2) as written. A "no" right after "with" or "at" counts ("Out with no timetable", "at No.
    1"), at a recall cost. So does an AP abbreviation that is an ordinary word: "Wash.", "Mass.",
    "Ill.", "Pa.", "Mo." and "La." count only in capitals or after a game or move word. Full state
    names other than the teams' homes and New Jersey are outside R8-7 (1) and are not listed ("Ohio",
    "Texas", "Florida").
  - The first-name rule. A singular, a city, a short name or a fans' name written without a
    possessive right before a bare surname is read as a first name. So is a surname followed by a
    universe surname. Both get no label and no count.
  - The order rule: a surname alone before a labelled mention contrasts, and one after it refers
    back.
  - The counting noise. A dateline or a draft writer's surname that a universe player shares is
    counted ("HENDERSON, Nev."), as a count only.

## Reviews (re-run on every version bump of the named dependency)

| date | dependency | verdict | evidence | open item |
|---|---|---|---|---|
| 2026-09-30 | `@napi-rs/keyring@2.1.0` (+ 12 platform packages) | **Safe — pin exact + lockfile integrity** | research 01 §30: no install scripts; loader only `require`s the platform package; SLSA v1 provenance from a GitHub-hosted runner (`CI.yml`, source commit `1635ed45…` = tag v2.1.0), re-verified by the orchestrator on npm's attestations endpoint; `npm audit` and OSV = 0; binary links only OS frameworks; MIT | plan 02 §7.2 item 5 (Keychain prompt count under Claude Desktop and under launchd) — a macOS runtime property, recorded here after the first `eff doctor` |
| 2026-10-25 | `@modelcontextprotocol/server@2.3.1` + `@modelcontextprotocol/core@2.3.1` (runtime) and `@modelcontextprotocol/client@2.3.1` (dev), from 2.2.0 (Stage C finding deps-mcp-sdk-advisory-2-3-1) | **Safe — pin exact + lockfile integrity** | **Why:** `npm audit --omit=dev --audit-level=high` failed CI from 2026-10-21 on GHSA-jm63-cq47-j5jp and GHSA-46jr-4wx8-v453 (high) and GHSA-rvq5-wwqv-78pq (server: HTTP transport, request-size validation, bearer auth), with GHSA-6prh-2h8m-c8cw (client: HTTP redirects) in the full report — all fixed in 2.3.0, none reachable over this server's stdio; 2.4.0 (published 2026-10-23) not taken. **Static diff** of the registry tarballs, 2.2.0 → 2.3.1: `core` — only `version` and `license` in `package.json`; `server` — the HTTP entries (a stateless transport serves one request; `createMcpHandler` refuses an instance still serving; the Origin allow-list's `<scheme>://*` form), bearer auth's `expectedResource`, `Server.connect` refusing a second transport, the opt-in `maxToolInputElements` cap (unset means no limit), the tool schemas' JSON conversion made lazy, a prompt's absent arguments validated as `{}`, the Tasks-extension gate for `tasks/get` and `tasks/cancel`; `stdio.mjs` unchanged; `client` — redirects followed only within the origin. No `preinstall`/`install`/`postinstall`, no new dependency (the client's `eventsource-parser` floor `^3.0.0` → `^3.0.8`, met by the locked 3.1.1), no new `fetch`, `node:http`, process, `eval` or `new Function` call site, the same URL hosts in the code; the run-time exports unchanged, two type exports added (`McpServerOptions`, `VerifyBearerTokenOptions`). **Provenance:** SLSA v1 from `modelcontextprotocol/typescript-sdk` `.github/workflows/release.yml` on `main` at `fcef852f6cda…` (= tag `@modelcontextprotocol/server@2.3.1`, a "Version Packages" release commit on `main`), GitHub-hosted runner; `npm audit signatures`: registry signatures and attestations verified, none missing or invalid; each tarball's sha512 = the registry's `dist.integrity` = the attestation subject = the lockfile. **Licence:** the `license` field reads Apache-2.0 from 2.3.0 (MIT before); the LICENSE file — the MCP project's MIT → Apache-2.0 transition notice — is byte-identical to 2.2.0's; no NOTICE file; Apache-2.0 is on the plan 04 §4.1 allow-list; the SDK is installed from the registry, never bundled into this package. **Protocol:** the SDK's `docs/protocol-versions.md`, re-read at both release commits, gained one paragraph (an HTTP client's probe); `serveStdio` still serves both eras (plan 01 A-5 holds). **Gate:** the runtime audit 0; `check:runtime-tree` (the same six names), `check:licenses`, `check:no-scripts`; `tsc --noEmit`; the unit suite with coverage, the process and end-to-end suites on the built server, and the SDK stdio smoke under both eras × `core`/`full`; A16a's `full` analytics loop stall on a quiet machine 26.8 / 31.0 ms, against 27.4 ms for the same source built on 2.2.0, and 12–37 ms per call against 14–44 ms (bound 50; two runs beside other CPU-heavy jobs read 68.9 and 111.1 ms); `tests/lint/dependency-review.test.ts` holds the advisory ranges and this row offline | — (closed in Stage C, finding status-sdk-version-stale: `SDK_VERSION` in `src/mcp/tools/ops.ts` reads 2.3.1, and `tests/mcp/sdk-version.test.ts` holds it equal to the pin, the lockfile and the installed package) |
| 2026-10-25 | `zod@4.6.7` (runtime; the one zod in the tree), from 4.6.5 (the same finding) | **Safe — pin exact + lockfile integrity** | **Why:** GHSA-mrhx-c7xc-m3w5 (high; its database entry updated 2026-10-23 — the CI audit of 2026-10-22 did not list it, the local one of 2026-10-25 failed the runtime gate on it): up to 4.6.5 an over-long array, map or set was parsed element by element, an issue kept per failing element, before its size check failed — memory exhaustion; fixed in 4.6.6. Every tool, resource and prompt argument this server takes is validated by zod, and its input arrays carry a `.max` bound before any refinement (`src/mcp/bounds.ts`; the stdin line cap is 10 MiB) — the case the fix gates. **Static diff** 4.6.5 → 4.6.6: `capSize` (classic parser) and `generateSizeGate` (compiled parser) fail a container over its leading `.max`/`.length`/`.size` check before any element is parsed, reporting that one issue; `util.sizeCaps`; a type-only reshaping of `$ZodRecordInternals`; tests. 4.6.6 → 4.6.7: only the version constant and `package.json` `version`. No dependency, no install hook (`prepublishOnly` and `postbuild` never run on install), MIT. **Provenance:** SLSA v1 from `colinhacks/zod` `.github/workflows/release.yml` on `main` at `b500a2ee9513…` (= tag `v4.6.7`), GitHub-hosted runner; `npm audit signatures` verified; sha512 = registry = attestation subject = lockfile. 4.6.7 is what the SDK's `^4.2.0` resolves (plan 04 §2). **Gate:** as the SDK row | — |

