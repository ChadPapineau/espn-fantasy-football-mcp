<!-- Plan reference: docs/plan/04-repo-structure-and-ci.md §1 (PR template) and §3 (commits). Keep the checklist; delete the hints. -->

## What and why

<!-- One paragraph. Link the plan section this implements or changes, e.g. `docs/plan/02-security-architecture.md §4`. -->

## Checklist

- [ ] **No secrets, no identifiers.** Nothing in this PR contains an ESPN cookie (`espn_s2`, `SWID`), a token, key or password, an email address, a league id, a team or member name, a member GUID outside `{00000000-0000-4000-8000-0000000000NN}`, an IP address or an absolute home path — the owner's or a public probe league's (the repo is public; `CLAUDE.md`). `secrets`, `secrets-selftest` and `docs / identifiers` are green.
- [ ] **Fixtures are anonymised** (`docs/research/03-espn-api.md` §F.3): league id `0`, "Example League", "Team A"…; recorded from public leagues, keyless.
- [ ] **Committed with `scripts/dev/commit-paths.sh`** (or a plain `git commit` through `.githooks`); explicit paths only — no `git add -A` / `-u` / directory adds; never `--no-verify`.
- [ ] **Conventional Commit** title and commits (`feat|fix|docs|test|chore|refactor|perf|ci|build(scope): subject`); **no AI attribution trailer**.
- [ ] **Read-only.** No write path is built; the Phase W seam stays declared and unimplemented (owner decision D11); no request can reach the ESPN write host.
- [ ] **Dependencies.** No new runtime dependency without a plan 04 §2 row and a reviewed `scripts/ci/runtime-allowlist.json`; every version exact; no install script.
- [ ] **Tests** for every new or changed unit (plan 05), adversarial by default; the coverage gate (plan 05 §7) untouched.
- [ ] **Docs updated** — the plan section this touches, `docs/HANDOFF.md` if a stage landed, `CHANGELOG.md`.
- [ ] **CI green** on the head commit: every `ci`, `docs` and `secrets` job.

## Notes for the reviewer

<!-- Anything that needs a second pair of eyes: a workflow change, a new gitleaks rule (add its generated case in scripts/ci/secret-fixtures.mjs), an assumption marked [A-n]. -->
