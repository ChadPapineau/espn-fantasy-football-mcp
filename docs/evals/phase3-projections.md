# Phase 3 projections — `v2-opportunity`, the turnover model, and plan 10 C1

Plan 10 §3.3 (C1; B14's design on history); plan 07 E1 (`model_version: "v2-opportunity"`,
`basis: "player_sim"`, the `weight_espn` rule — ADV OBJ-02); sibling research 05 §1 (the method),
research 05 §3.2 (the turnover model), §5 and §8.4 ("what good looks like"). Every number below is
measured by the committed code on committed data; nothing is estimated.

Owner paths: `src/domain/analytics/projections-v2/**`, `tests/domain/analytics/projections-v2/**`
(the excerpt in `data/`, its generator and loaders in `helpers/`), `tests/backtest/projections.test.ts`.

**Stage C (round 0, 2026-10-11):** the open item "QB's p10–p90 is narrow, RB slightly" is closed at
its root — the interception drive cost was counted twice in every simulated QB-week (see
"Per-position interval"); the per-position dispersion fitted on 2023 alone accepts no move. Every
number below is the re-run after that fix (the previous values are in the git history of this file).

## Summary

| Item | Status | Numbers (2024 / 2025, held out) |
|---|---|---|
| C1 — v2 beats trailing-4 on CRPS | **met** (hard, tested) | 3.589 vs 4.056 (−11.5 %) / 3.645 vs 4.107 (−11.2 %) |
| C1 — … and on within-position Spearman | **met** | 0.471 vs 0.370 / 0.443 vs 0.337 (68 position-weeks each) |
| C1 — the gain is not concentrated in weeks 1–3 | **met** | weeks 4–17 alone: 3.629 vs 4.068 / 3.674 vs 4.118; weeks 1–3 carry 23.7 % / 21.9 % of the gain |
| C1 — p10–p90 coverage 80 % ± 5 | **met** | 80.0 % / 78.0 % |
| Per-position p10–p90 (Stage C) | **QB fixed** (its mean at the root; its dispersion fitted on 2023); 2025 QB and RB reported | v2's own, held out: QB 80.4 % / 73.6 % (was 76.7 / 71.5), RB 78.9 / 74.9, WR 79.9 / 80.7, TE 81.9 / 80.6; on 2023 (training) QB 80.5, RB 80.1. **Served** (the ensemble at game time): QB 83.8 / 82.0 (was 85.5 / 84.0), RB 82.6 / 81.9, WR 80.4 / 82.6, TE 81.5 / 81.8 — every position within ± 5 (tested) |
| C1 — the ensemble beats ESPN's mean-only projection (positional CV) on CRPS, matches its Spearman | **met at game time** (see "ESPN") | 3.479 vs 3.508 / 3.485 vs 3.504; Spearman identical (0.468 / 0.460) |
| `weight_espn` | **stays 1.0** | the 0.75 mixture won MAE in both seasons and CRPS in 2025, tied 2024's CRPS inside Monte-Carlo noise; 0.5 lost 2024's CRPS |
| B14 (prospective, ≥ 8 weeks of pre-game snapshots) | **needs_time** — code path proven | the same harness (`externalCases` → `evaluateCases` → `espnModels`) runs on any ESPN projection rows |
| Turnover model widens the QB left tail | **met** (tested) | interceptions moment-matched to 2023: within-QB corr(INT, non-turnover points) −0.130 real, −0.129 simulated; Stage C centred the drive cost on the game's expected interceptions (it no longer moves the QB's mean) and re-matched it on 2023 |

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
| corr(attempts, yards per attempt) | −0.160 | −0.158 |
| CV of yards per attempt (median) | 0.241 | 0.223 |

(2024: −0.048 / −0.152; 2025: −0.175 / −0.186 — not used.) The model now draws interceptions from
the incompletions (an INT is an attempt not completed), couples a game-efficiency draw to the pass-
volume draw (a pass-heavy game is usually a trailing, less efficient one; coupling 0.75), and lets
each interception end its drive (24 yards and 0.2 of a touchdown no longer produced — Stage C's values) —
`helpers/run-calibrate-qb.ts` moment-matched these three on 2023 with the other parameters at their
fitted values. With them, adding the turnover penalty moves the QB's p10 down further
than his mean and widens p10–p90 (`expectation-simulate.test.ts`), and `turnoverTail` gives the exact
P(turnover points ≤ −4) for the expected volume (a double Poisson sum). The simulated
yards-per-attempt CV (0.22) is now a little under the real 0.24 (it was above, 0.25–0.29, before
Stage C); recorded.

**Stage C — the drive cost is centred, then re-matched.** Charged in full, the cost removed every
simulated QB-week's *expected* interception-ended drives a second time (the shrunk yards and
touchdown rates are measured on games that already lost them): the simulation's QB mean ran 1.28
points under its own expected line on the 2023 cases. Only an interception beyond the game's own
expectation (its incompletions × the game's interception rate) now costs a drive, and one fewer
returns one. Centring on the week's expectation instead would add a constant number of yards to every
simulated game, which reads as yards per attempt falling with attempts (corr −0.23 against the real
−0.16). Centred, the cost carried less of the INT–points correlation (−0.109 at the old 0.176 TD /
21 yards), so `run-calibrate-qb.ts` re-matched it on the same 2023 cases: **0.2 TD / 24 yards**,
which simulates the three moments in the table above. The section "Per-position interval" has the
finding and the held-out effect.

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
scores 3.594 / 3.645, and 3.589 / 3.645 after Stage C. (The QB calibration was re-matched after the
fit — coupling 1 → 0.75, drive cost 0.165 → 0.176 TD — without re-running the CRPS search; Stage C
centred the drive cost on the game's expected interceptions and re-matched it, 0.176 → 0.2 TD, 21 → 24
yards; both move only QB numbers.)

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
| **v2-opportunity** | **3.589** | **5.21** | **0.471** | **80.0 %** | 0.849 / 2.566 / 1.372 |
| trailing-4 | 4.056 | 5.75 | 0.370 | 61.5 % | 1.077 / 2.763 / 1.644 |
| trailing-4 + P(active) | 3.888 | 5.56 | 0.419 | 66.0 % | 0.938 / 2.687 / 1.617 |
| season-to-date | 3.979 | 5.53 | 0.385 | 61.1 % | 1.040 / 2.701 / 1.650 |

| 2025 (n 3,320) | CRPS | MAE | Spearman | coverage | pinball p10 / p50 / p90 |
|---|---:|---:|---:|---:|---|
| **v2-opportunity** | **3.645** | **5.29** | **0.443** | **78.0 %** | 0.872 / 2.591 / 1.407 |
| trailing-4 | 4.107 | 5.83 | 0.337 | 62.4 % | 1.082 / 2.795 / 1.697 |
| trailing-4 + P(active) | 4.013 | 5.70 | 0.361 | 65.5 % | 0.998 / 2.750 / 1.691 |
| season-to-date | 4.037 | 5.62 | 0.372 | 62.0 % | 1.042 / 2.725 / 1.722 |

By position, v2 vs trailing-4 (CRPS · Spearman · v2 coverage):

| | 2024 | 2025 |
|---|---|---|
| QB | 4.866 vs 5.704 · 0.481 vs 0.332 · 80.4 % | 5.192 vs 6.185 · 0.395 vs 0.269 · **73.6 %** |
| RB | 3.487 vs 3.905 · 0.576 vs 0.502 · 78.9 % | 3.734 vs 4.087 · 0.550 vs 0.482 · 74.9 % |
| WR | 3.463 vs 3.893 · 0.457 vs 0.343 · 79.9 % | 3.253 vs 3.591 · 0.454 vs 0.379 · 80.7 % |
| TE | 2.748 vs 3.003 · 0.369 vs 0.303 · 81.9 % | 2.892 vs 3.294 · 0.373 vs 0.220 · 80.6 % |

Weeks 1–3 vs 4–17 (v2 vs trailing-4 CRPS): 2024 3.421 vs 4.006 (n 649) and 3.629 vs 4.068 (n
2,784); 2025 3.520 vs 4.057 (n 626) and 3.674 vs 4.118 (n 2,694). The unfiltered population (no
relevance floor; 5,645 / 5,772 cases, 100 draws): v2 2.806 / 2.755 vs trailing-4 3.163 / 3.114,
Spearman 0.616 / 0.615 vs 0.554 / 0.551, coverage 81.9 % / 81.4 %.

The per-position interval is the next section's (Stage C): QB's narrowness was mostly a mean defect,
fixed, then its dispersion was fitted on 2023; 2025's QB interval (73.6 %) and RB's (74.9 %) stay
narrow and are reported, not re-fitted.

## Per-position interval (Stage C — the phase3-summary "Open" item)

**The finding (2023, the training season only).** Before the fix, the 2023 cases (weeks 4–17) showed
QB coverage 76.0 % with the misses on the high side (10.0 % below p10, 14.0 % above p90) and the
simulation's QB mean 1.16 points under the actual. Splitting the QB-week into its components (each
count's mean squared error against the simulation's own variance, 400 draws per case) found no
single source that widening fixes: attempts and passing yards under-dispersed (ratios 1.18 and
1.48), touchdowns and rushing yards over-dispersed (0.82, 0.83). Every dispersion knob tried —
the QB role draw, the efficiency draw, the per-completion yardage CV, all game-level volume draws
together — raised CRPS as it raised coverage. Scaling the QB mean by 1.07 instead lowered CRPS (4.80 →
4.74) **and** reached 79.5 % with symmetric tails: the QB interval looked narrow because its centre
was low.

**The cause — and the fix (`simulate.ts`, `constants.ts`).** The simulation's QB mean was 14.85 points
against its own expected line's 16.12 and the actual 16.00 (2023 cases): the interception drive cost
(each interception ends its drive, so the yards and touchdown chance the drive would still have
produced are lost — research 05 §3.2's negative INT–points correlation) was charged in full on every
interception, but the shrunk yards-per-completion and touchdown-per-attempt rates it is applied to
are measured on games that already lost their average interception-ended drives. Every simulated
QB-week lost its expected interceptions' drives twice — 1.28 points. The cost is now centred on the
game's own expected interceptions and re-matched on 2023 (0.176 TD / 21 yards → 0.2 / 24 — "The
turnover model" above): the simulation's QB mean is 16.09 (expected line 16.12, actual 16.00). The
anchored (served) simulation carried the same double count, which its final pin to ESPN's mean turned
into an ≈ 8 % stretch of every QB distribution — the served QB interval was wide (85.5 % / 84.0 %) for
the same reason the own one looked narrow.

**The per-position dispersion, fitted on 2023 alone (`fit.ts` `fitPositionDispersion`,
`helpers/run-fit-dispersion.ts`).** The model's own simulation now has a per-position dispersion
(`sim.position`: the role draw and the per-event yardage CVs, as multipliers of the global values).
The anchored simulation never reads it: it carries the own estimate's uncertainty, which an external
mean does not. Fitted by the module's coordinate descent (CRPS, 1 000 draws, common seeds, its 0.2 %
acceptance gate) on the 2023 weeks 4–17 cases of QB (420) and RB (737), after the drive-cost fix:

- **QB — accepted:** role draw × 1.25 and yardage per completion × 2.5. CRPS 4.749 → 4.732, coverage
  78.6 % → 80.5 %, tails 10.5 % / 9.0 %. The QB terms were moment-matched to each QB's game-to-game
  spread around his own season (a yards-per-attempt CV of 0.24); a forecast must also carry the
  uncertainty of the QB's expected rates, which that moment does not hold.
- **RB — no move lowers CRPS:** RB's 2023 coverage is 80.1 % as is, so the RB entry stays neutral.
- **WR and TE — not re-fitted:** their held-out coverage holds; neutral entries.

**Held out, per position** (2024 / 2025; nothing above was set from these seasons):

| p10–p90 coverage | QB | RB | WR | TE | all |
|---|---|---|---|---|---|
| v2's own, before | 76.7 / 71.5 | 78.9 / 74.9 | 79.9 / 80.7 | 81.9 / 80.6 | 79.4 / 77.6 |
| v2's own, after | **80.4 / 73.6** | 78.9 / 74.9 | 79.9 / 80.7 | 81.9 / 80.6 | 80.0 / 78.0 |
| served (ensemble 1.0, game time), before | 85.5 / 84.0 | 82.6 / 81.9 | 80.4 / 82.6 | 81.5 / 81.8 | 81.9 / 82.4 |
| served (ensemble 1.0, game time), after | **83.8 / 82.0** | 82.6 / 81.9 | 80.4 / 82.6 | 81.5 / 81.8 | 81.7 / 82.1 |

QB CRPS: own 4.897 → 4.866 (2024), 5.195 → 5.192 (2025); served 4.445 → 4.429, 4.207 → 4.202.
`tests/backtest/projections.test.ts` now holds three things:

- the training season's QB mean within 0.5 points of the actual;
- every position's 2023 coverage within 80 % ± 5;
- the **served** distribution's coverage within 80 % ± 5 at every position, in both held-out seasons.

**Still narrow, reported (not re-fitted on held-out data):**

- **2025 QBs (73.6 %) miss low.** 17.2 % of QB-weeks fall below p10. The model over-predicts QBs by
  1.10 points that season, against +0.51 in 2024 and +0.09 in 2023. That is a season-level drop in
  QB scoring the 2023-fitted model cannot see.
- **2025 RBs (74.9 %) sit at the band's edge,** with both tails near 12.5 %.
- **What the tools show is the served distribution,** and it covers 82.0 % (QB) and 81.9 % (RB) in
  2025.

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
| **ensemble, weight 1.0 (served)** | **3.479** | 5.057 | 0.468 | 81.7 % | **3.485** | 5.099 | 0.460 | 82.1 % |
| ensemble 1.0, plain rescale (sensitivity) | 3.486 | 5.057 | 0.468 | 83.4 % | 3.481 | 5.099 | 0.460 | 83.0 % |
| ensemble 0.75 | 3.478 | 5.022 | 0.476 | 81.5 % | 3.468 | 5.039 | 0.459 | 81.3 % |
| ensemble 0.5 | 3.492 | 5.011 | 0.478 | 81.8 % | 3.472 | 5.007 | 0.448 | 81.4 % |
| v2 own (weight 0) | 3.604 | 5.076 | 0.442 | 80.8 % | 3.550 | 5.020 | 0.423 | 79.7 % |

By position (ensemble vs ESPN, CRPS · coverage): QB 4.429 vs 4.444 · 83.8 % vs 74.6 % / 4.202 vs
4.237 · 82.0 % vs 76.2 %; RB 3.281 vs 3.324 · 82.6 % vs 78.4 % / 3.577 vs 3.610 · 81.9 % vs 76.9 %;
WR 3.578 vs 3.604 · 80.4 % vs 76.4 % / 3.344 vs 3.348 · 82.6 % vs 78.5 %; TE 2.931 vs 2.948 · 81.5 %
vs 78.6 % / 2.957 vs 2.968 · 81.8 % vs 78.5 %. (Before Stage C's centred drive cost QB was 4.445 vs
4.444 — a tie — and 85.5 % / 84.0 % coverage.) Monte-Carlo check (three seeds × 1 000 draws): the
weight-1.0 ensemble beats ESPN + positional CV by 0.016–0.024 CRPS in every seed and season — far
outside the evaluation's noise (≈ 0.002 at 1 000 draws, ≈ 0.005 at the test's 200).

**Pre-game** (v2's P(active) from the final injury report, while ESPN's number knows the
inactives): ESPN + positional CV 3.508 / 3.504, the ensemble 3.505 / 3.503 — a tie. At three seeds
× 1 000 draws the pre-game ensemble trails by 0.002–0.005. The whole gap is the Questionable group
(249 cases: 3.13 vs 2.76 — our zero mass on players ESPN's number already knows are active); on the
3,606 undesignated cases the pre-game ensemble already wins (3.721 vs 3.749). Read: the opportunity
simulation's shape beats the positional CV whenever both sides hold the same availability
information.

### Shadow weights (B14's design, on history)

`weight_espn` moves below 1 only if a shadow mixture beats ESPN alone (the served weight-1.0
ensemble) on CRPS **and** MAE in both seasons, a CRPS win having to exceed the evaluation's
Monte-Carlo noise (`BACKTEST_V2.crpsNoise` = 0.005). At three seeds × 1 000 draws:

| vs weight 1.0 | 2024 CRPS | 2024 MAE | 2025 CRPS | 2025 MAE |
|---|---|---|---|---|
| 0.75 | +0.0002 / −0.0010 / −0.0021 (tie) | −0.032 to −0.034 | −0.011 to −0.012 | −0.057 to −0.058 |
| 0.5 | +0.016 to +0.019 (loses) | −0.043 to −0.047 | −0.004 to −0.006 | −0.087 to −0.088 |
| 0.9 (not a plan weight) | −0.003 | −0.015 to −0.016 | −0.004 to −0.009 | −0.026 |

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
