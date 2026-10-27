## Step 0 — orient (once per session)

1. **Status.** Call `espn_get_status` with `include_checks: true`. Note `server.tool_contract`, `server.toolset`, `credential.state`, `credential.stale_warning`, `credential.age_days`, `drift.status` and `drift.affected_tools`, `capabilities.write`, `league.seeding_confirmed` and every `checks[]` row.
2. **Settings, once.** Read the league settings: the `espn-ff://league/settings` resource if the client offers it, otherwise `espn_get_league`. Note `clock.current_matchup_period`, `clock.current_week_final`, `rules.waiver.uses_budget`, `rules.waiver.next_execution` and `rules.waiver.last_execution`, `seeding.mode_in_use` and `seeding.confirmed`, `rules.trade.deadline`, `roster.ir`, `scoring.settings_hash` and `scoring.golden.status`.

### Routing — before answering anything

| Seen in Step 0 | Do |
|---|---|
| `server.tool_contract` ≠ this Skill's `metadata.tool_contract` | Stop: "These Skills expect tool contract N but the server reports M — install the Skills and the server from the same release." |
| `credential.state: rejected` | Hand over to the `espn-fantasy-football:session-check` Skill and stop. |
| `credential.state: not_configured` | Hand over to the `espn-fantasy-football:session-check` Skill (its setup steps). A public league still answers keyless reads — say so. |
| `drift.status: red` | Say which views are unavailable and what still works (the table below), and continue with what works. |
| `drift.status: host_moved` | Say: "ESPN moved its API; stale data until the override is set or a new version ships" (the operator sets `EFF_ESPN_READ_HOST`, or waits for the release), and pass `allow_stale: true` on every ESPN-fact read for the rest of the session. |
| `scoring.golden.status: mismatch` (or a `scoring_mismatch` check) | Say this week's numbers are unverified and route to the `espn-fantasy-football:onboard` Skill for the diagnosis. |
| a `checks[]` row `ir_invalid` | Say it first, whatever the question — **An invalid roster**, below. |
| `seeding.confirmed: false` | Print one line — "seeding reading unconfirmed — assuming ESPN's rule; run `espn-fantasy-football:onboard` to record it" — and continue. |
| `credential.stale_warning: true` | One line: "your ESPN session is N days old; re-running `eff setup` in a terminal now avoids a game-day failure." |

**An invalid roster.** Whenever a result shows the user's roster invalid — a `checks[]` row `ir_invalid`, `ir.invalid: true` from `espn_get_roster` for the user's team, or `ir_invalid: true` on the user's row (`is_mine: true`) of an `all: true` read — open the answer with **"Roster INVALID — every add is blocked"**, whatever the question. Each player in `ir.invalid_players[]` — in IR with no injury tag, `ACTIVE` or `SUSPENSION` — must leave the IR slot first; when that list is empty, IR holds more players than its seats (`ir.slots`) and one of them must leave. A `QUESTIONABLE` or `DOUBTFUL` player may stay in IR: never tell the user to move him out, because he cannot go back in while he carries that tag. With a full bench the move forces a drop (`ir.forced_drop_needed`), and ESPN refuses every claim and free-agent add until it is done, so the fix is the first action, due before the next waiver run (`rules.waiver.next_execution`). Every claim, free-agent add or stream in the answer is shown as blocked until then, never as a move to make now.

**Skill names.** This text names another Skill of this bundle by its installed name — `espn-fantasy-football:<name>` with the plugin, `espn-<name>` when the Skills were copied one by one (a copy's text is written so). Start only the Skill with exactly the name written here, never another bundle's Skill that shares the bare name (the owner's Yahoo Skills use several of the same names). With only the server's prompts (this text came in an `espn.*` prompt) there is no Skill to start: name the prompt the user chooses instead.

| Skill | Prompt |
|---|---|
| `espn-fantasy-football:onboard` | `espn.onboard` |
| `espn-fantasy-football:weekly` | `espn.weekly` |
| `espn-fantasy-football:start-sit` | `espn.start_sit` |
| `espn-fantasy-football:stream-kdef` | `espn.stream` |
| `espn-fantasy-football:retro` | `espn.retro` |
| `espn-fantasy-football:apply` | `espn.apply` |
| `espn-fantasy-football:session-check` | `espn.session` |
| `espn-fantasy-football:waivers` | `espn.waivers` |
| `espn-fantasy-football:trade` | `espn.trade` (under `EFF_TOOLSET=full`) |
| `espn-fantasy-football:injury-cascade` | `espn.injury` (under `EFF_TOOLSET=full`) |
| `espn-fantasy-football:schedule-plan` | `espn.schedule` (under `EFF_TOOLSET=full`) |
| `espn-fantasy-football:roster-audit` | `espn.roster_audit` (under `EFF_TOOLSET=full`) |
| `espn-fantasy-football:news-check` | `espn.check` (under `EFF_TOOLSET=full`) |

**Which league.** If any tool named `ff_<something>` (the owner's separate Yahoo server, under whatever name it was installed) is also visible in this session and the user's message names no platform, **ask which league before any recommendation** — unless the conversation already established one, in which case name the league the answer is for in the first line.

**Toolset.** A step labelled `(P1; …)` or `**P1:**` runs only when `server.toolset` is `full`; under `core` take the P0 path that step names, or skip it and say so. A whole P1 Skill reads `server.toolset` too and, under `core`, stops with: "this Skill needs the full toolset — set `EFF_TOOLSET=full` in the server's env and restart the client".

### What still works when a view drifts (plan 01 §7)

| Drifted or missing | Still works | Stops, and what to say |
|---|---|---|
| `mRoster` | standings, settings, the player pool | roster tools and every lineup analytic — "your roster can't be read right now" (the last nightly roster snapshot is served as `stale`) |
| `kona_player_info` | rosters, standings, settings, schedule | free agents, ESPN projections, ownership — analytics fall back to the last pool snapshot, marked `stale` |
| `mMatchupScore` | schedule and results | live totals and ESPN's win probability |
| `mBoxscore` | live totals | per-player lines and the scoring self-check (`match: null`) |
| `mTransactions2` | everything else | league transactions (`ESPN_DRIFT_DETECTED`) |
| `mSettings` | nothing that scores | every number — the server refuses to score until a human reviews the change |
| `proTeamSchedules_wl` | everything, on the last stored schedule | lock times may be stale — say so |

### Never re-fetch within a session

**Never re-fetch anything already in the conversation under its class TTL.** A result whose `meta.age_s` is under its class TTL is reused verbatim (the Re-fetch column in references/tool-outputs.md is authoritative).

| Data | Rule |
|---|---|
| `espn_get_status` | once per session; again only after an error names auth or drift |
| `espn_get_league` / `espn-ff://league/settings` | once per session (an unchanged `settings_hash` means nothing changed) |
| `espn_get_roster` | once per hour per team (one team's read after an `all: true` read of the same week is the same cached read); again after `PRECONDITION_CHANGED`, or once with `force_refresh: true` in `espn-fantasy-football:start-sit`'s game-day branch |
| `espn_get_scoreboard` | once per session before the week's games |
| `espn_get_live_scoreboard` | on every call inside a game window (the server's 60 s cache absorbs repeats); once per session otherwise |
| `espn_list_players` | once per (status, position, sort, page) per session — **except across the waiver run**: when `last_execution` moves (`phase` flips from `pre_run` to `post_run`), every pool page is stale |
| `espn_project_players` | once per (player set, horizon, week) per session — deterministic for a `seed` and a `settings_hash` |
| `espn_get_schedule`, `espn_get_injuries` | once per session unless `meta.freshness` was `stale`; injuries again on game day |
| `espn_list_transactions` | once per session; again after the waiver run |
| `espn_analyze_*` | re-run only when an input changed (a new roster, a new injury, the run) — `data.inputs[]` says which inputs were used and how old they were — or **once** when the result came back `partial: true` (references/tool-outputs.md: the repeat reads what the budget held back) |
| (P1) `espn_get_player_usage`, `espn_get_depth_chart`, `espn_get_defense_profile`, `espn_get_news` | once per (players, window) per session — they read the local datasets, refreshed on a schedule, not ESPN |
| (P1) `espn_get_player_outlook` | once per player per session (ESPN's cached player rows) |
