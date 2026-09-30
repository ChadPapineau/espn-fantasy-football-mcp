# product-planner — working notes

Role: product half of the plan for the ESPN Fantasy Football MCP server.
Owns `docs/plan/07-tool-catalog.md`, `08-scoring-engine.md`,
`09-skills-bundle.md`, `10-phasing-and-acceptance.md`, and this file.
Never edits plan 01–06, research, README, briefs, roster, program.

Brief: `docs/scratch/briefs/product-planner.md`.

## RESUME HERE

- [x] Read plan 01–06 (01 §0 shared-core + `espn_` naming is binding)
- [x] Read research 05, 06, 04, 03, 02; HANDOFF
- [x] Read sibling Yahoo plan 07–10 + adversarial-log round 1 at origin/main `67144b1` (baseline; never modified)
- [x] Read MCP best-practices + evaluation reference
- [x] Write 07 tool catalog → commit/push
- [x] Write 08 scoring engine → commit/push
- [x] Write 09 skills bundle → commit/push
- [x] Write 10 phasing + acceptance (tensions + open decisions) → commit/push
- [ ] Final: update this file, reply with SHAs

Status: 07, 08, 09, 10 written and pushed; final scratch update and reply remain.
Nothing in flight on disk beyond this file.

## Commit ledger

- `3fd70c9` docs(scratch): product-planner — working notes with RESUME HERE

## Design decisions pinned (so the four files agree)

- Names: `espn_<verb>_<resource>` (plan 01 D4/§0.4); sibling suffixes kept.
  Final names for the two nits: `espn_list_players(status)` (not
  `espn_list_free_agents`); `espn_get_standings` absorbs `espn_list_teams`.
  Skill prose uses BARE tool names (06 §C.3); qualified names only in
  frontmatter (both install forms) — plan 04 §4.2's `server:tool` rule → tension.
- Toolset gate `EFF_TOOLSET=core|full` (sibling C3 after OBJ-08); core = P0.
  Keep `outputSchema` on every tool (plan 01 define.ts is binding); dropping
  it on list tools is a what-would-change-it tied to the measured ceiling.
- P0 (21): get_league, get_standings, get_scoreboard, get_live_scoreboard,
  get_box_score (golden `match` rides here), list_transactions, get_roster,
  search_players, list_players, get_projections, get_injuries, get_schedule,
  project_players, analyze_lineup, analyze_matchup(pre), analyze_waivers
  (priority mode on ESPN ROS value + K/D-ST), record_recommendation,
  analyze_retrospective, list_recommendations, get_status, check_auth.
- P1 (13): get_player_stats, get_player_outlook, get_player_usage,
  get_depth_chart, get_defense_profile, get_news, analyze_replacement,
  analyze_trade, analyze_injury_cascade, analyze_schedule, analyze_roster,
  analyze_evidence (deterministic parts; calibrated table P2),
  analyze_league_activity. later: get_draft_results, analyze_scoring,
  analyze_draft, get_playbook. Writes F1–F7 conditional.
- Lineup objective default `auto`: points_only under seeding (b); mean with
  PF-weight under (a) while `Dist.basis = position_cv`; pwin when
  `player_sim` and A7 proves it (sibling OBJ-04).
- Seeding mode: config `EFF_SEEDING_MODE=auto|points_only` (operator-set,
  never model-set); tool detects (`mode_detected`), `both` when uncertain.
- `live` folds into `start-sit` (data-selected branch; sibling OBJ-18) →
  13 Skills ship (12 sibling names + `session-check`); `draft` deferred.
- Pre-empted sibling rulings: OBJ-05 (retro metrics that reach n≥30 fast),
  OBJ-15 (rec-log text is untrusted_fields), OBJ-16 (game-day availability
  = ESPN injuryStatus), OBJ-17 (per-player mismatch degrade, >10% blocks),
  OBJ-19 (prepare/cancel/record = local-write family → tension w/ plan 01 §4.1).
- Engine: canonical hub (sibling E2) + ESPN statId table; per-stat |Δ|≤0.005,
  total ≤0.01 vs appliedTotal; rounding rule discovered by fixture, never guessed.
- Phase W verdict: recommended DO NOT BUILD YET (reasons in 10 §3.W).

## Tensions candidates (→ plan 10 §4)

- plan 01 §4.1/§5.6 example names `espn_list_free_agents`, `espn_list_teams` (nit)
- plan 04 §4.2 skills job: `espn-fantasy-football-mcp-server:espn_<tool>` in prose vs 06 §C.3 bare names
- plan 04 §1 tree: no `.claude-plugin/`, `.mcp.json`, `evals/` (06 §E.1 wants manifest from first commit); plan 03 §4.2 "nothing lands in repo `.mcp.json`"
- plan 03 §3 config keys: add `EFF_TOOLSET`, `EFF_SEEDING_MODE`
- plan 01 §4.1 annotation families: no local-write family (record/prepare/cancel)
- plan 01 §4.2: double serialisation (structuredContent + text) — token table assumes one copy (sibling OBJ-06 spike)
- plan 01 §4.4: player.fullName wrapped → sibling OBJ-07 bare + path list; cost measured
- plan 01 §9.2 / plan 06: tables `league_settings`, `projection`, `points_cache`, `scoreboard_snapshot`; never-prune rule for recommendation_log + projection_snapshot (plan 06 prune "snapshots > 30 d")
- plan 03 §5 doctor rows: scoring_mismatch, settings_changed, ir_invalid
- plan 05 §7: add `src/domain/reclog/metrics.ts` to 100 % modules; plan 05 §1 table: Skills lanes
- plan 02 §5 `player_ids ≤ 25` vs analytics selectors
- plan 02 §1/§4.2/§8 "cannot forge" needs client-set qualifier (sibling OBJ-01) — Phase W prerequisite
- carried from sibling round 1 for the core planner to check: Node 22 ExperimentalWarning (OBJ-09), WAL file-copy backup (OBJ-10), server writes + busy_timeout stall (OBJ-11), ignore-scripts vs mermaid-cli puppeteer (OBJ-12), required checks reject direct pushes (OBJ-13)
