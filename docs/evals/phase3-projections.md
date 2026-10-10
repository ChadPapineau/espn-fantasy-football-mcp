# Phase 3 projections — `v2-opportunity`, the turnover model, and plan 10 C1

Plan 10 §3.3 (C1; B14's design on history); plan 07 E1 (`model_version: "v2-opportunity"`,
`basis: "player_sim"`, the `weight_espn` rule — ADV OBJ-02); sibling research 05 §1 (the method),
research 05 §3.2 (the turnover model), §5 and §8.4 ("what good looks like"). Every number below is
measured by the committed code on committed data; nothing is estimated.

Owner paths: `src/domain/analytics/projections-v2/**`, `tests/domain/analytics/projections-v2/**`
(the excerpt in `data/`, its generator and loaders in `helpers/`), `tests/backtest/projections.test.ts`.

## Summary

| Item | Status | Numbers (2024 / 2025, held out) |
|---|---|---|
| C1 — v2 beats trailing-4 on CRPS | **met** (hard, tested) | 3.594 vs 4.056 (−11.4 %) / 3.645 vs 4.107 (−11.2 %) |
| C1 — … and on within-position Spearman | **met** | 0.471 vs 0.370 / 0.443 vs 0.337 (68 position-weeks each) |
| C1 — the gain is not concentrated in weeks 1–3 | **met** | weeks 4–17 alone: 3.639 vs 4.068 / 3.676 vs 4.118; weeks 1–3 carry 24.6 % / 22.2 % of the gain |
| C1 — p10–p90 coverage 80 % ± 5 | **met** | 79.4 % / 77.6 % |
| C1 — the ensemble beats ESPN's mean-only projection (positional CV) on CRPS, matches its Spearman | **met at game time** (see "ESPN") | 3.481 vs 3.508 / 3.485 vs 3.504; Spearman identical (0.468 / 0.460) |
| `weight_espn` | **stays 1.0** | the 0.75 mixture won MAE in both seasons and CRPS in 2025, tied 2024's CRPS inside Monte-Carlo noise; 0.5 lost 2024's CRPS |
| B14 (prospective, ≥ 8 weeks of pre-game snapshots) | **needs_time** — code path proven | the same harness (`externalCases` → `evaluateCases` → `espnModels`) runs on any ESPN projection rows |
| Turnover model widens the QB left tail | **met** (tested) | interceptions moment-matched to 2023: within-QB corr(INT, non-turnover points) −0.130 real, −0.129 simulated |

## The data

`tests/domain/analytics/projections-v2/data/` (README there: licences, provenance, hashes): three
regular seasons, 2023–2025, weeks 1–18, QB/RB/WR/TE — nflverse player-weeks with snap shares and
pbp red-zone/goal-line counts and touchdowns (CC-BY 4.0), team-weeks with the market line and venue
(CC-BY 4.0), final injury reports (statuses only), ffopportunity expected touchdowns (CC BY-SA 4.0,
kept in their own files), and the ESPN → GSIS crosswalk of league-b's recorded box-score players.
2.9 MB in 33 files; every part re-hashed on every read. The 2024–2025 scoring columns equal the B7
excerpt's cell for cell (`data.test.ts`). Cut from the release files the Phase-3 history refresh
grounded (`docs/evals/phase3-data.md`), by `helpers/make-excerpt.ts`, by hand.

**2023 tunes; 2024 and 2025 are held out.** No constant was set from a held-out season: the priors
of a case's season pool only earlier seasons (`priorsBefore`), the parameters and the P(active) table
were fitted on 2023, the QB efficiency terms moment-matched on 2023.

## The method as built (sib research 05 §1, step by step)

| Step | Where | What it does |
|---|---|---|
| 1 Team volume from the market | `team.ts` | EWM of the team's dropbacks and rushes (half-life 6 games, shrunk 4 games toward the league mean), moved by the week's spread against the window's mean spread (2023: dropbacks −0.094, rushes +0.246 per point); the implied total scales touchdown rates by (implied / the player's window implied)^1.5, bounded to [0.6, 1.6] |
| 2 Shares with change points | `window.ts`, `expectation.ts` | EWM over ≤ 16 games (half-life 8, an older season × 0.6); a ≥ 15-point snap-share (else ≥ 8-point opportunity-share) jump held two games re-bases the window — earlier games keep 0.1 of their weight; shares shrunk toward the positional share with 1 pseudo-game |
| 3 Expected opportunities | `expectation.ts` | targets = team dropbacks × target share; carries = team rushes × carry share; QB attempts = dropbacks × his share × (1 − sack rate) |
| 4 Shrinkage per rate | `rates.ts` | `(n·obs + k·prior)/(n + k)` for catch rate, yards per reception / carry / completion, completion, sack, interception and fumble rates; priors pooled from earlier seasons (`buildV2Priors`) |
| 5 Touchdowns from location | `expectation.ts` | ffopportunity's expected TDs per opportunity (k = 40), else pbp red-zone / goal-line counts × the league's TD rate per location, else the positional prior — never the player's own TD rate (tested: three TDs a game change nothing) |
| 6 Regressed matchup | `matchup.ts` | points a defence allowed to a position against what the same offences score elsewhere, **relative to its all-position figure** (the market prices the total), × β_pos (QB 0.25, RB 0.25, WR 0.5, TE 0) × w(games → 1 at 8), bounded [0.8, 1.2]; ESPN's positional rating is carried beside it as a comparator and never multiplies anything |
| 7 Weather where evidenced | `weather.ts` | PFF/4for4 terms (wind ≥ 10 / > 13 mph, < 30 °F, precipitation ≥ 50 %), outdoors only, never on the implied total |
| 8 P(active) mixture | `availability.ts` | designation × last practice, fitted on 2023 (below); inside the game-day window ESPN's status alone (plan 07 D2) |
| 9 Simulated distribution | `simulate.ts` | per sample: shared game-script, pass/rush and role draws (gamma); Poisson counts (gamma–Poisson); binomial completions/receptions; gamma yardage sums; Poisson TDs on the location rate; the turnover model; 2-pt tries — each line scored by the engine (`scoreSamples` → `basis: "player_sim"`) under the league's S |
| Ensemble | `ensemble.ts`, `project.ts` | mean = weight_espn × ESPN + (1 − weight_espn) × own; the distribution is the simulation **re-run with the volume scaled** to carry that mean (counts are Poisson, so the spread grows like √f, not f), then pinned exactly |

`projectV2` (E1's v2 entry) runs three cooperative phases (set-up, sample-major sampling, scoring)
that yield every ≤ 12 ms under the 8 s CPU deadline (`partial` with the completed count). Samples
are held as numbers, not line objects, until scored. Measured on the development Mac
(`project.perf.test.ts`, process project): the worst in-bounds call — 64 players, all with an ESPN
mean (so the anchored simulation runs too), n_sims at the E1 ceiling shared down to 1 562 — takes
≈ 2.0 s wall, never partial; the event-loop heartbeat never saw a gap over 50 ms; one scoring step
(scoreSamples over 2 000 lines) stays under 20 ms.

## The turnover model (research 05 §3.2)

Interceptions per attempt and fumbles per touch are the player's weighted rates shrunk hard toward
the positional prior (k = 800 attempts, 300 touches), drawn per simulated opportunity. A first build
drew interceptions as Poisson on the drawn attempts: that made them **positively** correlated with
the QB's other points (more attempts → more yards and more INTs), so adding the turnover penalty
pulled his p10 down *less* than his mean — the opposite of research 05 §3.2. nflverse 2023–2025 shows the real sign (within-QB, ≥ 20
attempts, ≥ 6 games):

| 2023 within-QB | real | v2 simulation |
|---|---:|---:|
| corr(INT, non-turnover points) | −0.130 | −0.129 |
| corr(attempts, yards per attempt) | −0.159 | −0.162 |
| CV of yards per attempt (median) | 0.240 | 0.247 |

(2024: −0.048 / −0.152; 2025: −0.175 / −0.186 — not used.) The model now draws interceptions from
the incompletions (an INT is an attempt not completed), couples a game-efficiency draw to the pass-
volume draw (a pass-heavy game is usually a trailing, less efficient one; coupling 0.75), and lets
each interception end its drive (21 yards and 0.176 of a touchdown no longer produced) —
`helpers/run-calibrate-qb.ts` moment-matched these three on 2023 with the other parameters at their
fitted values. With them, adding the turnover penalty moves the QB's p10 down further
than his mean and widens p10–p90 (`expectation-simulate.test.ts`), and `turnoverTail` gives the exact
P(turnover points ≤ −4) for the expected volume (a double Poisson sum). Remaining gap: the simulated
yards-per-attempt CV (0.29) is above the real 0.24 — the drive-cost term adds variance; recorded.

## Tuning (2023 weeks 4–17; sib §1-Evaluation)

`fitV2Params` — coordinate descent over 27 parameters on small grids inside `V2_PARAM_BOUNDS`,
objective the mean v2 CRPS of the 2,694 relevant 2023 cases at 100 draws each, common random numbers
(`helpers/run-fit.ts`). Two runs: from the hand defaults 3.598 → 3.551 (93 evaluations); after the
QB terms were added, from that result 3.582 → **3.547** (155 evaluations, 10 min). The moves:
half-life 4 → 8 games; pre-change weight 0.25 → 0.1; k: catch rate 60 → 10, yards per reception
60 → 10, yards per carry 300 → 30, completion rate 150 → 50, yards per completion 150 → 50,
interception rate 400 → 800, xTD 20 → 40; market exponent 1 → 1.5; β: RB 0.25, WR 0.5, TE 0;
yards CVs: per catch 0.7, per carry 1.8, per completion 0.5.

**A finding to keep honest:** several shrinkage k's ended at the grid's low edge. Against a
*positional* prior, this data rewards trusting the player's own efficiency far more than sib §1 step
4's stabilisation figures suggest ("yards per carry is pure prior") — likely because the positional
prior is a poor target for a role (a depth-role prior is the natural next step). The values were not
extrapolated past the grid. `prior_season_weight` (0.6) is untunable on 2023 (the excerpt holds no
2022) and stays a choice [U].

Transfer to the held-out seasons: the untuned defaults scored 3.637 / 3.667 CRPS; the 2023 fit
scores 3.594 / 3.645. (The QB calibration was re-matched after the fit — coupling 1 → 0.75, drive
cost 0.165 → 0.176 TD — without re-running the CRPS search; it moves only QB numbers.)

**P(active)** (`fitAvailability`, k = 10 toward sib §3.5's Questionable 0.71 / Doubtful 0.059), from
the 2023 listed cases (n played / n): Questionable + full practice 38/45, + limited 93/139, + did not
practise 22/40, designation only 4/4 (all Questionable 157/228 → 0.689); Doubtful + limited 1/8,
+ did not practise 0/11 (→ 0.055 overall); practice-only listings (no game designation) 456/456 —
the NFL report's rule, and the population's (an undesignated player is in it only if he played).
Held out, the fitted table's Brier beats the designation-only prior: 0.0634 vs 0.0671 (2024, 865
listed cases), 0.0520 vs 0.0530 (2025, 776).

## C1 against trailing-4 (reference league S: fx-10h, half-PPR, 5-pt pass TD)

Population (`backtestCases`): players with ≥ 1 earlier game whose team plays that week and who
played or carried a Questionable/Doubtful designation (OUT and undesignated absences excluded — no
model is usefully scored on them), weeks 1–17; `relevant` adds a trailing-opportunity floor over the
last 4 games played (QB 15 attempts, RB 6 touches, WR/TE 3 targets). Baselines: the trailing-4 and
season-to-date means with the positional-CV gamma (QB CV by the pass-TD value), and trailing-4 with
v2's own P(active) mixture. 200 draws per player-week; fixed seed; `tests/backtest/projections.test.ts`
asserts the C1 lines, `helpers/run-backtest.ts` prints these tables.

| 2024 (n 3,433) | CRPS | MAE | Spearman | coverage | pinball p10 / p50 / p90 |
|---|---:|---:|---:|---:|---|
| **v2-opportunity** | **3.594** | **5.21** | **0.471** | **79.4 %** | 0.848 / 2.575 / 1.376 |
| trailing-4 | 4.056 | 5.75 | 0.370 | 61.5 % | 1.077 / 2.763 / 1.644 |
| trailing-4 + P(active) | 3.888 | 5.56 | 0.419 | 66.0 % | 0.938 / 2.687 / 1.617 |
| season-to-date | 3.979 | 5.53 | 0.385 | 61.1 % | 1.040 / 2.701 / 1.650 |

| 2025 (n 3,320) | CRPS | MAE | Spearman | coverage | pinball p10 / p50 / p90 |
|---|---:|---:|---:|---:|---|
| **v2-opportunity** | **3.645** | **5.28** | **0.443** | **77.6 %** | 0.871 / 2.596 / 1.407 |
| trailing-4 | 4.107 | 5.83 | 0.337 | 62.4 % | 1.082 / 2.795 / 1.697 |
| trailing-4 + P(active) | 4.013 | 5.70 | 0.361 | 65.5 % | 0.998 / 2.750 / 1.691 |
| season-to-date | 4.037 | 5.62 | 0.372 | 62.0 % | 1.042 / 2.725 / 1.722 |

By position, v2 vs trailing-4 (CRPS · Spearman · v2 coverage):

| | 2024 | 2025 |
|---|---|---|
| QB | 4.897 vs 5.704 · 0.481 vs 0.332 · 76.7 % | 5.195 vs 6.185 · 0.396 vs 0.269 · **71.5 %** |
| RB | 3.487 vs 3.905 · 0.576 vs 0.502 · 78.9 % | 3.734 vs 4.087 · 0.550 vs 0.482 · 74.9 % |
| WR | 3.463 vs 3.893 · 0.457 vs 0.343 · 79.9 % | 3.253 vs 3.591 · 0.454 vs 0.379 · 80.7 % |
| TE | 2.748 vs 3.003 · 0.369 vs 0.303 · 81.9 % | 2.892 vs 3.294 · 0.373 vs 0.220 · 80.6 % |

Weeks 1–3 vs 4–17 (v2 vs trailing-4 CRPS): 2024 3.404 vs 4.006 (n 649) and 3.639 vs 4.068 (n
2,784); 2025 3.513 vs 4.057 (n 626) and 3.676 vs 4.118 (n 2,694). The unfiltered population (no
relevance floor; 5,645 / 5,772 cases, 100 draws): v2 2.807 / 2.754 vs trailing-4 3.163 / 3.114,
Spearman 0.616 / 0.615 vs 0.554 / 0.551, coverage 81.5 % / 81.1 %.

Weak spot, recorded: the QB interval is too narrow (71.5 % in 2025; the overall gate holds) and RB
slightly narrow — the tuned dispersions are global, not per position.

## C1 against ESPN (league-b's recorded box scores, under league-b's S: half-PPR, 4-pt pass TD)

4,336 QB/RB/WR/TE box-score entries with ESPN's weekly projection, weeks 1–17 of 2024 and 2025;
4,051 become cases (5 without a GSIS id, 45 without an earlier game, 235 on a bye). Actual = ESPN's
own applied total.

**Finding — ESPN's recorded weekly projections are game-day values.** On both seasons the
projection is exactly 0 for the players who did not play and > 0 for those who did (Questionable:
played | projection > 0 = 97.0 % / 100 %, played | projection = 0 = 2.7 % / 0 %; undesignated 99.5 %
/ 99.7 % and 0 % / 2.7 %; no value lies in (0, 0.5]). So ESPN's number already knows the inactives —
this settles research 04 §G item 1 for finished seasons. The fair comparison is therefore at game
time: v2 reads availability as plan 07 D2 prescribes inside the game-day window (ESPN's status
alone, here: projection 0 = out), the information ESPN's own number carries. The pre-game variant
is reported beside it.

| Game time | 2024 CRPS | MAE | Spearman | cov. | 2025 CRPS | MAE | Spearman | cov. |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ESPN mean + positional CV | 3.508 | 5.057 | 0.468 | 77.2 % | 3.504 | 5.099 | 0.460 | 77.6 % |
| **ensemble, weight 1.0 (served)** | **3.481** | 5.057 | 0.468 | 81.9 % | **3.485** | 5.099 | 0.460 | 82.4 % |
| ensemble 1.0, plain rescale (sensitivity) | 3.487 | 5.057 | 0.468 | 83.3 % | 3.481 | 5.099 | 0.460 | 82.8 % |
| ensemble 0.75 | 3.482 | 5.024 | 0.473 | 81.6 % | 3.470 | 5.040 | 0.457 | 81.4 % |
| ensemble 0.5 | 3.497 | 5.015 | 0.473 | 81.8 % | 3.477 | 5.012 | 0.447 | 81.4 % |
| v2 own (weight 0) | 3.620 | 5.093 | 0.442 | 80.5 % | 3.562 | 5.039 | 0.420 | 79.1 % |

By position (ensemble vs ESPN): QB 4.445 vs 4.444 (a tie) / 4.207 vs 4.237; RB 3.281 vs 3.324 /
3.577 vs 3.610; WR 3.578 vs 3.604 / 3.344 vs 3.348; TE 2.931 vs 2.948 / 2.957 vs 2.968.
Monte-Carlo check (three seeds × 1 000 draws): the weight-1.0 ensemble beats ESPN + positional CV by
0.016–0.023 CRPS in every seed and season — far outside the evaluation's noise (≈ 0.002 at 1 000
draws, ≈ 0.005 at the test's 200).

**Pre-game** (v2's P(active) from the final injury report, while ESPN's number knows the
inactives): ESPN + positional CV 3.508 / 3.504, the ensemble 3.508 / 3.504 — a tie. At three seeds
× 1 000 draws the pre-game ensemble trails by 0.002–0.008. The whole gap is the Questionable group
(249 cases: 3.14 vs 2.76 — our zero mass on players ESPN's number already knows are active); on the
3,606 undesignated cases the pre-game ensemble already wins (3.726 vs 3.749). Read: the opportunity
simulation's shape beats the positional CV whenever both sides hold the same availability
information.

### Shadow weights (B14's design, on history)

`weight_espn` moves below 1 only if a shadow mixture beats ESPN alone (the served weight-1.0
ensemble) on CRPS **and** MAE in both seasons, a CRPS win having to exceed the evaluation's
Monte-Carlo noise (`BACKTEST_V2.crpsNoise` = 0.005). At three seeds × 1 000 draws:

| vs weight 1.0 | 2024 CRPS | 2024 MAE | 2025 CRPS | 2025 MAE |
|---|---|---|---|---|
| 0.75 | +0.0021 / −0.0004 / −0.0020 (tie) | −0.033 to −0.035 | −0.010 to −0.012 | −0.058 to −0.060 |
| 0.5 | +0.021 to +0.023 (loses) | −0.043 to −0.046 | −0.003 to −0.006 | −0.086 to −0.089 |
| 0.9 (not a plan weight) | −0.001 to −0.005 | −0.016 to −0.017 | −0.006 to −0.009 | −0.027 |

So **`weight_espn` stays 1.0** (constants.ts `WEIGHT_ESPN_V2`; `tests/backtest/projections.test.ts`
asserts the shipped constant agrees with the rule). Read with care: the mixtures consistently cut
MAE, and on these game-day projections a light mixture (0.9) improved both metrics in both seasons —
flagged for the orchestrator, not acted on (0.9 is not one of B14's shadow weights, and the history
covers one league). The decision B14 names — pre-game snapshots under the owner's league over ≥ 8
weeks — is still to come (`needs_time`); ESPN's pre-game projection lacks the inactives, which may
favour a mixture more than this history does.

## Integration seams (for E1 and `eff tune`)

- `projectV2(request)` → E1-shaped `data` (`model_version: "v2-opportunity"`, one target week) plus
  `details[]` (own Dist, expectation, opportunity, matchup with ESPN's rating beside it, the turnover
  tail); targets v2 does not model (K, D/ST, no team, no history) are listed with the reason and stay
  on v1. Inside the game-day window the caller sets `availability.game_day`.
- `applyTunedOverrides(params, tunedValues)` maps the retrospective registry's names
  (`ewm_half_life_games`, `shrink_k.*`, `matchup_beta.*`, `weight_espn`) onto v2 and lists what it
  ignored (`shrink_k.yards_per_target` and `shrink_k.yards_per_attempt` have no v2 counterpart).
- `fitV2Params` / `proposeV2Refit` / `diffParams` — the tuning used here, returned as proposals only.

## What still needs time

- **B14** (prospective): the harness takes any `{gsis_id, season, week, espn_mean, actual}` rows —
  the store's `espn_projection` snapshots joined to actuals map onto `ExternalRow` (integration).
- C1's ESPN comparison on the owner's league (league-b is the only recorded league with weekly
  projections; one league's scoring).

## Reproduce

```
scripts/dev/with-node.sh npx tsx tests/domain/analytics/projections-v2/helpers/run-backtest.ts   # these tables (~90 s)
scripts/dev/with-node.sh npx tsx tests/domain/analytics/projections-v2/helpers/run-fit.ts 100 2  # the tuning (~10 min)
scripts/dev/with-node.sh npx tsx tests/domain/analytics/projections-v2/helpers/run-calibrate-qb.ts
scripts/dev/with-node.sh npx vitest run --project unit tests/backtest/projections.test.ts      # C1, hard (~50 s)
```
