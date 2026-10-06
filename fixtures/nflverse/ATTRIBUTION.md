# fixtures/nflverse — attribution and provenance

The data in this directory is **nflverse data**, © the nflverse contributors, licensed under the
**Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). It is redistributed here as test fixtures
(plan 05 §3) as **excerpts**: a selection of rows of each release file, every column kept, values
unchanged. No league, team or member data of any fantasy league is included — only public NFL data.

**Retrieved:** 2026-10-06, from the GitHub release assets
`https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}`.

| Fixture | Rows | Part bytes | Stands in for | Upstream rows / bytes | `nflverse_timestamp` | upstream sha256 |
|---|---|---|---|---|---|---|
| `schedules/games.excerpt.json` + 1 `.tsv` part(s) | 557 | 191,870 | `schedules/games.parquet` | 7,548 / 521,703 | `2026-10-06 01:46:36 EDT` | `58405ef54b66550f…` |
| `injuries/injuries_2026.excerpt.json` + 1 `.tsv` part(s) | 1,052 | 156,164 | `injuries/injuries_2026.parquet` | 1,052 / 34,788 | `2026-10-06 02:02:02 EDT` | `5eb5c88076ff3a64…` |
| `weekly_rosters/roster_weekly_2026.excerpt.json` + 1 `.tsv` part(s) | 297 | 115,972 | `weekly_rosters/roster_weekly_2026.parquet` | 10,612 / 744,949 | `2026-10-06 02:02:48 EDT` | `19a2cb8bdabc1808…` |
| `stats_player/stats_player_week_2026.excerpt.json` + 3 `.tsv` part(s) | 1,075 | 245,600 + 245,620 + 70,338 | `stats_player/stats_player_week_2026.parquet` | 4,449 / 306,484 | `2026-10-06 00:34:45 EDT` | `2904a8aa8af67275…` |
| `players/players.excerpt.json` + 1 `.tsv` part(s) | 29 | 12,017 | `players/players.parquet` | 24,844 / 3,390,504 | `2026-10-05 12:51:38 EDT` | `84ed9906fbd8971b…` |
| `{tag}/timestamp.txt` | — | 24 each | `{tag}/timestamp.txt` | verbatim | — | — |

`manifest.json` carries the full sha256 of every committed part and of the exact upstream file it was
cut from (plan 08 §6 step 5: a revised nflverse file fails on the hash, not as a regression), the
upstream URL, schema size, writer (`parquet-cpp-arrow 25.0.1`), codecs (`SNAPPY`) and encodings.

## Why text, and how the tests use it

The repository's secret scanner (`scripts/dev/scan-secrets.mjs`) refuses binary archives and
databases — parquet included — because no rule can read them, and `.gitignore` keeps every archive
(`*.gz` too) out of the tree. So each excerpt is committed as **plain text**: a small JSON header
(`*.excerpt.json`: the upstream schema — names, order, physical and logical types —, nflverse's
`nflverse_type` / `nflverse_timestamp` metadata, the row count and the part names) and one or more
**TSV parts** (`*.excerpt.<n>.tsv`): a header line of column names, then one row per line, every cell
a JSON literal (`null`, a number, a JSON string — so `null` and `""` stay distinct; DATE values as
`YYYY-MM-DD`). A part stays under 240 KB (the plan's cap is 300 KB per fixture); the stats excerpt
needs three. The tests rebuild a parquet file from each excerpt with `tests/sources/nflverse/helpers/parquet-writer.ts` — the **same column names,
order, physical and logical types** and `nflverse_type` / `nflverse_timestamp` metadata as the real
file, SNAPPY-compressed, strings dictionary-encoded (RLE_DICTIONARY) as Arrow writes them — and serve
it through a fake HttpGet at the release URL it stands in for. No test touches the network.

## The excerpts (weeks 1–3 of the shared fixture roster, `fixtures/players/fixture-roster.json`)

- `games.excerpt`: every game of seasons **2025 and 2026** (285 + 272): the 2026 ESPN game ids
  join the recorded `proTeamSchedules_wl` exactly; 2025 exercises the season filter and the
  International Series venue overrides.
- `injuries_2026.excerpt`: every row (weeks 1–4).
- `roster_weekly_2026.excerpt`: every row (weeks 1–4) of the fixture-roster players and the
  decoy; every row sharing a `same_surname` last name (Allen, Love, Henry — matcher distractors);
  every kicker row; the rows with a null `gsis_id`; the active QB/RB/WR/TE rows without an `espn_id`;
  the one player whose `espn_id` differs in `players.parquet`.
- `stats_player_week_2026.excerpt`: weeks 1–3 — every row of both teams in the 14 games the
  fixture team units (PHI, DET, LA, WAS D/ST; LAC TQB) played (so their team-defence lines and the
  yards allowed are complete), every fixture-roster player row, every kicker row; plus the four
  team-level rows with a null `player_id` (all weeks; one carries BUF's week-2 safety).
- `players.excerpt`: the fixture-roster players and the decoy, the player whose `espn_id`
  differs from `roster_weekly`, and three legacy rows whose `gsis_id` is not a GSIS id.

## UUID-shaped values are public NFL player ids, not member GUIDs

`players.excerpt` (`smart_id`) and `roster_weekly_2026.excerpt` (`smart_id`, `sportradar_id`)
carry UUID-shaped values outside the fixture pseudonym range
(`{00000000-0000-4000-8000-0000000000NN}`). They are nflverse's public identifiers of NFL
players — published in the release files above, unchanged here — not ESPN member GUIDs (an ESPN
member id is always a brace-wrapped SWID GUID: research 03 §B.3) and never anyone's fantasy-league
identity. The ESPN rules of `scripts/dev/scan-secrets.mjs` and `.gitleaks.toml` match the brace or
`SWID` forms only, so they pass these columns by design; a literal "every GUID in the fake range"
check applies to ESPN fixtures (`fixtures/espn/`), not to this public dataset.

To refresh: download the release files into one directory as `<tag>_<file>` and
`<tag>_timestamp.txt`, run
`scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-fixtures.ts <download-dir>`,
update this table from `manifest.json`, and review the diff (the scanner runs at commit).
