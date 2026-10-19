// resource-turns.test.ts — resource reads and prompts take the process-wide turn gate, as tools do
// (plan 03 §1.2: the loop never stalls past 50 ms; plan 10 A16a; cooperative.ts yieldTurn). Stage C
// finding resources-prompts-bypass-turn-gate: readAsEnvelope (every resource, and the
// espn-ff://league/settings every prompt embeds) awaited its body and built, fitted and serialised the
// envelope in the same turn, and prompts/get built its text the moment it was dispatched — warm reads
// resolve as microtasks, so N parallel reads ran N bodies and N envelopes back to back in ONE
// macrotask (289 ms at 30 parallel espn-ff://status reads over stdio, against the tool twin's 30 ms).
// Deterministic here: a loop-turn counter shows which turn each slice ran in; no slice may share a
// turn. In process, fixture mode, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerPrompts } from "../../src/mcp/prompts/index.js";
import { readAsEnvelope } from "../../src/mcp/resources/index.js";
import type { McpServerOptions, ServerTexts } from "../../src/mcp/services.js";
import { makeWorld, type World } from "./helpers/world.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld({ league: "league-a" });
}, 60_000);
afterAll(() => {
  world.cleanup();
});

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

describe("resource reads take the turn gate (Stage C resources-prompts-bypass-turn-gate)", () => {
  it("N parallel reads: every body and every envelope build runs in a turn of its own", async () => {
    const turns = turnCounter();
    const events: { what: string; turn: number }[] = [];
    const N = 6;
    const reads = Array.from({ length: N }, (_, k) =>
      readAsEnvelope(`espn-ff://test/${String(k)}`, world.services, world.options, () => {
        events.push({ what: `body ${String(k)}`, turn: turns.now() });
        let seen = false;
        return Promise.resolve({
          // the envelope builder's first read of `data` marks the envelope build's turn
          get data(): unknown {
            if (!seen) {
              seen = true;
              events.push({ what: `envelope ${String(k)}`, turn: turns.now() });
            }
            return { k };
          },
          inputs: [],
        });
      }),
    );
    const out = await Promise.all(reads);
    turns.stop();
    expect(out).toHaveLength(N);
    expect(events).toHaveLength(2 * N);
    const byTurn = new Map<number, string[]>();
    for (const e of events) byTurn.set(e.turn, [...(byTurn.get(e.turn) ?? []), e.what]);
    // never two slices in one turn
    for (const [turn, what] of byTurn) expect(what, `turn ${String(turn)}`).toHaveLength(1);
    // each read's envelope comes after its body, in a later turn
    for (let k = 0; k < N; k++) {
      const b = events.find((e) => e.what === `body ${String(k)}`)?.turn ?? -1;
      const e = events.find((x) => x.what === `envelope ${String(k)}`)?.turn ?? -1;
      expect(e).toBeGreaterThan(b);
    }
  });

  it("N parallel prompts/get: each prompt's text is built in a turn of its own", async () => {
    const turns = turnCounter();
    const built: number[] = [];
    // the prompt text starts by reading the Skill body: that read marks the build's turn
    const skills = new Proxy({ weekly: "Weekly body." }, {
      get(t, prop, rec) {
        if (prop === "weekly") built.push(turns.now());
        return Reflect.get(t, prop, rec) as unknown;
      },
    });
    const texts = { ...world.options.texts, skills } as ServerTexts;
    const options: McpServerOptions = { ...world.options, texts };
    const handlers = new Map<string, (raw?: unknown) => Promise<unknown>>();
    const fake = {
      registerPrompt: (name: string, _cfg: unknown, cb: (raw?: unknown) => Promise<unknown>) => {
        handlers.set(name, cb);
      },
    } as unknown as McpServer;
    registerPrompts(fake, world.services, options);
    const weekly = handlers.get("espn.weekly");
    if (weekly === undefined) throw new Error("espn.weekly is not registered");
    const N = 6;
    await Promise.all(Array.from({ length: N }, () => weekly({})));
    turns.stop();
    // the first read of each build (its prompt text) — N builds, N distinct turns
    const firsts = built.slice(0, N);
    expect(firsts).toHaveLength(N);
    expect(new Set(firsts).size).toBe(N);
  });
});
