// cpu-deadline.test.ts — the samplers' CPU-deadline switch, usable only by tests (changelog R5;
// plan 10 A8a: the injection-invariance run disables the deadline so byte-equality cannot flake;
// plan 07 E1 [A-7]: in production the deadline is 8 s and a call past it is `partial: true`).
// The switch is McpServerOptions.cpuDeadlineMs: omitted = ANALYTICS_CPU_DEADLINE_MS, null = off, a
// number = that deadline. The tools honour it (a 0 ms deadline stops E1 after its first sample,
// both through espn_project_players and through E2's projection); a season run inside a tool (E2,
// E6, E8, E9) cut short by it names its completed paths and sets `partial`; the deadline counts the
// thread's CPU, so wall time the process did not run (a sleeping machine) never fires it; the
// composition root sets it to null only under EFF_TEST_STUBS=1 in fixture mode — both test-scope
// keys — and logs that it did.
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/cli/log.js";
import { loadConfig } from "../../src/config/schema.js";
import { ANALYTICS_CPU_DEADLINE_MS } from "../../src/mcp/bounds.js";
import { buildServices } from "../../src/services/index.js";
import { call, connect, ESPN_FIXTURES, makeWorld, ROOT, type World } from "./helpers/world.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld({});
}, 120_000);
afterAll(() => {
  world.cleanup();
});

interface Env {
  data: Record<string, unknown>;
  partial: boolean;
  warnings: string[];
}
async function run(c: Client, name: string, args: Record<string, unknown>): Promise<Env> {
  const r = await call(c, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
  return r.body as unknown as Env;
}
const E1 = { players: { team_id: 1 }, horizon: "week", week: 4, n_sims: 4000, seed: 7 };
/** Drops the per-call bookkeeping (ids, ages, fetch instants) — not answers. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (!["request_id", "age_s", "fetched_at", "as_of", "latest_execution_time"].includes(k))
      out[k] = stable(x);
  return out;
}
const deadlineWarning = (e: Env): string[] =>
  e.warnings.filter((w) => /^partial: \d+ of \d+ samples before the CPU deadline$/.test(w));
/** The seeding simulator's line: a season run inside a tool stopped at the deadline. */
const seasonWarning = (e: Env): string[] =>
  e.warnings.filter((w) => /^partial: \d+ of \d+ paths before the CPU deadline$/.test(w));

describe("the tools honour the injected switch", () => {
  it("omitted: the production 8 s deadline — a 4 000-sample call completes", async () => {
    expect(world.options.cpuDeadlineMs).toBeUndefined();
    expect(ANALYTICS_CPU_DEADLINE_MS).toBe(8000);
    const { client, close } = await connect(world);
    const e = await run(client, "espn_project_players", E1);
    expect(e.partial).toBe(false);
    expect(deadlineWarning(e)).toEqual([]);
    await close();
  });

  it("0 ms: E1 stops after its first sample — partial: true, the completed count named", async () => {
    const { client, close } = await connect(world, { options: { cpuDeadlineMs: 0 } });
    const e = await run(client, "espn_project_players", E1);
    expect(e.partial).toBe(true);
    expect(deadlineWarning(e)).toEqual(["partial: 1 of 4000 samples before the CPU deadline"]);
    // E2 runs E1 for both rosters through the same switch
    const l = await run(client, "espn_analyze_lineup", { week: 4, seed: 7 });
    expect(l.partial).toBe(true);
    expect(deadlineWarning(l).length).toBe(1);
    await close();
  });

  it("null: the deadline is off — the same answer as the production deadline, never partial", async () => {
    const prod = await connect(world);
    const off = await connect(world, { options: { cpuDeadlineMs: null } });
    for (const [name, args] of [
      ["espn_project_players", E1],
      ["espn_analyze_lineup", { week: 4, seed: 7 }],
    ] as const) {
      const a = await run(prod.client, name, args);
      const b = await run(off.client, name, args);
      expect(b.partial).toBe(false);
      expect(deadlineWarning(b)).toEqual([]);
      expect(seasonWarning(b)).toEqual([]);
      // the deadline counts CPU, never wall time: it never fires on fx-10h, so it is not partial and
      // switching it off changes no number (a run cut short would say so — the describe below)
      expect(a.partial, name).toBe(false);
      expect([...deadlineWarning(a), ...seasonWarning(a)], name).toEqual([]);
      expect(stable(b.data)).toEqual(stable(a.data));
    }
    await prod.close();
    await off.close();
  });
});

describe("a season run cut short inside a tool is said: warning + partial (plan 07 E1 [A-7])", () => {
  // every tool that runs the seeding simulator for a number it reports — E2's PF exchange rate, E6's
  // ΔU, E8's P(alive), E9's season read — carries the run's "paths" line and its flag
  async function rosters(c: Client): Promise<{ give: number[]; get: number[] }> {
    type P = { player_id: number; slot: string }[];
    const mine = (await run(c, "espn_get_roster", { week: 4 })).data.players as P;
    const theirs = (await run(c, "espn_get_roster", { week: 4, team_id: 2 })).data.players as P;
    return {
      give: mine
        .filter((p) => p.slot !== "IR")
        .slice(0, 1)
        .map((p) => p.player_id),
      get: theirs
        .filter((p) => p.slot !== "IR")
        .slice(0, 1)
        .map((p) => p.player_id),
    };
  }
  const calls = (o: { give: number[]; get: number[] }) =>
    [
      ["espn_analyze_lineup", { week: 4, seed: 7 }],
      ["espn_analyze_trade", { offer: { partner_team_id: 2, ...o }, seed: 4 }],
      ["espn_analyze_schedule", { seed: 2 }],
      ["espn_analyze_roster", { seed: 2 }],
    ] as const;

  it("0 ms: every season-backed number names the completed path count and sets partial", async () => {
    const { client, close } = await connect(world, {
      options: { toolset: "full", cpuDeadlineMs: 0 },
    });
    for (const [name, args] of calls(await rosters(client))) {
      const e = await run(client, name, args);
      expect(seasonWarning(e), name).toHaveLength(1);
      expect(seasonWarning(e)[0], name).toMatch(/^partial: 1 of \d+ paths/);
      expect(e.partial, name).toBe(true);
    }
    await close();
  }, 120_000);

  it("off: the same calls run every path — no line, not partial", async () => {
    const { client, close } = await connect(world, {
      options: { toolset: "full", cpuDeadlineMs: null },
    });
    for (const [name, args] of calls(await rosters(client))) {
      const e = await run(client, name, args);
      expect(seasonWarning(e), name).toEqual([]);
      expect(e.partial, name).toBe(false);
    }
    await close();
  }, 120_000);

  it("E6: ΔU from the one path the 0 ms run completed is flagged, never passed off as complete", async () => {
    const zero = await connect(world, { options: { toolset: "full", cpuDeadlineMs: 0 } });
    const off = await connect(world, { options: { toolset: "full", cpuDeadlineMs: null } });
    const args = { offer: { partner_team_id: 2, ...(await rosters(off.client)) }, seed: 4 };
    const z = await run(zero.client, "espn_analyze_trade", args);
    const f = await run(off.client, "espn_analyze_trade", args);
    // the cut-short run is the one marked partial, whatever its numbers came to
    expect([z.partial, f.partial]).toEqual([true, false]);
    expect(seasonWarning(z).length).toBe(1);
    await zero.close();
    await off.close();
  }, 120_000);
});

describe("the composition root sets the switch only under EFF_TEST_STUBS=1 in fixture mode", () => {
  const wire = (env: Record<string, string>) => {
    const home = path.join(world.root, "home");
    const config = loadConfig({
      env: {
        ESPN_LEAGUE_ID: "0",
        ESPN_SEASON: "2026",
        EFF_CONFIG_DIR: path.join(world.root, "config"),
        EFF_CACHE_DIR: world.cache,
        EFF_CREDENTIAL_STORE: "file",
        EFF_CREDENTIAL_FILE: path.join(world.root, "config", "session.json"),
        ...env,
      },
      file: undefined,
      home,
      repoRoot: ROOT,
      nowMs: world.clock.nowMs(),
    });
    const lines: string[] = [];
    const logger = createLogger({ level: "info", sink: (l) => lines.push(l) });
    const wiring = buildServices({
      config,
      store: world.store,
      clock: world.clock,
      logger,
      packageRoot: ROOT,
      home,
      loadKeyring: () => Promise.reject(new Error("keychain disabled in tests")),
    });
    wiring.close();
    return {
      options: wiring.options,
      off: lines.some((l) => l.includes('"event":"services.cpu_deadline_off"')),
    };
  };

  it("stubs + fixture mode: null (off), and the log says so", () => {
    const w = wire({ EFF_FIXTURE_DIR: ESPN_FIXTURES, EFF_TEST_STUBS: "1" });
    expect(w.options.fixtureMode).toBe(true);
    expect("cpuDeadlineMs" in w.options).toBe(true);
    expect(w.options.cpuDeadlineMs).toBeNull();
    expect(w.off).toBe(true);
  });

  it.each([
    ["fixture mode without the stubs", { EFF_FIXTURE_DIR: ESPN_FIXTURES }],
    ["the stubs without fixture mode", { EFF_TEST_STUBS: "1" }],
    ["a production configuration", {}],
    [
      "the stubs explicitly off in fixture mode",
      { EFF_FIXTURE_DIR: ESPN_FIXTURES, EFF_TEST_STUBS: "0" },
    ],
  ])("%s: the production deadline (the option is absent)", (_label, env) => {
    const w = wire(env);
    expect("cpuDeadlineMs" in w.options).toBe(false);
    expect(w.off).toBe(false);
  });
});
