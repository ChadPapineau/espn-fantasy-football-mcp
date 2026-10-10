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

## nflverse and ffopportunity — the three backtest seasons, 2023–2025 (2026-10-10)

Owner paths: `src/sources/nflverse/**` (`seasons.ts`, `phase2.ts` `historyFileSeasons`,
`schedules.ts`), `src/store/datasets/tables.ts` (`BACKTEST_SEASON_COUNT`, `backtestSeasonsFor`,
additive), `fixtures/history/**`, `tests/sources/nflverse/**`.

### What the refresh path loads now

| | |
|---|---|
| Seasons | every history file holds **[current − 3, current − 1] = 2023, 2024, 2025** (plan 10 D9 "≥ 3 in Phase 3", [A-3]), whatever seasons a run names; an explicitly named older season adds to them |
| Files | the seven history files — `stats_player_week_history` (+ the derived D/ST lines), `stats_team_week_history`, `pbp_history` (the projected subset), `snap_counts_history`, `injuries_history`, `depth_charts_history` (2025 snapshot runs + the ≤ 2024 weekly layout), `ffopportunity:ep_weekly_history` — and `nflverse:schedules` (one `games.parquet` holds every season: 2023–2025 games with lines are stored beside the run's own) |
| Why at the source | a publish rewrites the whole per-source file (plan 01 §5.5), so a run naming fewer seasons — the CLI's default `[current − 2, current − 1]` for a twin, a one-off `--seasons` — would otherwise shrink the file below what the held-out backtests read. The floor is applied inside the sources, so `eff refresh`, the seed and any other caller get it unchanged |
| Version | a history file: `h<UTC month>_2023-2024-2025` (no request; ascending; the same for a two- or three-season run, so neither re-downloads within the month); schedules: `<timestamp.txt>_2023-2024-2025-2026`. The first refresh after this change republishes each file once with 2023 |
| Gate | unchanged: a history twin runs only while the current season is in progress (or with `--seasons`); outside it every job exits 0 with no request (B1) |

### Per dataset (upstream release files)

All files: one row group, **SNAPPY** on every column chunk (plan 01 D9). The 2024 and 2025 files are
byte-identical to Phase 2's grounding (`docs/evals/phase2-datasets.md`, same sha256); the 2023
files are recorded in `tests/sources/nflverse/helpers/observed-history.ts` (columns, types,
codecs, rows, bytes, sha256).

| source → table | 2023 | 2024 | 2025 | licence |
|---|---|---|---|---|
| `nflverse:stats_player_week` → `ds_stats_player_week` + `ds_team_defense_week` | 846,050 B · 18,643 rows | 849,243 · 18,983 | 855,077 · 19,422 | CC-BY-4.0 |
| `nflverse:stats_team_week` → `ds_stats_team_week` | 128,136 · 570 | 128,118 · 570 | 128,766 · 570 | CC-BY-4.0 |
| `nflverse:pbp` → `ds_pbp` (51 of 372 columns kept) | 20,534,088 · 49,665 | 20,597,560 · 49,492 | 20,337,029 · 48,771 | CC-BY-4.0 |
| `nflverse:snap_counts` → `ds_snap_counts` | 237,882 · 26,540 | 240,862 · 26,615 | 242,046 · 26,613 | CC-BY-4.0 (Pro-Football-Reference via nflverse) |
| `nflverse:depth_charts` → `ds_depth_charts_legacy` (≤ 2024) / `ds_depth_charts` (2025) | 485,941 · 37,327 (legacy layout) | 482,923 · 37,312 (legacy) | 2,584,724 · 554,215 (snapshots) | CC-BY-4.0 (ESPN via nflverse) |
| `nflverse:injuries` → `ds_injuries` | 126,566 · 5,599 | 139,253 · 6,215 | 97,472 · 6,068 | CC-BY-4.0 |
| `ffopportunity:ep_weekly` → `ds_ep_weekly` | 1,152,618 · 6,081 | 1,125,932 · 6,005 | 1,131,935 · 6,054 | **CC-BY-SA-4.0** (separable file, attributed) |
| `nflverse:schedules` → `ds_schedules` (`games.parquet`, every season) | 285 games, all with spread, total, moneylines and score | 285, all | 285, all | CC-BY-4.0 |

`games.parquet` read on 2026-10-10: 522,027 B, 7,548 rows (1999–2026), 46 columns, rebuilt daily
upstream (so its hash is not pinned).

**2023 against 2024:** the same columns in every file; **one type change** — pbp `goal_to_go` is
INT32 in 2023 and DOUBLE from 2024. The assertion admits an integer where it reads a double
(widening loses nothing) and `flag01` stores the same 0/1 (2023: 0/1 on every kept play, checked
against the upstream counts on the fixture and > 2,000 goal-to-go plays on the real file); an
out-of-range integer stores NULL, never a flag (tested). `injuries_2023` has no `season_type` and
carries `date_modified`, as 2024 does; neither is read by the contract.

### Published history files (real runner + publisher, the real files, this Intel Mac)

| file | rows stored | dropped / noted at load | bytes | wall |
|---|---|---|---|---|
| `nflverse:stats_player_week_history` | 56,982 player-weeks + 1,710 D/ST lines | 66 null `player_id`; 17 team-level rows credited to their team | 12,881,920 | 2.7 s |
| `nflverse:stats_team_week_history` | 1,710 | 0 | 475,136 | 0.2 s |
| `nflverse:pbp_history` | 129,371 | 18,557 markers / `no_play` | 30,314,496 | 5.0 s |
| `nflverse:snap_counts_history` | 79,768 | 0 | 11,939,840 | 1.8 s |
| `nflverse:injuries_history` | 17,880 | 2 duplicate keys (both 2024's, as in Phase 2; 2023 has none) | 2,818,048 | 0.3 s |
| `nflverse:depth_charts_history` | 18,254 runs (2025) + 73,799 legacy rows (2023 + 2024) | 384 exact duplicates collapsed, 448 week-less `SBBYE` rows, 8 rows with an ungrammatical label (2023); 252 rows' label stored as `OTHER` (2023) | 15,249,408 | 4.0 s |
| `ffopportunity:ep_weekly_history` | 16,860 | 1,280 team-level rows (no `player_id`) | 4,915,200 | 0.7 s |
| `nflverse:schedules` (2023–2026) | 1,127 games + 43 venues | 0 | 356,352 | 0.3 s |
| **the seven history files** | | | **78,594,048** | 14.7 s |

Each three-season file is exactly 2023 alone plus Phase 2's two-season record (pbp 43,658 +
85,713; snaps 26,540 + 53,228; expected points 5,643 + 11,217; team-weeks 570 + 1,140; legacy
depth rows 36,922 + 36,877 — `phase3-real.test.ts`).

### What the grounding verified (2023, the new season)

- **Schema and codec:** for every source the contract's required upstream columns exist in the
  2023 file with a type the assertion admits; every codec is SNAPPY (`history-fixtures.test.ts`,
  offline over the observed record, in CI).
- **pbp counting = nflverse's own counting on every 2023 player-week** (the definitions plan 07 D1
  and E5 rely on; Phase 2 verified 2024–2026): targets 4,594/4,594, receptions 4,594/4,594 (every
  targeted player-week), carries 2,379/2,379, passing TDs 464/464, receiving TDs 719/719, rushing
  TDs 419/419, FG attempts 499/499, FGs made 475/475 — against `stats_player_week_2023`.
- **Depth-chart labels (2023 only):** nine well-formed labels outside the contract's closed
  vocabulary — `RS` 39, `ROT` 38, `LE` 38, `RE` 38, `LOT` 37, `WR2` 24, `J` 19, `WR1` 16, `T` 3
  rows — are stored as `OTHER` (the row kept, the text not), and 8 rows labelled `WR\8` fail the
  label grammar and are dropped. No upstream label outside the vocabulary reaches the file.
  Consequence for C6 (cascade, "next man up"): 40 rows of 2023 WR depth (`WR1`/`WR2`) read as
  `OTHER`; adding these labels to `DEPTH_LABELS` (`src/store/datasets/derive.ts`, not this stage's
  path) would keep them — requested, not done here.
- **Readers:** the Phase-2 reader statements answer for 2023 from the history files (snap counts,
  expected points for `2023_09_BUF_CIN`, the pbp team profile; `history-seasons.test.ts`).

### Size against plan 01 §5.8 ("store < 150 MB for a season")

The seven history files are 78.6 MB with three seasons (Phase 2's two: ≈ 51 MB). An **estimate**
for the end of a season, from the Phase-2 week-4 measurements scaled to 18 weeks: current-season
dataset files ≈ 35–40 MB (pbp ≈ 10, the stats file's two seasons ≈ 8.7, snaps ≈ 4, depth runs ≈ 3,
expected points ≈ 1.7, players + rosters + the rest ≈ 10), the ESPN cache < 20 MB, news ≤ 5 MB,
pool snapshots ≈ 30 MB — ≈ 170 MB, over the 150 MB the plan states (doctor warns at 500 MB, so
nothing fails). The third season alone adds ≈ 27 MB (pbp + 10.3, depth + 6.1, snaps + 4.0, stats
+ 4.2, expected points + 1.6, injuries + 0.9, team stats + 0.2). The levers, if a ruling wants
150 MB kept: drop the legacy depth-chart rows of the oldest season (≈ 6 MB) or narrow the pbp
projection. Recorded as an open item for the orchestrator; not changed here.

### Committed for tests (small excerpts only)

`fixtures/history/` (≈ 250 KB, `ATTRIBUTION.md` + `ffopportunity/ATTRIBUTION.md`, `manifest.json`
pinning every part's and every upstream file's sha256): one complete 2023 game,
`2023_09_BUF_CIN`, per per-season dataset (its pbp, snaps, team stats + the first POST row,
expected points, the week's player stats and injury reports of both teams), the legacy depth
chart's edge rows (duplicates, blank `depth_position`, `SBBYE`, each out-of-vocabulary label and
the ungrammatical one), and 2023's week 9 of `games.parquet` (served merged with the Phase-1 games
excerpt). `allFixtureRoutes()` serves them, so the seeded worlds (integration, stdio E2E,
plugin-eval) publish all three seasons through the real runner. Regenerate with
`tests/sources/nflverse/helpers/make-history-fixtures.ts`.

### Reproduce

```sh
# download (nflverse + ffopportunity release files only) into a directory OUTSIDE the repo, named
# <tag>_<file>: stats_player_stats_player_week_2023.parquet, pbp_play_by_play_2024.parquet,
# ffopportunity_ep_weekly_2025.parquet, schedules_games.parquet, <tag>_timestamp.txt, …
PHASE3_RELEASE_DIR=<dir> scripts/dev/heavy-lock.sh scripts/dev/with-node.sh \
  npx vitest run --project unit tests/sources/nflverse/phase3-real.test.ts
```
