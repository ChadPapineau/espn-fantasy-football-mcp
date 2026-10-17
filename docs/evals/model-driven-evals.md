# Model-driven evals: the question set (plan 05 §6, plan 10 A10b)

This page covers plan 05 §6 and decision T7, plan 10 A10b (≥ 8/10 on ten read-only fixture questions),
and the README's Testing row ("manual, before a release"). Plan 10 puts A10b in the Phase 1b exit gate
as one of the items the owner completes, with the evidence in `docs/evals/`.

The set was built on 2026-10-17 in Stage C round 1 (finding `eval-model-driven-evals-missing`) on
`build/phase-1`. It was built in fixture mode only: no cookie, no live ESPN request and no owner data
were used. Everything on this page comes from the fixture league `fx-10h`, which has league id `0` and
teams named "Team NN".

## Status

| item | status |
|---|---|
| The question set, [`tests/evals/read-only.xml`](../../tests/evals/read-only.xml) | **Built.** Ten read-only questions with their answers, in the mcp-builder `evaluation.md` format (`<evaluation><qa_pair><question/><answer/></qa_pair>`). |
| Its answer key | **Held by tests.** [`tests/e2e/model-evals.test.ts`](../../tests/e2e/model-evals.test.ts) runs in the process project on every push. It starts the built server the way the documented run does, then re-derives every answer from the tools in fixture mode, under `core` and under `full`. It fails if an answer changes or stops being the only answer. [`tests/evals/read-only.test.ts`](../../tests/evals/read-only.test.ts) runs in the unit project and holds the file's format and its agreement with the answer key below. |
| A10b, the model-driven run (pass bar ≥ 8/10) | **Not run.** The run is manual and comes before a release, because it spends model tokens. It is the owner's step before the `v0.1.0` tag. Read [Running it](#running-it-the-owner-before-a-release) for what it needs first. |

## The fixture state the questions assume

The fixture is `fixtures/espn/fx-10h`; its README describes it. It has 10 teams, `Team 01` to `Team 10`,
under the reference scoring: half-PPR, 5-point passing touchdowns, 6-point rushing and receiving
touchdowns, and −2 for interceptions and lost fumbles. Its clock is Tuesday of week 5 at 21:00 ET
(`2026-10-07T01:00:00Z`).

- Weeks 1–4 are final (**N = 4**).
- Week 5 has not kicked off.
- The waiver run has not happened yet, so every player not on a team is on waivers.

The server starts in fixture mode on a fresh state (no `eff refresh`) under the default toolset `core`,
as plan 05 §6's command does. The test checks that every answer is the same under `EFF_TOOLSET=full`,
so a run may use either toolset. A10b is defined under `core`.

The answers are stable for four reasons:

- the fixture is frozen;
- the fixture-mode server starts its clock at the fixture's own clock;
- every question names its weeks, so none depends on "the current week";
- every answer is an ESPN fact, never a sampled estimate.

## How the set was built

The set was built the way plan 05 §6 and `evaluation.md` steps 2–5 prescribe:

1. The tool descriptions and input schemas were read from `tools/list`, under `core` and under `full`.
2. The fixture league was explored through the tools in fixture mode, read-only.
3. Each question was solved with the tools.

No server code was read to write a question or to find an answer.

The plan's ten drafts were kept where they hold on the fixture. Six were reworded or adapted. As
drafted, those six were ambiguous, had no single checkable answer on this fixture, or asked for data
that no tool serves. Each change applies the rule plan 05 §6 adopts from `evaluation.md` ("read-only,
independent, stable, single-answer"); none is a new decision. Every question now states its answer
format, because the runner compares answers by exact string match.

| # | Plan 05 §6 draft (shortened) | As built | Why it changed |
|---|---|---|---|
| 1 | The largest margin of defeat in the week with the highest combined score, through week N | The same question, with "combined score" spelled out as all ten teams' points added together | "Highest combined score" can also be read as the single highest-scoring matchup (week 1, Team 04 against Team 01), and that reading gives a different answer |
| 2 | Free agents eligible at FLEX with a week-N projection above Team 3's lowest-projected FLEX starter | Players not on any team (free agents or on waivers), eligible for FLEX, with a week-5 projection above the lowest-projected of Team 03's RB, WR, TE and FLEX starters for week 5 | On this fixture every player not on a team is on waivers, so a literal "free agents" gives 0: the `FREEAGENT` list is empty. "FLEX starter" could mean the FLEX slot or every FLEX-eligible slot. Week 5 is the week the lineup decision is made; week 4 has been played. The pool spans several pages, so paging is part of the question |
| 3 | Points for a 45-yard field goal | Unchanged, with the answer format stated | — |
| 4 | Team 3's FLEX player in week N | Unchanged, with N = 4 | — |
| 5 | Whether the first seed stays first under a head-to-head tiebreak | Unchanged, after week 4 | — |
| 6 | The NFL team that shares a bye with the team of Team 1's week-N starting quarterback (its abbreviation) | How many other NFL teams share that bye (an integer) | Four teams share that bye week, so "which NFL team" has three correct answers |
| 7 | Week-N waiver claims whose player is now on a team other than the claimant | Week 2's executed waiver claims whose player is no longer on the claiming team's week-5 roster | The fixture's transactions are in weeks 2 and 3. In both weeks the drafted count is 0, because no claimed player moved to another team. A reader who found no transactions would also answer 0. The new version keeps the join of claims against later rosters and has an answer other than 0 |
| 8 | The rostered player with the largest gap between ESPN's rest-of-season projection and his season-to-date actual points | The player on Team 02's week-5 roster with the largest gap between ESPN's rest-of-season projection and his actual points in weeks 1–4 | No tool serves a season-to-date total on this fixture. Under `core` there is none. Under `full`, `espn_get_player_stats` returns no splits on the fresh fixture state the run uses ("espn:kona_playercard unavailable"). So the weekly lines are summed from rosters or box scores, which show a player only in weeks he was on a roster; for the whole league that means about 40 roster reads. Team 02's leader was on Team 02 all four weeks and leads by about 50 points |
| 9 | The reception stat id, and whether it scores 0.5 | Unchanged, with the answer format stated | — |
| 10 | The projected-vs-actual difference for Team 2's total in week N−1 | Week 3's actual total minus the sum of the nine starters' ESPN projections | The draft did not say which way to subtract. No tool reports ESPN's projected team total for a final week (the live scoreboard's is null), so the question names the sum the box score shows |

## The answer key

This is what the solvers derived. They are in `tests/evals/solvers.ts` and run against the built server
by `tests/e2e/model-evals.test.ts`. The section is generated: `UPDATE_EVALS=1` rewrites it, and
otherwise that test checks it against its own run.

<!-- answer-key:start -->
| # | answer | tools the solver read |
|---|---|---|
| 1 | `Team 08` | `espn_get_scoreboard` |
| 2 | `23` | `espn_get_roster`, `espn_list_players` |
| 3 | `4` | `espn_get_league` |
| 4 | `Chuba Hubbard` | `espn_get_roster` |
| 5 | `True` | `espn_get_standings` |
| 6 | `3` | `espn_get_roster`, `espn_get_schedule` |
| 7 | `3` | `espn_get_roster`, `espn_list_transactions` |
| 8 | `Drake Maye` | `espn_get_roster`, `espn_list_players` |
| 9 | `53,true` | `espn_get_league` |
| 10 | `7.5` | `espn_get_box_score` |
<!-- answer-key:end -->

Each solver refuses an answer that is not unique:

- **A tie.** The best item must lead the next by at least 0.01. For Q8 the lead must be at least
  20 points.
- **A threshold within rounding distance.** Q2's count must be the same with projections rounded to
  one or two decimals. Q10's difference must not sit near a one-decimal rounding boundary.
- **An unobserved week that could change the answer.** In Q8 the winner must have all four weeks on
  Team 02's roster.
- **A tie at the top of the standings.** Q5 would then need head-to-head results.

Every tool a solver reads reports ESPN facts (`meta.estimate: false`) and is annotated
`readOnlyHint: true`. No question needs `espn_record_recommendation` (the one tool that is not
read-only) or any analytics estimate.

## Running it (the owner, before a release)

The runner is mcp-builder's `scripts/evaluation.py`, the one plan 05 §6 names. It is third-party code.
The notes below come from reading it, not from running it.

```sh
# from the repository root, with the package built
scripts/dev/heavy-lock.sh scripts/dev/with-node.sh npm run build
STATE="$(mktemp -d)"   # outside every git tree: the server refuses a config or cache inside one
mkdir -m 700 "$STATE/home" "$STATE/config" "$STATE/cache"
NODE="$(scripts/dev/with-node.sh node -p process.execPath)"
python <mcp-builder>/scripts/evaluation.py -t stdio -m <a current model id> \
  -c "$NODE" -a "$PWD/dist/cli.js" serve \
  -e HOME="$STATE/home" EFF_CONFIG_DIR="$STATE/config" EFF_CACHE_DIR="$STATE/cache" \
     EFF_FIXTURE_DIR="$PWD/fixtures/espn/fx-10h" ESPN_LEAGUE_ID=0 ESPN_SEASON=2026 ESPN_TEAM_ID=2 \
     EFF_TOOLSET=core EFF_TEST_STUBS=1 EFF_LOG_LEVEL=warn \
     NODE_OPTIONS="--import=$PWD/tests/e2e/fixtures/no-socket.cjs" \
  -o docs/evals/<date>-model-driven.md tests/evals/read-only.xml
```

This is plan 05 §6's command plus the isolation the end-to-end suite and the Lane 2 eval servers use:

- **Private state directories.** Fixture mode is refused while a credential is stored, and the owner's
  own install has one. So `HOME`, `EFF_CONFIG_DIR` and `EFF_CACHE_DIR` point at empty directories.
  The server's own refusal message asks for the same thing.
- **Two network guards.** `EFF_TEST_STUBS=1` ends the process on any network call or keychain read.
  The no-socket preload ends it on any network attempt.
- **The preload rides `NODE_OPTIONS`.** The runner's `-a` cannot carry an option-like value such as
  `--import`.
- **Node by absolute path.** The server then runs on the repository's version of Node (`.nvmrc`),
  whatever `PATH` the runner inherits.

### Check these before the run

- **It needs an Anthropic API key.** The runner calls the Messages API directly, so it needs
  `pip install anthropic mcp` and `ANTHROPIC_API_KEY`. That is per-token API billing; a Claude
  subscription does not cover it. `CLAUDE.md` allows free services only, so running it this way is the
  owner's decision.
- **Its default model may no longer be served.** The default is `claude-3-7-sonnet-20250219`. Pass
  `-m` with a current model id.
- **It may turn every tool result into an error.** The runner encodes each tool result with
  `json.dumps(result.content)`. The MCP Python SDK returns `content` as model objects, which
  `json.dumps` cannot encode. Read statically, every tool call would therefore come back as
  "Error executing tool …", and the score would measure the runner, not the server. Read the first
  task's tool calls in the report before trusting any score. If that is what happens, the fix is one
  line in the local copy: encode each content block's `model_dump()`. That changes third-party code,
  so it is the owner's call.

### Pass bar and follow-up

The bar is **≥ 8/10** [A-1]. The runner scores each task by comparing the `<response>` value with the
committed answer as an exact string.

After the run:

1. Commit the report under `docs/evals/` and put the score in the status table above.
2. Triage the report's "feedback on the tools" into description fixes (plan 05 §6).
3. Run the set again after any change to a tool description.

If a fixture regeneration or a tool change moves an answer, `tests/e2e/model-evals.test.ts` fails and
names the question. To fix it:

1. Solve the question again with the tools.
2. Update the answer in the XML.
3. Build the package, then run that test once with `UPDATE_EVALS=1`.

## What this does not cover

- **B11 Lane 2 and B15** are the model-graded Skill cases run through `claude plugin eval`
  ([`stage-c-plugin-eval.md`](stage-c-plugin-eval.md); ruling R7-2). They are a separate lane. This
  runner calls the MCP server directly, without the Skills, and the plugin-eval gate does not block it.
- **The live league.** The questions are about the frozen fixture only. Plan 05 T7 rejected live-league
  evals because their answers change.
