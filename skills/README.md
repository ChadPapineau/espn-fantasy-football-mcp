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

The five P1 Skills (`trade`, `injury-cascade`, `schedule-plan`, `roster-audit`, `news-check`) arrive with the full toolset in Phase 2.

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
                          contract) · _lib.mjs · build-skills.mjs · check-skills.mjs · tool-sequences.mjs
```

`node scripts/skills/build-skills.mjs` copies the shared references into every Skill, replaces each generated block in each body (the guardrails in every body; the output contract in every body but `apply` and `session-check`), and stamps `metadata.version` and `metadata.tool_contract`. It is idempotent; `--check` writes nothing and fails when anything is stale. Edit the source, never a copy.

`node scripts/skills/check-skills.mjs` is Lane 1 (zero tokens, every push): the build check; frontmatter (name = folder; description ≤ 350 characters, third person, with "in the user's ESPN league"; `when_to_use`; description + `when_to_use` ≤ 1 536; the listing ≤ 4 600); both guardrail sentences verbatim in every body and the cookie line; the output-contract headings; every `espn_<verb>_…` name a registered P0 tool (a P1 tool only on a line labelled `(P1; …)` or `**P1:**`); no write tool named anywhere; no qualified tool name in prose; the eight `disallowed-tools` strings; `apply` user-invoked only; every backticked error code a real one; links inside the Skill and one level deep; the eval files well-formed; time-blind triggers with the collision check; no identifier under `skills/`, and the repository secret scanner clean.

## Tool sequences (Lane 1 dry run)

`evals/tool_sequence.json` lists the calls a Skill promises, in order, with argument templates on the fixture league `fx-10h` (league id `0`; Team 02 is the user's; Tuesday of week 5).

```text
{ schema_version: 1, skill, tool_contract, toolset: "core",
  fixture: { league: "fx-10h", env: { EFF_FIXTURE_DIR, ESPN_LEAGUE_ID: "0", EFF_TOOLSET }, team_id, week, … },
  sequences: [ { id, when, fixture_variant?, steps: [ { id, tool, args, expect?, note? } ] } ] }
```

- `tool` is a bare P0 tool; `args` validate against the tool's input contract in `scripts/skills/manifest.json` (keys, enums, ranges — the dry run re-validates against the registry's zod schemas).
- `expect` lists the outcomes a step may have on the fixture: `"ok"` (default) or error codes.
- Templates: `{ "$ref": "<step>.<path>" }` (a value from an earlier step's envelope, e.g. `"lineup.data.rec"`); `{ "$source_calls": ["<step>", …] }` (`[{ tool, request_id }]` from those steps); `{ "$opponent": "<scoreboard step>" }` (the other team of the user's matchup); `{ "$player": { "step": "<roster step>", "slot": "FLEX", "eligible": "FLEX" } }` (the first player in that slot).
- Every sequence starts with `espn_get_status`; when it records, the record steps come last (log before rendering), each with its producer's kind.
- The dry run loads every sequence with `loadToolSequences()` (which refuses anything `check-skills` would reject), builds arguments with `resolveArgs(step.args, results)` and checks outcomes with `outcomeAllowed(step, outcome)` — all from `scripts/skills/tool-sequences.mjs`.

## Lane 2 cases (`evals/evals.json`)

The skill-creator schema — `{ skill_name, evals: [ { id, name, toolset, prompt, expected_output, files, expectations[] } ] }` — with the plan's case name (`ON-1`, `WK-4-E`, `SS-INJ`) beside the integer id. `files` names the fixture the runner stages: `evals/fixtures/fx-10h` or `evals/fixtures/fx-10h/<variant>`, materialised from `fixtures/espn/fx-10h`. Each expectation is one sentence ending with its grader: `(tool_used …)`, `(tool_order)`, `(regex: \`…\`)`, `(regex_absent: \`…\`)` (free) or `(llm)` / `(llm, judge sees both replies)` (paid). A write tool is never named — "No write tool was called" covers all of them. Every Skill has an `-INJ` case whose expected answer equals the base fixture's apart from a quotation and one flag line; refusing to answer fails it. `session-check`'s SC-2 prompt carries `<SYNTHETIC_ESPN_S2>`: the runner substitutes a freshly generated cookie-shaped value at run time (never committed) and checks the trace never contains it. `apply` is user-invoked, so its cases start from the slash command.

## Trigger evals (`evals/trigger_eval.json`)

An array of `{ "query", "should_trigger" }` — at least 6 of each, at least 2 negatives naming Yahoo or Sleeper. Every query is time-blind (no weekday, clock time, date, "today", "tonight"): the model is not told the time in Claude Desktop or claude.ai. The four game-day prompts ("who should I start?", "X is inactive, who goes in?", "what can I still change?", "what are my odds right now?") are positives of `start-sit` and of no other Skill.

## Attribution

League data and ESPN projections from ESPN Fantasy (unofficial API); NFL data from nflverse (CC BY 4.0); weather from Open-Meteo (CC BY 4.0, non-commercial) or the National Weather Service (public domain). The Skills print the attribution of whatever data a result actually used.
