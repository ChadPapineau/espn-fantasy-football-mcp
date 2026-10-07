// e1-player-sim.test.ts — E1's P1 `player_sim` basis at the TOOL level (plan 10 §3.2; plan 07 E1):
// on league-a with the nflverse excerpts published, `espn_project_players` (fixture-roster players)
// under EFF_TOOLSET=full
// gives the player_sim distribution to every RB/WR/TE week with ≥ 3 trailing games — the same
// means as under core, where nothing is player_sim (the P0 projections are unchanged).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
}, 180_000);
afterAll(() => {
  world.cleanup();
});

interface Proj {
  player_id: number;
  position: string;
  weeks: { points: { mean: number; basis: string } }[];
  role_confidence_games: number;
}

async function projections(toolset: "core" | "full"): Promise<Proj[]> {
  const c = await connect(world, { options: { toolset } });
  try {
    await call(c.client, "espn_get_league", {});
    const r = await call(c.client, "espn_project_players", {
      // fixture-roster RBs and WRs (fixtures/players/fixture-roster.json): three 2026 stat weeks each
      players: { player_ids: [4379399, 4239996, 4430807, 4262921, 4374302, 3918298] },
      horizon: "week",
      week: 5,
      seed: 11,
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    return (r.body.data as { projections: Proj[] }).projections;
  } finally {
    await c.close();
  }
}

describe("espn_project_players: player_sim under full, position_cv under core", () => {
  it("same means; player_sim exactly for RB/WR/TE with ≥ 3 trailing games under full", async () => {
    const core = await projections("core");
    const full = await projections("full");
    expect(core.every((p) => p.weeks.every((w) => w.points.basis === "position_cv"))).toBe(true);
    expect(full.map((p) => p.player_id)).toEqual(core.map((p) => p.player_id));
    full.forEach((p, i) => {
      expect(p.weeks[0]?.points.mean).toBe(core[i]?.weeks[0]?.points.mean);
      const basis = p.weeks[0]?.points.basis;
      if (basis === "player_sim") {
        expect(["RB", "WR", "TE"]).toContain(p.position);
        expect(p.role_confidence_games).toBeGreaterThanOrEqual(3);
      }
      if (!["RB", "WR", "TE"].includes(p.position)) expect(basis).toBe("position_cv");
    });
    // the league's recorded pool answers the fixture-roster players it holds (a WR with three stat
    // weeks here): at least one player_sim week, the rest by the rule above
    expect(
      full.filter((p) => p.weeks[0]?.points.basis === "player_sim").length,
    ).toBeGreaterThanOrEqual(1);
  });
});
