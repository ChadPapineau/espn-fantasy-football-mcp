# Stage C backlog — what no agent change closes

The tracked list of Stage C items that need the owner, a repository setting, the Stage D merge or an
orchestrator ruling. The ledger of fixed findings lives with the orchestrator; this file records only
what stays open after the final gate's fix rounds 1, 2 and 3 (2026-10-28, `build/phase-1`). Each item
says why code cannot close it and what would.

## For the orchestrator's ledger

The final gate's second run (at `2ca70dc`) and its third (at `125c184`) verified three findings fixed
with the last verifiers' own repros, yet the ledger still lists them as confirmed:
`trade-locked-week-counted`, `store-future-stamped-rows-block` and `crosswalk-unpaired-joins-silent`.
They can be closed. `news-match-universe-homonyms` has no misattribution left (the third run); it
stays open only for the ruling below. R7-2 and R7-6 stay open by ruling (below); B11 Lane 2 and B15
are recorded at Stage D as not runnable.

## Ruled — moved here by the orchestrator

| id | item | why it is open | what closes it |
|---|---|---|---|
| R7-2 | B11 Lane 2 and B15 (`claude plugin eval`) | `claude plugin eval` refuses to start on this account ("currently in early access"); the gate is not worked around | the owner's `claude update` + `claude plugin eval` showing the feature enabled — then the suite runs before release; otherwise both are recorded at Stage D as not runnable (tooling gated), never as met |
| R7-6 | ON-1 graders (Skill scoring) | Skill scoring runs through the same gated `claude plugin eval` (R7-2) | the same as R7-2 |

## Needs the Stage D merge or a repository setting

| finding | evidence | what closes it |
|---|---|---|
| `ci-default-branch-controls-inert` | GitHub reads schedules, `dependabot.yml`, the dependency graph and the alerts built on it from the DEFAULT branch only. At the final gate's second run `main` held 0 files under `.github/`, was 452 commits behind `build/phase-1`, and `ci.yml` had 0 scheduled runs. So the weekly audit, the weekly secret scan and Dependabot updates and alerts do not run while the product lives on `build/phase-1`; `ci.yml`'s `macos-due` keeps the weekly macOS run going on pushes to the branch (its last pass: 2026-10-27, at `167a44a`). Agents may not touch `main` or the repository settings | the Stage D merge of `build/phase-1` into `main` (the controls then run from `main`), or the owner making `build/phase-1` the default branch until then |
| the dev-only `vite` advisories (informational) | `vite` 8.3.2, a dependency of the dev-only `vitest` 5.0.3, sits in the range of GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw and GHSA-587h-7wmj-h5pm (the bundled `launch-editor`), GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22 and GHSA-vfpm-58rq-9qcg (CI's full-tree audit at `125c184`: "fix available via `npm audit fix`"). Every one is a dev-server HTTP path: custom middleware, `server.fs.allow`, `?vite-wasm-instance`, `/__open-in-editor`. Vitest starts that server's listener only for `ui`, `api` or browser mode (`vitest` 5.0.3 `dist/chunks/index.DpLw24bj.js`: `if (config._apiRequested) await server.listen(…)`, else `api = { middlewareMode: true }`), and `vitest.config.ts` sets none of them, so no request ever reaches it here. The runtime audit is 0; plan 02 §7.1 makes the full-tree audit report-only, and Dependabot would raise the patch but reads manifests from `main` only (the row above). A bump downloads new third-party code, which this unattended fix round does not do | Dependabot's update after the Stage D merge, or the owner's `npm update vite` with the lockfile diff reviewed, then `npm run test:coverage` |

## Before Stage D — the owner's install

Seen on the owner's install at the final gate. Each is an action at a terminal; none needs code.

- **Stale datasets.** The 8 dataset sources have not been refreshed since 2026-10-11, and the launchd
  jobs are not installed. At the gate's second and third runs `eff doctor --online` completed and
  printed all 26 rows; 23 are ok, every ESPN and credential row among them (#9 drift, #14 clock, #15
  host, #16 credential, #17 league, #18 own team, #19 sources). It exits 1 only on #10 (all 8 sources
  expired) and warns on #11 (no launchd jobs). That exit is the design: plan 03 §5 makes doctor's
  exit code the worst row's, and row #10 fails a source past its hard limit with the remedy
  "`eff refresh all` (or `eff refresh <source>`)". Until then lineup, waivers and the season simulator
  answer STALE_ONLY unless called with `allow_stale: true`; the error names the source to refresh.
  The owner runs `eff refresh all`, then `eff install-launchd`. The alternative is a ruling that this
  exit is accepted until the owner does.
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

**Scope, measured** over the matcher's own universe, built as the refresh wiring builds it
(`universeFromEspnPlayers` over `fixtures/espn/recorded/season/players_wl.json`): 2 574 persons, the
2 669 rows less the 95 D/ST rows (ids ≤ 0). The matcher keys a name by `mergeName` (case,
punctuation and a trailing generational suffix folded), and 16 of its keys have more than one holder.
11 of the 16 are the identical full name. The other 5 differ only in a suffix ("Michael Carter" and
"Michael Carter II"; the matcher reads a suffix written after the name). The gate's third run counted
the 11 identical names; the earlier "16 full names" counted the keys, over the raw rows, where it is
also 16. 5 keys have a prominent holder (at least 1 % owned and 10 times each other holder), all among
the 11: Lamar Jackson, Justin Jefferson, Byron Young, Marcus Harris and Chris Jones. Choices 5 and 6
can act only where a namesake has a team: Justin Jefferson (the Browns LB, 0.35 %), Byron Young (the
Eagles DT, 0.08 %) and Marcus Harris (the Chiefs DT, 0.02 %). The Lamar Jackson and Chris Jones
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
its worst stalls were 17.1 and 25.4 ms. Its third run read 41.6 ms for the parallel `full` calls
(`tests/e2e/stall-parallel.test.ts`), within the bound and on the same code path the second run read
25.4 ms on; fix round 3 adds no work there (`fx-10h` has one division, so the division-rule ranking
of §B8 never runs).

## For the owner or an orchestrator ruling — F8, division winners first

Stage C live finding F8 (`docs/evals/stage-c-live.md`), raised again at the final gate's third run.
The owner's league has two divisions and ESPN's `playoffSeedingRuleBy` 0. The season simulator seeds
division winners first in every league with more than one division under the ESPN rule reading
(plan 07 E3; research 05 §2.1 quotes ESPN's seeding pages), and the owner states the rule as "record
first, then Total Points For". `espn_get_league` restates the settings exactly either way.

**Fix round 3 (changelog §B8):** the simulator now ranks every path by record alone as well. E3
`season` returns `division_rule` (`divisions`, `p_playoffs_record_only`, `p_bye_record_only`; null
with one division or without an ESPN rule reading). Its `rec.assumptions[]` states both answers with
the revisit trigger, and the Skills print each assumption. The answer no longer rests on an
assumption it does not state. The chain itself is unchanged, because which chain is right is not
the code's to decide.

**The evidence.** The one recorded league that tells the two chains apart is `league-c` (four
divisions, `playoffSeedingRuleBy` −1): its seasons reproduce exactly only with division winners
first (`docs/evals/phase3-waivers-seeding.md`). `league-a`, `league-b` and `fx-10h` read 0 with one
division, where the step changes nothing. The owner's five finished seasons reproduce exactly under
the shipped chain (C4, live), but none ranks a division winner below a non-winner by record, so they
fit both chains. So 0 with divisions has no discriminating sample. The reading that −1 means
"division winners first" and 0 means "by record" fits every observation, but it rests on one league.

**What closes it**, in order of cost:
1. The owner checks the league's settings page (Divisions and Playoffs) and says whether division
   winners take the top seeds. If they do, nothing changes.
2. If they do not, a ruling picks one of: (a) seed by record alone when `playoffSeedingRuleBy` is 0
   (the hypothesis above; one code path, tested on `league-c` and the owner's seasons); (b) a
   stored, owner-confirmed division rule beside the seeding reading, asked once by the onboard
   Skill (a configuration key: plan 03 §3 and the onboard Skill change).
3. Either way the first finished season in which a division winner trails a non-winner by record
   settles it from ESPN's own seeds (C4's reproduction).

## Informational — recorded, no change

- **The Skills listing margin.** The listing Claude Code sends every turn is 4 549 of the 4 600
  ceiling (headroom 51). The ceiling is downward-only, and both `check-skills` (Lane 1) and
  `tests/mcp/size.test.ts` fail any growth past it. Fix round 3 changed no Skill frontmatter. Buying
  headroom means cutting trigger words from `when_to_use`, which is a Skill-recall decision, not a
  defect fix.
- **Fixture mode and an unrecorded scoring period.** `fx-10h` records weeks 1–5. A tool that reads a
  per-period view for a later week (box score, roster, lineup, E3) answers INTERNAL with reason
  `fixture_missing`; the scoreboard, schedule and transactions answer from views that span the
  season. This is plan 05 §3.1's "distinct error naming the path", and it is loud on purpose: a
  fixture gap is a hole in the test world, and an absorbable code such as NOT_FOUND could let a test
  pass without reading what it meant to read (`isOptionalReadFailure` already absorbs it for the
  optional reads). Live, ESPN answers those weeks.
