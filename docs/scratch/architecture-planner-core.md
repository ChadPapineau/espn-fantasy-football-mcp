# architecture-planner-core — working notes

Agent: architecture-planner-core (wave 3). Brief: `docs/scratch/briefs/architecture-planner-core.md`.
Owns: `docs/plan/01-*` … `docs/plan/06-*`, this file. No wip patch exists (nothing unfinished).

## RESUME HERE

State: **DONE.** All six plan files are on `origin/main`. Nothing is pending.

If re-opened: the shared-core/naming decision is plan 01 §0 (D3, D4, §0.1–0.4); the one review this plan
requires but could not perform is the `@napi-rs/keyring` source/provenance checklist (plan 02 §7.2) — the
security auditor's doc 01 carries no verdict on it. The product planner (plans 07–10) and the skills researcher
(research 06) should take plan 01 §0.4's crosswalk rule (`ff_x` ↔ `espn_x`) as given.

## Commits (all on origin/main)

- 94e18cd scratch notes created
- d58ee9c scratch notes: verified facts
- 9f41a3c plan 01 §0 — shared-core decision + espn_ naming (committed first per brief)
- 55fc885 plan 01 complete
- fb8c7c6 plan 02
- f4ea7ef plans 03 + 04
- d272eee plans 05 + 06 (+ plan 04 identifiers-rule fix)

## Verified facts gathered (2026-09-30, this session)

- Sibling baseline `yahoo-fantasy-football-mcp@f3a0a48` plans 01–10 read (01–06 in full, 07–10 §0 + tool/skill names; 51 `ff_*` tools, 13 Skills).
- npm: `@modelcontextprotocol/server` 2.2.0 (2026-09-28; core 2.2.0 + zod ^4.2.0; no scripts); `@modelcontextprotocol/sdk` 1.31.0 (17 runtime deps);
  `@napi-rs/keyring` 2.1.0 (no install script; 12 optional platform packages; `darwin-arm64` = one .node, no scripts, no deps); `hyparquet` 1.31.2; `zod` 4.6.5.
- MCP spec sitemap: latest published revision 2026-07-28 (+ draft).
- SDK `docs/protocol-versions.md`: v2 "serves both [eras] from the same entry points"; `serveStdio` pins era per connection; `legacy: 'reject'` opt-in.
- Claude Code: tools exposed as `mcp__<server>__<tool>` [docs + observed]; `claude mcp add --scope user --env K=V --transport stdio <name> -- <cmd>`; user scope in `~/.claude.json`.
- Claude Desktop (user report #50319, 2026-04-18): namespace key = config key; different keys → separate namespaces; same key + same tool name → silent hang. MCP discussion #1198: namespacing unspecified in the spec.
- This machine: node v22.23.2 at `<home>/.fnm/node-versions/v22.23.2/installation/bin/node`, fnm 1.39.0.
- Doc 01 has **no** `@napi-rs/keyring` verdict.

## Log

- (t0) Created this file at 38c778b; pushed 94e18cd.
- (t1) Read research 03, 02, 04, 01, 00; sibling plans; mcp-builder refs; npm; sitemap; Claude Code docs; three GitHub threads.
- (t2) §0 committed first (9f41a3c); then 01 (55fc885), 02 (fb8c7c6), 03+04 (f4ea7ef), 05+06 (d272eee).
- (t3) Zero-install Mermaid lint (regex for unquoted special chars; fence balance) and identifier scan over all six files: clean.
