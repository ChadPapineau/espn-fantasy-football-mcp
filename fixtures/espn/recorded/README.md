# Recorded ESPN fixtures (evidence)

Keyless captures of three **public** ESPN leagues for the 2026 season, scrubbed and frozen. This is
the *recorded* fixture class of plan 05 §3 (the fixture law): the scoring golden, `verify`'s tests
and plan 08 §6 read only from here. Nothing here is derived; every file is `derived: false` in
[`../manifest.json`](../manifest.json).

| directory | what |
|---|---|
| `season/` | `proTeamSchedules_wl` (the NFL schedule, byes, `statsOfficial`) and the season-route skeleton an unknown view returns |
| `league-a/`, `league-b/`, `league-c/` | per league: `mSettings`, `mTeam` (+`mStandings`), `mMatchup`, `mRoster` weeks 1–3, final `mBoxscore` weeks 1–3, one `kona_player_info` page; `league-a` also holds the drift probe's shape response and the league skeleton |
| `errors/` | the recorded 404 (`GENERAL_NOT_FOUND`) and 400 (`FILTER_LIMIT_MISSING_SORT`) bodies |

The league formats are in the manifest (`leagues.<slot>.format`): a 10-team five-FLEX league, a
10-team half-PPR FAAB league and a 12-team 6-point-passing-TD league with rolling waivers. No league
id, team name or member name of any recorded league is stored anywhere in this repository.

## How a file was made

1. `scripts/record-fixture.ts --public` fetched each view from the read host with no cookie, an
   honest User-Agent and ≥ 1.2 s between requests, and kept the raw response **outside** the repo.
2. `scripts/scrub-fixture.ts` anonymised it (research 03 §F.3: league id → 0, "Example League N",
   "Team A"…, "Member N", member GUIDs → `{00000000-0000-4000-8000-0000000000NN}` by first
   appearance, IP → `0.0.0.0`, outlook text → `[outlook N chars]`, logos and free text emptied),
   verified it (captured names, the real ids, GUIDs, IPs, the repo scanner with its local
   deny-list) and only then wrote it.

Manifest fields worth knowing:

- `sha256` — of the canonical JSON (sorted keys, no whitespace) of the file's body.
- `scoring.sha256` — of every scoring field (`appliedStats`, `appliedTotal`, `stats`, …), computed
  on the raw recording and re-verified on the scrubbed file: the scoring fields are ESPN's own.
- `pruned` — keys emptied to keep each file ≤ 1 MB (`rankings`: ESPN analyst ranks per week; never
  a scoring field). `kona_player_info` keeps every key.
- `part` — a response too large for one file is split, losslessly, along one top-level array
  (`mRoster.spN.p1.json`, `.p2.json`, …): concatenate that array in part order.
- `withheld` — units (a box-score matchup row, a roster entry) removed because a line of theirs
  matched the local repo deny-list; listed by JSON path only.
- `replaced` — public player-name leaves (`…player.fullName|firstName|lastName`) replaced by
  `Player <id>` instead of withholding their whole unit, when that name was the unit's only
  deny-list match (the pipeline does this for recordings made after 2026-10-06; the current files
  predate it, so every list is empty).
- `incomplete` — what the withheld units leave missing, value-free: the team ids whose roster lost
  an entry or whose matchup row is gone, and `matchups_missing`. **A fixture-mode test must treat
  those teams as incomplete** — an empty starting slot or a missing game there is an artefact of
  withholding, not ESPN data (the next re-recording replaces names instead, so most holes close).

The files are printed by prettier at width 1000 (the `.prettierrc` here) so each stat map stays on
one line; `tests/fixtures/recorded-manifest.test.ts` checks every file against the manifest.

## Not recorded yet (B1 grounding)

The Phase 0 plan does not request every view a P0 tool reads in fixture mode. B1 grounding extends
the keyless recorder to: `mMatchupScore` (the current week — A4), solo `mNav` (today only inside the
probe's `mSettings&mNav&mTeam` composite), `kona_player_info` with `filterIds` (C1/D2),
`kona_playercard` for ≤ 5 ids (B2) and `players_wl` (the first 200 rows — the C1 name index).
`mTransactions2` and `mPendingTransactions` (A6) are not visible anonymously [U]: their fixtures are
**hand-built** (`derived`, never evidence) until the Phase 1b cookie recording.
`src/drift/types.ts` `REQUIRED_PATHS_UNVERIFIED` lists the views whose required keys no recording
verifies yet; a test fails when one gains a solo recording without leaving that list.

## Re-recording

A manual job (plan 06 §1.5), once per season or after drift — see the usage block at the top of
`scripts/record-fixture.ts`. League ids are given in the environment only and never written down.
After re-recording, re-baseline the drift manifest (the probe's observed keys AND the per-view
`views` section of `fixtures/drift/manifest.json`) with `scripts/probe.ts --rebaseline`.
