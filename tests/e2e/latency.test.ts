// latency.test.ts — the latency bounds of plan 10 A16a / A15a, each naming its dataset and test
// (plan 05 §0): the BUILT server over real stdio in fixture mode on fx-10h. Startup (spawn to a
// completed handshake) < 1 s with no network and no keychain; on a warm cache every P0 tool answers
// in < 500 ms (round trip, client side; all 18, the journal write included); espn_project_players
// for 32 players at n_sims 4000 < 3 s; the analytics that run the seeding simulator (E2's exchange
// rate, E5's P(alive)) < 5 s; and the server's main loop never stalls more than 50 ms during any
// analytics call (an event-loop delay probe inside the server process —
// tests/e2e/fixtures/heartbeat.cjs; ADV OBJ-07). Under EFF_TOOLSET=full on a seeded cache the same
// rules carry to the P1 tools: every P1 read tool warm < 500 ms, every P1 analytics call inside the
// 8 s per-call deadline with the loop stall ≤ 50 ms. The measured numbers are printed for the report.
import { afterAll, describe, expect, it } from "vitest";
import {
  bodyOf,
  HEARTBEAT,
  logRecords,
  makeHome,
  requireDist,
  seedHome,
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
    // espn_record_recommendation (the 18th P0 tool) writes the journal: each call is a real write
    // under a fresh client_ref (an equal one would be the dedup path), recording the lineup call
    // just made — so it is timed with its own cold/warm pair, never in the read loop above
    const lineup = bodyOf(
      await s?.client.callTool({
        name: "espn_analyze_lineup",
        arguments: { week: 5, objective: "auto" },
      }),
    );
    const league = bodyOf(await s?.client.callTool({ name: "espn_get_league", arguments: {} }));
    const record = (ref: string): Record<string, unknown> => ({
      kind: "lineup",
      week: 5,
      rec: (lineup.data as Record<string, unknown>).rec,
      source_calls: [
        {
          tool: "espn_analyze_lineup",
          request_id: (lineup.meta as Record<string, unknown>).request_id,
        },
      ],
      settings_hash: ((league.data as Record<string, unknown>).scoring as Record<string, unknown>)
        .settings_hash,
      followed_hint: "unknown",
      client_ref: ref,
    });
    await timed("espn_record_recommendation", record("latency-cold"));
    const rec = await timed("espn_record_recommendation", record("latency-warm"));
    report.warm_espn_record_recommendation = Math.round(rec);
    if (rec >= 500) slow.push(`espn_record_recommendation ${String(Math.round(rec))} ms`);
    expect(slow).toEqual([]);
    // all 18 P0 tools were timed warm (espn_check_auth once, by its once-a-minute rule)
    const timedTools = new Set([
      "espn_check_auth",
      ...Object.keys(report)
        .filter((k) => k.startsWith("warm_"))
        .map((k) => k.slice(5)),
    ]);
    expect(timedTools.size).toBe(18);
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

// --- EFF_TOOLSET=full: the 16 P1 tools on a seeded cache (A16a's rules carried to plan 10 §3.2) -------

/** The P1 read tools (facts and dataset reads): A16a's warm < 500 ms rule. */
const P1_READS: readonly [string, Record<string, unknown>][] = [
  ["espn_get_player_stats", { players: { team_id: 2 }, type: "week", week: 4 }],
  ["espn_get_projections", { players: { team_id: 2 }, horizon: "ros" }],
  ["espn_get_player_outlook", { players: { team_id: 2 } }],
  ["espn_get_player_usage", { players: { team_id: 2 }, window: 3 }],
  ["espn_get_depth_chart", { nfl_team: "DET" }],
  ["espn_get_defense_profile", { nfl_team: "DET" }],
  ["espn_get_news", { since_hours: 168, limit: 20 }],
  ["espn_list_recommendations", {}],
];
/** The P1 analytics: under the 8 s per-call deadline, the main loop never stalled > 50 ms. */
const P1_ANALYTICS: readonly [string, Record<string, unknown>][] = [
  ["espn_analyze_matchup", { week: 5, mode: "pre", seed: 1 }],
  ["espn_analyze_matchup", { mode: "season", seed: 4 }],
  ["espn_analyze_replacement", {}],
  ["espn_analyze_trade", { find_partners: { need_position: "WR" }, seed: 2 }],
  ["espn_analyze_injury_cascade", { player: { gsis_ids: ["00-0037248"] } }],
  ["espn_analyze_schedule", {}],
  ["espn_analyze_roster", { seed: 3 }],
  ["espn_analyze_evidence", { player: { gsis_ids: ["00-0037248"] } }],
  ["espn_analyze_league_activity", {}],
  ["espn_analyze_waivers", { mode: "auto", phase: "auto" }],
];

describe(
  "latency under EFF_TOOLSET=full on a seeded fx-10h over real stdio (A16a carried to the P1 tools)",
  { timeout: 600_000 },
  () => {
    const homeFull = makeHome({ env: { EFF_TOOLSET: "full" } });
    let f: Served | null = null;
    afterAll(async () => {
      if (f !== null) await f.stop();
      homeFull.cleanup();
    });
    const report: Record<string, number> = {};

    let lastWarnings: string[] = [];
    async function timedFull(name: string, args: Record<string, unknown>): Promise<number> {
      if (f === null) throw new Error("not served");
      const t0 = performance.now();
      const r = await f.client.callTool({ name, arguments: args }, { timeout: 120_000 });
      const ms = performance.now() - t0;
      const b = bodyOf(r);
      expect(r.isError, `${name}: ${JSON.stringify(b).slice(0, 300)}`).not.toBe(true);
      lastWarnings = (b.warnings as string[] | undefined) ?? [];
      return ms;
    }
    async function heartbeatFull(): Promise<number> {
      if (f === null) throw new Error("not served");
      const before = f.transport.stderr.length;
      f.transport.signal("SIGUSR2");
      const end = Date.now() + 5000;
      for (;;) {
        const rec = logRecords(f.transport.stderr.slice(before)).find(
          (l) => l.event === "e2e.heartbeat",
        );
        if (rec !== undefined) return rec.max_ms as number;
        if (Date.now() > end) throw new Error("no heartbeat line");
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    it("startup < 1 s; every P1 read tool warm < 500 ms", async () => {
      requireDist();
      await seedHome(homeFull);
      f = await serve(homeFull, { preloads: [HEARTBEAT] });
      report.startup_ms = Math.round(f.connectMs);
      expect(f.connectMs).toBeLessThan(1000);
      await timedFull("espn_get_league", {});
      await timedFull("espn_get_roster", { week: 5 });
      for (const [name, args] of P1_READS) await timedFull(name, args); // cold
      const slow: string[] = [];
      for (const [name, args] of P1_READS) {
        const ms = await timedFull(name, args);
        // fx-10h records no mPositionalRatings / kona_playercard: a tool's OPTIONAL comparator read of
        // those views goes upstream on every call (the fixture refuses it, the tool degrades and says
        // so) and waits on the per-second ESPN limiter — not a warm call. Production caches the views
        // for a day. Such a call is held to the limiter window instead, and must name the view.
        const upstream = lastWarnings.find((w) =>
          /^espn:(mPositionalRatings|kona_playercard) unavailable/.test(w),
        );
        if (upstream !== undefined) {
          report[`upstream_${name}`] = Math.round(ms);
          if (ms >= 2000) slow.push(`${name} ${String(Math.round(ms))} ms (${upstream})`);
          continue;
        }
        report[`warm_${name}`] = Math.round(ms);
        if (ms >= 500) slow.push(`${name} ${String(Math.round(ms))} ms`);
      }
      expect(slow).toEqual([]);
      // the dataset reads never went upstream
      for (const n of ["espn_get_player_usage", "espn_get_depth_chart", "espn_get_news"])
        expect(report[`warm_${n}`], n).toBeLessThan(500);
    });

    it("every P1 analytics call < 8 s (the per-call deadline); the main loop never stalls > 50 ms", async () => {
      await heartbeatFull();
      const slow: string[] = [];
      for (const [name, args] of P1_ANALYTICS) {
        const ms = await timedFull(name, args);
        const key = `${name}${typeof args.mode === "string" ? `_${args.mode}` : ""}`;
        report[key] = Math.round(ms);
        if (ms >= 8000) slow.push(`${key} ${String(Math.round(ms))} ms`);
      }
      const stall = await heartbeatFull();
      report.max_loop_stall_ms = Math.round(stall * 10) / 10;
      process.stdout.write(`latency report (full): ${JSON.stringify(report)}\n`);
      expect(slow).toEqual([]);
      expect(stall).toBeLessThanOrEqual(50);
    });
  },
);
