# 00 — Tooling inventory (connectors, skills, agents available during this program)

Date: 2026-09-29. Purpose: Phase-0 item 3 — what is available to the
orchestrating session, which of it helps this project, and which Skills this
project should have of its own. Nothing here is a product dependency.

## Connectors / MCP servers reachable from the orchestrating session

| connector | relevant? | how it is used here |
|---|---|---|
| GitHub (`gh` CLI 2.96, authenticated as the repo owner; SSH keys work) | **yes** | clone/push, repo description + topics, visibility/protection checks, API reads, `gh search repos` for prior-art discovery |
| Web search / fetch | **yes** | all research; official and primary sources first |
| Built-in browser | **yes, later** | Mermaid syntax validation of README diagrams (render check); reading pages that block fetchers |
| MCP registry search | checked | searched `espn`, `fantasy football`, `nfl`, `fantasy sports`, `sports` on 2026-09-29: **no ESPN, NFL, or fantasy-sports connector exists** — confirms the gap this project fills |
| Scheduled tasks (cloud Claude routines) | later, cautiously | model-driven recurring briefings (waiver-day report, Sunday inactives). **Not** for zero-token automation — that is scripts/launchd/cron |
| Sentry | maybe, later | optional error reporting for a local stdio server; decided in the plan |
| PostHog, Supabase, Cloudflare, Vercel, Adobe, Strava, Claude Docs, iOS simulator, computer-use | no | unrelated to a single-user local tool |

## Skills available to the orchestrator that matter here

| skill | use |
|---|---|
| `anthropic-skills:mcp-builder` | MCP-server design guidance (tool naming, schemas, transport, errors). Loaded in the plan phase and by the skills researcher |
| `anthropic-skills:skill-creator` (installed at `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/skill-creator/`) | authoring standard for the Skills this server ships (frontmatter, progressive disclosure, evals) |
| `code-review`, `security-review`, `simplify` | gates during the build phase (post-approval) |
| `schedule` / `loop` | recurring model-driven runs, if adopted |
| `dataviz` | any chart in docs or reports |
| `artifact-diagramming` | diagram guidance; README diagrams are Mermaid for native GitHub rendering |

The orchestration-discipline skills the sibling program used (`agent-brief`,
`agent-roster`, `tree-hygiene`, `mutation-verify`, from a private repo) are
not installed in this session; the same discipline is applied by hand
(verbatim briefs in `docs/scratch/briefs/`, a roster, explicit-path staging,
verify after every push).

## Local environment facts that shape the plan

- Node 22.23.2 via `fnm` (Claude Desktop launches the existing `strava-mcp`
  server with the absolute `fnm` node path), npm 10.9.8, git 2.39.5.
- The other local MCP server (`strava-mcp`) is Node/TypeScript, ESM,
  `@modelcontextprotocol/sdk` + `zod`, `tsc` build to `dist/`, launched from
  `claude_desktop_config.json` with absolute paths. This project matches
  that stack.
- The working directory path contains spaces and sits under
  `~/Documents` (iCloud-synced on macOS by default). Consequence: nothing
  secret is ever written inside the repo directory; credential and cache
  stores default to `~/.config/…` and `~/.cache/…`.
- No `gitleaks`, `osv-scanner`, or `pip-audit` installed; audits use
  `npm audit --package-lock-only` and the OSV HTTP API.

## Sibling project (Yahoo) — reuse by citation

`ChadPapineau/yahoo-fantasy-football-mcp` is running the same pre-build
program in parallel. Its verified research is reused here where
platform-agnostic (repo audit overlap, NFL data sources, strategy methods)
and cited by path and commit; ESPN-specific work is done here. Tool naming,
Skills and architecture consistency is a plan requirement; a shared core is
evaluated in the plan, not assumed.

## Skills this project should ship with (proposed; finalized by `docs/research/06-*`)

Candidate list to be researched, not a decision:
weekly game-plan briefing · start/sit protocol · waiver-priority strategy
and claim timing (move-to-last) · trade analysis · injury-cascade response ·
bye/playoff planning · K/D/ST streaming · draft assistant · league-settings
onboarding and validation · ESPN session/health troubleshooting · post-week
retrospective · news-vs-stats disagreement check · points-for seeding
strategy · roster health audit.

## Agents used in this program

See `docs/scratch/roster.md`. All are `general-purpose` sub-agents with a
saved verbatim brief; none has write access outside its owned paths.
