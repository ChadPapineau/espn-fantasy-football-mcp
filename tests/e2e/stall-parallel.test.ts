// stall-parallel.test.ts — the main-loop stall bound under PARALLEL analytics calls (plan 03 §1.2:
// "≤ 50 ms during any analytics call"; plan 10 A16a; ADV OBJ-07; Stage C finding
// analytics-parallel-calls-stall-loop). Claude issues tool calls in parallel, and the weekly and
// start-sit procedures run several analytics calls at once; the latency suite measures sequential
// calls only. Here the BUILT server over real stdio in fixture mode on fx-10h (the heartbeat preload
// inside the server process — tests/e2e/fixtures/heartbeat.cjs) answers N parallel
// espn_analyze_lineup (pwin) calls for N = 3, 6 and 10, and the realistic mix of a weekly turn, under
// both toolsets: the event loop's longest stall stays ≤ 50 ms, every call answers, and each answer
// equals the same call made alone. Before the fix each run's raw setImmediate let every in-flight
// call's slice share one check phase (72 ms at 6, 117 ms at 10 under core).
import { afterAll, describe, expect, it } from "vitest";
import {
  bodyOf,
  HEARTBEAT,
  logRecords,
  makeHome,
  requireDist,
  seedHome,
  serve,
  type E2eHome,
  type Served,
} from "./helpers.js";

const LINEUP = { week: 5, objective: "pwin", seed: 7 } as const;
const MIX: readonly [string, Record<string, unknown>][] = [
  ["espn_analyze_lineup", { week: 5, objective: "auto", seed: 1 }],
  ["espn_analyze_waivers", { mode: "auto", phase: "auto" }],
  ["espn_project_players", { players: { team_id: 2 }, horizon: "ros", seed: 3 }],
  ["espn_analyze_lineup", { week: 5, objective: "pwin", seed: 4 }],
];

async function heartbeat(s: Served): Promise<number> {
  const before = s.transport.stderr.length;
  s.transport.signal("SIGUSR2");
  const end = Date.now() + 5000;
  for (;;) {
    const rec = logRecords(s.transport.stderr.slice(before)).find(
      (l) => l.event === "e2e.heartbeat",
    );
    if (rec !== undefined) return rec.max_ms as number;
    if (Date.now() > end) throw new Error("no heartbeat line");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function callOk(
  s: Served,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await s.client.callTool({ name, arguments: args }, { timeout: 180_000 });
  const b = bodyOf(r);
  expect(r.isError, `${name}: ${JSON.stringify(b).slice(0, 300)}`).not.toBe(true);
  return b.data as Record<string, unknown>;
}

for (const toolset of ["core", "full"] as const) {
  describe(
    `parallel analytics calls under EFF_TOOLSET=${toolset} (fx-10h over real stdio)`,
    { timeout: 600_000 },
    () => {
      let home: E2eHome | null = null;
      let s: Served | null = null;
      afterAll(async () => {
        if (s !== null) await s.stop();
        home?.cleanup();
      });

      it("N parallel lineup (pwin) calls for N = 3, 6, 10 and a weekly turn's mix: the loop never stalls > 50 ms", async () => {
        requireDist();
        home = makeHome({ env: { EFF_TOOLSET: toolset } });
        if (toolset === "full") await seedHome(home);
        s = await serve(home, { preloads: [HEARTBEAT] });
        const served = s;
        // warm the caches (and the reference answer: the same call made alone)
        await callOk(served, "espn_get_league", {});
        await callOk(served, "espn_get_roster", { week: 5 });
        const alone = JSON.stringify((await callOk(served, "espn_analyze_lineup", LINEUP)).lineup);
        for (const [name, args] of MIX) await callOk(served, name, args);
        const report: Record<string, number> = {};
        for (const n of [3, 6, 10]) {
          await heartbeat(served); // a fresh window: only these calls are measured
          const answers = await Promise.all(
            Array.from({ length: n }, () => callOk(served, "espn_analyze_lineup", LINEUP)),
          );
          report[`n${String(n)}`] = Math.round((await heartbeat(served)) * 10) / 10;
          for (const a of answers) expect(JSON.stringify(a.lineup)).toBe(alone);
        }
        await heartbeat(served);
        await Promise.all(MIX.map(([name, args]) => callOk(served, name, args)));
        report.mix = Math.round((await heartbeat(served)) * 10) / 10;
        process.stdout.write(`parallel stall (${toolset}): ${JSON.stringify(report)}\n`);
        for (const [k, v] of Object.entries(report)) expect(v, k).toBeLessThanOrEqual(50);
      });
    },
  );
}
