// league-keepers.test.ts — espn_get_league restates the keeper setting and says a keeper league
// (plan 07 A1 `league.keepers`; research 03 §B.1 `draftSettings`; research 05 §5: keeper value is
// not modelled). Stage C live finding F6: the digest restated every other item of the owner's format
// and no keeper field at all, so a keeper league went unnoticed — two of the three recorded public
// leagues keep players. Fixture mode on fx-10h (a redraft league); the keeper setting of a keeper
// league is served through the platform the tool reads.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { keeperLeagueWarning } from "../../src/mcp/tools/league.js";
import type { League, Stamped } from "../../src/providers/platform.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const TEAM = (
  JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as { my_team_id: number }
).my_team_id;

interface DigestBody {
  data: { league?: { keepers: unknown }; rules?: unknown };
  warnings: string[];
}
const keeperLines = (b: DigestBody): string[] =>
  b.warnings.filter((w) => w.startsWith("keeper league"));

describe("espn_get_league restates keepers (Stage C live finding F6)", () => {
  it("the warning: a keeper league this season or next; none in a redraft league or unstated", () => {
    expect(keeperLeagueWarning({ count: 0, count_next_season: 0, deadline: null })).toBeNull();
    expect(
      keeperLeagueWarning({ count: null, count_next_season: null, deadline: null }),
    ).toBeNull();
    expect(keeperLeagueWarning({ count: 2, count_next_season: 0, deadline: null })).toBe(
      "keeper league (2 kept per team this season, 0 next season): every value this server gives is for this season only — keeper value is not modelled (trades, drops and waiver claims leave out what a player is worth next season)",
    );
    expect(keeperLeagueWarning({ count: 0, count_next_season: 3, deadline: null })).toContain(
      "(0 kept per team this season, 3 next season)",
    );
    expect(keeperLeagueWarning({ count: null, count_next_season: 1, deadline: null })).toContain(
      "(unknown kept per team this season, 1 next season)",
    );
  });

  it("fx-10h, a redraft league: keepers 0 and 0, and no keeper warning", async () => {
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX },
      teamId: TEAM,
      publishEspn: false,
    });
    try {
      const c = await connect(world);
      const r = await call(c.client, "espn_get_league", {});
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const b = r.body as unknown as DigestBody;
      expect(b.data.league?.keepers).toEqual({ count: 0, count_next_season: 0, deadline: null });
      expect(keeperLines(b)).toEqual([]);
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);

  it("a keeper league: restated, and said whichever sections are asked", async () => {
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX },
      teamId: TEAM,
      publishEspn: false,
    });
    const keepers = { count: 2, count_next_season: 2, deadline: "2026-09-01T16:00:00.000Z" };
    try {
      const s = faulty(world.services, {
        getLeague: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<League>;
          return { ...got, value: { ...got.value, keepers } };
        },
      });
      const c = await connect(world, { services: s });
      const all = await call(c.client, "espn_get_league", {});
      expect(all.isError, JSON.stringify(all.body).slice(0, 300)).toBe(false);
      const b = all.body as unknown as DigestBody;
      expect(b.data.league?.keepers).toEqual(keepers);
      expect(keeperLines(b)).toEqual([keeperLeagueWarning(keepers)]);
      // a call without the league section still learns it
      const rulesOnly = await call(c.client, "espn_get_league", { include: ["rules"] });
      expect(rulesOnly.isError).toBe(false);
      const rb = rulesOnly.body as unknown as DigestBody;
      expect(rb.data.league).toBeUndefined();
      expect(keeperLines(rb)).toHaveLength(1);
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);
});
