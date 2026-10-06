// debug.ts — `espn_debug_echo`, the fixture-mode-only echo spike (plan 07 §5.1; plan 10 A11b, T-06;
// ADV OBJ-24): a fresh 12-hex nonce ONLY in `structuredContent` (the text block says it was omitted)
// so each client can be asked to repeat it — the copy count — beside the `instructions` nonce
// createServer appends in fixture mode. Never registered in production mode; never in
// tests/smoke/expected-tools.json. Ported from sibling @5daa625 (registerDebugEcho), adapted.
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { advertised, envelopeOutline, fullDescription } from "../define.js";
import { TOOL_FAMILIES, buildEnvelope, envelopeSchema } from "../envelope.js";
import { describeForLog, wrapHandler } from "../errors.js";
import type { McpServices } from "../services.js";

/** The spike tool's name (fixture mode only). */
export const DEBUG_TOOL_NAME = "espn_debug_echo";
/** The text block of the spike's result: the nonce is never in it. */
export const DEBUG_ECHO_TEXT = "nonce omitted from text";

const echoData = z.strictObject({ nonce: z.string().regex(/^[0-9a-f]{12}$/) });

/** A fresh 12-hex nonce. */
export function newNonce(): string {
  return randomBytes(6).toString("hex");
}

/** Registers `espn_debug_echo` (call only in fixture mode). */
export function registerDebugEcho(server: McpServer, services: McpServices): void {
  const input = z.strictObject({});
  const output = envelopeSchema(echoData);
  server.registerTool(
    DEBUG_TOOL_NAME,
    {
      description: fullDescription(
        "Fixture-mode spike: returns a nonce only in structuredContent (the copy-count check).",
      ),
      inputSchema: advertised(input, () => ({ type: "object", properties: {} }), false),
      outputSchema: advertised(output, () => envelopeOutline(echoData), true),
      annotations: { ...TOOL_FAMILIES.ops },
    },
    wrapHandler(
      input,
      (_args, base) => {
        const env = buildEnvelope({
          data: { nonce: newNonce() },
          requestId: base.requestId,
          nowMs: services.clock.nowMs(),
          inputs: [],
        });
        return {
          content: [{ type: "text", text: DEBUG_ECHO_TEXT }],
          structuredContent: JSON.parse(JSON.stringify(env)) as Record<string, unknown>,
        };
      },
      {
        onError: (e, requestId) => {
          services.logger.warn("tool.error", {
            request_id: requestId,
            tool: DEBUG_TOOL_NAME,
            error: describeForLog(e),
          });
        },
      },
    ),
  );
}
