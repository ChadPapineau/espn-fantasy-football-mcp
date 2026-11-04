// rejected-in-flight.test.ts — a cookie ESPN has just rejected is never sent again, not even by a
// read already in flight (plan 02 §2.1 "Short-circuit": zero requests once rejected; changelog §R10,
// R10-10; the round-3 review's R3B-CS-2). fetchFresh asked the gate for the Cookie header once,
// before the limiter wait and the retry loop: a concurrent read whose cookie-bearing 401 recorded the
// rejection meanwhile did not stop it, and it sent the rejected cookie on its next attempt (after
// the limiter's wait, or a retry's backoff). The pipeline now asks the gate again for each attempt
// once the session reads rejected: a league not known public is refused with no request, a league
// known public (the feed, R10-10) goes keyless, and a value `eff setup` stored since is sent. Over
// the REAL authority (src/auth/state.ts) on the fake transport; the cookies are run-time fakes. No
// network.
import { describe, expect, it } from "vitest";
import { createCredentialAuthority } from "../../../src/auth/state.js";
import type { CredentialObservation } from "../../../src/auth/types.js";
import { createFixtureFetch, type FetchLike } from "../../../src/providers/espn/index.js";
import {
  MemoryStateRepo,
  MemoryStore,
  RecordingRegistrar,
  fakeCookies,
  stateRow,
} from "../../auth/helpers.js";
import { FIXTURES, NOW_ISO, jsonResponse, loadFixture, makeWorld } from "./helpers.js";

const SETUP_AT = "2026-10-01T11:00:00.000Z";

/** A working install: a stored value the row records as stored. */
function install(label: string) {
  const store = new MemoryStore("keychain");
  const cookies = fakeCookies(label);
  store.set(cookies, SETUP_AT);
  const repo = new MemoryStateRepo();
  repo.row = stateRow({ state: "stored", stored_at: SETUP_AT });
  const registrar = new RecordingRegistrar();
  const auth = createCredentialAuthority({
    store,
    repo,
    leagueId: "0",
    registrar,
    observer: "server",
    now: () => NOW_ISO,
  });
  return { store, repo, auth, cookies };
}

/** What a concurrent read's cookie-bearing 401 records (provider afterFailure → the authority). */
const rejection = (view: CredentialObservation["view"]): CredentialObservation => ({
  kind: "rejected",
  at: NOW_ISO,
  by: "server",
  upstream_status: 401,
  view,
});

const viewsOf = (url: string): string => new URL(url).searchParams.getAll("view").join("&");

/**
 * league-a's recordings with fx-10h's feed, where the first answer for `view` is a 503 (retryable)
 * and `during` runs while that attempt is in flight. `privateLeague`: a private stand-in (its
 * settings say isPublic: false), so every league read carries the cookie.
 */
function failingOnce(view: string, during: () => Promise<void>, privateLeague = false): FetchLike {
  const recorded = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  let failed = false;
  return async (url, init) => {
    const v = viewsOf(url);
    if (v === view && !failed) {
      failed = true;
      await during();
      return jsonResponse({ messages: ["unavailable"] }, 503);
    }
    if (v === "mTransactions2")
      return jsonResponse(loadFixture("fx-10h/league/mTransactions2.json"));
    // the recordings answer a cookie-bearing request as ESPN would; fixture mode itself refuses
    // one, so the header is dropped on the way in (after the recording saw it)
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    delete headers.cookie;
    const r = await recorded(url, { ...init, headers });
    if (!privateLeague || !v.includes("mSettings")) return r;
    const body = (await r.json()) as { settings?: Record<string, unknown> };
    if (body.settings !== undefined) body.settings.isPublic = false;
    return jsonResponse(body);
  };
}

/** Each request sent: its views and whether it carried a Cookie header. */
const sends = (sent: { url: string; headers: Record<string, string> }[]) =>
  sent.map((s) => ({ views: viewsOf(s.url), cookie: s.headers.cookie !== undefined }));

describe("R3B-CS-2: a read in flight never re-sends a cookie rejected meanwhile", () => {
  it("a league not known public: the retry after the rejection is not sent, the read answers ESPN_AUTH_REJECTED", async () => {
    const { auth } = install("in-flight-private");
    let rejectedAt = -1;
    const w = makeWorld({
      credentials: auth,
      fetch: failingOnce(
        "mRoster",
        async () => {
          // a concurrent read's 401 (another view) records the rejection while this attempt waits
          await auth.observe(rejection("mTeam"));
          rejectedAt = w.sent.length;
        },
        true,
      ),
    });
    await expect(w.provider.getRosters(w.ref, 3)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    expect(auth.state()).toBe("rejected");
    expect(rejectedAt).toBeGreaterThan(0);
    const all = sends(w.sent);
    // the 503 attempt carried the cookie (accepted then); nothing after the rejection went out
    expect(all[rejectedAt - 1]).toEqual({ views: "mRoster", cookie: true });
    expect(all.slice(rejectedAt)).toEqual([]);
  });

  it("a league known public: the feed's retry goes keyless (changelog §R10, R10-10), the rejected cookie never sent", async () => {
    const { auth } = install("in-flight-public");
    let rejectedAt = -1;
    const w = makeWorld({
      credentials: auth,
      fetch: failingOnce("mTransactions2", async () => {
        await auth.observe(rejection("mRoster"));
        rejectedAt = w.sent.length;
      }),
    });
    // the league's settings say isPublic: true (the recording); the feed is read with the cookie
    // while one not rejected is at hand (auth-gate.ts `feed`)
    expect((await w.provider.getLeague(w.ref)).value.is_public).toBe(true);
    const feed = await w.provider.listTransactions(w.ref, {
      types: ["WAIVER", "FREEAGENT"],
      week: 3,
      since: null,
      count: 10,
      team_id: null,
    });
    expect(feed.stamp.source).toBe("espn:mTransactions2");
    const all = sends(w.sent);
    expect(all[rejectedAt - 1]).toEqual({ views: "mTransactions2", cookie: true });
    expect(all.slice(rejectedAt)).toEqual([{ views: "mTransactions2", cookie: false }]);
  });

  it("a value `eff setup` stored while the attempt waited is the one sent on the retry", async () => {
    const { auth, store, repo } = install("in-flight-old");
    const fresh = fakeCookies("in-flight-new");
    const FRESH_AT = "2026-10-06T11:00:00.000Z";
    let rejectedAt = -1;
    const w = makeWorld({
      credentials: auth,
      fetch: failingOnce(
        "mRoster",
        async () => {
          await auth.observe(rejection("mTeam"));
          // setup stores the new value, then its row
          store.set(fresh, FRESH_AT);
          repo.row = stateRow({ state: "stored", stored_at: FRESH_AT });
          rejectedAt = w.sent.length;
        },
        true,
      ),
    });
    const r = await w.provider.getRosters(w.ref, 3);
    expect(r.value.length).toBeGreaterThan(0);
    const after = w.sent.slice(rejectedAt);
    expect(after.map((s) => viewsOf(s.url))).toEqual(["mRoster"]);
    const header = after[0]?.headers.cookie ?? "";
    expect(header).toContain(fresh.espn_s2);
    expect(auth.state()).not.toBe("rejected");
  });
});
