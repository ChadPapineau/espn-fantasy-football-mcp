// projections-roster.test.ts — espn_project_players answers a whole roster at the default detail
// (plan 07 E1 token line; plan 07 C8's 10 000-character analytics budget; §5.2 compact keeps every
// identifier and decision number). Stage C finding projections-roster-truncated: the result was only
// HALVED to fit, so the owner's 16-player roster came back as 8 of 16 (week, core), 7 of 15 (week,
// full) and 3 of 15 (ROS) — and the five Skills that project a roster this way read part of it.
// Now budget steps thin the rows (a shared assumption stated once in warnings[], drivers, weeks
// beyond the first, then only ros_total) before any player is dropped, one at a time.
// Fixture mode on fx-10h; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectionTrims } from "../../src/mcp/tools/analytics.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");

type J = Record<string, unknown>;
interface Proj {
  player_id: number;
  weeks: unknown[];
  ros_total: unknown;
}

describe.each(["core", "full"] as const)("E1 for a whole roster under %s", (toolset) => {
  it("16 players (my roster + 1) at week, ros and season: every player answered", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      clock: string;
      my_team_id: number;
    };
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: toolset },
      teamId: m.my_team_id,
      clock: m.clock,
      publishNflverse: toolset === "full",
    });
    try {
      const c = await connect(world, { options: { toolset } });
      const mine = (await call(c.client, "espn_get_roster", { week: 5 })).body.data as {
        players: { player_id: number }[];
      };
      const other = (await call(c.client, "espn_get_roster", { week: 5, team_id: 3 })).body
        .data as { players: { player_id: number }[] };
      const ids = [...mine.players.map((p) => p.player_id), other.players[0]?.player_id ?? 0];
      expect(ids).toHaveLength(16);
      for (const horizon of ["week", "ros", "season"] as const) {
        const r = await call(c.client, "espn_project_players", {
          players: { player_ids: ids },
          horizon,
        });
        expect(r.isError, `${horizon}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
        const projections = (r.body.data as { projections: Proj[] }).projections;
        expect(projections.map((p) => p.player_id).sort(), horizon).toEqual([...ids].sort());
        const warnings = r.body.warnings as string[];
        expect(
          warnings.some((w) => w.startsWith("result truncated")),
          horizon,
        ).toBe(false);
        expect(
          warnings.some((w) => w.startsWith("projections truncated")),
          horizon,
        ).toBe(false);
        if (horizon !== "week") for (const p of projections) expect(p.ros_total).not.toBeNull();
        else for (const p of projections) expect(p.weeks).toHaveLength(1);
        expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(10_000);
      }
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 120_000);
});

describe("projectionTrims (units)", () => {
  const dist = { mean: 1, p10: 0, p25: 0, p50: 1, p75: 2, p90: 3, p_zero: 0, basis: "position_cv" };
  const row = (id: number, weeks: number, ros: boolean, assumption = "shared text"): J => ({
    player_id: id,
    weeks: Array.from({ length: weeks }, (_, i) => ({ week: 5 + i })),
    ros_total: ros ? dist : null,
    drivers: [
      { name: "a", contribution: 1 },
      { name: "b", contribution: -3 },
    ],
    assumptions: [{ text: assumption, revisit_trigger: "later" }],
  });
  const apply = (steps: ReturnType<typeof projectionTrims>, d: unknown): unknown => {
    const out = steps.reduce<unknown>((acc, t) => t(acc)?.data ?? acc, d);
    return out;
  };

  it("hoists an assumption shared by two or more players into one warning naming them", () => {
    const [hoist] = projectionTrims(3);
    const d = { projections: [row(1, 1, false), row(2, 1, false), row(3, 1, false, "own")] };
    const r = hoist?.(d);
    expect(r?.warning).toBe("assumption of projections 1, 2: shared text (revisit when later)");
    const rows = (r?.data as { projections: { assumptions: unknown[] }[] }).projections;
    expect(rows.map((x) => x.assumptions.length)).toEqual([0, 0, 1]);
    // nothing left to share: the step stops
    expect(hoist?.(r?.data)).toBeNull();
  });

  it("an assumption line over the 400-character warning cap stays on its rows", () => {
    const [hoist] = projectionTrims(2);
    const long = "x".repeat(380);
    expect(hoist?.({ projections: [row(1, 1, false, long), row(2, 1, false, long)] })).toBeNull();
  });

  it("drivers: the largest by |contribution| first, weeks to one, then none; ros_total carries the horizon", () => {
    const steps = projectionTrims(2);
    const d = { projections: [row(1, 3, true), row(2, 3, true)] };
    const top = steps[1]?.(d);
    expect(
      (top?.data as { projections: { drivers: { name: string }[] }[] }).projections[0]?.drivers,
    ).toEqual([{ name: "b", contribution: -3 }]);
    const one = steps[2]?.(top?.data);
    expect(
      (one?.data as { projections: { weeks: unknown[] }[] }).projections.map((x) => x.weeks.length),
    ).toEqual([1, 1]);
    const all = apply(steps.slice(0, 5), d) as { projections: Proj[] };
    expect(all.projections.every((p) => p.weeks.length === 0 && p.ros_total !== null)).toBe(true);
    // a week horizon (no ros_total) never loses its week row
    const wk = apply(steps.slice(0, 5), { projections: [row(1, 1, false), row(2, 1, false)] }) as {
      projections: Proj[];
    };
    expect(wk.projections.every((p) => p.weeks.length === 1)).toBe(true);
  });

  it("detail full keeps every row: only the lossless hoist, then one player at a time", () => {
    const steps = projectionTrims(2, true);
    expect(steps).toHaveLength(2);
    const d = { projections: [row(1, 3, true), row(2, 3, true)] };
    const out = apply(steps.slice(0, 1), d) as {
      projections: { weeks: unknown[]; drivers: unknown[] }[];
    };
    expect(out.projections.map((p) => [p.weeks.length, p.drivers.length])).toEqual([
      [3, 2],
      [3, 2],
    ]);
  });

  it("the last step drops ONE player at a time, never half", () => {
    const steps = projectionTrims(4);
    const last = steps[steps.length - 1];
    const r = last?.({ projections: [row(1, 1, false), row(2, 1, false), row(3, 1, false)] });
    expect((r?.data as { projections: unknown[] }).projections).toHaveLength(2);
    expect(r?.warning).toMatch(/^projections truncated to 2 of 4 to fit the budget; /);
  });
});
