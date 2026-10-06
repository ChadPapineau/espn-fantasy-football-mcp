# tests/backtest/data/stats_player_week — attribution and provenance

The data in this directory is **nflverse data**, © the nflverse contributors, licensed under the
**Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). It is redistributed here as test data (plan 05 §3) as
**excerpts**: a selection of rows and columns of two release files, values unchanged. No league, team
or member data of any fantasy league is included — only public NFL data.

**Retrieved:** 2026-10-06, from the GitHub release assets
`https://github.com/nflverse/nflverse-data/releases/download/stats_player/{file}` — the same release
research 05 §3.1 read (its row counts, 19,422 for 2025 and 18,983 for 2024, are the upstream counts
below).

| Excerpt | Rows | Part bytes | Stands in for | Upstream rows / bytes | `nflverse_timestamp` | upstream sha256 |
|---|---|---|---|---|---|---|
| `stats_player_week_2024.excerpt.json` + 3 `.tsv` parts | 5,587 | 245,693 + 245,757 + 20,314 | `stats_player_week_2024.parquet` | 18,983 / 849,243 | `2026-08-13 12:49:08 EDT` | `847569d194ca3d96…` |
| `stats_player_week_2025.excerpt.json` + 3 `.tsv` parts | 5,752 | 245,689 + 245,689 + 33,695 | `stats_player_week_2025.parquet` | 19,422 / 855,077 | `2026-08-13 12:51:20 EDT` | `2a461becaa9adb3c…` |

**Rows:** `season_type` REG, weeks 1–17 (ESPN's `finalScoringPeriod` — week 18 is not a fantasy week),
`position_group` QB, RB, WR or TE — research 05 §3.1's filter. **Columns:** the keys and the 26 columns
the reference scoring reads, plus nflverse's own `fantasy_points` / `fantasy_points_ppr` as a
cross-check (B1's waiver-replay excerpt rule, `tests/backtest/helpers/waiver-excerpt.ts`
`BACKTEST_RULE`, which this directory reuses unchanged).

`manifest.json` carries the sha256 of every committed part and of the exact upstream file it was cut
from: `loadBacktestSeason` re-hashes every part on every read, so a revised nflverse file fails on the
hash, never as a changed result. The format (a JSON header of the upstream schema plus TSV parts of
JSON cells, each part under 240 KB) is `fixtures/nflverse/ATTRIBUTION.md`'s.

**Used by:** `tests/backtest/replacement.test.ts` — plan 10 B7's hard regression (research 05 §4.1's
2025 and 2024 baselines within 0.3 points per game and the flex split 7/3, 4/6), scored through the
shipped translator and engine under the reference league's settings. **Regenerate:**
`scripts/dev/with-node.sh npx tsx tests/backtest/helpers/make-replacement-excerpt.ts <download-dir>`,
then prettier on the JSON files.
