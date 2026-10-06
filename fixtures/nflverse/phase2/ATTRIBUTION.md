# fixtures/nflverse/phase2 — attribution and provenance

The data in this directory is **nflverse data**, © the nflverse contributors, licensed under the
**Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). Snap counts originate from Pro-Football-Reference
and depth charts from ESPN, as redistributed by nflverse. It is redistributed here as test fixtures
(plan 05 §3) as **excerpts**: a selection of rows of each release file, values unchanged. No
league, team or member data of any fantasy league is included — only public NFL data.

**Retrieved:** 2026-10-06, from the GitHub release assets
`https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}`. Every upstream file is
the one the Phase-2 dataset contract was grounded on (`tests/store/datasets/observed-phase2.ts`,
same sha256).

| Fixture | Rows | Part bytes | Columns kept | Stands in for | Upstream rows / bytes | `nflverse_timestamp` | upstream sha256 |
|---|---|---|---|---|---|---|---|
| `stats_team/stats_team_week_2026.excerpt.json` + 1 `.tsv` part | 60 | 27,476 | 138 of 138 | `stats_team/stats_team_week_2026.parquet` | 128 / 74,271 | `2026-10-06 11:55:06 EDT` | `428affe2a4f290cc…` |
| `stats_team/stats_team_week_2025.excerpt.json` + 1 `.tsv` part | 3 | 3,291 | 138 of 138 | `stats_team/stats_team_week_2025.parquet` | 570 / 128,766 | `2026-08-13 12:51:22 EDT` | `ec168d98ebbcb0d1…` |
| `stats_team/stats_team_week_2024.excerpt.json` + 1 `.tsv` part | 3 | 3,285 | 138 of 138 | `stats_team/stats_team_week_2024.parquet` | 570 / 128,118 | `2026-08-13 12:49:11 EDT` | `c95aca86417589ed…` |
| `pbp/play_by_play_2026.excerpt.json` + 1 `.tsv` part | 597 | 225,686 | 55 of 372 | `pbp/play_by_play_2026.parquet` | 11,155 / 4,849,154 | `2026-10-06 11:53:33 EDT` | `d1689918c262c5ea…` |
| `pbp/play_by_play_2025.excerpt.json` + 1 `.tsv` part | 182 | 70,939 | 55 of 372 | `pbp/play_by_play_2025.parquet` | 48,771 / 20,337,029 | `2026-08-13 08:26:02 EDT` | `c6ecedd6d678cc37…` |
| `pbp/play_by_play_2024.excerpt.json` + 1 `.tsv` part | 185 | 72,087 | 55 of 372 | `pbp/play_by_play_2024.parquet` | 49,492 / 20,597,560 | `2026-08-13 08:26:18 EDT` | `3fd2896bc0b911b6…` |
| `snap_counts/snap_counts_2026.excerpt.json` + 1 `.tsv` part | 346 | 36,268 | 16 of 16 | `snap_counts/snap_counts_2026.parquet` | 5,970 / 83,636 | `2026-10-06 07:01:45 EDT` | `51549f93e1e70999…` |
| `snap_counts/snap_counts_2025.excerpt.json` + 1 `.tsv` part | 95 | 10,286 | 16 of 16 | `snap_counts/snap_counts_2025.parquet` | 26,613 / 242,046 | `2026-09-24 08:50:29 EDT` | `47220218fecda7af…` |
| `snap_counts/snap_counts_2024.excerpt.json` + 1 `.tsv` part | 91 | 9,878 | 16 of 16 | `snap_counts/snap_counts_2024.parquet` | 26,615 / 240,862 | — | `9ec66a0c755939b3…` |
| `depth_charts/depth_charts_2026.excerpt.json` + 1 `.tsv` part | 593 | 67,043 | 12 of 12 | `depth_charts/depth_charts_2026.parquet` | 613,196 / 2,812,797 | `2026-10-06 10:08:52 EDT` | `eb3eb03833a2dc53…` |
| `depth_charts/depth_charts_2025.excerpt.json` + 1 `.tsv` part | 284 | 32,927 | 12 of 12 | `depth_charts/depth_charts_2025.parquet` | 554,215 / 2,584,724 | `2026-03-14 03:32:12 EDT` | `14f74185b3c2c48d…` |
| `depth_charts/depth_charts_2024.excerpt.json` + 1 `.tsv` part | 124 | 14,607 | 15 of 15 | `depth_charts/depth_charts_2024.parquet` (pre-2025 layout) | 37,312 / 482,923 | — | `2b5e72fa37f6a498…` |
| `stats_player/stats_player_week_2025.excerpt.json` + 1 `.tsv` part | 73 | 39,732 | 150 of 150 | `stats_player/stats_player_week_2025.parquet` | 19,422 / 855,077 | `2026-08-13 12:51:20 EDT` | `2a461becaa9adb3c…` |
| `stats_player/stats_player_week_2024.excerpt.json` + 1 `.tsv` part | 66 | 36,328 | 150 of 150 | `stats_player/stats_player_week_2024.parquet` | 18,983 / 849,243 | `2026-08-13 12:49:08 EDT` | `847569d194ca3d96…` |
| `injuries/injuries_2025.excerpt.json` + 1 `.tsv` part | 30 | 4,737 | 16 of 16 | `injuries/injuries_2025.parquet` | 6,068 / 97,472 | `2026-09-07 08:23:38 EDT` | `c7637c2f63471944…` |
| `injuries/injuries_2024.excerpt.json` + 1 `.tsv` part | 29 | 4,121 | 15 of 16 | `injuries/injuries_2024.parquet` | 6,215 / 139,253 | — | `7ebabbba930a70bc…` |
| `{tag}/timestamp.txt` (stats_team, pbp, snap_counts, depth_charts) | — | 24 each | — | `{tag}/timestamp.txt` | verbatim | — | — |

`manifest.json` carries the full sha256 of every committed part and of the exact upstream file it
was cut from (plan 08 §6 step 5), the upstream URL, schema size, writer, codecs (`SNAPPY`) and
encodings. The format (a JSON header with the upstream schema + TSV parts of JSON cells) and the
reason it is text are those of `../ATTRIBUTION.md` ("Why text, and how the tests use it"); the
tests rebuild parquet from each excerpt with the same names, order, physical and logical types.

## The excerpts

- **2026 (the current season):** three complete games, one a week — `2026_01_NO_DET`,
  `2026_02_LV_LAC` (a safety, kneels), `2026_03_LA_DEN` (a return touchdown, two-point tries,
  spikes) — so every team share has its whole-game denominator: their **pbp** (every play, the
  period/timeout markers and `no_play` rows included), **snap counts** (both teams), plus the
  fixture-roster players' snap rows of weeks 1–3; **team stats** of weeks 1–3 for every
  fixture-roster team, team unit and game team; **depth charts**: the fixture-roster players' rows
  (by `espn_id`) of the newest 21 daily snapshots, plus every DET row of the newest snapshot.
- **2025 and 2024 (the history twins):** one complete game each — `2025_07_WAS_DAL` (a safety, a
  return TD, a two-point try) and `2024_04_SEA_DET` — its pbp, snaps, both team-stat rows and the
  season's first POST row; the week's player stats of both teams (with that week's team-level rows)
  and injury reports; depth charts: the 2025 snapshot layout's WAS + DAL rows of the two snapshots
  bracketing kickoff, and the **pre-2025 layout** (2024): every SEA + DET row of week 4 plus a real
  exact-duplicate pair, blank `depth_position` rows and three week-less `SBBYE` rows.
- **pbp keeps 55 of 372 columns:** the dataset contract's upstream columns
  (`phase2RequiredUpstreamColumns`) plus `home_team`, `away_team`, `game_date`, `drive`, `time`
  and `desc` — columns the contract does not read, so a test sees the source's projection (`desc`
  is free text that must never reach a dataset file).
- **injuries 2024** omits `date_modified` (INT64 TIMESTAMP — the test writer has no TIMESTAMP type,
  and the contract does not read it); that file also has no `season_type` column upstream.

To refresh: download the release files into one directory as `<tag>_<file>` and
`<tag>_timestamp.txt` (plus ffopportunity's, see `../../ffopportunity/ATTRIBUTION.md`), run
`scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-phase2-fixtures.ts <dir>`,
run prettier on the JSON, update this table from `manifest.json`, and review the diff (the scanner
runs at commit).
