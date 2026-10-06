## ESPN vocabulary — slots, positions, statuses, the waiver clock, the pages

Use ESPN's words in every answer and in every manual step.

### Lineup slots (the slot map — `slot`, `slot_id`)

| Slot | id | Holds |
|---|---|---|
| QB | 0 | quarterback |
| RB | 2 | running back |
| WR | 4 | wide receiver |
| TE | 6 | tight end |
| FLEX | 23 | RB, WR or TE (the league's own flex rule is in `roster.slots[].eligible_positions`) |
| D/ST | 16 | team defense / special teams |
| K | 17 | kicker |
| BE | 20 | bench — scores nothing |
| IR | 21 | injured reserve — scores nothing; only IR-eligible players |

A player's **position** (QB, RB, WR, TE, K, D/ST) comes from the position map, never from the slot map: the same number means different things in the two maps. Which slots a player may fill is his `eligible_slots[]`. Counts per slot are in `roster.slots[].count`.

### Injury status (`injury_status`)

`ACTIVE`, `QUESTIONABLE`, `DOUBTFUL`, `OUT`, `INJURY_RESERVE`, `DAY_TO_DAY`, `SUSPENSION`. **IR-eligible: `OUT` and `INJURY_RESERVE` only** (`ir_eligible`). A player already in IR whose tag moves to Questionable or Doubtful keeps the roster valid; one whose tag disappears makes it **invalid** — every add is blocked until he leaves the IR slot.

### Player pool status (`status`)

`FREEAGENT` (anyone may add now, first come first served), `WAIVERS` (only a claim, processed at the next run), `ONTEAM` (rostered). `espn_list_players` also takes `AVAILABLE` (both free agents and waivers).

### The waiver clock

- The next run is `rules.waiver.next_execution`; the last one is `rules.waiver.last_execution`. The days and hour a league runs on are `rules.waiver.process_days[]` and `process_hour` — a league manager can change them, so never assume the default.
- Under the default one-day waiver period most players clear Wednesday mornings; a dropped player clears at the first run at least 24 hours later; a player dropped within 24 hours of being added is an immediate free agent.
- A successful claim sends the team to the back of the order (`waiver_rank`); a failed claim costs nothing. After the run, every unclaimed player is a free agent.

### The pages a manual step names

Labels as ESPN shows them on the web and in the app this season; if a label reads slightly differently, the page and the order of steps are the same.

| To | ESPN page and control |
|---|---|
| change the lineup | **Roster → Edit lineup**: tap **Move** beside the player, then the target slot (or the player to swap with), then save |
| move a player to or from IR | **Roster → Edit lineup**: **Move** → the IR slot (only for `OUT` / `INJURY_RESERVE`) |
| add a free agent | **Players → Add**: the **+** beside the player; if the roster is full, ESPN shows the **drop prompt** — pick the drop there |
| claim a waiver player | **Players → Add** on a player marked WA: **Claim**; the same drop prompt when the roster is full; claims can be reordered until the run |
| propose a trade | **Players** or the other team's roster → **Trade** |

### Codes ESPN may show the user

`TRAN_LINEUP_LOCKED` (that player's game has started), `TRAN_ROSTER_SLOT_LIMIT_EXCEEDED` (too many players in a slot), `TRAN_ROSTER_SAME_SLOT` (nothing to change), `TRAN_INVALID_SCORINGPERIOD_NOT_CURRENT` (not the current week). They come from ESPN's own pages; this server never sends a transaction.
