// partial-lost-input.test.ts — an answer that goes without an ESPN view it depends on says
// `partial: true` (plan 07 §2 Degradation: "every analytics tool lists which inputs it can lose and
// still answer (partial: true …)"; plan 01 §4.2). Stage C finding
// `envelope-partial-missing-view-e4-e12`: with the limiter's window full, espn_get_player_outlook
// (the outlook paragraphs missing) and espn_analyze_replacement (no free-agent pool, baselines
// proxied) answered `partial: false` with the omission only in a warning, while
// espn_get_projections in the same state said `partial: true`. The lost-input lines now carry the
// "partial:" prefix every tool's flag reads; the other pool readers (E8, E9, E6, E11) take the same
// line — E6/E11's pool loss was not even warned before. Fault injection over the real provider.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coded, faulty } from "./helpers/faults.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
  const c = await connect(world, { options: { toolset: "full" } });
  // the facts first (cached), as every Skill's Step 0 reads them
  for (const [name, args] of [
    ["espn_get_league", {}],
    ["espn_get_roster", { week: 4 }],
    ["espn_get_standings", {}],
  ] as const)
    expect((await call(c.client, name, args)).isError, name).toBe(false);
  await c.close();
}, 180_000);
afterAll(() => {
  world.cleanup();
});

interface Env {
  partial: boolean;
  warnings: string[];
}

async function under(
  fault: Parameters<typeof faulty>[1],
  name: string,
  args: Record<string, unknown>,
): Promise<Env> {
  const c = await connect(world, {
    options: { toolset: "full" },
    services: faulty(world.services, fault),
  });
  const r = await call(c.client, name, args);
  await c.close();
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
  return r.body as unknown as Env;
}

describe("a lost ESPN input makes the answer partial", () => {
  it("espn_get_player_outlook without the outlook view → partial, the paragraphs' absence said", async () => {
    const e = await under(
      { getPlayerOutlooks: coded("ESPN_UPSTREAM_UNAVAILABLE") },
      "espn_get_player_outlook",
      { players: { team_id: 1 } },
    );
    expect(e.partial).toBe(true);
    expect(
      e.warnings.some((w) => w.startsWith("partial:") && w.includes("outlook paragraphs")),
    ).toBe(true);
  });

  it("espn_get_player_outlook with the view → not partial (the control)", async () => {
    const e = await under({}, "espn_get_player_outlook", { players: { team_id: 1 } });
    expect(e.partial).toBe(false);
  });

  it.each([
    ["espn_analyze_replacement", {}],
    ["espn_analyze_schedule", {}],
    ["espn_analyze_roster", {}],
  ] as const)("%s without the free-agent pool → partial", async (name, args) => {
    const e = await under({ listPlayers: coded("ESPN_UPSTREAM_UNAVAILABLE") }, name, args);
    expect(e.partial).toBe(true);
    expect(
      e.warnings.some((w) => w.startsWith("partial:") && w.includes("no free-agent pool")),
    ).toBe(true);
  });

  it("espn_analyze_replacement with the pool → not partial (the control)", async () => {
    const e = await under({}, "espn_analyze_replacement", {});
    expect(e.partial).toBe(false);
  });
});
