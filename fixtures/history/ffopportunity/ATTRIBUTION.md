# fixtures/history/ffopportunity — attribution, provenance and licence (CC-BY-SA 4.0)

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

**Retrieved:** 2026-10-10, from the GitHub release `latest-data` of `ffverse/ffopportunity`
(`https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_2023.parquet`,
6,081 rows, 1,152,618 bytes, sha256 `40523f0b2c009ba2…` — the full hash is in `../manifest.json`).

- `ep_weekly/ep_weekly_2023.excerpt.json` + 1 `.tsv` part: every row of `2023_09_BUF_CIN` (21 rows,
  its team-level rows included — the contract drops them); all 159 columns. Upstream `season` is a
  string (`"2023"`) and `week` a double, as the release writes them; the file carries no
  `nflverse_timestamp` metadata.

Same text format as `../../nflverse/ATTRIBUTION.md`; regenerated with
`tests/sources/nflverse/helpers/make-history-fixtures.ts`.
