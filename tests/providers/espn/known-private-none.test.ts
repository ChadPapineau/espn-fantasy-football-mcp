// known-private-none.test.ts — changelog §R10, R10-23 (the round-4 verifier's V4-S2; plan 02 §2.1's
// learning read): with nothing stored, an `auto` read of a league whose publicity is unknown goes
// out keyless once, and its 401 teaches `false`; once known() is `false` — this process saw the 401,
// or the value another process kept, each within its 7-day trust — every `auto` read answers
// ESPN_REQUIRES_COOKIES with zero requests and none of the call's budget (R10-19), as `feed` and
// `own` already did. Before, each read of a known-private league sent a keyless request ESPN must
// refuse: the verifier's probe counted 6 refused 401s over 3 calls after the first had taught
// `false`. The in-process `false` is trusted 7 days from the 401 that taught it, like the kept
// value; past that one keyless read re-learns it (a league that turned public is read keyless
// again). A `true` keeps its rule: a league known public that has gone private costs one 401,
// which teaches `false`. The fake transport, the in-memory ports and the fake clock; no cookie
// exists anywhere here (nothing is stored). No network.
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import {
  cachedPublicity,
  publicityKey,
  PUBLICITY_MAX_AGE_MS,
} from "../../../src/providers/espn/cache.js";
import { createFixtureFetch, type FetchLike } from "../../../src/providers/espn/index.js";
import { createUpstreamBudget } from "../../../src/providers/platform.js";
import {
  FakeAuthority,
  FIXTURES,
  jsonResponse,
  LEAGUE_ID,
  makeWorld,
  MemoryCache,
  NOW_ISO,
  testCookieHeader,
  type World,
} from "./helpers.js";

const DAY_MS = 24 * 3600 * 1000;
const viewsOf = (url: string): string => new URL(url).searchParams.getAll("view").join("&");

/** A league ESPN answers keyless with 401 while `isPrivate()` (its anonymous refusal), else serves. */
function league(isPrivate: () => boolean): FetchLike {
  const recorded = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  return async (url, init) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    // nothing is stored in this file: no request may carry a cookie
    expect(h.cookie ?? h.Cookie).toBeUndefined();
    if (url.includes("/leagues/") && isPrivate())
      return jsonResponse({ messages: ["You are not authorized to view this League."] }, 401);
    return recorded(url, init);
  };
}

const none = (): FakeAuthority =>
  new FakeAuthority("not_configured", { ok: false, reason: "not_configured" });

/** The effCode a read fails with, or "ok". */
async function outcome(f: () => Promise<unknown>): Promise<string> {
  try {
    await f();
    return "ok";
  } catch (e) {
    return String((e as { effCode?: unknown }).effCode);
  }
}

/** A server-process provider over `cache` (one process), nothing stored, the league private. */
function processOn(
  cache: MemoryCache,
  clock = fixedClock(NOW_ISO),
  isPrivate: () => boolean = () => true,
): World {
  return makeWorld({ credentials: none(), fetch: league(isPrivate), cache, clock });
}

/** One call's three league reads (the verifier's probe: settings, standings, rosters). */
const threeReads = (w: World) => [
  () => w.provider.getLeague(w.ref),
  () => w.provider.getStandings(w.ref),
  () => w.provider.getRosters(w.ref, 3),
];

describe("R10-23: an auto read of a league known private, nothing stored", () => {
  it("the verifier's probe: 1 request teaches false, then every read refuses with 0 requests", async () => {
    const w = processOn(new MemoryCache());
    // the learning read: one keyless request, its 401 → ESPN_REQUIRES_COOKIES
    expect(await outcome(() => w.provider.getLeague(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(1);
    expect(viewsOf(w.sent[0]?.url ?? "")).toBe("mSettings&mNav");
    expect(w.provider.knownPublic()).toBe(false);
    // three more calls' reads (the probe sent 6 keyless 401s here): zero requests
    for (let call = 0; call < 3; call++)
      for (const read of threeReads(w)) expect(await outcome(read)).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(1);
  });

  it("the refusal carries no_credential and spends none of the call's budget (used() 0)", async () => {
    const w = processOn(new MemoryCache());
    await outcome(() => w.provider.getLeague(w.ref));
    const budget = createUpstreamBudget("r-0123456789ab", w.clock.nowMs());
    for (const read of [
      () => w.provider.getLeague(w.ref, { budget }),
      () => w.provider.getStandings(w.ref, { budget }),
      () => w.provider.getRosters(w.ref, 3, { budget }),
      () => w.provider.getMatchups(w.ref, { budget }),
    ]) {
      const err = await read().catch((e: unknown) => e);
      expect(err).toMatchObject({
        effCode: "ESPN_REQUIRES_COOKIES",
        effDetails: { reason: "no_credential" },
      });
    }
    expect(budget.used()).toBe(0);
    expect(w.sent.length).toBe(1);
  });

  it("the kept value: a second process refuses with 0 requests from its first read", async () => {
    const cache = new MemoryCache();
    const first = processOn(cache);
    await outcome(() => first.provider.getLeague(first.ref));
    expect(first.sent.length).toBe(1);
    expect(cache.get(publicityKey(LEAGUE_ID))).not.toBeNull();
    // a new process (an `eff` command, the next server) on the same store
    const second = processOn(cache);
    for (const read of threeReads(second))
      expect(await outcome(read)).toBe("ESPN_REQUIRES_COOKIES");
    expect(second.sent.length).toBe(0);
    expect(second.provider.knownPublic()).toBe(false);
  });

  it("the 7-day bound in one process: day 6 refuses with 0 requests, day 8 re-learns with 1", async () => {
    const w = processOn(new MemoryCache());
    await outcome(() => w.provider.getLeague(w.ref));
    expect(w.sent.length).toBe(1);
    w.clock.advance(6 * DAY_MS);
    for (const read of threeReads(w)) expect(await outcome(read)).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(1);
    w.clock.advance(2 * DAY_MS);
    // past the trust: one keyless read re-learns it, and the next reads refuse again
    expect(await outcome(() => w.provider.getLeague(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(2);
    for (const read of threeReads(w)) expect(await outcome(read)).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(2);
  });

  it("the 7-day bound at its edge: exactly 7 days still refuses, a millisecond past re-learns", async () => {
    const w = processOn(new MemoryCache());
    await outcome(() => w.provider.getLeague(w.ref));
    w.clock.advance(PUBLICITY_MAX_AGE_MS);
    expect(await outcome(() => w.provider.getStandings(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(1);
    w.clock.advance(1);
    expect(await outcome(() => w.provider.getStandings(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(2);
  });

  it("the kept value's own stamp bounds it, also in a process that lives for days", async () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    // another process kept `false` on day 0
    cachedPublicity(cache, LEAGUE_ID, clock).save(false);
    clock.advance(1 * DAY_MS);
    const w = processOn(cache, clock);
    // day 1: the kept value refuses (read from the store once)
    expect(await outcome(() => w.provider.getLeague(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(0);
    // day 6: still within the kept row's 7 days
    w.clock.advance(5 * DAY_MS);
    expect(await outcome(() => w.provider.getStandings(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(0);
    // day 8: the kept row is past its 7 days, though this process read it only 7 days ago
    w.clock.advance(2 * DAY_MS);
    expect(await outcome(() => w.provider.getStandings(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(1);
    // what it re-learned is kept again for the next process
    const next = processOn(cache, w.clock);
    expect(await outcome(() => next.provider.getLeague(next.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(next.sent.length).toBe(0);
  });

  it("a league that turned public within the 7 days is read keyless once the trust ends", async () => {
    let isPrivate = true;
    const w = processOn(new MemoryCache(), fixedClock(NOW_ISO), () => isPrivate);
    await outcome(() => w.provider.getLeague(w.ref));
    isPrivate = false;
    w.clock.advance(3 * DAY_MS);
    expect(await outcome(() => w.provider.getLeague(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(1);
    w.clock.advance(5 * DAY_MS);
    // the re-learning read is served: the league is public now, and is read keyless from here
    expect(await outcome(() => w.provider.getLeague(w.ref))).toBe("ok");
    expect(w.provider.knownPublic()).toBe(true);
    expect(await outcome(() => w.provider.getStandings(w.ref))).toBe("ok");
  });

  it("unknown publicity is unchanged: each process's first read is the one keyless learning read", async () => {
    const w = processOn(new MemoryCache());
    expect(w.provider.knownPublic()).toBeNull();
    expect(await outcome(() => w.provider.getStandings(w.ref))).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(1);
    expect(w.provider.knownPublic()).toBe(false);
  });

  it("a league known true keeps its rule: keyless reads; gone private, one 401 teaches false", async () => {
    let isPrivate = false;
    const w = processOn(new MemoryCache(), fixedClock(NOW_ISO), () => isPrivate);
    expect(await outcome(() => w.provider.getLeague(w.ref))).toBe("ok");
    expect(w.provider.knownPublic()).toBe(true);
    // well past 7 days, a true is still trusted: every read keyless, none refused
    w.clock.advance(10 * DAY_MS);
    const before = w.sent.length;
    expect(await outcome(() => w.provider.getStandings(w.ref))).toBe("ok");
    expect(w.sent.length).toBeGreaterThan(before);
    expect(w.provider.knownPublic()).toBe(true);
    // the league goes private: one keyless 401 teaches false, then zero requests
    isPrivate = true;
    w.clock.advance(10 * DAY_MS);
    const was = w.sent.length;
    expect(await outcome(() => w.provider.getRosters(w.ref, 3))).toBe("ESPN_REQUIRES_COOKIES");
    const after = w.sent.length;
    expect(after).toBe(was + 1);
    expect(w.provider.knownPublic()).toBe(false);
    for (const read of threeReads(w)) expect(await outcome(read)).toBe("ESPN_REQUIRES_COOKIES");
    expect(w.sent.length).toBe(after);
  });

  it("a value stored since (another process ran `eff setup`) is still found and sent", async () => {
    const cache = new MemoryCache();
    // the label still reads not_configured; the store now holds a value (plan 02 §2.2)
    let stored = false;
    const header = testCookieHeader("{00000000-0000-4000-8000-000000000023}");
    const auth = new (class extends FakeAuthority {
      override getCookieHeader() {
        this.headerCalls++;
        return Promise.resolve(
          stored
            ? { ok: true as const, header }
            : { ok: false as const, reason: "not_configured" as const },
        );
      }
    })("not_configured", { ok: false, reason: "not_configured" });
    const recorded = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
    const cookies: (string | undefined)[] = [];
    const w = makeWorld({
      credentials: auth,
      cache,
      fetch: async (url, init) => {
        const h = (init.headers ?? {}) as Record<string, string>;
        cookies.push(h.cookie);
        if (h.cookie === undefined)
          return jsonResponse({ messages: ["You are not authorized to view this League."] }, 401);
        const { cookie: _drop, ...rest } = h;
        const r = await recorded(url, { ...init, headers: rest });
        if (!viewsOf(url).includes("mSettings")) return r;
        // the league's own settings say private, as a cookie-bearing read of it would
        const body = (await r.json()) as { settings?: Record<string, unknown> };
        if (body.settings !== undefined) body.settings.isPublic = false;
        return jsonResponse(body);
      },
    });
    await outcome(() => w.provider.getLeague(w.ref));
    expect(w.provider.knownPublic()).toBe(false);
    stored = true;
    expect(await outcome(() => w.provider.getStandings(w.ref))).toBe("ok");
    // the learning read keyless, then every read of the call with the value found
    expect(cookies[0]).toBeUndefined();
    expect(cookies.length).toBeGreaterThan(1);
    expect(cookies.slice(1).every((c) => c === header)).toBe(true);
    expect(w.provider.knownPublic()).toBe(false);
  });
});
