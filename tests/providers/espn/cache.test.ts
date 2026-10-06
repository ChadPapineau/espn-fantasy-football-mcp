// cache.test.ts — src/providers/espn/cache.ts (plan 01 §5.3; plan 05 §2 `providers/espn/cache`): the
// canonical key (view order, filter order → one entry), the class per view (a composite takes its
// strictest member), the PII strip (member names, notification settings, clientAddress never stored;
// owner GUIDs kept for own-team resolution; `__proto__` never copied), the force_refresh gate (once
// per 60 s per key) and the coalescer (N concurrent → one call).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FRESHNESS_TABLE } from "../../../src/config/freshness.js";
import {
  cacheKey,
  classForViews,
  Coalescer,
  ForceRefreshGate,
  serverTimeIso,
  stripForCache,
  UNCACHED_VIEWS,
  VIEW_FRESHNESS,
} from "../../../src/providers/espn/cache.js";
import { canonicalJson } from "../../../src/providers/espn/filter.js";
import { leagueTarget, seasonTarget } from "../../../src/providers/espn/path.js";
import { ESPN_VIEWS } from "../../../src/providers/espn/types.js";
import { loadFixture } from "./helpers.js";

const H = "lm-api-reads.fantasy.espn.com";

describe("cacheKey", () => {
  it("two spellings of one request are one key; any difference is another", () => {
    const a = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mStandings", "mTeam"],
    });
    const b = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mTeam", "mStandings"],
    });
    const f1 = canonicalJson({ players: { b: 1, a: 2 } });
    const f2 = canonicalJson({ players: { a: 2, b: 1 } });
    expect(cacheKey(a, "0", f1)).toBe(cacheKey(b, "0", f2));
    expect(cacheKey(a, "0", null)).not.toBe(cacheKey(a, "0", f1));
    expect(cacheKey(a, "0", null)).not.toBe(cacheKey(a, "1", null));
    const r3 = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mRoster"],
      scoringPeriodId: 3,
    });
    const r4 = leagueTarget({
      host: H,
      season: 2026,
      leagueId: "0",
      views: ["mRoster"],
      scoringPeriodId: 4,
    });
    expect(cacheKey(r3, "0", null)).not.toBe(cacheKey(r4, "0", null));
    expect(cacheKey(r3, "0", null)).toContain("sp=3");
    expect(cacheKey(seasonTarget({ host: H, season: 2026 }), null, null)).toBe(
      "espn:v1|season|2026|-|proTeamSchedules_wl|sp=-|f=-",
    );
  });
});

describe("freshness classes", () => {
  it("every view has a class from the table; the board view is never cached", () => {
    for (const v of ESPN_VIEWS)
      expect(FRESHNESS_TABLE[VIEW_FRESHNESS[v]].origin).toMatch(/espn|dataset/);
    expect(UNCACHED_VIEWS).toEqual(["kona_league_communication"]);
  });
  it("a composite takes its strictest member; immutable last", () => {
    expect(classForViews(["mSettings", "mNav"]).id).toBe("espn_settings");
    expect(classForViews(["mSettings", "mTeam"]).id).toBe("espn_standings");
    expect(classForViews(["mDraftDetail", "mTeam"]).id).toBe("espn_standings");
    expect(classForViews(["mDraftDetail"]).id).toBe("espn_draft");
    expect(() => classForViews([])).toThrow(RangeError);
  });
});

describe("stripForCache (plan 02 §2.4)", () => {
  it("drops member names, notification settings and any clientAddress; keeps owner GUIDs and team names", () => {
    const body = {
      members: [
        {
          id: "{00000000-0000-4000-8000-000000000001}",
          displayName: "Member 1",
          firstName: "F",
          lastName: "L",
          isLeagueCreator: false,
          notificationSettings: [{ x: 1 }],
        },
      ],
      teams: [{ id: 1, name: "Team A", owners: ["{00000000-0000-4000-8000-000000000001}"] }],
      status: { lastUpdateInfo: { clientAddress: "0.0.0.0" }, isActive: true },
      deep: { a: [{ clientAddress: "0.0.0.0", ok: 1 }] },
    };
    expect(stripForCache(body)).toEqual({
      members: [{ id: "{00000000-0000-4000-8000-000000000001}", isLeagueCreator: false }],
      teams: [{ id: 1, name: "Team A", owners: ["{00000000-0000-4000-8000-000000000001}"] }],
      status: { isActive: true },
      deep: { a: [{ ok: 1 }] },
    });
  });
  it("a recorded mNav body keeps nothing of a member but id and flags", () => {
    const out = stripForCache(loadFixture("recorded/league-a/mNav.json")) as {
      members: Record<string, unknown>[];
    };
    for (const m of out.members)
      expect(Object.keys(m).sort()).toEqual(["id", "isLeagueCreator", "isLeagueManager"]);
  });
  it("never copies __proto__; cuts hostile depth; scalars pass", () => {
    const hostile = JSON.parse('{"a":{"__proto__":{"polluted":true},"b":1}}') as unknown;
    const out = stripForCache(hostile) as { a: Record<string, unknown> };
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(out.a).toEqual({ b: 1 });
    let deep: unknown = 1;
    for (let i = 0; i < 60; i++) deep = { d: deep };
    expect(JSON.stringify(stripForCache(deep))).toContain("null");
    expect(stripForCache("x")).toBe("x");
    expect(stripForCache(null)).toBeNull();
  });
});

describe("ForceRefreshGate", () => {
  it("honours force_refresh at most once per 60 s per key", () => {
    const g = new ForceRefreshGate();
    expect(g.allow("k", 0)).toBe(true);
    expect(g.allow("k", 59_999)).toBe(false);
    expect(g.allow("other", 1)).toBe(true);
    expect(g.allow("k", 60_000)).toBe(true);
  });
  it("stays bounded (oldest key evicted past 4096)", () => {
    const g = new ForceRefreshGate();
    for (let i = 0; i < 4100; i++) g.allow(`k${String(i)}`, 0);
    expect(g.allow("k0", 1)).toBe(true);
    expect(g.allow("k4099", 1)).toBe(false);
  });
});

describe("Coalescer", () => {
  it("N concurrent identical calls → one run; the key is free again afterwards", async () => {
    const c = new Coalescer<number>();
    let runs = 0;
    let release!: (n: number) => void;
    const gate = new Promise<number>((r) => (release = r));
    const calls = Array.from({ length: 5 }, () => c.run("k", () => (runs++, gate)));
    expect(calls.filter((x) => x.joined)).toHaveLength(4);
    expect(c.size).toBe(1);
    release(7);
    expect(await Promise.all(calls.map((x) => x.promise))).toEqual([7, 7, 7, 7, 7]);
    expect(runs).toBe(1);
    expect(c.size).toBe(0);
    const failing = c.run("k", () => Promise.reject(new Error("boom")));
    await expect(failing.promise).rejects.toThrow("boom");
    expect(c.size).toBe(0);
  });
  it("property: concurrent calls over k keys run exactly k times", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 30 }),
        async (keys) => {
          const c = new Coalescer<string>();
          let runs = 0;
          const ps = keys.map(
            (k) =>
              c.run(String(k), async () => {
                runs++;
                await Promise.resolve();
                return String(k);
              }).promise,
          );
          expect(await Promise.all(ps)).toEqual(keys.map(String));
          expect(runs).toBe(new Set(keys).size);
        },
      ),
    );
  });
});

describe("serverTimeIso", () => {
  it("parses RFC 1123; refuses junk and over-long values", () => {
    expect(serverTimeIso("Tue, 06 Oct 2026 06:28:53 GMT")).toBe("2026-10-06T06:28:53.000Z");
    expect(serverTimeIso(undefined)).toBeNull();
    expect(serverTimeIso("not a date")).toBeNull();
    expect(serverTimeIso("x".repeat(65))).toBeNull();
  });
});
