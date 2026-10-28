# Stage C backlog — what no agent change closes

The tracked list of Stage C items that need the owner, a repository setting, the Stage D merge or an
orchestrator ruling. The ledger of fixed findings lives with the orchestrator; this file records only
what stays open after the final gate's fix round 1 (2026-10-28, `build/phase-1`). Each item says why
code cannot close it and what would.

## Ruled — moved here by the orchestrator

| id | item | why it is open | what closes it |
|---|---|---|---|
| R7-2 | B11 Lane 2 and B15 (`claude plugin eval`) | `claude plugin eval` refuses to start on this account ("currently in early access"); the gate is not worked around | the owner's `claude update` + `claude plugin eval` showing the feature enabled — then the suite runs before release; otherwise both are recorded at Stage D as not runnable (tooling gated), never as met |
| R7-6 | ON-1 graders (Skill scoring) | Skill scoring runs through the same gated `claude plugin eval` (R7-2) | the same as R7-2 |

## Needs the Stage D merge or a repository setting

| finding | evidence | what closes it |
|---|---|---|
| `ci-default-branch-controls-inert` | GitHub reads schedules, `dependabot.yml`, the dependency graph and the alerts built on it from the DEFAULT branch only. At the final gate `main` held 0 files under `.github/`, was 440 commits behind `build/phase-1`, and `ci.yml` had 0 scheduled runs. So the weekly audit and macOS jobs, the weekly secret scan and Dependabot updates and alerts do not run while the product lives on `build/phase-1`. Agents may not touch `main` or the repository settings | the Stage D merge of `build/phase-1` into `main` (the controls then run from `main`), or the owner making `build/phase-1` the default branch until then |

## Before Stage D — the owner's install

Seen on the owner's install at the final gate. Each is an action at a terminal; none needs code.

- **A stray test worker.** An orphaned vitest fork worker (pid 63651, parent 1, working directory in an
  earlier mutation-test scratch folder) has run at about 100 % CPU since 2026-10-27. The agents'
  permission settings refused to kill it. It loads every local timing measurement: the server's
  startup read about 930–1 010 ms at both the pre-fix (`04adb5f`) and post-fix builds on 2026-10-28,
  against 552–561 ms at the gate (plan 10 A15a's bound is 1 s). The owner stops it with
  `kill 63651`.
- **Stale datasets.** The 8 dataset sources had not been refreshed since 2026-10-11 (about 16 days),
  and the launchd jobs were not installed. Lineup, waivers and the season simulator answer STALE_ONLY
  unless called with `allow_stale`; the error now names the source to refresh. `eff doctor --online`
  fails #10 (datasets) and warns #11 (launchd). The owner runs `eff refresh all`, then
  `eff install-launchd`.
- **R6-3's `league_fitted` is not live.** `premium_basis` is `cold_start_table` ("no previous-season
  transactions of this league are stored") because `eff transactions --backfill` has never run. The
  owner runs it once.
- **A red drift row the probe cannot read.** The probe has no public probe league on this install, so
  its shape probe is skipped (`private_league`). A red row on any view the probe does not read now
  has its own re-check: `eff refresh espn:drift`. `eff probe` and `eff doctor` name it and print the
  stored red diff. Setting `EFF_PROBE_LEAGUE_ID` locally to a public probe league from D2 makes the
  daily probe judge the league shape too. The ids stay in local config only.

## For an orchestrator ruling — the news matcher's fail-safe choices

`news-match-universe-homonyms` was fixed on the evidence of the gate's five items
(`src/sources/news/match.ts`, `teams.ts`). The final gate called part of the item "a fail-safe-versus-recall
policy question". These are the choices made, each with the alternative.

1. **Evidence that contradicts every holder of a shared name gives the name to no one.** Before, such
   a cue was "no evidence", and the most-owned holder took the name. Example: "Lamar Jackson:
   Intercepts a pass against the Ravens" went to the Ravens QB, though it is a defender's play
   against his team. This follows R7-4's precedent (fail safe instead of smarter parsing). The
   alternative is the old rule.
2. **A cue word between two teams names a game the subject plays in** ("Bengals vs. Vikings: Justin
   Jefferson questionable"). Only a holder on one of the two teams can take the name. The test
   expected no ref for this title by design. The evidence: the Browns namesake plays in neither game.
   As a consequence, a game naming both namesakes' teams ("Vikings vs. Browns: …") gets no ref; before,
   the order of the teams decided. The alternative is to treat the second team of a game as the
   subject's opponent, as before.
3. **A roster move ties its team to the name, like a team written next to it.** Examples: "Bengals
   sign CB Lamar Jackson", "…: Signs with Bengals", "Waived by", "Lands on … practice squad". A holder
   on another team is not the subject. A trade ("traded to") is excluded, because the universe still
   lists a traded player on the team he left, and his news must not be blocked by it.
4. **"`<team>` matchup" stays a weak cue.** It rules a holder out only while it leaves another, so it
   costs some recall. "Justin Jefferson: Expected to play in Vikings matchup" gets no ref. In
   "Michael Carter: Expected to start in Titans matchup" the Eagles namesake takes the name. Both
   holders of that name are under 1 % owned.

## For an orchestrator ruling — the stall bound's measurement

Plan 10 A16a's 50 ms stall bound is measured by wall-clock event-loop delay
(`tests/e2e/fixtures/heartbeat.cjs`). On a loaded host the operating system's preemption reads as the
server's stall: 107.1 ms locally against 21 ms on re-run, and 80.6 and 128.5 ms on CI. The bound and
the measurement are unchanged. A window over the bound is now repeated (at most three windows) only
with evidence that the host set it. The longest timer gap must hold no more of the main thread's own
CPU than the bound, and either the process saw an involuntary context switch inside it or an idle
control process beside the server stalled past 25 ms. A JavaScript block over the bound is never
excused. A host that sets every window fails with "cannot be measured", never a pass
(`tests/e2e/helpers.ts` `measureStall`; `tests/e2e/heartbeat-evidence.test.ts`). The alternative is
the old single window, which fails on a loaded machine.
