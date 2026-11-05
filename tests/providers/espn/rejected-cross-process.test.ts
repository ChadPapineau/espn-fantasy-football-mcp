// rejected-cross-process.test.ts — the round-4 verifier's V4-S1 (plan 02 §2.1 "Short-circuit": zero
// requests once rejected; the round-3 review's R3B-CS-2, which 946f486 fixed for one process): a read
// in flight never sends a cookie rejected meanwhile, whoever recorded the rejection and however many
// times the gate is asked again.
// (a) Another PROCESS records it: a launchd job, a second `eff serve` or `eff doctor` shares the
//     credential_state row, and the limiter's windows are cross-process, so a wait in which another
//     process's cookie-bearing 401 lands is ordinary. The in-flight re-check read this process's
//     label only (state() re-reads the row only while not_configured), and the retry went out with
//     the rejected cookie. The authority's rejectedNow now reads the row: one SQLite row read, never
//     a credential-store read.
// (b) The re-ask hands out a NEW value (`eff setup` stored one meanwhile) and the attempt waits at
//     the limiter again; a concurrent 401 rejects that value during this second wait. The attempt
//     was sent without a second check. Every acquire is now followed by the check (bounded).
// Over the REAL authority (src/auth/state.ts), two of them sharing one row for (a), on the fake
// transport; the cookies are run-time fakes. No network.
// (a) runs as the processes are composed (the round-4b review's CS-1): `eff serve` and every `eff`
// command hand the provider the authority wrapped by withProbeAccess (src/services/index.ts,
// src/cli/espn-stack.ts). Both wrappers dropped rejectedNow, so the gate read the label only and the
// retry went out with the rejected cookie in every real process; the unwrapped authority hid it.
import { describe, expect, it } from "vitest";
import {
  createCredentialAuthority,
  type CredentialAuthorityHandle,
} from "../../../src/auth/state.js";
import type {
  CredentialObservation,
  CredentialObserver,
  CredentialStore,
} from "../../../src/auth/types.js";
import { withProbeAccess as cliProbeAccess } from "../../../src/cli/espn-stack.js";
import { createFixtureFetch, type FetchLike } from "../../../src/providers/espn/index.js";
import { REJECTED_REASK_ROUNDS } from "../../../src/providers/espn/request.js";
import { withProbeAccess as serveProbeAccess } from "../../../src/services/index.js";
import {
  MemoryStateRepo,
  MemoryStore,
  RecordingRegistrar,
  fakeCookies,
  stateRow,
} from "../../auth/helpers.js";
import { FIXTURES, NOW_ISO, jsonResponse, makeWorld } from "./helpers.js";

const SETUP_AT = "2026-10-01T11:00:00.000Z";
const viewsOf = (url: string): string => new URL(url).searchParams.getAll("view").join("&");

const rejection = (
  view: CredentialObservation["view"],
  by: CredentialObserver = "server",
): CredentialObservation => ({ kind: "rejected", at: NOW_ISO, by, upstream_status: 401, view });

/** One install's store and row, and an authority per process over them. */
function install(label: string) {
  const store = new MemoryStore("keychain");
  const cookies = fakeCookies(label);
  store.set(cookies, SETUP_AT);
  const repo = new MemoryStateRepo();
  repo.row = stateRow({ state: "stored", stored_at: SETUP_AT });
  const authority = (observer: CredentialObserver) =>
    createCredentialAuthority({
      store,
      repo,
      leagueId: "0",
      registrar: new RecordingRegistrar(),
      observer,
      now: () => NOW_ISO,
    });
  return { store, repo, cookies, authority };
}

/**
 * league-a's recordings as a PRIVATE league (its settings say isPublic: false, so every league read
 * carries the cookie), where the first answer for `view` is a 503 (retryable) and `during` runs while
 * that attempt is in flight. The Cookie header is dropped on the way in (fixture mode refuses one).
 */
function privateFailingOnce(view: string, during: () => Promise<void>): FetchLike {
  const recorded = createFixtureFetch({ dir: FIXTURES, league: "league-a" });
  let failed = false;
  return async (url, init) => {
    const v = viewsOf(url);
    if (v === view && !failed) {
      failed = true;
      await during();
      return jsonResponse({ messages: ["unavailable"] }, 503);
    }
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    delete headers.cookie;
    const r = await recorded(url, { ...init, headers });
    if (!v.includes("mSettings")) return r;
    const body = (await r.json()) as { settings?: Record<string, unknown> };
    if (body.settings !== undefined) body.settings.isPublic = false;
    return jsonResponse(body);
  };
}

/** How a composition root hands the provider its authority (the round-4b review's CS-1). */
const COMPOSED: readonly (readonly [
  string,
  (a: CredentialAuthorityHandle, store: CredentialStore) => CredentialAuthorityHandle,
])[] = [
  ["unwrapped", (a) => a],
  [
    "eff serve's withProbeAccess",
    (a, store) => serveProbeAccess(a, store, new RecordingRegistrar()),
  ],
  [
    "the eff commands' withProbeAccess",
    (a, store) => cliProbeAccess(a, store, new RecordingRegistrar()),
  ],
];

describe.each(COMPOSED)("V4-S1 (a) as composed (%s)", (_label, compose) => {
  it("the retry after another process's 401 is not sent; the read answers ESPN_AUTH_REJECTED", async () => {
    const { store, repo, authority } = install("xproc-composed");
    const base = authority("server");
    const server = compose(base, store);
    const job = authority("daily_job");
    let rejectedAt = -1;
    const w = makeWorld({
      credentials: server,
      fetch: privateFailingOnce("mRoster", async () => {
        await job.getCookieHeader();
        await job.observe(rejection("mTeam", "daily_job"));
        rejectedAt = w.sent.length;
      }),
    });
    await expect(w.provider.getRosters(w.ref, 3)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    expect(repo.row?.state).toBe("rejected");
    expect(rejectedAt).toBeGreaterThan(0);
    expect(w.sent.slice(rejectedAt)).toEqual([]);
    expect(server.rejectedNow()).toBe(true);
    expect(base.holdsSecret()).toBe(false);
  });
});

describe("V4-S1 (a): a rejection another process records while the read waits is honoured", () => {
  it("the retry after another process's 401 is not sent; the read answers ESPN_AUTH_REJECTED", async () => {
    const { store, repo, authority } = install("xproc");
    const server = authority("server");
    const job = authority("daily_job");
    let rejectedAt = -1;
    const w = makeWorld({
      credentials: server,
      fetch: privateFailingOnce("mRoster", async () => {
        // the other process: its own cookie-bearing request got a 401 and it recorded it
        await job.getCookieHeader();
        await job.observe(rejection("mTeam", "daily_job"));
        rejectedAt = w.sent.length;
      }),
    });
    await expect(w.provider.getRosters(w.ref, 3)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    expect(repo.row?.state).toBe("rejected");
    expect(rejectedAt).toBeGreaterThan(0);
    // the 503 attempt carried the cookie (accepted then); nothing went out after the rejection
    expect(w.sent[rejectedAt - 1]?.headers.cookie).toBeDefined();
    expect(w.sent.slice(rejectedAt)).toEqual([]);
    // this process adopted the row's rejection, from metadata: the secret it held is dropped
    expect(server.state()).toBe("rejected");
    expect(server.holdsSecret()).toBe(false);
    const reads = store.reads;
    await expect(w.provider.getRosters(w.ref, 3)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    expect(store.reads).toBe(reads);
  });

  it("the authority's rejectedNow: the label, else the shared row for the value held — one row read, no store read", async () => {
    const { store, repo, authority } = install("xproc-unit");
    const a = authority("server");
    expect((await a.getCookieHeader()).ok).toBe(true);
    const reads = store.reads;
    const metaReads = store.metaReads;
    expect(a.rejectedNow()).toBe(false);
    // a row rejecting ANOTHER value (one stored since, rejected): not the held one
    repo.row = stateRow({ state: "rejected", stored_at: "2026-10-09T00:00:00.000Z" });
    expect(a.rejectedNow()).toBe(false);
    expect(a.state()).toBe("stored");
    // a row read that fails proves nothing
    repo.row = stateRow({ state: "rejected", stored_at: SETUP_AT });
    repo.failGet = true;
    expect(a.rejectedNow()).toBe(false);
    repo.failGet = false;
    // the row rejects the held value: adopted (label, dropped secret), and it stays rejected
    expect(a.rejectedNow()).toBe(true);
    expect(a.state()).toBe("rejected");
    expect(a.holdsSecret()).toBe(false);
    expect(a.rejectedNow()).toBe(true);
    expect(store.reads).toBe(reads);
    expect(store.metaReads).toBe(metaReads);
    // a row without stored_at is taken to describe the held value, as getCookieHeader takes it
    const other = install("xproc-no-stored-at");
    const b = other.authority("server");
    expect((await b.getCookieHeader()).ok).toBe(true);
    other.repo.row = stateRow({ state: "rejected", stored_at: null });
    expect(b.rejectedNow()).toBe(true);
    // nothing loaded: a rejected row is adopted as the startup label is
    const third = install("xproc-unloaded");
    const c = third.authority("server");
    third.repo.row = stateRow({ state: "rejected", stored_at: SETUP_AT });
    expect(c.rejectedNow()).toBe(true);
    expect((await c.getCookieHeader()).ok).toBe(false);
  });
});

describe("V4-S1 (b): the value a re-ask hands out is checked again after the wait that follows", () => {
  it("rejected during the re-acquire's wait: never sent; the read answers ESPN_AUTH_REJECTED", async () => {
    const { store, repo, authority } = install("reask-old");
    const auth = authority("server");
    const fresh = fakeCookies("reask-new");
    const FRESH_AT = "2026-10-06T11:00:00.000Z";
    let armed = false;
    let rejectedNewAt = -1;
    let sleeps = 0;
    const w = makeWorld({
      credentials: auth,
      fetch: privateFailingOnce("mRoster", async () => {
        // the old value is rejected during the 503 attempt; `eff setup` stores a new one
        await auth.observe(rejection("mTeam"));
        store.set(fresh, FRESH_AT);
        repo.row = stateRow({ state: "stored", stored_at: FRESH_AT });
        armed = true;
      }),
      over: {
        sleep: (ms: number) => {
          w.clock.advance(ms);
          if (armed) {
            sleeps++;
            // the first armed sleep is the retry's backoff, the second the re-acquire's 1/s wait:
            // a concurrent read's 401 rejects the NEW value then
            if (sleeps === 2) {
              void auth.observe(rejection("mMatchup"));
              rejectedNewAt = w.sent.length;
            }
          }
          return Promise.resolve();
        },
      },
    });
    await expect(w.provider.getRosters(w.ref, 3)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
      effDetails: { reason: "short_circuit" },
    });
    expect(rejectedNewAt).toBeGreaterThan(0);
    expect(
      w.sent.slice(rejectedNewAt).filter((s) => (s.headers.cookie ?? "").includes(fresh.espn_s2)),
    ).toEqual([]);
    expect(w.sent.slice(rejectedNewAt)).toEqual([]);
  });

  it("is bounded: values rejected round after round end the attempt with the short-circuit, nothing sent", async () => {
    const { store, repo, authority } = install("reask-bounded");
    const auth = authority("server");
    let round = 0;
    let armed = false;
    let rejectedAt = -1;
    const storeNew = () => {
      round++;
      const at = `2026-10-0${String(round + 1)}T11:00:00.000Z`;
      const c = fakeCookies(`reask-bounded-${String(round)}`);
      store.set(c, at);
      repo.row = stateRow({ state: "stored", stored_at: at });
    };
    const w = makeWorld({
      credentials: auth,
      fetch: privateFailingOnce("mRoster", async () => {
        await auth.observe(rejection("mTeam"));
        storeNew();
        armed = true;
        rejectedAt = w.sent.length;
      }),
      over: {
        sleep: (ms: number) => {
          w.clock.advance(ms);
          // after the retry's backoff, every wait at the limiter ends with the value just handed
          // out rejected and another stored (a pathological owner, re-running setup each second)
          if (armed && round <= REJECTED_REASK_ROUNDS + 1) {
            void auth.observe(rejection("mMatchup"));
            storeNew();
          }
          return Promise.resolve();
        },
      },
    });
    await expect(w.provider.getRosters(w.ref, 3)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    // the bound ended it: more values were stored and rejected than the rounds allow, and the one
    // stored after the last rejection (accepted, were it sent) never went out
    expect(round).toBeGreaterThan(REJECTED_REASK_ROUNDS + 1);
    expect(rejectedAt).toBeGreaterThan(0);
    expect(w.sent.slice(rejectedAt)).toEqual([]);
  });
});
