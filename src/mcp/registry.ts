// registry.ts — the ONE ordered tool list (plan 01 §3.1: registration order is fixed here, then
// filtered in order by EFF_TOOLSET; plan 07 C3: `core` = the 18 P0 tools; the 16 P1 slots are
// declared for Stage B2 and register nothing until their tools exist). The write tools are the
// PHASE W SEAM: their names are declared, their registration point is below, and NOTHING registers
// there — the module is not built (plan 10 §3.W; D11) and plan 02 §3.2's four gates can never all
// hold in this build. The tool set is decided at process start and never changes (no list_changed).
import type { Toolset } from "../config/schema.js";
import type { AnyToolDefinition } from "./define.js";
import type { WriteGateVerdict } from "./services.js";
import { analyzeLineupTool, analyzeWaiversTool, projectPlayersTool } from "./tools/analytics.js";
import { getInjuries, getSchedule } from "./tools/datasets.js";
import {
  getBoxScore,
  getLeague,
  getLiveScoreboard,
  getScoreboard,
  getStandings,
  listTransactions,
} from "./tools/league.js";
import { checkAuth, getStatus } from "./tools/ops.js";
import { listPlayers, searchPlayers } from "./tools/players.js";
import { analyzeRetrospective, recordRecommendation } from "./tools/reclog.js";
import { getRoster } from "./tools/roster.js";

/** The tool contract the Skills are stamped with (scripts/skills/_lib.mjs reads this literal). */
export const TOOL_CONTRACT = 1;

/** Priority of a registry slot (plan 07 legend). */
export type Priority = "P0" | "P1";

/** One registry row: a catalog id, its priority, and the tool — null for a declared P1 slot. */
export interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly priority: Priority;
  readonly tool: AnyToolDefinition | null;
}

const row = (
  id: string,
  name: string,
  priority: Priority,
  tool: AnyToolDefinition | null,
): RegistryEntry => Object.freeze({ id, name, priority, tool });

/** Every read tool, in registration order (plan 07 §3: A → B → C → D → E → G). */
export const REGISTRY: readonly RegistryEntry[] = Object.freeze([
  row("A1", "espn_get_league", "P0", getLeague),
  row("A2", "espn_get_standings", "P0", getStandings),
  row("A3", "espn_get_scoreboard", "P0", getScoreboard),
  row("A4", "espn_get_live_scoreboard", "P0", getLiveScoreboard),
  row("A5", "espn_get_box_score", "P0", getBoxScore),
  row("A6", "espn_list_transactions", "P0", listTransactions),
  row("B1", "espn_get_roster", "P0", getRoster),
  row("C1", "espn_search_players", "P0", searchPlayers),
  row("C2", "espn_list_players", "P0", listPlayers),
  row("D2", "espn_get_injuries", "P0", getInjuries),
  row("D3", "espn_get_schedule", "P0", getSchedule),
  row("E1", "espn_project_players", "P0", projectPlayersTool),
  row("E2", "espn_analyze_lineup", "P0", analyzeLineupTool),
  row("E5", "espn_analyze_waivers", "P0", analyzeWaiversTool),
  row("E12", "espn_record_recommendation", "P0", recordRecommendation),
  row("E13", "espn_analyze_retrospective", "P0", analyzeRetrospective),
  row("G1", "espn_get_status", "P0", getStatus),
  row("G2", "espn_check_auth", "P0", checkAuth),
  // P1 slots (Stage B2): declared so `full`'s order is fixed now; nothing registers until built.
  row("B2", "espn_get_player_stats", "P1", null),
  row("C3", "espn_get_projections", "P1", null),
  row("C4", "espn_get_player_outlook", "P1", null),
  row("D1", "espn_get_player_usage", "P1", null),
  row("D4", "espn_get_depth_chart", "P1", null),
  row("D5", "espn_get_defense_profile", "P1", null),
  row("D6", "espn_get_news", "P1", null),
  row("E3", "espn_analyze_matchup", "P1", null),
  row("E4", "espn_analyze_replacement", "P1", null),
  row("E6", "espn_analyze_trade", "P1", null),
  row("E7", "espn_analyze_injury_cascade", "P1", null),
  row("E8", "espn_analyze_schedule", "P1", null),
  row("E9", "espn_analyze_roster", "P1", null),
  row("E10", "espn_analyze_evidence", "P1", null),
  row("E11", "espn_analyze_league_activity", "P1", null),
  row("E14", "espn_list_recommendations", "P1", null),
]);

/** The tools a toolset registers, in registry order (`core` = P0; `full` adds the built P1 tools). */
export function toolsFor(toolset: Toolset): readonly AnyToolDefinition[] {
  return REGISTRY.filter((e) => toolset === "full" || e.priority === "P0")
    .map((e) => e.tool)
    .filter((t): t is AnyToolDefinition => t !== null);
}

/** The registered tool names for a toolset. */
export function toolNames(toolset: Toolset): string[] {
  return toolsFor(toolset).map((t) => t.name);
}

/** The full catalog names of a toolset (built or declared) — tests/smoke/expected-tools.json. */
export function catalogNames(toolset: Toolset): string[] {
  return REGISTRY.filter((e) => toolset === "full" || e.priority === "P0").map((e) => e.name);
}

// --- PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11) ------------------------------

/**
 * The seven conditional write tools of plan 07 §3.F — declared names only. No definition exists in
 * this build; the write host is not in the allow-list (src/http).
 */
export const WRITE_TOOL_NAMES: readonly string[] = Object.freeze([
  "espn_prepare_lineup",
  "espn_commit_lineup",
  "espn_prepare_transaction",
  "espn_commit_transaction",
  "espn_prepare_trade",
  "espn_commit_trade",
  "espn_cancel_prepared",
]);

/**
 * PHASE W SEAM — NOT IMPLEMENTED. The registration point of the write tools: plan 02 §3.2 lets them
 * register only when all four gates (Env, Acknowledgement, Credential, Own team) hold, evaluated at
 * process start from persisted evidence. The verdict type pins `allHold` to `false`, and even if it
 * did not, there is no tool to register: this returns the empty list, always.
 */
export function writeToolsFor(_gates: WriteGateVerdict): readonly AnyToolDefinition[] {
  // PHASE W SEAM — NOT IMPLEMENTED: a write module would return its definitions here, and only
  // when `_gates.allHold` (the literal `false` in this build) were true.
  return [];
}
