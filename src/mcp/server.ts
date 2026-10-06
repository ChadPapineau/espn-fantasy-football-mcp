// server.ts — createServer (plan 01 §3.1/§4): one McpServer named `espn-fantasy-football-mcp-server`
// whose `instructions` carry both mandatory sentences exactly once (plan 02 §6.3; plan 01 §4.1 the
// ESPN sentence) plus a short static guide; tools/resources/prompts capabilities; `ttlMs` and
// `cacheScope: "private"` on every cacheable list (300 000 ms — the tool set is fixed at process
// start); the registry's tools in order (EFF_TOOLSET), the PHASE W SEAM registration point (registers
// nothing), the ten resources and the eight P0 prompts. No I/O here: the composition root injects
// everything. Ported from sibling @5daa625 (src/mcp/server.ts), adapted.
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

/** The short usage guide after the two sentences (static; no dynamic text — plan 07 §5.4). */
export const SERVER_GUIDE = [
  "Fantasy-football analysis of the operator's own ESPN league, read-only: no tool changes the league.",
  "Start with espn_get_status and espn_get_league once per session; espn-ff://docs/tool-outputs lists every tool's fields.",
  "Every result is an envelope {data, meta, page, truncated, partial, warnings}; every Dist carries its basis.",
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

/** Builds the server (tools, resources, prompts) over the injected services. */
export function createServer(services: McpServices, options: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
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
