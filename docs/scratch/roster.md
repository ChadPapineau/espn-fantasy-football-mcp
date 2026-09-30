# Agent roster — pre-build program

Program: `docs/scratch/program.md`. Briefs (verbatim, as sent):
`docs/scratch/briefs/<agent>.md`. Update this table on every agent event
(spawn, completion, cutoff) in the same commit as whatever that event produced.

Status vocabulary: ⚪ not started · 🟢 running · 🟠 cut off · ✅ done · ⛔ blocked

| agent | id | wave | status | owns | last SHA | resume pointer |
|---|---|---|---|---|---|---|
| repo-security-auditor | afe0e8db560613322 | 1 (+ keyring addendum) | ✅ done (wave 1 `879763f`; keyring addendum `5b6b0bb` — Safe; SLSA provenance re-verified by the orchestrator on the npm attestations endpoint) | `docs/research/01-*`, `02-*`, `docs/scratch/repo-security-auditor.md` | `5b6b0bb` | — |
| espn-api-specialist | ae40ffdfb8c95bafa | 1 | ✅ done (SHAs verified on origin; identifier scan clean) | `docs/research/03-espn-api.md`, `docs/scratch/espn-api-specialist.md` | `c43704c` | — |
| data-source-evaluator | a60240589e2bf3479 | 2 | ✅ done (SHAs verified; identifier scan clean; espn_id 497/500 recounted independently; ToU §2.B.viii quote verified) | `docs/research/04-*`, `docs/scratch/data-source-evaluator.md` | `38c778b` | — |
| fantasy-strategy-analyst | a0bfbe7bbfa3c85c1 | 2 | ✅ done (SHAs verified; identifier scan clean; IR-eligibility quotes verified at support.espn.com) | `docs/research/05-*`, `docs/scratch/fantasy-strategy-analyst.md` | `31abd8f` | — |
| skills-mcp-researcher | a4ffbd8e575038d07 | 3 | ✅ done (SHAs verified; identifier scan clean; plugin tool-naming claim spot-checked at code.claude.com) | `docs/research/06-*`, `docs/scratch/skills-mcp-researcher.md` | `2696787` | — |
| architecture-planner-core | aa8211963894867bd | 3 | ✅ done (SHAs verified; identifier/abs-path scan clean; SDK 2.2.0 and keyring 2.1.0 metadata re-checked on the npm registry) | `docs/plan/01-*` … `06-*`, `docs/scratch/architecture-planner-core.md` | `965ee10` | — |
| product-planner | abf797cc7b96aadb5 | 4 | ✅ done (SHAs verified; identifier scan clean) | `docs/plan/07-*` … `10-*`, `docs/scratch/product-planner.md` | `131ec10` | — |
| devils-advocate | a30c04c0a440fc7aa | 5 | ✅ closed — round 3 `ae92d9a`: all round-2 objections conceded-by-defence, none pressed, no new objections, closing verdict written; five line nits taken by the orchestrator (`073f4e4`) | `docs/plan/adversarial-log.md`, `docs/scratch/devils-advocate.md` | `ae92d9a` | — |
| plan-reviser | a5f11d7307d30c73a | 5 | ✅ R1–R3 done (`7f36671`); 🟠 cut off (spend limit) before its R4 pass — nothing lost; R4 taken over by workflow `wf_cf35c7e6-a8e` | `docs/plan/01-*` … `10-*` edits, `docs/plan/changelog.md`, `docs/scratch/plan-reviser.md` | `7f36671` | — |
| docs-writer | a92a346d851a82fce | 6 | ✅ done (`8951cb7`…`315ebe5`); all 8 README diagrams parse + render (Mermaid 11); orchestrator fixes `480352c`; aligned after R4 (`ab04385`) | `README.md`, `LICENSE`, `SECURITY.md`, `docs/README.md`, `docs/plan/00-index.md`, `docs/scratch/docs-writer.md` | `315ebe5` | — |

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
- 2026-09-30 — `architecture-planner-core` ✅ (`94e18cd`…`965ee10`), plans 01–06, 1,914 lines. Orchestrator verified `@modelcontextprotocol/server` 2.2.0 (2026-09-28, no install scripts) and `@napi-rs/keyring` 2.1.0 (2026-09-13, prebuilt optional deps, no install script) on the npm registry; scans clean. `repo-security-auditor` resumed (same id) for the keyring audit per plan 02 §7.2.
- 2026-09-30 — keyring addendum ✅ (`5b6b0bb`): `@napi-rs/keyring@2.1.0` Safe, pin exact + lockfile integrity; plan 02 §7.2 items 1–4 pass statically, item 5 (macOS prompt behaviour) is a runtime check for the first `eff doctor`. Orchestrator verified the SLSA provenance (GitHub-hosted runner, `CI.yml`, source commit `1635ed45…`).
- 2026-09-30 — `skills-mcp-researcher` ✅ (`8b7fff1`…`2696787`), 582 lines: 14 Skills shipping + `draft` deferred; 36-tool crosswalk; registration gate (operator-controlled) + execution gate (prepare/commit with HMAC ticket). Wave 4 spawned: `product-planner`.
- 2026-09-30 — `product-planner` ✅ (`3fd70c9`…`131ec10`), plans 07–10, 1,413 lines: 21 P0 tools, 13 Skills, engine spec, phases with testable acceptance, write module verdict "do not build yet", 16 tensions (T-01…T-16), 15 open decisions. Wave 5 spawned: `devils-advocate` round 1 (tensions handed over as pre-filed objections).
- 2026-09-30 — `devils-advocate` round 1 ✅ (`e72afb5`). Orchestrator defence: 14 CONCEDE, 6 CONCEDE-MODIFIED (OBJ-05/06/07/12/13/18), tensions adopted per triage (`175fe2f`). `plan-reviser` spawned to apply the edits and write `changelog.md` §R1.
- 2026-09-30 — `plan-reviser` 🟠 cut off by a usage limit after `5973653`; inventory: tree clean, HEAD == origin/main, RESUME HERE checklist current (all OBJ-01…20 and T-01…16 applied; five closing tasks pending). Resumed the same id via SendMessage. Orchestrator re-rendered all six plan diagrams after the edits (6 ok, Mermaid 11.4.1) and re-scanned `docs/plan/` for identifiers (clean).
- 2026-09-30 — `plan-reviser` ✅ (`f1d2003`…`5351241`). Orchestrator follow-ups: `espn_get_player` example → `espn_get_player_stats`; changelog keyring review row; HANDOFF findings 4/7/10 corrected. `devils-advocate` resumed for round 2.
- 2026-09-30 — Adversarial round 2: `devils-advocate` `ae7bb52`; orchestrator reproduced the SQLite 10-attachment limit and the read-only open mode on this machine; defence `07e4b37` (OBJ-21 option A; OBJ-22–26 and ten nits conceded). `plan-reviser` resumed for the R2 edits; `docs-writer` spawned in the second slot (no path overlap; final consistency pass against changelog §R2).
- 2026-09-30 — `plan-reviser` R2 ✅ (`89debff`…`b4e0588`). Orchestrator: R1+R2 retired-phrase grep 0 hits; 14 diagrams parse (6 plan + 8 in the in-progress README); identifier scan clean. `devils-advocate` resumed for round 3.
- 2026-09-30 — Adversarial review **closed** at round 3 (`ae92d9a`): 3 rounds, 26 objections (1 blocking, 10 significant, 15 marginal), 16 tensions, 15 nits — all resolved, none pressed. Orchestrator note `073f4e4` takes the five closing nits; `plan-reviser` resumed to apply them and write changelog §R3 + the final summary. All 14 diagrams (6 plan + 8 README draft) parse and render (Mermaid 11).
- 2026-09-30 — `plan-reviser` final pass ✅ (`96b7d9b`…`7f36671`): five closing nits applied, changelog §R3 + Summary written. **The plan is final at `7f36671`** pending Chad's review. `.env.example` realigned with plan 03 §3 by the orchestrator (`88215ac`). Remaining: `docs-writer`.
- 2026-09-30 — `docs-writer` ✅ (`315ebe5`). Orchestrator: diagrams render; briefs' absolute local paths replaced by placeholders (`480352c`; history residual is HANDOFF item 13).
- 2026-09-30 — `plan-reviser` 🟠 cut off by a spend limit before its first R4 edit (tree clean; nothing lost). Session model switched to Opus 5.5 by Chad; **ultracode on** — remaining work runs as workflows (parallel agents; the two-agent cap is superseded for this session by Chad's ultracode opt-in).
- 2026-09-30 — Workflow `wf_cf35c7e6-a8e` (10 agents): applied R4 (`2840a58`, `39196fe`); 5 audit lenses → 64 findings → 2 skeptics → 55 confirmed → 44 fixed (`7d03833`, `ab04385`, `fc48280`), 1 not real, 10 parked; recheck found 10 residuals. Orchestrator rulings V1–V8 on the parked items; orchestrator-owned edits (research 01 path elision, closing-verdict annotation, HANDOFF wording, this roster) committed before the second workflow.
