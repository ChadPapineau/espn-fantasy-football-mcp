# architecture-planner-core — working notes

Agent: architecture-planner-core (wave 3). Brief: `docs/scratch/briefs/architecture-planner-core.md`.
Owns: `docs/plan/01-*` … `docs/plan/06-*`, this file, and (transiently)
`docs/scratch/architecture-planner-core.wip.patch`.

## RESUME HERE

State: **reading done; verification done; writing plan 01 §0 next.**

Next steps, in order:
1. Write `docs/plan/01-system-architecture.md` §0 (shared-core + naming decision) — commit + push FIRST.
2. Finish 01 (layers, transport, conventions, caching, limiter, drift, observability, seam).
3. 02 security, 03 lifecycle, 04 repo+CI, 05 testing, 06 automation — commit + push after each.
4. Final reply per brief format (SHAs, decision in three lines, ten decisions, negatives, assumptions).

## Verified facts gathered (2026-09-30, this session)

- Sibling baseline: `yahoo-fantasy-football-mcp@f3a0a48` docs/plan/01–10 all landed. D1–D11 as the brief says.
  Sibling plan 07 has 51 `ff_*` tool names (34 read in v1 + 7 conditional write + ops); plan 09 ships 13 Skills.
- npm (read 2026-09-30): `@modelcontextprotocol/server` latest 2.2.0 (2026-09-28), engines node>=20, deps
  `zod ^4.2.0`, `@modelcontextprotocol/core 2.2.0`, no install script. `@modelcontextprotocol/sdk` v1 latest 1.31.0
  (2026-09-28) — 17 runtime deps incl. express/hono/jose. `@napi-rs/keyring` 2.1.0 (2026-09-13), MIT, **no
  install script**, 12 optional platform packages. `hyparquet` 1.31.2 (`prepare` script only — dev-time, not
  run on install from registry). `zod` latest 4.6.5.
- MCP spec sitemap: revisions 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, **2026-07-28** (latest) + draft.
- Claude Code tool naming observed first-hand in this session: `mcp__<server>__<tool>` (e.g. `mcp__strava__strava_get_activity`);
  MCP tools are deferred behind ToolSearch in this session.
- Doc 01 (security audit) contains **no verdict on `@napi-rs/keyring`** — the brief said "if present"; it is not.
  Doc 03 §C.4 has the npm facts; the decision must be made here with an honest assessment.

## Decision sketch (to be committed in 01 §0)

Shared core: option **(b′)** — two independently released servers now; extract a shared npm package
(`@<scope>/fantasy-core`: canonical stat hub, scoring engine, analytics, DataSource loaders, envelope,
untrusted_text) *only after* both engines pass their golden tests, i.e. a migration path not a day-one coupling.
Tool prefix: `ff_` **identical to the sibling** is rejected for the ESPN server → use `espn_` for platform-fact
tools? — evaluate against the evidence: Claude Code namespaces by server (no collision); Desktop [U]; Skill
trigger ambiguity when both installed. Decide in §0 with the reasoning.

## Log

- (t0) Created this file. Working tree clean at 38c778b. Pushed 94e18cd.
- (t1) Read research 03, 02, 04, 01, 00; sibling plan 01–06 in full, 07–10 §0; mcp-builder refs; npm; sitemap.
