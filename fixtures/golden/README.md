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

Regenerate the frozen outputs only after a deliberate engine change the golden test explains, or a
re-recording: `scripts/dev/with-node.sh npx tsx tests/golden/freeze.ts`.

## Licence and attribution

`nflverse-crosscheck.json` is **nflverse data**, © the nflverse contributors, licensed under the
**Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (<https://creativecommons.org/licenses/by/4.0/>). It is
a selection of rows and columns of `stats_player/stats_player_week_2026.parquet` and
`schedules/games.parquet` (retrieved 2026-10-06); values are unchanged, the D/ST rows are sums of
the player rows as the dataset contract defines them. No league, team or member identifier of any
fantasy league is included — only public NFL data.
