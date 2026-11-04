// rejected-public-live.test.ts — changelog §R10, R10-7, the server side: what the server does in
// credential state `rejected` on a PUBLIC league, over the REAL authority (src/auth/state.ts, the
// composition root's probe access) and the provider's cookie gate (src/providers/espn/auth-gate.ts)
// on the fake transport — never fixture mode's scripted label (src/services/fixture-credential.ts).
// Plan 02 §2.1 "Short-circuit": in Rejected, getCookieHeader answers the typed failure with no
// request; "tools that work anonymously on a public league continue without cookies if the league
// is public — the server tries anonymously once to learn settings.isPublic and remembers it".
// Research 03 §B: the cookie-only views (mTransactions2, mPendingTransactions) are empty
// anonymously, so they stay behind the short-circuit (ESPN_AUTH_REJECTED, zero requests). What is
// held here: every `auto` read goes keyless after one anonymous settings read; the rejected cookie
// is never sent — its secret is never even loaded; a private league still answers
// ESPN_AUTH_REJECTED after its one anonymous 401; a new `eff setup` lifts it with the NEW value. No
// network; the cookies are run-time fakes (tests/auth/helpers.ts).
import { describe, expect, it } from "vitest";
import { createCredentialAuthority } from "../../../src/auth/state.js";
import { withProbeAccess } from "../../../src/services/index.js";
import {
  MemoryStateRepo,
  MemoryStore,
  RecordingRegistrar,
  fakeCookies,
  stateRow,
} from "../../auth/helpers.js";
import { NOW_ISO, jsonResponse, loadFixture, makeWorld } from "./helpers.js";

const SETUP_AT = "2026-10-01T11:00:00.000Z";
const REJECTED_AT = "2026-10-05T09:00:00.000Z";

/** A store holding `label`'s fake cookies, and a row recording that very value rejected. */
function rejectedInstall(label: string) {
  const store = new MemoryStore("keychain");
  const cookies = fakeCookies(label);
  store.set(cookies, SETUP_AT);
  const repo = new MemoryStateRepo();
  repo.row = stateRow({
    state: "rejected",
    stored_at: SETUP_AT,
    last_rejected_at: REJECTED_AT,
    rejected_since: REJECTED_AT,
    rejected_view: "mRoster",
    updated_at: REJECTED_AT,
    updated_by: "server",
  });
  const registrar = new RecordingRegistrar();
  const auth = withProbeAccess(
    createCredentialAuthority({
      store,
      repo,
      leagueId: "0",
      registrar,
      observer: "server",
      now: () => NOW_ISO,
    }),
    store,
    registrar,
  );
  return { store, repo, auth, cookies };
}

/** The views of each request the provider sent, and whether it carried a Cookie header. */
const sends = (sent: { url: string; headers: Record<string, string> }[]) =>
  sent.map((s) => ({
    views: new URL(s.url).searchParams.getAll("view").join("&"),
    cookie: s.headers.cookie !== undefined,
  }));

describe("R10-7: credential state rejected on a public league (the live code path)", () => {
  it("every auto read goes keyless after ONE anonymous settings read; the cookie-only views short-circuit", async () => {
    const { store, auth, cookies } = rejectedInstall("r10-7-public");
    // league-a's recorded settings say isPublic: true
    const w = makeWorld({ credentials: auth });
    expect(auth.state()).toBe("rejected");

    const league = await w.provider.getLeague(w.ref);
    expect(league.value.is_public).toBe(true);
    // the one anonymous read that learns the league's publicity (plan 02 §2.1)
    expect(sends(w.sent)).toEqual([{ views: "mSettings&mNav", cookie: false }]);

    // the reads the waiver, roster and matchup tools make: all keyless, all answered
    const standings = await w.provider.getStandings(w.ref);
    expect(standings.value.teams.length).toBeGreaterThan(0);
    const rosters = await w.provider.getRosters(w.ref, 3);
    expect(rosters.value.length).toBeGreaterThan(0);
    const box = await w.provider.getBoxScores(w.ref, 3);
    expect(box.value.length).toBeGreaterThan(0);
    const before = w.sent.length;
    expect(before).toBeGreaterThan(1);

    // the cookie-only views (empty anonymously, research 03 §B): ESPN_AUTH_REJECTED, no request
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    await expect(
      w.provider.listTransactions(w.ref, {
        types: ["WAIVER", "FREEAGENT"],
        week: 4,
        since: null,
        count: 10,
        team_id: null,
      }),
    ).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    expect(w.sent.length).toBe(before);

    // the rejected cookie was never sent, and its secret was never loaded (meta reads only)
    expect(sends(w.sent).every((s) => !s.cookie)).toBe(true);
    for (const s of w.sent) expect(JSON.stringify(s.headers)).not.toContain(cookies.swid);
    expect(store.reads).toBe(0);
    // keyless 200s on a public league prove nothing: the state stays rejected (no observation)
    expect(auth.state()).toBe("rejected");
  });

  it.each([
    ["getRosters", (w: ReturnType<typeof makeWorld>) => w.provider.getRosters(w.ref, 3)],
    ["getStandings", (w: ReturnType<typeof makeWorld>) => w.provider.getStandings(w.ref)],
    ["getBoxScores", (w: ReturnType<typeof makeWorld>) => w.provider.getBoxScores(w.ref, 2)],
    ["getMatchups", (w: ReturnType<typeof makeWorld>) => w.provider.getMatchups(w.ref)],
  ] as const)(
    "a fresh process whose first read is %s learns the publicity first, then reads keyless",
    async (_name, read) => {
      const { store, auth } = rejectedInstall("r10-7-first");
      const w = makeWorld({ credentials: auth });
      await expect(read(w)).resolves.toBeTruthy();
      expect(sends(w.sent)[0]).toEqual({ views: "mSettings&mNav", cookie: false });
      expect(sends(w.sent).every((s) => !s.cookie)).toBe(true);
      expect(store.reads).toBe(0);
    },
  );

  it("a private league: its one anonymous read answers 401, then ESPN_AUTH_REJECTED with zero requests", async () => {
    const { store, auth } = rejectedInstall("r10-7-private");
    const sentCookies: boolean[] = [];
    const w = makeWorld({
      credentials: auth,
      fetch: (_url, init) => {
        const cookie = (init.headers as Record<string, string>).cookie !== undefined;
        sentCookies.push(cookie);
        return Promise.resolve(
          cookie
            ? jsonResponse(loadFixture("recorded/league-a/mSettings.json"))
            : jsonResponse(
                { messages: ["x"], details: [{ type: "AUTH_LEAGUE_NOT_VISIBLE" }] },
                401,
              ),
        );
      },
    });
    await expect(w.provider.getLeague(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    expect(sentCookies).toEqual([false]);
    for (const read of [
      () => w.provider.getRosters(w.ref, 4),
      () => w.provider.getStandings(w.ref),
      () => w.provider.listPendingTransactions(w.ref),
    ])
      await expect(read()).rejects.toMatchObject({ effCode: "ESPN_AUTH_REJECTED" });
    expect(sentCookies).toEqual([false]);
    expect(store.reads).toBe(0);
  });

  it("a new `eff setup` lifts it: the NEW value is sent, the rejected one never", async () => {
    const { store, repo, auth, cookies: old } = rejectedInstall("r10-7-lift");
    const w = makeWorld({ credentials: auth });
    await w.provider.getLeague(w.ref);
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    // another terminal: `eff setup` stores a new value and records it validated
    const fresh = fakeCookies("r10-7-lift-new");
    const at = "2026-10-06T11:30:00.000Z";
    store.set(fresh, at);
    repo.row = stateRow({
      state: "validated",
      stored_at: at,
      last_accepted_at: at,
      updated_at: at,
      updated_by: "setup",
    });
    // a cookie-only view now asks the authority, which reloads the new value and sends it
    await w.provider.listPendingTransactions(w.ref).catch(() => undefined);
    const withCookie = w.sent.filter((s) => s.headers.cookie !== undefined);
    expect(withCookie.length).toBeGreaterThan(0);
    for (const s of withCookie) {
      expect(s.headers.cookie).toContain(fresh.swid);
      expect(s.headers.cookie).not.toContain(old.swid);
    }
  });
});
