// refused-budget.test.ts — changelog §R10, R10-19 (plan 01 §5.6: the ≤ 3 counts upstream requests):
// a read the cookie gate refuses before any request — ESPN_REQUIRES_COOKIES, the ESPN_AUTH_REJECTED
// short-circuit — spends none of the call's budget; the budget is charged only for a request about
// to be sent. Before, request.ts charged the budget before it asked the gate, so a call whose reads
// the gate refused had "used" its three requests with none sent, and a later read of it — a keyless
// one on a public league included — was refused as over budget. Held here: refused reads leave
// `used()` at 0 and send nothing; on a public league under a rejected session, a keyless read after
// three refusals fits the budget; a refusal met in flight (the session rejected while the read
// waited at the limiter) gives its charge back; three real requests still spend the budget and a 4th
// still gets the budget signal (the tool's `partial: true` — tests/mcp/p1-fx10h.test.ts holds it at
// the tool level); the 20 s deadline is unchanged; the refusal is never a stale answer (R10-18).
// The fake transport and the in-memory ports; the cookies are synthetic test values. No network.
import { describe, expect, it } from "vitest";
import { createCredentialAuthority } from "../../../src/auth/state.js";
import type { CredentialObservation } from "../../../src/auth/types.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { cachedPublicity } from "../../../src/providers/espn/cache.js";
import { createFixtureFetch, type FetchLike } from "../../../src/providers/espn/index.js";
import { leagueTarget } from "../../../src/providers/espn/path.js";
import { EspnRequester } from "../../../src/providers/espn/request.js";
import {
  createUpstreamBudget,
  isUpstreamBudgetExhausted,
  MAX_UPSTREAM_PER_CALL,
  PER_CALL_DEADLINE_MS,
} from "../../../src/providers/platform.js";
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
  LEAGUE_ID,
  makeWorld,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  NOW_ISO,
  SEASON,
  testCookieHeader,
} from "./helpers.js";

const RID = "r-0123456789ab";
const HOST = "lm-api-reads.fantasy.espn.com";
const SWID = "{00000000-0000-4000-8000-000000000031}";
const viewsOf = (url: string): string => new URL(url).searchParams.getAll("view").join("&");

/** league-a's recordings as a PRIVATE league (its settings say so); the Cookie header dropped. */
function privateRecordings(): FetchLike {
  const recorded = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  return async (url, init) => {
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    const cookie = headers.cookie !== undefined;
    delete headers.cookie;
    if (!cookie) return jsonResponse({ messages: ["x"] }, 401);
    const r = await recorded(url, { ...init, headers });
    if (!viewsOf(url).includes("mSettings")) return r;
    const body = (await r.json()) as { settings?: Record<string, unknown> };
    if (body.settings !== undefined) body.settings.isPublic = false;
    return jsonResponse(body);
  };
}

/** A bare request pipeline over the fake transport, the league's publicity kept as `known`. */
function requester(state: "rejected" | "not_configured", known: boolean) {
  const clock = fixedClock(NOW_ISO);
  const sent: string[] = [];
  const r = new EspnRequester({
    fetch: (url, init) => {
      expect((init.headers as Record<string, string> | undefined)?.cookie).toBeUndefined();
      sent.push(viewsOf(url));
      return Promise.resolve(jsonResponse({ transactions: [] }));
    },
    clock,
    limiter: new MemoryLimiterRepo(),
    cache: new MemoryCache(),
    driftState: new MemoryDrift(),
    credentials: new FakeAuthority(state, { ok: true, header: testCookieHeader(SWID) }),
    host: HOST,
    origin: "server",
    observer: "server",
    recordRawBodies: false,
    // what another process kept of the league's publicity (auth-gate.ts PublicityStore)
    publicity: { load: () => known, save: () => undefined },
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });
  return { r, sent, clock };
}

/** A transaction-feed (`feed`) or pending-claims (`own`) read of one scoring period. */
const spec = (cookies: "own" | "feed", week: number) => ({
  target: leagueTarget({
    host: HOST,
    season: SEASON,
    leagueId: LEAGUE_ID,
    views: [cookies === "own" ? "mPendingTransactions" : "mTransactions2"],
    scoringPeriodId: week,
  }),
  filter: null,
  leagueId: LEAGUE_ID,
  cookies,
  parse: (b: unknown) => b,
});

describe("R10-19: a read the cookie gate refuses spends none of the call's budget", () => {
  it("a league known private under a rejected session: every read refused, nothing sent, used() stays 0", async () => {
    const cache = new MemoryCache();
    cachedPublicity(cache, LEAGUE_ID, fixedClock(NOW_ISO)).save(false);
    const w = makeWorld({
      credentials: new FakeAuthority("rejected", { ok: true, header: testCookieHeader(SWID) }),
      fetch: privateRecordings(),
      cache,
    });
    const budget = createUpstreamBudget(RID, w.clock.nowMs());
    const reads = [
      () => w.provider.getStandings(w.ref, { budget }),
      () => w.provider.getRosters(w.ref, 3, { budget }),
      () =>
        w.provider.listTransactions(
          w.ref,
          { types: ["WAIVER"], week: 3, since: null, count: 10, team_id: null },
          { budget },
        ),
      () => w.provider.getMatchups(w.ref, { budget }),
      () => w.provider.getLiveMatchups(w.ref, 3, { budget }),
    ];
    // five reads, more than the budget holds: each meets its own refusal, never the budget
    for (const read of reads) {
      const err = await read().catch((e: unknown) => e);
      expect(isUpstreamBudgetExhausted(err)).toBe(false);
      expect(err).toMatchObject({
        effCode: "ESPN_AUTH_REJECTED",
        effDetails: { reason: "short_circuit" },
      });
    }
    expect(w.sent).toEqual([]);
    expect(budget.used()).toBe(0);
  });

  it("a league known private with nothing stored: the feed and pending claims refused unsent, used() stays 0", async () => {
    const { r, sent, clock } = requester("not_configured", false);
    const budget = createUpstreamBudget(RID, clock.nowMs());
    for (const [cookies, week] of [
      ["feed", 1],
      ["own", 1],
      ["feed", 2],
      ["own", 2],
    ] as const)
      await expect(r.read(spec(cookies, week), { budget })).rejects.toMatchObject({
        effCode: "ESPN_REQUIRES_COOKIES",
        effDetails: { reason: "no_credential" },
      });
    expect(sent).toEqual([]);
    expect(budget.used()).toBe(0);
  });

  it("a public league under a rejected session: three refused reads, then a keyless read that fits the budget", async () => {
    const { r, sent, clock } = requester("rejected", true);
    const budget = createUpstreamBudget(RID, clock.nowMs());
    // the caller's own claims are never read keyless: refused three times, nothing sent
    for (const week of [1, 2, 3])
      await expect(r.read(spec("own", week), { budget })).rejects.toMatchObject({
        effCode: "ESPN_AUTH_REJECTED",
        effDetails: { reason: "short_circuit" },
      });
    expect(sent).toEqual([]);
    expect(budget.used()).toBe(0);
    // ESPN serves the feed to anyone here (R10-10): three keyless reads, all inside the budget
    for (const week of [1, 2, 3]) {
      const got = await r.read(spec("feed", week), { budget });
      expect(got.stamp.cache).toBe("miss");
    }
    expect(sent).toEqual(["mTransactions2", "mTransactions2", "mTransactions2"]);
    expect(budget.used()).toBe(3);
    // and a 4th real request is the budget's to refuse, as before
    const fourth = await r.read(spec("feed", 4), { budget }).catch((e: unknown) => e);
    expect(isUpstreamBudgetExhausted(fourth)).toBe(true);
    expect((fourth as { missing: unknown }).missing).toEqual({
      view: "mTransactions2",
      reason: "budget",
    });
    expect(sent).toHaveLength(3);
  });

  it("three real requests spend the budget, and the 4th still gets the budget signal (partial)", async () => {
    const w = makeWorld({ slot: "league-a" });
    const budget = createUpstreamBudget(RID, w.clock.nowMs());
    await w.provider.getLeague(w.ref, { budget });
    await w.provider.getRosters(w.ref, 3, { budget });
    await w.provider.getStandings(w.ref, { budget });
    expect(budget.used()).toBe(MAX_UPSTREAM_PER_CALL);
    const n = w.sent.length;
    const err = await w.provider.getMatchups(w.ref, { budget }).catch((e: unknown) => e);
    expect(isUpstreamBudgetExhausted(err)).toBe(true);
    expect(w.sent.length).toBe(n);
  });

  it("the 20 s deadline is unchanged: a call past it starts no request, refused or not", async () => {
    // a read the gate refuses reports its refusal, which wins over every outage answer (R10-18;
    // the round-4 verifier's V4-M1: the deadline answered it as an outage, from stale cache when
    // an entry was usable); a read the gate does not refuse reports the deadline. Neither sends
    const refused = makeWorld({
      credentials: new FakeAuthority("rejected", { ok: true, header: testCookieHeader(SWID) }),
      fetch: privateRecordings(),
    });
    const late = createUpstreamBudget(RID, refused.clock.nowMs() - PER_CALL_DEADLINE_MS - 1);
    const err = await refused.provider
      .getRosters(refused.ref, 3, { budget: late })
      .catch((e: unknown) => e);
    expect((err as { effCode?: string }).effCode).toBe("ESPN_AUTH_REJECTED");
    expect(refused.sent).toEqual([]);
    expect(late.used()).toBe(0);
    const open = makeWorld({
      credentials: new FakeAuthority("stored", { ok: true, header: testCookieHeader(SWID) }),
      fetch: privateRecordings(),
    });
    const late2 = createUpstreamBudget(RID, open.clock.nowMs() - PER_CALL_DEADLINE_MS - 1);
    const err2 = await open.provider
      .getRosters(open.ref, 3, { budget: late2 })
      .catch((e: unknown) => e);
    expect(isUpstreamBudgetExhausted(err2)).toBe(true);
    expect((err2 as { missing: { reason: string } }).missing.reason).toBe("deadline");
    expect(open.sent).toEqual([]);
  });

  it("a refusal met in flight (rejected while the read waited at the limiter) gives its charge back", async () => {
    const store = new MemoryStore("keychain");
    store.set(fakeCookies("r10-19-in-flight"), "2026-10-01T11:00:00.000Z");
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
    const rejection: CredentialObservation = {
      kind: "rejected",
      at: NOW_ISO,
      by: "server",
      upstream_status: 401,
      view: "mTeam",
    };
    let armed = false;
    const waits: number[] = [];
    const w = makeWorld({
      credentials: auth,
      fetch: privateRecordings(),
      over: {
        // the limiter's 1/s wait before the roster read's first attempt: a concurrent read's 401
        // records the rejection meanwhile (provider afterFailure → the authority)
        sleep: async (ms) => {
          waits.push(ms);
          if (armed) {
            armed = false;
            await auth.observe(rejection);
          }
          w.clock.advance(ms);
        },
      },
    });
    const budget = createUpstreamBudget(RID, w.clock.nowMs());
    await w.provider.getLeague(w.ref, { budget });
    expect(budget.used()).toBe(1);
    const n = w.sent.length;
    armed = true;
    await expect(w.provider.getRosters(w.ref, 3, { budget })).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    expect(waits.length).toBeGreaterThan(0);
    expect(armed).toBe(false);
    // the roster read was charged when it was about to go out, then refused unsent: given back
    expect(w.sent.length).toBe(n);
    expect(budget.used()).toBe(1);
  });
});
