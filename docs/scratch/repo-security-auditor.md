# Working notes — repo-security-auditor

Brief: `docs/scratch/briefs/repo-security-auditor.md`. Deliverables I own:
`docs/research/01-repo-security-audit.md`, `docs/research/02-prior-art-lessons.md`,
this file. Clones live only under the session scratch dir
(`…/scratchpad/eff-research/vendor/<owner>__<name>`), never in the repo.

Standing rules applied: every clone is `--depth 1`, read-only, nothing
installed or executed; credential values are never printed (reported as
`[redacted]` by file:line); dependency audits via `npm audit --package-lock-only`
(lockfile present) or the OSV HTTP API (everything else).

## RESUME HERE

**Status:** started 2026-09-29. Nothing audited yet.

**Done:**
- Read brief, program, roster, tooling inventory.
- This notes file created and pushed (first action).

**Not done:**
- Read sibling (Yahoo) audit docs 01/02 for reuse-by-citation.
- Discover additional ESPN repos via `gh search repos`.
- Clone + audit repos 1–13 from the brief (ESPN MCP servers, ESPN API
  wrappers, cookie-grabbing helpers).
- Dependency audits (npm audit / OSV).
- Write `docs/research/01-repo-security-audit.md` and `02-prior-art-lessons.md`.

**Next concrete step:** read the sibling audit via
`git -C "…/Yahoo Fantasy Football" show origin/main:docs/research/01-repo-security-audit.md`,
then `gh api repos/<o>/<r>` metadata for the 13 listed repos and clone them
`--depth 1` into the vendor scratch dir.

## Audit log (per repo, appended as I go)

(empty)
