# docs-writer — working state

Role: documentation writer (README.md, LICENSE, SECURITY.md,
docs/README.md, docs/plan/00-index.md). Brief:
`docs/scratch/briefs/docs-writer.md`.

## RESUME HERE

- **State**: LICENSE + SECURITY.md pushed. Next: the two indexes, then the README.
- **Order of work** (orchestrator note: supporting files first so the
  plan-reviser's round-2 edits to plan 01–10 land before the
  plan-dependent README sections are written):
  1. [x] `LICENSE` (MIT) + `SECURITY.md` — commit + push
  2. [ ] `docs/README.md` + `docs/plan/00-index.md` — commit + push
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
