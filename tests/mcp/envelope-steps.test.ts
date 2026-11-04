// envelope-steps.test.ts — a tool result's serialisation, schema check and result are steps of their
// own (envelope.ts validatedToolResultSteps; define.ts runTool takes them through `inTurns`; plan 03
// §1.2's ≤ 20 ms batch; changelog §R10 timing items: in one turn the three were 20–30 ms of an
// analytics answer on the owner's Mac). The result is the one built from the envelope before — the
// same text block, the same structuredContent — and an invalid envelope's issues are the same; in a
// served call, the tool body, the fit, the schema check and the result each run in a loop turn of
// their own (a loop-turn counter, no wall time).
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { drainSteps } from "../../src/domain/analytics/cooperative.js";
import { defineTool, outputSchemaOf, runTool } from "../../src/mcp/define.js";
import {
  serializeEnvelope,
  toToolResult,
  validatedToolResult,
  validatedToolResultSteps,
  type Envelope,
} from "../../src/mcp/envelope.js";
import type { McpServices } from "../../src/mcp/services.js";

/** One increment per event-loop iteration (an immediate queued inside an immediate runs next turn). */
function turnCounter(): { now: () => number; stop: () => void } {
  let turn = 0;
  let on = true;
  const tick = (): void => {
    turn += 1;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    now: () => turn,
    stop: () => {
      on = false;
    },
  };
}

const services = {
  clock: {
    nowMs: () => Date.parse("2026-10-06T12:00:00Z"),
    nowIso: () => "2026-10-06T12:00:00.000Z",
  },
  logger: {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  },
} as unknown as McpServices;
const options = { version: "0.0.0" } as never;

const data = z.strictObject({ rows: z.array(z.strictObject({ k: z.number(), s: z.string() })) });
const rowsTool = defineTool({
  name: "espn_get_standings",
  description: "A test tool.",
  input: z.strictObject({}),
  data,
  budget: "list",
  run: () =>
    Promise.resolve({
      data: { rows: Array.from({ length: 50 }, (_, k) => ({ k, s: `row ${String(k)} \u00e9` })) },
      inputs: [],
    }),
});
/** A served envelope of the rows tool (what runTool validated and sent), as a fresh object. */
async function servedEnvelope(): Promise<Envelope<{ rows: { k: number; s: unknown }[] }>> {
  const r = await runTool(rowsTool, {}, { requestId: "r-0123456789ab" }, services, options);
  return JSON.parse(r.content[0].text) as Envelope<{ rows: { k: number; s: unknown }[] }>;
}

describe("validatedToolResultSteps", () => {
  const schema = outputSchemaOf({ data });

  it("a valid envelope: the result toToolResult builds, in both wire modes, after two yields", async () => {
    for (const wireOutputSchema of [true, false]) {
      const env = await servedEnvelope();
      const work = validatedToolResultSteps(env, schema, { wireOutputSchema });
      let yields = 0;
      let r = work.next();
      for (; r.done !== true; r = work.next()) yields += 1;
      expect(yields).toBe(2);
      expect(r.value).toEqual({ ok: true, result: toToolResult(env, { wireOutputSchema }) });
      if (r.value.ok) expect(r.value.result.content[0].text).toBe(serializeEnvelope(env));
      expect(validatedToolResult(env, schema, { wireOutputSchema })).toEqual(r.value);
    }
  });

  it("an invalid envelope: the same value-free issues, and no result is built", async () => {
    const env = await servedEnvelope();
    const bad = { ...env, data: { rows: [{ k: 1, s: 7 }] } };
    const work = validatedToolResultSteps(bad, schema, { wireOutputSchema: true });
    let yields = 0;
    let r = work.next();
    for (; r.done !== true; r = work.next()) yields += 1;
    expect(yields).toBe(1);
    expect(r.value.ok).toBe(false);
    if (!r.value.ok)
      expect(r.value.issues).toEqual([{ path: "data.rows.[].s", code: "invalid_type" }]);
    // a value JSON cannot carry never passes (the round trip drops it before the check)
    const undef = { ...env, data: { rows: [{ k: 1, s: undefined }] } };
    expect(
      drainSteps(validatedToolResultSteps(undef, schema, { wireOutputSchema: false })).ok,
    ).toBe(false);
  });
});

describe("runTool: the body, the fit, the check and the result in turns of their own", () => {
  it("the output schema's check runs in a turn after the tool body's, and the reply after it", async () => {
    const turns = turnCounter();
    const seen: Partial<Record<"body" | "check" | "reply", number>> = {};
    const checked = z.strictObject({
      rows: z.array(z.strictObject({ k: z.number(), s: z.string() })).refine(() => {
        seen.check ??= turns.now();
        return true;
      }),
    });
    const t = defineTool({
      name: "espn_get_standings",
      description: "A test tool.",
      input: z.strictObject({}),
      data: checked,
      budget: "list",
      run: () => {
        seen.body = turns.now();
        return Promise.resolve({ data: { rows: [{ k: 1, s: "a" }] }, inputs: [] });
      },
    });
    const r = await runTool(t, {}, { requestId: "r-0123456789ab" }, services, options);
    seen.reply = turns.now();
    turns.stop();
    expect(r.structuredContent).toBeDefined();
    expect(seen.check).toBeGreaterThan(seen.body ?? Infinity);
    expect(seen.reply).toBeGreaterThan(seen.check ?? Infinity);
  });
});
