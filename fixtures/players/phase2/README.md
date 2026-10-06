# fixtures/players/phase2 — Phase-2 grounding excerpts for the fixture roster

Small excerpts of the real 2026-10-06 Phase-2 release files, restricted to the players of
[`../fixture-roster.json`](../fixture-roster.json), so the Phase-2 dataset contract
(`src/store/datasets/tables.ts`, Phase-2 section; plan 10 §3.2) is tested on real rows without a
network call. `tests/store/datasets/phase2-grounding.test.ts` loads them through the reference
loader (`tests/store/datasets/phase2-loaders.ts`) and checks the contract's reader SQL against
nflverse's own weekly stats excerpt (`../../nflverse/stats_player/`): pbp-derived targets,
receptions, carries, passing/receiving/rushing TDs, FG attempts and makes equal nflverse's numbers
for every fixture player-week.

## Format

Each excerpt is two files: `<name>.excerpt.json` (provenance: the release URL, its `updated_at`,
byte size, row count and sha256 — which must equal `tests/store/datasets/observed-phase2.ts` — the
selection rule, and the column list) and `<name>.excerpt.tsv` (a header line of column names, then
one row per line, one JSON literal per cell, in upstream order). Only the contract's upstream
columns are kept (`phase2RequiredUpstreamColumns`), so a column the contract stops reading makes
the test fail until the excerpt is regenerated.

| excerpt | upstream file | selection |
|---|---|---|
| `pbp_2026` | nflverse `pbp/play_by_play_2026.parquet` | weeks 1–3: every play a fixture player passed, caught, ran, kicked, returned or scored on; plus 3 `no_play` and 2 marker rows (dropped by the contract) |
| `snap_counts_2026` | nflverse `snap_counts/snap_counts_2026.parquet` | weeks 1–3: the fixture players' rows (by `pfr_player_id`) |
| `ep_weekly_2026` | ffopportunity `latest-data/ep_weekly_2026.parquet` | weeks 1–3: the fixture players' rows, plus 2 team-level rows with no `player_id` (dropped) |
| `depth_charts_2026` | nflverse `depth_charts/depth_charts_2026.parquet` | the newest 14 daily snapshots: the fixture players' rows (by `espn_id`) |
| `stats_team_week_2026` | nflverse `stats_team/stats_team_week_2026.parquet` | weeks 1–3: the fixture players' teams |
| `depth_charts_2024` | nflverse `depth_charts/depth_charts_2024.parquet` (pre-2025 layout) | weeks 1–2: the fixture players' rows, plus 3 week-less `SBBYE` rows, one byte-identical duplicate pair and 2 blank `depth_position` rows |

The files hold public NFL data only — no fantasy league, team, member or account identifier — and
were scanned by `scripts/dev/scan-secrets.mjs` (deny-list active) before they were committed. The
player name columns of the upstream files are not part of the excerpts except where the contract
keeps them (`depth_charts` `player_name` / `full_name`, third-party text the readers wrap).

## Licence and attribution

- **nflverse** (`pbp`, `snap_counts`, `depth_charts`, `stats_team`): © the nflverse contributors,
  Creative Commons Attribution 4.0 International (CC BY 4.0) — <https://github.com/nflverse/nflverse-data>.
  Snap counts originate from Pro-Football-Reference and depth charts from ESPN, as redistributed by
  nflverse. Redistributed here unmodified in substance (a selection of rows and columns).
- **ffopportunity** (`ep_weekly_2026`): © the ffverse contributors, Creative Commons
  Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) — <https://github.com/ffverse/ffopportunity>.
  The two `ep_weekly_2026.excerpt.*` files are a selection of that data and are shared under the same
  licence (CC BY-SA 4.0); the rest of this repository is not a derivative of them.

Regenerating: download the release files named in each header to a directory outside the repo,
select the rows as described above, keep `phase2RequiredUpstreamColumns(<source>, <season>)`, and
update `tests/store/datasets/observed-phase2.ts` from the same files.
