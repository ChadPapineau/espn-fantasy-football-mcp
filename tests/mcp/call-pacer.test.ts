// call-pacer.test.ts — one tool call's cooperative pacer (src/mcp/call.ts):
//  - Stage C finding `analytics-cpu-deadline-per-run`: plan 07 E1 [A-7] / E3 set an 8 s CPU deadline
//    PER CALL, but each cooperative run started a fresh 8 s (E1 under full ran v1 then v2 on two
//    budgets; E3's season chain about seven). The call's batches are now summed and every run is
//    handed what the call has left (cpuDeadlineOf → remainingDeadline), deadline-less set-up runs
//    included in the sum;
//  - Stage C finding `mcp-request-extra-dropped`: the tool handler dropped the SDK's request
//    context, so a request with a progressToken got no notifications/progress (plan 03 §1.2) and a
//    cancelled call ran to completion with its store writes (MCP cancellation: SHOULD stop). The
//    pacer now notifies progress at its yields (≤ one per PROGRESS_INTERVAL_MS) and stops a
//    cancelled call at its next batch boundary, before any side effect; its ESPN budget aborts too.
// The unit tests drive the REAL runner (runCooperative) through the call pacer on a fake CPU clock
// (deterministic); the tool tests run real calls in process over the recorded fixtures.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCooperative, type Pacer } from "../../src/domain/analytics/index.js";
import {
  CallCancelled,
  PROGRESS_INTERVAL_MS,
  callPacer,
  controlsFromRequest,
  remainingDeadline,
} from "../../src/mcp/call.js";
import type { ToolContext } from "../../src/mcp/define.js";
import { cpuDeadlineOf } from "../../src/mcp/tools/analytics.js";
import { TEST_CALL_TIMEOUT_MS, call, connect, makeWorld, type World } from "./helpers/world.js";

/** A base pacer on a fake clock: every step advances CPU and wall time by `stepMs`. */
function fakeBase(): { base: Pacer; tick: (ms: number) => void } {
  let t = 0;
  return {
    base: {
      nowMs: () => t,
      cpuMs: () => t,
      yieldToLoop: () => Promise.resolve(),
    },
    tick: (ms) => {
      t += ms;
    },
  };
}

describe("the CPU deadline is one budget per call (plan 07 E1 [A-7], E3)", () => {
  it("runs share it: a later run gets only what the earlier ones left, set-up runs counted", async () => {
    const { base, tick } = fakeBase();
    const pacer = callPacer(base);
    const D = 50;
    // run A (like E1's v1 sampling): 30 steps of 1 ms inside a 50 ms deadline — completes
    const a = await runCooperative(
      30,
      () => {
        tick(1);
      },
      {
        pacer,
        batchMs: 5,
        deadlineMs: remainingDeadline(D, pacer.spentMs()),
      },
    );
    expect(a.partial).toBe(false);
    // run B (a deadline-less set-up run, like projection.ts's): 10 steps — never stopped, counted
    const b = await runCooperative(
      10,
      () => {
        tick(1);
      },
      { pacer, batchMs: 5, deadlineMs: null },
    );
    expect(b.partial).toBe(false);
    expect(pacer.spentMs()).toBe(40);
    // run C (like v2's sampling): 30 steps — handed 10 ms, so it stops partial near 10 steps; a
    // fresh per-run 50 ms (the defect) would have completed all 30
    const remaining = remainingDeadline(D, pacer.spentMs());
    expect(remaining).toBe(10);
    const c = await runCooperative(
      30,
      () => {
        tick(1);
      },
      { pacer, batchMs: 5, deadlineMs: remaining },
    );
    expect(c.partial).toBe(true);
    expect(c.completed).toBeLessThan(30);
    expect(c.completed).toBeGreaterThanOrEqual(10);
    expect(pacer.spentMs()).toBeLessThanOrEqual(D + 5);
  });

  it("a run handed 0 does one batch and reports partial", async () => {
    const { base, tick } = fakeBase();
    const pacer = callPacer(base);
    const r = await runCooperative(
      100,
      () => {
        tick(1);
      },
      { pacer, batchMs: 5, deadlineMs: 0 },
    );
    expect(r.partial).toBe(true);
    expect(r.completed).toBeLessThanOrEqual(5);
  });

  it("cpuDeadlineOf hands a run the call's remainder (null = the test switch off)", () => {
    const ctx = (deadline: number | null | undefined, spent: number): ToolContext =>
      ({
        options: deadline === undefined ? {} : { cpuDeadlineMs: deadline },
        pacer: { spentMs: () => spent },
      }) as unknown as ToolContext;
    expect(cpuDeadlineOf(ctx(undefined, 0))).toBe(8000);
    expect(cpuDeadlineOf(ctx(undefined, 3000))).toBe(5000);
    expect(cpuDeadlineOf(ctx(undefined, 9000))).toBe(0);
    expect(cpuDeadlineOf(ctx(100, 40))).toBe(60);
    expect(cpuDeadlineOf(ctx(null, 9000))).toBeNull();
  });

  it("an unpaired CPU read never counts across a yield", async () => {
    const { base, tick } = fakeBase();
    const pacer = callPacer(base);
    pacer.cpuMs(); // a start read …
    tick(100); // … then time outside any batch
    await pacer.yieldToLoop(); // the yield drops the unpaired start
    pacer.cpuMs();
    tick(2);
    pacer.cpuMs();
    expect(pacer.spentMs()).toBe(2);
  });
});

describe("cancellation stops a call at its next batch boundary", () => {
  it("the runner rejects with CallCancelled at the next yield; later steps never run", async () => {
    const { base, tick } = fakeBase();
    const ac = new AbortController();
    const pacer = callPacer(base, { signal: ac.signal });
    let ran = 0;
    const p = runCooperative(
      1000,
      (i) => {
        ran = i + 1;
        tick(1);
        if (i === 7) ac.abort();
      },
      { pacer, batchMs: 5, deadlineMs: null },
    );
    await expect(p).rejects.toBeInstanceOf(CallCancelled);
    expect(ran).toBeLessThan(20);
    expect(pacer.cancelled()).toBe(true);
    expect(() => {
      pacer.throwIfCancelled();
    }).toThrow(CallCancelled);
  });
});

describe("progress notifications", () => {
  it("one at the first yield, then at most one per interval, strictly increasing", async () => {
    const { base } = fakeBase();
    let wall = 0;
    const sent: number[] = [];
    const pacer = callPacer(base, { progress: (n) => sent.push(n) }, () => wall);
    await pacer.yieldToLoop();
    expect(sent).toEqual([1]);
    wall += PROGRESS_INTERVAL_MS - 1;
    await pacer.yieldToLoop();
    expect(sent).toEqual([1]);
    wall += 1;
    await pacer.yieldToLoop();
    wall += 10 * PROGRESS_INTERVAL_MS;
    await pacer.yieldToLoop();
    expect(sent).toEqual([1, 2, 3]);
  });

  it("a progress sender that throws never fails the call", async () => {
    const { base } = fakeBase();
    const pacer = callPacer(base, {
      progress: () => {
        throw new Error("transport closed");
      },
    });
    await expect(pacer.yieldToLoop()).resolves.toBeUndefined();
  });

  it("controlsFromRequest binds the progressToken and the signal; anything else is no control", async () => {
    const notes: unknown[] = [];
    const ac = new AbortController();
    const c = controlsFromRequest({
      mcpReq: {
        signal: ac.signal,
        _meta: { progressToken: "tok-1" },
        notify: (n: unknown) => {
          notes.push(n);
          return Promise.resolve();
        },
      },
    });
    expect(c.signal).toBe(ac.signal);
    c.progress?.(3);
    expect(notes).toEqual([
      { method: "notifications/progress", params: { progressToken: "tok-1", progress: 3 } },
    ]);
    // a numeric token; a rejecting notifier is swallowed
    const n2 = controlsFromRequest({
      mcpReq: { _meta: { progressToken: 7 }, notify: () => Promise.reject(new Error("x")) },
    });
    expect(() => n2.progress?.(1)).not.toThrow();
    // no token → no progress; odd shapes → no controls
    expect(controlsFromRequest({ mcpReq: { notify: () => undefined } }).progress).toBeUndefined();
    for (const x of [undefined, null, 1, "s", {}, { mcpReq: null }, { mcpReq: { signal: {} } }])
      expect(controlsFromRequest(x)).toEqual({});
    await Promise.resolve();
  });
});

// --- real calls ----------------------------------------------------------------------------------------

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
  ({ client, close } = await connect(world));
  for (const [name, args] of [
    ["espn_get_league", {}],
    ["espn_get_roster", { week: 4 }],
  ] as const)
    expect((await call(client, name, args)).isError, name).toBe(false);
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

const E1 = { players: { team_id: 1 }, horizon: "ros", week: 4, n_sims: 4000, seed: 11 };

describe("the request context reaches the call (plan 03 §1.2; MCP cancellation)", () => {
  it.each(["legacy", "modern"] as const)(
    "a request with a progressToken gets notifications/progress during an analytics call (%s era)",
    async (era) => {
      const c =
        era === "legacy"
          ? { client, close: () => Promise.resolve() }
          : await connect(world, { modern: true });
      const seen: number[] = [];
      const r = await c.client.callTool(
        { name: "espn_project_players", arguments: E1 },
        {
          timeout: TEST_CALL_TIMEOUT_MS,
          onprogress: (p) => {
            seen.push(p.progress);
          },
        },
      );
      await c.close();
      expect((r as { isError?: boolean }).isError).not.toBe(true);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1] ?? 0);
    },
  );

  it("a cancelled call stops, is logged tool.cancelled, and stores no projection", async () => {
    let puts = 0;
    const projections = world.services.projections;
    const counted = new Proxy(projections, {
      get(t, prop, rec) {
        const v: unknown = Reflect.get(t, prop, rec);
        if (prop === "put" && typeof v === "function")
          return (...a: unknown[]) => {
            puts += 1;
            return (v as (...x: unknown[]) => unknown).apply(t, a);
          };
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const c = await connect(world, { services: { projections: counted } });
    const ac = new AbortController();
    const before = world.logLines.length;
    const p = c.client.callTool(
      { name: "espn_project_players", arguments: { ...E1, seed: 13 } },
      { timeout: TEST_CALL_TIMEOUT_MS, signal: ac.signal },
    );
    // cancel as soon as the call has started (its first cooperative yield)
    for (
      let i = 0;
      i < 200 && !world.logLines.slice(before).some((l) => l.includes("tool.start"));
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toThrow();
    // the server stops at its next batch boundary and says so
    for (let i = 0; i < 400; i++) {
      if (world.logLines.slice(before).some((l) => l.includes("tool.cancelled"))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const logs = world.logLines.slice(before);
    expect(logs.some((l) => l.includes("tool.cancelled"))).toBe(true);
    expect(logs.some((l) => l.includes('"tool.end"'))).toBe(false);
    expect(logs.some((l) => l.includes('"tool.error"'))).toBe(false);
    expect(puts).toBe(0);
    await c.close();
  });

  it("tool.end carries the call's cooperative CPU", async () => {
    const before = world.logLines.length;
    expect((await call(client, "espn_project_players", { ...E1, seed: 14 })).isError).toBe(false);
    const end = world.logLines.slice(before).find((l) => l.includes("tool.end"));
    expect(end).toBeDefined();
    const rec = JSON.parse(end ?? "{}") as { cpu_ms?: unknown };
    expect(typeof rec.cpu_ms).toBe("number");
  });
});
