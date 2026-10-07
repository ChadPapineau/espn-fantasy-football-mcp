# Phase 2 acceptance — B1–B15, item by item

Scope: plan 10 §3.2's acceptance list, as it stood when Stage B2's integration closed (2026-10-06,
branch `build/phase-1`), updated after the B2a gate's rounds 1–3 (2026-10-07; the last three sections). Every row names its status and where the evidence lives. **met** = the
criterion holds and a test in CI holds it; **soft_reported** = the plan's soft number is reported
(its hard parts are met); **needs_live** = it can only be shown against the live league or a live
model run; **needs_time** = it needs weeks of data that do not exist yet. Exit gate (plan 10 §3.2):
hard B1–B2, B7–B13, B15 and the hard parts of B3–B6; reported: the soft parts of B3–B6, and B14.

The whole product end to end: [`tests/e2e/stdio-full.test.ts`](../../tests/e2e/stdio-full.test.ts)
spawns the built server in fixture mode on `fx-10h`, its cache seeded first with every
fixture-backed dataset source of `full` through the real runner and publisher, lists the 34 read
tools in registry order and calls every one; [`tests/e2e/skills-dry-run.test.ts`](../../tests/e2e/skills-dry-run.test.ts)
replays every Skill's `core` and `full` tool sequences the same way;
[`tests/e2e/latency.test.ts`](../../tests/e2e/latency.test.ts) holds the latency and stall bounds.

| Item | Status | Evidence |
|---|---|---|
| **B1** sources load through `eff refresh`; a renamed column fails naming it; `eff status` shows licence and age; off-season < 2 s, exit 0 | met | `tests/sources/nflverse/phase2-*.test.ts`, `tests/sources/{ffopportunity,sleeper,news}/`, `tests/cli/refresh.test.ts` (the off-season test now covers the history twins, gated on the current season), `tests/cli/store-commands.test.ts` (`eff status`: each source's licence and age). The allow-list carries the four feed hosts; the first real `eff refresh all` is the owner's |
| **B2** usage trailing summaries for ≥ 95 % of rostered players; `routes_proxy` present and labelled; `xfp_gap` non-null wherever ffopportunity has the player | met for the rostered players D1 models (QB/RB/WR/TE/K) · **ruling requested** on the denominator | [`tests/integration/b2-usage-coverage.test.ts`](../../tests/integration/b2-usage-coverage.test.ts) and the stdio leg in `stdio-full`: on the seeded `fx-10h`, every team, **131 of 134** rostered QB/RB/WR/TE/K (97.8 %) carry a trailing window (the skill positions alone also ≥ 95 %); over **all 145** rostered entries it is 131/145 = **90.3 %**, because the 11 rostered D/ST have no player row in any usage source (D1: "no usage model for D/ST") — the all-rostered share is capped at 134/145 = 92.4 % by construction, so B2's "≥ 95 % of rostered players" cannot hold literally on any league with a rostered D/ST. The three uncovered players have no 2026 game in weeks 1–3. The seed now carries [`fixtures/fx10h-usage/`](../../fixtures/fx10h-usage/ATTRIBUTION.md) (the usage rows of every fx-10h rostered QB/RB/WR/TE/K the shared excerpts lack, from the 2026-10-06 release files); before, the excerpts covered 23 of 145. `routes_proxy` is on every game row with the note "routes are a snap-share proxy (04 #3)" (a value where the pbp excerpt covers the team-week: team dropbacks); `xfp_gap` non-null on every game row ffopportunity covers (207 of 210 rows read) |
| **B3** waiver detection | soft_reported (hard met) | [`phase2-analytics.md`](phase2-analytics.md) §B3: the usage detector's precision is about half the points-only detector's at equal picks with the cold-start thresholds (Phase 3 tunes them); hard: numeric evidence on every signal, `percent_change` never a signal, `value_basis: ensemble` with the Π rule holding — at the tool level with signals present since gate round 2 (`tests/mcp/p1-tools.test.ts`, "B3 hard parts with signals present": on the recorded leagues E5's free-agent candidates carry no usage rows, so the earlier tool-level loops ran over empty `signals[]`) |
| **B4** demand model | soft_reported (hard met) | §B4 there: two runs on `fx-10h` are not evidence; `learned.second_claim_at_new_position` flips from null on a same-run-pair fixture |
| **B5** trade evaluator | soft_reported (hard met) | §B5 there: Δ-sign accuracy is not computable (no recorded trade on the fixtures) — measured on the live league as trades happen; hard: implied drop on every uneven trade, `fair` iff the interval spans 0, ΔU under the configured reading and under `both` on `seeding-unknown`, the deadline from `tradeSettings` |
| **B6** cascade | soft_reported (hard met) | §B6 there: the top-beneficiary hit rate does not yet beat next-man-up; hard: `hypothesis_only` rule, shares never above the vacated share, IR eligibility from the structured status only |
| **B7** replacement, schedule, roster | met, one VOR cell **pending ruling** | `tests/backtest/replacement.test.ts`: 2024 and 2025 baselines and 35 of 36 VOR cells within 0.3 ppg under the shipped (league) score, flex splits 7/3 and 4/6. 2024 TE rank 3 reads 3.593 against the table's 3.2: that TE's week-2 own fumble-recovery TD (ESPN stat 63, 6 points, scored by the reference league and by the engine) is not in nflverse's `fantasy_points`, the line research 05's `qb_vor.py` scored — 6 points over 15 games is the 0.4. On research 05's own basis (`researchBasis`: a return TD counted, an own-recovery TD not) **every** cell of both seasons is within 0.3 (this one 3.193); the shipped-score cell stays pinned at its measured value until the orchestrator rules (plan 10 B7 against the table as written). IR first on `ir-invalid`, the hidden-bench play's three risks, `qb_bench == 0` only at `streamability.QB ≥ 0.9` |
| **B8** evidence and news | met | `stdio-full`: on all six injected-text variants no planted string appears outside an `untrusted_text` wrapper or a `meta.untrusted_fields[]` path in any of the 34 tools' outputs (warnings and meta included), with a positive control on every variant (the trade-block note through A2 since gate round 3); `structured_disagrees` names `injury_status` on `inj-ir-cleared`; `calibration_state.note` on every E10 result; `rules_v1` precision 1.00 on 71 labelled real items (65 in-sample, 6 held out; 16 claims, all correct — `tests/domain/evidence/labelled.test.ts`, [`fixtures/news/labelled/README.md`](../../fixtures/news/labelled/README.md)) |
| **B9** live and fitted season | met | `tests/mcp/p1-fx10h.test.ts`, `tests/domain/analytics/matchup.test.ts`: final/live/pending on `sunday-live`, no locked seat actionable; on a cold cache the box score is read first and a live call without its live facts conditions nothing (`live: null`, `partial`; gate round 3); `start-sit`'s live branch in the `full` dry run; the fitted season within 0.05 of the cold start for my team (0.982 vs 0.952) |
| **B10** Inspector smoke | met | `npm run smoke` and the CI Inspector step under both toolsets: 18 / 34 tools in order, no write tool, 8 / 13 prompts; every P1 Skill's Step 0 under `core` names `EFF_TOOLSET=full` (`check:skills`, the `-CORE` cases) |
| **B11** Skills | met (Lane 1) · needs_live (Lane 2 — owner's action) | Lane 1 for all 13 (`check:skills`, the collision check across 13, the stdio dry runs under `core` and `full`). Lane 2 (the WV-2/TR-*/IC-*/SP-*/RA-*/NC-*/-INJ cases) is a `claude plugin eval` run: agent runs plus `llm` graders that cost tokens, and its report is published to claude.ai by default — the owner's call, not a build agent's. The suite is generated and dataset-seeded: `npm run build && npm run build:plugin-evals -- --seed --seed-datasets` (274 cases, 32 eval plugins) |
| **B12** token sizes | met | `tests/mcp/size.test.ts`: `full` `tools/list` 32 999 ≤ 35 000; compact/full ≈ 0.98 recorded; plan 07 §5.1 updated; D3 re-decided (`core` stays the default) |
| **B13** engine families | met, as scoped by D8 | [`phase2-engine-families.md`](phase2-engine-families.md): `long_td_bonus` verified on a recorded league, `per_n_yards` for the divisors a recorded league scores, the D/ST points-allowed derivation pinned 70/70; under D8 (no extra fixture league) stat 74 (`fg_50p_legacy`) stays `verified: false` |
| **B14** prospective projection backtest | needs_time | ≥ 8 weeks of `espn_projection` snapshots |
| **B15** plugin eval suite | needs_live (owner's action) | generated from every Skill's `evals.json` (`scripts/skills/build-plugin-evals.mjs`), servers in fixture mode on `fx-10h`, dataset-seeded with `--seed-datasets` (the seed now includes `fixtures/fx10h-usage/`); the free graders run inside the same `claude plugin eval` run as Lane 2 (above), which costs tokens and publishes by default, so it was not run by the build |

## Gate round 1 (2026-10-07) — what the fixer changed

- **A season run cut short is said.** E2's PF exchange rate, E6's ΔU, E8's P(alive) and E9's season read now carry the seeding simulator's `partial` and its "partial: k of n paths before the CPU deadline" line into the envelope (`tests/mcp/cpu-deadline.test.ts`); no cache holds a season run.
- **The CPU deadline counts CPU.** The cooperative runner counts the thread's CPU (`process.threadCpuUsage`) instead of the batches' wall time, so a sleeping or loaded machine no longer cuts a healthy call short; batch length (the stall) is still wall time. The A8a invariance and P12 determinism comparisons run with the deadline off, as the plan says.
- **The A16a stall bound has headroom.** The derived fixture fetch and the cached-body parse yield between their phases; a batch ends before a chunk predicted to overrun it. Per-call worst stalls on this Mac 48 → 26 ms; the latency suite's P1 maximum 25–28 ms over three runs (was 30–64).
- **The local coverage gate reproduces.** The unit project runs `maxWorkers: "50%"` (6 forks here, 2 on a 4-vCPU runner): `npm run test:coverage` at the default parallelism passed in 218 s with no timeout.
- **The injury-cascade sequences price only the available beneficiaries.** With the fx-10h usage rows the cascade now names beneficiaries, and the Lane 1 sequence passed every one to `espn_analyze_waivers` — rostered ones included, against SKILL.md step 5 ("the available beneficiaries' `player_id`s"), so a roster of only rostered beneficiaries was a NOT_FOUND. `$ids` takes `where` (`{ "status": ["FREEAGENT", "WAIVERS"] }`), checked by `check:skills` and documented in `skills/README.md`.
- **A latent overflow fixed.** fast-check found `toStatLine` passing a ±Infinity sum of two finite FG-miss buckets; overflowed sums are now dropped and reported.


## Gate round 2 (2026-10-07) — what the fixer changed, and what stays open

The gate found no code defect; it reported three hard items it could not show met as written
(B2's denominator, B7's one cell, B11 Lane 2 / B15) and four soft ones. The soft ones were fixed at
their root where a fix exists:

- **Stall headroom (A16a).** A CPU profile of the built server on the seeded `fx-10h`, aligned with
  a 1 ms gap probe, located the long turns. (1) `runCooperative` paced the next chunk from the last
  chunk alone, so cheap steps ran up to the budget and then a heavy one (the trade partner search's
  first package per team, whose roster is not yet memoised): 25–32 ms turns. The prediction now
  takes the larger of the last pace and the longest chunk timed so far in the run, so a batch passes
  the budget only on a chunk longer than every chunk before it (`tests/domain/analytics/kernels.test.ts`:
  a fast-check property and the trade-shaped case; both fail on the old pacing). (2)
  `COOPERATIVE.batchMs` 16 → 12 ms (plan 03 §1.2 allows ≤ 20). (3) D5 `espn_get_defense_profile` read and
  scored its whole window (every NFL rostered player × 10 weeks by default) as one macrotask:
  40–55 ms on `fx-10h`, far more on a live mid-season window — a plan 03 §1.2 breach the suite did
  not measure. It now reads one statement per week, each scored in its own turn, re-sorted to the
  single statement's order (the numbers cannot move; tested), with a re-read as one statement if a
  publish lands between two weeks; D6 extracts claims five items per turn. (4) `latency.test.ts`
  now also holds the warm P1 reads to the 50 ms bound. Measured after the fix (process suite on
  this Mac): `core` analytics 17.1 ms, `full` analytics 28 ms, warm P1 reads 17.1 ms (the gate's
  run: 44.8 ms; the scratch probe over three rounds per call: 22–29 ms, D5 22–33 ms cold).
- **B3 at the tool level.** A positive control (`tests/mcp/p1-tools.test.ts`, "B3 hard parts with
  signals present") gives E5's candidates a crosswalk pair and per-week rows through the dataset
  ports and requires `xfp_gap` (and `snap_jump` when four weeks are read, as on league-a) to fire,
  then checks every candidate's signals
  (finite value, finite numeric evidence, never `percent_change`, which stays in `demand`). On the
  recorded leagues themselves the free-agent candidates still have no usage rows — B3's numbers
  are the historical-season backtest's (`phase2-analytics.md`), not `fx-10h`'s.
- **The supplement's UUIDs.** `fixtures/fx10h-usage/ATTRIBUTION.md` carries the note
  `fixtures/nflverse/ATTRIBUTION.md` has: its 1,008 UUID-shaped values are nflverse's public player
  ids (`sportradar_id`, `smart_id`), never member GUIDs; `fx10h-usage.test.ts` holds the claim.

Open, for the orchestrator or the owner (no code change closes them):

- **B2's denominator** — 131/134 = 97.8 % of the rostered players D1 models; 131/145 = 90.3 % over
  every rostered entry, capped at 92.4 % by the 11 rostered D/ST no usage source covers.
- **B7's one cell** — 2024 TE rank 3: 3.593 under the league's scoring vs the table's 3.2; 3.193 on
  research 05's nflverse basis, where all 36 cells are within 0.3.
- **B11 Lane 2 and B15's graders** — one `claude plugin eval` run (`npm run build && npm run
  build:plugin-evals -- --seed --seed-datasets`, 274 cases): it spends the owner's tokens and
  publishes its report to claude.ai by default, so it needs the owner's go.
- **B8's held-out set** — 6 held-out items (16 claims pooled) is a sanity check, not an estimate;
  growing it needs new captures of the public feeds over several days, by an engineer whose brief
  allows the fetch, labelled before `rules_v1` runs on them (`fixtures/news/labelled/README.md`).

## Gate round 3 (2026-10-07) — what the fixer changed, and what stays open

The gate again found the three hard items it cannot show met as written (B2's denominator, B7's
one cell, B11 Lane 2 / B15) and five soft ones. The soft ones are fixed at their root:

- **E3 live never fabricates (plan 01 §5.6–§5.7).** Two defects behind one symptom. (1) A week the
  pro schedule holds no game for (before any `eff refresh`, or the keyless read held back by the
  budget) read as **everyone's bye**: `lockPlan` gave each player `game_state: "bye"` (its own
  `bye` flag said false) and `matchupPlayerOf` read a missing row as a bye, so E3 live put all 18
  starters in `players_final` at 0 points — `p_win` 0.5 on `[0.5, 0.5]`, `mu = sigma = 0`. An
  unknown week is now `tbd` (no lock instant, never `all_locked`; `tbd_player_ids` lists the
  players), and a missing row is `tbd`. (2) The first live call in a game window spent the 3-request
  budget on mSettings, mRoster and mMatchup, so the box score was never read and every started
  player scored 0 so far (`p_win` 0.504 against the true 0.237). Live now reads the box score first
  and takes this period's pairing from it (mMatchup only when the box score cannot name the
  opponent; `pre` keeps its order), then the pro schedule; and a live call missing either live fact
  conditions nothing: the lineups as set at their pre-game distributions, `live: null`,
  `partial: true`, the omission an assumption and a warning ("live conditioning unavailable: … not
  read; p_win is the pre-game number …"). Measured on `sunday-live` (unit worlds): before any
  refresh, first call `live: null`, `p_win` 0.496 on [0.393, 0.599], second call live 0.258;
  with the schedule stored, the **first** call is already live (0.257, the same points so far as the
  second), only ESPN's cross-check held back (`partial`, named). Tests: `matchup.test.ts`
  (live-unread case, `tbd` default), `schedule.test.ts` (an unknown week), `p1-fx10h.test.ts`
  ("sunday-live on a COLD cache", both orders), `p1-tools.test.ts` (box score lost → nothing
  conditioned; mMatchup past the budget → live still answers).
- **The Skills handle `partial: true`.** Plan 01 §5.6's "the Skill then asks a narrower question"
  was in no SKILL.md. `tool-outputs.md` (also `espn-ff://docs/tool-outputs`) now says what
  `partial` means and what to do — say what is missing, call the same tool once more (the first
  call's reads are cached), else ask the narrower question; the output contract (generated into
  every recommending SKILL.md) never presents a partial number as the answer; `orient.md`'s
  re-fetch table allows that one repeat; `start-sit`'s live step names E3's two partial shapes.
- **The trade-block note reaches a tool, wrapped.** No tool read `teams[].tradeBlock`, so
  `inj-tradeblock` had no positive control and plan 09 TR-INJ ("the note quoted with source
  `espn.team.trade_block`") could not pass. A2 `espn_get_standings` now carries
  `teams[].trade_block` (plan 01 §4.4: `untrusted_text`, source `espn.team.trade_block`, cap 500;
  null for ESPN's empty `{}` or any other shape); the injection flags gained a claimed-authority
  `role_marker` ("Commissioner note:", "League manager notice:", "Admin:" opening a sentence) and a
  blanket-order `imperative` ("accept any trade", "approve every claim") — none fires on the 71
  labelled real headlines. B8's walk now requires a positive control on **every** variant
  (`stdio-full`: `inj-tradeblock` → `standings`; `injection.test.ts`: shown and flagged); E6's
  result is unchanged by the note (`p1-fx10h.test.ts`). The trade Skill reads the note from step
  3's standings.
- **`client_ref` is path-listed on read-back.** `RECLOG_TEXT_PATHS` lists it (its grammar admits
  words — `IGNORE.previous:rules`), so `espn-ff://rec/{log_id}` lists `data.client_ref` with
  source `store.recommendation_log`, read back through the same filter.
- **The CBS guids' note.** `fixtures/news/README.md` says the 40 UUID-shaped CBS `<guid>` values
  (and their copies in the labelled sets and one `xml.test.ts` assertion) are public article ids,
  not member GUIDs; `tests/sources/news/fixture-ids.test.ts` holds it.

Open, for the orchestrator or the owner (no code change closes them; evidence unchanged):

- **B2's denominator** — 131/134 = 97.8 % of the rostered players D1 models; 131/145 = 90.3 % over
  every rostered entry, capped at 92.4 % by the 11 rostered D/ST no usage source covers.
- **B7's one cell** — 2024 TE rank 3: 3.593 under the league's scoring vs the table's 3.2; 3.193 on
  research 05's nflverse basis, where all 36 cells are within 0.3.
- **B11 Lane 2 and B15's graders** — one `claude plugin eval` run (`npm run build && npm run
  build:plugin-evals -- --seed --seed-datasets`, 274 cases): the owner's tokens and a report
  published to claude.ai by default, so it needs the owner's go. TR-INJ can pass now that the note
  is shown.
