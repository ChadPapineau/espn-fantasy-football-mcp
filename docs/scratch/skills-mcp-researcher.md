# skills-mcp-researcher — working notes

Role: Skills and MCP-design researcher for the ESPN Fantasy Football MCP server.
Brief: `docs/scratch/briefs/skills-mcp-researcher.md`.
Deliverable: `docs/research/06-skills-and-mcp-design.md` (sections A–E).

## Status log

- [x] Scratch file created and pushed (8b7fff1)
- [x] Inputs read: docs/research/00–05, docs/plan/01 §0 (9f41a3c), HANDOFF, .env.example; sibling 06 + plans 01, 02, 04, 07, 09, 10 (dfde1b6)
- [x] Authoring standards loaded: mcp-builder SKILL.md + mcp_best_practices.md + evaluation.md; skill-creator SKILL.md + references/schemas.md
- [x] Section A (ESPN mechanism deltas: gate + opt-in, cookie failure UX, free text in fact JSON)
- [x] Section B (split applied to every ESPN capability and decision type)
- [x] Section C (naming crosswalk given plan §0; Skill-level consequences)
- [x] Section D (Skills catalog: triggers, tool order, evals) — 1e7c161
- [x] Section E (layout, plugin manifest, versioning, evals in CI)
- [x] Public ESPN Skill search run (GitHub API ×4, WebSearch ×3, skills.sh, mcpmarket, lobehub) — results below; write-up pending in 06 §D.0
- [x] Unverified list (§F, A-1–A-6, U-1–U-12) and sources (§G)
- [x] Final push; no WIP patch was ever needed (every checkpoint was a complete section)

## Sources log

- Sibling sha `dfde1b621fdc26be6db00cde64a316c51bba3cdf` (origin/main of yahoo-fantasy-football-mcp, 2026-09-30). Read in full: docs/research/06 (A–G), docs/plan/01, 02, 04, 07, 09, 10.
- ESPN plan §0 at 9f41a3c: D3 (two servers/two repos now, shared package on trigger), D4 (`espn_`, `espn-ff://`, `espn.<workflow>`, key `espn-fantasy-football`, bin `eff`, env `EFF_`), D8 envelope incl. untrusted fields inside trusted objects, D12 keychain, D13 writes not in v1, D14 gate is a domain service, §0.4 crosswalk rule.
- Claude Code docs fetched 2026-09-30: /docs/en/skills (frontmatter table; `allowed-tools`/`disallowed-tools` accept string or YAML list, clear on next message; combined description+when_to_use cap 1,536; listing budget 1 % of context; plugin skills as `/plugin-name:skill-name`; outside Claude Code only name/description/license/compatibility/metadata/allowed-tools), /docs/en/plugin-evals (six grader types: regex, tool_used, tool_order, file_exists free; llm, baseline paid; mocks `evals/mocks/<server>/<tool>.md` with `{{input.x}}`, `{{file:fixtures/…}}`, `expect:`; `.replay/`; "A run never starts your plugin's real MCP servers unless you ask"; **plugin MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`**; `arm: both` + `min:0,max:0` for must-not-trigger).
- Public ESPN-Skill search (2026-09-30): GitHub API repo search `espn fantasy claude skill` → 2 hits (this repo; garavitgabriel/espn-fantasy-claude-openclaw = **baseball**, 8 skills, `.claude-plugin/`, `.mcp.json`, Playwright login, two-step token writes); `espn fantasy football plugin OR skills OR agent` → 3,439 (none a football Skills bundle on page 1); `espn fantasy football claude` → 12 (ryanjadhav/espn-fantasy: `SKILL.md` + CLI, `--dry-run` writes, 0 stars; tdiderich/fantasy-football-agent: one AGL-compiled read-only skill; parkermarshall97, alexdejong3, tlo1216/frontoffice-manager, TheSirLancelot/the_combine: checked contents — see 06 §D.0); `espn fantasy "agent skill"` → 952 generic. WebSearch ×3; skills.sh → navigation only; curtisawe-cmd/FF-Site → 404; lobehub thorsenk → redirect (MCP server listing).

## RESUME HERE

**Done.** `docs/research/06-skills-and-mcp-design.md` is complete: A (gate + opt-in module, cookie-failure UX,
field-by-field untrusted text), B (split over 03 rows 1–25 and every 05 decision type; ≈ 36 read + 3 ops + 7
conditional write tools), C (crosswalk table; eight Skill-level consequences incl. the plugin-hosted tool-name
form `mcp__plugin_<plugin>_<server>__<tool>`), D (14 shipping Skills — the sibling's 13 names + `session-check`;
`draft` deferred; each with trigger, non-triggers, tool order, inputs, outputs, guardrails, ≥ 3 evals incl. an
injection case; fixture `fx-10h` + variants; skill-creator eval format), E (layout with the plugin manifest from
Phase 0, versioning, Lane 1 zero-token / Lane 2 token evals, install paths), F (unverified by name), G (sources).
Nothing pending. If resumed for revisions: the product planner (plan 07/09) owns final tool names; sib 10 nits
to pass back to the Yahoo program are in §C.1 (server-name vs config-key in Skill text).
