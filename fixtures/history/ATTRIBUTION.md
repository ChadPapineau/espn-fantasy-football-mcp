# fixtures/history — attribution and provenance (the third backtest season, 2023)

The data under `nflverse/` is **nflverse data**, © the nflverse contributors, licensed under the
**Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). Snap counts originate from Pro-Football-Reference
and depth charts from ESPN, as redistributed by nflverse.

The data under `ffopportunity/` is **ffopportunity data**, © the ffverse contributors
(<https://github.com/ffverse/ffopportunity>), licensed under the **Creative Commons
Attribution-ShareAlike 4.0 International licence (CC BY-SA 4.0)** —
<https://creativecommons.org/licenses/by-sa/4.0/> — and **shared under the same licence**; see
`ffopportunity/ATTRIBUTION.md`.

Both are redistributed here as test fixtures (plan 05 §3) as **excerpts**: a selection of rows of
each release file, values unchanged. No league, team or member data of any fantasy league is
included — only public NFL data.

**Retrieved:** 2026-10-10, from the GitHub release assets
`https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}` and
`https://github.com/ffverse/ffopportunity/releases/download/latest-data/{file}`. Every upstream
2023 file is the one the third season was grounded on
(`tests/sources/nflverse/helpers/observed-history.ts`, same sha256; `docs/evals/phase3-data.md`).

| Fixture | Rows | Part bytes | Columns kept | Stands in for | Upstream rows / bytes | `nflverse_timestamp` | upstream sha256 |
|---|---|---|---|---|---|---|---|
| `nflverse/stats_player/stats_player_week_2023.excerpt.json` + 1 `.tsv` part | 71 | 38,362 | 150 of 150 | `stats_player/stats_player_week_2023.parquet` | 18,643 / 846,050 | `2026-08-13 12:48:30 EDT` | `ac776fbd7c9fefdb…` |
| `nflverse/stats_team/stats_team_week_2023.excerpt.json` + 1 `.tsv` part | 3 | 3,287 | 138 of 138 | `stats_team/stats_team_week_2023.parquet` | 570 / 128,136 | `2026-08-13 12:48:37 EDT` | `a155e2a9cb2a6bff…` |
| `nflverse/pbp/play_by_play_2023.excerpt.json` + 1 `.tsv` part | 166 | 63,703 | 55 of 372 | `pbp/play_by_play_2023.parquet` | 49,665 / 20,534,088 | `2026-02-12 05:24:17 EST` | `bd3484731408def6…` |
| `nflverse/snap_counts/snap_counts_2023.excerpt.json` + 1 `.tsv` part | 92 | 9,919 | 16 of 16 | `snap_counts/snap_counts_2023.parquet` | 26,540 / 237,882 | — | `97873cab365dfb39…` |
| `nflverse/depth_charts/depth_charts_2023.excerpt.json` + 1 `.tsv` part | 134 | 15,601 | 15 of 15 | `depth_charts/depth_charts_2023.parquet` (pre-2025 layout) | 37,327 / 485,941 | — | `44dbf02554d4a8a7…` |
| `nflverse/injuries/injuries_2023.excerpt.json` + 1 `.tsv` part | 16 | 2,418 | 15 of 16 | `injuries/injuries_2023.parquet` | 5,599 / 126,566 | — | `5d8d881aabd613c3…` |
| `nflverse/schedules/games_2023.excerpt.json` + 1 `.tsv` part | 14 | 5,362 | 46 of 46 | `schedules/games.parquet` (2023 week 9 only) | 7,548 / 522,027 | `2026-10-10 16:16:26 EDT` | `68ab1450807fec52…` |
| `ffopportunity/ep_weekly/ep_weekly_2023.excerpt.json` + 1 `.tsv` part | 21 | 23,947 | 159 of 159 | `latest-data/ep_weekly_2023.parquet` | 6,081 / 1,152,618 | — | `40523f0b2c009ba2…` |

`manifest.json` carries the full sha256 of every committed part and of the exact upstream file it
was cut from (plan 08 §6 step 5), the upstream URL, schema size, writer, codecs (`SNAPPY`) and
encodings. The format (a JSON header with the upstream schema + TSV parts of JSON cells) and the
reason it is text are those of `../nflverse/ATTRIBUTION.md` ("Why text, and how the tests use it");
the tests rebuild parquet from each excerpt with the same names, order, physical and logical types.

## The excerpts

- **One complete 2023 game, `2023_09_BUF_CIN`** (week 9, outdoors; five fixture-roster player rows),
  as 2024 and 2025 have one each in `../nflverse/phase2/`: its **pbp** (every play, markers and
  `no_play` included), **snap counts**, both **team-stat** rows plus the season's first POST row,
  **expected points** (its team-level rows included), the week's **player stats** of BUF and CIN
  (with that week's team-level rows) and their **injury reports**.
- **Depth charts (pre-2025 layout):** every BUF and CIN row of week 9, a real exact-duplicate pair,
  two blank `depth_position` rows, three week-less `SBBYE` rows, and what 2023 adds over 2024: the
  first row of each label outside the contract's closed vocabulary (`DEPTH_LABELS`: `RS`, `ROT`,
  `LE`, `RE`, `LOT`, `WR2`, `J`, `WR1`, `T` — stored as `OTHER`) and two rows whose label fails the
  label grammar (dropped as invalid).
- **Schedules:** every 2023 week-9 game of `games.parquet` (lines, roof, scores). One URL holds every
  season, so the tests serve this excerpt **merged** with `../nflverse/schedules/games.excerpt.json`
  (same 46-column schema, checked by the generator).
- **pbp keeps 55 of 372 columns:** the dataset contract's upstream columns plus `home_team`,
  `away_team`, `game_date`, `drive`, `time` and `desc` (free text that must never reach a dataset
  file). In this file `goal_to_go` is **INT32** (DOUBLE from 2024 on); the contract reads it as the
  same 0/1 flag.
- **injuries 2023** omits `date_modified` (INT64 TIMESTAMP — the test writer has no TIMESTAMP type,
  and the contract does not read it); like 2024, the file has no `season_type` column upstream.

To refresh: download the release files into one directory as `<tag>_<file>` (see the header of
`tests/sources/nflverse/helpers/make-history-fixtures.ts`), run
`scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-history-fixtures.ts <dir>`,
run prettier on the JSON, update this table from `manifest.json`, and review the diff (the scanner
runs at commit).
