// server.ts — createServer (plan 01 §3.1/§4): one McpServer named `espn-fantasy-football-mcp-server`
// whose `instructions` carry both mandatory sentences exactly once (plan 02 §6.3; plan 01 §4.1 the
// ESPN sentence) plus a short static guide (plan 07 §5.4: no dynamic text) that carries changelog
// §R17, R17-2's two sentences verbatim — a request one of the plugin's Skills covers loads that
// Skill before any tool call or question, and data time comes from the envelope's meta — and §R18,
// R18-1's sentence right after the first (a question that only asks whether a player is healthy is
// a plain lookup) and R18-11's right after R18-1's (a question about a league on another platform
// is not about this league: no Skill covers it), with the session-start reads scoped to a session
// that loads no Skill (1,477 characters in all); tools/resources/prompts
// capabilities, each declared `listChanged: false` — the sets are fixed at process start and no
// list_changed is ever sent (plan 01 §3.1, plan 02 §3.2, plan 07 §5.4; changelog R5), so initialize
// and server/discover advertise it (the SDK would otherwise default the bit to true on the first
// registration); `ttlMs` and `cacheScope: "private"` on every cacheable list (300 000 ms — the tool
// set is fixed at process start); the registry's tools in order (EFF_TOOLSET), the PHASE W SEAM
// registration point (registers nothing), the ten resources and the eight P0 prompts. No I/O here:
// the composition root injects everything. Ported from sibling @5daa625 (src/mcp/server.ts), adapted.
import { McpServer, type CacheHint } from "@modelcontextprotocol/server";
import { ESPN_ESTIMATE_RULE, UNTRUSTED_TEXT_RULE } from "./envelope.js";
import { registerDefinedTool } from "./define.js";
import { registerPrompts } from "./prompts/index.js";
import { toolsFor, writeToolsFor } from "./registry.js";
import { registerResources } from "./resources/index.js";
import type { McpServerOptions, McpServices } from "./services.js";
import { registerDebugEcho } from "./tools/debug.js";

/** The server name clients and the Skills use (plan 01 §4.1). */
export const SERVER_NAME = "espn-fantasy-football-mcp-server";

/** `ttlMs` for the list results and discovery (plan 01 §3.1). */
export const LIST_TTL_MS = 300_000;

/**
 * Changelog §R17, R17-2, verbatim: a request one of the plugin's Skills covers loads that Skill
 * before any tool call and any question (the Skill makes the session's first reads); a plain lookup
 * needs none. Then changelog §R18, R18-1's sentence, verbatim, one space after R17-2's two (which
 * stay byte-identical): a question that only asks whether a player is healthy is such a lookup,
 * even when the read shows him hurt — R17-3's reading, in the text the model reads. Then §R18,
 * R18-11's sentence, verbatim, one space after R18-1's (R17-2's two and R18-1's stay
 * byte-identical): a question about a league on another platform is not about this league, so no
 * Skill covers it — R17-2's own condition (a "question about this league") negated in R17-2's
 * words. The instructions are 1,477 characters in all (1,355 before R18-11).
 */
export const SKILL_FIRST_RULE =
  "When one of this plugin's Skills covers the request (a lineup, start/sit, waiver, trade, roster or season question about this league), load it before any tool call and before asking the user anything: it makes the session's first reads and says what to ask. A plain lookup (a status, a score, a setting) needs no Skill. A question that only asks whether a player is healthy is such a lookup, even when he turns out to be hurt. A question about a league on another platform (Sleeper, Yahoo and the like) is not about this league: no Skill covers it.";

/** Changelog §R17, R17-2, verbatim: the data's time is the envelope's, never the conversation's. */
export const DATA_TIME_RULE =
  "Data time comes from `meta.as_of` and `meta.freshness`, never from comparing a date in the data with the conversation's date.";

/**
 * The short usage guide after the two sentences (static; no dynamic text — plan 07 §5.4). The
 * session-start reads stay for a session that loads no Skill (R17-2), scoped by the clause in front.
 */
export const SERVER_GUIDE = [
  "Fantasy-football analysis of the operator's own ESPN league, read-only: no tool changes the league.",
  SKILL_FIRST_RULE,
  "When no Skill is loaded, start with espn_get_status and espn_get_league once per session; espn-ff://docs/tool-outputs lists every tool's fields.",
  "Every result is an envelope {data, meta, page, truncated, partial, warnings}; every Dist carries its basis.",
  DATA_TIME_RULE,
  "Log a recommendation with espn_record_recommendation before presenting it.",
].join(" ");

/** The `instructions` text: each mandatory sentence exactly once, then the guide. */
export const SERVER_INSTRUCTIONS = `${UNTRUSTED_TEXT_RULE}\n\n${ESPN_ESTIMATE_RULE}\n\n${SERVER_GUIDE}`;

/** The fixture-mode echo-spike line carrying the `instructions` nonce (plan 10 A11b; ADV OBJ-24). */
export function spikeLine(nonce: string): string {
  return `Fixture-mode spike nonce (repeat it if asked): ${nonce}`;
}

/** The instructions a server serves: the production text, plus the spike nonce in fixture mode. */
export function instructionsFor(
  options: Pick<McpServerOptions, "fixtureMode" | "spikeNonce">,
): string {
  return options.fixtureMode && options.spikeNonce !== undefined
    ? `${SERVER_INSTRUCTIONS}\n\n${spikeLine(options.spikeNonce)}`
    : SERVER_INSTRUCTIONS;
}

const LIST_HINT: CacheHint = { ttlMs: LIST_TTL_MS, cacheScope: "private" };

/**
 * The capabilities the server declares: tools, resources and prompts with `listChanged: false`
 * (the sets never change mid-session — no late registration, no list_changed; changelog R5).
 */
export const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { listChanged: false },
  prompts: { listChanged: false },
} as const;

/** Builds the server (tools, resources, prompts) over the injected services. */
export function createServer(services: McpServices, options: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      capabilities: {
        tools: { ...SERVER_CAPABILITIES.tools },
        resources: { ...SERVER_CAPABILITIES.resources },
        prompts: { ...SERVER_CAPABILITIES.prompts },
      },
      instructions: instructionsFor(options),
      cacheHints: {
        "tools/list": LIST_HINT,
        "prompts/list": LIST_HINT,
        "resources/list": LIST_HINT,
        "resources/templates/list": LIST_HINT,
        "server/discover": LIST_HINT,
      },
    },
  );
  for (const tool of toolsFor(options.toolset))
    registerDefinedTool(server, tool, services, options);
  // PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; D11; plan 02 §3.2): the write tools would register
  // here, only when all four registration gates hold at process start. writeToolsFor returns [].
  for (const tool of writeToolsFor(options.writeGates))
    registerDefinedTool(server, tool, services, options);
  if (options.fixtureMode) registerDebugEcho(server, services);
  registerResources(server, services, options);
  registerPrompts(server, services, options);
  return server;
}
