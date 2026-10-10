# tests/domain/evidence/data/injury_outcomes — attribution and provenance

The data in this directory is **derived from nflverse data**, © the nflverse contributors, licensed
under the **Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). The snap counts nflverse redistributes come from
Pro-Football-Reference. It is redistributed here as aggregated test data (plan 05 §3). Only public
NFL data and no player identity: no name, no id — counts.

**Retrieved:** 2026-10-10, from the release assets listed in `manifest.json` → `upstream` (byte
size, row count, `nflverse_timestamp`, sha256): `injuries/injuries_{2023,2024,2025}.parquet` and
`snap_counts/snap_counts_{2023,2024,2025}.parquet`.

`outcomes.tsv` (2,681 cells) — every regular-season row of the official injury report, joined to
whether the player took a snap in that week's game (offense + defense + special-teams snaps > 0 in
the snap counts, matched by team, week and the crosswalk's `nameKey`), counted per season, week,
position bucket (QB, RB, WR, TE, K, OTHER), official game status (`report_status`, verbatim:
Questionable / Doubtful / Out / Note / none), the week's practice participation (`practice_status`,
verbatim, whitespace collapsed) and outcome (`played` 0/1). A row whose player never appears in his
team's snap counts that season cannot be labelled and is not counted (`manifest.json` → `seasons`:
138 / 128 / 150 of 5,451 / 5,954 / 5,783 rows). The outcome is "took a snap", so an active player who
took none (a backup quarterback) reads as not played — the same label for every model compared.

The file is a header line of column names, then one row per line, every cell a JSON literal;
`manifest.json` carries its sha256 and `loadInjuryOutcomes` re-hashes it on every read.

**Used by:** `tests/domain/evidence/calibration-history.test.ts` — plan 10 §3.3 C8 (E10's
evidence-augmented P(active) against designation-only, held out by season; the
`PRACTICE_REPORT_HISTORY` seed in `src/domain/evidence/calibration.ts`), numbers in
`docs/evals/phase3-kdst-news.md`. **Regenerate:**
`scripts/dev/with-node.sh npx tsx tests/domain/evidence/helpers/make-injury-outcomes.ts <download-dir>`,
then prettier on `manifest.json`, then `UPDATE_EVALS=1` on the test.
