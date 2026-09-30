# 00 — Plan index (reading order)

The refined plan for `espn-fantasy-football-mcp`: a local, stdio-only, **read-only-by-default** MCP
server for ESPN Fantasy Football, with a Skills bundle, written in Node/TypeScript on the official MCP
SDK. **Nothing in this plan is built.** Every feature is 📋 planned; the build starts only after the
owner approves the plan (recorded in [`../HANDOFF.md`](../HANDOFF.md)).

This project is not affiliated with, endorsed by, or supported by ESPN or The Walt Disney Company. It
plans to use ESPN's unofficial, undocumented API with the user's own session cookies; plan 02 and
[`../research/03-espn-api.md` §D](../research/03-espn-api.md#d-terms-of-service-rate-limits-account-risk)
carry the terms-of-use and account-risk disclosure.

## How to read it

1. Start with **01** (what the system is) and **02** (what it must never do).
2. Read **07** and **09** for what a user would actually touch — the tools and the Skills.
3. Read **10** for the order of work, the acceptance criteria, the honest 2026 expectation and the
   open decisions that belong to the owner.
4. Use **03–06** and **08** as references for lifecycle, repository and CI, testing, automation and
   the scoring engine.
5. Read the **Summary** at the end of [`changelog.md`](changelog.md) to see what the three-round
   adversarial review changed and what survived, and [`adversarial-log.md`](adversarial-log.md) for the
   arguments themselves and the closing verdict.

Every decision in every file carries **decision · why · alternative considered · what would change
it**, and every file ends with its assumptions and unverified items by name.

## Structural plan

| # | Document | One line |
|---|---|---|
| 01 | [System architecture](01-system-architecture.md) | One Node process, one npm package, stdio only, SDK v2 exact-pinned, Node ≥ 24.15. The shared-core decision (two servers, two repos, no shared package today, a named extraction trigger) and the `espn_` naming. Layering (MCP surface → pure domain → providers → store), the output envelope and error contract, `untrusted_text` applied field by field, every data class with its TTL, hard limit and invalidation trigger, per-source read-only dataset files, the global ESPN limiter and per-call deadline, the drift detector and the degradation table, observability, the `FantasyPlatform` and `DataSource` seams |
| 02 | [Security architecture](02-security-architecture.md) | The two rules (no roster change without a human confirmation the model cannot forge — in a session without shell or filesystem reach; the cookie never enters the model channel, the client config, the repo or a log). Trust boundaries, the credential state machine and store specification, redaction, other members' personal data, least privilege and the opt-in write module's four gates, own-team pinning, the prepare/commit confirmation gate and its three human channels, input bounds, prompt-injection defences, supply chain and the native-addon review, the 21-row threat model |
| 03 | [Lifecycle and operations](03-lifecycle-and-operations.md) | Startup with no network or keychain on the path, clean shutdown on stdin EOF, no listening socket in `serve`. `eff setup` (hidden input, the definitive check, the optional one-shot local page), config precedence and every key, launch configuration with absolute paths and the runtime install outside any file-provider directory, the 25 `eff doctor` checks, cookie rejection mid-session without a restart or a loop, migrations, uninstall |
| 04 | [Repository structure and CI](04-repo-structure-and-ci.md) | Single package, strict TypeScript ESM, import-boundary lint rules, the directory tree, the runtime dependency allow-list (four direct packages), Conventional Commits, the CI jobs (lint, typecheck, test with the coverage gate, process, Inspector smoke, supply chain, secrets, identifiers, pack), the docs workflow (Mermaid, Skills structure, generated-docs currency, links), gitleaks rules for ESPN cookies, GUIDs and league ids, release and branch-protection recommendations |
| 05 | [Testing strategy](05-testing-strategy.md) | The pyramid — unit, property, contract over recorded anonymised fixtures, drift, fault injection, process/lifecycle, Inspector smoke, model-driven evals. **The fixture law** (recorded = evidence; derived = plumbing; the golden reads only recorded), the scrub procedure with its deny-list abort, the security regression set, the coverage gate (90/85/90 globally, 100 % for ten named modules), and what runs with zero tokens, with tokens, and with credentials |
| 06 | [Automation inventory](06-automation-inventory.md) | Every zero-token job: CI and repo hygiene, the daily drift probe (the first automation built; keyless when a public probe league is configured, plan 06 §1.2), the dataset refreshes under launchd, the few read-only credentialed jobs (roster, pool and projection snapshots, transactions append, the daily credential check, the pre-kickoff check), manual and pre-release jobs, and the request budget that keeps the account at tens of ESPN requests per day |

## Product plan

| # | Document | One line |
|---|---|---|
| 07 | [Tool catalog](07-tool-catalog.md) | 34 read tools in v1 — **18 P0** registered by default (`EFF_TOOLSET=core`) and **16 P1** added by `full` — plus 7 conditional write tools and 4 deferred. For each: inputs, output shape, method, ESPN views and request budget, degradation, token cost and the decision behind it. Ten resources, thirteen prompts, the token economy and its ceilings, the never-re-fetch rules, and the clean negatives returned as fields |
| 08 | [Scoring engine](08-scoring-engine.md) | A pure, settings-driven engine over a canonical stat hub: the ESPN stat-id table, bracket and bonus families, position overrides, projections scored as sampled stat lines, and validation against ESPN's own applied points — per stat within 0.005 and per total within 0.01 on recorded fixtures — with a mismatch degrading per player and refusing league-wide only above 10 % |
| 09 | [Skills bundle](09-skills-bundle.md) | The **13 Skills** that ship (`onboard`, `weekly`, `start-sit`, `stream-kdef`, `retro`, `apply`, `session-check`, `waivers`, `trade`, `injury-cascade`, `schedule-plan`, `roster-audit`, `news-check`), their triggers, tool order, output contract and guardrails; the shared conventions; the directory layout and plugin packaging; the two eval lanes (zero-token structural on every push, model-graded before a release); install paths per client |
| 10 | [Phasing and acceptance](10-phasing-and-acceptance.md) | Phases 0 → 1a (fixtures and keyless data, no cookies) → 1b (the live league, gated on the owner accepting the account risk) → 2 → 3, a conditional write phase with the verdict **"recommended: do not build yet"**, and a "later" list. Acceptance criteria as tests, CI jobs or named manual checks; the measurement ledger; the honest expectation for the 2026 season; the open decisions for the owner (D0–D15) |

## Review record

| Document | One line |
|---|---|
| [Adversarial log](adversarial-log.md) | The devil's advocate's objections and the orchestrator's defence, round by round, ending in the **closing verdict**. Closed after three rounds: 26 objections (1 blocking, 10 significant, 15 marginal), 16 pre-filed tensions and 15 nits — all resolved (20 objections as ruled, 6 with a modified fix), nothing rejected, nothing pressed at close. The closing verdict lists what survived unchanged, what changed and why it matters, and the residual concerns in rank order |
| [Changelog](changelog.md) | What each round changed (§R1, §R2, §R3, plus §R4 — the consistency fixes after the docs pass, their verification pass and the orchestrator's rulings on the parked items): one row per objection, tension and nit — ruling, files and sections changed, what survived unchanged — the numbers that moved (for example `core` = 18 tools, the Node floor, `weight_espn = 1.0`), the narrow readings the reviser made, a final **Summary** for a reader who reads nothing else, and the dependency reviews to re-run on every version bump |

## Numbers worth knowing before you read

| Quantity | Value | Where |
|---|---|---|
| Tools registered by default (`EFF_TOOLSET=core`) | 18 (P0) | 07 C3 |
| Tools added by `EFF_TOOLSET=full` | 16 (P1) — 34 read tools in total | 07 C3 |
| Conditional write tools / deferred tools | 7 / 4 | 07 §3.F, §3 |
| Skills | 13 | 09 K1 |
| Resources / prompts | 10 / 13 | 07 §4 |
| Node floor | ≥ 24.15 | 01 D2 |
| ESPN request caps | ≤ 30/min, ≤ 1/s sustained, ≤ 2 concurrent, ≤ 3 per tool call, ≤ 20 s per call | 01 D7, §6 |
| `eff doctor` checks | 25 | 03 §5 |
| Coverage gate | 90 % lines / 85 % branches / 90 % functions; 100 % for ten modules | 05 §7 |
| Engine validation tolerance | 0.005 per stat, 0.01 per total | 08 E4 |
| v1 projection ensemble weight on ESPN's mean | 1.0 | 07 E1 |
| Write module verdict | recommended: do not build yet | 10 §3.W |
