// store-path-switch.test.ts — a running server across `EFF_CREDENTIAL_FILE=<alt> eff setup
// --storage file` in another terminal (Stage C finding auth-file-path-switch-deletes-row; plan 02
// §2.1 "Where the state lives", §2.2 "One store per install", "Multiple processes"; plan 03 §1.1
// step 4, §2.1 step 4, §3, L6; plan 06 §1.4). Every process resolves its configuration as the CLI
// does — src/config/schema.ts `loadConfig` over its own env and the config.json on disk, where the
// recorded store and path win over env — so the server (started from a client env block, which
// never names EFF_CREDENTIAL_FILE) and setup (run from a shell that does) start on different paths.
// Setup is the real orchestration (src/auth/setup.ts) recording config.json through the CLI's own
// writer (src/cli/config-file.ts); the keychain is the real adapter over an in-memory keyring; the
// file store is the real 0600 store in a temp HOME; the server holds the install store opened with
// its config dir, the authority and the composition root's probe access. The server reads the value
// at the path config.json records with no restart, never deletes the row setup wrote (so `eff
// status` and the daily credential check keep seeing it), clears a row only for a value gone from
// that path — never one another terminal's setup writes while it reads — and fails closed on a
// config.json it cannot read. A property drives random interleavings of setups from shells naming
// any path, resets, calls, probe reads and observations.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileStoreExistsSync, sessionFileBody } from "../../src/auth/file.js";
import { buildCookieHeader } from "../../src/auth/format.js";
import type { KeychainSelftestResult } from "../../src/auth/selftest.js";
import { runSetup, type PromptAnswer } from "../../src/auth/setup.js";
import { createCredentialAuthority, deriveStartupState } from "../../src/auth/state.js";
import { openCredentialStore, openCredentialStores } from "../../src/auth/stores.js";
import {
  KEYCHAIN_ACCOUNTS,
  type CookieHeaderResult,
  type CredentialObserver,
  type CredentialStoreKind,
  type EspnCookies,
} from "../../src/auth/types.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { mergeConfigPatch, patchConfigFile, type ConfigPatch } from "../../src/cli/config-file.js";
import { configPatchOf } from "../../src/cli/setup.js";
import { configFilePath, type XattrReader } from "../../src/config/paths.js";
import { loadConfig, readConfigFile, type Config } from "../../src/config/schema.js";
import { withProbeAccess } from "../../src/services/index.js";
import { ROOT, noXattrs, tempDir } from "../config/helpers.js";
import {
  FakeKeyring,
  MemoryStateRepo,
  RecordingRegistrar,
  fakeCookies,
  stateRow,
} from "./helpers.js";

const LEAGUE = "0";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T5 = "2026-10-06T00:00:00.000Z";
const T6 = "2026-10-07T00:00:00.000Z";
const T7 = "2026-10-08T00:00:00.000Z";

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
let home: string;
let configDir: string;
let kr: HookedKeyring;
let repo: MemoryStateRepo;
let clock: string;

/** The paths a shell's EFF_CREDENTIAL_FILE may name (each in its own 0700 directory). */
const alt = (name: "alt" | "alt2" = "alt"): string => path.join(home, name, "session.json");
const defaultPath = (): string => path.join(configDir, "session.json");

beforeEach(() => {
  tmp = tempDir("eff-auth-pathswitch-");
  home = path.join(tmp.dir, "home");
  configDir = path.join(home, ".config", "espn-fantasy-football-mcp");
  for (const d of [home, path.join(home, "alt"), path.join(home, "alt2")])
    mkdirSync(d, { mode: 0o700 });
  kr = new HookedKeyring();
  repo = new MemoryStateRepo();
  clock = T1;
});
afterEach(() => {
  tmp.cleanup();
});

/**
 * What a process resolves at start: its own env (`EFF_CREDENTIAL_FILE` only when `envFile` names
 * one) over the config.json on disk, exactly as `loadConfigFromProcess` does.
 */
function resolveConfig(envFile: string | null): Config {
  return loadConfig({
    env: {
      ESPN_LEAGUE_ID: LEAGUE,
      ESPN_SEASON: "2026",
      EFF_CONFIG_DIR: configDir,
      EFF_CACHE_DIR: path.join(home, ".cache", "espn-fantasy-football-mcp"),
      ...(envFile === null ? {} : { EFF_CREDENTIAL_FILE: envFile }),
    },
    file: readConfigFile(configDir),
    home,
    repoRoot: ROOT,
    nowMs: Date.parse(T0),
    xattr: noXattrs,
  });
}

const storeConfig = (c: Config) => ({
  filePath: c.credentialFile,
  home,
  repoRoot: ROOT,
  xattr: noXattrs,
  loadKeyring: () => Promise.resolve(kr),
});

/**
 * config.json merged exactly as the CLI's writer merges it (`mergeConfigPatch`: the same key and
 * credential rules) and renamed into place, without its fsyncs — for the property, which runs
 * hundreds of setups; the examples use the writer itself (`patchConfigFile`).
 */
function recordQuickly(patch: ConfigPatch): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const current = readConfigFile(configDir) as Record<string, unknown> | undefined;
  const next = mergeConfigPatch(current ?? {}, patch);
  const staged = `${configFilePath(configDir)}.staged`;
  writeFileSync(staged, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(staged, configFilePath(configDir));
}

/**
 * `eff setup [--storage kind]` (or `--reset`) from a shell whose env names `envFile` (or none):
 * the CLI's own resolution of the store and path (src/cli/setup.ts), private league, probe 200,
 * one team.
 */
async function setup(
  cookies: EspnCookies,
  at: string,
  storage: CredentialStoreKind | null,
  envFile: string | null,
  opts: { readonly reset?: boolean; readonly quick?: boolean } = {},
): Promise<number> {
  const reset = opts.reset ?? false;
  const c = resolveConfig(envFile);
  const answers: PromptAnswer[] = [
    { kind: "answer", value: cookies.swid },
    { kind: "answer", value: cookies.espn_s2 },
  ];
  const r = await runSetup(
    {
      reset,
      storage,
      serviceName: null,
      leagueId: LEAGUE,
      season: c.season,
      recordedStore: c.origins.EFF_CREDENTIAL_STORE === "file" ? c.credentialStore : null,
      filePath: c.credentialFile,
    },
    {
      prompt: { ask: () => Promise.resolve(answers.shift() ?? { kind: "closed" }) },
      out: () => undefined,
      now: () => at,
      stores: openCredentialStores(storeConfig(c)), // setup's own process opens both backends
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
          if (opts.quick === true) recordQuickly(configPatchOf(p));
          else
            patchConfigFile({ configDir, home, repoRoot: ROOT, xattr: noXattrs }, configPatchOf(p));
          return Promise.resolve();
        },
      },
      credentialState: repo,
      registrar: new RecordingRegistrar(),
    },
  );
  return r.exitCode;
}

/**
 * A long-lived process as the composition roots are to wire it (src/auth/stores.ts: the install store
 * opened with its config dir): started from `envFile`'s env.
 */
function server(
  envFile: string | null,
  observer: CredentialObserver = "server",
  xattr: XattrReader = noXattrs,
) {
  const c = resolveConfig(envFile);
  const reg = new RecordingRegistrar();
  const store = openCredentialStore(c.credentialStore, {
    ...storeConfig(c),
    xattr,
    configDir: c.configDir,
  });
  const auth = createCredentialAuthority({
    store,
    repo,
    leagueId: LEAGUE,
    registrar: reg,
    observer,
    now: () => clock,
    fileStoreExists: c.credentialStore === "file" && fileStoreExistsSync(c.credentialFile),
  });
  return {
    auth,
    probing: withProbeAccess(auth, store, reg),
    store,
    reg,
    startPath: c.credentialFile,
  };
}

/** True when `r` carries exactly the header for `c` (compared, never printed). */
const carries = (r: CookieHeaderResult, c: EspnCookies): boolean =>
  r.ok && r.header === buildCookieHeader(c);

/** What `eff status` derives and what the daily `credential-check` gates on (src/cli). */
function observers() {
  const row = repo.get();
  return {
    status: deriveStartupState({ row, leagueId: LEAGUE, storeKind: "file", fileStoreExists: true }),
    storedAt: row?.stored_at ?? null,
    store: row?.store ?? null,
    dailyCheckProbes: row?.league_id === LEAGUE && row.state !== "not_configured",
  };
}

describe("`EFF_CREDENTIAL_FILE=<alt> eff setup --storage file` while a keychain server runs (the finding's repro)", () => {
  it("the server reads <alt> with no restart, the row stays, a re-run sticks, the daily check probes", async () => {
    const [a, b, c] = [fakeCookies("ps-a"), fakeCookies("ps-b"), fakeCookies("ps-c")];
    expect(await setup(a, T0, "keychain", null)).toBe(0);
    const srv = server(null); // the client env block: no EFF_CREDENTIAL_FILE
    expect(srv.startPath).toBe(defaultPath());
    expect(srv.auth.state()).toBe("validated");
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);

    expect(await setup(b, T5, "file", alt())).toBe(0);
    expect(readConfigFile(configDir)).toMatchObject({
      EFF_CREDENTIAL_STORE: "file",
      EFF_CREDENTIAL_FILE: alt(),
    });
    expect(observers()).toEqual({
      status: "validated",
      storedAt: T5,
      store: "file",
      dailyCheckProbes: true,
    });

    // espn_get_roster / espn_check_auth: the server's next calls send the new value
    clock = T6;
    expect(srv.auth.state()).toBe("validated");
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
    expect(carries(await srv.probing.getCookieHeaderForProbe(), b)).toBe(true);
    expect(srv.store.kind).toBe("file");
    expect(srv.reg.registered.some((x) => x.value === b.espn_s2)).toBe(true);
    expect(fileStoreExistsSync(defaultPath())).toBe(false); // nothing was ever at the start path
    expect(observers()).toEqual({
      status: "validated",
      storedAt: T5,
      store: "file",
      dailyCheckProbes: true,
    });

    // the user re-runs setup in the same shell: the recorded path wins, and nothing undoes it
    expect(await setup(c, T7, null, alt())).toBe(0);
    expect(srv.auth.state()).toBe("validated");
    expect(carries(await srv.auth.getCookieHeader(), c)).toBe(true);
    expect(observers()).toMatchObject({ status: "validated", storedAt: T7, store: "file" });

    // the daily credential check — a fresh process resolving config.json — probes the same value
    const job = server(null, "daily_job");
    expect(job.startPath).toBe(alt());
    expect(carries(await job.probing.getCookieHeaderForProbe(), c)).toBe(true);
    expect(carries(await job.auth.getCookieHeader(), c)).toBe(true);
    expect(observers().dailyCheckProbes).toBe(true);
  });

  it("espn_check_auth as the FIRST call after the switch probes with <alt>'s value", async () => {
    const [a, b] = [fakeCookies("ps-p-a"), fakeCookies("ps-p-b")];
    await setup(a, T0, "keychain", null);
    const srv = server(null);
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    await setup(b, T5, "file", alt());
    expect(srv.auth.state()).toBe("validated"); // the provider's configured() gate
    expect(carries(await srv.probing.getCookieHeaderForProbe(), b)).toBe(true);
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
    expect(observers()).toMatchObject({ status: "validated", store: "file", storedAt: T5 });
  });

  it("a server started before the first `eff setup` picks up a file store at another path (L6)", async () => {
    const srv = server(null);
    expect(srv.auth.state()).toBe("not_configured");
    expect(await srv.auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    const a = fakeCookies("ps-f-a");
    expect(await setup(a, T5, "file", alt())).toBe(0);
    expect(srv.auth.state()).toBe("validated");
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    expect(observers()).toMatchObject({ status: "validated", store: "file", storedAt: T5 });
  });

  it("a client env block naming another EFF_CREDENTIAL_FILE does not win over the recorded path (plan 03 §3)", async () => {
    const [a, b] = [fakeCookies("ps-e-a"), fakeCookies("ps-e-b")];
    await setup(a, T0, "keychain", null);
    const srv = server(alt("alt2")); // no path recorded yet: this process starts on its env's
    expect(srv.startPath).toBe(alt("alt2"));
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    await setup(b, T5, "file", null); // a shell without it: the default path is recorded
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
    expect(observers()).toMatchObject({ status: "validated", store: "file", storedAt: T5 });
    // a restarted server resolves the same path: config.json wins over the env block
    expect(server(alt("alt2")).startPath).toBe(defaultPath());
  });

  it("a call that lands mid-switch (config.json moved, keychain emptied, no file yet) recovers", async () => {
    const [a, b] = [fakeCookies("ps-m-a"), fakeCookies("ps-m-b")];
    await setup(a, T0, "keychain", null);
    const srv = server(null);
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    let mid: CookieHeaderResult | null = null;
    kr.afterDelete = {
      account: KEYCHAIN_ACCOUNTS.swid, // setup has recorded <alt> and just emptied the keychain
      run: async () => {
        mid = await srv.auth.getCookieHeader();
      },
    };
    expect(await setup(b, T5, "file", alt())).toBe(0);
    expect(mid).toEqual({ ok: false, reason: "not_configured" }); // the old value really was gone
    expect(srv.auth.state()).toBe("validated"); // setup then recorded the new one
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
    expect(observers()).toMatchObject({ status: "validated", storedAt: T5, store: "file" });
  });
});

describe("the row is judged at the path config.json records", () => {
  it("session.json removed from the recorded path: a row without items is cleared (plan 03 §1.1 step 4)", async () => {
    const a = fakeCookies("ps-v-a");
    await setup(a, T0, "file", alt());
    const srv = server(null);
    expect(srv.startPath).toBe(alt());
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    rmSync(alt());
    expect(await srv.auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    expect(repo.row).toBeNull();
    expect(srv.auth.state()).toBe("not_configured");
  });

  it("a leftover session.json at a process's start path is never read once config.json records another", async () => {
    const [old, a] = [fakeCookies("ps-o-old"), fakeCookies("ps-o-a")];
    expect(await setup(old, T0, "keychain", null)).toBe(0);
    const srv = server(null);
    expect(carries(await srv.auth.getCookieHeader(), old)).toBe(true);
    expect(await setup(a, T5, "file", alt())).toBe(0);
    // a stray copy at the server's start path (what `eff doctor` #6 reports): never consulted
    const stray = readFileSync(alt(), "utf8").replace(T5, T6);
    writeFileSync(defaultPath(), stray, { mode: 0o600 });
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    rmSync(alt());
    expect(await srv.auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    expect(repo.row).toBeNull();
  });

  it("a config.json the server cannot read fails closed: no header, the row untouched, then recovers", async () => {
    const [a, b] = [fakeCookies("ps-u-a"), fakeCookies("ps-u-b")];
    await setup(a, T0, "keychain", null);
    const srv = server(null);
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    await setup(b, T5, "file", alt());
    const good = readFileSync(configFilePath(configDir), "utf8");
    writeFileSync(configFilePath(configDir), "{ half-written", { mode: 0o600 });
    const before = repo.row;
    expect(await srv.auth.getCookieHeader()).toEqual({ ok: false, reason: "unreadable" });
    expect(await srv.probing.getCookieHeaderForProbe()).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(repo.row).toBe(before);
    expect(srv.auth.state()).toBe("validated");
    writeFileSync(configFilePath(configDir), good, { mode: 0o600 });
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
    expect(observers()).toMatchObject({ status: "validated", storedAt: T5, store: "file" });
  });
});

describe("another terminal's setup landing while the server reads (no row it cannot verify is cleared)", () => {
  it("a row written during a read of the recorded path is never cleared by that read", async () => {
    const [a, b] = [fakeCookies("ps-race-a"), fakeCookies("ps-race-b")];
    expect(await setup(a, T0, "file", alt())).toBe(0);
    rmSync(alt()); // the value at the recorded path is gone (removed by hand); its row is stale
    const stale = repo.row;
    expect(stale).toMatchObject({ store: "file", stored_at: T0 });
    // while this process runs the location rule before its first read of <alt>, another terminal's
    // `EFF_CREDENTIAL_FILE=<alt2> eff setup --storage file` completes: config.json, the file, the row
    const setupRow = stateRow({
      state: "validated",
      store: "file",
      stored_at: T5,
      last_accepted_at: T5,
      updated_at: T5,
    });
    let landed = 0;
    const midRead: XattrReader = (paths) => {
      if (landed++ === 0) {
        recordQuickly({ EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: alt("alt2") });
        writeFileSync(alt("alt2"), sessionFileBody(b, metaFor(b, T5)), { mode: 0o600 });
        repo.put(setupRow);
      }
      return noXattrs(paths);
    };
    const srv = server(null, "server", midRead);
    expect(srv.startPath).toBe(alt());
    expect(srv.auth.state()).toBe("validated"); // the stale row's label, until the first read
    expect(await srv.auth.getCookieHeader()).toEqual({ ok: false, reason: "not_configured" });
    expect(landed).toBeGreaterThan(0);
    // <alt> really was empty, but the row is setup's, for a value at <alt2>: it stays
    expect(repo.row).toEqual(setupRow);
    expect(observers()).toEqual({
      status: "validated",
      storedAt: T5,
      store: "file",
      dailyCheckProbes: true,
    });
    // the label follows setup's row, and the next call reads where config.json now says
    expect(srv.auth.state()).toBe("validated");
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
    expect(repo.row).toMatchObject({ state: "validated", store: "file", stored_at: T5 });
  });
});

describe("a path the file store refuses is refused before anything changes (plan 03 §2.1 steps 4, 8)", () => {
  it("`EFF_CREDENTIAL_FILE=<a synced path> eff setup --storage file`: the keychain install keeps working", async () => {
    const [a, b] = [fakeCookies("ps-r-a"), fakeCookies("ps-r-b")];
    expect(await setup(a, T0, "keychain", null)).toBe(0);
    const srv = server(null);
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    const before = readFileSync(configFilePath(configDir), "utf8");
    const row = repo.row;

    const synced = path.join(home, "Documents", "session.json");
    mkdirSync(path.dirname(synced), { mode: 0o700 });
    expect(await setup(b, T5, "file", synced)).toBe(2);
    // config.json is untouched, so every later process — the server, the jobs, `eff setup` — starts
    expect(readFileSync(configFilePath(configDir), "utf8")).toBe(before);
    expect(() => resolveConfig(null)).not.toThrow();
    expect(() => resolveConfig(synced)).not.toThrow(); // the same shell can simply run setup again
    // the keychain value was not deleted for a value that could not be stored; the row stands
    expect(repo.row).toBe(row);
    expect(fileStoreExistsSync(synced)).toBe(false);
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
    expect(observers()).toMatchObject({ status: "validated", store: "keychain", storedAt: T0 });
    // and the next setup, at a path the rules accept, moves the install as usual
    expect(await setup(b, T6, "file", alt())).toBe(0);
    expect(carries(await srv.auth.getCookieHeader(), b)).toBe(true);
  });

  it("a fresh install whose path is refused records nothing: a re-run with a good path works", async () => {
    const srv = server(null);
    const inRepo = path.join(ROOT, "eff-never-created", "session.json");
    expect(await setup(fakeCookies("ps-r-f"), T5, "file", inRepo)).toBe(2);
    expect(readConfigFile(configDir)).toBeUndefined();
    expect(repo.row).toBeNull();
    const a = fakeCookies("ps-r-g");
    expect(await setup(a, T6, "file", alt())).toBe(0);
    expect(carries(await srv.auth.getCookieHeader(), a)).toBe(true);
  });
});

describe("property: setups from shells naming any path never leave the server reading elsewhere", () => {
  it("setups (either store, any EFF_CREDENTIAL_FILE), resets, calls, probe reads and observations", async () => {
    type Where = "default" | "alt" | "alt2";
    type Step =
      | {
          readonly t: "setup";
          readonly storage: CredentialStoreKind | null;
          readonly env: Where | null;
        }
      | { readonly t: "reset"; readonly env: Where | null }
      | { readonly t: "call" }
      | { readonly t: "probe" }
      | {
          readonly t: "obs";
          readonly kind: "accepted" | "rejected";
          readonly by: "server" | "daily_job";
        };
    const where = fc.constantFrom<Where | null>(null, "default", "alt", "alt2");
    const pathOf = (w: Where | null): string | null =>
      w === null ? null : w === "default" ? defaultPath() : alt(w);
    // weighted so that most runs move the install to a path the server did not start on (a setup
    // recording the file store from a shell whose path differs) and then call: the finding's case
    const step: fc.Arbitrary<Step> = fc.oneof(
      {
        weight: 3,
        arbitrary: fc.record({
          t: fc.constant("setup" as const),
          storage: fc.constantFrom<CredentialStoreKind | null>("file", "file", "keychain", null),
          env: where,
        }),
      },
      { weight: 1, arbitrary: fc.record({ t: fc.constant("reset" as const), env: where }) },
      { weight: 3, arbitrary: fc.constant({ t: "call" as const }) },
      { weight: 1, arbitrary: fc.constant({ t: "probe" as const }) },
      {
        weight: 1,
        arbitrary: fc.record({
          t: fc.constant("obs" as const),
          kind: fc.constantFrom("accepted" as const, "rejected" as const),
          by: fc.constantFrom("server" as const, "daily_job" as const),
        }),
      },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Where | null>(null, "alt2"),
        fc.array(step, { minLength: 2, maxLength: 10 }),
        async (serverEnv, steps) => {
          // a fresh install per run (same temp HOME, emptied)
          rmSync(configDir, { recursive: true, force: true });
          for (const w of ["alt", "alt2"] as const) rmSync(alt(w), { force: true });
          kr = new HookedKeyring();
          repo = new MemoryStateRepo();
          let tick = Date.parse(T0);
          const at = (): string => new Date((tick += 60_000)).toISOString();
          /** What setup last stored (the model). */
          let current: {
            kind: CredentialStoreKind;
            cookies: EspnCookies;
            storedAt: string;
          } | null = null;
          const srv = server(pathOf(serverEnv));
          let n = 0;
          for (const s of steps) {
            clock = at();
            if (s.t === "setup") {
              const c = fakeCookies(`pp-${String(n++)}`);
              const t = at();
              if ((await setup(c, t, s.storage, pathOf(s.env), { quick: true })) !== 0)
                return false;
              const kind = repo.row?.store ?? null;
              if (kind === null) return false;
              current = { kind, cookies: c, storedAt: t };
            } else if (s.t === "reset") {
              if (
                (await setup(fakeCookies("unused"), at(), null, pathOf(s.env), {
                  reset: true,
                  quick: true,
                })) !== 0
              )
                return false;
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
      { numRuns: 30 },
    );
  });
});
