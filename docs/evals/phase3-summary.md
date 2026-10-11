# Phase 3 — acceptance summary (plan 10 §3.3, C1–C10)

Stage B2b, integration (2026-10-10), revised by the B2b gate's fix round 1 (C2's `full` basis
re-run on v2-opportunity; C5's replay on the Phase 3 forecast and the league-fitted demand curve; the
seeding simulator's posterior mean draw; the fixture tooling's write-host constant). Exit gate: **C1–C4, C6, C7 and C9 are hard; C5 and C8 soft with
numbers** (plan 10 §3.3). Acceptance that depends on data accruing in season is built and tested on
history now and marked **needs_time**, with the code path proven — never faked. Every number below is
copied from a committed, test-held evals document (linked per row; the tables there are regenerated
by their tests and asserted equal to a fresh run) or from a test named in the row. Spec: plan 10
§3.3; changelog §R4/§R5.

Status vocabulary: **met** · **not_met** · **soft_reported** (a soft item, reported with its numbers)
· **needs_time** (the data cannot exist yet; the code path is built and tested).

## The ten items

| # | Item (plan 10 §3.3) | Status | Numbers (held-out 2024 / 2025 unless said) | Evidence |
|---|---|---|---|---|
| C1 | v2 beats trailing-4 on CRPS and within-position Spearman; gain not concentrated in weeks 1–3; 80 % coverage ± 5; the ensemble beats ESPN's mean-only projection on CRPS and matches its Spearman | **met** (ESPN clause at game time) | CRPS 3.594 vs 4.056 (−11.4 %) / 3.645 vs 4.107 (−11.2 %); Spearman 0.471 vs 0.370 / 0.443 vs 0.337; weeks 4–17 alone 3.639 vs 4.068 / 3.676 vs 4.118 (weeks 1–3 carry 24.6 % / 22.2 % of the gain); p10–p90 coverage 79.4 % / 77.6 %; ensemble vs ESPN mean-only 3.481 vs 3.508 / 3.485 vs 3.504, Spearman identical (0.468 / 0.460). With pre-game availability the ensemble ties ESPN (the gap is the Questionable group, where ESPN's recorded number already knows who was inactive) | [phase3-projections.md](phase3-projections.md); `tests/backtest/projections.test.ts` |
| C1 → product | E1 serves `basis: player_sim` where the opportunity inputs exist | **met** | under `EFF_TOOLSET=full`, `model_version: "v2-opportunity"`; every QB/RB/WR/TE with a game history, a gsis id, a team and a game that week gets v2's first-week distribution around ESPN's mean (`weight_espn` 1.0, the label unchanged); K, D/ST, byes and players without history keep v1 and say why. On the seeded fixture league ≥ 8 of one roster's players are v2-served; over stdio the full E2E asserts it | `tests/integration/e1-v2.test.ts`, `tests/e2e/stdio-full.test.ts` |
| B14 | prospective shadow weights 0.5 / 0.75 vs 1.0 over ≥ 8 weeks of pre-game ESPN snapshots | **needs_time** | the same harness (`externalCases` → `evaluateCases` → `espnModels`) runs on the `espn_projection` snapshots once 8 weeks accrue; on history the 0.75 mixture won MAE both seasons and tied 2024's CRPS inside Monte-Carlo noise — `weight_espn` stays 1.0 (the B14 rule counts a CRPS win only beyond 0.005) | [phase3-projections.md](phase3-projections.md) |
| C2 | regret below both baselines; P(win) within ±5 per decile; "did it matter"; the regret test sets `auto` | **not met as written — two rulings requested (R6)**; every other part met | Replayed on **both toolsets as shipped** — `core` (position_cv) and `full` (v2-opportunity for every QB/RB/WR/TE it models, 4,044 player-weeks incl. 484 QB weeks; the B2b fix replaced Phase 2's player_sim here). Regret vs last week's points: ≈ 13.4 points per team-week lower, both seasons, both bases (**met**). Regret vs ESPN's projection: E2's lineup **is** ESPN's in all 308 team-weeks on **both** bases — every served mean is ESPN's projection (`weight_espn` 1.0, ADV OBJ-02; asserted as the reason), so "below" is unattainable for `mean`/`auto` (the A11a / R2 nit 2 structure; the earlier `full` margin was Phase 2's rescale clamp) — **ruling requested**. P(win) as played: two mirrored deciles miss ±5 on both bases (position_cv 5.6 on n = 49; v2 8.5 on n = 47), both under-confident, inside their Wilson intervals, family-wise consistent; resolving ±5 needs ≈ 355 per decile — **unresolved, ruling requested**; E2's own `p_win_after` under v2 is within 4.9 (met); Brier 0.2233 / 0.2235 vs 0.25. "Did it matter": the product's lineup differs from the manager's in 149 of 272 head-to-head team-weeks and flips 20 results (10 each way) (**reported**). Switch rule on v2: 8 differing team-weeks (< 30), and no replayed lineup is all-player_sim → `auto` stays `mean` (the committed record, re-derived from the v2 replay) (**met**) | [phase3-startsit.md](phase3-startsit.md); `tests/backtest/lineup-history.test.ts`, `tests/domain/analytics/calibration/v2-history.test.ts` |
| C3 | Brier ≤ ESPN's `winProbability` on replayed weeks with a `scoreboard_snapshot`; ≤ `playoffPct` on replayed seasons | **needs_time** | 0 replayed weeks carry a pre-week snapshot (finished seasons have none; the recorded 2026 scoreboards are post-kickoff). Ours: Brier 0.2233 on 272 replayed forecasts; P(playoffs) on 9 league-seasons × weeks 4/8/12 Brier 0.209 / 0.155 / 0.094 vs base rate 0.250 — after the B2b fix that draws each cold-start team's mean from its posterior (was 0.214 / 0.159 / 0.094; asserted better at every checkpoint); one decile each at weeks 4 and 8 is still inconsistent (the shrinkage constant k = 4 against the recorded seasons' persistence, implied k 2.5–58 — a ruling, not tuned here). The chain `preWeekSnapshot → espnNumbersOf → attachEspn → compareWithEspn` is tested end to end | [phase3-startsit.md](phase3-startsit.md); `tests/backtest/winprob-history.test.ts` |
| C4 | the tiebreak chain reproduces `playoffSeed` exactly on ≥ 2 finished seasons under reading (a); (b) on points-only seasons; any other written up | **met** | reading (a) reproduces every team's seed in **9 of 9** recorded league-seasons (three probe leagues × 2023–2025); no exception needed; reading (b) reproduces none (no recorded points-only season exists, so (b) is held on constructed seasons and by fast-check against an independent implementation) | [phase3-waivers-seeding.md](phase3-waivers-seeding.md); `tests/domain/analytics/seeding-reproduce/` |
| C5 | the fitted rule beats "claim the top trending player" by ≥ 10 % over ≥ 2 replayed seasons; P(clears_to_FA) within ±10 points where history allows; fitted vs cold-start Π compared | **soft_reported** — rule vs trending **met** on the Phase 3 forecast; P(clears) **met** with the league-fitted curve, **not met** for the cold start (ruling requested) | B2b fix: the replay's rule now ranks targets with v2-opportunity's week-ahead forecast (read as of the claim week): fitted rule vs trending **+18.2 % (2024), +66.7 % (2025)** per successful claim (on the A9a trailing-4 forecast −32.6 % / −1.8 %, reported beside). P(clears): the cold-start curve under-predicts clears by 47–49 points on league-b's real drops (n = 182, 178); the demand curve fitted on the other season (intercept and slope separately, `fitDemandCurve`) is within ±2.4 points both seasons (q0 ≈ 0.004–0.007 per rival vs research 05's 0.05; slope at its lower bound; one judged decile each) — reported, not applied to E5; fitted Π on the v2 feed ×0.96 (k = 1) to ×1.23 (k = 10) at W = 9 vs the cold start | [phase3-waivers-seeding.md](phase3-waivers-seeding.md); `tests/backtest/waivers-fitted.test.ts`, `tests/backtest/waivers-clears.test.ts` |
| C5 → product | E5 `premium_basis: "league_fitted"` when the league's history allows | **met** (code path) / **needs_time** (owner's league) | E5 logs every priority run it prices (`waiver_run`, the newest call before the run wins) and re-solves Π from the league's own feed + the persisted transactions' drift; `league_fitted` at 13 logged runs (one regular season), the cold-start table below with the reason said; on the seeded league: one call → one run, 13 runs → `league_fitted` | `tests/integration/phase3-tools.test.ts` |
| C6 | beneficiary-share MAE below next-man-up; top-beneficiary hit rate above it | **met** | MAE 0.1427 vs 0.1718 (next man up by usage) and 0.1693 (by depth chart), below both every season and position; hits 52 / 145 vs 43 and 42 (exact McNemar p = 0.12 alone; the role rule was chosen with these absences in view — re-run on 2026 absences); E7 now serves the table (`priors: CASCADE_PRIORS`, each teammate's depth-chart rank) | [phase3-cascade.md](phase3-cascade.md); `tests/backtest/cascade.test.ts`; `tests/integration/phase3-tools.test.ts` |
| C7 | beats "last week's score" clearly; matches "lowest implied total"; the share of D/ST variance from `rare_c` reported | **met** | D/ST pooled ρ gain +0.275 to +0.304 (95 % intervals +0.20 to +0.37), MAE 4.4–4.75 vs 6.4–7.0; K +0.076 to +0.102 (interval lower bounds +0.012 to +0.038), MAE 3.7–4.0 vs 5.2–5.7; identical order to the implied total in all 384 scoring × position × week cells; rare events 15.5 % of D/ST variance under the reference scoring (27.7 % with their covariance; league-c 2.4 %); the `rare_c` fix (every TD member a realised D/ST line carries) | [phase3-kdst-news.md](phase3-kdst-news.md); `tests/backtest/kdst-history.test.ts` |
| C8 | `table_n ≥ 200`; news-augmented P(active) Brier ≤ designation-only; E10 shows `posterior`; `news-check` drops the hand-set line | **soft_reported** + **needs_time** | on the official practice channel (held out): augmented Brier 0.0808 vs designation-only 0.0848 (2024), 0.0765 vs 0.0803 (2025), every interval below 0. `table_n` counts scored **news** claims: 0 today. Wired now: E10 reads the calibration table (practice history + this league's scored claims) and logs each scorable claim value-free; E13 scores them once final; at 200 scored news claims the posterior shows and the note drops — proven at tool level on the seeded league | [phase3-kdst-news.md](phase3-kdst-news.md); `tests/integration/phase3-tools.test.ts` |
| C9 | retrospective attribution populated for every projection-backed call; parameter changes proposed and applied only by `eff tune --apply` | **met** (wired and tested end to end); live proposal evidence **needs_time** | every E1 call (any toolset, any caller — lineup, matchup, waivers, schedule, roster) stores each projected player's first-week projection (`v2-opportunity` with its trace, else `v1-ensemble`); E13 joins the newest one made before each game's kickoff to the final box score, so every call whose subjects were projected is attributed (a post-kickoff projection is never read — tested); the proposal set is persisted (`parameter_proposal`) and only `eff tune --apply`, typed by the owner in an interactive terminal, applies it — refused under `CLAUDECODE`, launchd or off a terminal; the server reads the tuned file once at start. Proposals need ≥ 100 traced share windows / ≥ 150 matchup-traced player-weeks per position / ≥ 300 paired ESPN weeks (≈ 3–8 weeks of a season). On 4,815 recorded league-b player-weeks the layer identity holds on every row | [phase3-negatives.md](phase3-negatives.md) (C9 section); `tests/integration/phase3-tools.test.ts`; `tests/cli/tune.test.ts` |
| C10 | research 05 §8.3's negatives re-checked with the product's own numbers, written to `docs/evals/`, a recurring pre-season job | **met** | 10 of 15 negatives re-checked (the other 5 not re-checkable on this data, listed with reasons): 9 hold, 1 holds revised (points for decided the last playoff seat in 1 of 9 real league-seasons vs research 05's simulated 56 %); the recurring job is now a plan 06 §1.5 row | [phase3-negatives.md](phase3-negatives.md); `tests/domain/reclog/negatives.test.ts` |

## What the integration wired (the product, not only the models)

| Engine | Phase 3 behaviour | Where |
|---|---|---|
| E1 `espn_project_players` (and every engine that projects through it: E2, E3, E5's ensemble value, E8, E9) | v2-opportunity under `full` from the local datasets: nflverse player-weeks with the usage extras (current season), ffopportunity expected TDs (`EpWeeklyRow.x_*_td`, additive), team-game volume (`stats_team_week` — a new optional `TeamWeekReader` port), schedules lines and scores, venue weather, the official practice report, a memoised regressed matchup table; tuned overrides from `tuned-parameters.json`; bulk callers use v2's smallest sample count | `src/mcp/tools/projection-v2.ts`, `src/mcp/tools/analytics.ts` |
| E2 `espn_analyze_lineup` | `auto` follows the committed switch record (`insufficient` → `mean`); an all-player_sim lineup never occurs while K and D/ST stay v1 | `src/domain/analytics/calibration/objectiveSwitch.ts` |
| E5 `espn_analyze_waivers` | logs priority runs; `league_fitted` from 13 | `src/mcp/tools/analytics.ts` |
| E7 `espn_analyze_injury_cascade` | cascade v2 (the redistribution prior table, depth-chart ranks) | `src/mcp/tools/market-p1.ts` |
| E10 `espn_analyze_evidence` | the calibration table, the posterior at 200 news claims, claim logging | `src/domain/analytics/evidence.ts`, `src/mcp/tools/market-p1.ts` |
| E13 `espn_analyze_retrospective` | attribution over stored projections, proposal persistence, claim scoring | `src/mcp/tools/retro-p3.ts`, `src/mcp/tools/reclog.ts` |
| Store | migration 002: `parameter_proposal`, `waiver_run`, `scored_claim` (never pruned), `projection.p_active / reported_mean / trace_json` | `src/store/migrations/002_phase3.ts`, `src/store/repos/phase3.ts` |
| `eff tune` / `eff uninstall` | the real store's proposal table is read; uninstall removes `tuned-parameters.json` | `src/cli/tune.ts`, `src/cli/uninstall.ts` |
| E3 seeding | the exact reproduction is surfaced here and in [phase3-waivers-seeding.md](phase3-waivers-seeding.md); A1's `seeding_evidence` still uses its standings-only approximation (open). B2b fix: every cold-start (and E1-fitted) team's weekly mean is drawn once per path from its posterior, sd σ/√(n + 4) — E2's PF exchange rate and E3 `season` read it | `src/domain/analytics/seeding.ts`, `src/domain/analytics/seasonFit.ts` |

## Measured (this Intel Mac, seeded fx-10h over real stdio, `npm run test:process`)

- Every `full` analytics call stays under the main-loop stall bound (A16a, 50 ms): worst **29.3 ms**
  (P1 analytics), 15.9 ms (P1 warm reads); `core` 14.4 ms. Before two fixes in this stage, v2 stalled
  the loop 59–89 ms: its scoring step now scores one sample set per cooperative step (own, then
  anchored), the matchup table scores a week in slices of 400, the prior season is read without the
  usage extras.
- P1 analytics wall times 0.07–3.0 s (trade 2.96 s, league activity 3.0 s, matchup 2.0–2.3 s), all
  under the 8 s per-call deadline. Startup 543 ms.
- E2's lineup answer under `full` 9,810 chars (budget 10,000, with its existing trims) after
  `data.inputs` stopped repeating identical rows.

## Rulings requested (for R6)

1. **C2, regret vs "start by ESPN's projection".** At `weight_espn` 1.0 E2's lineup is ESPN's in all
   308 team-weeks on **both** toolsets as shipped (core position_cv and full v2-opportunity): every
   served mean is ESPN's projection, so `mean`/`auto` picks the same assignment by the same numbers —
   the A11a structure R2 nit 2 ruled "not informative in v1". Phase 3 changes the distribution's
   shape, not its mean. "Below" is reachable only through `pwin` (the regret test: needs ≥ 30
   differing team-weeks and an all-player_sim lineup, and K / D/ST are never player_sim) or a weight
   below 1.0 (B14 — the owner's ADV OBJ-02 decision). Options: apply R2 nit 2 to C2 (identical
   lineups reported as not informative; C2's regret clause = below last week's points and never
   above ESPN's), or move the ESPN clause to needs_time behind B14.
2. **C2, ±5 per decile.** Unresolved on both bases (position_cv 5.6 on n = 49; v2 8.5 on n = 47 —
   both under-confident, consistent family-wise); ≈ 355 forecasts per central decile are needed and
   two ten-team seasons give 47–70. E2's own `p_win_after` under v2 is within ±5 (met). No sign of
   a dispersion defect behind the miss (gate round 2 re-read of the committed tables): the adjacent
   decile pair 0.2–0.3 / 0.7–0.8 leans the other way on both bases (over-confident by 4.7 / 4.8 on
   n = 16), and the reliability term of the Brier decomposition is 0.0020 (position_cv) / 0.0031
   (v2) against a resolution of 0.026–0.028 — the pattern of sampling noise, so the dispersion is not
   re-fitted on the held-out seasons.
3. **C5's cold-start demand intercept (research 05 §1.3).** League-b's real drops cleared 94–96 %
   against the cold curve's 63 %; the curve fitted on the other season puts q0 at 0.004–0.007 per
   rival (a tenth of 0.05) with no slope, within ±2.4 points. Revise the intercept, or keep the cold
   start until the owner's claim feed fits it (E5 serves the cold start today, said).
4. **The seeding simulator's shrinkage constant k = 4 (research 05 §2.4).** After the B2b fix the
   cold start samples each team's mean from its posterior; one decile each at weeks 4 and 8 is still
   inconsistent. The recorded seasons imply k from 2.5 to 58 (one season shows no persistence);
   an empirical-Bayes k lowered Brier further in a one-off run but did not clear week 4. Keep 4,
   adopt an estimated k (a new bound to choose), or leave it to the owner's league's history.
5. **ESPN's stored weekly projections on finished seasons are game-day values** (0 exactly for
   inactives) — resolves research 04 §G item 1; C1's ESPN clause is evaluated at game time, and C2's
   replay reads the same game-day availability on every side (the gate accepted this reading).

## Open (named, not this stage's to close)

- Per-position calibration: QB's p10–p90 interval is narrow (76.7 % / 71.5 %); RB slightly (78.9 % /
  74.9 %) — the overall C1 coverage holds.
- The seeding simulator's remaining inconsistency at weeks 4 and 8 (ruling 4 above).
- A1's `seeding_evidence` could use `reproduceSeason` over the previous season; the provider's
  settings read (`mSettings` + `mNav`) fails on history recorded with `mSettings` alone.
- C5's replay stands v2's own mean in for E1's (the replay league has no ESPN projections for free
  agents); E5 applies no league-fitted demand curve until the owner's league's claim feed exists.
- `league-a` scores return yards the D/ST expected line does not carry (an E5 `returns_e` field);
  kickers 0.73 points a game low (proposal, not applied); 8 D/ST weeks differ from ESPN by 1–2 points.
- The negatives re-check reads the committed excerpts; a runner over the store's history files is the
  follow-up.
