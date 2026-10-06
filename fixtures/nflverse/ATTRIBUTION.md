# fixtures/nflverse — attribution and provenance

The data in this directory is **nflverse data**, © the nflverse contributors, licensed under the
**Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). It is redistributed here as test fixtures
(plan 05 §3) as **excerpts**: a selection of rows of each release file, every column kept, values
unchanged. No league, team or member data of any fantasy league is included — only public NFL data.

**Retrieved:** 2026-10-06, from the GitHub release assets
`https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}`.

| Fixture | Rows | Bytes | Stands in for | Upstream rows / bytes | `nflverse_timestamp` | upstream sha256 |
|---|---|---|---|---|---|---|
| `schedules/games.excerpt.json.gz` | 557 | 29,739 | `schedules/games.parquet` | 7,548 / 521,703 | `2026-10-06 01:46:36 EDT` | `58405ef54b66550f…` |
| `injuries/injuries_2026.excerpt.json.gz` | 1,052 | 19,374 | `injuries/injuries_2026.parquet` | 1,052 / 34,788 | `2026-10-06 02:02:02 EDT` | `5eb5c88076ff3a64…` |
| `weekly_rosters/roster_weekly_2026.excerpt.json.gz` | 297 | 15,215 | `weekly_rosters/roster_weekly_2026.parquet` | 10,612 / 744,949 | `2026-10-06 02:02:48 EDT` | `19a2cb8bdabc1808…` |
| `stats_player/stats_player_week_2026.excerpt.json.gz` | 1,075 | 58,867 | `stats_player/stats_player_week_2026.parquet` | 4,449 / 306,484 | `2026-10-06 00:34:45 EDT` | `2904a8aa8af67275…` |
| `players/players.excerpt.json.gz` | 29 | 4,696 | `players/players.parquet` | 24,844 / 3,390,504 | `2026-10-05 12:51:38 EDT` | `84ed9906fbd8971b…` |
| `{tag}/timestamp.txt` | — | 24 each | `{tag}/timestamp.txt` | verbatim | — | — |

`manifest.json` carries the full sha256 of every committed file and of the exact upstream file it was
cut from (plan 08 §6 step 5: a revised nflverse file fails on the hash, not as a regression), the
upstream URL, schema size, writer (`parquet-cpp-arrow 25.0.1`), codecs (`SNAPPY`) and encodings.

## Why JSON, and how the tests use it

The repository's secret scanner (`scripts/dev/scan-secrets.mjs`) refuses binary archives and
databases — parquet included — because no rule can read them. So each excerpt is committed as
**gzipped columnar JSON** (`schema`, nflverse's `key_value` metadata, `columns[name][i]` = row i;
DATE values as `YYYY-MM-DD`). The scanner decompresses `.gz` and scans the text; gzip keeps every
file far under the plan's 300 KB fixture cap (prettier-formatted JSON would not be). Read one with
`gunzip -c <file> | head -c 2000`. The tests rebuild a parquet file
from each excerpt with `tests/sources/nflverse/helpers/parquet-writer.ts` — the **same column names,
order, physical and logical types** and `nflverse_type` / `nflverse_timestamp` metadata as the real
file, SNAPPY-compressed, strings dictionary-encoded (RLE_DICTIONARY) as Arrow writes them — and serve
it through a fake HttpGet at the release URL it stands in for. No test touches the network.

## The excerpts (weeks 1–3 of the shared fixture roster, `fixtures/players/fixture-roster.json`)

- `games.excerpt.json.gz`: every game of seasons **2025 and 2026** (285 + 272): the 2026 ESPN game ids
  join the recorded `proTeamSchedules_wl` exactly; 2025 exercises the season filter and the
  International Series venue overrides.
- `injuries_2026.excerpt.json.gz`: every row (weeks 1–4).
- `roster_weekly_2026.excerpt.json.gz`: every row (weeks 1–4) of the fixture-roster players and the
  decoy; every row sharing a `same_surname` last name (Allen, Love, Henry — matcher distractors);
  every kicker row; the rows with a null `gsis_id`; the active QB/RB/WR/TE rows without an `espn_id`;
  the one player whose `espn_id` differs in `players.parquet`.
- `stats_player_week_2026.excerpt.json.gz`: weeks 1–3 — every row of both teams in the 14 games the
  fixture team units (PHI, DET, LA, WAS D/ST; LAC TQB) played (so their team-defence lines and the
  yards allowed are complete), every fixture-roster player row, every kicker row; plus the four
  team-level rows with a null `player_id` (all weeks; one carries BUF's week-2 safety).
- `players.excerpt.json.gz`: the fixture-roster players and the decoy, the player whose `espn_id`
  differs from `roster_weekly`, and three legacy rows whose `gsis_id` is not a GSIS id.

To refresh: download the release files into one directory as `<tag>_<file>` and
`<tag>_timestamp.txt`, run
`scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-fixtures.ts <download-dir>`,
update this table from `manifest.json`, and review the diff (the scanner runs at commit).
