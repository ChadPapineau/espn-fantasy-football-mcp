# Skills bundle

Agent Skills that teach Claude to use the ESPN fantasy-football MCP server (plan 09). Each Skill is a self-contained folder — instructions and reference files only, no scripts — so it works as part of the Claude Code plugin, copied into `~/.claude/skills/`, zipped for claude.ai, or read by the server's `espn.<workflow>` prompts.

**Skills N.x need server N.x.** Every `SKILL.md` carries `metadata.version` (the package version) and `metadata.tool_contract`; at the start of a session each Skill compares its `tool_contract` with the server's (`espn_get_status` → `server.tool_contract`) and stops when they differ.

**Read-only.** This version has no write module (PHASE W SEAM — NOT IMPLEMENTED): no Skill changes the team; every recommendation ends with "say *apply* for the exact clicks", and the `apply` Skill turns an agreed change into numbered manual steps on ESPN.

## The eight P0 Skills

| Skill | Use it for | Tools, in order (bare names) |
|---|---|---|
| [onboard](onboard/SKILL.md) | set up and check the league: the format in plain English, which team is the user's, the scoring self-check per stat, the seeding reading, the session state | status → league → roster → box score → (standings / seeding evidence / one auth probe) → record |
| [weekly](weekly/SKILL.md) | the week's plan in six tables: last week, matchup and lineup, the claim or scramble brief, K and D/ST, injuries and byes, league activity | status → league → scoreboards → roster → injuries → projections → lineup → K and D/ST → pool → waivers → schedule → transactions → standings → records |
| [start-sit](start-sit/SKILL.md) | start, sit and flex under the seeding reading; Questionable players; ESPN's projection as a cross-check; the game-day branch once a slot locks | status → league → roster → scoreboard → opponent → injuries → projections → lineup → record; game day: fresh roster → live scoreboard → … → lineup with `only_unlocked` |
| [stream-kdef](stream-kdef/SKILL.md) | which kicker or D/ST to start or stream, two weeks out; claim or free-agent add after the run | status → league → roster → schedule → pool → waivers (one position per call) → record |
| [retro](retro/SKILL.md) | how last week's advice did: regret against two baselines, Brier/CRPS beside ESPN's, "n too small" by name | status → league → scoreboard → retrospective → (transactions) → record |
| [apply](apply/SKILL.md) | the exact clicks for a change agreed in the conversation (user-invoked only) | status → league → roster; nothing logged, nothing changed |
| [session-check](session-check/SKILL.md) | the ESPN session: status, the DevTools steps, `eff setup` in a terminal, one verification — never a cookie in chat | status → (one auth probe) |
| [waivers](waivers/SKILL.md) | claim, pass or marginal against the priority premium; the ordered claim list; the scramble list; the drop with its IR-move option | status → league → roster → pool → injuries → transactions → standings → waivers → record |

Two P0 Skills carry a P1 branch that runs only under `EFF_TOOLSET=full`: `waivers`' usage branch (usage-first detection, the ensemble value basis, the FAAB bid curve) and `start-sit`'s live win probability (`espn_analyze_matchup` with `mode: "live"` beside ESPN's). Under `core` each takes its P0 path and says so.

## The five P1 Skills (`EFF_TOOLSET=full`)

Each one's Step 0 reads `server.toolset` and, under `core`, stops with: "this Skill needs the full toolset — set `EFF_TOOLSET=full` in the server's env and restart the client".

| Skill | Use it for | Tools, in order (bare names) |
|---|---|---|
| [trade](trade/SKILL.md) | an offer, a counter or a partner search: Δ for both sides with intervals and ΔU (playoff and bye odds) under the seeding reading, the implied drop, veto risk, a devil's-advocate paragraph, the deadline | status → league (+ seeding evidence) → both rosters → standings → injuries → projections (ROS) → replacement → trade (offer or partner search) → record |
| [injury-cascade](injury-cascade/SKILL.md) | an absence: weeks out, beneficiaries by role affinity with `p_role_holds`, `hypothesis_only`, the IR consequence, a claim/pass per beneficiary — after `news-check` when the source is a report | status → league → roster → injuries → depth chart → team usage → schedule → cascade → pool → waivers (the beneficiaries) → record |
| [schedule-plan](schedule-plan/SKILL.md) | byes and the playoff race: P(playoffs), P(bye), the marginal-values table and the exchange rate under one or both readings, holes and fixes, the playoff weeks | status → league (+ seeding evidence) → roster → playoff-week schedule → projections (ROS) → replacement → standings → matchup (season) → schedule → record |
| [roster-audit](roster-audit/SKILL.md) | the whole roster rest-of-season: the IR section first when invalid, the hidden-bench play, the derived bench template, handcuffs and stashes, droppables, adds remaining | status → league → roster → injuries → projections (ROS) → replacement → pool (one page per position) → standings → roster analysis → record |
| [news-check](news-check/SKILL.md) | a pasted claim, a headline or ESPN's outlook against the numbers: the flag, the evidence table, `structured_disagrees`, what would confirm it, the consequence; "priors are hand-set"; the log read back as data | status → league → roster → outlook → news → injuries → usage → schedule → evidence → record (read-back: the log first) |

## Install

- **Claude Code (plugin):** `claude plugin marketplace add <owner>/espn-fantasy-football-mcp`, then `claude plugin install espn-fantasy-football@espn-fantasy-football-mcp`; in development, `claude --plugin-dir .`. The Skills appear as `/espn-fantasy-football:<name>`.
- **Copy install:** `node scripts/skills/build-skills.mjs --copy-out dist/skills-copy`, then copy `dist/skills-copy/espn-*` into `~/.claude/skills/` (renamed `espn-<name>` so they never collide with another bundle; standard frontmatter only). Register the server under the key `espn-fantasy-football` (`eff print-config --client code`) — the Skills' `disallowed-tools` strings name that key.
- **Claude Desktop / claude.ai chat:** zip one `dist/skills-copy/espn-<name>` folder and upload it; configure the server separately (`eff print-config --client desktop`).

## Layout and generation

```text
skills/
├── _shared/references/   the shared text, written once: orient · guardrails · output-template · log ·
│                         tool-outputs · espn-vocabulary · priority-waivers   (not a Skill)
├── <skill>/
│   ├── SKILL.md          frontmatter + body; generated blocks between BEGIN/END GENERATED markers
│   ├── references/       byte-identical copies of _shared/references + the Skill's own <skill>-*.md
│   └── evals/            tool_sequence.json · evals.json · trigger_eval.json
└── README.md
scripts/skills/           manifest.json (tool lists, tool_contract, the eight deny strings, the input
                          contract of every P0 and P1 tool) · _lib.mjs · build-skills.mjs · check-skills.mjs ·
                          tool-sequences.mjs · build-plugin-evals.mjs (the claude plugin eval suite)
```

`node scripts/skills/build-skills.mjs` copies the shared references into every Skill, replaces each generated block in each body (the guardrails in every body; the output contract in every body but `apply` and `session-check`), and stamps `metadata.version` and `metadata.tool_contract`. It is idempotent; `--check` writes nothing and fails when anything is stale. Edit the source, never a copy.

`node scripts/skills/check-skills.mjs` is Lane 1 (zero tokens, every push) for all thirteen Skills — the P0 Skills validated under `core`, the P1 Skills under `full`, the toolset stated per sequence and per case: the build check; frontmatter (name = folder; description ≤ 350 characters, third person, with "in the user's ESPN league"; `when_to_use`; description + `when_to_use` ≤ 1 536; the listing ≤ 4 600); both guardrail sentences verbatim in every body and the cookie line; the output-contract headings; every `espn_<verb>_…` name a registered tool — in a P0 Skill a P1 tool only on a line labelled `(P1; …)` or `**P1:**`; every P1 Skill's Step 0 carries the toolset stop verbatim; no write tool named anywhere; no qualified tool name in prose; the eight `disallowed-tools` strings; `apply` user-invoked only; every backticked error code a real one; links inside the Skill and one level deep; the eval files well-formed; time-blind triggers with the collision check; no identifier under `skills/`, and the repository secret scanner clean.

## Tool sequences (Lane 1 dry run)

`evals/tool_sequence.json` lists the calls a Skill promises, in order, with argument templates on the fixture league `fx-10h` (league id `0`; Team 02 is the user's; Tuesday of week 5).

```text
{ schema_version: 1, skill, tool_contract, toolset: "core" | "full",
  fixture: { league: "fx-10h", env: { EFF_FIXTURE_DIR, ESPN_LEAGUE_ID: "0", EFF_TOOLSET }, team_id, week, … },
  sequences: [ { id, when, fixture_variant?, toolset?: "full", steps: [ { id, tool, args, expect?, note? } ] } ] }
```

- `toolset` is the file's: `core` for a P0 Skill, `full` for a P1 Skill. A P0 Skill's P1 branch is a sequence of its own with `"toolset": "full"` (it must call a P1 tool); a P1 Skill's sequences never set one.
- `tool` is a bare tool of the sequence's toolset; `args` validate against the tool's input contract in `scripts/skills/manifest.json` (keys, enums, ranges, the selector variants `selector:single` and `selector:outlook` — the dry run re-validates against the registry's zod schemas).
- `expect` lists the outcomes a step may have on the fixture: `"ok"` (default) or error codes.
- Templates: `{ "$ref": "<step>.<path>" }` (a value from an earlier step's envelope, e.g. `"lineup.data.rec"`); `{ "$source_calls": ["<step>", …] }` (`[{ tool, request_id }]` from those steps); `{ "$opponent": "<scoreboard step>" }` (the other team of the user's matchup); `{ "$player": { "step": "<roster step>", "slot": "FLEX", "eligible": "FLEX", "injury_status": "OUT" } }` (the first player in that slot, optionally eligible for another and carrying ESPN's status); `{ "$ids": { "from": "<step>.<path to an array>", "key": "player_id", "max": 5 } }` (the distinct ids in that list — the cascade's beneficiaries priced as waiver candidates; never resolved empty).
- Every sequence starts with `espn_get_status`; when it records, the record steps come last (log before rendering), each with its producer's kind.
- The dry run loads one toolset's sequences with `loadToolSequences(root, { toolset })` — `core` (the default: the eight P0 Skills' P0 paths) or `full` (the five P1 Skills and the P0 Skills' P1 branches), so each server starts with the matching `EFF_TOOLSET`; every file is validated whatever the filter, and anything `check-skills` would reject is refused. It builds arguments with `resolveArgs(step.args, results)` and checks outcomes with `outcomeAllowed(step, outcome)` — all from `scripts/skills/tool-sequences.mjs`.

## Lane 2 cases (`evals/evals.json`)

The skill-creator schema — `{ skill_name, evals: [ { id, name, toolset, prompt, expected_output, files, expectations[] } ] }` — with the plan's case name (`ON-1`, `WK-4-E`, `SS-INJ`) beside the integer id. `files` names the fixture the runner stages: `evals/fixtures/fx-10h` or `evals/fixtures/fx-10h/<variant>`, materialised from `fixtures/espn/fx-10h`. Each expectation is one sentence ending with its grader: `(tool_used …)`, `(tool_order)`, `(regex: \`…\`)`, `(regex_absent: \`…\`)` (free) or `(llm)` / `(llm, judge sees both replies)` (paid). A write tool is never named — "No write tool was called" covers all of them. Every Skill has an `-INJ` case whose expected answer equals the base fixture's apart from a quotation and one flag line; refusing to answer fails it. `toolset` is stated per case: a P0 Skill's cases run under `core` except the ones its rule lists as its P1 branch (`WV-2`, `WV-3-E`, `SS-11-E`, under `full`); a P1 Skill's cases run under `full` except its one `-CORE` case, which runs under `core` and checks the Step 0 stop (a regex expectation on `EFF_TOOLSET=full` — plan 10 B10). `session-check`'s SC-2 prompt carries `<SYNTHETIC_ESPN_S2>`: the runner substitutes a freshly generated cookie-shaped value at run time (never committed) and checks the trace never contains it. `apply` is user-invoked, so its cases start from the slash command.

## The plugin eval suite (`claude plugin eval` — Lane 2, plan 10 B15)

`node scripts/skills/build-plugin-evals.mjs` turns every Skill's `evals/evals.json` and `evals/trigger_eval.json` into a `claude plugin eval` suite under `dist/plugin-evals/` (git-ignored; a build output, never committed): one case directory per Lane 2 case and per trigger (`prompt.md` + `graders/*.md`), each expectation's tag mapped mechanically — `(tool_order)` to a `tool_order` grader per consecutive pair of the tools it names, `(tool_used: …)` to `tool_used` on the qualified tool (`input_match <key> <value>`, `min`, `max`, `arm`; "every write tool …" to a trace guard; `Skill <name>` to routing; "no input_match on the substituted value / injected string" to a guard over every tool call's input), `(regex…)` to `regex` on the final message, `(llm)` to a rubric carrying the case's expected output, and `(llm, judge sees both replies)` to one carrying the base fixture's expected reply as the reference. Triggers become `tool_used: Skill` cases (negatives `min: 0, max: 0, arm: both`). SC-2's `<SYNTHETIC_ESPN_S2>` is replaced by a fresh cookie-shaped value per build.

The harness has no MCP mock layer — a case's plugin starts its servers for real — so "mocks generated from fx-10h" are **eval plugins**: the bundle plus one server, `dist/cli.js serve` in fixture mode on the case's fx-10h variant with `EFF_TEST_STUBS=1` and the no-socket preload, under the toolset the case states. Their config and cache live in a fresh temp directory outside every git tree (the server refuses one inside). `--seed` (after `npm run build`) writes the recorded state NC-INJ-2 needs — a week-4 log entry whose note carries an order — through the real tools. Running it costs tokens and is manual: `claude plugin eval dist/plugin-evals/evals --allow-tools "mcp__plugin_espn-fantasy-football_espn-fantasy-football__*" …` (the generated README has the full command and the pass bar).

## Trigger evals (`evals/trigger_eval.json`)

An array of `{ "query", "should_trigger" }` — at least 6 of each, at least 2 negatives naming Yahoo or Sleeper. Every query is time-blind (no weekday, clock time, date, "today", "tonight"): the model is not told the time in Claude Desktop or claude.ai. The four game-day prompts ("who should I start?", "X is inactive, who goes in?", "what can I still change?", "what are my odds right now?") are positives of `start-sit` and of no other Skill.

## Attribution

League data and ESPN projections from ESPN Fantasy (unofficial API); NFL data from nflverse (CC BY 4.0); weather from Open-Meteo (CC BY 4.0, non-commercial) or the National Weather Service (public domain). The Skills print the attribution of whatever data a result actually used.
