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

## Reviews (re-run on every version bump of the named dependency)

| date | dependency | verdict | evidence | open item |
|---|---|---|---|---|
| 2026-09-30 | `@napi-rs/keyring@2.1.0` (+ 12 platform packages) | **Safe — pin exact + lockfile integrity** | research 01 §30: no install scripts; loader only `require`s the platform package; SLSA v1 provenance from a GitHub-hosted runner (`CI.yml`, source commit `1635ed45…` = tag v2.1.0), re-verified by the orchestrator on npm's attestations endpoint; `npm audit` and OSV = 0; binary links only OS frameworks; MIT | plan 02 §7.2 item 5 (Keychain prompt count under Claude Desktop and under launchd) — a macOS runtime property, recorded here after the first `eff doctor` |

