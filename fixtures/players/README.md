# fixtures/players — the shared fixture roster

`fixture-roster.json` is the one list of real NFL players every Phase-1 fixture is built from:
the nflverse excerpts (plan 05 §3, plan 10 §3.1a "nflverse excerpts … for the fixture league's
players"), the crosswalk tests (plan 10 A6a), the engine's ESPN-vs-nflverse cross-check (plan 08
§3.2 E8) and any test that needs a real player. Build new fixtures from it rather than picking
players ad hoc, so every excerpt joins with every other **and** with the recorded ESPN fixtures.

## How it was chosen

Every player and team unit is **present in the recorded ESPN fixtures**
(`fixtures/espn/recorded/league-{a,b,c}/`), so its ESPN id, name, position and pro team are ESPN's
own; `tests/store/datasets/fixture-roster.test.ts` re-reads the recordings and checks each one,
including `box_weeks` — the league slot → weeks in which the player appears in a recorded
`mBoxscore`. The nflverse side was joined **on `espn_id`** (research 04 §C: the ESPN id is a
lookup) from the 2026-10-06 releases: `roster_weekly_2026` (team, jersey, ids, status — the
player's latest row, week 4), `stats_player_week_2026` (`stat_weeks`: the weeks 1–3 with a stat
line) and, for the one free agent absent from the season roster, `players` (`id_source:
"nflverse:players"`).

## Contents

- **24 players** — 4 QB, 6 RB, 7 WR, 4 TE, 3 K — plus **4 D/ST and 1 TQB** team units (ESPN unit
  ids −(16000 + proTeamId) and −(15000 + proTeamId); no `gsis_id` — a unit's identity is its team)
  and **1 decoy** (`decoys[]`): an nflverse-only player with exactly the same full name as a
  fixture player, at another team and position.
- `espn_team` is ESPN's spelling (`WSH`, `LAR`, `FA`); `team` is nflverse's (`WAS`, `LA`).
- `tags` mark the crosswalk / matcher / cross-check edge cases each entry exercises:
  - `rookie_2026` — three 2026 rookies (an RB, a WR and a K); all three have an nflverse
    `espn_id`, so a test of the "rookie without an id resolves by name + team + position" path
    (A6a) blanks the id in its own derived excerpt;
  - `name_collision` — the WR whose full name an nflverse LB (the decoy) shares: the matcher must
    never accept a name-only match;
  - `same_surname` — Allen (QB BUF, WR IND), Love (QB GB, RB ARI), Henry (RB BAL, TE NE);
  - `espn_name_suffix` / `nflverse_name_suffix` — the suffix is on one side only (ESPN "James
    Cook III" vs nflverse "James Cook"; nflverse "Oronde Gadsden II" vs ESPN "Oronde Gadsden");
  - `nickname_differs` — ESPN "Joshua Palmer" vs nflverse "Josh Palmer";
  - `apostrophe_name`, `hyphenated_name`, `punctuated_name`, `initials_name` — normalisation;
  - `free_agent` + `players_fallback` — ESPN pro team 0, absent from `roster_weekly_2026`,
    resolvable only through nflverse `players` (research 04 §C step 2);
  - `stat_week_gap` — an ESPN box-score week with no nflverse stat line that week;
  - `roster_only` — recorded in an `mRoster` page but in no recorded box score;
  - `reserve_status` — nflverse status `RES` in week 4;
  - `espn_abbrev_differs` — the Rams and Commanders D/ST (`LAR`→`LA`, `WSH`→`WAS`).
- `first_name` is nflverse's legal first name (`Joshua` for Josh Allen): match on the full name,
  not on first + last.

The file holds no league, team or member identifier of any fantasy league — only public NFL data;
the `league-a/b/c` keys of `box_weeks` are the placeholder slot names of the recorded fixtures.

## Licence and attribution

Player names, teams, jersey numbers and nflverse ids are from **nflverse** (`nflverse-data`
releases `weekly_rosters`, `stats_player`, `players`), © the nflverse contributors, licensed under
**Creative Commons Attribution 4.0 International (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data>. Redistributed here unmodified in substance (a
selection of columns and rows). ESPN ids, names and positions are facts taken from the recorded
ESPN fixtures (see `fixtures/espn/recorded/README.md`).
