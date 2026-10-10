# Phase 3 data — what was recorded, what ESPN serves, what still needs time

Plan 10 §3.3 (C1–C10). Each section names its owner's paths; numbers are measured, never estimated.

## ESPN previous seasons — keyless recording of the probe leagues (2026-10-10)

Owner paths: `scripts/record-fixture.ts --history`, `scripts/espn-fixture/history.ts`,
`fixtures/espn/recorded/history/**`, `tests/fixtures/history*.test.ts`.

### What was recorded

| | |
|---|---|
| Leagues | the three public probe leagues (D2), bound to the committed slots `league-a`, `league-b`, `league-c` by their `status.previousSeasons` (a season's list must equal the committed current-season list cut below it, else the run stops before any further request) |
| Seasons | **2023, 2024, 2025** for every league (≥ 3 historical seasons, [A-3]) |
| Per league-season | `mSettings`; `mTeam` + `mStandings` (records, points for, `playoffSeed`, `rankCalculatedFinal`, divisions, the standings schedule); `mMatchup` (every regular-season and playoff row with its winner, totals, `pointsByScoringPeriod`, `cumulativeScore`) |
| Weekly projections | every scoring period 1–17 of `league-b` in **2024 and 2025** as `mBoxscore` (each roster entry carries that week's actual `statSourceId 0` and ESPN's projection `statSourceId 1, statSplitTypeId 1`, id `11<season><week>`), plus that season's `proTeamSchedules_wl` (every game `statsOfficial: true`) |
| Files | 67 fixtures + `recorded/history/manifest.json`, 24.7 MB, each ≤ 1 MB (four `mMatchup` bodies split losslessly along `schedule`) |
| Requests | **66** keyless GETs to the read host in total, ≥ 1.2 s apart, no cookie: 60 by the recorder, 6 exploratory (3 of them reused as captures). Cap for the stage: 90 |
| Index | `fixtures/espn/recorded/history/manifest.json` — the recording manifest's entry shape (sha256 of the canonical scrubbed body, the scoring-field hash re-verified against the raw recording, `withheld`, `incomplete`), plus a value-free summary per league-season. Kept apart from `fixtures/espn/manifest.json`, whose hash the drift entity manifest binds. Fixture mode serves a previous season from it: `createFixtureFetch({ manifest: "recorded/history/manifest.json" })` |

### What ESPN serves keylessly

- **Every attempted season was served** (9/9 league-seasons, HTTP 200). No season was refused, so
  the manifest carries no `served: false` entry; the code path for one (a typed 4xx recorded,
  never retried, nothing else requested for that league-season) is tested on the fake host.
- **Not attempted** (listed by ESPN, outside this run's window): `league-a` 2018–2022, `league-b`
  2016–2022, `league-c` 2006–2022 — each in the manifest's `not_attempted`. Seasons before 2018 sit
  on the `leagueHistory` route (research 03 §A.1), which this recorder does not use; their keyless
  availability is untested.
- **Finding — on a previous season only the box score carries ESPN's weekly projections.** On the
  league route of a finished season, `kona_player_info` returned the weekly *actuals* and the
  season splits only: weekly projection ids (`11<season><week>`) in
  `filterStatsForTopScoringPeriodIds.additionalValue` were ignored; without a stats filter only
  the season splits came back; `useFullProjectionTable` with `filterStatsForSourceIds [1]` and
  `filterStatsForSplitTypeIds [1]` returned no stats at all (three exploratory requests). So the
  projections cost one request per week, which with ≤ 90 requests fits one league for two
  seasons: `league-b` was chosen as the closest to the reference format (10 teams, half-PPR). The
  raw projected `stats` re-score under any league's scoring; the recorded `appliedTotal` is
  `league-b`'s.
- **Not in a finished season's payload:** `teams[].currentSimulationResults` (ESPN's `playoffPct`)
  is absent from every previous season's `mTeam`, and `mMatchup` rows carry no `playoffTierType`
  (a playoff row is `matchupPeriodId > matchupPeriodCount`).

### Inputs per acceptance item

- **C4 (seeding reproduction) — inputs complete on 9/9 league-seasons.** `playoffSeed` is a
  permutation of 1..N in every season; every schedule row is decided; the regular season is
  complete (each team once per period); every team's record and points for equal its
  regular-season results to 0.01 (cross-view, tested). Observed on the recorded data (a fact, not
  the C4 simulator): ESPN's `TOTAL_POINTS_SCORED` reading (a) — win % first, points for as the
  tiebreak — reproduces every team's `playoffSeed` exactly in all six `league-a`/`league-b`
  seasons; `league-c` (four divisions, `playoffSeedingRuleBy: -1`) reproduces exactly once the
  division winners are seeded first. No recorded league uses the points-only reading (b), and no
  season needed a tiebreak below points for.
- **C1 (projection backtest vs ESPN) — inputs for two held-out seasons.** 2,528 (2024) and 2,530
  (2025) weekly projections, on 5,058 of 5,067 roster entries (99.8 %); every starter's actual sums
  to the team's points for that period (team-weeks without a withheld entry; tested). Whether these stored projections are the as-of-kickoff
  values is still [U] (research 04 §G item 1). Under the owner's league's own scoring this needs
  the live league (Stage C).
- **C3 (P(win) and P(playoffs) vs ESPN) — replay inputs present; the ESPN side needs time.** The
  full schedule results and per-period points support the replay; ESPN's `winProbability` exists
  only in in-season `mMatchupScore` snapshots and its `playoffPct` only in in-season `mTeam`, so
  both comparisons are **needs_time** until scoreboard snapshots accrue (the code paths are tested
  on fixtures, never faked).

### Withheld units (value-free)

A numeric token in a public player's entry matched the owner's local deny-list (a public id
coinciding with a private term). With `--withhold-denylisted` the smallest unit is removed —
in a box score the **roster entry**, never the matchup row (so totals and the other entries stay);
in `mMatchup` the final-roster entry; in `proTeamSchedules_wl` one team's `teamPlayersByPosition`.
78 units in 45 files, each listed by JSON path in `withheld` and summarised in `incomplete`
(`team_ids`, `matchups_missing: 0`). Consumers skip a team-week listed in `incomplete` when they
sum entries.

### Reproduce

```sh
# keyless, ids from the environment only (never committed); raw captures stay outside the repo
EFF_PROBE_LEAGUE_IDS=<a>,<b>,<c> scripts/dev/with-node.sh npx tsx scripts/record-fixture.ts \
  --public --history --withhold-denylisted --raw-dir <dir outside the repo>
# offline re-scrub of a stored run (no network, no league id): byte-identical output
scripts/dev/with-node.sh npx tsx scripts/record-fixture.ts --public --history --scrub-only \
  --withhold-denylisted --raw-dir <the same dir>
```
