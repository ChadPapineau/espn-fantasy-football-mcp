// refusal-before-outage.test.ts — changelog §R10, R10-18 ("a session refusal is never a reason to
// serve stale cache"; no stale-on-refusal path anywhere) and the round-4 verifier's V4-M1. Three
// pipeline steps ran BEFORE the cookie gate in request.ts read(): the open breaker, ESPN's
// Retry-After hold and a passed call deadline. Each answered a read the gate would refuse with zero
// requests from the stale entry, as an outage (RATE_LIMITED, ESPN_UPSTREAM_UNAVAILABLE, the
// breaker) — on a private league under a rejected session, settings up to 7 days old, with the
// rejection the owner has to fix hidden behind the outage label. The gate's zero-request refusal now
// wins over each of them; a read the gate does not refuse is answered by the outage rules as before
// (the controls). Under a rejected session the authority reads metadata only: no secret is loaded.
// The fake transport and the in-memory ports; the cookies are synthetic test values. No network.
import { describe, expect, it } from "vitest";
import { createCredentialAuthority } from "../../../src/auth/state.js";
import { createFixtureFetch, type FetchLike } from "../../../src/providers/espn/index.js";
import { createUpstreamBudget, PER_CALL_DEADLINE_MS } from "../../../src/providers/platform.js";
import {
  MemoryStateRepo,
  MemoryStore,
  RecordingRegistrar,
  fakeCookies,
  stateRow,
} from "../../auth/helpers.js";
import {
  FakeAuthority,
  FIXTURES,
  jsonResponse,
  loadFixture,
  makeWorld,
  NOW_ISO,
  testCookieHeader,
  type World,
} from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000041}";
const HOUR_MS = 3_600_000;
const viewsOf = (url: string): string => new URL(url).searchParams.getAll("view").join("&");

/**
 * league-a's recordings; `isPublic` sets the settings' publicity. `season` may answer a season
 * route (the pro schedule) itself — a 429 with Retry-After sets the hold every read then meets.
 */
function league(isPublic: boolean, season: () => Response | null = () => null): FetchLike {
  const recorded = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  return async (url, init) => {
    if (!url.includes("/leagues/")) {
      const r = season();
      if (r !== null) return r;
    }
    if (viewsOf(url) === "mTransactions2")
      return jsonResponse(loadFixture("fx-10h/league/mTransactions2.json"));
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    delete headers.cookie;
    const r = await recorded(url, { ...init, headers });
    if (!viewsOf(url).includes("mSettings")) return r;
    const body = (await r.json()) as { settings?: Record<string, unknown> };
    if (body.settings !== undefined) body.settings.isPublic = isPublic;
    return jsonResponse(body);
  };
}

type Outcome =
  { readonly served: string; readonly degraded: unknown } | { readonly error: string | undefined };

async function outcome(p: Promise<{ stamp: { degraded: unknown; cache: string } }>) {
  try {
    const r = await p;
    return { served: r.stamp.cache, degraded: r.stamp.degraded } as Outcome;
  } catch (e) {
    return { error: (e as { effCode?: string }).effCode } as Outcome;
  }
}

/** The settings cached by a cookie-bearing read, then the session `then`, and the clock +25 h. */
async function primed(opts: {
  readonly isPublic: boolean;
  readonly then: "rejected" | "stored" | "not_configured";
  readonly season?: () => Response | null;
}) {
  const auth = new FakeAuthority("stored", { ok: true, header: testCookieHeader(SWID) });
  const w = makeWorld({ credentials: auth, fetch: league(opts.isPublic, opts.season) });
  expect((await w.provider.getLeague(w.ref)).value.is_public).toBe(opts.isPublic);
  auth.current = opts.then;
  w.clock.advance(25 * HOUR_MS);
  return { w, auth };
}

const breakerOf = (w: World) =>
  (w.provider as unknown as { req: { limiter: { breaker: { forceOpen(): void } } } }).req.limiter
    .breaker;

/** A keyless season read answered 429 with Retry-After 300: ESPN's hold, set for every read. */
async function hold(w: World): Promise<void> {
  await outcome(w.provider.getProSchedule(2026));
}

describe("V4-M1: the gate's refusal wins over the outage answers (a private league, rejected session)", () => {
  it("baseline: no outage → ESPN_AUTH_REJECTED, no request", async () => {
    const { w } = await primed({ isPublic: false, then: "rejected" });
    const n = w.sent.length;
    expect(await outcome(w.provider.getLeague(w.ref))).toEqual({ error: "ESPN_AUTH_REJECTED" });
    expect(w.sent.length).toBe(n);
  });

  it("ESPN's Retry-After hold: ESPN_AUTH_REJECTED, never the stale settings as RATE_LIMITED", async () => {
    let on = false;
    const { w } = await primed({
      isPublic: false,
      then: "rejected",
      season: () => (on ? jsonResponse({ m: 1 }, 429, { "retry-after": "300" }) : null),
    });
    on = true;
    await hold(w);
    const n = w.sent.length;
    expect(await outcome(w.provider.getLeague(w.ref))).toEqual({ error: "ESPN_AUTH_REJECTED" });
    expect(w.sent.length).toBe(n);
  });

  it("a passed call deadline: ESPN_AUTH_REJECTED, never the stale settings as an outage", async () => {
    const { w } = await primed({ isPublic: false, then: "rejected" });
    const budget = createUpstreamBudget("r-0123456789ab", w.clock.nowMs() - PER_CALL_DEADLINE_MS);
    const n = w.sent.length;
    expect(await outcome(w.provider.getLeague(w.ref, { budget }))).toEqual({
      error: "ESPN_AUTH_REJECTED",
    });
    expect(w.sent.length).toBe(n);
    expect(budget.used()).toBe(0);
  });

  it("an open breaker: ESPN_AUTH_REJECTED, never the stale settings as the breaker's", async () => {
    const { w } = await primed({ isPublic: false, then: "rejected" });
    breakerOf(w).forceOpen();
    const n = w.sent.length;
    expect(await outcome(w.provider.getLeague(w.ref))).toEqual({ error: "ESPN_AUTH_REJECTED" });
    expect(await outcome(w.provider.getRosters(w.ref, 3))).toEqual({ error: "ESPN_AUTH_REJECTED" });
    expect(w.sent.length).toBe(n);
  });

  it("nothing stored: the feed of a league known private is ESPN_REQUIRES_COOKIES under a hold, never stale", async () => {
    let on = false;
    const { w, auth } = await primed({
      isPublic: false,
      then: "stored",
      season: () => (on ? jsonResponse({ m: 1 }, 429, { "retry-after": "300" }) : null),
    });
    const q = { types: ["WAIVER" as const], week: 3, since: null, count: 10, team_id: null };
    await w.provider.listTransactions(w.ref, q);
    auth.current = "not_configured";
    w.clock.advance(25 * HOUR_MS);
    on = true;
    await hold(w);
    const n = w.sent.length;
    expect(await outcome(w.provider.listTransactions(w.ref, q))).toEqual({
      error: "ESPN_REQUIRES_COOKIES",
    });
    expect(w.sent.length).toBe(n);
  });

  it("the real authority under rejection: the refusal is read from metadata, no secret loaded", async () => {
    const store = new MemoryStore("keychain");
    store.set(fakeCookies("v4-m1"), "2026-10-01T11:00:00.000Z");
    const repo = new MemoryStateRepo();
    repo.row = stateRow({ state: "stored", stored_at: "2026-10-01T11:00:00.000Z" });
    const auth = createCredentialAuthority({
      store,
      repo,
      leagueId: "0",
      registrar: new RecordingRegistrar(),
      observer: "server",
      now: () => NOW_ISO,
    });
    const w = makeWorld({ credentials: auth, fetch: league(false) });
    expect((await w.provider.getLeague(w.ref)).value.is_public).toBe(false);
    await auth.observe({
      kind: "rejected",
      at: NOW_ISO,
      by: "server",
      upstream_status: 401,
      view: "mRoster",
    });
    w.clock.advance(25 * HOUR_MS);
    breakerOf(w).forceOpen();
    const reads = store.reads;
    const n = w.sent.length;
    expect(await outcome(w.provider.getLeague(w.ref))).toEqual({ error: "ESPN_AUTH_REJECTED" });
    expect(store.reads).toBe(reads);
    expect(auth.holdsSecret()).toBe(false);
    expect(w.sent.length).toBe(n);
  });
});

describe("V4-M1 controls: a read the gate does not refuse keeps the outage rules", () => {
  it("a stored session under a hold, a deadline and an open breaker: the stale entry, as before", async () => {
    let on = false;
    const { w } = await primed({
      isPublic: false,
      then: "stored",
      season: () => (on ? jsonResponse({ m: 1 }, 429, { "retry-after": "300" }) : null),
    });
    on = true;
    await hold(w);
    expect(await outcome(w.provider.getLeague(w.ref))).toMatchObject({
      served: "stale",
      degraded: { code: "RATE_LIMITED", served: "stale_cache" },
    });
    const budget = createUpstreamBudget("r-0123456789ab", w.clock.nowMs() - PER_CALL_DEADLINE_MS);
    expect(await outcome(w.provider.getLeague(w.ref, { budget }))).toMatchObject({
      degraded: { served: "stale_cache" },
    });
  });

  it("a league known public under a rejected session: its keyless read is no refusal, so the outage rules answer", async () => {
    const { w } = await primed({ isPublic: true, then: "rejected" });
    breakerOf(w).forceOpen();
    const n = w.sent.length;
    expect(await outcome(w.provider.getLeague(w.ref))).toMatchObject({
      degraded: { served: "stale_cache" },
    });
    expect(w.sent.length).toBe(n);
  });
});
