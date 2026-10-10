# tests/domain/analytics/projections-v2/data — attribution, provenance and licences

The C1 projection-backtest excerpt (plan 10 §3.3 C1 and D9: three nflverse seasons — 2023 tunes the
`v2-opportunity` parameters, 2024 and 2025 are held out; research 05 §8.4 #2). Public NFL data only:
no league, team or member data of any fantasy league is included. The only fantasy-platform values are
the ESPN player ids of the players in league-b's recorded box scores (`espn_xwalk`), which are public
NFL player ids.

## Licences

- **nflverse data** (every file except `ep_week_*`) — © the nflverse contributors, licensed under the
  **Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
  <https://github.com/nflverse/nflverse-data>, <https://creativecommons.org/licenses/by/4.0/>.
- **ffopportunity data** (`ep_week_*` only) — © the ffverse contributors
  (<https://github.com/ffverse/ffopportunity>), licensed under the **Creative Commons
  Attribution-ShareAlike 4.0 International licence (CC BY-SA 4.0)** —
  <https://creativecommons.org/licenses/by-sa/4.0/>. These files are an adaptation (a selection of
  rows and columns, values rounded to 4 decimals) and are **shared under the same licence**. The
  share-alike condition attaches to these files only — they are kept apart from the nflverse tables
  for that reason — and not to the code that reads them (research 04 §E).

## What each table is

All rows: the regular season, weeks 1–18 (week 18 feeds the next season's trailing window; the
backtest scores weeks 1–17, ESPN's `finalScoringPeriod`), positions QB/RB/WR/TE.

| Table | Cut from | Columns |
|---|---|---|
| `player_week_<s>` | `stats_player/stats_player_week_<s>.parquet`, joined to `snap_counts/snap_counts_<s>.parquet` on `players/players.parquet`'s `pfr_id`, and to counts from `pbp/play_by_play_<s>.parquet` | the keys; every column the scoring translator reads for a stat the reference leagues score (the B7 excerpt's set — its 2024–2025 cells are equal, `data.test.ts`); attempts, completions, sacks, carries, targets, air yards; the offensive snap share; red-zone (`yardline_100` ≤ 20) targets and carries and goal-line (≤ 5) carries, and the touchdowns on them (two-point tries excluded) |
| `team_week_<s>` | `stats_team/stats_team_week_<s>.parquet`, `schedules/games.parquet`, `pbp/play_by_play_<s>.parquet` | the offence's attempts, sacks, carries, targets; the score; the market line from the team's side (`spread` > 0 = favoured — nflverse's `spread_line` is the home side's), `total_line`, roof, temperature, wind; pbp's pass/run plays, dropbacks, designed rushes, red-zone plays and the sum and count of `xpass` |
| `injury_week_<s>` | `injuries/injuries_<s>.parquet` | the final report and practice status only (no injury text, no names) |
| `ep_week_<s>` | ffopportunity `latest-data/ep_weekly_<s>.parquet` | expected receptions, touchdowns (receiving, rushing, passing), interceptions and fantasy points |
| `espn_xwalk` | `players/players.parquet` | `espn_id` → `gsis_id` for the 251 QB/RB/WR/TE players in league-b's recorded 2024–2025 box scores (`fixtures/espn/recorded/history`) |

## Provenance

**Retrieved:** 2026-10-10 (the players file 2026-10-06), from the GitHub release assets
`https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}` and
`https://github.com/ffverse/ffopportunity/releases/download/latest-data/{file}` — the files the
Phase-3 history refresh grounded (`docs/evals/phase3-data.md`). `manifest.json` pins the sha256 of
every committed part and of every upstream file each table was cut from; `helpers/data.ts` re-hashes
every part on every read, so a revised upstream file fails on the hash, never as a changed result.

| Excerpt | Rows | Part bytes |
|---|---|---|
| `player_week_2023` | 5,897 | 245,738 + 245,685 + 126,339 |
| `player_week_2024` | 5,935 | 245,656 + 245,733 + 129,892 |
| `player_week_2025` | 6,108 | 245,734 + 245,739 + 147,208 |
| `team_week_2023` / `_2024` / `_2025` | 544 each | 48,395 / 48,248 / 48,952 |
| `injury_week_2023` / `_2024` / `_2025` | 1,687 / 1,713 / 1,750 | 123,971 / 124,888 / 126,623 |
| `ep_week_2023` / `_2024` / `_2025` (CC BY-SA) | 5,364 / 5,293 / 5,343 | 224,460 / 221,304 / 223,483 |
| `espn_xwalk` | 251 | 5,767 |

**Generator:** `helpers/make-excerpt.ts` (run by hand on the downloaded release files — no test, agent
or CI job fetches). The format (a JSON header plus TSV parts of JSON cells, each part under 240 KB) is
`fixtures/nflverse/ATTRIBUTION.md`'s.
