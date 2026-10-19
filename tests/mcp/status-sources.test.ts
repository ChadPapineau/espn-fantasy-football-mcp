// status-sources.test.ts — espn_get_status and espn-ff://status/freshness list the configured dataset
// sources exactly as `eff status` does (plan 07 G1; the Step 0 snapshot every Skill reads). Stage C
// finding status-phase2-sources-missing: the model-facing status kept only the Phase-1 registry rows
// — both weather sources whatever EFF_WEATHER_SOURCE said, never a Phase-2 source — so under
// EFF_TOOLSET=full a stale pbp, snap-count, depth-chart, Sleeper or news feed the P1 tools depend on
// never showed, while `eff status` listed all 17. Fixture mode, no network.
import { describe, expect, it } from "vitest";
import { configuredSources } from "../../src/cli/status.js";
import { statusSources } from "../../src/mcp/tools/ops.js";
import { call, connect, makeWorld } from "./helpers/world.js";

const PHASE_2 = [
  "nflverse:stats_team_week",
  "nflverse:pbp",
  "nflverse:snap_counts",
  "nflverse:depth_charts",
  "ffopportunity:ep_weekly",
  "sleeper:trending",
  "news:rotowire",
  "news:espn",
  "news:cbs",
];

describe("the configured sources (parity with eff status)", () => {
  it.each([
    ["core", "open-meteo"],
    ["core", "nws"],
    ["full", "open-meteo"],
    ["full", "nws"],
  ] as const)("toolset %s, weather %s: the same list in the same order", (toolset, weather) => {
    expect(statusSources({ toolset, weatherSource: weather })).toEqual(
      configuredSources({ toolset, weatherSource: weather }),
    );
  });
});

describe("espn_get_status and espn-ff://status/freshness at the tool level", () => {
  it("under full: every Phase-2 source, and only the configured weather source", async () => {
    const world = await makeWorld({ env: { EFF_TOOLSET: "full", EFF_WEATHER_SOURCE: "nws" } });
    try {
      const c = await connect(world, { options: { toolset: "full", weatherSource: "nws" } });
      const st = await call(c.client, "espn_get_status", {});
      expect(st.isError).toBe(false);
      const ids = (st.body.data as { sources: { id: string }[] }).sources.map((s) => s.id);
      expect(ids).toEqual(expect.arrayContaining(PHASE_2));
      expect(ids).toContain("weather:nws");
      expect(ids).not.toContain("weather:open_meteo");
      expect(ids).toHaveLength(17);
      const raw = (await c.client.readResource({ uri: "espn-ff://status/freshness" })) as {
        contents: { text: string }[];
      };
      const res = JSON.parse(raw.contents[0]?.text ?? "{}") as {
        data: { sources: { id: string }[] };
      };
      expect(res.data.sources.map((s) => s.id)).toEqual(ids);
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);

  it("under core: no Phase-2 source, one weather source", async () => {
    const world = await makeWorld();
    try {
      const c = await connect(world);
      const st = await call(c.client, "espn_get_status", {});
      const ids = (st.body.data as { sources: { id: string }[] }).sources.map((s) => s.id);
      for (const p of PHASE_2) expect(ids).not.toContain(p);
      expect(ids.filter((i) => i.startsWith("weather:"))).toEqual(["weather:open_meteo"]);
      expect(ids).toHaveLength(8);
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);
});
