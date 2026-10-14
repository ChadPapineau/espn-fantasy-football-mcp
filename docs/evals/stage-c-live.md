# Stage C — live read-only acceptance on the owner's league

Scope: Stage C's live lane (`docs/scratch/build-program.md`; `docs/HANDOFF.md` ▶ NEXT STEP step 3):
the whole read-only product run against the owner's real ESPN league, through the product only.
Run on 2026-10-11 (a Sunday: scoring period 5 in progress, periods 1–4 final) at `c6741f8` on
`build/phase-1`; `dist/` was checked to be built from that tree (no source file newer than its
output). This file is **anonymised**: no league, team, member or player name or id appears in it;
live tool output stayed in the session scratchpad outside the repository and is not committed.

**How it was run.**
- CLI: `eff status --json`, `eff doctor --online --json`, `eff check-auth --json` once each; `eff
  refresh all` (then each refresh target on its own — finding F1); `eff probe --json` once.
- Server: the built `node dist/cli.js serve` over real stdio, driven by the official MCP client
  (`@modelcontextprotocol/client` 2.2.0), envelopes checked with the repo's own validators (the tool's
  full output schema, the A6 / B8 walk, `identifierLeaks`, the mandatory-sentence and family checks)
  plus a stack-trace / home-path / cookie-shaped-string scan. Seven sessions: one listing the surface,
  one `core` session (the weekly Skill's `pre_run` sequence, a warm repeat of every `core` tool,
  hostile inputs, 8 prompts, the resources) and five `full` sessions (all 34 tools, the golden, C4,
  13 prompts, 8 resources + 2 templates, re-runs).
- The league id was passed only as `ESPN_LEAGUE_ID` in each command's environment. The cookie was
  read only by the product from its own store; no configuration directory, keychain item or
  credential file was read, and no cookie, SWID or credential was printed or copied anywhere.
- **ESPN requests: 78 in total** for everything above (the product's own counters: `eff status`
  `requests_today` 81 at the end against 3 before the run), under the product's limiter, read host
  only. Budget: 300.

## Verdicts, items (1)–(7)

| # | Item | Verdict | Evidence (aggregated) |
|---|---|---|---|
| 1 | credential validated, own team resolved | **met** | `eff status --json` and `eff check-auth`: `validated`, `accepted: true` (probe `settings`, HTTP 200); `espn_get_league` resolves `my_team` from the SWID. Output value-free (booleans, labels, timestamps). `eff doctor --online` could not show it (F1) |
| 2 | `espn_get_league` restates the format exactly | **met except keepers** (F6) | every item in the table below matches; keepers are not restated at all |
| 3 | per-stat golden, every completed week | **met** | periods 1–4, every matchup: 580 rostered player-weeks, 1,758 non-zero `appliedStats` entries; product verdict `match` on all 580, `scoring.golden.status = "match"`; independent recomputation from raw stats × the restated scoring items: max per-stat difference 0.000, max total difference 0.000; period 5 (in progress, own matchup) 20 / 20 provisional |
| 4 | all 34 tools, 13 prompts | **34 / 34 called, 2 defects** | 32 tools answer schema-valid, walk-clean envelopes on every call; `espn_get_depth_chart` does for 31 of 32 NFL teams and answers INTERNAL for one (F3); `espn_get_status` stays schema-valid but fails the A6 walk once a drift diff exists (F7). 13 / 13 prompts resolve (one vocabulary note, F11); 10 / 10 resources read (one misleading NOT_FOUND, F12). No stack frame, GUID, IP or cookie-shaped string in any output; stdout carried JSON-RPC frames only; every session exited 0 on stdin EOF in ≤ 60 ms |
| 5 | C4 on the league's previous seasons; R6-3 | **C4 met · R6-3 not met** (F5) | C4: ESPN serves five finished previous seasons; the seeding chain reproduces `playoffSeed` exactly for 10 / 10 teams in 5 / 5 (method `reproduction`, record reading, no bracket edit); the season before the first answers `ESPN_LEAGUE_NOT_FOUND`. R6-3: `premium_basis: cold_start_table`, `p_clears_to_fa.basis: cold_start`, the cold start and its measured miss stated — no product command stores the previous seasons' transactions |
| 6 | plan 10 items marked needs_live | see the table below | |
| 7 | no write host, no cookie in logs, credential transitions | **met (observed transitions)** | write host in no request or log line (hosts seen: the ESPN read host, GitHub release assets, Sleeper, three RSS hosts); `scan-secrets` over every captured log: no credential-rule, GUID or deny-list match (only Node's own exit-13 warning carries a home path, F1); the logger writes `"cookie":"[redacted]"` and nothing else. Transitions: the state stayed `validated`; every accepted probe advanced `last_accepted_at`; `espn_check_auth` ≤ 1 / min enforced (`RATE_LIMITED`, `retry_after_s` 58). The rejected side was not exercised live (it needs an invalid stored cookie); it stays held by the fault tests |

### Item 2 — the format, field by field

| Owner's format | `espn_get_league` | |
|---|---|---|
| 10 teams, head to head | `size` 10, `scoring_type` H2H_POINTS | ✓ |
| half-PPR | `rec` 0.5 | ✓ |
| 5-pt passing TD | `pass_td` 5 (`pass_yd` 0.04) | ✓ |
| 6-pt rushing / receiving TD | `rush_td` 6, `rec_td` 6 (yards 0.1) | ✓ |
| −2 interception, −2 fumble lost | `pass_int` −2, `fum_lost` −2 | ✓ |
| QB / 2 RB / 2 WR / TE / FLEX / D/ST / K | slots 1 / 2 / 2 / 1 / 1 (RB-WR-TE) / 1 / 1, `starters` 9 | ✓ |
| 5 bench + 2 IR | `bench` 5, `ir` 2, `total` 16 | ✓ |
| 1-day waivers, move-to-last | `waiver_hours` 24, `waiver_system` `priority_move_to_last`, no budget (`waiver.type` and `order_reset` listed in `unverified_fields`) | ✓ |
| 14 regular-season matchups | `regular_season_matchups` 14, playoff weeks 15–17, one-week rounds | ✓ |
| 6 of 10 make the playoffs | `playoffs.team_count` 6 | ✓ |
| record first, then Total Points For | `seeding_rule` TOTAL_POINTS_SCORED, `mode_in_use` espn_rule, confirmed | ✓ |
| trade deadline 2026-12-02 | `trade.deadline` 2026-12-02 (noon ET) | ✓ |
| no keepers | not present in the digest; the product has no keeper field | **F6** |

The kicker and D/ST items match ESPN's own `appliedStats` on every player-week (item 3), including
the D/ST 18–21 points-allowed bracket the digest still lists as unverified (4 live player-weeks) and
the missed-field-goal items that score a short miss twice.

## Findings (anonymised; ranked)

| id | severity | finding |
|---|---|---|
| F1 | high | CLI ESPN requests die on the limiter's 1/s wait: `eff refresh all`, `eff probe` and `eff doctor --online` exit 13 with no output |
| F2 | high | the live `mPendingTransactions` answer is classified as a skeleton: the drift state turns **red** and stays red |
| F3 | medium | `espn_get_depth_chart` answers INTERNAL for any team whose depth chart carries an nflverse placeholder player id |
| F4 | medium | `espn_analyze_waivers`: the same claim flips from pass (`core`) to claim (`full`), always against the same drop |
| F5 | medium | R6-3 cannot apply live: no product path stores the previous seasons' transactions |
| F6 | low | `espn_get_league` does not restate the keeper setting |
| F7 | low | `espn_get_status` / `espn-ff://status*`: unwrapped strings in `drift.diff[]` |
| F8 | low | the season simulator seeds division winners first; unverified for this league's seeding rule |
| F9 | low | wasted requests: a season the league never had is re-requested on every call; each CLI probe re-learns publicity |
| F10 | low | log flood: one warn line per skipped dataset row (835 in one session) |
| F11 | low | the `espn.stream` prompt takes `DST`; the tools spell it `D/ST` |
| F12 | low | `espn-ff://roster/snapshot` with no snapshot yet says "team, player or week is not in this league" |
| F13 | low | `eff doctor --online`'s host probe is charged to the jobs' keyless daily cap |
| F14 | low | A1's seeding evidence on a cold cache falls back to standings-only and says the season "could not be read" |
| F15 | low | `partial` is not set when an ESPN view is missing in E4 outlooks and E12 replacement |

**F1 — the CLI's limiter wait does not hold the event loop** (`src/cli/espn-http.ts`, `realSleep`:
`setTimeout(resolve, ms).unref()`). Every CLI ESPN request goes through `espnRequest`; when a second
request in the same process falls inside the limiter's 1-request-per-second window it sleeps on an
unref'd timer, nothing else keeps Node alive, and the process ends with exit 13 ("unsettled top-level
await") before the request is sent — no stdout, no result. Seen live: `eff refresh all` stopped after
its first source (`espn:pro_schedule` published, `espn:players` never ran, nor anything after it);
`eff probe` stopped after its host probe; `eff doctor --online` stopped after row #16 (the probe was
recorded as accepted in the store, then no row was printed). Reproduced offline with a fake limiter
that asks for one 400 ms wait: exit 13, the request never sent. Consequences: the daily drift probe
and the refresh-all job (launchd) never complete; A7b and A17b cannot pass; Node's warning prints the
absolute path of `dist/cli.js` to stderr. Workaround used here: one refresh target per process (all
published). `eff setup` uses the same helper (its probe, cookie probe and team read); the owner's run
completed. Expected: the wait holds the loop (a ref'd timer, as `src/providers/espn/limiter.ts`
does).

**F2 — red drift from a live pending-transactions read.** `espn_list_transactions { pending: true }`
requested `view=mPendingTransactions`; the cookie-bearing answer on the owner's private league had no
`pendingTransactions` key (research 03 recorded `pendingTransactions: []` anonymously on a public
league). The detector classified it `skeleton`: `drift_state` went from `additive` to **red** (since
that call, still red at the end of the run; `affected_tools: [espn_list_transactions]`), the tool
answered the executed-transactions list with the warning "espn:mPendingTransactions unavailable", and
`espn_get_status`, `espn-ff://status/drift` and `eff status` now report red. With F1 the probe cannot
clear it. Expected: either the absent key means "nothing pending" (an empty list, no drift) or the view
has really changed — a recorded live sample has to decide; one ordinary read must not leave the whole
product red.

**F3 — depth charts and nflverse placeholder ids.** The nflverse 2026 depth-chart file carries
player ids of the shape `AAA999999` (three letters, six digits) for some players; the dataset accepts
them and the tool's output schema (`gsisId`, `src/mcp/tools/schemas.ts`) rejects them:
`tool.output_invalid` (`data.teams[].groups[].slots[].gsis_id`, `invalid_format`) → INTERNAL. Today 1
of 32 NFL teams fails (and `player` lookups on that team's players); this season's depth-chart file
carries such ids for eight teams (on rows no longer current for the other seven), so more will fail
as depth charts change. Expected: such an id is passed as null
(or not a gsis id) and the team still answers.

**F4 — E5's verdict depends on the toolset.** Same league state, same candidate (a waiver QB, ESPN ROS
about 186), same conditional drop: `core` (`value_basis: espn_ros`) gives `s = −16.847` → pass;
`full` (`value_basis: ensemble`) gives `s = +10.552` → claim. Under `full` nine players reach
`claim_list` (two QBs at the top, a starting QB already rostered); under `core` none. Every candidate
of every position, in both toolsets, names the same conditional drop: a bench WR on his bye week,
83.7 % owned, ESPN ROS 146.6 — while E11 (`espn_analyze_roster`) rates that player's bench marginal
value 8.2 and another bench WR's 0 as the most droppable. The marginal-lineup logic may be defensible
for one horizon, but a sign flip between toolsets on the same ESPN inputs (only the weekly-value basis
differs: ESPN's ROS split under `core`, E1's ROS weeks under `full`), and a drop that disagrees with
E11, need a root cause before E5 advises an add/drop on the live league. Plausible defect; not
root-caused here (the `full` path replaces the weekly values with E1's ROS weeks,
`src/mcp/tools/analytics.ts` around the E5 P1 overlay).

**F5 — R6-3 live.** E5 serves the cold start on the owner's league and says so correctly (warning:
no previous-season transactions stored; the measured miss in `rec.assumptions`). Round 0 named the
missing piece: a one-time backfill of each previous season's transactions into `transactions_seen`.
It does not exist in any `eff` command, and `espn_list_transactions` takes no season, so whether ESPN
serves a past season's `mTransactions2` for this league could not be checked through the product.
`league_fitted` from the first call is therefore not met live.

**F6 — keepers.** The digest has no keeper field and the product reads none (plan 07 E16 assumes
redraft). The owner's league has no keepers, so nothing is wrong today, but the restatement is
incomplete and a keeper league would go unnoticed.

**F7 — drift diff strings.** With a non-empty diff, `data.drift.diff[].removed[]` (and `added[]`,
which carries ESPN's own key names) are bare strings outside the walk's code grammar (`$`, `[]`) and
off the server-prose list — the A6 walk fails on `espn_get_status`, `espn-ff://status` and
`espn-ff://status/drift`. Earlier in the run the status was `additive` with an empty `diff`, which says
nothing actionable while the server log held the paths.

**F8 — division winners first.** The league has two divisions and ESPN's `playoffSeedingRuleBy` is 0;
E3 `season`'s chain starts with `division_winners_first`. The owner's rule is record first, then
points for; C4 reproduces all five seasons exactly under the product's chain, but those seasons may
not discriminate (no seed table here shows a division winner ranked below a non-winner by record).
Unverified assumption that changes P(playoffs) in exactly the season where it matters.

**F9 — requests.** C4's walk asked for the season before the league's first three times per call
(three 404s, again on a repeat call) — 7 requests for a season that does not exist; a 404 is not
remembered. Each `eff check-auth` / `eff doctor --online` re-sends the anonymous publicity read before
the cookie probe (one extra keyless request per run).

**F10 — log volume.** One P1 call in a `full` session wrote 835 `store.warning
dataset_row_skipped_position` lines at `warn`, one per skipped dataset row (a count per read would do).

**F11 — prompt vocabulary.** `espn.stream`'s `position` accepts `K` or `DST`; `D/ST`, the spelling
every tool uses, is refused. Both valid values resolve.

**F12 — empty snapshot.** No roster snapshot exists yet (the jobs are not installed), and
`espn-ff://roster/snapshot` answers NOT_FOUND "The requested team, player or week is not in this
league." with the hint to check an id or week.

**F13 — the jobs' cap.** `eff doctor --online` (and `eff probe` run by hand) record their keyless host
probe as `origin: job`, so interactive runs consume the jobs' 30-per-day keyless cap.

**F14 — A1's seeding evidence on a cold cache.** The first `espn_get_league` call with
`seeding_evidence` spent its three-request budget on this season's settings and teams, showed the
standings-only comparison, and warned "last season's schedule or settings could not be read"; the
next call (warm cache) reproduced the season. The text should say the budget was spent (the onboard
Skill makes this call once).

**F15 — `partial`.** While the local limiter's window was full, `espn_get_player_outlook` (outlook
paragraphs missing) and `espn_analyze_replacement` (no free-agent pool, baselines proxied) answered
`partial: false` with the omission only in `warnings`; `espn_get_projections` in the same state said
`partial: true`. With the window clear all three answered complete.

## Plan 10 items marked needs_live (B1 / B2a / B2b gates and `docs/evals/*`)

| Item | Verdict | Evidence |
|---|---|---|
| A1b golden gate, live | **met** | item 3 above; `scoring.golden.status = "match"`. (`eff smoke` named in A1b does not exist; the box-score tool carried the check.) No D/ST return TD occurred, so 103/104 stay as they were |
| A2b credential lifecycle | **met where observable** | `validated`, own team resolved, status value-free; the rejection paths are fault-tested, not run live; `ESPN_TEAM_ID` in `config.json` not checked (the configuration directory is not read) |
| A3b anonymous-capable reads | **partly** | the private league's anonymous read answers 401, classified `AUTH_LEAGUE_NOT_VISIBLE`; "every tool returns `ESPN_REQUIRES_COOKIES` with no cookie stored" needs the cookie removed — not done |
| A4b fault matrix, cookie rows | **met (live parts)** | the live private 401 classified by the allow-list; the write host absent from every request and log line |
| A5b request budget (≤ 12 per weekly run) | **met** | the weekly Skill's `pre_run` sequence: 11 ESPN requests (settings and teams were cached a few minutes earlier; a fully cold run would add about 2) |
| A6b snapshots | **needs_time** | the snapshot jobs are not installed yet (Stage D) |
| A7b drift probe daily | **not met** | `eff probe` exits 13 (F1); drift is red from F2 |
| A8b box score `match` on a private week | **met** | every player of every matchup, periods 1–4 |
| A11b echo spike | not this lane | needs the Claude clients |
| A14b latency, live | **met** | warm cache, every `core` tool: max 424 ms (`espn_analyze_lineup`), most under 30 ms; cold `espn_get_roster` 1,002 ms (< 3 s) |
| A17b `doctor --online` #16 accepted | **not met** | the probe ran and was accepted, but the command exits 13 before printing (F1) |
| B11 Lane 2, B15 plugin eval | not this lane | the `claude plugin eval` lane (R5-5) |
| B5 trade Δ-sign | **needs_time** | no accepted trade to score yet |
| C1 under the owner's scoring, C3, B14 | **needs_time** | prospective; no pre-week scoreboard snapshots yet |
| C4 on the owner's league | **met** | item 5 |
| C5 / R6-3 league feed | **not met** | F5 |
| Sleeper and RSS shapes on first live fetch (phase2-datasets) | **met** | `sleeper:trending` 100 rows, RSS 11 / 25 / 40 items published, every dataset source published |

## Measurements

- **Standings consistency:** for 10 / 10 teams, wins, losses and points for in `espn_get_standings`
  equal the sums over the four final scoreboards; ESPN's current `playoff_seed` order equals record
  first, points for second, computed independently.
- **Projections:** E1 under `full` serves `v2-opportunity` with ESPN's weekly mean as the point
  estimate (`weight_espn` 1), own line beside it, `player_sim` spread.
- **Matchup:** live P(win) 0.962 against ESPN's 0.90, the live projected totals within 0.5 points of
  ESPN's on both sides; season P(playoffs) 0.92 against ESPN's `playoffPct` 0.893, seed distribution
  summing to 1.
- **Latency over stdio:** start-up to a completed handshake about 0.57 s; P1 analytics 0.07–2.0 s with
  the limiter clear (one call waited 18.5 s for the 30-per-minute window after the C4 walk — the
  limiter governing, not computation).
- **Requests by phase (78):** CLI 8 (doctor 3, check-auth 2, refresh 2, probe 1); first server
  session 5; weekly `pre_run` 11; the rest of the `core` session 5; golden 5 (four conditional
  `304`s); C4 walk 20 (7 of them the 404s of F9); all 34 tools after that 10; re-runs 14.

## Side effects on the owner's local store (product behaviour, for the record)

Datasets refreshed (every source published, one target at a time); one recommendation row written by
the required `espn_record_recommendation` call (`client_ref` `stage-c-live-acceptance`); E5 logged its
priced waiver run (1 of 13); E1 stored its first-week projections; `drift_state` is **red** because of
F2 and stays so until a probe succeeds.
