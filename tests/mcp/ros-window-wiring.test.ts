// ros-window-wiring.test.ts — Stage C finding projection-ros-includes-week18, the wiring of every
// league-wide tool (research 04 §B.1.1; plan 07 E1, E4–E9, E11). ESPN's split (1,0) total counts the
// games not yet played through NFL week 18, so each tool must share it over the player's own window at
// the call's clock (common.ts rosReadingOf → rosOptsOf) — as E1 does. ros-window-tools.test.ts holds
// the helpers to E1's numbers under a reading the test builds itself; this file holds the TOOLS to
// pass the reading: a spy on weeklyValues (the one function every one of them prices a player week
// with) records every call each tool makes, and every call must carry the window (`ros_weeks`) and the
// schedule's last week. A tool whose reading reverted to null (the verifier's mutation of E5, E6 and
// E8: every other test still passed) answers with weeklyValues' default reading and fails here.
// Fixture world (league-a at T0, after week 4's games; `full`; nflverse published), no network.
//
// Ruling R7-5 (the verifier, attempt 3): seven call sites were reached by no call above, so reverting
// their window passed every test — E6's free-agent wire (league-a's pool holds WAIVERS players only,
// so the wire was empty), E7's claim verdicts (no league-a beneficiary is a free agent or on waivers,
// so the E5 sub-path never ran: the candidate, the shared waiver request with my roster, the rivals'
// rosters and the reading passed into it) and E9's handcuff values (my league-a team has no handcuff).
// The second block reaches each on fx-10h, with the platform reads shaped the way those sub-paths need
// (a pool cleared to free agency, a waivers QB on my QB's NFL team), and first asserts that the
// sub-path ran — so it can never pass by skipping it.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WeeklyValuesOpts } from "../../src/domain/analytics/waivers.js";
import type { McpServices } from "../../src/mcp/services.js";
import { TRADE_WIRE_ASSUMPTION } from "../../src/mcp/tools/market-p1.js";
import type { PageOf, PlatformPlayer, Stamped } from "../../src/providers/platform.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

/** Every weeklyValues call since the last reset: its options argument (null when none was passed). */
const seen = vi.hoisted(() => ({ opts: [] as (WeeklyValuesOpts | null)[] }));

vi.mock("../../src/domain/analytics/waivers.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/domain/analytics/waivers.js")>();
  return {
    ...mod,
    weeklyValues: (...args: Parameters<typeof mod.weeklyValues>) => {
      seen.opts.push(args[4] ?? null);
      return mod.weeklyValues(...args);
    },
  };
});

let world: World;
let client: Client;
let close: () => Promise<void>;
let mine: { player_id: number; slot: string; position: string; gsis_id: string | null }[];
let rival: { player_id: number; slot: string }[];
let pooled: { player_id: number; position: string; gsis_id: string | null }[];

async function data(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await call(client, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
  return r.body.data as Record<string, unknown>;
}

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await data("espn_get_league", {});
  mine = (await data("espn_get_roster", { week: 4 })).players as typeof mine;
  rival = (await data("espn_get_roster", { week: 4, team_id: 2 })).players as typeof rival;
  await data("espn_get_standings", {});
  pooled = (await data("espn_list_players", { status: "ONTEAM", limit: 100 }))
    .players as typeof pooled;
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** The last week ESPN's total counts (research 04 §B.1.1): the 2026 schedule's week 18. */
const LAST_WEEK = 18;

/** Calls `tool` and returns the options of every weeklyValues call it made. */
async function optsOf(tool: string, args: Record<string, unknown>) {
  seen.opts.length = 0;
  await data(tool, args);
  return [...seen.opts];
}

describe("every league-wide tool shares ESPN's ROS total over the player's window", () => {
  const cases: readonly (readonly [string, string, () => Record<string, unknown>])[] = [
    ["E4", "espn_analyze_replacement", () => ({ horizon: "ros" })],
    ["E5 priority", "espn_analyze_waivers", () => ({})],
    ["E5 espn_ros", "espn_analyze_waivers", () => ({ value_source: "espn_ros" })],
    [
      "E6 offer",
      "espn_analyze_trade",
      () => ({
        offer: {
          partner_team_id: 2,
          give: mine
            .filter((p) => p.slot !== "IR")
            .slice(0, 1)
            .map((p) => p.player_id),
          get: rival
            .filter((p) => p.slot !== "IR")
            .slice(0, 1)
            .map((p) => p.player_id),
        },
        seed: 4,
      }),
    ],
    [
      "E6 partners",
      "espn_analyze_trade",
      () => ({ find_partners: { need_position: "RB", max_partners: 1 }, seed: 4 }),
    ],
    [
      "E7",
      "espn_analyze_injury_cascade",
      () => ({
        // a crosswalked RB (E7 reads his usage through the gsis id)
        player: {
          player_ids: [
            (pooled.find((p) => p.position === "RB" && p.gsis_id !== null) ?? pooled[0])
              ?.player_id ?? 0,
          ],
        },
      }),
    ],
    ["E8", "espn_analyze_schedule", () => ({ seed: 2 })],
    ["E9", "espn_analyze_roster", () => ({ seed: 2 })],
    ["E11", "espn_analyze_league_activity", () => ({})],
  ];

  for (const [label, tool, args] of cases)
    it(`${label} (${tool}): every weekly value carries the window and week ${String(LAST_WEEK)}`, async () => {
      const opts = await optsOf(tool, args());
      expectWindowed(label, opts);
    }, 240_000);
});

/** Every weeklyValues call of one tool call carried the window and the schedule's last week. */
function expectWindowed(label: string, opts: readonly (WeeklyValuesOpts | null)[]): void {
  expect(opts.length, `${label} priced no player week`).toBeGreaterThan(0);
  const without = opts.filter(
    (o) => o === null || !Array.isArray(o.ros_weeks) || o.ros_last_week !== LAST_WEEK,
  );
  expect(without.length, `${label}: ${String(without.length)} of ${String(opts.length)}`).toBe(0);
}

describe("the sub-paths no league-a call reaches share it too (ruling R7-5)", () => {
  const FX = path.join(ESPN_FIXTURES, "fx-10h");
  const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
    current_week: number;
  };
  const week = manifest.current_week;
  let fx: World;
  let base: { client: Client; close: () => Promise<void> };
  let myRoster: { player_id: number; position: string; slot: string }[];
  let partnerRoster: { player_id: number; slot: string }[];
  /** The pool's waivers QBs (E7 moves one onto my QB's NFL team). */
  let waiverQbs: number[];

  type J = Record<string, unknown>;
  async function body(c: Client, name: string, args: J): Promise<J> {
    const r = await call(c, name, args);
    expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
    return r.body;
  }
  /** Calls `name` on a server over `services`; returns its data and every weeklyValues call's options. */
  async function run(services: McpServices, name: string, args: J) {
    const c = await connect(fx, { options: { toolset: "full" }, services });
    try {
      seen.opts.length = 0;
      const data = (await body(c.client, name, args)).data as J;
      return { data, opts: [...seen.opts] };
    } finally {
      await c.close();
    }
  }

  beforeAll(async () => {
    fx = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: manifest.my_team_id,
      clock: manifest.clock,
      publishEspn: true,
    });
    base = await connect(fx, { options: { toolset: "full" } });
    await body(base.client, "espn_get_league", {});
    myRoster = (
      (await body(base.client, "espn_get_roster", { week })).data as { players: typeof myRoster }
    ).players;
    partnerRoster = (
      (await body(base.client, "espn_get_roster", { week, team_id: 3 })).data as {
        players: typeof partnerRoster;
      }
    ).players;
    waiverQbs = (
      (await body(base.client, "espn_list_players", { status: "WAIVERS", position: "QB", week }))
        .data as { players: { player_id: number }[] }
    ).players.map((p) => p.player_id);
    expect(waiverQbs.length, "no waivers QB in the pool").toBeGreaterThan(0);
  }, 180_000);
  afterAll(async () => {
    await base.close();
    fx.cleanup();
  });

  /** The services with the pool's WAIVERS players cleared to free agency (E6's wire is not empty). */
  const freeAgency = (): McpServices =>
    faulty(fx.services, {
      listPlayers: async (real, ...args) => {
        const got = (await real(...args)) as Stamped<PageOf<PlatformPlayer>>;
        const items = got.value.items.map((x) =>
          x.status === "WAIVERS" ? { ...x, status: "FREEAGENT" as const } : x,
        );
        return { ...got, value: { ...got.value, items } };
      },
    });

  const wired = (data: J): boolean =>
    ((data.rec as { assumptions: { text: string }[] } | null)?.assumptions ?? []).some(
      (a) => a.text === TRADE_WIRE_ASSUMPTION.text,
    );

  it("E6 offer with a free-agent wire: the wire's players carry the window", async () => {
    const give = myRoster.find((p) => p.slot !== "IR")?.player_id;
    const get = partnerRoster.find((p) => p.slot !== "IR")?.player_id;
    const { data, opts } = await run(freeAgency(), "espn_analyze_trade", {
      offer: { partner_team_id: 3, give: [give], get: [get] },
      seed: 4,
    });
    // the sub-path ran: the freed seats were valued from the wire
    expect(wired(data)).toBe(true);
    expectWindowed("E6 offer + wire", opts);
  }, 240_000);

  it("E6 partner search with a free-agent wire: the wire's players carry the window", async () => {
    const { data, opts } = await run(freeAgency(), "espn_analyze_trade", {
      find_partners: { need_position: "RB", max_partners: 1 },
      seed: 4,
    });
    expect(wired(data)).toBe(true);
    expectWindowed("E6 partners + wire", opts);
  }, 240_000);

  /** The services with my QB's filterIds read also returning `backup`, on my QB's NFL team. */
  const movedOnto = (qb: number, backup: number): McpServices =>
    faulty(fx.services, {
      getPlayers: async (real, ...args) => {
        const got = (await real(...args)) as Stamped<readonly PlatformPlayer[]>;
        const inj = got.value.find((p) => p.ref.id === qb);
        if (inj === undefined) return got;
        const extra = (await real(
          args[0],
          [{ platform: "espn", id: backup }],
          args[2],
          args[3],
        )) as Stamped<readonly PlatformPlayer[]>;
        const b = extra.value[0];
        if (b === undefined) return got;
        return {
          ...got,
          value: [...got.value, { ...b, pro_team_id: inj.pro_team_id, pro_team: inj.pro_team }],
        };
      },
    });

  it("E7 with a beneficiary on waivers: its E5 claim verdict carries the window", async () => {
    const qb = myRoster.find((p) => p.position === "QB" && p.slot === "QB")?.player_id ?? 0;
    expect(qb).toBeGreaterThan(0);
    // the first waivers QB the cascade lists as my QB's backup (one whose week trails 0.75 × his)
    let ran: Awaited<ReturnType<typeof run>> | null = null;
    for (const backup of waiverQbs.slice(0, 8)) {
      const r = await run(movedOnto(qb, backup), "espn_analyze_injury_cascade", {
        player: { player_ids: [qb] },
        assume_weeks_out: 4,
      });
      const b = (
        r.data.beneficiaries as {
          player_id: number;
          availability: { status: string | null };
          verdict: string | null;
        }[]
      ).find((x) => x.player_id === backup);
      if (b?.availability.status === "WAIVERS" && b.verdict !== null) {
        ran = r;
        break;
      }
    }
    // the sub-path ran: E5 judged a beneficiary on waivers (his candidate, my roster, the rivals)
    expect(ran, "no waivers QB became a claimable beneficiary").not.toBeNull();
    expectWindowed("E7 + claim verdicts", ran?.opts ?? []);
  }, 240_000);

  it("E9 for a team with a handcuff: the starter's promoted weeks carry the window", async () => {
    const { data, opts } = await run(fx.services, "espn_analyze_roster", { team_id: 1, seed: 2 });
    // the sub-path ran: a bench RB behind his NFL team's lead back was valued
    expect((data.handcuff_values as unknown[]).length).toBeGreaterThan(0);
    expectWindowed("E9 + handcuffs", opts);
  }, 240_000);
});
