// feed-pending-split.test.ts — changelog §R10, R10-10, the provider half, on the fake transport: the
// old `required` cookie use is split in two (src/providers/espn/auth-gate.ts `feed` / `own`). The
// league's feed (mTransactions2) is served to anyone on a public league, so with no accepted cookie
// at hand — nothing stored, or a rejected session — it is read keyless there, and the request
// carries no Cookie header; on a league not known to be public it is refused as before. Pending
// claims (mPendingTransactions) are the caller's own: never read keyless — ESPN_REQUIRES_COOKIES with
// nothing stored, ESPN_AUTH_REJECTED under a rejected session, both with ZERO requests (not even the
// identity or publicity read), public or private, and a pending list cached under the session is not
// served once the session is rejected. One publicity rule (the gate's `known()`: this process's
// observation, else the kept value) decides in both credential branches, so a fresh process reads
// the feed keyless on the kept value. A league kept public that is private now answers the keyless
// feed with 401: under a rejected session that is ESPN_AUTH_REJECTED, and the league is learned
// private. Fixture mode (no credential authority at all) follows the same split. No network; the
// cookies are synthetic test values.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import { cachedPublicity } from "../../../src/providers/espn/cache.js";
import {
  createEspnProvider,
  createFixtureFetch,
  type FetchLike,
} from "../../../src/providers/espn/index.js";
import type { TxnQuery } from "../../../src/providers/platform.js";
import {
  FakeAuthority,
  FIXTURES,
  jsonResponse,
  LEAGUE_ID,
  loadFixture,
  makeWorld,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  SEASON,
  stubScoring,
  testCookieHeader,
} from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000021}";
/** The world's clock (helpers NOW_ISO): a kept publicity saved now is fresh. */
const SEASON_NOW = "2026-10-06T12:00:00.000Z";
const HEADER = testCookieHeader(SWID);
const FEED: TxnQuery = {
  types: ["WAIVER", "WAIVER_ERROR", "FREEAGENT"],
  week: 3,
  since: null,
  count: 25,
  team_id: null,
};

const viewsOf = (url: string): string => new URL(url).searchParams.getAll("view").join("&");
const notVisible = (): Response =>
  jsonResponse({ messages: ["x"], details: [{ type: "AUTH_LEAGUE_NOT_VISIBLE" }] }, 401);

/** A public league (league-a's recordings, isPublic true) with fx-10h's feed and pending bodies. */
function publicLeague(): FetchLike {
  const recorded = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  return (url, init) => {
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    delete headers.cookie; // the recordings refuse a Cookie header; `sent` already holds it
    const v = viewsOf(url);
    if (v === "mTransactions2")
      return Promise.resolve(jsonResponse(loadFixture("fx-10h/league/mTransactions2.json")));
    if (v === "mPendingTransactions")
      return Promise.resolve(jsonResponse(loadFixture("fx-10h/league/mPendingTransactions.json")));
    return recorded(url, { ...init, headers });
  };
}

/** A private league: every keyless request is 401; a cookie-bearing one is the public body. */
function privateLeague(): FetchLike {
  const inner = publicLeague();
  return (url, init) => {
    const cookie = (init.headers as Record<string, string> | undefined)?.cookie !== undefined;
    return cookie ? inner(url, init) : Promise.resolve(notVisible());
  };
}

type Session = "none" | "not_configured" | "rejected";
const authority = (s: Session): FakeAuthority | null =>
  s === "none"
    ? null
    : s === "not_configured"
      ? new FakeAuthority("not_configured", { ok: false, reason: "not_configured" })
      : new FakeAuthority("rejected", { ok: true, header: HEADER });
const refusal = (s: Session): string =>
  s === "rejected" ? "ESPN_AUTH_REJECTED" : "ESPN_REQUIRES_COOKIES";

describe("pending claims are never read keyless (changelog §R10, R10-10)", () => {
  const cells: [Session, "public" | "private" | "kept public"][] = [];
  for (const s of ["none", "not_configured", "rejected"] as const)
    for (const p of ["public", "private", "kept public"] as const) cells.push([s, p]);

  it.each(cells)("session %s on a %s league: the refusal, with zero requests", async (s, p) => {
    const cache = new MemoryCache();
    if (p === "kept public") cachedPublicity(cache, LEAGUE_ID, fixedClock(SEASON_NOW)).save(true);
    const w = makeWorld({
      credentials: authority(s),
      fetch: p === "private" ? privateLeague() : publicLeague(),
      cache,
    });
    // a public league this process has already seen answer (the in-process observation)
    if (p === "public") {
      await w.provider.getLeague(w.ref);
      expect(w.provider.knownPublic()).toBe(true);
    }
    const before = w.sent.length;
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: refusal(s),
      effDetails: { reason: s === "rejected" ? "short_circuit" : "no_credential" },
    });
    expect(w.sent.length).toBe(before);
    expect(w.limiter.rows.length).toBe(before);
  });

  it("with an accepted session pending claims carry the cookie, on a public league too", async () => {
    const a = new FakeAuthority("validated", { ok: true, header: HEADER });
    const w = makeWorld({ credentials: a, fetch: publicLeague() });
    await w.provider.getLeague(w.ref);
    expect(w.provider.knownPublic()).toBe(true);
    const r = await w.provider.listPendingTransactions(w.ref);
    expect(r.value).toEqual([]);
    const pending = w.sent.filter((x) => viewsOf(x.url) === "mPendingTransactions");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.headers.cookie).toBe(HEADER);
  });

  it("a pending list cached under the session is not served once the session is rejected", async () => {
    const a = new FakeAuthority("validated", { ok: true, header: HEADER });
    const w = makeWorld({ credentials: a, fetch: publicLeague() });
    await w.provider.listPendingTransactions(w.ref);
    const n = w.sent.length;
    // a cookie-bearing 401 elsewhere: the session is rejected now
    a.current = "rejected";
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    expect(w.sent.length).toBe(n);
  });
});

describe("the league feed is read keyless on a league known public (changelog §R10, R10-10)", () => {
  it.each(["none", "not_configured", "rejected"] as const)(
    "session %s on a public league: the feed answers, its request carries no Cookie header",
    async (s) => {
      const a = authority(s);
      const w = makeWorld({ credentials: a, fetch: publicLeague() });
      const r = await w.provider.listTransactions(w.ref, FEED);
      expect(r.stamp.source).toBe("espn:mTransactions2");
      expect(r.value.items.length).toBeGreaterThan(0);
      const feed = w.sent.filter((x) => viewsOf(x.url) === "mTransactions2");
      expect(feed).toHaveLength(1);
      expect(feed[0]?.headers.cookie).toBeUndefined();
      // nothing in this run carried a cookie: the rejected one is never sent again
      for (const x of w.sent) expect(x.headers.cookie, x.url).toBeUndefined();
      // and the keyless 200s proved nothing about the session (no observation recorded)
      expect(a?.observations ?? []).toEqual([]);
    },
  );

  it("a fresh process under a rejected session reads the feed keyless on the KEPT publicity", async () => {
    const cache = new MemoryCache();
    cachedPublicity(cache, LEAGUE_ID, fixedClock(SEASON_NOW)).save(true);
    const a = authority("rejected");
    const w = makeWorld({ credentials: a, fetch: publicLeague(), cache });
    const r = await w.provider.listTransactions(w.ref, FEED);
    expect(r.value.items.length).toBeGreaterThan(0);
    expect(w.sent.some((x) => viewsOf(x.url) === "mTransactions2")).toBe(true);
    for (const x of w.sent) expect(x.headers.cookie, x.url).toBeUndefined();
  });

  it("the server with an accepted session sends it for the feed on a public league (unchanged)", async () => {
    const w = makeWorld({
      credentials: new FakeAuthority("validated", { ok: true, header: HEADER }),
      fetch: publicLeague(),
    });
    await w.provider.getLeague(w.ref);
    await w.provider.listTransactions(w.ref, FEED);
    const feed = w.sent.filter((x) => viewsOf(x.url) === "mTransactions2");
    expect(feed[0]?.headers.cookie).toBe(HEADER);
  });

  it.each(["none", "not_configured", "rejected"] as const)(
    "session %s on a private league: the feed is refused as before, with no feed request",
    async (s) => {
      const w = makeWorld({ credentials: authority(s), fetch: privateLeague() });
      await expect(w.provider.listTransactions(w.ref, FEED)).rejects.toMatchObject({
        effCode: refusal(s),
      });
      expect(w.sent.some((x) => viewsOf(x.url) === "mTransactions2")).toBe(false);
      for (const x of w.sent) expect(x.headers.cookie, x.url).toBeUndefined();
    },
  );

  it("a league kept public that is private now: the keyless feed's 401 is ESPN_AUTH_REJECTED, then private is known", async () => {
    // the settings still answer (cached as public); the feed's keyless request is refused
    const inner = publicLeague();
    const fetch: FetchLike = (url, init) =>
      viewsOf(url) === "mTransactions2" ? Promise.resolve(notVisible()) : inner(url, init);
    const a = authority("rejected");
    const w = makeWorld({ credentials: a, fetch });
    await w.provider.getLeague(w.ref);
    expect(w.provider.knownPublic()).toBe(true);
    await expect(w.provider.listTransactions(w.ref, FEED)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    expect(w.provider.knownPublic()).toBe(false);
    // the next feed read is refused with no request at all
    const n = w.sent.length;
    await expect(w.provider.listTransactions(w.ref, FEED)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    expect(w.sent.length).toBe(n);
    for (const x of w.sent) expect(x.headers.cookie, x.url).toBeUndefined();
  });

  it("with nothing stored the same refusal stays ESPN_REQUIRES_COOKIES (no session to blame)", async () => {
    const inner = publicLeague();
    const fetch: FetchLike = (url, init) =>
      viewsOf(url) === "mTransactions2" ? Promise.resolve(notVisible()) : inner(url, init);
    const w = makeWorld({ credentials: authority("not_configured"), fetch });
    await w.provider.getLeague(w.ref);
    await expect(w.provider.listTransactions(w.ref, FEED)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
  });
});

describe("fixture mode (no credential authority) follows the same split", () => {
  it("fx-10h: the feed answers keyless; pending claims are ESPN_REQUIRES_COOKIES with zero requests", async () => {
    const limiter = new MemoryLimiterRepo();
    const clock = fixedClock("2026-10-07T01:00:00.000Z");
    const p = createEspnProvider({
      config: {
        leagueId: "0",
        season: SEASON,
        teamId: 2,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
        fixtureDir: path.join(FIXTURES, "fx-10h"),
      },
      repos: { limiter, espnCache: new MemoryCache(), driftState: new MemoryDrift() },
      credentials: null,
      clock,
      scoring: stubScoring,
      // the limiter's 1 s spacing on the fixed clock: a wait moves it (no real timer)
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
    });
    const ref = { platform: "espn" as const, league_id: "0", season: SEASON };
    await expect(p.listPendingTransactions(ref)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    expect(limiter.rows).toHaveLength(0);
    const feed = await p.listTransactions(ref, FEED);
    expect(feed.value.items.length).toBeGreaterThan(0);
    // still refused once the league is known public in this process
    expect(p.knownPublic()).toBe(true);
    const n = limiter.rows.length;
    await expect(p.listPendingTransactions(ref)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    expect(limiter.rows).toHaveLength(n);
  });
});
