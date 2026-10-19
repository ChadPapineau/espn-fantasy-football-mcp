// projections-roster.test.ts — espn_project_players answers a whole roster at the default detail
// (plan 07 E1 token line; plan 07 C8's 10 000-character analytics budget; §5.2 compact keeps every
// identifier and decision number). Stage C finding projections-roster-truncated: the result was only
// HALVED to fit, so the owner's 16-player roster came back as 8 of 16 (week, core), 7 of 15 (week,
// full) and 3 of 15 (ROS) — and the five Skills that project a roster this way read part of it.
// Attempt 1 added budget steps that thin the rows (a shared assumption stated once in warnings[],
// drivers, weeks beyond the first, then only ros_total) before any player is dropped, one at a
// time — but under `full` at horizon week (v2's rows are the longest) the seeded fixture league
// still lost a player in 68 of its 130 sixteen-player sets. Now two more steps run first: the
// numbers go to the precision a decision reads (points 0.1, probabilities 0.01), then the
// assumptions only one player carries go (their ids said). Fixture mode on fx-10h; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { projectionTrims } from "../../src/mcp/tools/analytics.js";
import { seedDatasets } from "../integration/helpers/seed.js";
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

describe("E1 for a whole roster under full on the SEEDED fixture league (every source loaded)", () => {
  it("my roster + each of another team's players at week: every player answered, in budget", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      clock: string;
      my_team_id: number;
    };
    // the state a refresh leaves (the e2e seed): v2's inputs and their history twins, the official
    // report, the news and trending feeds — the longest E1 rows and the longest envelope
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: m.my_team_id,
      clock: m.clock,
      publishEspn: false,
    });
    try {
      await seedDatasets(world.store, {
        storePath: storePath(world.cache),
        datasetDir: datasetDir(world.cache),
        cache: world.cache,
        clock: world.clock,
        season: 2026,
      });
      world.store.reopenChangedDatasets();
      const c = await connect(world, { options: { toolset: "full" } });
      const roster = async (team?: number) =>
        (
          (
            await call(c.client, "espn_get_roster", {
              week: 5,
              ...(team === undefined ? {} : { team_id: team }),
            })
          ).body.data as { players: { player_id: number }[] }
        ).players.map((p) => p.player_id);
      const mine = await roster();
      const other = await roster(m.my_team_id === 1 ? 3 : 1);
      expect(mine).toHaveLength(15);
      for (const extra of other) {
        // the ESPN limiter's per-minute window (fixture mode counts requests too)
        world.clock.advance(4_000);
        const ids = [...mine, extra];
        const r = await call(c.client, "espn_project_players", {
          players: { player_ids: ids },
          horizon: "week",
          week: 5,
        });
        expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
        const got = (r.body.data as { projections: Proj[] }).projections;
        expect(got.map((p) => p.player_id).sort(), String(extra)).toEqual([...ids].sort());
        for (const p of got) expect(p.weeks).toHaveLength(1);
        const warnings = r.body.warnings as string[];
        expect(
          warnings.filter((w) => /^(?:result|projections) truncated/.test(w)),
          String(extra),
        ).toEqual([]);
        expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(10_000);
      }
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 180_000);
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

  it("before any player leaves: the numbers to a decision's precision, then lone assumptions (ids said)", () => {
    const steps = projectionTrims(2);
    const precision = steps[steps.length - 3];
    const lone = steps[steps.length - 2];
    const wk = {
      week: 5,
      points: {
        mean: 15.94,
        p10: 5.735,
        p25: 9.295,
        p50: 14.437,
        p75: 20.864,
        p90: 27.796,
        p_zero: 0.0371,
        basis: "player_sim",
      },
      p_active: 0.8549,
      opponent: "LAR",
      implied_total: 26.25,
      inputs: { espn: 15.94, own: 12.489, weight_espn: 1 },
      disagreement: { pct: 0.215, flagged: false },
    };
    const d = {
      projections: [
        { ...row(1, 1, false), weeks: [wk], assumptions: [] },
        { ...row(2, 1, false, "only his"), weeks: [wk] },
      ],
    };
    const r = precision?.(d);
    const w0 = (r?.data as { projections: { weeks: (typeof wk)[] }[] }).projections[0]?.weeks[0];
    expect(w0?.points).toEqual({
      mean: 15.9,
      p10: 5.7,
      p25: 9.3,
      p50: 14.4,
      p75: 20.9,
      p90: 27.8,
      p_zero: 0.04,
      basis: "player_sim",
    });
    expect([w0?.p_active, w0?.implied_total, w0?.inputs, w0?.disagreement.pct]).toEqual([
      0.85,
      26.3,
      { espn: 15.9, own: 12.5, weight_espn: 1 },
      0.22,
    ]);
    expect(r?.warning).toMatch(
      /^projections\[\] numbers rounded to fit the 10000-character budget/,
    );
    // nothing left to round: the step stops
    expect(precision?.(r?.data)).toBeNull();
    const a = lone?.(r?.data);
    expect(a?.warning).toMatch(/^projections\[\]\.assumptions of 2 omitted to fit/);
    expect(
      (a?.data as { projections: { assumptions: unknown[] }[] }).projections.every(
        (x) => x.assumptions.length === 0,
      ),
    ).toBe(true);
    expect(lone?.(a?.data)).toBeNull();
    // the quantiles stay ordered (rounding is monotone)
    const p = w0?.points;
    expect(
      p !== undefined && p.p10 <= p.p25 && p.p25 <= p.p50 && p.p50 <= p.p75 && p.p75 <= p.p90,
    ).toBe(true);
  });

  it("the last step drops ONE player at a time, never half", () => {
    const steps = projectionTrims(4);
    const last = steps[steps.length - 1];
    const r = last?.({ projections: [row(1, 1, false), row(2, 1, false), row(3, 1, false)] });
    expect((r?.data as { projections: unknown[] }).projections).toHaveLength(2);
    expect(r?.warning).toMatch(/^projections truncated to 2 of 4 to fit the budget; /);
  });
});
