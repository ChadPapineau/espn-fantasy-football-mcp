# plan-reviser — working notes (adversarial round 1 edits)

Brief: `docs/scratch/briefs/plan-reviser.md`. Role: apply the orchestrator's
round-1 rulings (`docs/plan/adversarial-log.md` §1.D–§1.F) to `docs/plan/01-*`
… `10-*`, resolve plan 10 §4, write `docs/plan/changelog.md` §R1, run the
retired-phrase grep, and make the two permitted `docs/HANDOFF.md` edits.
No new design decisions.

## RESUME HERE

Status legend: `pending` · `applied (file §)` · `note only` · `already done`.

### Objections
- OBJ-01 — applied (plan 10 §3.1a Fixtures, A1a, A-1, §5 D0/D2; plan 09 §4 tree, §5.2, A-2; plan 05 §3.1, §2 domain/scoring; plan 08 §6 steps 1, 6)
- OBJ-02 — applied (plan 07 E1 output/method/DWAC; plan 10 A11a, B14; plan 01 D15)
- OBJ-03 — applied (plan 07 E5 output/method, E7 verdict; plan 09 §3.8 output/guardrails/WV-1, §3.2 WK-1; plan 10 A9a, A12b)
- OBJ-04 — applied (plan 06 §1.4 credential check + closing para + snapshot roster, §3; plan 02 §2.1 diagram/table, S3; plan 01 §4.3, §8; plan 03 §6, §5 #6; plan 07 G1; plan 10 A2b)
- OBJ-05 — applied (plan 06 §2 + A-2; plan 02 §2.2 row, friction para, §8 #21, A-1; plan 03 §2.1 step 4, §5 #6, §8 step 2)
- OBJ-06 — applied (plan 03 §3 key, §5 #15; plan 02 S12, §5, §7.1; plan 01 §4.3 row, §7 host row + recovery para; plan 09 §2 orient, §3.7)
- OBJ-07 — applied (plan 01 §1.1 Domain; plan 03 §1.2; plan 10 A16a, A-2; plan 07 E1/E3 n_sims)
- OBJ-08 — applied (plan 07 C3 row, §2 Toolset, C3/E3/E14 headers, E2 data, §5.1, A-4; plan 10 Ph1, §1, §3.1a Analytics/Tools, A3a, A7a, A10a, 1b Tools, §3.2, B10, B12, D3)
- OBJ-09 — applied ((a) plan 01 D6, §1 diagram, §5.1, §5.5; plan 02 §8 #8; plan 03 L7, §1.1, §7; plan 05 store row; plan 06 J3, §2; plan 10 A5a, A15a · (b) plan 01 §4.1; plan 02 §6.3; plan 05 §5; plan 07 legend, C10, §5.1, A-4; plan 10 A3a, A7a, B12 · (c) plan 02 opening rule, §1, §4.2, §8 #14; plan 03 §5 #13; plan 09 §6 ×2; plan 10 §3.W (4), prereqs (a)(b), W10 · sibling citations: plans 07/09/10 headers)
- OBJ-10 — applied (plan 03 §4.1 runtime-install para + example paths, §4.2, §4.3, §5 #2, #24, #25, A-9, §7; plan 06 §2 runtime bullet; plan 05 cli/print-config)
- OBJ-11 — applied (plan 03 §4.1 doctor bullet, §5 #2, §7 upgrade path)
- OBJ-12 — applied (plan 09 §4 .mcp.json + bin/eff, §6 Code-tab row, K8; plan 04 §1 tree; plan 10 A15b; plan 03 §5 #2)
- OBJ-13 — applied (plan 07 C12, A1 inputs/output/method/views/clean negatives, C9, E2 inputs/objective, E3 inputs, §6 row 1, G1; plan 09 §3.1 tools/inputs/output, §3.3 inputs, §3.11 inputs/SP-5-E; plan 03 §3 key; plan 10 D1, B5)
- OBJ-14 — applied (plan 07 G2; plan 02 S2, §2.1 diagram/table; plan 03 §2.1 step 5, §5 #16/#17; plan 09 §3.7 ×3, §3.1 ON-5-E; plan 06 credential check; plan 10 D2)
- OBJ-15 — applied (plan 02 §2 facts, §2.1 format row, §2.3; plan 01 §8, §10; plan 03 §2.1 step 3; plan 05 auth/format, cli/log)
- OBJ-16 — applied (plan 06 §1.4 snapshot roster/pool, transactions append, pre-kickoff, budget line, §2 StartCalendarInterval; plan 03 §5 #11)
- OBJ-17 — applied (plan 09 §2 orient.md; plan 10 A16b)
- OBJ-18 — applied (plan 09 §2 P1 Step 0, §5.1 item 3; plan 10 D3, B10, B11)
- OBJ-19 — applied ((a) plan 02 header, S1, §7.2, §10; plan 01 D12; plan 04 §2 · (b) plan 04 §2 devDeps; plan 05 A-2; plan 09 §5.1 #3 · (c) plan 07 A6 · (d) plan 05 sources/*; plan 01 D9, §5.5 · (e) plan 08 §6 step 5 · (f) already done)
- OBJ-20 — applied (plan 01 §6 backoff + httpClient; plan 05 §4.1 two rows; plan 10 A5a)

### Tensions
- T-01 applied (plan 04 §1 tree, §2 files, §4.2 skills; plan 03 §4.2; plan 09 §4/K8) · T-02 applied (plan 04 §4.2; plan 03 §4.2; plan 07 §1) · T-03 applied (plan 03 §3; plan 01 §3.1; plan 07 §2) · T-04 applied (plan 01 §4.1 table; plan 02 §4.1; plan 07 §2/E12) · T-05 applied (plan 01 §4 intro; plan 05 §2 envelope; plan 07 C10) · T-06 applied (plan 01 §4.2; plan 07 §5.1) · T-07 applied (plan 01 §9.2; plan 06 §1.3/§1.4; plan 08 §9; plan 07 A4/E12/E13; plan 10 §3.1a) · T-08 applied (plan 03 §5 #21–23; plan 06 §1.4; plan 07 E9; plan 08 §6; plan 10 1b) · T-09 applied (with OBJ-09(c)) · T-10 applied (plan 05 T8, §1, §2, §7) · T-11 note only (plan 02 §5) · T-12 applied (plan 01 §4.4) · T-13 merged into T-03 (plan 01 §4.1/§5.6 examples; plan 07 C1/§1/A2/C2) · T-14 applied (plan 01 §7) · T-15 (a) plan 01 D2, plan 03 §4.1/§5 #1/§4.3, plan 04 R2/R5/§1/§2/§4.1, plan 06 §1.1 · (b) plan 03 §7/L7, plan 05 store, plan 06 backup · (c) replaced by OBJ-09(a) · (d) plan 04 §4.2 · (e) plan 04 §5/A-3 · T-16 already done · §1.5 probe coverage applied (plan 01 §7)

### Other tasks
- Plan 10 §4 resolved table — applied (plan 10 §4: five columns, "Resolution applied" names file §; T-11 note only; T-13 → T-03; T-16 already done)
- `docs/plan/changelog.md` §R1 — applied (numbers table, 20 objection rows, 16 tension rows, survived-unchanged list, narrow readings)
- Consistency grep (retired phrases / old numbers) — done: all retired phrases 0 hits over plans 01–10 + changelog (adversarial-log.md excluded — not mine to edit); survivors fixed: plan 10 A11b label, Ph8, §3.0, §3.1b scope/deferred list, D10, §2 ledger, A-7; plan 07 C3 table name; plan 01 §10, D6; plan 02 S9, §8 #5/#9; plan 03 §2.1 flags, §2.2; plan 04 R2, §1; plan 05 §3.1; plan 06 J3
- Mermaid manual parse pass — done: touched blocks = plan 01 §1 (one quoted node label) and plan 02 §2.1 (four transition labels); both pass; other blocks untouched
- `docs/HANDOFF.md` item 2 + "Things Chad needs to know / decide" — applied (item 2 → decision on the runtime-install location; items 10 (D2) and 11 (D0) added; nothing else touched)

### Notes / ambiguities resolved narrowly
- OBJ-01: `record-fixture.ts --public` (existing script, standalone in Phase 0) instead of a second `record-fixtures.ts`
- OBJ-07: `N_SIMS_MAX` constant, value set on first measurement
- OBJ-09(a): "plan 10 A4a" read as A5a (store rows) + A15a
- OBJ-09(c): "plan 02 §8 #2/#5" read as the forgeability sentences (opening rule, §1, §4.2, §8 #14)
- OBJ-13: onboard gets the Y−1 evidence via opt-in `include: ["seeding_evidence"]` on A1
- OBJ-16: waiver-relative jobs use the same fixed-cadence self-selecting pattern as kickoff-relative ones
- T-15(a): CI matrix → Node 24 only
- Not applied: defence §1.F item 1 (separate acceptance row for the D0-not-accepted product) — a suggestion, not a §1.E edit
- Not mine to fix: HANDOFF finding 4 ("verdict pending"), item 10 ("21 P0 tools"), finding 7 ("ensemble") are stale but outside the two permitted HANDOFF edits

### Pushed SHAs
- f1d2003 — resume file
- 18d6e32 — OBJ-01..04
- d419983 — OBJ-05..08
- 3e8b675 — OBJ-09
- 22e80ef — OBJ-10..14
- 5973653 — OBJ-15..20 + tensions T-01..T-15
- e95f4de — plan 10 §4 resolved table
- 896a4db — changelog §R1
- 8a96156 — consistency pass
- 488b2da — HANDOFF edits (item 2; items 10–11)

**STATE: ALL TASKS DONE (2026-09-30).** Nothing pending; no WIP patch exists; tree clean. Round 2 can start from `origin/main`.

---

## RESUME HERE — Round 2 (rulings: adversarial-log.md §2.D–§2.F; started from `07e4b37`)

Status legend as above.

### Objections
- OBJ-21 — applied (plan 10 §3.1a Fixtures, A1a, A14a, §6 A-1; plan 09 §4 tree ×2, §3.1 ON-3, §5.1 #7, §5.2, §7 A-2; plan 05 §3 fixture-law box, §3.1 steps 1/2/4, §2 domain/scoring, §5 smoke dir; plan 08 §6 step 1; plan 01 §9.1; plan 04 §1, §4.1 smoke dir)
- OBJ-22 — applied (plan 01 D6, §1 diagram node, §5.1, §5.5 new paragraph, §14 A-13; plan 03 §1.1 step 3; plan 05 §2 store row; plan 06 §1.3 intro + store prune; plan 10 §4 T-15)
- OBJ-23 — applied (plan 09 §4 tree, §6 Code-tab row, K8; plan 04 §1 tree, §2 files; plan 03 §4.2, §5 #2; plan 10 §4 T-01, A15b)
- OBJ-24 (instructions delivery [U], nonce in A11b spike, rule also in docs resource, fallback short form, pointer ≤ 40) — pending
- OBJ-25 (throwaway item, 10 s timeout, ok/timeout/error, recorded + doctor #7) — pending
- OBJ-26 (anonymous control request; accepted: null when not discriminating) — pending

### Nits
- N1 8 s CPU deadline · N2 retro "not informative in v1" + shadow weights 0.5/0.75 · N3 marginal[] · N4 orient.md line · N5 hourly snapshot-pool wake · N6 host-override scope · N7 Z7 — applied (plan 10 §3.0 Z7 + exit gate, §1 row 0) · N8 E2 wording · N9 wireOutputSchema lever · N10 bounds name their dataset — all pending

### Other tasks
- changelog §R2 — pending
- consistency grep (R2 phrases + R1 list re-check) — pending
- Mermaid manual pass on touched blocks — pending
- HANDOFF: one item (SQLite 10-attachment limit applies to the sibling's layout) — pending

### R2 narrow readings
- OBJ-21: the two Inspector-smoke invocations (plan 04 §4.1, plan 05 §5) pointed at bare `fixtures/espn`; with two classes I pointed them at `fixtures/espn/fx-10h` (the dir plan 09 already uses for fixture mode)
- OBJ-22: the ruling puts the readOnly [A] in "plan 01 §13"; §13 is "What this plan does not decide" — the assumptions table is §14, so it is A-13 there
- OBJ-22: dataset files are now `datasets/<source>.sqlite` (rename onto the same path); the version lives in `refresh_log`, not the file name
- OBJ-23: plan 04 §2 `files` drops `bin` and lists `scripts/eff-launch.sh` so a tarball install is still a plugin root

### R2 pushed SHAs
- 89debff — R2 resume checklist
- 3c18e09 — OBJ-21 + Z7
