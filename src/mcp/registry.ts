// registry.ts — the ONE ordered tool list (plan 01 §3.1: registration order is fixed here, then
// filtered in order by EFF_TOOLSET; plan 07 C3: `core` = the 18 P0 tools; `full` adds the 16 P1
// tools of plan 10 §3.2 = 34). The write tools are the
// PHASE W SEAM: their names are declared, their registration point is below, and NOTHING registers
// there — the module is not built (plan 10 §3.W; D11) and plan 02 §3.2's four gates can never all
// hold in this build. The tool set is decided at process start and never changes (no list_changed).
import type { Toolset } from "../config/schema.js";
import type { AnyToolDefinition } from "./define.js";
import type { WriteGateVerdict } from "./services.js";
import { analyzeLineupTool, analyzeWaiversTool, projectPlayersTool } from "./tools/analytics.js";
import {
  analyzeMatchupTool,
  analyzeReplacementTool,
  analyzeRosterTool,
  analyzeScheduleTool,
} from "./tools/analytics-p1.js";
import { getInjuries, getSchedule } from "./tools/datasets.js";
import { getDefenseProfile, getDepthChart, getNews, getPlayerUsage } from "./tools/datasets-p1.js";
import { getPlayerOutlook, getPlayerStats, getProjections } from "./tools/espn-p1.js";
import {
  analyzeEvidenceTool,
  analyzeInjuryCascadeTool,
  analyzeLeagueActivityTool,
  analyzeTradeTool,
} from "./tools/market-p1.js";
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
import { analyzeRetrospective, listRecommendations, recordRecommendation } from "./tools/reclog.js";
import { getRoster } from "./tools/roster.js";

/** The tool contract the Skills are stamped with (scripts/skills/_lib.mjs reads this literal). */
export const TOOL_CONTRACT = 1;

/** Priority of a registry slot (plan 07 legend). */
export type Priority = "P0" | "P1";

/** One registry row: a catalog id, its priority, and the tool (null only for a declared, unbuilt slot). */
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
  // P1 (Stage B2, plan 10 §3.2): registered under EFF_TOOLSET=full only, after the 18 (C3).
  row("B2", "espn_get_player_stats", "P1", getPlayerStats),
  row("C3", "espn_get_projections", "P1", getProjections),
  row("C4", "espn_get_player_outlook", "P1", getPlayerOutlook),
  row("D1", "espn_get_player_usage", "P1", getPlayerUsage),
  row("D4", "espn_get_depth_chart", "P1", getDepthChart),
  row("D5", "espn_get_defense_profile", "P1", getDefenseProfile),
  row("D6", "espn_get_news", "P1", getNews),
  row("E3", "espn_analyze_matchup", "P1", analyzeMatchupTool),
  row("E4", "espn_analyze_replacement", "P1", analyzeReplacementTool),
  row("E6", "espn_analyze_trade", "P1", analyzeTradeTool),
  row("E7", "espn_analyze_injury_cascade", "P1", analyzeInjuryCascadeTool),
  row("E8", "espn_analyze_schedule", "P1", analyzeScheduleTool),
  row("E9", "espn_analyze_roster", "P1", analyzeRosterTool),
  row("E10", "espn_analyze_evidence", "P1", analyzeEvidenceTool),
  row("E11", "espn_analyze_league_activity", "P1", analyzeLeagueActivityTool),
  row("E14", "espn_list_recommendations", "P1", listRecommendations),
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
 * The seven conditional write tools of plan 07 §3.F — declared names only, owned by the gate's types
 * (no other source file spells them). No definition exists in this build; the write host is not in
 * the allow-list (src/http).
 */
export { WRITE_TOOL_NAMES } from "../domain/gate/types.js";

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
