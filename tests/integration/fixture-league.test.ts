// fixture-league.test.ts — fixture mode over a derived fixture league (src/providers/espn/
// fixture-league.ts; plan 05 §3 fixture law class 2; plan 10 A3a): manifest reading and the league's
// frozen clock, the RFC 6902 subset a variant is stored as (prototype-safe), the kona_player_info
// pool emulation (filters, the provider's sorts, paging, split trimming), view routing by season /
// period / composition, the mBoxscore and mTransactions2 filters, and the guards the recorded fixture
// fetch has (no cookie, no path outside the root, unanswerable requests named, no network).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyJsonPatch,
  createDerivedLeagueFetch,
  derivedLeagueClock,
  poolQuery,
  readDerivedManifest,
} from "../../src/providers/espn/fixture-league.js";
import { FixtureError } from "../../src/providers/espn/fixture.js";
import {
  playerFilter,
  scheduleFilter,
  sortTerms,
  transactionsFilter,
} from "../../src/providers/espn/filter.js";
import { resolveFixtureDir } from "../../src/providers/espn/index.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
const LEAGUE = `${BASE}/2026/segments/0/leagues/0`;

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
function tempTree(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eff-fxl-"));
  tmp.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const fetchFx = createDerivedLeagueFetch({ dir: FX });
async function get(
  url: string,
  filter?: string,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const r = await fetchFx(
    url,
    filter === undefined ? {} : { headers: { "X-Fantasy-Filter": filter } },
  );
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
    headers: r.headers,
  };
}

describe("manifest and clock", () => {
  it("reads the fx-10h manifest; a recorded or absent directory is not derived", () => {
    const m = readDerivedManifest(FX);
    expect(m?.kind).toBe("derived_league");
    expect(m?.league).toBe("fx-10h");
    expect(m?.views.length).toBeGreaterThan(20);
    expect(readDerivedManifest(path.join(ROOT, "fixtures", "espn"))).toBeNull();
    expect(readDerivedManifest(path.join(ROOT, "no-such-dir"))).toBeNull();
  });

  it("the league's frozen instant is Tuesday of week 5, 21:00 ET; variants carry their own", () => {
    expect(derivedLeagueClock(FX)).toBe(Date.parse("2026-10-07T01:00:00.000Z"));
    expect(derivedLeagueClock(path.join(FX, "post-run"))).toBe(
      Date.parse("2026-10-07T10:00:00.000Z"),
    );
    expect(derivedLeagueClock(path.join(FX, "sunday-live"))).toBe(
      Date.parse("2026-10-11T18:05:00.000Z"),
    );
    expect(derivedLeagueClock(path.join(ROOT, "fixtures", "espn"))).toBeNull();
    const bad = tempTree({
      "manifest.json": { kind: "derived_league", clock: "not a date", views: [] },
    });
    expect(derivedLeagueClock(bad)).toBeNull();
    const none = tempTree({ "manifest.json": { kind: "derived_league", views: [] } });
    expect(derivedLeagueClock(none)).toBeNull();
  });

  it("resolveFixtureDir: derived for fx-10h and its variants, recorded otherwise", () => {
    expect(resolveFixtureDir(FX)).toEqual({ dir: FX, league: "fx-10h", kind: "derived" });
    expect(resolveFixtureDir(path.join(FX, "k10"))?.kind).toBe("derived");
    expect(resolveFixtureDir(path.join(ROOT, "fixtures", "espn"))?.kind).toBeUndefined();
    expect(resolveFixtureDir("relative/dir")).toBeNull();
  });

  it("a malformed manifest's fields fall back to safe defaults", () => {
    const dir = tempTree({
      "manifest.json": {
        kind: "derived_league",
        views: [{ route: "x", views: [1, "mNav"] }, "junk"],
      },
    });
    const m = readDerivedManifest(dir);
    expect(m?.league).toBe("derived");
    expect(m?.root).toBe(".");
    expect(m?.views).toEqual([
      { route: "league", season: 0, views: ["mNav"], scoringPeriodId: null, path: "" },
    ]);
  });
});

describe("applyJsonPatch (RFC 6902 subset)", () => {
  const doc = { a: { b: [1, 2, 3] }, c: "x" };

  it("adds, removes and replaces object keys and array items; the input is never mutated", () => {
    const out = applyJsonPatch(doc, [
      { op: "add", path: "/a/d", value: { e: 1 } },
      { op: "replace", path: "/c", value: "y" },
      { op: "remove", path: "/a/b/0" },
      { op: "add", path: "/a/b/-", value: 9 },
      { op: "add", path: "/a/b/0", value: 0 },
      { op: "replace", path: "/a/b/1", value: 7 },
    ]);
    expect(out).toEqual({ a: { b: [0, 7, 3, 9], d: { e: 1 } }, c: "y" });
    expect(doc).toEqual({ a: { b: [1, 2, 3] }, c: "x" });
  });

  it("takes a path as segments too (the generator's form): keys and array indices", () => {
    expect(
      applyJsonPatch(doc, [
        { op: "replace", path: ["a", "b", 1], value: 5 },
        { op: "add", path: ["a", "b", "-"], value: 6 },
        { op: "add", path: ["home"], value: { side: true } },
      ]),
    ).toEqual({ a: { b: [1, 5, 3, 6] }, c: "x", home: { side: true } });
    expect(applyJsonPatch(doc, [{ op: "replace", path: [], value: 1 }])).toBe(1);
    for (const bad of [
      ["a", -1],
      ["a", 1.5],
      ["a", null],
      ["__proto__", "x"],
    ])
      expect(() => applyJsonPatch(doc, [{ op: "add", path: bad, value: 1 }])).toThrow(RangeError);
    expect(() => applyJsonPatch(doc, [{ op: "add", path: 7, value: 1 }])).toThrow(RangeError);
  });

  it("unescapes ~0 and ~1, replaces the root, and removes a key", () => {
    expect(
      applyJsonPatch({ "a/b": 1, "c~d": 2 }, [
        { op: "remove", path: "/a~1b" },
        { op: "replace", path: "/c~0d", value: 3 },
      ]),
    ).toEqual({ "c~d": 3 });
    expect(applyJsonPatch({ a: 1 }, [{ op: "replace", path: "", value: [1] }])).toEqual([1]);
  });

  it.each<[string, unknown]>([
    ["ops not an array", { op: "add" }],
    ["an op without a path", [{ op: "add" }]],
    ["an op that is not an object", [7]],
    ["an unsupported op", [{ op: "move", path: "/a", from: "/c" }]],
    ["a pointer without a leading slash", [{ op: "remove", path: "a" }]],
    ["a __proto__ segment", [{ op: "add", path: "/__proto__/polluted", value: 1 }]],
    ["a constructor segment", [{ op: "add", path: "/constructor/prototype", value: 1 }]],
    ["a prototype segment", [{ op: "replace", path: "/a/prototype", value: 1 }]],
    ["an index past the end", [{ op: "replace", path: "/a/b/3", value: 1 }]],
    ["a non-numeric index", [{ op: "remove", path: "/a/b/x" }]],
    ["a leading-zero index", [{ op: "remove", path: "/a/b/01" }]],
    ["a missing parent", [{ op: "add", path: "/zz/yy", value: 1 }]],
    ["a missing key to replace", [{ op: "replace", path: "/zz", value: 1 }]],
    ["a missing key to remove", [{ op: "remove", path: "/a/zz" }]],
    ["removing the root", [{ op: "remove", path: "" }]],
    ["add without a value", [{ op: "add", path: "/q" }]],
    ["a path through a scalar", [{ op: "add", path: "/c/x", value: 1 }]],
    ["a path through an array item that is a scalar", [{ op: "add", path: "/a/b/0/x", value: 1 }]],
  ])("refuses %s", (_, ops) => {
    expect(() => applyJsonPatch(doc, ops)).toThrow(RangeError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("the pool (kona_player_info)", () => {
  const entry = (
    id: number,
    status: string,
    owned: number,
    changed: number,
    slots: number[],
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    status,
    player: {
      id,
      active: true,
      eligibleSlots: slots,
      ownership: { percentOwned: owned, percentChange: changed },
      draftRanksByRankType: { STANDARD: { rank: 100 - id } },
      stats: [
        { scoringPeriodId: 0, statSourceId: 1, statSplitTypeId: 0, appliedTotal: id * 10 },
        { scoringPeriodId: 0, statSourceId: 0, statSplitTypeId: 0, appliedTotal: id },
        { scoringPeriodId: 4, statSourceId: 1, statSplitTypeId: 1, appliedTotal: 20 - id },
        { scoringPeriodId: 5, statSourceId: 1, statSplitTypeId: 1, appliedTotal: id },
        { scoringPeriodId: 2, statSourceId: 0, statSplitTypeId: 1, appliedTotal: 1 },
      ],
      ...extra,
    },
  });
  const pool = {
    response: { positionAgainstOpponent: null },
    entries: [
      entry(1, "WAIVERS", 50, 1, [2, 23]),
      entry(2, "FREEAGENT", 70, -3, [4, 23]),
      entry(3, "ONTEAM", 90, 5, [0]),
      entry(4, "WAIVERS", 10, 9, [17], { active: false }),
      entry(5, "WAIVERS", 50, 0, [2]),
    ],
  };
  const q = (spec: Parameters<typeof playerFilter>[0], sp: number | null = 5) =>
    poolQuery(pool, JSON.parse(playerFilter(spec, "league")) as unknown, sp, 2026);
  const ids = (r: ReturnType<typeof q>) => (r.body.players as { id: number }[]).map((p) => p.id);

  it("filters by status and slot, and sorts by % owned with the draft-rank tie-break", () => {
    const r = q({
      filterStatus: ["FREEAGENT", "WAIVERS"],
      filterSlotIds: [2, 23],
      limit: 10,
      offset: 0,
      sorts: sortTerms("percOwned", 2026, 5),
    });
    expect(ids(r)).toEqual([2, 5, 1]);
    expect(r.total).toBe(3);
  });

  it("filterIds, filterActive, paging and every provider sort key", () => {
    expect(ids(q({ filterIds: [3, 1, 99] }))).toEqual([1, 3]);
    expect(
      ids(q({ filterActive: true, limit: 100, sorts: sortTerms("percChanged", 2026, 5) })),
    ).toEqual([3, 1, 5, 2]);
    expect(ids(q({ limit: 2, offset: 1, sorts: sortTerms("projection_week", 2026, 5) }))).toEqual([
      4, 3,
    ]);
    expect(ids(q({ limit: 5, sorts: sortTerms("projection_ros", 2026, 5) }))).toEqual([
      5, 4, 3, 2, 1,
    ]);
    expect(ids(q({ limit: 5, sorts: sortTerms("draftRank", 2026, 5) }))).toEqual([5, 4, 3, 2, 1]);
    const season = poolQuery(
      pool,
      { players: { sortAppliedStatTotal: { sortAsc: true, sortPriority: 1, value: "002026" } } },
      null,
      2026,
    );
    expect(ids(season)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the season splits and weeks sp-1 and sp; all splits without a period", () => {
    const one = (r: ReturnType<typeof q>) =>
      (
        (r.body.players as { player: { stats: { scoringPeriodId: number }[] } }[])[0]?.player
          .stats ?? []
      ).map((s) => s.scoringPeriodId);
    expect(one(q({ filterIds: [1] }, 5))).toEqual([0, 0, 4, 5]);
    expect(one(q({ filterIds: [1] }, null))).toEqual([0, 0, 4, 5, 2]);
  });

  it("an unsupported sort is a FixtureError, never a silent order", () => {
    expect(() =>
      poolQuery(
        pool,
        { players: { sortSomethingNew: { sortAsc: true, sortPriority: 1 } } },
        5,
        2026,
      ),
    ).toThrow(FixtureError);
    expect(() =>
      poolQuery(
        pool,
        { players: { sortAppliedStatTotal: { sortAsc: true, sortPriority: 1, value: "992026" } } },
        5,
        2026,
      ),
    ).toThrow(FixtureError);
  });

  it("tolerates odd entries: no player, no stats, no ownership", () => {
    const odd = {
      response: {},
      entries: [
        { id: 7, status: "WAIVERS" },
        { id: 8, status: "WAIVERS", player: { stats: "x" } },
      ],
    };
    const r = poolQuery(odd, { players: { filterSlotIds: { value: [2] } } }, 5, 2026);
    expect(r.total).toBe(0);
    const s = poolQuery(
      odd,
      {
        players: {
          sortPercOwned: { sortAsc: false, sortPriority: 1 },
          sortAppliedStatTotal: { sortAsc: false, sortPriority: 2, value: "1120265" },
          limit: 5,
        },
      },
      5,
      2026,
    );
    expect((s.body.players as unknown[]).length).toBe(2);
  });
});

describe("routing over fx-10h", () => {
  it("serves a league view by scoring period, and a period-less view for any period", async () => {
    const r = await get(`${LEAGUE}?view=mRoster&scoringPeriodId=5`);
    expect(r.status).toBe(200);
    expect(r.body.scoringPeriodId).toBe(5);
    expect(r.headers.get("content-type")).toContain("application/json");
    const s = await get(`${LEAGUE}?view=mSettings&scoringPeriodId=5`);
    expect((s.body.settings as { name: string }).name).toBe("Example League");
  });

  it("composes a composite request from its views (mSettings+mNav), and serves mTeam+mStandings whole", async () => {
    const r = await get(`${LEAGUE}?view=mSettings&view=mNav`);
    expect(r.body.members).toBeDefined();
    expect((r.body.settings as Record<string, unknown>).scoringSettings).toBeDefined();
    const t = await get(`${LEAGUE}?view=mStandings&view=mTeam`);
    expect((t.body.teams as unknown[]).length).toBe(10);
    const one = await get(`${LEAGUE}?view=mTeam`);
    expect((one.body.teams as unknown[]).length).toBe(10);
  });

  it("mBoxscore honours its matchup-period filter", async () => {
    const r = await get(`${LEAGUE}?view=mBoxscore&scoringPeriodId=4`, scheduleFilter([4]));
    expect((r.body.schedule as unknown[]).length).toBe(5);
    const none = await get(`${LEAGUE}?view=mBoxscore&scoringPeriodId=4`, scheduleFilter([3]));
    expect(none.body.schedule).toEqual([]);
  });

  it("mTransactions2 honours its type filter and period, with the count header", async () => {
    const all = await get(
      `${LEAGUE}?view=mTransactions2`,
      transactionsFilter(["WAIVER", "WAIVER_ERROR", "FREEAGENT"]),
    );
    const n = (all.body.transactions as unknown[]).length;
    expect(n).toBeGreaterThan(0);
    expect(all.headers.get("x-fantasy-filter-transaction-count")).toBe(String(n));
    const err = await get(`${LEAGUE}?view=mTransactions2`, transactionsFilter(["WAIVER_ERROR"]));
    expect(
      (err.body.transactions as { type: string }[]).every((t) => t.type === "WAIVER_ERROR"),
    ).toBe(true);
    const wk = await get(
      `${LEAGUE}?view=mTransactions2&scoringPeriodId=3`,
      transactionsFilter(["WAIVER", "FREEAGENT"]),
    );
    expect(
      (wk.body.transactions as { scoringPeriodId: number }[]).every((t) => t.scoringPeriodId === 3),
    ).toBe(true);
    const unfiltered = await get(`${LEAGUE}?view=mTransactions2`);
    expect((unfiltered.body.transactions as unknown[]).length).toBe(n);
  });

  it("kona_player_info answers from the pool with the player count header", async () => {
    const f = playerFilter(
      { filterStatus: ["WAIVERS"], limit: 25, offset: 0, sorts: sortTerms("percOwned", 2026, 5) },
      "league",
    );
    const r = await get(`${LEAGUE}?view=kona_player_info&scoringPeriodId=5`, f);
    expect((r.body.players as unknown[]).length).toBe(25);
    expect(Number(r.headers.get("x-fantasy-filter-player-count"))).toBeGreaterThan(25);
  });

  it("serves the season views and last season's standings", async () => {
    const s = await get(`${BASE}/2026?view=proTeamSchedules_wl`);
    expect((s.body.settings as { proTeams: unknown[] }).proTeams.length).toBe(33);
    const p = await fetchFx(`${BASE}/2026/players?view=players_wl`, {});
    expect(Array.isArray(await p.json())).toBe(true);
    const last = await get(`${BASE}/2025/segments/0/leagues/0?view=mTeam&view=mStandings`);
    expect(last.body.seasonId).toBe(2025);
  });

  it("answers never change the shared bodies: a filtered or trimmed answer, then the whole one", async () => {
    // a fresh fetch, so this test reads the files itself (its own cache)
    const f = createDerivedLeagueFetch({ dir: FX });
    const json = async (url: string, filter?: string) =>
      (await (
        await f(url, filter === undefined ? {} : { headers: { "X-Fantasy-Filter": filter } })
      ).json()) as Record<string, unknown>;
    const box = `${LEAGUE}?view=mBoxscore&scoringPeriodId=4`;
    const n = ((await json(box)).schedule as unknown[]).length;
    expect(n).toBeGreaterThan(0);
    expect((await json(box, scheduleFilter([3]))).schedule).toEqual([]);
    expect(((await json(box)).schedule as unknown[]).length).toBe(n);
    const tx = `${LEAGUE}?view=mTransactions2`;
    const all = ((await json(tx)).transactions as unknown[]).length;
    await json(tx, transactionsFilter(["WAIVER_ERROR"]));
    expect(((await json(tx)).transactions as unknown[]).length).toBe(all);
    // a trimmed pool page keeps weeks sp−1, sp and the season; the pool itself keeps every week
    interface Page {
      players: { id: number; player: { stats: { scoringPeriodId: number }[] } }[];
    }
    const page = (sp: string) =>
      json(
        `${LEAGUE}?view=kona_player_info${sp}`,
        playerFilter(
          { filterStatus: ["ONTEAM"], limit: 1, offset: 0, sorts: sortTerms("percOwned", 2026, 5) },
          "league",
        ),
      ) as unknown as Promise<Page>;
    const periods = (p: Page) => new Set(p.players[0]?.player.stats.map((x) => x.scoringPeriodId));
    const before = periods(await page(""));
    const trimmed = periods(await page("&scoringPeriodId=5"));
    expect([...trimmed].every((x) => [0, 4, 5].includes(x))).toBe(true);
    expect(before.size).toBeGreaterThan(trimmed.size);
    expect(periods(await page(""))).toEqual(before);
  });

  it("the fetch yields to the event loop between its phases (plan 10 A16a: as real I/O would)", async () => {
    const f = createDerivedLeagueFetch({ dir: FX });
    let turns = 0;
    let done = false;
    const spin = (): void => {
      if (done) return;
      turns += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    // a cold read (file, parse, answer) and a warm one (answer) each give up the loop
    const cold = await f(`${LEAGUE}?view=mRoster&scoringPeriodId=5`, {});
    const atCold = turns;
    const warm = await f(`${LEAGUE}?view=mRoster&scoringPeriodId=5`, {});
    done = true;
    expect([cold.status, warm.status]).toEqual([200, 200]);
    expect(atCold).toBeGreaterThanOrEqual(3);
    expect(turns - atCold).toBeGreaterThanOrEqual(1);
  });

  it("a variant serves the base body plus its patch", async () => {
    const k10 = createDerivedLeagueFetch({ dir: path.join(FX, "k10") });
    const r = await k10(`${LEAGUE}?view=mTeam&view=mStandings`, {});
    const teams = ((await r.json()) as { teams: { id: number; waiverRank: number }[] }).teams;
    expect(teams.find((t) => t.id === 2)?.waiverRank).toBe(10);
  });

  it.each<[string, string | undefined]>([
    ["an unknown view", `${LEAGUE}?view=mPositionalRatings&scoringPeriodId=5`],
    ["a league request with no view", LEAGUE],
    ["the board route", `${LEAGUE}/communication/?view=kona_league_communication`],
    ["a season without data", `${BASE}/2019?view=proTeamSchedules_wl`],
    ["the players route of another season", `${BASE}/2019/players?view=players_wl`],
    ["an unknown path", "https://lm-api-reads.fantasy.espn.com/somewhere"],
    ["a composite with an unknown view", `${LEAGUE}?view=mSettings&view=mDraftDetail`],
    ["kona of a season without a pool", `${BASE}/2025/segments/0/leagues/0?view=kona_player_info`],
  ])("refuses %s as fixture_missing", async (_, url) => {
    await expect(fetchFx(url ?? "", {})).rejects.toMatchObject({
      name: "FixtureError",
      effDetails: { reason: "fixture_missing" },
    });
  });

  it("refuses a Cookie header in every header shape, and an unparsable filter", async () => {
    for (const headers of [
      { Cookie: "x=1" },
      new Headers({ cookie: "x=1" }),
      [["COOKIE", "x=1"]] as [string, string][],
    ])
      await expect(fetchFx(`${LEAGUE}?view=mSettings`, { headers })).rejects.toMatchObject({
        effDetails: { reason: "fixture_cookie_refused" },
      });
    await expect(
      fetchFx(`${LEAGUE}?view=kona_player_info`, { headers: { "x-fantasy-filter": "{not json" } }),
    ).rejects.toMatchObject({ effDetails: { reason: "fixture_missing" } });
  });
});

describe("guards", () => {
  it("refuses a relative directory and a directory that is not a derived league", () => {
    expect(() => createDerivedLeagueFetch({ dir: "fixtures/espn/fx-10h" })).toThrow(RangeError);
    expect(() => createDerivedLeagueFetch({ dir: path.join(ROOT, "fixtures", "espn") })).toThrow(
      RangeError,
    );
  });

  it("never reads a path outside the manifest's root, absolute, or with ..", async () => {
    const outside = tempTree({ "secret.json": { leaked: true } });
    const dir = tempTree({
      "league/manifest.json": {
        kind: "derived_league",
        season: 2026,
        root: ".",
        views: [
          {
            route: "league",
            season: 2026,
            views: ["mSettings"],
            scoringPeriodId: null,
            path: "../secret.json",
          },
          {
            route: "league",
            season: 2026,
            views: ["mNav"],
            scoringPeriodId: null,
            path: path.join(outside, "secret.json"),
          },
          { route: "league", season: 2026, views: ["mTeam"], scoringPeriodId: null, path: "" },
          {
            route: "league",
            season: 2026,
            views: ["mMatchup"],
            scoringPeriodId: null,
            path: "x.json",
            patch: "../p.json",
          },
          {
            route: "league",
            season: 2026,
            views: ["mPendingTransactions"],
            scoringPeriodId: null,
            path: "broken.json",
          },
        ],
      },
      "league/x.json": { a: 1 },
      "league/broken.json": "{ not json",
    });
    const f = createDerivedLeagueFetch({ dir: path.join(dir, "league") });
    for (const v of ["mSettings", "mNav", "mTeam", "mMatchup", "mPendingTransactions"])
      await expect(f(`${LEAGUE}?view=${v}`, {})).rejects.toMatchObject({ name: "FixtureError" });
  });
});
