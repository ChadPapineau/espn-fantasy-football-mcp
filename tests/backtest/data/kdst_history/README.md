# tests/backtest/data/kdst_history — attribution and provenance

The data in this directory is **derived from nflverse data**, © the nflverse contributors, licensed
under the **Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). It is redistributed here as test data (plan 05 §3).
Only public NFL data: no league, team or member data of any fantasy league, and no player names.

**Retrieved:** 2026-10-10, from the GitHub release assets listed in `manifest.json` → `upstream`
(each with its byte size, row count, `nflverse_timestamp` and sha256): `schedules/games.parquet`,
`stats_player/stats_player_week_{2023,2024,2025}.parquet`,
`stats_team/stats_team_week_{2023,2024,2025}.parquet` and `pbp/play_by_play_{2023,2024,2025}.parquet`.
`games.parquet` is rebuilt upstream every day; its sha256 pins the file this cut was made from.

| File | Rows | What |
|---|---|---|
| `games.tsv` | 768 | every regular-season game of weeks 1–17 of 2023–2025: teams, final score, `spread_line`, `total_line`, ESPN game id — values unchanged |
| `dst.tsv` | 1,536 | every team-game's D/ST week, derived by the product's own code: `TeamDefenseAggregator` over every `stats_player_week` row (the `ds_team_defense_week` derivation), points-allowed inputs from `pointsAllowedFromTeamWeek` (the opponent's `stats_team_week` row, its final score and the game's pbp plays — plan 08 §3.2 U-6), and the special-teams TD split (kick, punt and blocked-kick returns, from pbp through `returnTdKind`) |
| `k.tsv` | 1,534 | every regular-season `stats_player_week` row of position K, weeks 1–17: team, opponent and the kicking columns `statLineFromPlayerWeek` reads (FG attempts and the made / missed / blocked distance lists, PATs) — values unchanged, no player id or name |

Each file is a header line of column names, then one row per line, every cell a JSON literal (the
format of `fixtures/nflverse/ATTRIBUTION.md`). `manifest.json` carries each file's sha256;
`loadKdstHistory` (`tests/backtest/helpers/kdst-history.ts`) re-hashes every file on every read, so a
revised or edited file fails on the hash, never as a changed result. `notes` lists the two team-games
whose pbp special-teams TD (a recovered muff counted by the stats as a defensive fumble-return TD)
has no `special_teams_tds` credit — it stays in `fumble_recovery_tds_opp`, never counted twice.

**Used by:** `tests/backtest/kdst-history.test.ts` — plan 10 §3.3 C7 (the K/D-ST model against "last
week's score" and the implied total; the rare-event share of D/ST variance; `DST_RARE_RATES`), with the
numbers in `docs/evals/phase3-kdst-news.md`. **Regenerate:**
`scripts/dev/with-node.sh npx tsx tests/backtest/helpers/make-kdst-history.ts <download-dir>`, then
prettier on `manifest.json`, then `UPDATE_EVALS=1` on the test to rewrite the report's sections.
