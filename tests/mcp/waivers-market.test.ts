// waivers-market.test.ts — espn_analyze_waivers prices the waiver market the Skills mean, and under
// EFF_TOOLSET=full weights playoff weeks by P(alive) (plan 07 E5: "Data: C2 (≤ 3 pages)", the W
// bullet of changelog R5-1). Stage C round-2 findings:
// - skills-waivers-default-pool-wrong-market: the waivers and weekly Skills' main call (mode, phase
//   and value_source auto; no positions) read ONE 50-row page of every position sorted by ESPN's
//   rest-of-season projection — on fx-10h 25 TQB and 7 QB rows — so it priced backup QBs, kickers
//   and D/STs and never the RB/WR targets ("no claim clears the premium", an empty scramble list).
//   Now the default is the league's flex market (one page of the FLEX slot: the same one request);
//   named positions read a page each (≤ 3).
// - waivers-playoff-weeks-unweighted-full: under full E5 never passed P(alive), so W counted every
//   playoff week at 1 (W 12, Π 26.95) with the P0 assumption "playoff weeks are weighted 1" on a
//   toolset where the season simulator exists.
// Fixture mode on fx-10h, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServices } from "../../src/mcp/services.js";
import { defaultWaiverMarket } from "../../src/mcp/tools/analytics.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const FLEX = new Set(["RB", "WR", "TE"]);

type J = Record<string, unknown>;
interface Waivers {
  W: number;
  premium: number;
  candidates: { player_id: number; position: string; s: number }[];
  claim_list: number[];
  marginal: number[];
  scramble_list: number[];
  rec: { assumptions: { text: string }[] };
}

async function fxWorld(toolset: "core" | "full"): Promise<World> {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  return makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: toolset },
    teamId: m.my_team_id,
    clock: m.clock,
  });
}

async function waivers(
  world: World,
  toolset: "core" | "full",
  args: J,
  services?: Partial<McpServices>,
): Promise<J> {
  const c = await connect(world, {
    options: { toolset },
    ...(services === undefined ? {} : { services }),
  });
  try {
    await call(c.client, "espn_get_league");
    await call(c.client, "espn_get_roster", { week: 5 });
    await call(c.client, "espn_get_standings");
    const r = await call(c.client, "espn_analyze_waivers", { detail: "full", ...args });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    return r.body;
  } finally {
    await c.close();
  }
}

describe("the default market (Stage C skills-waivers-default-pool-wrong-market)", () => {
  it("the Skill's main call prices the flex market, never QB/K/D-ST/TQB, in one pool request", async () => {
    const world = await fxWorld("core");
    try {
      const queries: unknown[] = [];
      const counted = faulty(world.services, {
        listPlayers: (real, ...args) => {
          queries.push(args[1]);
          return real(...args);
        },
      });
      const body = await waivers(
        world,
        "core",
        { mode: "auto", phase: "auto", value_source: "auto" },
        counted,
      );
      const d = body.data as Waivers;
      expect(d.candidates.length).toBeGreaterThan(0);
      for (const c of d.candidates) expect(FLEX.has(c.position), String(c.player_id)).toBe(true);
      // the RB/WR targets of the finding are priced (with their surplus)
      const ids = d.candidates.map((c) => c.player_id);
      expect(ids).toEqual(expect.arrayContaining([4871023, 4711533, 4426385]));
      expect(d.scramble_list.length + d.claim_list.length + d.marginal.length).toBeGreaterThan(0);
      expect(body.warnings as string[]).toContain(
        "pool: the FLEX market (RB, WR, TE) — one page by ESPN's rest-of-season projection; pass positions for QB, K or D/ST",
      );
      // the same one pool read the old all-position page cost: the FLEX slot's page
      expect(queries).toEqual([
        { status: "AVAILABLE", position: "FLEX", sort: "projection_ros", week: 5, injured: null },
      ]);
    } finally {
      world.cleanup();
    }
  }, 120_000);

  it("named positions read a page each (interleaved): every position asked is priced", async () => {
    const world = await fxWorld("core");
    try {
      const body = await waivers(world, "core", { positions: ["RB", "WR", "TE"] });
      const d = body.data as Waivers;
      const positions = new Set(d.candidates.map((c) => c.position));
      expect([...positions].every((p) => FLEX.has(p))).toBe(true);
      // the full list names every candidate: claim, marginal and scramble ids cover the TE page too
      expect(positions.size).toBeGreaterThanOrEqual(2);
    } finally {
      world.cleanup();
    }
  }, 120_000);

  it("defaultWaiverMarket: the widest flex slot, else the starting positions without K and D/ST", () => {
    const slot = (name: string, cls: string, eligible: string[], count = 1) => ({
      name,
      class: cls,
      count,
      eligible_positions: eligible,
    });
    expect(
      defaultWaiverMarket({
        slots: [
          slot("QB", "starter", ["QB"]),
          slot("RB/WR", "flex", ["RB", "WR"]),
          slot("FLEX", "flex", ["RB", "WR", "TE"]),
        ],
      } as never),
    ).toEqual({ slot: "FLEX", positions: ["RB", "WR", "TE"] });
    expect(
      defaultWaiverMarket({
        slots: [
          slot("QB", "starter", ["QB"]),
          slot("WR", "starter", ["WR"]),
          slot("RB", "starter", ["RB"]),
          slot("TE", "starter", ["TE"]),
          slot("K", "starter", ["K"]),
          slot("D/ST", "starter", ["D/ST"]),
        ],
      } as never),
    ).toEqual({ slot: null, positions: ["RB", "WR", "TE"] });
  });
});

describe("playoff weeks weighted by P(alive) under full (Stage C waivers-playoff-weeks-unweighted-full)", () => {
  it("full: W is 9 regular weeks plus P(alive) per playoff week, Π below the unweighted one; core keeps weight 1, said", async () => {
    const core = await fxWorld("core");
    const full = await fxWorld("full");
    try {
      const c = (await waivers(core, "core", { mode: "priority" })).data as Waivers;
      const f = (await waivers(full, "full", { mode: "priority" })).data as Waivers;
      const weighted =
        "playoff weeks are weighted 1: P(alive) from the seeding simulator was not given";
      // fx-10h week 5: weeks 6–14 regular (9), playoff weeks 15–17
      expect(c.W).toBe(12);
      expect(c.rec.assumptions.map((a) => a.text)).toContain(weighted);
      expect(f.W).toBeGreaterThan(9);
      expect(f.W).toBeLessThan(12);
      expect(f.premium).toBeLessThan(c.premium);
      expect(f.rec.assumptions.map((a) => a.text)).not.toContain(weighted);
    } finally {
      core.cleanup();
      full.cleanup();
    }
  }, 180_000);
});
