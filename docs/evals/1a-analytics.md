# Phase 1a analytics — what the engines reproduce, and how they were measured

Scope: the P0 decision engines in `src/domain/analytics/` — E1 projections (`v1-ensemble`), E2
lineup, the seeding simulator behind E3 `season` (domain code; the tool is P1), E5 waiver priority
with the K/D-ST slice, and the E12/E13 hooks. Recorded-week replays are in
[1a-backtest.md](1a-backtest.md). Every number here comes from a test that runs in CI unless it is
marked *measured once*.

## Waiver-priority DP (research 05 §1.2; plan 10 A9a as ruled in changelog R5-1)

A9a's hard regression has three parts: (i) the domain DP reproduces the research table
(`Π(2, 13)` within 0.5 of 29.5); (ii) on `fx-10h` the tool's premium equals the DP table's value at
the tool's own reported `(k, W)` within 0.5, with `W` the research definition computed from the
league clock; (iii) the band and marginal clauses (unchanged). (i):
`tests/domain/analytics/waiver-dp.test.ts` reproduces the research's cold-start `Π(k, W)` table
**cell for cell** (all 80 cells within 0.05; `Π(2, 13) = 29.5`), `V(1, 16) = 95.8`,
`V(10, 16) = 48.5`, the per-week thresholds with 10 weeks left (2.50 … 0.26) and the research's
drift and demand sensitivities (`Π(1, 9)` = 26.8 / 23.2 at c = 0.15 / 0.35; 19.9 / 27.2 at demand
×0.5 / ×1.5).

- **Index convention.** The research table's `W` is the usable weeks *after* the claim's own week;
  the claim's value spans `W + 1` weeks (the research's worked examples read `Π(2, 12)` for "weeks
  5–17"). The DP is solved on that horizon, and `espn_analyze_waivers` reports `W` in the table's
  convention, so the reference scenario (k = 2, 13 weeks after the claim week) reads `Π(2, 13)`.
- **The band** re-solves the DP with every surplus value ×0.5 and ×1.5, the demand curve still read
  at the base rate: at (2, 13) it is 14.73 / 29.5 / 44.21. The research quotes `Π(1, 9)` = 12.1 /
  42.8 for its own surplus sensitivity; neither reading of "surplus ×" (scale the values only, or the
  rates through the demand curve too) gives those two numbers (ours: 12.5 / 37.5 and 10.6 / 40.2),
  so the band is defined here and recorded as a decision, not claimed as a reproduction.
- `k = N` claims anything positive (research 05 §1.2's rule; the DP's drift residual is not charged);
  a weekly-reset order makes the premium 0; an unknown order is read as move-to-last, said so.
- **(ii) On `fx-10h` (week 5), tool level — `tests/mcp/a9a-premium.test.ts` (in process, the real
  composition root in fixture mode) and `tests/e2e/acceptance.test.ts` (over real stdio).** `W` is
  computed in the test from `fx-10h`'s own `mSettings` — claim week 5 (`currentMatchupPeriod`),
  14 regular-season weeks plus 3 playoff rounds = `finalScoringPeriod` 17, so `W = 17 − 5 = 12`
  weeks after the claim week (the playoff weeks weighted 1 at P0, which the result states as an
  assumption) — and the tool reports `k = 2` (team 2's `waiverRank`), `W = 12` and `Π(2, 12) =
  26.95`: within 0.5 of the DP and of the research table read at that cell (27.0, between 24.5 at
  `W = 11` and 29.5 at `W = 13`), the cell research 05 §1.6 example A reads for the same state (a
  week-5 run over weeks 5–17). Counting the claim week in would read 29.5, 2.55 away; that is the
  number A9a's old text assumed (`W = 13`) and changelog R5-1 retired. **Cold cache:** a
  standalone first call spends its 3 requests (plan 01 §5.6) on settings, rosters and the pool,
  so standings is the 4th read and is not made: `partial: true`, a warning naming `espn:mTeam`,
  `k: null` and the cold-start premium at `k = ⌈N/2⌉` (13.95 here). Verdicts priced without the
  rivals can move (here the claim list is empty both ways). The next call makes only that read and
  answers exactly what a server warmed in the Skills' order answers (k, W, premium, band, claim /
  marginal / scramble lists).

## Seeding simulator (research 05 §2.4; plan 10 A10a as ruled in changelog R5-2)

`tests/domain/analytics/seeding.test.ts`. **Hard:** the 3-team toy league within 0.02 under both
readings; the marginal-values table populated, `pf_per_win` finite under (a) and null under (b);
the research's qualitative claims. **Soft (reported here):** the ten-team table's cells.

- **3-team toy league, hand-computed (hard, ±0.02 at 20 000 paths).** Reading (a): `P(A in) =
  Φ(10/√800) = 0.638`. Reading (b): `1 − ∫ P(A < 300, A < C)` by quadrature. Both pass.
- **The research run's ten-team state — soft, a reconstruction (R5-2).** The research recorded only
  the run's inputs (true means 122 … 100, σ 20, a 9 + 5 round-robin, the state after week 8) and
  three teams' facts (T4 4-4 with PF 908, third in PF; T8 4-4, seventh; T2 4-4, fifth) — not the
  other seven teams: their week 1–8 results were one seeded draw of `seeding_mc.py`, a script that
  was never committed, and a Python RNG stream cannot be reproduced from JS. A10a's old text assumed
  "the same seeds"; that state cannot be rebuilt, so the `T4/T8/T2` cells cannot be a hard 0.03
  regression and are reported here instead. A state carrying every recorded fact was found by
  search (annealing on the six P(playoffs) and P(bye) cells), and the simulator reproduces:

  | team | reading | research | ours |
  |---|---|---:|---:|
  | T4 | (a) | 0.826 | 0.813 |
  | T4 | (b) | 0.969 | 0.929 |
  | T8 | (a) | 0.331 | 0.339 |
  | T8 | (b) | 0.133 | 0.145 |
  | T2 | (a) | 0.857 | 0.859 |
  | T2 | (b) | 0.757 | 0.755 |

  The largest gap is 0.040 (T4 under (b)). The test keeps a 0.05 bound and is labelled a
  **reconstruction sanity bound, not the plan tolerance**: it catches a simulator change that moves
  this state, and says nothing about the research's unrecorded draw. The independent evidence is
  the **marginal values, which the search never targeted** (asserted within the same sanity bound): T8 +80 PF under (b) 0.497 (research 0.486); T4 +80 PF P(bye) under (b) 0.345 (0.376);
  T8 +1 win under (a) 0.241 (0.255); T4 +1 win under (a) 0.126 (0.117); the σ ×1.4 signs and sizes
  under (b) for T4 (−0.066 vs −0.049) and T8 (+0.067 vs +0.060) — nine cells are asserted within
  0.05. The research's **qualitative findings are hard** — they hold on any state with the recorded
  facts: a win ≫ 40 PF under (a); wins worth nothing under (b); the variance sign flips with the
  cutoff (T4 above it loses from σ ×1.4 under (b), T8 below it gains); T2 a favourite under (a), a
  bubble team under (b).
- `pf_per_win` is finite under (a) and null under (b) (hard); marginal values are pathwise monotone
  because every perturbation runs on the same random numbers (a property test).

## Sampler budgets and N_SIMS_MAX (plan 07 E1 A-7; plan 10 A16a; plan 01 §1.1)

`tests/domain/analytics/analytics.perf.test.ts` (process project, wall clock) asserts the budgets;
the figures below were *measured once* on the development Mac (Intel, Node 24):

| call | result |
|---|---|
| E1, 32 players × 1 week × 4 000 samples | 81 ms (budget 3 s) |
| E1, 64 players × 18 weeks at `N_SIMS_MAX` = 20 000 (shared down to 3 472 per player-week by `SIMS.maxTotalSamples` = 4 M) | 1.7 s, never partial (budget: half the 8 s deadline) |
| E1 cost per sample (draw + quantile sort) | ≈ 0.42 µs |
| seeding simulator, 12 teams, 10 remaining weeks, 10 000 paths, both readings, 8 variants | 1.2 s (budget 5 s) |
| longest event-loop stall (5 ms heartbeat) during the worst E1 call / a 20 000-path season | 30.8 ms / 20.5 ms (bound 50 ms) |

`N_SIMS_MAX = 20 000` (`src/domain/analytics/constants.ts`, mirrored by `src/mcp/bounds.ts`): the
worst in-bounds call is held by `maxTotalSamples`, not by `n_sims`, so 20 000 leaves the worst call
at ~21 % of the CPU deadline uninstrumented (coverage instrumentation runs ~3× slower and still
fits). Samplers yield every ≤ 16 ms of CPU (`COOPERATIVE.batchMs`), adaptively reading the clock
about once per millisecond; post-processing (quantile sorts) is batched too.

**The CPU deadline is switchable by tests only (changelog R5).** The tools pass
`ANALYTICS_CPU_DEADLINE_MS` (8 s) to E1 and the seeding simulator unless the server options carry
`cpuDeadlineMs` (null = off), which only a test's injected options or the composition root under
`EFF_TEST_STUBS=1` in fixture mode set — so plan 10 A8a's injection-invariance run
(`tests/e2e/injection.test.ts`) compares answers with the deadline off and checks each server's
log says so. `tests/mcp/cpu-deadline.test.ts` shows the tools honour it: 0 ms stops E1 after one
sample (`partial: true`, "1 of 4000 samples"), off and the production deadline give identical
answers on the recorded league, and no production configuration reaches the switch.

## Decisions the engines encode (beyond the plan's text)

- E1: ESPN's mean is the point estimate for every active player-week; a structured OUT / IR / SSPD
  status wins over ESPN's number (estimate 0, named). Below P(active) 0.5 the distribution's zero
  mass is held at 0.5 so ESPN's mean stays the estimate (a Doubtful player projected at 12 would
  otherwise need ~200 points when active). `horizon: season` is read as the rest of the season.
- E2: `no_move` only when nothing changes (a coin-flip swap is flagged, still recommended), so the
  `mean` lineup is exactly ESPN's lineup at weight 1.0 and E13's baseline stays identically zero.
- E5: surplus is the lineup gain on my roster (E2's assignment) over the best drop; equal drops are
  broken by the drop's own projected total (the bench effect). `s_with_ir_move` frees the seat with
  no drop — the activation warning carries the research's timing trap. K/D-ST are valued on the
  implied-total bracket model under the league's own S; ESPN's K/D-ST projections are comparators.
- The PA tie-break direction (fewer points against ranks higher) is unverified [U]; it only acts
  after win %, PF and head-to-head all tie.
