# Phase 3 — research 05 §8.3's negatives, re-checked with the product's own numbers (C10)

Plan 10 §3.3, acceptance **C10**: "The 05 §8.3 negatives re-checked with the product's own numbers
and written to `docs/evals/` (a recurring pre-season job from now on)." This file is that write-up.
It also records the state of **C9** (retrospective attribution and `eff tune`), the other item this
module built.

## What "the product's own numbers" means here

Every number below comes from shipped code, not from research 05's scripts:

- **Points:** each nflverse player-week goes through the shipped translator
  (`statLineFromPlayerWeek`) and scoring engine (`score`) under the reference league's own settings
  (`fixtures/espn/fx-10h` `mSettings`: half-PPR, 5-pt pass TD, −2 INT, −2 fumble lost). The two
  variants the claims need are the same settings with one rule changed: 5 → 4 pt per pass TD, −2 →
  −1 per INT.
- **Baselines:** the shipped allocation (`allocate` over `allocationPlanOf` of fx-10h's roster,
  N = 10), the same code E4 and B7 use.
- **Waiver numbers:** the shipped cold-start DP (`solvePremiumTable`, `demandOf`, N = 10).
- **League outcomes:** the nine finished probe-league seasons recorded keylessly in
  `fixtures/espn/recorded/history` (2023–2025 × three leagues; placeholders only): ESPN's own
  records, points for, `playoffSeed`, playoff size and waiver settings.

The checks live in `src/domain/reclog/negatives.ts` (pure). Each check states its verdict rule in
code, and the table prints that rule beside the verdict. No verdict is a judgement call.

## Data

| Input | What | Where |
|---|---|---|
| nflverse `stats_player_week` 2024 and 2025 | QB/RB/WR/TE regular-season rows of weeks 1–17: 5,587 and 5,752 rows, re-hashed on every read | `tests/backtest/data/stats_player_week` (CC-BY 4.0) |
| nflverse `games` 2025 | the regular-season schedule (both sides of every game) | `fixtures/nflverse/schedules` (CC-BY 4.0) |
| ESPN finished seasons | three probe leagues × 2023, 2024, 2025: records, points for, seeds, settings | `fixtures/espn/recorded/history` |

2023 is in the store's three-season history files at runtime (Phase 3 grounding,
`docs/evals/phase3-data.md`). Only one game of 2023 is committed as a fixture, so this run reads
2024–2025, the two seasons research 05 used. The 2024 schedule is not committed either, so the
matchup-stability checks read 2025 only.

## Results

Seasons are listed as 2024 then 2025. "pts/game" means players with ≥ 8 games.

<!-- negatives-results:start -->
| # | Claim (research 05 §8.3) | Research 05 said | The product's numbers | Verdict — rule |
|---|---|---|---|---|
| 1 | Hoard the #1 waiver slot for the league-winner | V(1,16) = 96; Π(1, W) ≈ 2.5 pts/week with 10 weeks left | V(1,16) 95.8, V(10,16) 48.5, #1-slot threshold, 10 weeks left (pts/week) 2.5 | **holds** — holds while Π(1, 9)/10 ≤ 3 pts/week with 10 weeks left (a modest upgrade beats holding the #1 slot) |
| 2 | Never claim from a high slot — wait for free agency | a player worth claiming clears with probability near zero | P(clears 9 rivals) at 2.5 pts/week 0.075, at 4.5 0.0087, at 7 0.00021 | **holds** — holds while a 4.5-pt/week player clears every rival ahead with probability < 5 % |
| 3 | 5-pt passing TDs mean draft a QB early | QB1 − QB12 = 160.0 / 105.9 vs RB1 176 / 224, WR1 158 / 140; +6–18 % QB VOR pool; 0–1 pt/game QB1 edge | **2024:** QB1 − QB12 160, RB1 VOR 175.9, WR1 VOR 157.7, QB VOR pool 4 → 5 pt (%) 17.6, QB1 edge 4 → 5 pt (pts/game) 0.98, QB10 − QB12 (pts/game) 0.97; **2025:** QB1 − QB12 105.9, RB1 VOR 223.6, WR1 VOR 140.4, QB VOR pool 4 → 5 pt (%) 6.3, QB1 edge 4 → 5 pt (pts/game) -0.38, QB10 − QB12 (pts/game) 0.4 | **holds** — holds while QB1 − QB12 ≤ max(RB1, WR1 season-total VOR) in every season |
| 4 | −2 INT makes turnover-prone QBs unstartable | no top-24 QB moves > 1 rank; a 7–12 % level shift | **2024:** largest top-24 rank move 1, −1 → −2 level shift (%) 3.5, −2 penalty share (%) 6.6; **2025:** largest top-24 rank move 1, −1 → −2 level shift (%) 3.3, −2 penalty share (%) 6.3 | **holds** — holds while no top-24 QB moves > 1 rank between −1 and −2 per INT; revised at 2–3; overturned beyond |
| 5 | Stack QB–WR to score more | correlation 0.35 (this format, 2024–2025): variance, not the mean | **2024:** r 0.36, QB–WR1 weeks 401; **2025:** r 0.37, QB–WR1 weeks 413; pooled r 0.36 | **holds** — holds for any r (a correlation moves variance, not the mean); revised when the pooled r is > 0.1 from research 05's 0.35 |
| 6 | When the matchup is decided, the rest of the week doesn't matter | PF decides the 6th seed in 56 % of simulated seasons (6 of 10) | league-seasons 9, PF decided the last seat 1, share 0.11 | **holds revised** — holds while points-for decided the last playoff seat in ≥ 1 finished league-season; revised when the share is > 0.25 from the simulated 0.56 |
| 7 | Carry a backup QB/TE for the bye | QB10 − QB12 < 1 pt/game; TE5+ is replacement | **2024:** QB10 − QB12 (pts/game) 0.97, TE5 VOR (pts/game) 2.3; **2025:** QB10 − QB12 (pts/game) 0.4, TE5 VOR (pts/game) 1.22 | **holds** — holds while QB10 − QB12 < 1 pt/game in every season |
| 8 | ESPN's position-vs-opponent ratings rank the matchups | near noise (YoY r 0.15–0.27); regress toward 1 | **2025:** QB 0.39, RB -0.02, WR 0.39, TE 0.33; mean r 0.27 | **holds** — holds while the mean split-half r (weeks 1–8 vs 9–17) of points allowed by position is < 0.4 |
| 9 | Plan playoff-week lineups by strength of schedule in September | YoY r 0.15–0.27 — a negative | **2025:** QB 0.34, RB -0.27, WR 0.22, TE 0.08; mean r 0.09 | **holds** — holds while the mean r of points allowed in weeks 1–4 vs 15–17 is < 0.4 |
| 10 | The waiver order resets weekly, so priority doesn't matter | wrong for a rolling league; ESPN offers both | league-seasons 9, priority (non-FAAB) league-seasons 3, rolling 3 | **holds** — holds while ≥ 1 finished league-season uses rolling (move-to-last) priority |
<!-- negatives-results:end -->

**Not re-checked on this data**, and why:

<!-- negatives-not-rechecked:start -->
- `pf_seeding_high_ceiling` — needs the seeding simulator's variance experiment (C2/C4 owners), not a history statistic
- `handcuff_rb1` — no labelled handcuff outcomes exist in the committed history (sib §18: no rigorous study)
- `ir_any_injured` — an ESPN rule (IR eligibility), verified at the source in research 05 §4.3 — not a statistic
- `trending_adds` — needs Sleeper trending history; the product uses trending only as demand (q_i)
- `clinched_week_17` — unproven by research 05 itself; no week-17 rest labels in the committed history
<!-- negatives-not-rechecked:end -->

## What changed against research 05

- **No negative is overturned.** Every claim research 05 called false is still false by the
  product's own numbers.
- **Reproduced exactly:** QB1 − QB12, RB1 and WR1 VOR, the 4 → 5 pt QB VOR pool change, the top-24
  INT rank moves, the QB–WR1 correlation, QB10 − QB12, V(1,16) = 95.8 and the #1 slot's 2.5
  pts/week threshold. The test asserts the QB, INT, backup and DP numbers against research 05's
  transcribed table.
- **Revised numbers (the verdict stands):**
  - *−2 INT:* going from −1 to −2 per INT costs a top-24 QB about 3.3–3.5 % of his points. The whole
    −2 penalty is about 6.3–6.6 % of his points before it, a little under research 05's "7–12 %".
    The rank result (no top-24 QB moves more than one rank) is unchanged.
  - *QB1's per-game edge from the fifth TD point:* +0.98 pts/game in 2024 but −0.38 in 2025. Under
    4-pt scoring a different QB tops the ≥ 8-game list, so the edge can shrink. Research 05's
    "0–1 pt/game" was too narrow at the low end. The claim still fails.
  - *"Every point counts":* points for decided the last playoff seat in 1 of 9 real league-seasons
    (11 %). Research 05's 56 % was simulated for a 6-of-10 bracket; these leagues seed 4 of 10 or 8
    of 12. The negative holds (points for can decide), but research 05's frequency is not the
    observed one. With n = 9, nothing should be tuned on this number.
  - *Matchup stability:* weeks 1–8 vs 9–17 of 2025 give a mean r of 0.27 across positions (QB 0.39,
    WR 0.39, TE 0.33, RB −0.02). Weeks 1–4 vs 15–17 give 0.09. Weak, as research 05 said. This is
    the product's first within-season number; research 05 quoted only year-over-year r.

## The recurring pre-season job

C10 makes this re-check a pre-season job. It runs each August after the season rollover, once the
refresh has loaded the three backtest seasons:

1. Re-score the history through the shipped engine under the league's then-current settings.
2. Run `negativesReport`.
3. Update this file: `UPDATE_EVALS=1 scripts/dev/with-node.sh npx vitest run --project unit
   tests/domain/reclog/negatives.test.ts` regenerates the two marked sections, and the same test
   without the variable fails while they are stale.

**Not built yet:** the plan 06 job row and a runner that reads the store's history files instead of
the committed excerpts. Both are asked of the integration and the plan 06 owner in this module's
`needs_from_others`. Until then the job is the test above: a manual, pre-release, zero-token run.

## C9 — retrospective attribution and `eff tune` (status)

- **Attribution** (`src/domain/reclog/attribution.ts`): each projected player-week's error
  (realised − reported) is split into availability, opportunity, efficiency, touchdowns, turnovers,
  other, anchor (the cost of reporting ESPN's mean instead of the model's own) and scoring (ESPN vs
  the engine). The parts sum to the error exactly, a fast-check property.
  - Each projection-backed call gets its own decomposition: Σ role weight × its subjects' layers.
    The calls reach `data.attribution` as `calls.<i>.<layer>`, with `i` indexing `calls[]`.
    `data.attribution` also carries the season-to-date aggregate, gated on `min_n`.
  - Matchup and weather lifts are reported beside the sum.
  - Hard parts, met in unit tests: the identity, the hand-computed RB week, every refusal, and
    E13's own output schema accepting the populated `data`.
- **Proposals** (`src/domain/reclog/tune.ts`): four fits over the attributed window:
  - the EWM half-life, the shrinkage `k` per rate, `β_pos` and `weight_espn`;
  - each shrunk toward the value in effect, one step at most, and proposed only when it beats that
    value overall and in both halves of the window;
  - made on final weeks only.
  - Synthetic recovery is tested: h = 5, k ≈ 800, β = 0.6 and a model-truth `weight_espn` are each
    recovered, and only one step is proposed.
- **`eff tune`** (`src/cli/tune.ts`) is a dry-run diff by default. `--apply` writes
  `<config>/tuned-parameters.json` (atomic, 0600). It runs only in an interactive terminal: it
  refuses when `CLAUDECODE` is set or under a launchd label, and the human must type `apply`.
  `--revert` undoes the last change set. It is not in the launchd job list and cannot be reached
  from `serve`.
- **needs_time / needs wiring:** live numbers need the E13 tool to pass attribution rows. Those
  rows join stored projections, which v2 must store with an active-conditional expectation and a
  trace. Proposal sets need a store table, and the projection model must read the overrides. All
  four are listed in this module's `needs_from_others`. Proposals from real evidence also need
  ≥ 100 traced share windows, ≥ 150 matchup-traced player-weeks per position and ≥ 300 paired
  ESPN weeks, which is about 3–8 weeks of a season's projections.
