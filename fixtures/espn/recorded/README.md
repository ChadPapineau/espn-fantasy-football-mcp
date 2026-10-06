# Recorded ESPN fixtures (evidence)

Keyless captures of three **public** ESPN leagues for the 2026 season, scrubbed and frozen. This is
the *recorded* fixture class of plan 05 §3 (the fixture law): the scoring golden, `verify`'s tests
and plan 08 §6 read only from here. Nothing here is derived; every file is `derived: false` in
[`../manifest.json`](../manifest.json).

| directory | what |
|---|---|
| `season/` | `proTeamSchedules_wl` (the NFL schedule, byes, `statsOfficial`), `players_wl` (the season player index — a root JSON array in id order, the C1 name index) and the season-route skeleton an unknown view returns |
| `league-a/`, `league-b/`, `league-c/` | per league: `mSettings`, `mTeam` (+`mStandings`), `mMatchup`, `mRoster` weeks 1–3, final `mBoxscore` weeks 1–3, one `kona_player_info` page, `mMatchupScore` for the current week (`sp4`: post-game, matchups still `UNDECIDED`) and the last final box-score week (`sp3`), solo `mNav`, and the two `filterIds` captures of the same ≤ 25 players (20 spread over the league's roster, the rest from the free-agent page): `kona_player_info.ids` and `kona_playercard` (weekly actual splits); `league-a` also holds the drift probe's shape response and the league skeleton |
| `errors/` | the recorded 404 (`GENERAL_NOT_FOUND`), 400 (`FILTER_LIMIT_MISSING_SORT`) and 401 (`AUTH_COMMUNICATION_NOT_VISIBLE`, the board route answered anonymously) bodies |
| `../synthetic/errors/` | **not recorded**: the private-league 401 (`AUTH_LEAGUE_NOT_VISIBLE`) cannot be obtained keylessly, so it is hand-written from research 03 §A.4 and listed under `synthetic_files` with `synthetic: true`. Synthetic is allowed for error bodies only — never for a scoring field |

The recorded views agree with each other, and a test holds them to it: every `mMatchupScore` team
total of the final week equals that week's box score, and every `kona_playercard` weekly actual
split equals the box-score line of the same player-week (`id`, `appliedTotal`, `appliedStats`,
`stats`).

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
  a scoring field). `kona_player_info` and `kona_playercard` keep every key.
- `part` — a response too large for one file is split, losslessly, along one array
  (`mRoster.spN.p1.json`, `.p2.json`, …): concatenate that array in part order. `array` is `$`
  when the body itself is the array (the player index, should it outgrow 1 MB); `id_range` gives
  each part's first and last element id.
- `withheld` — units (a box-score matchup row, a roster entry, an index row) removed because a line
  of theirs matched the local repo deny-list; listed by JSON path only.
- `replaced` — public player-name leaves (`…player.fullName|firstName|lastName`, or the names of an
  index row) replaced by `Player <id>` instead of withholding their whole unit, when a name was the
  only deny-list match. Empty in this recording: no name matched.
- `incomplete` — what the withheld units leave missing, value-free: the team ids whose roster lost
  an entry or whose matchup row is gone, `matchups_missing`, and `rows_missing` (index or kona
  rows — a count, never an id). **A fixture-mode test must treat those teams as incomplete** — an
  empty starting slot or a missing game there is an artefact of withholding, not ESPN data. The
  2026-10-06 re-recording closed every hole a name or a digit run caused; what is left is one
  public player whose id equals a term of the local deny-list (ids are never altered — they key
  the scoring evidence), so his roster entries, his box-score matchup rows and his index row stay
  withheld.
- `synthetic_files` — hand-written error bodies (see `../synthetic/`): `basis` names the source
  of the shape; never evidence, never a scoring field.

The files are printed by prettier at width 1000 (the `.prettierrc` here) so each stat map stays on
one line; `tests/fixtures/recorded-manifest.test.ts` checks every file against the manifest.

## Not recorded (and why)

`mTransactions2` and `mPendingTransactions` (A6) are not visible anonymously [U]: their fixtures are
**hand-built** (`derived`, never evidence) until the Phase 1b cookie recording. `mMatchupScore`
before kickoff (a week with no game started) was not available at capture time — the current
period was post-game; re-record during a Tuesday–Thursday window to add it. `mStandings` exists
only inside the `mTeam&mStandings` composite. `src/drift/types.ts` `REQUIRED_PATHS_UNVERIFIED`
lists the views whose required keys no solo recording verifies; a test fails when one gains a solo
recording without leaving that list.

The per-view, per-entity drift manifest the in-call detector reads is
[`../../drift/entity-manifest.json`](../../drift/entity-manifest.json), generated from these files
by `scripts/gen-manifest.ts`.

## Re-recording

A manual job (plan 06 §1.5), once per season or after drift — see the usage block at the top of
`scripts/record-fixture.ts`. League ids are given in the environment only and never written down.
After re-recording, re-baseline the drift manifest (the probe's observed keys AND the per-view
`views` section of `fixtures/drift/manifest.json`) with `scripts/probe.ts --rebaseline`, then
regenerate the entity manifest with `scripts/gen-manifest.ts` (`--check` verifies it is current).
