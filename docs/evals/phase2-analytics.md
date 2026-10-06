# Phase 2 analytics — the market engines, what is gated and what is reported

Scope: the Phase-2 market engines in `src/domain/analytics/` (plan 10 §3.2, acceptance B3–B6):
E5 at P1 (usage signals, per-rival and fitted demand, the learned waiver mechanics, `mode: faab`),
E6 trade, E7 injury cascade, E10 evidence (composed from the evidence domain,
`src/domain/evidence/`), E11 league activity and E1's `player_sim` hook. The public surface is
[`phase2.ts`](../../src/domain/analytics/phase2.ts); every tuning constant is in
[`marketConstants.ts`](../../src/domain/analytics/marketConstants.ts). The hard parts run in CI on
every push; the soft numbers below were **measured once** (2026-10-06) with the harness
[`tests/domain/analytics/phase2-soft-backtest.ts`](../../tests/domain/analytics/phase2-soft-backtest.ts)
on the nflverse and ffopportunity release files the sources engineer downloaded (outside the repo,
never committed), and on `fx-10h`'s own feed. They are reported, never gated (plan 10 §3.2 exit
gate: "reported: the soft parts of B3–B6").

Re-run: `scripts/dev/with-node.sh npx tsx tests/domain/analytics/phase2-soft-backtest.ts <dir>` where
`<dir>` holds `stats_player_week_{2024,2025}.parquet`, `snap_counts_{2024,2025}.parquet`,
`ep_weekly_{2024,2025}.parquet` and `players.parquet`. No network; no cookie.

## B3 — waiver detection

**Hard (CI, [`waivers-p1.test.ts`](../../tests/domain/analytics/waivers-p1.test.ts),
[`usage-signals.test.ts`](../../tests/domain/analytics/usage-signals.test.ts)):** every candidate's
`signals[]` cites a finite numeric `evidence` (a property over arbitrary usage, and P0's K/D-ST
`stream` signal now carries its number too); `percent_change` never appears in `signals[]` — the
detector's input type has no ownership field, and changing every candidate's `percent_change`
changes no signal; `value_basis` flips to `ensemble` when E1's values are passed and the Π rule still
holds for every candidate (claim ⇔ s ≥ Π outside the band, `marginal` inside it and never in
`claim_list`; a property over random candidates). With nothing new, the P1 layer reproduces P0's
output exactly (bar the stream signal's evidence).

**Soft (measured once).** Decision weeks 5–14; "available" = season-to-date points per game below
RB36 / WR38 / TE14 (research 05 §1.6); a hit = top-24 RB/WR or top-12 TE over the next four weeks;
the points-only detector takes the same number of picks each week from last week's top available
scorers (equal recall budget). Half-PPR points from nflverse's standard and PPR columns; xFP is
ffopportunity's (PPR on both sides of the gap). `rz_shift`, `depth_chart` and `implied_total` need
pbp, chart and line inputs the harness does not join — not backtested.

| season | signal | picks | usage precision | points-only precision |
|---|---|---:|---:|---:|
| 2024 | `snap_jump` | 186 | 0.065 | 0.183 |
| 2024 | `target_share_jump` | 111 | 0.072 | 0.207 |
| 2024 | `xfp_gap` | 440 | 0.089 | 0.164 |
| 2024 | any | 633 | 0.084 | 0.156 |
| 2025 | `snap_jump` | 192 | 0.094 | 0.214 |
| 2025 | `target_share_jump` | 94 | 0.117 | 0.234 |
| 2025 | `xfp_gap` | 378 | 0.119 | 0.185 |
| 2025 | any | 575 | 0.104 | 0.193 |

**Reading.** On these two seasons, with the cold-start thresholds and no P(role holds) filter beyond
the teammate-absence rule, the usage detector does **not** beat the points-only detector at equal
picks — research 05 §8.4's "working" bar is not met. This is the honest P1 result: the signals are
shipped as *explanation and evidence* (every one cites its number, and the surplus rule, not the
signal, decides the claim — E5 states this in an assumption), and Phase 3's re-fit of the
thresholds (plan 10 §3.3) is what must move this table. Two known biases: the "available" pool by
season points per game keeps early-season busts whose xFP gap is large (they inflate `xfp_gap`
picks), and the outcome is a top-24 finish, which favours players already scoring.

## B4 — the demand model

**Hard (CI, [`demand.test.ts`](../../tests/domain/analytics/demand.test.ts),
[`league-activity.test.ts`](../../tests/domain/analytics/league-activity.test.ts)):**
`learned.second_claim_at_new_position` is null until the feed shows the case and flips on a same-run
pair fixture — **true** when a team that won one claim lost another to a team ranked behind it
before the run (only possible once it had dropped below that team), **false** when it won two claims
each contested and lost by teams ranked behind it; conflicting runs read null; a run without its
stored order before is never guessed. `fx-10h`'s own week-2 pair (Team 1's two wins) is uncontested
on the second player, so on `fx-10h` itself the field stays null — the fixture does not show the case.
The fit recovers a planted upgrade effect, beats the cold-start curve's Brier on data drawn from it,
and refuses fewer than 20 rows or one-sided labels.

**Soft (measured once, `fx-10h`, in sample, two runs).** Features: `r` = ESPN's weekly projection
for the run's scoring period above a replacement level by position; no rival-upgrade feature (the
rosters at each run are not reconstructed), no trend; activity from earlier runs.

| rows | claims | Brier cold-start | Brier fitted | coefficients (a, b, c, d) |
|---|---:|---:|---:|---|
| (a) every unowned pool player claimable in both runs: 2,890 | 13 | 0.10332 | 0.00448 | −5.386, −0.066, 0, 0.301 |
| (b) only the 12 players someone claimed × 10 teams: 120 | 13 | 0.10586 | 0.0963 | −1.989, −0.136, 0, 0.150 |

**Reading.** (a) is dominated by the base rate (13 claims in 2,890 rows): the cold-start curve's
5 % floor is far above it, so any fit "wins" — not evidence. (b) is the question that matters (which
rival claims a contested player) and the fit barely beats the curve with a negative `r` coefficient:
two runs carry no signal. `premium_basis` stays `cold_start_table` and E5 uses a fit only when the
tool supplies one; the per-rival cold-start reading (the curve at each rival's own lineup gain) is
the default.

## B5 — the trade evaluator

**Hard (CI, [`trade.test.ts`](../../tests/domain/analytics/trade.test.ts)):** a 2-for-1 (any uneven
trade) always carries `implied_drop`, naming the receiving side and never one of the players it
receives, `forced: true` when the active roster overflows (the drop is inside Δ) and `forced: false`
when an open seat absorbs the extra player — a property over random uneven offers; `verdict: fair`
iff the `delta_me` [p10, p90] interval spans 0 (a property over random offers; `accept` iff p10 > 0;
`counter`/`decline` iff p90 < 0); `delta_u` is present under the configured reading (one row) and
under both readings when `seeding_mode: "both"` is passed explicitly on an unconfirmed reading
(`seeding.confirmed: false`, two rows, `me`/`partner` the configured reading's); with no season
simulation the basis is `cold_start` and the numbers stay finite; the deadline is
`tradeSettings.deadlineDate`, and after it the result is `no_move` with no execution time; a partner
name shaped like an instruction changes no number, no verdict and no action (research 05 §6 case 4);
partner search proposes only Δ_partner ≥ ε with Δ_me > 0.

**Soft.** Δ sign accuracy against realised rest-of-season lineup points needs recorded trades:
`fx-10h`'s feed has **no `TRADE_ACCEPT` row** and the three recorded probe leagues carry no
transaction feed, so the number is **not computable** in this stage (owner decision D8: no extra
fixture league). It becomes computable the first time the owner's league accepts a trade.

Measured once (Intel Mac, development build): an offer with 200 Monte-Carlo paths over 14 weeks
(2-for-1, both drops priced) 305 ms; a partner search over nine teams 1.25 s; the longest event-loop
gap during both 24 ms (the search, the counters and the paths run cooperatively).

## B6 — the injury cascade

**Hard (CI, [`cascade.test.ts`](../../tests/domain/analytics/cascade.test.ts)):** the
beneficiaries' shares never sum above the vacated share, component by component (targets, carries,
red-zone opportunities), with or without team evidence — a property over random teammates, injured
shares, team games and reception points, on both the shares and the per-game counts; without team
evidence only a retained fraction (85–90 %) is redistributed, with ≥ 2 games of team evidence the
blend is capped at the vacated share; `hypothesis_only = true` whenever team_games = 0 ∧
usage_confirmed = false ∧ market_move = null (a property; a market reading below 0.5 is not a move);
`ir_consequence.ir_eligible` is true only for `OUT` / `INJURY_RESERVE`, from the structured status,
for every ESPN status and unknown strings (`PUP`, `NFI`, a lower-case `out`).

**Soft (measured once).** An absence = a team's RB1 (by carries) or WR1/TE1 (by targets) who played
week t−1 and neither of weeks t, t+1 while the team played; the realised top beneficiary = the
teammate with the largest gain in targets + carries per game over the two games.

| season | absences | cascade top-beneficiary hit rate | next-man-up hit rate |
|---|---:|---:|---:|
| 2024 | 42 | 0.214 | 0.286 |
| 2025 | 39 | 0.154 | 0.154 |

**Reading.** The role-affinity prior does not beat next-man-up on top-beneficiary identity
(research 05's "working" bar is MAE below next-man-up *and* a higher hit rate). The harness runs the
cascade with no red-zone shares and no team evidence — the prior alone — and the realised measure
counts any teammate (an outside receiver's targets often go to a back or the tight end, which
next-man-up never names but the cascade can). The redistribution prior table from pbp history is a
Phase-3 build (plan 10 §3.3); this table is its baseline.

## E10 — evidence

The `rules_v1` extractor, the hand-set reliability table (with the season-outlook decay and the
injection cap) and the class-based `injury_status` comparator are the evidence domain's
(`src/domain/evidence/`, tested in `tests/domain/evidence/`, B8's labelled set included). E10
composes them and adds its own comparisons — the official practice participation, the IR slot, the
lineup lock, `waiverProcessDate` and usage — and the text-invariant recommendation:
[`evidence.test.ts`](../../tests/domain/analytics/evidence.test.ts) covers the `inj-ir-cleared`
shape (`structured_disagrees` names `injury_status`, "no move"), NC-1 to NC-4, the system-prompt
outlook (flagged, quoted, the recommendation unchanged), league-member text never entering, and a
property: the recommendation is identical with any texts, any sources and any pasted claim.
`calibration_state.note` is on every result; `posterior` is null at P1.

## E1 — the `player_sim` hook

[`playerSim.ts`](../../src/domain/analytics/playerSim.ts) simulates targets and carries (Poisson
around a gamma game-script multiplier), receptions, yards and touchdowns, scores every line through
the plan 08 engine under the league's S, and rescales to ESPN's mean (weight_espn = 1.0): the mean is
ESPN's exactly, the shape is the opportunity model's. Only RB/WR/TE with ≥ 3 games of volume qualify;
a QB keeps `position_cv`. [`player-sim.test.ts`](../../tests/domain/analytics/player-sim.test.ts):
basis, the anchored mean, determinism per seed, the P(active) zero mass with E1's floor, the rescale
clamp, and that a full-PPR league raises a receiver's simulated mean at the same anchor.

## Decisions taken where the plan is silent (simplest safe option)

- **E5 P1 composes P0, it does not fork it.** `analyzeWaiversP1` runs `analyzeWaivers` for s, Π and
  the band (unchanged) and layers signals, demand, learned mechanics and FAAB on top. P(role holds)
  stays the cold-start prior: usage signals detect and explain, they do not yet move s (an
  assumption on every result) — moving it needs a hook in `waivers.ts`.
- **FAAB valuation** reuses P0's surplus with no priority premium (the order is irrelevant to a bid);
  a candidate is a claim iff its best bid has a positive expected net value; `data.faab` is the top
  claim's bid and every open candidate carries its own (`bid`, additive).
- **ΔU** scales the seeding simulator's +3 points-per-week marginal value linearly by the trade's
  regular-season Δ per week, clamped to [−p, 1 − p]; a re-run of the simulator on the traded rosters
  is the tool's option.
- **`implied_drop.forced`, `DeltaU.basis`/`by_reading`, `InjuryCascadeData.vacated`,
  `WaiverCandidate.bid`** are additive contract fields (types.ts).
- **E7 verdicts** come through an injected evaluator (the tool wires it to E5 at P1), so a
  beneficiary's claim / pass is E5's rule and `marginal` is E5's band; an ONTEAM beneficiary has none.
- **Learned mechanics** need the waiver order before each run (stored standings snapshots); without
  it every field stays null — never inferred from the order of rows in the feed.
