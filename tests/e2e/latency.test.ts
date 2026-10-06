// latency.test.ts — the latency bounds of plan 10 A16a / A15a, each naming its dataset and test
// (plan 05 §0): the BUILT server over real stdio in fixture mode on fx-10h. Startup (spawn to a
// completed handshake) < 1 s with no network and no keychain; on a warm cache every P0 tool answers
// in < 500 ms (round trip, client side); espn_project_players for 32 players at n_sims 4000 < 3 s;
// the analytics that run the seeding simulator (E2's exchange rate, E5's P(alive)) < 5 s; and the
// server's main loop never stalls more than 50 ms during any analytics call (an event-loop delay
// probe inside the server process — tests/e2e/fixtures/heartbeat.cjs; ADV OBJ-07). The measured
// numbers are printed for the report.
import { afterAll, describe, expect, it } from "vitest";
import {
  bodyOf,
  HEARTBEAT,
  logRecords,
  makeHome,
  requireDist,
  serve,
  type Served,
} from "./helpers.js";

const P0_CALLS: readonly [string, Record<string, unknown>][] = [
  ["espn_get_league", {}],
  ["espn_get_standings", {}],
  ["espn_get_scoreboard", { week: 4 }],
  ["espn_get_live_scoreboard", {}],
  ["espn_get_box_score", { week: 4, team_id: 2 }],
  ["espn_list_transactions", { count: 40 }],
  ["espn_get_roster", { week: 5 }],
  ["espn_search_players", { query: "Robinson" }],
  ["espn_list_players", { status: "WAIVERS", sort: "percOwned", week: 5, limit: 25 }],
  ["espn_get_injuries", { players: { team_id: 2 } }],
  ["espn_get_schedule", { weeks: [5, 6] }],
  ["espn_project_players", { players: { team_id: 2 }, horizon: "week", week: 5, seed: 1 }],
  ["espn_analyze_lineup", { week: 5, objective: "auto" }],
  ["espn_analyze_waivers", { mode: "auto", phase: "auto" }],
  ["espn_analyze_retrospective", { week: 4 }],
  ["espn_get_status", {}],
];
const ANALYTICS = new Set([
  "espn_project_players",
  "espn_analyze_lineup",
  "espn_analyze_waivers",
  "espn_analyze_retrospective",
]);

const home = makeHome();
let s: Served | null = null;
afterAll(async () => {
  if (s !== null) await s.stop();
  home.cleanup();
});

async function timed(name: string, args: Record<string, unknown>): Promise<number> {
  if (s === null) throw new Error("not served");
  const t0 = performance.now();
  const r = await s.client.callTool({ name, arguments: args });
  const ms = performance.now() - t0;
  expect(r.isError, `${name}: ${JSON.stringify(bodyOf(r)).slice(0, 300)}`).not.toBe(true);
  return ms;
}

/** The stall probe's window maximum (ms) since the previous call. */
async function heartbeat(): Promise<number> {
  if (s === null) throw new Error("not served");
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

describe("latency on fx-10h over real stdio (A15a, A16a)", { timeout: 300_000 }, () => {
  const report: Record<string, number> = {};

  it("startup: spawn to a completed handshake in < 1 s (no network, no keychain)", async () => {
    requireDist();
    s = await serve(home, { preloads: [HEARTBEAT] });
    report.startup_ms = Math.round(s.connectMs);
    expect(s.connectMs).toBeLessThan(1000);
  });

  it("warm cache: every P0 tool answers in < 500 ms", async () => {
    // espn_check_auth answers at most once a minute (plan 02 §2.1): timed once, never repeated
    report.espn_check_auth_ms = Math.round(await timed("espn_check_auth", {}));
    expect(report.espn_check_auth_ms).toBeLessThan(500);
    for (const [name, args] of P0_CALLS) await timed(name, args); // cold: fills the cache
    const slow: string[] = [];
    for (const [name, args] of P0_CALLS) {
      const ms = await timed(name, args);
      report[`warm_${name}`] = Math.round(ms);
      if (ms >= 500) slow.push(`${name} ${String(Math.round(ms))} ms`);
    }
    expect(slow).toEqual([]);
  });

  it("E1 for 32 players at n_sims 4000 < 3 s; E2 and E5 (the seeding simulator inside) < 5 s; loop stall ≤ 50 ms", async () => {
    await heartbeat(); // start a fresh window: only the analytics calls below are measured
    const e1 = await timed("espn_project_players", {
      players: { pool: { status: "WAIVERS", position: "FLEX", top: 32 } },
      horizon: "week",
      week: 5,
      n_sims: 4000,
      seed: 2,
    });
    const e2 = await timed("espn_analyze_lineup", { week: 5, objective: "auto" });
    const e5 = await timed("espn_analyze_waivers", { mode: "auto", phase: "auto" });
    const stall = await heartbeat();
    Object.assign(report, {
      e1_32_players_4000_ms: Math.round(e1),
      e2_ms: Math.round(e2),
      e5_ms: Math.round(e5),
      max_loop_stall_ms: Math.round(stall * 10) / 10,
    });
    process.stdout.write(`latency report: ${JSON.stringify(report)}\n`);
    expect(e1).toBeLessThan(3000);
    expect(e2).toBeLessThan(5000);
    expect(e5).toBeLessThan(5000);
    expect(stall).toBeLessThanOrEqual(50);
    for (const k of Object.keys(report))
      if (k.startsWith("warm_") && ANALYTICS.has(k.slice(5))) expect(report[k]).toBeLessThan(500);
  });
});
