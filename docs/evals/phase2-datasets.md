# Phase 2 datasets — the contract, grounded (2026-10-06)

The Phase-2 dataset contract (`src/store/datasets/tables.ts`, Phase-2 section; plan 10 §3.2 sources
and acceptance B1–B2; plan 01 §5.2 rows and §5.5 per-source files; plan 06 §1.3 jobs) was grounded
on the real release files downloaded on 2026-10-06 to a directory outside the repo (never committed;
read with hyparquet 1.31.2). Every number below comes from those files. The machine-checked record
is `tests/store/datasets/observed-phase2.ts` (columns, codecs, rows, bytes, sha256 per file and
season) and the fixture-roster excerpts in `fixtures/players/phase2/`.

## Per dataset

Sizes are the release asset's bytes; rows are the upstream file's rows; "kept" is what the contract
stores. All parquet files are a single row group, **SNAPPY** on every column chunk (the allowed
codec, plan 01 D9). Release asset `updated_at` is in `observed-phase2.ts`.

| source → table | upstream file (per season) | 2026 | 2025 | 2024 | kept columns | licence |
|---|---|---|---|---|---|---|
| `nflverse:stats_team_week` → `ds_stats_team_week` | `nflverse-data/releases/download/stats_team/stats_team_week_{season}.parquet` | 74,271 B · 128 rows (wk 1–4) | 128,766 B · 570 | 128,118 B · 570 | 92 of 138 (`TEAM_WEEK_STAT_COLUMNS` + ids) | CC-BY-4.0 |
| `nflverse:pbp` → `ds_pbp` | `…/pbp/play_by_play_{season}.parquet` | 4,849,154 B · 11,155 | 20,337,029 B · 48,771 | 20,597,560 B · 49,492 | 51 (49 of 372 + the derived `rz`, `gl`) | CC-BY-4.0 |
| `nflverse:snap_counts` → `ds_snap_counts` | `…/snap_counts/snap_counts_{season}.parquet` | 83,636 B · 5,970 | 242,046 B · 26,613 | 240,862 B · 26,615 | 15 of 16 (no `player` name) | CC-BY-4.0 |
| `nflverse:depth_charts` → `ds_depth_charts` (2025+) / `ds_depth_charts_legacy` (≤ 2024) | `…/depth_charts/depth_charts_{season}.parquet` | 2,812,797 B · 613,196 (220 snapshots) | 2,584,724 B · 554,215 (221) | 482,923 B · 37,312 (legacy layout) | 2025+: 11 of 12 (no `pos_name`) → 15 with the run columns; ≤ 2024: 11 of 15 | CC-BY-4.0 |
| `ffopportunity:ep_weekly` → `ds_ep_weekly` | `ffverse/ffopportunity/releases/download/latest-data/ep_weekly_{season}.parquet` | 331,526 B · 1,362 | 1,131,935 B · 6,054 | 1,125,932 B · 6,005 | 63 of 159 (player-level actuals + `_exp` components + 4 team denominators; no `_diff`, no `full_name`) | **CC-BY-SA-4.0** |
| `sleeper:trending` → `ds_trending` | `api.sleeper.app/v1/players/nfl/trending/{add\|drop}?lookback_hours=24&limit=50` (JSON) | not fetched here | — | — | 6 | non-commercial |
| `news:rotowire` / `news:espn` / `news:cbs` → `ds_news` + `ds_news_players` | the three RSS feeds (plan 07 D6; research 04 §B.10) | not fetched here | — | — | 7 + 5 | api-terms |

The history twins of the Phase-1 datasets read these prior-season files with the unchanged Phase-1
specs: `stats_player/stats_player_week_2025.parquet` 855,077 B · 19,422 rows and `…_2024` 849,243 B ·
18,983 (150 columns, identical to 2026); `injuries/injuries_2025.parquet` 97,472 B · 6,068 and
`…_2024` 139,253 B · 6,215 — **2024 has no `season_type` and adds `date_modified`**, neither of
which the contract reads.

Sleeper and the RSS feeds were not fetched in this stage (this brief allowed nflverse and
ffopportunity downloads only). Their shapes are the sibling's 2026-09-29 observations (research 04
§B.5, §B.10; Y-04 §B4, §B10): trending is `[{ "player_id": "4984", "count": 1234 }]` (a defence's
`player_id` is its team code); RotoWire items carry ~200-character descriptions, ESPN items a
headline and link only, CBS items ~140 characters with promotional entries. The source engineer
verifies them on the first live fetch.

## Measured dataset files (contract + reference loader, `journal_mode=DELETE`)

| file | rows loaded | dropped / collapsed at load | bytes |
|---|---|---|---|
| `nflverse:stats_team_week` (2026) | 128 | 0 | 49,152 |
| `nflverse:stats_team_week_history` (2024 + 2025) | 1,140 | 0 | 315,392 |
| `nflverse:pbp` (2026, weeks 1–4) | 9,640 | 1,515 (`no_play` + markers) | 2,232,320 |
| `nflverse:pbp_history` | 85,713 | 12,550 | 20,017,152 |
| `nflverse:snap_counts` (2026) | 5,970 | 0 | 876,544 |
| `nflverse:snap_counts_history` | 53,228 | 0 | 7,929,856 |
| `nflverse:depth_charts` (2026) | 12,046 runs from 613,196 snapshot rows | 0 invalid, 0 duplicate slots | 2,146,304 |
| `nflverse:depth_charts_history` | 18,254 runs (2025) + 36,877 legacy rows (2024) | 2024: 234 `SBBYE` rows dropped, 201 exact duplicates collapsed | 9,179,136 |
| `ffopportunity:ep_weekly` (2026) | 1,265 | 97 (no `player_id`) | 389,120 |
| `ffopportunity:ep_weekly_history` | 11,217 | 842 | 3,280,896 |

- **A-11 (pbp ≈ 10 MB a season) holds:** 20.0 MB for two seasons after trimming `ds_pbp` to the three
  indexes its IN-list lookups use (`dbstat`: 12.2 MB of rows, 2.85 MB primary key, ~1.6–1.8 MB per
  index; the four indexes first drafted and then dropped — passer, kicker, TD scorer, defteam — cost 6.1 MB and no statement needed them).
- **Depth charts:** the 2025+ files are one full snapshot of all 32 teams per day, 600 k rows a
  season; stored as occupancy runs (`depthChartRuns`) they shrink 50× and still answer "the chart
  as of any instant" with one range predicate. The current chart (`valid_to_ms IS NULL`) is exactly
  the newest snapshot (2,288 rows for 2026).
- Store total stays well inside plan 01 §5.8's 150 MB: the Phase-2 files above sum to ≈ 46 MB at
  week 4 with two history seasons; a full current season adds ≈ 8 MB of pbp and ≈ 3 MB of snaps.

## What the grounding verified

- **Columns:** for every source and every season (2024, 2025, 2026) the contract's required upstream
  columns exist in that season's file (`phase2-tables.test.ts`, "grounded"). All five Phase-2
  parquet schemas are identical across the three seasons **except `depth_charts`**, which changed
  layout in 2025 (no `season`/`week`; `dt`, `espn_id`, `pos_*`) — hence `ds_depth_charts_legacy`.
- **pbp counting = nflverse's own counting.** With `PBP_KEPT_PLAY_TYPES` (drop `no_play` and
  `play_type`-null markers), a target = `pass_attempt = 1 AND sack = 0 AND two_point_attempt = 0`
  with a receiver, a carry = `rush_attempt = 1 AND two_point_attempt = 0` with a rusher. Against
  `stats_player_week`: targets 4,454/4,454 (2024), 4,533/4,533 (2025), 1,032/1,032 (2026);
  carries 2,357/2,358, 2,355/2,355, 504/504; receptions 914/914 (2026); passing, receiving and
  rushing TDs and FG attempts/makes agree on every player-week of all three seasons. The one
  disagreeing 2024 carry is unexplained and recorded, not patched. The committed fixture excerpt
  reproduces the same equality at test time (`phase2-grounding.test.ts`).
- **Return TDs:** player `special_teams_tds` is not kickoff + punt returns: 13 player-weeks in
  2024–2025 differ — blocked FG/punt returns (`return_touchdown = 0`) and a muffed punt the kicking
  team recovered for a TD (`return_touchdown = 1`, scorer ≠ returner). `returnTdKind` credits a
  `kr`/`pr` TD only to the play's own returner (plan 08 §3.2 split).
- **Ids:** snap counts carry no gsis id; 1,739 of 1,742 2026 snap `pfr_player_id`s (507/508 skill
  players) are in `players.parquet` (one pfr id disagrees between `roster_weekly` and `players` — the
  roster wins, as for `espn_id`). Every ep_weekly `player_id` is a gsis id in `players.parquet`
  (438/438 in 2026). Depth charts carry `espn_id` on every row; `gsis_id` is null on 300 of 3,318
  2026 espn ids.
- **Real-data reader runs** (all Phase-2 statements on the files above): the BUF defence profile,
  the week-1 chart as of kickoff, 2024's last listed chart, ep and snap rows for a fixture QB all
  return the expected rows; with no `ANALYZE` in a published file the planner preferred the
  `(season, week, posteam)` index (11 ms) over the receiver/rusher index (0.3 ms) for the usage
  statements, so those statements carry a unary `+` on `season`/`week`.

## The per-source connection design with Phase 2

25 contract files (9 Phase-1, 9 Phase-2, 7 history) plus the registry's 3 uncontracted ids
(`nflverse:pfr_advstats`, `nflverse:ftn_charting`, `odds:the_odds_api`) = 28 dataset files, against
SQLite's limit of 10 attachments. `phase2-connections.test.ts` opens all 28 at once, each its own
read-only connection with only `main` in `database_list`; runs every Phase-2 statement on its own
file's connection (and its history twin's); refuses INSERT/UPDATE/DELETE/DROP/CREATE/ALTER and a WAL
switch on every contract file by the open mode (A-13); leaves no `-wal`/`-shm` beside a published
file; and shows one connection attaching them all fails at the 11th ("too many attached
databases"). Each Phase-2 reader method spans at most 4 files, under the on-demand join ceiling
of 8 (`MAX_ON_DEMAND_ATTACHMENTS`). The design holds unchanged.

## Integration still owed by other modules (the contract is ready for them)

- `src/config/freshness.ts`: the 7 history ids (`<dataset>_history`) are not yet `DatasetSourceId`s
  — add them to `DATASET_SOURCE_IDS` + `SOURCE_REGISTRY` (phase `2`, release basis, the current
  source's licence and attribution, riding the current source's refresh job and refreshing only
  when a prior-season asset's `updated_at` moves).
- `src/store/publisher.ts`, `src/store/datasets/connections.ts`: switch `tablesFor` /
  `isPhase1DatasetSource` / `columnsHash` to `contractTablesFor` / `isContractDatasetSource` /
  `contractColumnsHash`, so Phase-2 and history files are held to their contract; consider
  `ANALYZE` on the staging file before publish.
- `src/domain/analytics/types.ts`: declare the pending ports (`PHASE_2_PENDING_PORT_READERS`:
  `DepthChartReader.asOf`, `SnapCountReader.counts`, `TeamWeekReader.lines`,
  `PbpReader.playerUsage` / `scoringPlays` / `teamProfile`); the store implements them over
  `PHASE_2_READER_QUERIES`.
- The sources layer: the Phase-2 sources fill these tables (`tests/store/datasets/phase2-loaders.ts`
  is the reference for every derivation); `nflverse:schedules` adds the prior seasons to its
  `ctx.seasons` (one file holds them all); the news source needs the ESPN player universe and its own
  previous file at load (`SourceContext.datasets`) for `ds_news_players` and the 30-day append.
