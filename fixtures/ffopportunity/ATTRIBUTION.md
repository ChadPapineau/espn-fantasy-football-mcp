# fixtures/ffopportunity — attribution, provenance and licence (CC-BY-SA 4.0)

The data in this directory is **ffopportunity data**, © the ffverse contributors
(<https://github.com/ffverse/ffopportunity>), licensed under the **Creative Commons
Attribution-ShareAlike 4.0 International licence (CC BY-SA 4.0)** —
<https://creativecommons.org/licenses/by-sa/4.0/>. ffopportunity's expected-points models are
built on nflverse play-by-play data (CC-BY 4.0, <https://github.com/nflverse/nflverse-data>).

**Share-alike:** the files in this directory are a selection of rows of that data, values
unchanged, and are **shared under the same licence (CC BY-SA 4.0)**. The share-alike condition
attaches to this data, not to the rest of this repository: the code that reads it is not a
derivative of it (research 04 §E). No league, team or member data of any fantasy league is
included — only public NFL data.

**Retrieved:** 2026-10-06, from the GitHub release `latest-data` of `ffverse/ffopportunity`
(`https://github.com/ffverse/ffopportunity/releases/download/latest-data/{file}`); every upstream
file is the one the Phase-2 dataset contract was grounded on (`tests/store/datasets/observed-phase2.ts`).

| Fixture | Rows | Part bytes | Columns kept | Stands in for | Upstream rows / bytes | upstream sha256 |
|---|---|---|---|---|---|---|
| `ep_weekly/ep_weekly_2026.excerpt.json` + 1 `.tsv` part | 118 | 114,270 | 159 of 159 | `latest-data/ep_weekly_2026.parquet` | 1,362 / 331,526 | `38bb0e03dc39c92f…` |
| `ep_weekly/ep_weekly_2025.excerpt.json` + 1 `.tsv` part | 21 | 23,298 | 159 of 159 | `latest-data/ep_weekly_2025.parquet` | 6,054 / 1,131,935 | `7b8be943bd230fc5…` |
| `ep_weekly/ep_weekly_2024.excerpt.json` + 1 `.tsv` part | 21 | 22,504 | 159 of 159 | `latest-data/ep_weekly_2024.parquet` | 6,005 / 1,125,932 | `ed657898682e7750…` |
| `ep_weekly/timestamp.txt` | — | 27 | — | `latest-data/timestamp.txt` | verbatim (`2026-10-06 12:14:46.831507` — no zone: the build's UTC clock) | — |

- **2026:** every row of the three complete fixture games of `../nflverse/phase2/` (`2026_01_NO_DET`,
  `2026_02_LV_LAC`, `2026_03_LA_DEN`), the fixture-roster players' rows of weeks 1–3
  (`../players/fixture-roster.json`) and the file's first two team-level rows (null `player_id`,
  dropped by the contract).
- **2025, 2024:** every row of `2025_07_WAS_DAL` / `2024_04_SEA_DET` (one team-level row each).
- Upstream `season` is a string (`"2026"`) and `week` a double, as the release writes them; the
  files carry no `nflverse_timestamp` metadata.

Same text format as `../nflverse/ATTRIBUTION.md` (a JSON header with the upstream schema + TSV parts
of JSON cells); regenerated with `tests/sources/nflverse/helpers/make-phase2-fixtures.ts`.
