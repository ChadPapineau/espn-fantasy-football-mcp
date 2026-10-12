// store-switch.test.ts — a running server across `eff setup --storage …` in another terminal
// (Stage C finding auth-store-switch-deletes-credential-row; plan 02 §2.1 "Where the state lives",
// §2.2 "One store per install", "Multiple processes"; plan 03 §1.1 step 4, §6, L6; plan 06 §1.4).
// The real `eff setup` orchestration (src/auth/setup.ts) runs against the real keychain adapter over
// an in-memory keyring and the real 0600 file store in a temp HOME; the server holds the install
// store (src/auth/stores.ts) and the authority (src/auth/state.ts) exactly as the composition root
// wires them, plus the composition root's own probe access. The switch is picked up with no
// restart, the row setup wrote is never deleted by the server (so `eff status` and the daily
// credential check keep seeing it), and a fixed backend that cannot follow at worst reports
// not_configured without touching that row. A property drives random interleavings of setups
// (either store), resets, server calls, probe reads and observations.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCookieHeader } from "../../src/auth/format.js";
import type { KeychainSelftestResult } from "../../src/auth/selftest.js";
import {
  runSetup,
  type PromptAnswer,
  type SetupConfigPatch,
  type SetupRequest,
} from "../../src/auth/setup.js";
import { createCredentialAuthority, deriveStartupState } from "../../src/auth/state.js";
import { openCredentialStore, openCredentialStores } from "../../src/auth/stores.js";
import {
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_SERVICE,
  type CookieHeaderResult,
  type CredentialStore,
  type CredentialStoreKind,
  type EspnCookies,
} from "../../src/auth/types.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { withProbeAccess } from "../../src/services/index.js";
import { ROOT, noXattrs, tempDir } from "../config/helpers.js";
import {
  FakeKeyring,
  MemoryStateRepo,
  MemoryStore,
  RecordingRegistrar,
  fakeCookies,
  stateRow,
} from "./helpers.js";

const LEAGUE = "0";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T5 = "2026-10-06T00:00:00.000Z";
const T6 = "2026-10-07T00:00:00.000Z";

/** A keyring that can run a hook after one account's delete (another process acting mid-setup). */
class HookedKeyring extends FakeKeyring {
  afterDelete: { account: string; run: () => Promise<void> } | null = null;
  override async deletePassword(
    service: string,
    account: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const r = await super.deletePassword(service, account, signal);
    const h = this.afterDelete;
    if (h !== null && h.account === account) {
      this.afterDelete = null;
      await h.run();
    }
    return r;
  }
}

let tmp: { dir: string; cleanup: () => void };
let kr: HookedKeyring;
let cfg: Parameters<typeof openCredentialStores>[0];
let repo: MemoryStateRepo;
let clock: string;

beforeEach(() => {
  tmp = tempDir("eff-auth-switch-");
  const home = path.join(tmp.dir, "home");
  mkdirSync(home, { mode: 0o700 });
  kr = new HookedKeyring();
  cfg = {
    filePath: path.join(home, ".config", "espn-fantasy-football-mcp", "session.json"),
    home,
    repoRoot: ROOT,
    xattr: noXattrs,
    loadKeyring: () => Promise.resolve(kr),
  };
  repo = new MemoryStateRepo();
  clock = T1;
});
afterEach(() => {
  tmp.cleanup();
});

/** `eff setup [--storage kind]` in another terminal: private league, probe 200, one team. */
async function setup(
  cookies: EspnCookies,
  at: string,
  storage: CredentialStoreKind | null,
  recordedStore: CredentialStoreKind | null,
): Promise<{ readonly exitCode: number; readonly patches: SetupConfigPatch[] }> {
  const answers: PromptAnswer[] = [
    { kind: "answer", value: cookies.swid },
    { kind: "answer", value: cookies.espn_s2 },
  ];
  const patches: SetupConfigPatch[] = [];
  const req: SetupRequest = {
    reset: false,
    storage,
    serviceName: null,
    leagueId: LEAGUE,
    season: 2026,
    recordedStore,
    filePath: cfg.filePath,
  };
  const r = await runSetup(req, {
    prompt: { ask: () => Promise.resolve(answers.shift() ?? { kind: "closed" }) },
    out: () => undefined,
    now: () => at,
    stores: openCredentialStores(cfg), // setup's own process opens both backends
    runSelftest: (): Promise<KeychainSelftestResult> =>
      Promise.resolve({ outcome: "ok", reason: "ok", code: null, at, cleanup: "deleted" }),
    network: {
      anonymousSettings: () => Promise.resolve({ status: 401 }),
      anonymousBoard: () => Promise.resolve({ error: "unused" }),
      settingsWithCookies: () => Promise.resolve({ status: 200 }),
      boardWithCookies: () => Promise.resolve({ error: "unused" }),
      resolveTeam: () => Promise.resolve({ kind: "one", teamId: 3 }),
    },
    config: {
      record: (p) => {
        patches.push(p);
        return Promise.resolve();
      },
    },
    credentialState: repo,
    registrar: new RecordingRegistrar(),
  });
  return { exitCode: r.exitCode, patches };
}

/** The server as the composition root wires it, on the store config.json recorded at start. */
function server(startKind: CredentialStoreKind, store?: CredentialStore) {
  const reg = new RecordingRegistrar();
  const s = store ?? openCredentialStore(startKind, cfg);
  const auth = createCredentialAuthority({
    store: s,
    repo,
    leagueId: LEAGUE,
    registrar: reg,
    observer: "server",
    now: () => clock,
  });
  return { auth, probing: withProbeAccess(auth, s, reg), store: s, reg };
}

/** True when `r` carries exactly the header for `c` (compared, never printed). */
const carries = (r: CookieHeaderResult, c: EspnCookies): boolean =>
  r.ok && r.header === buildCookieHeader(c);

/** What `eff status` derives and what the daily `credential-check` gates on (src/cli). */
function observers(storeKind: CredentialStoreKind) {
  const row = repo.get();
  return {
    status: deriveStartupState({ row, leagueId: LEAGUE, storeKind, fileStoreExists: true }),
    storedAt: row?.stored_at ?? null,
    store: row?.store ?? null,
    dailyCheckProbes: row?.league_id === LEAGUE && row.state !== "not_configured",
  };
}

describe("`eff setup --storage file` while a keychain server runs (the finding's repro)", () => {
  it("the next cookie-bearing call reads the file, and the row setup wrote stays", async () => {
    const a = fakeCookies("switch-a");
    const b = fakeCookies("switch-b");
    expect((await setup(a, T0, "keychain", null)).exitCode).toBe(0);
    const srv = server("keychain");
    expect(srv.auth.state()).toBe("validated");
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true); // espn_check_auth / any read

    const sw = await setup(b, T5, "file", "keychain");
    expect(sw.exitCode).toBe(0);
    expect(sw.patches[0]).toMatchObject({ EFF_CREDENTIAL_STORE: "file" });
    expect(kr.peek(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNTS.meta)).toBeUndefined();
    expect(observers("file")).toEqual({
      status: "validated",
      storedAt: T5,
      store: "file",
      dailyCheckProbes: true,
    });

    // espn_get_roster: the server picks the switch up — no ESPN_REQUIRES_COOKIES, no restart
    clock = T6;
    expect(srv.auth.state()).toBe("validated");
    const r = await srv.auth.getCookieHeader();
    expect(carries(r, b)).toBe(true);
    expect(srv.auth.state()).toBe("validated");
    expect(srv.store.kind).toBe("file");
    expect(srv.reg.registered.some((x) => x.value === b.espn_s2)).toBe(true);

    // eff status still shows validated (file) with its stored_at; the daily check still probes
    expect(observers("file")).toEqual({
      status: "validated",
      storedAt: T5,
      store: "file",
      dailyCheckProbes: true,
    });
  });

  it("espn_check_auth as the FIRST call after the switch probes with the file's value", async () => {
    const a = fakeCookies("switch-p-a");
    const b = fakeCookies("switch-p-b");
    await setup(a, T0, "keychain", null);
    const srv = server("keychain");
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    await setup(b, T5, "file", "keychain");
    expect(srv.auth.state()).toBe("validated"); // the provider's configured() gate
    expect(carries(await srv.probing.getCookieHeaderForProbe(), b)).toBe(true);
    expect(observers("file").dailyCheckProbes).toBe(true);
  });

  it("the reverse switch (`--storage keychain` while a file-store server runs) is followed too", async () => {
    const a = fakeCookies("switch-r-a");
    const b = fakeCookies("switch-r-b");
    await setup(a, T0, "file", null);
    const srv = server("file");
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    await setup(b, T5, "keychain", "file");
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
    expect(srv.store.kind).toBe("keychain");
    expect(observers("keychain")).toMatchObject({ status: "validated", store: "keychain" });
  });

  it("a call that lands mid-switch (keychain emptied, new row not yet written) recovers with no restart", async () => {
    const a = fakeCookies("switch-m-a");
    const b = fakeCookies("switch-m-b");
    await setup(a, T0, "keychain", null);
    const srv = server("keychain");
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    let mid: CookieHeaderResult | null = null;
    kr.afterDelete = {
      account: KEYCHAIN_ACCOUNTS.swid, // setup has just emptied the keychain
      run: async () => {
        mid = await srv.auth.getCookieHeader();
      },
    };
    await setup(b, T5, "file", "keychain");
    // the old value really had vanished: not_configured then, and the row describing it cleared
    expect(mid).toEqual({ ok: false, reason: "not_configured" });
    // setup then recorded the new value: the label follows it, so the provider asks again
    expect(srv.auth.state()).toBe("validated");
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
    expect(observers("file")).toMatchObject({ status: "validated", storedAt: T5, store: "file" });
  });

  it("a server started before the first `eff setup` picks the new value up (plan 03 L6)", async () => {
    const srv = server("keychain");
    expect(srv.auth.state()).toBe("not_configured");
    expect(await srv.auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    const a = fakeCookies("switch-f-a");
    await setup(a, T5, null, "keychain");
    expect(srv.auth.state()).toBe("validated");
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
  });
});

describe("a fixed backend that cannot follow: at worst not_configured, the row untouched", () => {
  it("a row naming the other backend is never cleared, and the label does not flap", async () => {
    const keychain = new MemoryStore("keychain"); // empty: setup moved the value to the file
    const row = stateRow({
      state: "validated",
      store: "file",
      stored_at: T5,
      last_accepted_at: T5,
    });
    repo.row = row;
    const srv = server("keychain", keychain);
    expect(srv.auth.state()).toBe("validated");
    expect(await srv.auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    expect(repo.row).toBe(row);
    expect(srv.auth.state()).toBe("not_configured");
    expect(srv.auth.state()).toBe("not_configured"); // the same row never re-arms the label
    expect(keychain.reads + keychain.metaReads).toBe(1);
    expect(observers("file")).toMatchObject({ status: "validated", dailyCheckProbes: true });
  });

  it("a row for a value this backend held (same store) is still cleared when the value vanishes", async () => {
    const keychain = new MemoryStore("keychain");
    repo.row = stateRow({ state: "validated", store: "keychain", stored_at: T0 });
    const srv = server("keychain", keychain);
    expect(await srv.auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    expect(repo.row).toBeNull();
    expect(srv.auth.state()).toBe("not_configured");
  });

  it("a value read from one backend never replaces a row naming the other, or a later value", async () => {
    const keychain = new MemoryStore("keychain");
    const a = fakeCookies("switch-x-a");
    keychain.set(a, T0); // a leftover the two-store check (doctor #6) reports
    const other = stateRow({ state: "validated", store: "file", stored_at: T5 });
    repo.row = other;
    const srv = server("keychain", keychain);
    expect((await srv.auth.getCookieHeader()).ok).toBe(true);
    expect(repo.row).toEqual(other);

    const later = stateRow({ state: "validated", store: "keychain", stored_at: T5 });
    repo.row = later;
    const srv2 = server("keychain", keychain);
    expect((await srv2.auth.getCookieHeader()).ok).toBe(true);
    expect(repo.row).toEqual(later);

    // …while an older row for the same backend is still recreated for the value read (a re-setup)
    repo.row = stateRow({
      state: "validated",
      store: "keychain",
      stored_at: "2026-09-01T00:00:00.000Z",
    });
    const srv3 = server("keychain", keychain);
    expect((await srv3.auth.getCookieHeader()).ok).toBe(true);
    expect(repo.row).toMatchObject({ state: "stored", store: "keychain", stored_at: T0 });
  });
});

describe("the install store is bound only to this league's row", () => {
  it("a row for another league names no store to follow", async () => {
    const pair = openCredentialStores(cfg);
    const a = fakeCookies("switch-l-a");
    await pair.keychain.write(a, metaFor(a, T0));
    repo.row = stateRow({ league_id: "7", state: "validated", store: "file", stored_at: T5 });
    const srv = server("keychain");
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    expect(srv.store.kind).toBe("keychain");
  });
});

/** `eff setup --reset` in another terminal (both stores and the row). */
async function reset(): Promise<number> {
  const r = await runSetup(
    {
      reset: true,
      storage: null,
      serviceName: null,
      leagueId: LEAGUE,
      season: 2026,
      recordedStore: null,
      filePath: cfg.filePath,
    },
    {
      prompt: { ask: () => Promise.resolve({ kind: "closed" }) },
      out: () => undefined,
      now: () => clock,
      stores: openCredentialStores(cfg),
      runSelftest: () => Promise.reject(new Error("unused")),
      network: {
        anonymousSettings: () => Promise.resolve({ error: "unused" }),
        anonymousBoard: () => Promise.resolve({ error: "unused" }),
        settingsWithCookies: () => Promise.resolve({ error: "unused" }),
        boardWithCookies: () => Promise.resolve({ error: "unused" }),
        resolveTeam: () => Promise.resolve({ kind: "error", code: "unused" }),
      },
      config: { record: () => Promise.resolve() },
      credentialState: repo,
      registrar: new RecordingRegistrar(),
    },
  );
  return r.exitCode;
}

describe("property: across any interleaving, the server reads the stored value and never corrupts the row", () => {
  it("setups (either store), resets, calls, probe reads and observations", async () => {
    type Step =
      | { readonly t: "setup"; readonly storage: CredentialStoreKind | null }
      | { readonly t: "reset" }
      | { readonly t: "call" }
      | { readonly t: "probe" }
      | {
          readonly t: "obs";
          readonly kind: "accepted" | "rejected";
          readonly by: "server" | "daily_job";
        };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({
        t: fc.constant("setup" as const),
        storage: fc.constantFrom<CredentialStoreKind | null>("keychain", "file", null),
      }),
      fc.constant({ t: "reset" as const }),
      fc.constant({ t: "call" as const }),
      fc.constant({ t: "call" as const }),
      fc.constant({ t: "probe" as const }),
      fc.record({
        t: fc.constant("obs" as const),
        kind: fc.constantFrom("accepted" as const, "rejected" as const),
        by: fc.constantFrom("server" as const, "daily_job" as const),
      }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<CredentialStoreKind>("keychain", "file"),
        fc.array(step, { maxLength: 14 }),
        async (startKind, steps) => {
          // a fresh install per run (same temp HOME, emptied)
          rmSync(path.dirname(cfg.filePath), { recursive: true, force: true });
          kr = new HookedKeyring();
          cfg = { ...cfg, loadKeyring: () => Promise.resolve(kr) };
          repo = new MemoryStateRepo();
          let tick = Date.parse(T0);
          const at = (): string => new Date((tick += 60_000)).toISOString();
          /** What setup last stored, and where (the model). */
          let current: {
            kind: CredentialStoreKind;
            cookies: EspnCookies;
            storedAt: string;
          } | null = null;
          let recorded: CredentialStoreKind | null = null;
          const srv = server(startKind);
          let n = 0;
          for (const s of steps) {
            clock = at();
            if (s.t === "setup") {
              const c = fakeCookies(`prop-${String(n++)}`);
              const t = at();
              const r = await setup(c, t, s.storage, recorded);
              if (r.exitCode !== 0) return false;
              const kind = repo.row?.store ?? null;
              if (kind === null) return false;
              current = { kind, cookies: c, storedAt: t };
              recorded = kind;
            } else if (s.t === "reset") {
              if ((await reset()) !== 0) return false;
              current = null;
            } else if (s.t === "call" || s.t === "probe") {
              const r =
                s.t === "call"
                  ? (srv.auth.state(), await srv.auth.getCookieHeader())
                  : await srv.probing.getCookieHeaderForProbe();
              const row = repo.row;
              if (current === null) {
                if (r.ok) return false; // nothing is stored: never a header
                continue;
              }
              // the row setup wrote for the stored value is never deleted or replaced by the server
              if (row?.store !== current.kind || row.stored_at !== current.storedAt) return false;
              const rejectedHere = row.state === "rejected" || srv.auth.state() === "rejected";
              if (r.ok) {
                if (r.header !== buildCookieHeader(current.cookies)) return false;
              } else if (!(s.t === "call" && r.reason === "rejected" && rejectedHere)) {
                return false;
              }
            } else {
              await srv.auth.observe({
                kind: s.kind,
                at: clock,
                by: s.by,
                upstream_status: s.kind === "accepted" ? 200 : 401,
                view: "mSettings",
              });
            }
          }
          return true;
        },
      ),
      { numRuns: 40 },
    );
  });
});
