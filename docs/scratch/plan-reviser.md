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
- Plan 10 §4 resolved table — pending
- `docs/plan/changelog.md` §R1 — pending
- Consistency grep (retired phrases / old numbers) — pending
- Mermaid manual parse pass — pending
- `docs/HANDOFF.md` item 2 + "Things Chad needs to know / decide" — pending

### Notes / ambiguities resolved narrowly
(none yet)

### Pushed SHAs
- f1d2003 — resume file
- 18d6e32 — OBJ-01..04
- d419983 — OBJ-05..08
- 3e8b675 — OBJ-09
- 22e80ef — OBJ-10..14
