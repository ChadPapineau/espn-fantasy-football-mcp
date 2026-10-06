# fixtures/golden — the scoring engine's frozen outputs and its nflverse cross-check excerpt

Plan 08 §6 step 1 and E8. Nothing here is ESPN evidence: the golden compares the engine with
ESPN's own `appliedStats`/`appliedTotal`, read only from [`../espn/recorded/`](../espn/recorded/)
through a path guard (`tests/golden/recorded.ts`). These files pin the engine's own output and hold
the second source the engine is cross-checked against.

| file | what | made by |
|---|---|---|
| `espn-recorded.json` | the engine's points for every rostered player-week of `league-a/b/c` weeks 1–3 (actual and projected lines) and each league's `settings_hash` — an engine change that silently alters a score fails `tests/golden/espn-recorded.test.ts` even when the ESPN fixtures are unchanged | `tests/golden/freeze.ts` (refuses to run unless every player-week matches ESPN) |
| `manifest.json` | the content hash of `espn-recorded.json` and the recorded sources it was built from (a re-recording forces a re-freeze) | `tests/golden/freeze.ts` |
| `nflverse-crosscheck.json` | nflverse rows for the [fixture roster](../players/fixture-roster.json), 2026 weeks 1–3: each player's `ds_stats_player_week` row (the `src/store/datasets/tables.ts` columns, verbatim) and each fixture D/ST unit's `ds_team_defense_week` row aggregated by that table's contract, with the game facts points allowed is computed from | a one-off extraction from the 2026-10-06 release files (sources and sha256 inside) |
| `nflverse-phase2-evidence.json` | plan 10 B13 (plan 08 §3.2 U-6, §4.3): for each of the 70 recorded D/ST weeks the game, both teams, the opponent's final score and the opponent's `ds_stats_team_week` counts points/yards allowed read; every 2026 week 1–3 pbp play with a TD or a safety (a `no_play` row included) and the try after each TD the team without the ball scored, in `ds_pbp` column names; the `espn_id → gsis_id` pair of every recorded QB/RB/WR/TE. `tests/golden/nflverse-phase2.test.ts` and `docs/evals/phase2-engine-families.md` read it | `tests/golden/extract-nflverse-evidence.ts`, a one-off run on local copies of the 2026-10-06 release files (sources and sha256 inside; it never fetches) |
| `p14-yahoo.json` | plan 08 P14 (the `fantasy-core` guard): the sibling `yahoo-fantasy-football-mcp`'s own normaliser output for a canonical rule table both hubs share by name, and its engine's points for 150 deterministic canonical lines — frozen JSON, no shared code (plan 01 D3) | a one-off run of the sibling's code at the commit named inside; regenerate only when a shared canonical name changes |

Regenerate the frozen outputs only after a deliberate engine change the golden test explains, or a
re-recording: `scripts/dev/with-node.sh npx tsx tests/golden/freeze.ts`.

## Licence and attribution

`nflverse-crosscheck.json` is **nflverse data**, © the nflverse contributors, licensed under the
**Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (<https://creativecommons.org/licenses/by/4.0/>). It is
a selection of rows and columns of `stats_player/stats_player_week_2026.parquet` and
`schedules/games.parquet` (retrieved 2026-10-06); values are unchanged, the D/ST rows are sums of
the player rows as the dataset contract defines them.

`nflverse-phase2-evidence.json` is **nflverse data** under the same licence and attribution: a
selection of rows and columns of `schedules/games.parquet`, `pbp/play_by_play_2026.parquet`,
`stats_team/stats_team_week_2026.parquet` and `weekly_rosters/roster_weekly_2026.parquet`
(retrieved 2026-10-06); values are unchanged. It holds public NFL ids only (game ids, team
abbreviations, gsis and ESPN player ids, the ESPN D/ST unit ids) — no player name and no fantasy
league, team or member identifier. No league, team or member identifier of any
fantasy league is included — only public NFL data.
