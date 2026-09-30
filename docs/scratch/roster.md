# Agent roster — pre-build program

Program: `docs/scratch/program.md`. Briefs (verbatim, as sent):
`docs/scratch/briefs/<agent>.md`. Update this table on every agent event
(spawn, completion, cutoff) in the same commit as whatever that event produced.

Status vocabulary: ⚪ not started · 🟢 running · 🟠 cut off · ✅ done · ⛔ blocked

| agent | id | wave | status | owns | last SHA | resume pointer |
|---|---|---|---|---|---|---|
| repo-security-auditor | — | 1 | ⚪ not started | `docs/research/01-*`, `02-*`, `docs/scratch/repo-security-auditor.md` | — | brief |
| espn-api-specialist | — | 1 | ⚪ not started | `docs/research/03-espn-api.md`, `docs/scratch/espn-api-specialist.md` | — | brief |
| data-source-evaluator | — | 2 | ⚪ not started | `docs/research/04-*`, `docs/scratch/data-source-evaluator.md` | — | brief |
| fantasy-strategy-analyst | — | 2 | ⚪ not started | `docs/research/05-*`, `docs/scratch/fantasy-strategy-analyst.md` | — | brief |
| skills-mcp-researcher | — | 3 | ⚪ not started | `docs/research/06-*`, `docs/scratch/skills-mcp-researcher.md` | — | brief |
| architecture-planner-core | — | 3 | ⚪ not started | `docs/plan/01-*` … `06-*`, `docs/scratch/architecture-planner-core.md` | — | brief |
| product-planner | — | 4 | ⚪ not started | `docs/plan/07-*` … `10-*`, `docs/scratch/product-planner.md` | — | brief |
| devils-advocate | — | 5 | ⚪ not started | `docs/plan/adversarial-log.md`, `docs/scratch/devils-advocate.md` | — | brief |
| docs-writer | — | 6 | ⚪ not started | `README.md`, `LICENSE`, `SECURITY.md`, `docs/README.md`, `docs/plan/00-index.md` | — | brief |

## Cutoff procedure

Do not touch the tree; inventory `git status --short` against the `owns`
column; preserve each agent's WIP as `docs/scratch/<agent>.wip.patch`
(explicit paths, pushed); mark 🟠; resume the same ID via `SendMessage` in
wave order; respawn cold from the saved brief only if the ID is gone.

## Event log

- 2026-09-29 — Phase 0: repo cloned via SSH into the exact local directory;
  `.gitignore` + `.env.example` committed first (`0408875`); `main` pushed;
  description + 15 topics applied via `gh`. Repo is PUBLIC, no branch
  protection, no rulesets; secret scanning + push protection enabled.
