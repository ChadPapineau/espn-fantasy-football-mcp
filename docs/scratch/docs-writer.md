# docs-writer — working state

Role: documentation writer (README.md, LICENSE, SECURITY.md,
docs/README.md, docs/plan/00-index.md). Brief:
`docs/scratch/briefs/docs-writer.md`.

## RESUME HERE

- **State**: LICENSE, SECURITY.md and both indexes pushed. All plan + research files read. Next: README first half (banner → diagrams).
- **Order of work** (orchestrator note: supporting files first so the
  plan-reviser's round-2 edits to plan 01–10 land before the
  plan-dependent README sections are written):
  1. [x] `LICENSE` (MIT) + `SECURITY.md` — commit + push
  2. [x] `docs/README.md` + `docs/plan/00-index.md` — commit + push
  3. [ ] `README.md` first half (banner, status, features, 8 Mermaid
         diagrams) — commit + push
  4. [ ] `README.md` second half (tool + Skills reference, quickstart,
         credentials, config, launch config, security, testing,
         contributing, roadmap, FAQ, acknowledgements, licence) — commit + push
  5. [ ] Re-read `docs/plan/changelog.md` §R1 + §R2 and fix any README
         statement it contradicts — commit + push
- **Truth rule**: where a plan file and `adversarial-log.md`
  "Round 2 — defence" §2.E disagree, the defence wins.
- **Mermaid**: manual strict syntax pass only (no npx / mermaid-cli);
  the orchestrator renders in a browser and reports failures.
- **WIP patch**: none yet (`docs/scratch/docs-writer.wip.patch` when
  there is unfinished work).
- **Do not touch**: `docs/research/*`, `docs/plan/01`–`10`,
  `adversarial-log.md`, `changelog.md`, `docs/scratch/roster.md`,
  `docs/scratch/program.md`, `docs/scratch/briefs/`, `.gitignore`,
  `.env.example`.

## Log

- started; resume file created.
- LICENSE (MIT) and SECURITY.md written and pushed. SECURITY.md links to README anchor `#terms-of-use-and-account-risk` — the README must carry that heading.
- docs/README.md and docs/plan/00-index.md written and pushed.
- Facts to carry into the README (so a resumed session need not re-derive them):
  18 P0 tools = A1–A6, B1, C1–C2, D2–D3, E1, E2, E5, E12–E13, G1, G2; 16 P1 = B2, C3, C4, D1, D4–D6,
  E3, E4, E6–E11, E14; later = A7, E15, E16, G3; writes F1–F7. 13 Skills: 8 at P0 (incl. `waivers`
  priority branch), 5 at P1. Launch: plugin `.mcp.json` = `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/eff-launch.sh" serve`
  (round-2 defence OBJ-23; no `bin/` dir). Datasets: per-source read-only SQLite files opened as separate
  connections (OBJ-22). Fixtures: recorded = evidence, derived = plumbing (OBJ-21).
- Plan inconsistencies noticed so far (for the final report): (1) plan 07 §4.2 lists `espn.waivers` as a
  P1 prompt while plan 09 K2/§1 ships the `waivers` Skill at P0 (priority branch) — 8 P0 Skills vs 7 P0
  prompts; (2) HANDOFF finding 9 still lists `waivers` under P1 and says "14 Skills ship" before its
  parenthetical correction; (3) private vulnerability reporting is OFF on the repo (SECURITY.md says so).
