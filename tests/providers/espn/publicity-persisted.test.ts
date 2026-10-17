// publicity-persisted.test.ts — the league's publicity outlives a process (Stage C finding
// espn-missing-season-404-not-cached, the provider half; plan 02 §2.1: "the server tries
// anonymously once to learn settings.isPublic and remembers it"). Every `eff check-auth` and
// `eff doctor --online` is a new process with a new provider: each one sent the anonymous
// mSettings read again before its cookie probe (one extra keyless request per run), because a
// private league's 401 was remembered in memory only. The learned value is now kept in the
// provider's cache (cache.ts cachedPublicity): a second process probes with no anonymous read, a
// value older than PUBLICITY_MAX_AGE_MS is learned again, and a league body that says otherwise
// replaces it. No network; the cookies are synthetic test values.
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import {
  cachedPublicity,
  publicityKey,
  PUBLICITY_MAX_AGE_MS,
} from "../../../src/providers/espn/cache.js";
import {
  FakeProbeAuthority,
  jsonResponse,
  loadFixture,
  makeWorld,
  MemoryCache,
  NOW_ISO,
  testCookieHeader,
} from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000001}";

function settingsBody(isPublic: boolean): unknown {
  const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
    settings: Record<string, unknown>;
  };
  const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
  s.settings.isPublic = isPublic;
  return { ...s, members: nav.members, teams: nav.teams };
}

/** A private league: keyless → 401 AUTH_LEAGUE_NOT_VISIBLE; with a cookie → the recorded body. */
function privateLeague(): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  log: { views: string; cookie: boolean }[];
} {
  const log: { views: string; cookie: boolean }[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const views = new URL(url).searchParams.getAll("view").join("&");
    const cookie = (init.headers as Record<string, string>).cookie !== undefined;
    log.push({ views, cookie });
    if (!cookie)
      return Promise.resolve(
        jsonResponse({ messages: ["x"], details: [{ type: "AUTH_LEAGUE_NOT_VISIBLE" }] }, 401),
      );
    return Promise.resolve(jsonResponse(settingsBody(false)));
  };
  return { fetch, log };
}

const authority = (): FakeProbeAuthority =>
  new FakeProbeAuthority("validated", { ok: true, header: testCookieHeader(SWID) });

describe("the league's publicity is kept across processes", () => {
  it("the first process learns it with one anonymous read; the next probes with none", async () => {
    const cache = new MemoryCache();
    const first = privateLeague();
    const a = makeWorld({ credentials: authority(), fetch: first.fetch, cache });
    expect(await a.provider.probeCredential(a.ref)).toMatchObject({ accepted: true });
    expect(first.log).toEqual([
      { views: "mSettings&mNav", cookie: false },
      { views: "mSettings", cookie: true },
    ]);
    // a new process (a new provider over the same store): the cookie probe alone
    const second = privateLeague();
    const b = makeWorld({ credentials: authority(), fetch: second.fetch, cache, clock: a.clock });
    b.clock.advance(60_000);
    expect(await b.provider.probeCredential(b.ref)).toMatchObject({ accepted: true });
    expect(second.log).toEqual([{ views: "mSettings", cookie: true }]);
  });

  it("a value older than PUBLICITY_MAX_AGE_MS is learned again; an unreadable row is unknown", async () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const store = cachedPublicity(cache, "0", clock);
    store.save(false);
    expect(store.load()).toBe(false);
    clock.advance(PUBLICITY_MAX_AGE_MS + 1);
    expect(store.load()).toBeNull();
    const league = privateLeague();
    const w = makeWorld({ credentials: authority(), fetch: league.fetch, cache, clock });
    await w.provider.probeCredential(w.ref);
    expect(league.log[0]).toEqual({ views: "mSettings&mNav", cookie: false });
    // the learned value was written again: a fresh row
    expect(store.load()).toBe(false);
    const entry = cache.get(publicityKey("0"));
    expect(entry).not.toBeNull();
    cache.put({ ...entry!, parsed_json: "{not json" });
    expect(() => store.load()).toThrow();
    const again = privateLeague();
    const v = makeWorld({ credentials: authority(), fetch: again.fetch, cache, clock });
    await v.provider.probeCredential(v.ref);
    expect(again.log[0]).toEqual({ views: "mSettings&mNav", cookie: false });
  });

  it("a league body that says otherwise replaces the kept value (the owner made the league public)", async () => {
    const cache = new MemoryCache();
    const clock = fixedClock(NOW_ISO);
    const store = cachedPublicity(cache, "0", clock);
    store.save(false);
    const publicLeague = (): Promise<Response> => Promise.resolve(jsonResponse(settingsBody(true)));
    const w = makeWorld({ credentials: authority(), fetch: publicLeague, cache, clock });
    await w.provider.getLeague(w.ref);
    expect(store.load()).toBe(true);
  });
});
