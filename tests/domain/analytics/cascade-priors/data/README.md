# tests/domain/analytics/cascade-priors/data — attribution and provenance

The data in this directory is **derived from nflverse data**, © the nflverse contributors, licensed
under the **Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). **Changes made:** the play-by-play rows are
aggregated into per-player team-game counts, joined with each player's position group and depth-chart
rank, and every player id is replaced by a pseudonym. No league, team or member data of any fantasy
league is included — only public NFL data, and no NFL player id or name.

**Retrieved:** 2026-10-10, from the GitHub release assets
`https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}` (pbp `timestamp.txt`
`2026-10-10 11:17:28 EDT`; depth charts `2026-10-10 09:32:48 EDT`). The 2024 and 2025 files are the
same bytes as Phase 2's grounding; all are listed in `manifest.json` with bytes and sha256.

| File | Rows | Bytes |
|---|---|---|
| `usage-2023.tsv` | 8,102 | 185,288 |
| `usage-2024.tsv` | 8,134 | 185,836 |
| `usage-2025.tsv` | 10,021 | 230,205 |

| Upstream file | Bytes | sha256 (prefix) |
|---|---|---|
| `pbp/play_by_play_2023.parquet` | 20,534,088 | `bd3484731408def6…` |
| `pbp/play_by_play_2024.parquet` | 20,597,560 | `3fd2896bc0b911b6…` |
| `pbp/play_by_play_2025.parquet` | 20,337,029 | `c6ecedd6d678cc37…` |
| `stats_player/stats_player_week_2023.parquet` | 846,050 | `ac776fbd7c9fefdb…` |
| `stats_player/stats_player_week_2024.parquet` | 849,243 | `847569d194ca3d96…` |
| `stats_player/stats_player_week_2025.parquet` | 855,077 | `2a461becaa9adb3c…` |
| `depth_charts/depth_charts_2023.parquet` | 485,941 | `44dbf02554d4a8a7…` |
| `depth_charts/depth_charts_2024.parquet` | 482,923 | `2b5e72fa37f6a498…` |
| `depth_charts/depth_charts_2025.parquet` | 2,584,724 | `14f74185b3c2c48d…` |
| `schedules/games.parquet` (2025 kickoff dates only) | 522,027 | `68ab1450807fec52…` |

**Rows** (`manifest.json` `rule`): one per (week, team, player) of the regular season — targets
(`pass_attempt = 1 ∧ sack = 0 ∧ two_point_attempt = 0`, a receiver), carries
(`rush_attempt = 1 ∧ two_point_attempt = 0`, a rusher) and their red-zone subsets
(`yardline_100 ≤ 20`) over the store's kept play types — the definitions of
`src/store/datasets/{derive,tables}.ts`, restated in `src/domain/analytics/cascade-priors/usage.ts`
and held equal by `usage.test.ts`; the position group from `stats_player_week` (else `OTHER`); the
rank on that week's depth chart (2023–2024 the weekly charts' `depth_team`; 2025 the last snapshot
before game day 12:00 UTC, `pos_rank`). A skill player listed on a team-week's chart with no
opportunity has a row of zeros. **Columns:** `week team player position depth targets carries
rz_targets rz_carries` (the season is the file's). **Players** are `p1, p2, …` per (season, team),
numbered in sorted-id order — enough to follow a player through a season, nothing more.

**Why text:** the secret scanner refuses parquet and archives (no rule can read them), so the
derived counts are committed as plain TSV, each file under 240 KB.
`helpers/excerpt.ts` `loadUsageExcerpt` re-hashes every file against `manifest.json` on every read.

**Used by:** `tests/backtest/cascade.test.ts` (plan 10 C6, hard — the leave-one-season-out
comparison of cascade v2 with next man up), `../table.test.ts` (the shipped table
`src/domain/analytics/cascade-priors/generated/table.ts` is rebuilt from these files and compared
exactly), `../excerpt.test.ts`. Results: `docs/evals/phase3-cascade.md`.

**Regenerate** (the release files in a directory outside the repo; no network from the script):

```sh
scripts/dev/with-node.sh npx tsx tests/domain/analytics/cascade-priors/make-usage-excerpt.ts <dir> --report
scripts/dev/with-node.sh npx prettier --write src/domain/analytics/cascade-priors/generated tests/domain/analytics/cascade-priors/data/manifest.json
```
