# docs/

The research, the plan, the record of how the plan was attacked and defended, and the orchestration
state of the agent program that produced them. **Read [`HANDOFF.md`](HANDOFF.md) first** in any fresh
session; then [`plan/00-index.md`](plan/00-index.md) for the plan in reading order. Everything in this
directory describes a product that is **📋 planned, not built** — no server code exists, and the build
starts only after the owner approves the plan.

> **Not affiliated with ESPN.** This project is not affiliated with, endorsed by, or supported by ESPN
> or The Walt Disney Company. It plans to use ESPN's unofficial, undocumented fantasy API with the
> user's own session cookies; the terms-of-use and account-risk disclosure is in
> [`research/03-espn-api.md` §D](research/03-espn-api.md#d-terms-of-service-rate-limits-account-risk)
> and in the [README](../README.md#terms-of-use-and-account-risk).

| Path | What it is |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | **The single handoff document.** The ▶ NEXT STEP, the findings that shape the product (the unofficial cookie-authenticated API and its silent drift, the Disney Terms of Use reading, keychain-first credentials, the prior-art audit, the write surface, data sources, the format strategy, the Skills design, the product plan), program status, decisions made with dates, and the accumulating list of things the owner must know or decide |
| [`research/`](#research-00-to-06) | Seven research documents (waves 1–3), each verified by the orchestrator against load-bearing claims at source |
| [`plan/`](#plan-01-to-10-plus-the-review-record) | The ten-part refined plan, the adversarial log and the changelog of what the review changed |
| [`scratch/`](#scratch) | Orchestration state — the agent roster, verbatim briefs, per-agent resume notes. Not product documentation |

## Research 00 to 06

| Doc | One line |
|---|---|
| [`00-tooling-inventory.md`](research/00-tooling-inventory.md) | Which connectors, skills and agents were available to the orchestrating session, the local-environment facts that shape the plan (the Node toolchain, a checkout path with spaces under an iCloud-managed directory), the sibling Yahoo program reused by citation, and the candidate Skills list later finalised in 06 |
| [`01-repo-security-audit.md`](research/01-repo-security-audit.md) | Twenty-nine prior-art repositories (ESPN MCP servers, API wrappers, cookie helpers) read **statically as untrusted code** — nothing installed or executed: per-repo verdicts (*Safe to learn from* · *Learn from with caution* · *Do not use*), a historical cookie leak found in one public history (the value never reproduced), dependency-advisory counts, the rejected list, and the focused audit of the one native dependency the plan adopts (`@napi-rs/keyring`, §30: Safe) |
| [`02-prior-art-lessons.md`](research/02-prior-art-lessons.md) | Architecture lessons from the repositories that passed: capability matrices, the choices that work (adopt the idea, never the code), the mistakes to avoid with the symptom each produces, and what the matrix says this design must do differently — notably that every write gate but one in prior art is a boolean the model sets, and nobody labels untrusted text |
| [`03-espn-api.md`](research/03-espn-api.md) | The capability reference for ESPN's **unofficial** fantasy API: hosts, routes, views and the `X-Fantasy-Filter` header; the data model (settings, the two id spaces, stat ids, rosters, matchups, native projections and ownership); **§C credentials** (the two cookies, their unknown lifetime, expiry detection, storage options, rotation); **§D terms of service, rate limits and account risk** (the Disney Terms of Use quoted, enforcement evidence, the polite-usage design); the write endpoints (documented, never probed); the drift-resilience design and the fixture-anonymisation procedure; the unverified ledger and the probe log |
| [`04-data-sources.md`](research/04-data-sources.md) | Every NFL data source graded per need with an ESPN-native column first (projections, ownership, injury status, schedule and lock flags), nflverse as the backbone, ffopportunity, Sleeper, odds, weather, news; the ESPN player-id crosswalk study with exact counts; the freshness map; the licensing table and the personal-vs-commercial constraint (the binding one is the Disney terms, not a data licence) |
| [`05-strategy-and-analytics.md`](research/05-strategy-and-analytics.md) | The analytics methodology for this league format: waiver priority as an option under move-to-last rules (the premium `Π(k, W)` and the claim rule), the two readings of points-for seeding and the scenario simulator, 5-point passing touchdowns and turnover penalties, replacement level and bench/IR construction for a 10-team half-PPR roster, the ESPN deltas for every other decision type, news text as untrusted input, the scoring-engine specification, and the decisions, pitfalls, clean negatives and evaluation plan |
| [`06-skills-and-mcp-design.md`](research/06-skills-and-mcp-design.md) | What is a tool, a Skill, a prompt and a resource for this server: the ESPN deltas to the sibling's mechanism research (the confirmation gate composed with an opt-in write module, session-cookie failure as an MCP concern, free text inside fact JSON), the split applied to every capability and decision type, the naming crosswalk with the sibling, the candidate Skills catalog, and the repository layout, versioning, eval lanes and install paths for the bundle |

## Plan 01 to 10 plus the review record

The reading-order index with one-line summaries is [`plan/00-index.md`](plan/00-index.md). Plans 01–06
are the **structural plan** (architecture, security, lifecycle, repository and CI, testing, automation);
07–10 are the **product plan** (tool catalog, scoring engine, Skills bundle, phasing and acceptance).

- [`plan/adversarial-log.md`](plan/adversarial-log.md) holds every objection a devil's-advocate agent
  raised, the defence's ruling on each, and — at the end — the **closing verdict**. The review is
  **closed after three rounds**: 26 objections (1 blocking, 10 significant, 15 marginal), 16 pre-filed
  tensions and 15 nits — all resolved and landed in the plan; nothing rejected, nothing withdrawn,
  nothing pressed at close. The closing verdict also ranks the residual concerns.
- [`plan/changelog.md`](plan/changelog.md) records, one row per objection, tension and nit, what changed
  in which plan file and what survived unchanged (§R1, §R2, §R3), ends with a **Summary** for a reader
  who reads nothing else, and lists the dependency reviews that must be re-run on every version bump.

The plan is final and **awaiting the owner's approval**; approval, not the review, is what starts the build.

## Scratch

[`scratch/`](scratch/) is the agent program's working memory, committed so that work survives a
usage-limit cutoff: [`roster.md`](scratch/roster.md) (every agent, its brief, owned paths, status and
last pushed SHA), [`program.md`](scratch/program.md) (waves and file ownership),
[`briefs/`](scratch/briefs/) (the verbatim brief each agent was given) and one `<agent>.md` note per
agent with a `## RESUME HERE` section. It is orchestration state, not product documentation: nothing in
it is a decision unless `HANDOFF.md` or a plan file records it.

## Conventions used across these documents

- **Verification marks.** Claims are tagged as verified (with the source and the date — observed by a
  probe, quoted from an official page, or read in community source) or **unverified**; each document
  collects its unverified items by name in a ledger near its end.
- **No identifiers, no secrets.** No league id, team or owner name, member GUID, IP address, cookie or
  absolute local path appears in any committed file. Examples use placeholders (`0000000`,
  "Example League", "Team A", `/absolute/path/to/…`).
- **Third-party code is untrusted.** The audited repositories were read statically; nothing here copies
  their code or prose. They are acknowledged in the README as inspiration only.
- **Sibling project.** `yahoo-fantasy-football-mcp` (same owner) runs the same program for Yahoo. Its
  platform-agnostic research is reused here by citation; the two plans keep their names, Skills and
  architecture consistent without sharing code (plan 01 §0 has the shared-core decision).

## Licence

The documents in this directory are covered by the repository's [MIT licence](../LICENSE). MIT was
chosen because it gives maximal reuse for a small open-source tool, it is the norm for MCP servers, and
it carries no NOTICE-file overhead; Apache-2.0's explicit patent grant was judged not material for a
project of this kind, and MIT matches the sibling project. The licence covers this repository's own
text and (future) code only — it grants nothing over ESPN's data or services, which remain subject to
their owner's terms.
