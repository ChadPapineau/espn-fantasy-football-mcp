// absent-season.test.ts — a past season ESPN has no league for is asked once per session (plan 01
// §5.6 politeness; plan 07 A1 seeding evidence). Stage C finding `espn-missing-season-404-not-cached`:
// the seeding evidence of a league in its first season sent three requests that 404 on EVERY call
// (the rules read, then the standings read and its settings read), each spending the 30/min window.
// Now the first "no such league" answer for a past season is remembered for the server process: the
// evidence stops after that one request, a repeat call sends none, and espn_get_league for that
// season answers ESPN_LEAGUE_NOT_FOUND without a request. The configured season is never remembered.
// Fixture world; the previous season's URLs answer ESPN's recorded 404 GENERAL_NOT_FOUND body.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { NO_PREVIOUS_SEASON_WARNING } from "../../src/mcp/tools/league.js";
import { ESPN_FIXTURES, SEASON, call, connect, makeWorld, type World } from "./helpers/world.js";

const NOT_FOUND = readFileSync(
  path.join(ESPN_FIXTURES, "recorded", "errors", "404-league-not-found.json"),
  "utf8",
);

const prevHits: string[] = [];
function notFoundBefore(season: number): (inner: FetchLike) => FetchLike {
  return (inner) => (url, init) => {
    const u = new URL(url);
    if (u.pathname.includes(`/seasons/${String(season)}/`)) {
      prevHits.push(u.searchParams.getAll("view").join(","));
      return Promise.resolve(
        new Response(NOT_FOUND, {
          status: 404,
          headers: { "content-type": "application/json;charset=utf-8" },
        }),
      );
    }
    return inner(url, init);
  };
}

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({ league: "league-b", wrapFetch: notFoundBefore(SEASON - 1) });
  ({ client, close } = await connect(world));
  expect((await call(client, "espn_get_league")).isError).toBe(false);
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("a season before the league's first is asked once (plan 07 A1)", () => {
  it("the first evidence call stops after one request and says why", async () => {
    const before = prevHits.length;
    const r = await call(client, "espn_get_league", { include: ["seeding", "seeding_evidence"] });
    expect(r.isError).toBe(false);
    expect(prevHits.length - before).toBe(1);
    expect(r.body.warnings as string[]).toContain(NO_PREVIOUS_SEASON_WARNING);
    expect((r.body.data as { seeding: { evidence: unknown } }).seeding.evidence).toBeNull();
  });

  it("a repeat call — on a new connection too — sends no request for that season", async () => {
    const before = prevHits.length;
    const r = await call(client, "espn_get_league", { include: ["seeding_evidence"] });
    expect(r.isError).toBe(false);
    const c2 = await connect(world);
    const r2 = await call(c2.client, "espn_get_league", { include: ["seeding_evidence"] });
    await c2.close();
    expect(r2.isError).toBe(false);
    expect(prevHits.length - before).toBe(0);
    expect(r2.body.warnings as string[]).toContain(NO_PREVIOUS_SEASON_WARNING);
  });

  it("espn_get_league for that season → ESPN_LEAGUE_NOT_FOUND with no request", async () => {
    const before = prevHits.length;
    const r = await call(client, "espn_get_league", { season: SEASON - 1 });
    expect(r.isError).toBe(true);
    expect((r.body.error as { code: string }).code).toBe("ESPN_LEAGUE_NOT_FOUND");
    expect(prevHits.length - before).toBe(0);
  });

  it("another past season is still asked (only what ESPN said is remembered)", async () => {
    const r = await call(client, "espn_get_league", { season: SEASON - 2 });
    // league-b's recording has no such season: the fixture refuses it, but a request was attempted
    expect(r.isError).toBe(true);
    expect((r.body.error as { code: string }).code).not.toBe("ESPN_LEAGUE_NOT_FOUND");
  });
});
