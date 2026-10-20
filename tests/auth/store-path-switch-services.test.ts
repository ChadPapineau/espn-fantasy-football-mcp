// store-path-switch-services.test.ts — Stage C finding auth-file-path-switch-deletes-row through the
// composition roots themselves, as they are: the server (src/services/index.ts buildServices) and
// the jobs and CLI (src/cli/espn-stack.ts buildEspnStack). Each process resolves its configuration
// as the CLI does — src/config/schema.ts `loadConfig` over its own env and the config.json on disk,
// where the recorded store and path win over env (plan 03 §3) — so a process started from a client
// env block (which never names EFF_CREDENTIAL_FILE) and `eff setup` run from a shell that does start
// on different session.json paths. Setup is the real orchestration (src/auth/setup.ts), recording
// config.json through the CLI's own writer; the keychain is the real adapter over an in-memory
// keyring; the file store is the real 0600 store in a temp HOME; store.sqlite is real. Whatever a
// running process can read after `EFF_CREDENTIAL_FILE=<alt> eff setup --storage file`, it never
// deletes or rewrites the row setup wrote — `eff status` and the daily credential check keep seeing
// it, a re-run of setup is never undone — and a process started afterwards (a restarted server, the
// daily check) sends the new value (plan 02 §2.1 "Where the state lives", §2.2 "Multiple processes";
// plan 03 §1.1 step 4, §3, L6; plan 06 §1.4). No network, no real keychain, no real cookie.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCookieHeader } from "../../src/auth/format.js";
import type { KeychainSelftestResult } from "../../src/auth/selftest.js";
import { runSetup, type PromptAnswer } from "../../src/auth/setup.js";
import { openCredentialStores } from "../../src/auth/stores.js";
import type { CredentialStoreKind, EspnCookies } from "../../src/auth/types.js";
import { patchConfigFile } from "../../src/cli/config-file.js";
import { buildEspnStack } from "../../src/cli/espn-stack.js";
import { configPatchOf } from "../../src/cli/setup.js";
import { loadConfig, readConfigFile, type Config } from "../../src/config/schema.js";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { buildServices, type Wiring } from "../../src/services/index.js";
import { makeIo } from "../cli/helpers.js";
import { noXattrs } from "../config/helpers.js";
import {
  ROOT,
  SEASON,
  call,
  connect,
  fixtureFetchPlus,
  makeWorld,
  type World,
} from "../mcp/helpers/world.js";
import { FakeKeyring, RecordingRegistrar, fakeCookies } from "./helpers.js";

let w: World;
let kr: FakeKeyring;
let home: string;
let wirings: Wiring[];
/** The Cookie header of every request a process made (kept in memory; compared, never printed). */
let sent: (string | null)[];

beforeEach(async () => {
  w = await makeWorld({ env: { EFF_CREDENTIAL_STORE: "keychain" } });
  home = path.join(w.root, "home");
  mkdirSync(path.join(home, "alt"), { mode: 0o700 });
  kr = new FakeKeyring();
  wirings = [];
  sent = [];
});
afterEach(() => {
  for (const x of wirings) x.close();
  w.cleanup();
});

/** The path a shell's EFF_CREDENTIAL_FILE names (its own 0700 directory). */
const alt = (): string => path.join(home, "alt", "session.json");
const defaultPath = (): string => path.join(w.config.configDir, "session.json");

/**
 * What a process resolves at start: its own env (`EFF_CREDENTIAL_FILE` only when `envFile` names
 * one) over the config.json on disk, as `loadConfigFromProcess` does.
 */
function resolveConfig(envFile: string | null): Config {
  return loadConfig({
    env: {
      ESPN_LEAGUE_ID: w.config.leagueId,
      ESPN_SEASON: String(SEASON),
      ESPN_TEAM_ID: "1",
      EFF_CONFIG_DIR: w.config.configDir,
      EFF_CACHE_DIR: w.cache,
      ...(envFile === null ? {} : { EFF_CREDENTIAL_FILE: envFile }),
    },
    file: readConfigFile(w.config.configDir),
    home,
    repoRoot: ROOT,
    nowMs: w.clock.nowMs(),
    xattr: noXattrs,
  });
}

function cookieOf(init: RequestInit): string | null {
  const h = init.headers;
  if (h === undefined || h instanceof Headers || Array.isArray(h)) return null;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === "cookie") return v ?? null;
  return null;
}

/**
 * A private league: an anonymous league read is refused; a cookie-bearing one is served from the
 * recorded (public) fixtures marked private (the Cookie header is noted here and taken off first —
 * the fixture fetch refuses any request that carries one).
 */
function privateLeague(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const cookie = cookieOf(init);
    sent.push(cookie);
    if (cookie === null && new URL(url).pathname.includes("/leagues/"))
      return new Response("{}", { status: 401 });
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).filter(
        ([k]) => k.toLowerCase() !== "cookie",
      ),
    );
    const res = await inner(url, { ...init, headers });
    const text = (await res.text()).replaceAll('"isPublic":true', '"isPublic":false');
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

/**
 * `eff setup [--storage kind]` from a shell whose env names `envFile` (or none): the CLI's own
 * resolution of the store and path (src/cli/setup.ts), config.json through the CLI's writer, a
 * private league, probe 200, one team.
 */
async function setup(
  cookies: EspnCookies,
  at: string,
  storage: CredentialStoreKind | null,
  envFile: string | null,
): Promise<number> {
  const c = resolveConfig(envFile);
  const answers: PromptAnswer[] = [
    { kind: "answer", value: cookies.swid },
    { kind: "answer", value: cookies.espn_s2 },
  ];
  const r = await runSetup(
    {
      reset: false,
      storage,
      serviceName: null,
      leagueId: c.leagueId,
      season: c.season,
      recordedStore: c.origins.EFF_CREDENTIAL_STORE === "file" ? c.credentialStore : null,
      filePath: c.credentialFile,
    },
    {
      prompt: { ask: () => Promise.resolve(answers.shift() ?? { kind: "closed" }) },
      out: () => undefined,
      now: () => at,
      stores: openCredentialStores({
        filePath: c.credentialFile,
        home,
        repoRoot: ROOT,
        xattr: noXattrs,
        loadKeyring: () => Promise.resolve(kr),
      }),
      runSelftest: (): Promise<KeychainSelftestResult> =>
        Promise.resolve({ outcome: "ok", reason: "ok", code: null, at, cleanup: "deleted" }),
      network: {
        anonymousSettings: () => Promise.resolve({ status: 401 }),
        anonymousBoard: () => Promise.resolve({ error: "unused" }),
        settingsWithCookies: () => Promise.resolve({ status: 200 }),
        boardWithCookies: () => Promise.resolve({ error: "unused" }),
        resolveTeam: () => Promise.resolve({ kind: "one", teamId: 1 }),
      },
      config: {
        record: (p) => {
          patchConfigFile(
            { configDir: c.configDir, home, repoRoot: ROOT, xattr: noXattrs },
            configPatchOf(p),
          );
          return Promise.resolve();
        },
      },
      credentialState: w.store.repos.credentialState,
      registrar: new RecordingRegistrar(),
    },
  );
  return r.exitCode;
}

/** The server as `eff serve` composes it, started from `envFile`'s env (null: a client env block). */
function serve(envFile: string | null): Wiring {
  const config = resolveConfig(envFile);
  const wiring = buildServices({
    config,
    store: w.store,
    clock: w.clock,
    logger: w.logger,
    packageRoot: ROOT,
    home,
    fetch: privateLeague(fixtureFetchPlus("league-a", [])),
    loadKeyring: () => Promise.resolve(kr),
  });
  wirings.push(wiring);
  return wiring;
}

/** A job or CLI command as src/cli composes it (buildEspnStack), started from `envFile`'s env. */
function job(envFile: string | null) {
  const config = resolveConfig(envFile);
  const io = makeIo(
    {
      dir: w.root,
      home,
      configDir: w.config.configDir,
      cacheDir: w.cache,
      cleanup: () => undefined,
    },
    { clock: w.clock, keyring: kr, fetch: privateLeague(fixtureFetchPlus("league-a", [])) },
  );
  const stack = buildEspnStack(io, config, w.store, w.logger, {
    origin: "job",
    observer: "daily_job",
    probeObserver: "daily_job",
  });
  return { stack, config };
}

/** The row as `eff status` and the daily credential check read it. */
function row() {
  const r = w.store.repos.credentialState.get();
  return r === null
    ? null
    : { league_id: r.league_id, state: r.state, store: r.store, stored_at: r.stored_at };
}

/** Whether the daily `credential-check` probes (src/cli/credential-check.ts gates on the row). */
const dailyCheckProbes = (): boolean => {
  const r = w.store.repos.credentialState.get();
  return r?.league_id === w.config.leagueId && r.state !== "not_configured";
};

describe("`EFF_CREDENTIAL_FILE=<alt> eff setup --storage file` while the server runs (buildServices)", () => {
  it("the server's calls never delete the row setup wrote; a re-run sticks; a restart sends the new value", async () => {
    const [a, b, c] = [fakeCookies("pss-a"), fakeCookies("pss-b"), fakeCookies("pss-c")];
    const t0 = w.clock.nowIso();
    expect(await setup(a, t0, "keychain", null)).toBe(0);
    const wiring = serve(null); // the client env block: no EFF_CREDENTIAL_FILE
    const services = wiring.services;
    expect(services.auth.state()).toBe("validated");
    expect((await services.auth.probe(services.league)).accepted).toBe(true);
    expect(sent.at(-1) === buildCookieHeader(a)).toBe(true);

    w.clock.advance(60_000);
    const t5 = w.clock.nowIso();
    expect(await setup(b, t5, "file", alt())).toBe(0);
    expect(readConfigFile(w.config.configDir)).toMatchObject({
      EFF_CREDENTIAL_STORE: "file",
      EFF_CREDENTIAL_FILE: alt(),
    });
    const switched = {
      league_id: w.config.leagueId,
      state: "validated",
      store: "file",
      stored_at: t5,
    };
    expect(row()).toEqual(switched);

    // espn_check_auth, then espn_get_roster over the MCP surface (the finding's sequence)
    w.clock.advance(60_000);
    sent = [];
    await services.auth.probe(services.league);
    expect(row()).toEqual(switched);
    const client = await connect({ services, options: wiring.options });
    try {
      await call(client.client, "espn_get_roster", { force_refresh: true });
      expect(row()).toEqual(switched);
      services.auth.state();
      await call(client.client, "espn_get_roster", { force_refresh: true });
      // whatever this process could read, it sent no other value than the one setup stored
      expect(sent.filter((x) => x !== null).every((x) => x === buildCookieHeader(b))).toBe(true);
      // eff status and the daily check still see setup's row
      expect(row()).toEqual(switched);
      expect(dailyCheckProbes()).toBe(true);

      // the user re-runs setup in the same shell (the recorded path wins): the next calls keep it
      w.clock.advance(60_000);
      const t7 = w.clock.nowIso();
      expect(await setup(c, t7, null, alt())).toBe(0);
      expect(row()).toEqual({ ...switched, stored_at: t7 });
      sent = [];
      services.auth.state();
      await call(client.client, "espn_get_roster", { force_refresh: true });
      await services.auth.probe(services.league);
      expect(row()).toEqual({ ...switched, stored_at: t7 });
      expect(sent.filter((x) => x !== null).every((x) => x === buildCookieHeader(c))).toBe(true);
      expect(dailyCheckProbes()).toBe(true);
    } finally {
      await client.close();
    }
    const rerun = row();

    // a server started now (restart, or the daily check's own process) reads where config.json says
    const restarted = serve(null).services;
    expect(restarted.auth.state()).toBe("validated");
    sent = [];
    expect(await restarted.auth.probe(restarted.league)).toMatchObject({ accepted: true });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((x) => x !== null).every((x) => x === buildCookieHeader(c))).toBe(true);
    expect(row()).toEqual(rerun);
  });
});

describe("the same switch while a job runs (buildEspnStack)", () => {
  it("a job's calls never delete the row; the next job sends the new value", async () => {
    const [a, b] = [fakeCookies("psj-a"), fakeCookies("psj-b")];
    expect(await setup(a, w.clock.nowIso(), "keychain", null)).toBe(0);
    const running = job(null);
    expect(running.config.credentialFile).toBe(defaultPath());
    const auth = running.stack.authority;
    if (auth === null) throw new Error("no authority outside fixture mode");
    const first = await auth.getCookieHeader();
    expect(first.ok && first.header === buildCookieHeader(a)).toBe(true);

    w.clock.advance(60_000);
    const t5 = w.clock.nowIso();
    expect(await setup(b, t5, "file", alt())).toBe(0);
    const switched = {
      league_id: w.config.leagueId,
      state: "validated",
      store: "file",
      stored_at: t5,
    };
    expect(row()).toEqual(switched);

    w.clock.advance(60_000);
    // whatever this job can read, it is never another value than the one setup stored
    for (const r of [
      await auth.getCookieHeader(),
      await auth.getCookieHeaderForProbe(),
      (auth.state(), await auth.getCookieHeader()),
    ])
      expect(!r.ok || r.header === buildCookieHeader(b)).toBe(true);
    expect(row()).toEqual(switched);
    expect(dailyCheckProbes()).toBe(true);
    running.stack.close();

    // the daily check's own process (started from launchd's env, no EFF_CREDENTIAL_FILE)
    const daily = job(null);
    expect(daily.config.credentialFile).toBe(alt());
    const probe = await daily.stack.authority?.getCookieHeaderForProbe();
    expect(probe?.ok === true && probe.header === buildCookieHeader(b)).toBe(true);
    daily.stack.close();
    expect(row()).toEqual(switched);
  });
});
