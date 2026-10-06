# Build program — full read-only scope (Phases 0, 1a, 1b, 2, 3)

Owner decisions (2026-10-05, `docs/HANDOFF.md` → "Decisions made"): build approved; full planned
functionality, no scope cuts; read-only (Phase W **not built**, its seam clearly marked in code);
free services only; personal use; rigorous secret hygiene; routine building at the owner's "Extra"
effort level, QA/penetration-testing passes at "Ultracode" (the orchestrator stops and asks the
owner to switch). Spec: `docs/plan/01–10`, acceptance in `docs/plan/10` §3.0–§3.3.

Branch: `build/phase-1` (merges to `main` only when the full gate is green). Every stage runs as a
Workflow; the orchestrator verifies each at source (SHAs on origin, CI runs, the gate re-run)
before starting the next. Method ported from the sibling's proven build (its Phase 1a went from
scaffold to QA-hardened merge in about 12 hours).

| stage | workflow | what | exit |
|---|---|---|---|
| A | `effmcp-foundation` | scaffold (exact pins, `.npmrc` first, tsconfig/eslint/prettier/vitest, CI workflows, supply-chain + secret/identifier scripts with ESPN cookie rules, pre-commit hook, commit-paths) → contract layer (platform seam incl. the **declared, unbuilt write seam**, sources, store, domain types, errors, envelope, bounds, config with key scopes, paths with file-provider refusal, logger redaction) → Phase 0 tools (standalone drift probe, keyless public-league fixture recorder + scrubber) → two critics → revise → independent gate | gate green locally and in CI on the branch |
| B1 | `effmcp-core` | Phase 1a + 1b (P0): grounding (nflverse dataset contract; recorded + scrubbed ESPN fixtures from the public probe leagues) → parallel modules by file ownership (store, http/runner/weather, nflverse, ESPN provider + drift + limiter, credential store + setup lifecycle, scoring engine + ESPN stat map, crosswalk, league model, reclog, P0 Skills) → P0 analytics → MCP surface (18 P0 tools, resources, 8 P0 prompts) + `eff` CLI and lifecycle → integration (stdio E2E, per-stat golden vs recorded `appliedStats`) → independent gate with a bounded fix loop | full gate green; every P0 tool callable end to end in fixture mode |
| B2 | `effmcp-expansion` | Phase 2 + 3 (P1 + model wave): usage/market sources (snap counts, depth charts, pbp subset, team stats, ffopportunity, Sleeper trending, news RSS), the 16 P1 tools and 5 P1 Skills, the opportunity model and calibration, the waiver DP and seeding simulator on league history, scheduled jobs (launchd) → integration → independent gate | full gate green; all 34 read tools callable end to end |
| — | **owner stop** | (1) run `eff setup` in a terminal (hidden-input cookie entry; nothing in chat); (2) switch effort to Ultracode; (3) reply "go" | — |
| C | `effmcp-qa-pentest` | QA + penetration-test finders (many lenses, incl. live read-only end-to-end against the real league) → adversarial verification → remediation by lead architects → re-verification; loop until two dry rounds | no confirmed finding open |
| D | merge + install | final gate, docs (README status, CHANGELOG, HANDOFF), merge to `main`, CI green on `main`, launch config + Skills installed for the owner | `main` green; the owner's client sees the server |

Agent rules: repo `CLAUDE.md`. Commits only via `scripts/dev/commit-paths.sh`; Node via
`scripts/dev/with-node.sh`; heavy jobs via `scripts/dev/heavy-lock.sh`. The probe-league ids are
passed to agents in their prompts and kept in local environment/config only — never in a file.

## RESUME HERE

- Stage A ✅ 2026-10-06 — workflow `effmcp-foundation` (run `wf_b6bfaf03-11c`), gate green with 0 fix rounds at `bd64cba`; CI green. Facts in `docs/HANDOFF.md` → "Build facts (Stage A)".
- Stage B1 — launching `effmcp-core` (Phase 1a + 1b). If interrupted, resume the run with its `scriptPath` + `resumeFromRunId` (completed agents replay from cache), after checking `git log` on the branch for what landed.
