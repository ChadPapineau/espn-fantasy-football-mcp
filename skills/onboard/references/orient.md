## Step 0 — orient (once per session)

1. **Status.** Call `espn_get_status` with `include_checks: true`. Note `server.tool_contract`, `server.toolset`, `credential.state`, `credential.stale_warning`, `credential.age_days`, `drift.status` and `drift.affected_tools`, `capabilities.write`, `league.seeding_confirmed` and every `checks[]` row.
2. **Settings, once.** Read the league settings: the `espn-ff://league/settings` resource if the client offers it, otherwise `espn_get_league`. Note `clock.current_matchup_period`, `clock.current_week_final`, `rules.waiver.uses_budget`, `rules.waiver.next_execution` and `rules.waiver.last_execution`, `seeding.mode_in_use` and `seeding.confirmed`, `rules.trade.deadline`, `roster.ir`, `scoring.settings_hash` and `scoring.golden.status`.

### Routing — before answering anything

| Seen in Step 0 | Do |
|---|---|
| `server.tool_contract` ≠ this Skill's `metadata.tool_contract` | Stop: "These Skills expect tool contract N but the server reports M — install the Skills and the server from the same release." |
| `credential.state: rejected` | Hand over to the `session-check` Skill and stop. |
| `credential.state: not_configured` | Hand over to the `session-check` Skill (its setup steps). A public league still answers keyless reads — say so. |
| `drift.status: red` | Say which views are unavailable and what still works (the table below), and continue with what works. |
| `drift.status: host_moved` | Say: "ESPN moved its API; stale data until the override is set or a new version ships" (the operator sets `EFF_ESPN_READ_HOST`, or waits for the release), and pass `allow_stale: true` on every ESPN-fact read for the rest of the session. |
| `scoring.golden.status: mismatch` (or a `scoring_mismatch` check) | Say this week's numbers are unverified and route to `onboard` for the diagnosis. |
| a `checks[]` row `ir_invalid` | Say it first, whatever the question: the roster is invalid and adds are blocked until the IR slot is fixed. |
| `seeding.confirmed: false` | Print one line — "seeding reading unconfirmed — assuming ESPN's rule; run `onboard` to record it" — and continue. |
| `credential.stale_warning: true` | One line: "your ESPN session is N days old; re-running `eff setup` in a terminal now avoids a game-day failure." |

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
| `espn_get_roster` | once per hour per team; again after `PRECONDITION_CHANGED`, or once with `force_refresh: true` in `start-sit`'s game-day branch |
| `espn_get_scoreboard` | once per session before the week's games |
| `espn_get_live_scoreboard` | on every call inside a game window (the server's 60 s cache absorbs repeats); once per session otherwise |
| `espn_list_players` | once per (status, position, sort, page) per session — **except across the waiver run**: when `last_execution` moves (`phase` flips from `pre_run` to `post_run`), every pool page is stale |
| `espn_project_players` | once per (player set, horizon, week) per session — deterministic for a `seed` and a `settings_hash` |
| `espn_get_schedule`, `espn_get_injuries` | once per session unless `meta.freshness` was `stale`; injuries again on game day |
| `espn_list_transactions` | once per session; again after the waiver run |
| `espn_analyze_*` | re-run only when an input changed (a new roster, a new injury, the run) — `data.inputs[]` says which inputs were used and how old they were |
| (P1) `espn_get_player_usage`, `espn_get_depth_chart`, `espn_get_defense_profile`, `espn_get_news` | once per (players, window) per session — they read the local datasets, refreshed on a schedule, not ESPN |
| (P1) `espn_get_player_outlook` | once per player per session (ESPN's cached player rows) |
