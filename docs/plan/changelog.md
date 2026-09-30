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
- **OBJ-26** — on a public league whose board probe does not discriminate, setup keeps the value and the state stays `stored`; the daily `credential check` then yields `accepted: null` and changes no state.
- **Nit 2** — E13's output shape is unchanged; "not informative in v1" is what `retro` says (a guardrail in plan 09 §3.5), noted in E13's method.
- **Nit 10** — the 500 ms bound names `fx-10h` in fixture mode and "the process test"; no test file name was invented.

## Reviews (re-run on every version bump of the named dependency)

| date | dependency | verdict | evidence | open item |
|---|---|---|---|---|
| 2026-09-30 | `@napi-rs/keyring@2.1.0` (+ 12 platform packages) | **Safe — pin exact + lockfile integrity** | research 01 §30: no install scripts; loader only `require`s the platform package; SLSA v1 provenance from a GitHub-hosted runner (`CI.yml`, source commit `1635ed45…` = tag v2.1.0), re-verified by the orchestrator on npm's attestations endpoint; `npm audit` and OSV = 0; binary links only OS frameworks; MIT | plan 02 §7.2 item 5 (Keychain prompt count under Claude Desktop and under launchd) — a macOS runtime property, recorded here after the first `eff doctor` |

