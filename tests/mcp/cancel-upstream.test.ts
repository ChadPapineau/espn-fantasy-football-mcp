// cancel-upstream.test.ts — a call the client cancels while it waits on an ESPN read is a
// cancellation, not an error (MCP cancellation; define.ts "a cancelled call is not an error"). Stage C
// finding mcp-cancel-abort-logged-error: the cancel aborts the call's upstream budget, so the pending
// read rejects with an AbortError (the limiter's sleep) or an upstream error (the aborted fetch), and
// runTool recognised only CallCancelled — the call was logged `tool.error` at warn and never
// `tool.cancelled`. Through the real composition root in fixture mode with a fetch that hangs until
// its signal aborts; no network, no cookie.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_CALL_TIMEOUT_MS, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let hanging = 0;

beforeAll(async () => {
  world = await makeWorld({
    league: "league-a",
    // every ESPN request waits until the call's signal aborts (the client's cancel), then rejects
    // the way an aborted fetch does
    wrapFetch: () => (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        hanging += 1;
        const signal = init.signal;
        const fail = (): void => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        };
        if (signal === undefined || signal === null) return;
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      }),
  });
}, 60_000);

afterAll(() => {
  world.cleanup();
});

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("a cancel during an ESPN read (Stage C mcp-cancel-abort-logged-error)", () => {
  it("is logged tool.cancelled at info, never tool.error, and no reply is sent", async () => {
    const c = await connect(world);
    const before = world.logLines.length;
    const startedReads = hanging;
    const ac = new AbortController();
    const p = c.client.callTool(
      { name: "espn_get_league", arguments: {} },
      { timeout: TEST_CALL_TIMEOUT_MS, signal: ac.signal },
    );
    // cancel once the call is waiting on ESPN
    await until(() => hanging > startedReads);
    ac.abort();
    await expect(p).rejects.toThrow();
    await until(() => world.logLines.slice(before).some((l) => l.includes('"tool.cancelled"')));
    const logs = world.logLines.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
    const cancelled = logs.filter((l) => l.event === "tool.cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ level: "info", tool: "espn_get_league" });
    expect(logs.filter((l) => l.event === "tool.error")).toEqual([]);
    expect(logs.filter((l) => l.event === "tool.end")).toEqual([]);
    await c.close();
  }, 60_000);
});
