// e1-v2.test.ts — E1's v2-opportunity at the TOOL level on the seeded fixture league (plan 10 §3.3
// C1; plan 07 E1 → model_version "v2-opportunity", basis "player_sim"): fx-10h seeded exactly as the
// stdio suites see it (tests/integration/helpers/seed.ts), through the real composition root in
// fixture mode. Under EFF_TOOLSET=full every QB/RB/WR/TE of a roster whose opportunity inputs exist
// gets v2's first-week distribution AROUND ESPN'S MEAN (weight_espn 1.0 — ADV OBJ-02; the label and
// `inputs.espn` unchanged); K and D/ST keep v1; under `core` nothing changes (v1-ensemble,
// position_cv). A human-applied tuned weight reaches the ensemble; the answer is seed-deterministic.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { clearMatchupMemo } from "../../src/mcp/tools/projection-v2.js";
import { envelopeViolations, identifierLeaks } from "../mcp/helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { seedDatasets } from "./helpers/seed.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
  current_week: number;
};

interface Week0 {
  week: number;
  points: { mean: number; p10: number; p90: number; basis: string; p_zero: number };
  p_active: number | null;
  inputs: { espn: number | null; own: number | null; weight_espn: number };
  disagreement: { pct: number | null; flagged: boolean };
}
interface Proj {
  player_id: number;
  position: string;
  weeks: Week0[];
  drivers: { name: string; contribution: number }[];
  assumptions: { text: string }[];
  stat_line_expectation?: Record<string, number>;
}
interface E1 {
  data: { model_version: string; projections: Proj[] };
  warnings: string[];
  meta: { estimate?: boolean };
}

let world: World;

beforeAll(async () => {
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: manifest.my_team_id,
    clock: manifest.clock,
    publishEspn: false,
  });
  await seedDatasets(world.store, {
    storePath: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    cache: world.cache,
    clock: world.clock,
    season: 2026,
  });
  world.store.reopenChangedDatasets();
  const c = await connect(world, { options: { toolset: "full" } });
  try {
    const r = await call(c.client, "espn_get_roster", {
      team_id: manifest.my_team_id,
      week: manifest.current_week,
    });
    rosterIds = (r.body.data as { players: { player_id: number }[] }).players.map(
      (p) => p.player_id,
    );
  } finally {
    await c.close();
  }
}, 300_000);
afterAll(() => {
  world.cleanup();
});

let rosterIds: number[] = [];

async function e1Once(
  toolset: "core" | "full",
  args: Record<string, unknown>,
  tuned: Readonly<Record<string, number>> | null,
): Promise<E1> {
  const c = await connect(world, {
    options: { toolset, ...(tuned === null ? {} : { tuned: { values: tuned, updated_at: null } }) },
  });
  try {
    const r = await call(c.client, "espn_project_players", {
      horizon: "week",
      seed: 7,
      ...args,
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    expect(envelopeViolations(r.body as never)).toEqual([]);
    expect(identifierLeaks(JSON.stringify(r.body))).toEqual([]);
    return r.body as unknown as E1;
  } finally {
    await c.close();
  }
}

/** My roster projected in chunks small enough that no answer is truncated by the C8 budget. */
async function e1(
  toolset: "core" | "full",
  args: Record<string, unknown> = {},
  tuned: Readonly<Record<string, number>> | null = null,
): Promise<E1> {
  clearMatchupMemo();
  const parts: E1[] = [];
  for (let i = 0; i < rosterIds.length; i += 5)
    parts.push(
      await e1Once(toolset, { players: { player_ids: rosterIds.slice(i, i + 5) }, ...args }, tuned),
    );
  for (const p of parts) expect(p.warnings.join(" ")).not.toMatch(/truncated/);
  const versions = new Set(parts.map((p) => p.data.model_version));
  return {
    data: {
      model_version: versions.has("v2-opportunity") ? "v2-opportunity" : "v1-ensemble",
      projections: parts.flatMap((p) => p.data.projections),
    },
    warnings: parts.flatMap((p) => p.warnings),
    meta: parts[0]?.meta ?? {},
  };
}

const MODELLED = new Set(["QB", "RB", "WR", "TE"]);

describe("espn_project_players: v2-opportunity under full on the seeded fixture league", () => {
  let core: E1;
  let full: E1;
  beforeAll(async () => {
    core = await e1("core");
    full = await e1("full");
  }, 120_000);

  it("core is unchanged: v1-ensemble, every week position_cv", () => {
    expect(core.data.model_version).toBe("v1-ensemble");
    for (const p of core.data.projections)
      for (const w of p.weeks) expect(w.points.basis).toBe("position_cv");
  });

  it("full serves v2 (player_sim) to the modelled positions; K and D/ST keep v1", () => {
    expect(full.data.model_version).toBe("v2-opportunity");
    expect(full.meta.estimate).toBe(true);
    expect(full.data.projections.length).toBe(rosterIds.length);
    const v2 = full.data.projections.filter((p) => p.weeks[0]?.points.basis === "player_sim");
    // the fixture league's rostered skill players carry three 2026 stat weeks (fixtures/fx10h-usage)
    expect(v2.length).toBeGreaterThanOrEqual(8);
    for (const p of v2) expect(MODELLED.has(p.position)).toBe(true);
    for (const p of full.data.projections) {
      if (!MODELLED.has(p.position)) expect(p.weeks[0]?.points.basis).toBe("position_cv");
      // a modelled player v2 did not serve says why (fixed vocabulary), never silently
      else if (p.weeks[0]?.points.basis !== "player_sim")
        expect(p.assumptions.map((a) => a.text).join(" ")).toMatch(
          /v2-opportunity did not model this player \((bye|no_history|no_gsis_id|no_nfl_team|inputs_not_loaded|no_team|position_not_modelled)\)/,
        );
    }
  });

  it("ESPN's mean stays the point estimate (weight_espn 1.0) and the labels are unchanged", () => {
    const byId = new Map(core.data.projections.map((p) => [p.player_id, p]));
    let checked = 0;
    for (const p of full.data.projections) {
      const w = p.weeks[0];
      const c = byId.get(p.player_id)?.weeks[0];
      if (w === undefined || c === undefined || w.points.basis !== "player_sim") continue;
      checked += 1;
      expect(w.inputs.espn).toBe(c.inputs.espn);
      // no ESPN projection: the opportunity model's own mean is the estimate (weight 0), said so
      if (w.inputs.espn === null) {
        expect(w.inputs.weight_espn).toBe(0);
        expect(p.assumptions.map((a) => a.text)).toContain(
          "no ESPN projection: the opportunity model's own mean is the estimate",
        );
        continue;
      }
      expect(w.inputs.weight_espn).toBe(1);
      if (w.points.mean > 0)
        expect(Math.abs(w.points.mean - w.inputs.espn)).toBeLessThanOrEqual(0.051);
      expect(w.points.p10).toBeLessThanOrEqual(w.points.mean);
      expect(w.points.p90).toBeGreaterThanOrEqual(w.points.p10);
      if (w.inputs.espn > 0) expect(p.drivers.map((d) => d.name)).toContain("espn_projection");
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("is seed-deterministic", async () => {
    const again = await e1("full");
    expect(again.data.projections).toEqual(full.data.projections);
  });

  it("include_stat_line carries v2's expected counts for the v2-served players", async () => {
    const r = await e1("full", { include_stat_line: true, detail: "full" });
    const p = r.data.projections.find((x) => x.weeks[0]?.points.basis === "player_sim");
    expect(p?.stat_line_expectation).toBeDefined();
    const keys = Object.keys(p?.stat_line_expectation ?? {});
    expect(keys).toEqual(expect.arrayContaining(["pass_att", "targets", "rush_att"]));
  });

  it("a human-applied tuned weight_espn reaches the ensemble (eff tune --apply → next start)", async () => {
    const r = await e1("full", {}, { weight_espn: 0.75 });
    const p = r.data.projections.find(
      (x) =>
        x.weeks[0]?.points.basis === "player_sim" &&
        x.weeks[0].inputs.espn !== null &&
        x.weeks[0].inputs.own !== null &&
        x.weeks[0].inputs.espn > 0,
    );
    const w = p?.weeks[0];
    expect(w?.inputs.weight_espn).toBe(0.75);
    const espn = w?.inputs.espn ?? null;
    const own = w?.inputs.own ?? null;
    expect(espn).not.toBeNull();
    if (espn !== null && own !== null)
      expect(w?.points.mean).toBeCloseTo(0.75 * espn + 0.25 * own, 0);
  });
});
