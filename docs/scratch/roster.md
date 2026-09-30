# Agent roster — pre-build program

Program: `docs/scratch/program.md`. Briefs (verbatim, as sent):
`docs/scratch/briefs/<agent>.md`. Update this table on every agent event
(spawn, completion, cutoff) in the same commit as whatever that event produced.

Status vocabulary: ⚪ not started · 🟢 running · 🟠 cut off · ✅ done · ⛔ blocked

| agent | id | wave | status | owns | last SHA | resume pointer |
|---|---|---|---|---|---|---|
| repo-security-auditor | afe0e8db560613322 | 1 | ✅ done (SHAs verified; credential-shaped scan clean; leak commit confirmed by metadata) | `docs/research/01-*`, `02-*`, `docs/scratch/repo-security-auditor.md` | `879763f` | — |
| espn-api-specialist | ae40ffdfb8c95bafa | 1 | ✅ done (SHAs verified on origin; identifier scan clean) | `docs/research/03-espn-api.md`, `docs/scratch/espn-api-specialist.md` | `c43704c` | — |
| data-source-evaluator | a60240589e2bf3479 | 2 | ✅ done (SHAs verified; identifier scan clean; espn_id 497/500 recounted independently; ToU §2.B.viii quote verified) | `docs/research/04-*`, `docs/scratch/data-source-evaluator.md` | `38c778b` | — |
| fantasy-strategy-analyst | a0bfbe7bbfa3c85c1 | 2 | ✅ done (SHAs verified; identifier scan clean; IR-eligibility quotes verified at support.espn.com) | `docs/research/05-*`, `docs/scratch/fantasy-strategy-analyst.md` | `31abd8f` | — |
| skills-mcp-researcher | a4ffbd8e575038d07 | 3 | 🟢 running | `docs/research/06-*`, `docs/scratch/skills-mcp-researcher.md` | — | brief |
| architecture-planner-core | aa8211963894867bd | 3 | 🟢 running | `docs/plan/01-*` … `06-*`, `docs/scratch/architecture-planner-core.md` | — | brief |
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
- 2026-09-29 — wave 1 spawned: `repo-security-auditor`, `espn-api-specialist` (briefs committed at `efd6f4b`).
- 2026-09-29 — `espn-api-specialist` ✅ (`dd7cdec`…`c43704c`), 617 lines, 30/30 anonymized probes. Orchestrator: SHAs match origin; grep for GUIDs/IPs/league ids clean. Key facts: only `lm-api-reads` serves JSON; unknown views return 200 skeletons (drift must be key-based); no rate-limit headers; native projections/ownership/ADP; Disney ToU text covers automated access literally, no verified enforcement against own-league reads.
- 2026-09-29 — wave 2 (first slot) spawned: `data-source-evaluator`.
- 2026-09-30 — `repo-security-auditor` ✅ (`879763f`), 29 repos. Orchestrator scan clean; leak commit confirmed by metadata. Wave 2 (second slot) spawned: `fantasy-strategy-analyst`.
- 2026-09-30 — `docs/HANDOFF.md` created (Chad: "Yes").
- 2026-09-30 — `data-source-evaluator` ✅ (`d36a34f`…`38c778b`), 306 lines, 28 probes. Orchestrator recounted nflverse `roster_weekly_2026` espn_id coverage: 497/500 (99.4%) — matches; Disney ToU §2.B.viii commercial-use quote verified at source. Wave 3 (first slot) spawned: `architecture-planner-core`.
- 2026-09-30 — `fantasy-strategy-analyst` ✅ (`c57d110`…`31abd8f`), 451 lines, 22 requests. Orchestrator verified the IR-eligibility quotes at the ESPN help article (Updated 2026-08-18). `architecture-planner-core` committed the shared-core decision early (`9f41a3c`). Wave 3 (second slot) spawned: `skills-mcp-researcher`.
