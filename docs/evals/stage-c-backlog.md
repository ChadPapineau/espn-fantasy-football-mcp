# Stage C backlog — what no agent change closes

The tracked list of Stage C items that need the owner, a repository setting, the Stage D merge or an
orchestrator ruling. The ledger of fixed findings lives with the orchestrator; this file records only
what stays open after the final gate's fix rounds 1 and 2 (2026-10-28, `build/phase-1`). Each item
says why code cannot close it and what would.

## For the orchestrator's ledger

The final gate's second run (at `2ca70dc`) verified three findings fixed with the last verifiers' own
repros, yet the ledger still lists them as confirmed: `trade-locked-week-counted`,
`store-future-stamped-rows-block` and `crosswalk-unpaired-joins-silent`. They can be closed. R7-2 and
R7-6 stay open by ruling (below); B11 Lane 2 and B15 are recorded at Stage D as not runnable.

## Ruled — moved here by the orchestrator

| id | item | why it is open | what closes it |
|---|---|---|---|
| R7-2 | B11 Lane 2 and B15 (`claude plugin eval`) | `claude plugin eval` refuses to start on this account ("currently in early access"); the gate is not worked around | the owner's `claude update` + `claude plugin eval` showing the feature enabled — then the suite runs before release; otherwise both are recorded at Stage D as not runnable (tooling gated), never as met |
| R7-6 | ON-1 graders (Skill scoring) | Skill scoring runs through the same gated `claude plugin eval` (R7-2) | the same as R7-2 |

## Needs the Stage D merge or a repository setting

| finding | evidence | what closes it |
|---|---|---|
| `ci-default-branch-controls-inert` | GitHub reads schedules, `dependabot.yml`, the dependency graph and the alerts built on it from the DEFAULT branch only. At the final gate's second run `main` held 0 files under `.github/`, was 452 commits behind `build/phase-1`, and `ci.yml` had 0 scheduled runs. So the weekly audit, the weekly secret scan and Dependabot updates and alerts do not run while the product lives on `build/phase-1`; `ci.yml`'s `macos-due` keeps the weekly macOS run going on pushes to the branch (its last pass: 2026-10-27, at `167a44a`). Agents may not touch `main` or the repository settings | the Stage D merge of `build/phase-1` into `main` (the controls then run from `main`), or the owner making `build/phase-1` the default branch until then |

## Before Stage D — the owner's install

Seen on the owner's install at the final gate. Each is an action at a terminal; none needs code.

- **Stale datasets.** The 8 dataset sources have not been refreshed since 2026-10-11, and the launchd
  jobs are not installed. At the gate's second run `eff doctor --online` completed and printed all 26
  rows; 23 are ok, every ESPN and credential row among them (#9 drift, #14 clock, #15 host, #16
  credential, #17 league, #18 own team). It exits 1 only on #10 (all 8 sources expired) and warns on
  #11 (no launchd jobs). Until then lineup, waivers and the season simulator answer STALE_ONLY unless
  called with `allow_stale: true`; the error names the source to refresh. The owner runs
  `eff refresh all`, then `eff install-launchd`. The alternative is a ruling that this exit is
  accepted until the owner does.
- **R6-3's `league_fitted` is not live.** `premium_basis` is `cold_start_table` ("no previous-season
  transactions of this league are stored") because `eff transactions --backfill` has never run. The
  owner runs it once.
- **The probe judges no league shape on this install.** The probe has no public probe league here, so
  its shape probe is skipped (`private_league`); a red row on a view the probe does not read is
  re-checked by `eff refresh espn:drift`. Setting `EFF_PROBE_LEAGUE_ID` locally to a public probe
  league from D2 makes the daily probe judge the league shape too. The ids stay in local config only.
- **Which registration the owner installs.** A Claude Code session opened in the clone reads the
  repository's own `.mcp.json` as a project server, and it cannot start there (`CONNECTION_CLOSED`):
  `${CLAUDE_PLUGIN_ROOT}` and `${user_config.*}` expand only in a plugin install. Fix round 2 made the
  CLI say so: doctor row 2 lists that file as the plugin's own, never as a registration, and
  `eff uninstall` no longer prints the `claude mcp remove --scope project` that would delete the
  plugin's server from the clone (README "What to get right"). So on an install with no other
  registration, row 2 now warns "no client is configured" — the truth the old "ok" hid. The owner
  installs the plugin (README step 5) or `eff print-config`'s entry, and leaves the project server
  unapproved in sessions opened in the clone (`disabledMcpjsonServers: ["espn-fantasy-football"]` in
  the clone's `.claude/settings.local.json` declines it; agents never edit that file).
- **The stray test worker is gone.** The orphaned vitest worker (pid 63651) named here before was
  running at 02:27 on 2026-10-28 and gone by 03:24. The gate's clean install had replaced the
  `node_modules` it ran from at 02:28. Nobody signalled it.

## For an orchestrator ruling — the news matcher's fail-safe choices

`news-match-universe-homonyms` was fixed on the evidence of the gate's five items
(`src/sources/news/match.ts`, `teams.ts`). At `2ca70dc` no misattribution remains: the finding's
repros resolve correctly, and in 71 adversarial titles (the verifier's 50 and 21 more, over the
recorded universe) no star's item goes to a namesake and no namesake's item to a star. What remains is
a loss of recall by fail-safe design, which is a policy question. These are the choices made, each with
the alternative. Choices 5 and 6 were missing from this list before fix round 2. Fix round 2 changed no
rule; `tests/sources/news/match-universe.test.ts` ("the final gate's recall items") holds 5 and 6 as
built, with the examples below.

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
5. **A namesake's team named anywhere in the item, with no cue, blocks the prominent holder**
   (`sharedHolder`'s last line). Without a cue word a team in an item may be the subject's own or his
   opponent, so the namesake's team named loosely means the item may be the namesake's own news. The
   star loses every item that names his namesake's team. These give the 99.86 %-owned Vikings WR no
   ref: "Justin Jefferson: Leads Vikings past Browns", "…: Catches TD | Jefferson caught seven passes
   in a win over the Browns.", "…: Vikings host Browns on Sunday" and "…: Practice limited | … The
   Vikings face the Browns.". So do "Byron Young: Records two sacks in win over Eagles" (the 20.13 %
   Rams DE) and "Marcus Harris: Breaks up two passes in loss to Chiefs" (the 2.08 % Titans CB). The
   alternative, that prominence decides when no cue rules a holder out, gives the namesake's own news
   to the star: "Justin Jefferson: Records 10 tackles in Browns win", "…: Records sack | Jefferson had
   a sack in the Browns' loss to the Vikings." and "…: Lands on injured reserve | The Browns placed
   Jefferson on IR with a knee injury." would go to the WR at 0.80. The last one hands him an IR claim,
   which E10 reads from news. A middle option, that prominence decides only when the star's own team
   is named too, recovers the three titles that name both teams but still misattributes the second
   counter-example, which names both teams too.
6. **A namesake's team attached to the name never gives him the name past a prominent holder**
   (`sharedHolder`, the attached branch). "Browns LB Justin Jefferson: Records sack", "Eagles DT Byron
   Young: Records two sacks" and "Chiefs DT Marcus Harris: Records sack" get no ref; a cue that rules
   the star out lets the attached namesake take it ("Eagles DT Byron Young: Records sack against the
   Rams"). The reason is the lagging universe (choice 3's exclusion): after a trade of the star to
   the namesake's team, "Browns WR Justin Jefferson" would otherwise go to the LB. **The bare-surname
   path does not follow this rule:** "Browns LB Jefferson: Records sack" gives the Browns LB at 0.60
   (`last_name_team`, held as built), and so would "Browns WR Jefferson: Catches TD" after such a
   trade. The options: (a) the attached namesake takes the name on both paths (recall; the post-trade
   item misattributes); (b) both paths block (the surname path loses the LB's own item); (c) a
   position word written next to the name is evidence like the attached team. ESPN's `position_id` is
   in `ds_players` and would join the matcher's universe (`UNIVERSE_SQL`), so "LB" rules out a WR and
   "WR" rules out an LB. Under (c) the LB takes "Browns LB Justin Jefferson", and the post-trade
   "Browns WR Jefferson" gets no ref on either path.

**Scope, measured** over the recorded universe (`fixtures/espn/recorded/season/players_wl.json`,
2 669 rows). 16 full names are shared. 5 have a prominent holder (at least 1 % owned and 10 times each
other holder): Lamar Jackson, Justin Jefferson, Byron Young, Marcus Harris and Chris Jones. Choices 5
and 6 can act only where a namesake has a team: Justin Jefferson (the Browns LB, 0.35 %), Byron Young
(the Eagles DT, 0.08 %) and Marcus Harris (the Chiefs DT, 0.02 %). The Lamar Jackson and Chris Jones
namesakes are free agents. In the owner's league, which has no defensive slots, only the Vikings WR's
items count: those that name the Browns.

**The fixer's recommendation:** keep 1–5 as built, because the alternative to 5 puts a namesake's
injury and transaction news on the star, which E10 then reads as his claim. For 6, take (c) as a
follow-up, or (b) now if the two paths must agree before Stage D.

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
the old single window, which fails on a loaded machine. The final gate's second run needed no repeat:
its worst stalls were 17.1 and 25.4 ms.
