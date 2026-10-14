// credential-reload.test.ts — Stage C remediation, round 1 (finding auth-running-server-misses-new-
// credential; plan 02 §2.2 "Multiple processes", plan 03 §1.1 step 4 [A-3], §6 L6): a server that
// started with nothing stored picks up a value `eff setup` stores while it runs — the next
// cookie-bearing call and the next `espn_check_auth` probe ask the authority, which reads the stored
// `storedAt`, instead of trusting the startup label. Covered over the REAL authority
// (src/auth/state.ts) and the composition root's probe access, for a fresh install (setup writes
// the row) and a wiped cache (items stored, no row: the label says not_configured and no other
// process will ever write the row). Nothing stored → still ESPN_REQUIRES_COOKIES / not_configured
// with no cookie and no extra request. No network; the cookies are run-time fakes.
import { describe, expect, it } from "vitest";
import { createCredentialAuthority } from "../../../src/auth/state.js";
import { CookieGate } from "../../../src/providers/espn/auth-gate.js";
import { withProbeAccess } from "../../../src/services/index.js";
import {
  MemoryStateRepo,
  MemoryStore,
  RecordingRegistrar,
  fakeCookies,
  stateRow,
} from "../../auth/helpers.js";
import {
  FakeAuthority,
  jsonResponse,
  loadFixture,
  loadRoster,
  makeWorld,
  NOW_ISO,
  testCookieHeader,
} from "./helpers.js";

const SETUP_AT = "2026-10-06T11:00:00.000Z";

function privateSettings(): unknown {
  const s = structuredClone(loadFixture("recorded/league-a/mSettings.json")) as {
    settings: Record<string, unknown>;
  };
  const nav = loadFixture("recorded/league-a/mNav.json") as Record<string, unknown>;
  s.settings.isPublic = false;
  return { ...s, members: nav.members, teams: nav.teams };
}

/** A private league: keyless → 401 AUTH_LEAGUE_NOT_VISIBLE; with a cookie → the recorded bodies. */
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
    if (views === "mSettings&mNav" || views === "mSettings")
      return Promise.resolve(jsonResponse(privateSettings()));
    if (views === "mRoster") return Promise.resolve(jsonResponse(loadRoster("league-a", 1)));
    if (views === "mPendingTransactions")
      return Promise.resolve(
        jsonResponse({
          ...(loadFixture("recorded/league-a/skeleton.json") as object),
          pendingTransactions: [],
        }),
      );
    return Promise.reject(new Error(`unscripted ${views}`));
  };
  return { fetch, log };
}

function realAuthority(store: MemoryStore, repo: MemoryStateRepo) {
  const registrar = new RecordingRegistrar();
  const base = createCredentialAuthority({
    store,
    repo,
    leagueId: "0",
    registrar,
    observer: "server",
    now: () => NOW_ISO,
  });
  return withProbeAccess(base, store, registrar);
}

describe("a credential stored while the server runs is picked up without a restart", () => {
  it("fresh install: not_configured → `eff setup` (value + row) → check_auth accepted, tools send the cookie", async () => {
    const store = new MemoryStore("keychain");
    const repo = new MemoryStateRepo();
    const auth = realAuthority(store, repo);
    const league = privateLeague();
    const w = makeWorld({ credentials: auth, fetch: league.fetch });
    expect(auth.state()).toBe("not_configured");
    // before setup: nothing stored — the probe sends nothing, a cookie-only view refuses
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: null,
      reason: "not_configured",
    });
    expect(league.log).toEqual([]);
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    expect(league.log.every((l) => !l.cookie)).toBe(true);
    // another terminal: `eff setup` stores the value and writes the row it validated
    store.set(fakeCookies("reload"), SETUP_AT);
    repo.row = stateRow({
      state: "validated",
      stored_at: SETUP_AT,
      last_accepted_at: SETUP_AT,
      updated_by: "setup",
    });
    w.clock.advance(61_000);
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: true,
      probe: "settings",
      upstream_status: 200,
    });
    const pending = await w.provider.listPendingTransactions(w.ref);
    expect(pending.value).toEqual([]);
    expect(
      league.log.filter((l) => l.views === "mPendingTransactions").map((l) => l.cookie),
    ).toEqual([true]);
    expect(auth.state()).toBe("validated");
  });

  it("wiped cache: the items are stored but no row exists — the label alone said not_configured", async () => {
    const store = new MemoryStore("keychain");
    store.set(fakeCookies("wiped"), SETUP_AT);
    const repo = new MemoryStateRepo();
    const auth = realAuthority(store, repo);
    const league = privateLeague();
    const w = makeWorld({ credentials: auth, fetch: league.fetch });
    expect(auth.state()).toBe("not_configured");
    expect(store.reads).toBe(0);
    const probe = await w.provider.probeCredential(w.ref);
    expect(probe).toMatchObject({ accepted: true, probe: "settings", upstream_status: 200 });
    // the acceptance landed on a row recreated for the stored value (plan 03 §1.1 step 4 [A-3])
    expect(repo.row).toMatchObject({ league_id: "0", stored_at: SETUP_AT, state: "validated" });
    expect(auth.state()).toBe("validated");
    w.clock.advance(1000);
    const rosters = await w.provider.getRosters(w.ref, 1);
    expect(rosters.value.length).toBe(10);
    const rosterSends = league.log.filter((l) => l.views === "mRoster");
    expect(rosterSends.map((l) => l.cookie)).toEqual([true]);
  });

  it("wiped cache, no probe first: the first cookie-bearing tool call loads the value and sends it", async () => {
    const store = new MemoryStore("file");
    store.set(fakeCookies("first-call"), SETUP_AT);
    const repo = new MemoryStateRepo();
    const auth = realAuthority(store, repo);
    const league = privateLeague();
    const w = makeWorld({ credentials: auth, fetch: league.fetch });
    const pending = await w.provider.listPendingTransactions(w.ref);
    expect(pending.value).toEqual([]);
    expect(league.log.map((l) => l.cookie)).toEqual([true, true]);
    expect(auth.state()).not.toBe("not_configured");
  });

  it("the gate asks the authority whatever the label says (the label is not the store)", async () => {
    // an authority whose startup label is not_configured but whose store holds a value now
    const SWID = "{00000000-0000-4000-8000-000000000012}";
    const header = testCookieHeader(SWID);
    const a = new FakeAuthority("validated", { ok: true, header });
    a.state = () => "not_configured";
    const g = new CookieGate(a, w0clock(), "server");
    expect(await g.forRequest("required", "league")).toBe(header);
    expect(await g.forRequest("auto", "league")).toBe(header);
    expect(await new CookieGate(a, w0clock(), "server").memberId()).toBe(SWID);
    // season routes and a known-public league's auto reads still never ask
    const calls = a.headerCalls;
    expect(await g.forRequest("auto", "season")).toBeNull();
    g.learnPublic(true);
    expect(await g.forRequest("auto", "league")).toBeNull();
    expect(a.headerCalls).toBe(calls);
  });

  it("a store that cannot be read on an install that never recorded a value stays keyless (no INTERNAL)", async () => {
    // a keychain that will not load where setup never ran: asking must not turn every read into
    // INTERNAL; behind a recorded value the same failure is INTERNAL as before (doctor #6/#7)
    const none = new FakeAuthority("stored", { ok: false, reason: "unreadable" });
    none.state = () => "not_configured";
    const g = new CookieGate(none, w0clock(), "server");
    expect(await g.forRequest("auto", "league")).toBeNull();
    await expect(g.forRequest("required", "league")).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
      effDetails: { reason: "no_credential" },
    });
    expect(await g.memberId()).toBeNull();
    const recorded = new CookieGate(
      new FakeAuthority("stored", { ok: false, reason: "unreadable" }),
      w0clock(),
      "server",
    );
    await expect(recorded.forRequest("auto", "league")).rejects.toMatchObject({
      effCode: "INTERNAL",
      effDetails: { reason: "credential_unreadable" },
    });
    // a stored value that fails the format rules is never "nothing stored"
    const bad = new FakeAuthority("stored", { ok: false, reason: "invalid_format" });
    bad.state = () => "not_configured";
    await expect(
      new CookieGate(bad, w0clock(), "server").forRequest("auto", "league"),
    ).rejects.toMatchObject({
      effCode: "INTERNAL",
      effDetails: { reason: "credential_invalid_format" },
    });
  });

  it("the probe: nothing stored → not_configured with zero requests, whatever the row says", async () => {
    const store = new MemoryStore("file");
    const repo = new MemoryStateRepo();
    // a stale row from before `eff setup --reset` emptied the store
    repo.row = stateRow({ state: "validated", stored_at: SETUP_AT });
    const auth = realAuthority(store, repo);
    const league = privateLeague();
    const w = makeWorld({ credentials: auth, fetch: league.fetch });
    expect(await w.provider.probeCredential(w.ref)).toMatchObject({
      accepted: null,
      reason: "not_configured",
      upstream_status: null,
    });
    expect(league.log).toEqual([]);
  });
});

function w0clock() {
  return makeWorld().clock;
}
