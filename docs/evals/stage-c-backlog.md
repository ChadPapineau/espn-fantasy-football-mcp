# Stage C backlog — what no agent change closes

The tracked list of Stage C items that need the owner, a repository setting, the Stage D merge or an
orchestrator ruling. The ledger of fixed findings lives with the orchestrator; this file records only
what stays open after the final gate's fix rounds 1, 2 and 3, ruling R8-3's fix and its fix rounds
2 and 3, and ruling R8-6's fix (2026-10-28, `build/phase-1`). Each item says why code cannot close it
and what would.

## For the orchestrator's ledger

**Ruled R8-5 (2026-10-28, `docs/plan/changelog.md` §R8):** the three findings below are closed as
fixed; `ci-default-branch-controls-inert` closes with the Stage D merge.

The final gate's second run (at `2ca70dc`) and its third (at `125c184`) verified three findings fixed
with the last verifiers' own repros, yet the ledger still lists them as confirmed:
`trade-locked-week-counted`, `store-future-stamped-rows-block` and `crosswalk-unpaired-joins-silent`.
They can be closed. `news-match-universe-homonyms`: the fourth run found namesakes' items still
reaching the star; ruling R8-3 is built (`cb2bcc7`; below, and changelog §B9), fix rounds 2 and 3
answered the independent attacks on it (`91a8c1b`, `c16b9d8`), and ruling R8-6 then made the matcher
fail closed for shared names (`154838b`), which closes the open roster-move title (below). R7-2 and R7-6
stay open by ruling (below); B11 Lane 2 and B15 are recorded at Stage D as not runnable.

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

- **Stale datasets (R8-1: accepted at the Stage C gate; closed by the Stage D install).** The 8 dataset sources have not been refreshed since 2026-10-11, and the launchd
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

## Ruled R8-3 — the news matcher's fail-safe choices

**Superseded in part by R8-6 (2026-10-28):** R8-3's fix rounds did not converge (15, 16 and 16 violations against `52796bf`, `7b9572c` and `dbe9686`). For a shared name the matcher now fails closed: only a label next to the name picks a holder. The prominent holder takes the item only when it names no team and no position anywhere. Everything else gets no ref and is counted. The open items below that R8-6 does not settle are rebuilt or closed by its fix run (changelog §R8, §B9).

**Built under R8-6 (2026-10-28, commit `154838b`; changelog §B9, "R8-6 — the matcher fails closed").**
The shared-name path is rebuilt: `labels.ts` (the label next to the name, and the broad scan),
`positions.ts` (the position forms), `cues.ts` removed. A name one universe player holds matches
exactly as at `f41e810`. What it closes:

- **The open roster move.** "Lamar Jackson: Signs with Ravens practice squad" gets no ref and is
  counted: a roster move is no label (R8-6 (c)). So do "Justin Jefferson: Signs with Vikings | …" and
  "Ravens sign Lamar Jackson to practice squad".
- **The 16 violations open at `dbe9686`.** None reaches the other holder.
  `tests/sources/news/match-r86-cases.test.ts` holds each, with every variant it named, at its R8-6
  outcome. So does every one of the 443 misattributions the attacks on R8-3's three rounds found.
- **The known limits below.** "A game not his own" is closed: games are not read. "A topic's clause
  naming the player he hit" and "a teammate of no known team" are no longer readings: such items get
  no ref and are counted. "A free-agent namesake signed since" is closed, because no cue rules a holder
  out: "Lamar Jackson: Carted off with ankle injury | … loss to the Steelers." names a team and gets no
  ref. "edge rusher" for the Chiefs' Chris Jones stays no ref. "The residual's verbs" stays the
  accepted residual where an item names no team and no position ("Lamar Jackson: Waived with injury
  designation | Jackson (hamstring) reverts to injured reserve." gives the QB 0.80). Its other example
  names a position ("| The receiver beat him deep.") and gets no ref now.
- **The fixer's open concerns.** The five `PLAY_OBJECTS` entries went with the cue lists. The perf
  bounds stay ratios: the last attack's 4,000-character item costs 1.3 times a benign one (`dbe9686`
  about 210 times), and 1,000 of them build in 0.9 s.

What stays, as R8-6 accepts it:

- **The residual.** A namesake's item that names no team and no position goes to the prominent
  holder at 0.80. Three of the earlier batteries' 1,167 labelled texts do: "Justin Jefferson: Sacks
  Carson Wentz twice in win", "Joe Burrow: Picked off by Lamar Jackson" and "Chris Jones: Punts six
  times for 280 yards".
- **The recall loss.** A shared name's item that names a team or a position, with no label next to
  the name, gets no ref and is counted, with ESPN's own status still behind the star. Over the labelled
  batteries this is 158 right star refs and 52 namesake refs lost against `dbe9686` (191 and 24 against
  `f41e810`, which loses 380 wrong refs). One real fixture item loses its ref: the CBS "Lamar Jackson
  injury update: Ravens QB …". Matching an item's opponent against the week's schedule would recover
  much of it; it is not built.

**Fix round 2 of R8-6 (2026-10-28, commit `1ca78bf`; changelog §B9, "R8-6 fix round 2").** The
independent attack on the first build found 23 violations. What closes:

- **The scan's 14 gaps.** Team-site domains, ranks, unit and alignment forms, depth-chart names,
  hyphenated spellings, roles, all-caps plurals, cities, singulars, other sites' and legacy
  abbreviations, hashtags, short names and lower-case abbreviations each take the residual away now.
  The round's scan-sweep of 223 team forms misses none; city nicknames, stadiums, fans' names and the
  teams' own hashtags are listed too.
- **The label readings.** A word before a label of teams alone (it must open its clause), a line or
  paragraph break and a closing quotation mark break a label. ESPN's own position fits only its own id, so "Vikings CB
  Smith" is no S's and "Eagles DT Byron Young" is the Eagles DT's. The two-word forms and "EDGE" are
  labels again. Every mention's label counts ("Lamar Jackson: Limited | Ravens QB Lamar Jackson …").
- **The spelling.** A suffix narrows the holders; it picks no one past the scan.
- **The character sets.** One fold reads both the label and the scan, and every entry is held by a
  behaviour (the mutation run caught all 626 deletions).

What stays, as R8-6 accepts it: the residual; the recall loss (measured in §B9: against `6ba7bb1`,
4 star and 12 namesake refs over the 1,167 earlier texts, each a form the scan now finds, a writer's
position ESPN does not give him, or a team after a blocker word); and the new ordinary-word forms,
which take a star's residual away where they stand ("throws a dime", "a roster slot", "per CBS
Sports").

Readings for the re-gate to check:

- **(a) The label is the first mention's.** Superseded by fix round 2: every mention's label counts,
  and a segment that writes the name both with a label and without one picks no one ("Lamar Jackson:
  Throws pick to CB Lamar Jackson"). A name the title writes alone takes the blurb's label, even where
  the blurb contrasts the other holder ("Justin Jefferson: Released by Browns | Not to be confused with
  Vikings' Justin Jefferson" gives the WR).
- **A label next to the name picks him in his namesake's item.** "Ravens QB Lamar Jackson's namesake
  signs with Bengals" gives the QB at 0.95, as at every earlier build.
- **An inline tag breaks a label.** "Vikings<b> WR</b> Justin Jefferson" gets no ref: any tag is a
  break.
- **Choice 6 stands.** A prominent holder whom no position of the label rules out blocks a team-only
  namesake label ("Cleveland's Justin Jefferson", "Philadelphia's Byron Young": no ref).
- **A free agent fits no team label.** "Bengals CB Lamar Jackson" gets no ref; the universe lists no
  Lamar Jackson on the Bengals.
- **Spelling stays as at `f41e810`.** Superseded by fix round 2: a written suffix narrows the
  holders, and the one it leaves takes the residual only when the scan finds nothing.
- **The scan errs toward finding.** "leads the pack", "OT" and "medical bills" each take the residual
  away.

**Ruled R8-3 (2026-10-28, changelog §R8):** choices 1–5 stand; a loose team mention on a shared name is
never evidence for a holder; the opponent cues cover result and play wording; choice 6 takes (c),
position words from ESPN's `position_id`, on both paths. The gate's fourth run found namesake items
still reaching the star at `f41e810` (repros kept with the orchestrator, outside the repo).

**Built (2026-10-28, commit `cb2bcc7`; changelog §B9).** Every clause holds, each with tests that fail
on the code at `f41e810` (`tests/sources/news/match-r83.test.ts`, `positions.test.ts`). The
gate's four batteries are committed as tests, every title with its label (battery 1 the gate's own,
2–4 their stated intent). Battery 1 had 10 misattributions; it has none now, and 34 right refs where
it had 20. The namesakes' injury and play items of batteries 2–4 get no ref or their own holder, never
the star. What R8-3 built:

- **Cues (clause 3).** The holders of a shared name are told apart with a second reading of the cue
  words (`teams.ts` `shared`). It reads the old words; 26 result words such as "win over", "loss to",
  "beat", "fell to" and "past", never before the team's possessive; 36 play words such as "sacks",
  "intercepts", "picks off", "brought down" and "torches"; and, between two teams, "host", "visit" and
  "face". A unique name keeps the old reading.
- **Loose teams (clause 2).** A team not written next to the name and not tied to it by a roster move,
  a game's teams included, only rules holders out. `full_name_team` on a shared name needs the
  attached team or the move.
- **Positions (clause 4, choice 6(c)).** `ds_players.position_id` joins the universe (`UNIVERSE_SQL`,
  `universeFromEspnPlayers`, the run's temp file). A closed vocabulary (`positions.ts`) is read next to
  the name and in a sentence describing the subject, and rules out every holder of another position.
  Writers' words cover ESPN's split labels: DL is DT or DE, edge and LB are DE or LB, a DB is a CB or S.
  The LB takes "Browns LB Justin Jefferson" and "LB Justin Jefferson"; the free-agent CB takes "Free-agent
  cornerback Lamar Jackson visits Bengals"; the post-trade "Browns WR Jefferson" gets no ref on either
  path.
- **The bare surname (clause 4: the same rule).** A surname several universe players share (302 of
  1,604) needs a team written next to it or tied to it by a move; a position filters it, and a sharer
  who outshines the one left and is not ruled out blocks him. "Cleveland's Jefferson" and "Jefferson:
  Questionable for Vikings" get no ref (the second was the Vikings WR's at 0.60).
- **Counted (clause 5).** An item whose evidence leaves no single holder keeps no ref for that name. The
  publish step counts it, with the items no player matched, in `eff refresh news`'s warnings; every item
  stays stored and listed.
- **The residual (clause 6).** No team of a holder's, no position, no cue: the prominent holder at 0.80.

**Fix round 2 (2026-10-28, commit `91a8c1b`; changelog §B9, "Fix round 2").** The independent attack on
`cb2bcc7` found 14 ways that build still broke R8-3. A loose mention cancelled a ruled cue, so "…win
over the Minnesota Vikings" gave the star the namesake's injury. A sentence about the player the
subject faced was read as his position. The residual was read more widely than clause 6 words it. The
cue list missed "win at", the strip and the blocked kick, and read idioms as games. The surname path
read no cues, and a shared surname could vanish from the counts. Each is fixed at root, and
`tests/sources/news/match-r83-round2.test.ts` holds each one with the attack's texts:

- **Cues (clause 3).** The shared-name reading is `src/sources/news/cues.ts`. A team's full name is
  one mention; capitals, short names and abbreviations in a context are teams. A cue is about the
  person named last before it in its sentence, a play word only right after his name, and no loose
  mention cancels it. The lists gain the result and play wording the attack named, and a cue holds
  only where the words after the team read as the game or the play. The idioms that name a team's own
  loss are no cue ("lost to the Browns for the season", "a big loss to the Eagles", the draft, "Beats
  Browns teammate").
- **The residual (clause 6), as worded.** Prominence decides only for an item that names no team and
  no position. One naming either that leaves several holders gets no ref and is counted (clause 5).
- **Describing sentences (clause 4).** A sentence elsewhere in the item never picks a holder. It
  blocks a pick it contradicts and supports a holder a cue left, and it yields to a team or position
  written next to the name. A pronoun ("The linebacker covering him") makes it no evidence at all. The
  written forms are wider: every mention, the surname alone included, tags with abbreviations,
  appositives with ages, the headline topic's clause.
- **Both paths, one rule (clause 4).** A shared surname is decided by the full name's function with
  its own cues ("Cleveland's Jefferson: Sacks Vikings QB twice" is the Browns LB's at 0.60). One left
  to no one in an item that names a team is counted.

Battery 1 has no misattribution: 28 right refs and the open item below (round 1 had 34; the recall lost
is clause 5's and the describing sentences'). Batteries 2–4 give no namesake item to a star except
clause 6's accepted residuals, which name no team, no position and no cue: the three "Placed on IR"
titles, "Lamar Jackson: Inks reserve/future contract" and "Lamar Jackson: Waived with injury
designation | Jackson (hamstring) reverts to injured reserve."

**Fix round 3 (2026-10-28, commit `c16b9d8`; changelog §B9, "Fix round 3").** The independent attack on
`7b9572c` found 16 ways that build still broke R8-3, or lost what `f41e810` had for no clause's sake.
Each is fixed at root, and `tests/sources/news/match-r83-round3.test.ts` holds each one with the
attack's texts:

- **Topic clauses (clause 4).** "<name> injury update: <position> …" labels him only when the rest of
  its sentence names no other team, position, person or second-player word ("also", "teammate",
  "him" …). "Lamar Jackson injury update: Steelers cornerback fined for hit on Ravens QB" gets no ref
  (it was the free-agent CB's); "…: Ravens QB dealing with ankle sprain" stays the QB's.
- **Idioms (clause 3).** A team's loss of its own player is no game in any case or form: "Injury a big
  loss to Eagles", "…: A big loss to Browns", "Is Lost To Browns", "Lost to Browns until December",
  "Pressured by Browns to take pay cut", "Holds out against Browns". A preposition or a score keeps a
  game ("in a big loss to the Browns").
- **Labels and moves (clause 2).** "injured" before a name is no label for an opponent's hit. The
  lists now read "<name> of the <team>", "superstar", "MVP", "No. 1", "the Vikings' top receiver", a
  plural label's list ("Vikings WRs Jordan Addison and Justin Jefferson"), "Activated by", "Placed on
  IR by", "Reinstated by" and "<team> place <name> on IR".
- **Cues (clauses 1 and 3).** A result or an against word is about its sentence's subject (the first
  person named, with a list he heads). Another person named before the cue anchors a game between
  that person's team and the cued team ("Jackson found Zay Flowers twice in the win over the Bengals"
  is the QB's; "Unlike Justin Jefferson, Bijan Robinson starred in the win over the Browns" is never
  the WR's). A game in a sentence that names no one is the item's subject's again (choice 2). "at"
  between two teams is a game. The play wording reads its plain variants ("for three touchdowns",
  "Burns Browns cornerback", "Burned by Chiefs receiver").
- **Lists (clause 3).** 23 lists that decide a cue, a label or a move are held by one literal in the
  test: word for word, and entry by entry through a behaviour. A deleted entry fails both, except
  entries a shorter one covers.
- **The residual (clause 6).** An initial or a time ("1 P.M.", "P.J. Walker") is no position.
- **The surname (clauses 4 and 5).** Writing a holder's own position never costs his ref ("Vikings S
  Smith" is Harrison Smith's). The surname never gives what the full name refuses ("Eagles' Young"
  gets no ref, as "Eagles' Byron Young" does). A position next to a shared surname is evidence: "LB
  Jefferson" is the Browns LB's, and "WR Jefferson" (two fit) gets no ref and is counted.
- **Linear.** The attack's worst-case item takes 2.7 ms, as at `f41e810`; it took 33.9 ms at
  `7b9572c`.

The four batteries give exactly fix round 2's outcomes; unique names still match as at `f41e810`.

**Readings the fixer made (for the re-gate to check).** (a) Withdrawn in fix round 2. A team named
loosely that rules no holder out no longer leaves the item to prominence; such an item is no residual
and gets no ref (clause 5). Battery 2's "Lamar Jackson: Works out for Bengals" and "…: Visits Bears"
are the namesake's again, with no ref. The cost is the star's own items that name a team in wording
no cue reads ("Justin Jefferson: Leads Vikings to win | …", "Lamar Jackson: Signs extension with
Ravens"), which now get no ref either. (b) A surname several players share is a shared name, so
clause 2 binds the bare-surname path; it now uses the full name's function and its own cues. (c)
Narrowed in fix round 2. A describing sentence is about the subject only when he is the last person
named before it, it names no one after it, and no "him" within three words of its position (or "he"
right after it) gives it to another player. Even then it never picks a holder. (d) One item naming two
namesakes ("Lamar Jackson: Throws pick to CB Lamar Jackson") is decided as one person: a name written
twice in an item is one person, the common case.

**Closed by R8-6 (was open — needs a ruling): a roster move to the star's own team.** A roster move is
no label now: the title below gets no ref and is counted. "Lamar Jackson: Signs with Ravens practice
squad" (battery 1, the namesake's) goes to the Ravens QB at 0.95: the move ties the Ravens to the name,
and choice 3, standing as built, reads a move like an attached team, so the holder on that team takes
it. A free agent is consistent with any signing, though: it is how he stops being one. Options: (a) as
built; (b) an incoming move (sign, claim, join, lands on) is a free-agent holder's too, so with one it
leaves two holders and gets no ref ("Lamar Jackson: Signs with Ravens" would get none either); (c) "claimed
by" alone rules out the holder already on that team (a team never claims its own player). The same
reading gives the star "Justin Jefferson: Signs with Vikings | Jefferson, lost to the Browns in free
agency, joins Minnesota." at 0.95.

**Known limits, as built (for the re-gate to check).** Each follows a choice or a vocabulary that
stands; the first two came from the fixer's own attack after fix round 2, the last three from fix
round 3.

- **A game not his own.** A game written in a sentence about the subject is his (choice 2), so
  "Justin Jefferson: Questionable | Jefferson watched the Vikings host the Bengals from the stands."
  rules the Browns LB out and gives the WR 0.80. Telling a spectator from a player would need verb
  parsing.
- **The residual's verbs.** An item that names no team and no position is clause 6's residual even
  when its verbs are the namesake's. "Justin Jefferson: Burned for touchdown | The receiver beat him
  deep." gives the WR 0.80, since the receiver is plainly another player. "Lamar Jackson: Waived with
  injury designation | Jackson (hamstring) reverts to injured reserve." gives the Ravens QB 0.80. Both
  are accepted by the ruling.
- **"edge rusher"** stays DE or LB: "Chiefs edge rusher Chris Jones" (ESPN's DT) gets no ref, where
  "pass rusher" now fits him.
- **A topic's clause naming the player he hit** is no label either: "Chris Jones injury update: Chiefs
  DT fined for hit on Broncos QB" gets no ref (fix round 3). Telling the subject from the player he
  hit would need verb parsing.
- **A teammate of no known team** leaves the subject's cue no evidence: "Lamar Jackson: Big day |
  Jackson found Van Jefferson twice in the win over the Bengals." gives the QB no ref (Van Jefferson
  is a free agent; fix round 3).
- **A free-agent namesake signed since.** A cue about a free agent rules him out (he plays no games).
  The universe may list a namesake as a free agent after a team signed him, and then the star takes
  his game item by elimination: "Lamar Jackson: Carted off with ankle injury | Jackson was hurt
  covering a punt in Sunday's loss to the Steelers." gives the Ravens QB 0.80, as at `f41e810`. The
  attack's round-3 probe listed this group without naming it a violation.

**Before R8-3** (the record the ruling was made on; the as-built choices below are the ones it kept or
changed):

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

## Ruled R8-2 — the stall bound's measurement

**Ruled R8-2 (2026-10-28, changelog §R8):** accepted as built.

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
of §B8 never runs). At `8bd0931`, R8-6's fix, CI's process job read 83.4 ms over the `full` P1
analytics window (`tests/e2e/latency.test.ts`). The helper did not excuse that window, so the job
failed. The same build read 26.1 and 25.2 ms locally, and `a579917` read 24.5 ms on CI. R8-6 changed
only the news matcher, which runs at refresh (and at the e2e seed, before the server starts), never
inside a tool call. Re-running CI needs a push from this account.

## Closed by R8-4 — F8, division winners first

**Closed by R8-4 (2026-10-28, changelog §R8):** the owner confirmed that the league's division
winners take the top seeds. The shipped chain is right; nothing changes.

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
