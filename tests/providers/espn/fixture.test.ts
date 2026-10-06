// fixture.test.ts — src/providers/espn/fixture.ts, fixture mode's transport (plan 05 §3.1 step 5):
// serves the recorded fixtures by path + views + scoringPeriodId + canonical filter with the recorded
// status and headers; re-assembles split responses; composes a composite request from solo
// recordings (views compose additively — research 03 §A.2); a missing fixture is a distinct error
// naming the path; a cookie-bearing request is refused (fixture mode and real cookies never coexist).
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeBodies,
  createFixtureFetch,
  FixtureError,
} from "../../../src/providers/espn/fixture.js";
import { FIXTURES, loadRoster } from "./helpers.js";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026";
const league = `${BASE}/segments/0/leagues/0`;

describe("createFixtureFetch", () => {
  const f = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  it("serves a recorded response with its status and headers", async () => {
    const r = await f(`${league}?view=mTeam&view=mStandings`, { headers: {} });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(((await r.json()) as { teams: unknown[] }).teams).toHaveLength(10);
  });
  it("re-assembles a split response (mRoster parts) and caches the body", async () => {
    const r = await f(`${league}?view=mRoster&scoringPeriodId=1`, {});
    const body = (await r.json()) as { teams: { id: number }[] };
    expect(body.teams.map((t) => t.id)).toEqual(
      (loadRoster("league-a", 1).teams as { id: number }[]).map((t) => t.id),
    );
    const again = (await (await f(`${league}?view=mRoster&scoringPeriodId=1`, {})).json()) as {
      teams: unknown[];
    };
    expect(again.teams).toHaveLength(body.teams.length);
  });
  it("matches the filter canonically (key order free); headers given as Headers or pairs", async () => {
    const filter = '{"filterActive":{"value":true}}';
    const a = await f(`${BASE}/players?view=players_wl`, {
      headers: new Headers({ "X-Fantasy-Filter": filter }),
    });
    expect(a.status).toBe(200);
    const b = await f(`${league}?view=mBoxscore&scoringPeriodId=3`, {
      headers: [["x-fantasy-filter", '{"schedule":{"filterMatchupPeriodIds":{"value":[3]}}}']],
    });
    expect(b.status).toBe(200);
  });
  it("composes a composite request from solo recordings (mSettings + mNav)", async () => {
    const r = await f(`${league}?view=mSettings&view=mNav`, {});
    const body = (await r.json()) as {
      settings: Record<string, unknown>;
      members: { isLeagueCreator: boolean }[];
    };
    expect(body.settings.scoringSettings).toBeDefined();
    expect(body.members[0]).toHaveProperty("isLeagueCreator");
  });
  it("a missing fixture is a distinct INTERNAL error naming the request path", async () => {
    const e = await f(`${league}?view=mDraftDetail`, {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FixtureError);
    expect((e as FixtureError).effDetails.reason).toBe("fixture_missing");
    expect((e as Error).message).toContain("/leagues/0?view=mDraftDetail");
    await expect(f(`${league}?view=mTeam&view=mDraftDetail`, {})).rejects.toBeInstanceOf(
      FixtureError,
    );
    await expect(
      f(`${league}?view=mSettings&view=mNav`, { headers: { "x-fantasy-filter": "{}" } }),
    ).rejects.toBeInstanceOf(FixtureError);
    await expect(
      f(`${league}?view=mRoster`, { headers: { "x-fantasy-filter": "not json" } }),
    ).rejects.toBeInstanceOf(FixtureError);
  });
  it("refuses a cookie-bearing request", async () => {
    const e = await f(`${league}?view=mTeam&view=mStandings`, { headers: { Cookie: "a=b" } }).catch(
      (x: unknown) => x,
    );
    expect((e as FixtureError).effDetails.reason).toBe("fixture_cookie_refused");
  });
  it("another league slot serves its own files; the error fixtures are never served", async () => {
    const c = createFixtureFetch({ dir: FIXTURES, league: "league-c" });
    const body = (await (await c(`${league}?view=mTeam&view=mStandings`, {})).json()) as {
      teams: unknown[];
    };
    expect(body.teams).toHaveLength(12);
  });
  it("needs an absolute directory", () => {
    expect(() => createFixtureFetch({ dir: "fixtures/espn", league: "league-a" })).toThrow(
      RangeError,
    );
    expect(() =>
      createFixtureFetch({ dir: path.resolve("/nonexistent-eff-dir"), league: "x" }),
    ).toThrow();
  });
});

describe("composeBodies (views compose additively)", () => {
  it("objects merge by key; id-keyed arrays merge by id; anything else keeps the first", () => {
    expect(
      composeBodies(
        { a: 1, s: { x: 1 }, teams: [{ id: 1, n: "a" }, { id: 2 }], list: [1, 2] },
        { b: 2, s: { y: 2 }, teams: [{ id: 2, o: ["g"] }, { id: 3 }], list: [3], a: 9 },
      ),
    ).toEqual({
      a: 1,
      b: 2,
      s: { x: 1, y: 2 },
      teams: [{ id: 1, n: "a" }, { id: 2, o: ["g"] }, { id: 3 }],
      list: [1, 2],
    });
    expect(composeBodies(1, 2)).toBe(1);
  });
});
