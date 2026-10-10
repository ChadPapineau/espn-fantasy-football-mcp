# Recorded previous seasons (ESPN, keyless)

Finished previous seasons of the three public probe leagues — the Phase 3 inputs of plan 10 §3.3
(C4's seeding reproduction, C1's comparison with ESPN's weekly projections, C3's replay). Recorded
by `scripts/record-fixture.ts --public --history` (`scripts/espn-fixture/history.ts`), scrubbed per
research 03 §F.3; the measured record is [docs/evals/phase3-data.md](../../../../docs/evals/phase3-data.md).

## Layout

```
<season>/season/proTeamSchedules_wl.json       the pro schedule (seasons with box scores)
<season>/<slot>/mSettings.json                 the league's settings that season
<season>/<slot>/mTeam.json                     mTeam + mStandings: records, points for, playoffSeed
<season>/<slot>/mMatchup[.pN].json             every schedule row with its winner and totals
<season>/league-b/mBoxscore.spN.json           box scores: each entry's actual and ESPN's projection
manifest.json                                  the index (below)
```

Slots are the committed current-season slots (`league-a` … `league-c`), bound by each season's
`status.previousSeasons`. League ids are 0, team names `Team A`…, members `Member N`, member GUIDs
in the fixture range — consistent across seasons within a slot.

## The manifest

`manifest.json` lists every file with the recording manifest's entry shape (`fixtures/espn/manifest.json`):
`sha256` of the canonical scrubbed body, the scoring-field hash checked against the raw recording,
`part` for a response split to stay ≤ 1 MB, `withheld` / `incomplete` for units removed because a
line matched the local deny-list (in a box score a roster entry, never the matchup row). Per league
it summarises each attempted season (served or the typed 4xx, finished, teams, seeds, box-score
weeks, weekly projections) and lists the previous seasons not attempted.

It is not part of `fixtures/espn/manifest.json` on purpose: that file's hash is bound by the drift
entity manifest (`scripts/gen-manifest.ts`), and the drift observations stay current-season only.

## Using it

- Tests: `tests/fixtures/helpers/history-fixtures.ts` (`historyBody(season, slot, name)`,
  `servedSeasons(slot)`, `historyFixtureFetch(slot)`).
- Fixture mode: `createFixtureFetch({ dir: "<repo>/fixtures/espn", league: "league-b",
  manifest: "recorded/history/manifest.json" })` serves `/seasons/<season>/segments/0/leagues/0`.
- Held by `tests/fixtures/history-manifest.test.ts` (hashes, placeholders, C4's and C1's inputs).
