// stall-parallel.test.ts — the main-loop stall bound under PARALLEL analytics calls (plan 03 §1.2:
// "≤ 50 ms during any analytics call"; plan 10 A16a; ADV OBJ-07; Stage C finding
// analytics-parallel-calls-stall-loop). Claude issues tool calls in parallel, and the weekly and
// start-sit procedures run several analytics calls at once; the latency suite measures sequential
// calls only. Here the BUILT server over real stdio in fixture mode on fx-10h (the heartbeat preload
// inside the server process — tests/e2e/fixtures/heartbeat.cjs) answers N parallel
// espn_analyze_lineup (pwin) calls for N = 3, 6 and 10, and the realistic mix of a weekly turn, under
// both toolsets: the event loop's longest stall stays ≤ 50 ms, every call answers, and each answer
// equals the same call made alone. Before the fix each run's raw setImmediate let every in-flight
// call's slice share one check phase (72 ms at 6, 117 ms at 10 under core). A window over the bound
// is repeated only on the host's evidence (helpers.ts measureStall, ruling R8-2); the report prints
// each window's control, the server's own longest run on the CPU, and every repeated window's
// evidence.
import { afterAll, describe, expect, it } from "vitest";
import {
  bodyOf,
  HEARTBEAT,
  heartbeatOf,
  makeHome,
  measureStall,
  requireDist,
  seedHome,
  serve,
  StallControl,
  type E2eHome,
  type Served,
  type StallWindow,
} from "./helpers.js";

const LINEUP = { week: 5, objective: "pwin", seed: 7 } as const;
const MIX: readonly [string, Record<string, unknown>][] = [
  ["espn_analyze_lineup", { week: 5, objective: "auto", seed: 1 }],
  ["espn_analyze_waivers", { mode: "auto", phase: "auto" }],
  ["espn_project_players", { players: { team_id: 2 }, horizon: "ros", seed: 3 }],
  ["espn_analyze_lineup", { week: 5, objective: "pwin", seed: 4 }],
];

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
      let control: StallControl | null = null;
      afterAll(async () => {
        control?.stop();
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
        // the host control (helpers.ts StallControl): a window over the bound while an idle
        // process beside the server stalled too measured the host's preemption, and is repeated
        control = await StallControl.start();
        const ctl = control;
        await heartbeatOf(served.transport);
        const windows: Record<string, StallWindow> = {};
        for (const n of [3, 6, 10]) {
          windows[`n${String(n)}`] = await measureStall(
            served.transport,
            ctl,
            async () => {
              const answers = await Promise.all(
                Array.from({ length: n }, () => callOk(served, "espn_analyze_lineup", LINEUP)),
              );
              for (const a of answers) expect(JSON.stringify(a.lineup)).toBe(alone);
            },
            50,
          );
        }
        windows.mix = await measureStall(
          served.transport,
          ctl,
          async () => {
            await Promise.all(MIX.map(([name, args]) => callOk(served, name, args)));
          },
          50,
        );
        // the report: each stall, the control's, the server's own longest run on the CPU (the
        // evidence the verdict rests on) and the windows taken
        const each = (f: (w: StallWindow) => number) =>
          JSON.stringify(
            Object.fromEntries(
              Object.entries(windows).map(([k, w]) => [k, Math.round(f(w) * 10) / 10]),
            ),
          );
        process.stdout.write(
          `parallel stall (${toolset}): ${each((w) => w.stall_ms)} control ${each((w) => w.control_ms)} own CPU ${each((w) => w.server.cpu_max_ms)} windows ${each((w) => w.attempts)}\n`,
        );
        // every window repeated on the host's evidence, with that evidence
        for (const [k, w] of Object.entries(windows))
          for (const r of w.repeated)
            process.stdout.write(
              `parallel stall (${toolset}) ${k} repeated: ${JSON.stringify({ ...r.server, control_ms: r.control_ms })}\n`,
            );
        // the bound on the stall as measured, never on the report's rounding (R8-2: unchanged)
        for (const [k, w] of Object.entries(windows)) expect(w.stall_ms, k).toBeLessThanOrEqual(50);
      });
    },
  );
}
