// roster-empty-tool.test.ts — Stage C round 2, finding analytics-empty-roster-validation, through the
// tools (plan 01 §4.3; plan 07 E2, E3, E5, E8, E9): a league renewed but not yet drafted answers
// every roster with no entries. The analytics tools refused it as VALIDATION ("The arguments are
// invalid … fix the arguments") with no field — though their arguments were valid — so a weekly or
// start-sit question in August sent the model to fix arguments it could not fix. Each now answers
// NOT_FOUND with reason `roster_empty`. The recorded league-b, its rosters emptied on the way in (the
// fixture fetch is wrapped, nothing on disk changes), under the full toolset. No network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

interface RosterBody {
  teams?: { roster?: { entries?: unknown[] } }[];
}

/** Every mRoster answer with every team's roster emptied (the league before its draft). */
function emptyRosters(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const res = await inner(url, init);
    const views = new URL(url).searchParams.getAll("view");
    if (!views.includes("mRoster") || res.status !== 200) return res;
    const body = (await res.json()) as RosterBody;
    for (const t of body.teams ?? []) if (t.roster !== undefined) t.roster.entries = [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json;charset=utf-8" },
    });
  };
}

let world: World | undefined;
let conn: { client: Client; close: () => Promise<void> } | undefined;

beforeAll(async () => {
  world = await makeWorld({
    league: "league-b",
    env: { EFF_TOOLSET: "full" },
    wrapFetch: emptyRosters,
  });
  conn = await connect(world);
}, 120_000);

afterAll(async () => {
  await conn?.close();
  world?.cleanup();
});

describe("before the draft: the analytics tools answer roster_empty, never VALIDATION", () => {
  it("the roster read itself is empty (the precondition)", async () => {
    const r = await call(conn!.client, "espn_get_roster", {});
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect((r.body.data as { players: unknown[] }).players).toEqual([]);
  });

  for (const tool of [
    "espn_analyze_lineup",
    "espn_analyze_waivers",
    "espn_analyze_roster",
    "espn_analyze_matchup",
    "espn_analyze_schedule",
  ])
    it(`${tool} {}: NOT_FOUND, reason roster_empty`, async () => {
      const r = await call(conn!.client, tool, {});
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(true);
      const err = (r.body as { error: Record<string, unknown> }).error;
      expect(err.code).toBe("NOT_FOUND");
      expect(err.reason).toBe("roster_empty");
      expect(err.hint).not.toMatch(/fix the arguments/);
    }, 120_000);
});
