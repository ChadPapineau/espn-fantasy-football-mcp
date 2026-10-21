// season-renewal.test.ts — Stage C finding league-rollover-not-found-misdiagnosed, end to end. From
// July 1 an unset ESPN_SEASON is the new season (src/config/schema.ts defaultSeason), which ESPN
// serves for a league only once its manager renews it — until then every read 404s GENERAL_NOT_FOUND
// (research 03 §A.4) while last season still reads. Every tool answered that 404 with the table's
// "Check ESPN_LEAGUE_ID and ESPN_SEASON", and the Skills read the code as "the league id is wrong".
// Now, while seasonMayAwaitRenewal holds, the provider tags the 404 `season_not_renewed` with the
// fixed SEASON_RENEWAL_TEXT message and hint, which the MCP mapper shows — whether the season is
// unset or pinned to the new one (the finder's repro pins ESPN_SEASON=2027). Controls: the same 404
// after October 1, unset or pinned, and a past season's 404 keep the table's words.
// Fixture world (no network): the 2027 league URLs answer ESPN's recorded 404 body.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEASON_RENEWAL_TEXT } from "../../src/config/schema.js";
import { ERROR_TABLE } from "../../src/mcp/errors.js";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const NOT_FOUND = readFileSync(
  path.join(ESPN_FIXTURES, "recorded", "errors", "404-league-not-found.json"),
  "utf8",
);
const NEW_SEASON = 2027;

/** Every league URL of `season` answers ESPN's recorded 404 GENERAL_NOT_FOUND. */
function notRenewed(season: number): (inner: FetchLike) => FetchLike {
  return (inner) => (url, init) =>
    new URL(url).pathname.includes(`/seasons/${String(season)}/segments/0/leagues/`)
      ? Promise.resolve(
          new Response(NOT_FOUND, {
            status: 404,
            headers: { "content-type": "application/json;charset=utf-8" },
          }),
        )
      : inner(url, init);
}

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly reason?: string;
  readonly upstream_status?: number;
}

async function errorOf(client: Client, tool: string, args: Record<string, unknown> = {}) {
  const r = await call(client, tool, args);
  expect(r.isError, tool).toBe(true);
  return r.body.error as ErrorBody;
}

/** A world at `clock` whose league is not renewed for 2027; ESPN_SEASON unset unless given. */
async function worldAt(clock: string, season = ""): Promise<World> {
  return makeWorld({
    league: "league-b",
    clock,
    env: { ESPN_SEASON: season },
    wrapFetch: notRenewed(NEW_SEASON),
  });
}

describe.each([
  ["ESPN_SEASON unset", "", "default"],
  ["ESPN_SEASON=2027 (the finder's repro)", String(NEW_SEASON), "env"],
])("July, %s, the league not renewed yet: the tools name the state", (_label, season, origin) => {
  let world: World;
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    world = await worldAt("2027-07-15T15:00:00.000Z", season);
    expect(world.config.season).toBe(NEW_SEASON);
    expect(world.config.origins.ESPN_SEASON).toBe(origin);
    ({ client, close } = await connect(world));
  }, 120_000);
  afterAll(async () => {
    await close();
    world.cleanup();
  });

  it.each(["espn_get_league", "espn_get_roster", "espn_analyze_lineup"])(
    "%s: ESPN_LEAGUE_NOT_FOUND, reason season_not_renewed, the renewal message and hint",
    async (tool) => {
      const e = await errorOf(client, tool);
      expect(e.code).toBe("ESPN_LEAGUE_NOT_FOUND");
      expect(e.reason).toBe(SEASON_RENEWAL_TEXT.reason);
      expect(e.message).toBe(SEASON_RENEWAL_TEXT.message);
      expect(e.hint).toBe(SEASON_RENEWAL_TEXT.hint);
      expect(e.upstream_status).toBe(404);
      // the old words, which read as "the id is wrong", are gone from this state
      expect(e.hint).not.toBe(ERROR_TABLE.ESPN_LEAGUE_NOT_FOUND.hint);
    },
  );

  it("a past season's 404 is no renewal: the table's words, no reason", async () => {
    const e = await errorOf(client, "espn_get_league", { season: NEW_SEASON - 2 });
    // league-b's recorded seasons: the 2025 read is a fixture refusal or a 404 — either way never
    // the renewal state
    expect(e.reason).not.toBe(SEASON_RENEWAL_TEXT.reason);
    expect(e.hint).not.toBe(SEASON_RENEWAL_TEXT.hint);
  });
});

describe("the same 404 outside the renewal state keeps the table's words", () => {
  it.each([
    ["October, ESPN_SEASON unset", "2027-10-02T15:00:00.000Z", ""],
    ["October, ESPN_SEASON=2027", "2027-10-02T15:00:00.000Z", String(NEW_SEASON)],
  ])(
    "%s",
    async (_label, clock, season) => {
      const world = await worldAt(clock, season);
      const { client, close } = await connect(world);
      try {
        expect(world.config.season).toBe(NEW_SEASON);
        const e = await errorOf(client, "espn_get_league");
        expect(e.code).toBe("ESPN_LEAGUE_NOT_FOUND");
        expect(e.reason).toBeUndefined();
        expect(e.message).toBe(ERROR_TABLE.ESPN_LEAGUE_NOT_FOUND.message);
        expect(e.hint).toBe(ERROR_TABLE.ESPN_LEAGUE_NOT_FOUND.hint);
      } finally {
        await close();
        world.cleanup();
      }
    },
    120_000,
  );
});
