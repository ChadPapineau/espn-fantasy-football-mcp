// trade-wire.test.ts — E6 espn_analyze_trade's wire and its find_partners position, at the tool level
// on fx-10h under EFF_TOOLSET=full (fixture mode; no network). Stage C round-2 findings:
// - trade-wire-fill-free-waivers: the seats a trade frees were filled from the AVAILABLE pool —
//   WAIVERS players included — as free, certain, instant adds. fx-10h's pool holds no free-agent QB,
//   only WAIVERS QBs, yet "give both of my QBs for an RB" read `fair` (Δ_me +7.3) and the partner
//   search proposed it. A WAIVERS player needs a claim; only a FREEAGENT is an instant add, and the
//   rec says which pool a freed seat was valued from.
// - players-position-filter-unvalidated: need_position was matched exactly and case-sensitively, so
//   `rb` / `FLEX` / `XYZ` answered partners [] with a false "no partner gains" conclusion.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageOf, PlatformPlayer, Stamped } from "../../src/providers/platform.js";
import { TRADE_WIRE_ASSUMPTION } from "../../src/mcp/tools/market-p1.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
/** My two QBs on fx-10h (team 2) and team 10's RB, as the finding's repro names them. */
const MY_QBS = [4426338, 4431452];
const THEIR_RB = 3042519;

type J = Record<string, unknown>;
interface Evaluation {
  verdict: string;
  delta_me: { mean: number };
  rec: { assumptions: { text: string }[] };
}

let world: World;
let client: Client;
let close: () => Promise<void>;

async function ok(c: Client, name: string, args: J = {}): Promise<J> {
  const r = await call(c, name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body;
}

beforeAll(async () => {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await ok(client, "espn_get_league");
  await ok(client, "espn_get_roster", { week: 5 });
  await ok(client, "espn_get_standings");
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("E6's wire is free agency only (Stage C trade-wire-fill-free-waivers)", () => {
  it("the repro's precondition: QBs are available on WAIVERS, none as a FREEAGENT", async () => {
    const waivers = (await ok(client, "espn_list_players", {
      status: "WAIVERS",
      position: "QB",
      week: 5,
    })) as { data: { players: unknown[] } };
    const fa = (await ok(client, "espn_list_players", {
      status: "FREEAGENT",
      position: "QB",
      week: 5,
    })) as { data: { players: unknown[] } };
    expect(waivers.data.players.length).toBeGreaterThan(0);
    expect(fa.data.players).toEqual([]);
  });

  it("giving both my QBs for an RB is never fair: no WAIVERS QB fills the seat for free", async () => {
    const e = (await ok(client, "espn_analyze_trade", {
      offer: { partner_team_id: 10, give: MY_QBS, get: [THEIR_RB] },
      seed: 7,
    })) as { data: Evaluation };
    expect(e.data.verdict).not.toBe("fair");
    expect(e.data.verdict).not.toBe("accept");
    expect(e.data.delta_me.mean).toBeLessThan(-50);
    // no free agent at all: the engine says the freed seat is worth 0, and no wire assumption
    expect(e.data.rec.assumptions.map((a) => a.text)).toContain(
      "a seat the trade frees is valued at 0 (no free agent to fill it)",
    );
    expect(e.data.rec.assumptions.map((a) => a.text)).not.toContain(TRADE_WIRE_ASSUMPTION.text);
  }, 60_000);

  it("the partner search never proposes giving away both QBs", async () => {
    const p = (await ok(client, "espn_analyze_trade", {
      find_partners: { need_position: "RB" },
      seed: 7,
    })) as { data: { partners: { proposal: { give: number[] } }[] } };
    for (const x of p.data.partners)
      expect(MY_QBS.every((id) => x.proposal.give.includes(id))).toBe(false);
  }, 60_000);

  it("control: a FREEAGENT QB is an instant add — it fills the seat, and the rec names the pool", async () => {
    // the same pool with its WAIVERS QBs cleared to free agency
    const s = faulty(world.services, {
      listPlayers: async (real, ...args) => {
        const got = (await real(...args)) as Stamped<PageOf<PlatformPlayer>>;
        const items = got.value.items.map((x) =>
          x.position === "QB" && x.status === "WAIVERS"
            ? { ...x, status: "FREEAGENT" as const }
            : x,
        );
        return { ...got, value: { ...got.value, items } };
      },
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    try {
      const filled = (await ok(c.client, "espn_analyze_trade", {
        offer: { partner_team_id: 10, give: MY_QBS, get: [THEIR_RB] },
        seed: 7,
      })) as { data: Evaluation };
      const bare = (await ok(client, "espn_analyze_trade", {
        offer: { partner_team_id: 10, give: MY_QBS, get: [THEIR_RB] },
        seed: 7,
      })) as { data: Evaluation };
      expect(filled.data.delta_me.mean).toBeGreaterThan(bare.data.delta_me.mean + 50);
      expect(filled.data.rec.assumptions.map((a) => a.text)).toContain(TRADE_WIRE_ASSUMPTION.text);
    } finally {
      await c.close();
    }
  }, 60_000);
});

describe("one free agent fills one side only (Stage C trade-wire-fill-free-waivers, the engine half)", () => {
  // the verifier's case: both sides free a seat; with only 3046779 a free agent, both Δs rose
  // (Δ_me 0 → +7.955, Δ_partner −37.249 → −16.999), both from that one player
  const ONE_FA = 3046779;
  const OFFER = { partner_team_id: 10, give: [4366031], get: [4262921] };
  interface Impact {
    weekly_impact: { me: number; partner: number }[];
    rec: { assumptions: { text: string }[] };
  }
  const sums = (d: Impact) => ({
    me: d.weekly_impact.reduce((s, w) => s + w.me, 0),
    partner: d.weekly_impact.reduce((s, w) => s + w.partner, 0),
  });

  it("with one FREEAGENT in the pool, Δ_me and Δ_partner never both rise; the fill is named once", async () => {
    const s = faulty(world.services, {
      listPlayers: async (real, ...args) => {
        const got = (await real(...args)) as Stamped<PageOf<PlatformPlayer>>;
        const items = got.value.items.map((x) =>
          x.ref.id === ONE_FA ? { ...x, status: "FREEAGENT" as const } : x,
        );
        return { ...got, value: { ...got.value, items } };
      },
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    try {
      const one = (await ok(c.client, "espn_analyze_trade", { offer: OFFER, seed: 7 })) as {
        data: Impact;
      };
      const bare = (await ok(client, "espn_analyze_trade", { offer: OFFER, seed: 7 })) as {
        data: Impact;
      };
      const [a, b] = [sums(one.data), sums(bare.data)];
      const rose = { me: a.me > b.me + 1e-6, partner: a.partner > b.partner + 1e-6 };
      // he fills a seat (a wire was given) — on exactly one side
      expect(rose.me || rose.partner).toBe(true);
      expect(rose.me && rose.partner).toBe(false);
      const side = rose.me ? "me" : "partner";
      expect(side === "me" ? a.partner : a.me).toBeCloseTo(side === "me" ? b.partner : b.me, 6);
      const fill = one.data.rec.assumptions.find((x) =>
        x.text.startsWith("the seats the trade frees are filled"),
      )?.text;
      expect(fill).toBe(
        `the seats the trade frees are filled from the wire, each free agent on one side only: you add ${side === "me" ? String(ONE_FA) : "none"}; the partner adds ${side === "partner" ? String(ONE_FA) : "none"}`,
      );
    } finally {
      await c.close();
    }
  }, 120_000);
});

describe("E6 find_partners.need_position (Stage C players-position-filter-unvalidated)", () => {
  it("rb is RB; FLEX, XYZ and a non-starting position are VALIDATION unknown_position", async () => {
    const up = (await ok(client, "espn_analyze_trade", {
      find_partners: { need_position: "RB" },
      seed: 7,
    })) as { data: { partners: unknown[] } };
    const low = (await ok(client, "espn_analyze_trade", {
      find_partners: { need_position: "rb" },
      seed: 7,
    })) as { data: { partners: unknown[] } };
    expect(low.data.partners).toEqual(up.data.partners);
    for (const bad of ["FLEX", "XYZ", "BE", "IR"]) {
      const r = await call(client, "espn_analyze_trade", {
        find_partners: { need_position: bad },
        seed: 7,
      });
      expect(r.isError, bad).toBe(true);
      expect((r.body as { error: J }).error, bad).toMatchObject({
        code: "VALIDATION",
        field: "find_partners.need_position",
        reason: "unknown_position",
      });
    }
  }, 120_000);
});
