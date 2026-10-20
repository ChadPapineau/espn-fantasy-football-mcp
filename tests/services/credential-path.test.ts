// credential-path.test.ts — the server's file store reads the session.json path config.json records
// now (plan 03 §3: the recorded store and path are authoritative for every process; plan 02 §2.2
// "Multiple processes"; plan 03 L6: the next successful `eff setup` in another terminal is picked up
// without a restart) — the src/services half of Stage C finding auth-file-path-switch-deletes-row.
// The server is the real composition root (src/services/index.ts buildServices), started from a
// client env block (which never names EFF_CREDENTIAL_FILE), over a real store.sqlite, the real
// EspnProvider and a private-league fixture fetch; `eff setup` is the real orchestration
// (src/auth/setup.ts) run from shells whose EFF_CREDENTIAL_FILE names other paths, recording
// config.json through the CLI's own writer. After each setup the server's very next cookie-bearing
// read sends the value setup just stored, read from the path config.json records (never the
// keychain setup emptied, never the start path), and the row setup wrote stays. No network, no real
// keychain (an in-memory keyring), temp paths only.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCookieHeader } from "../../src/auth/format.js";
import type { KeychainSelftestResult } from "../../src/auth/selftest.js";
import { runSetup, type PromptAnswer } from "../../src/auth/setup.js";
import { openCredentialStores } from "../../src/auth/stores.js";
import type { CredentialStoreKind, EspnCookies } from "../../src/auth/types.js";
import { patchConfigFile } from "../../src/cli/config-file.js";
import { configPatchOf } from "../../src/cli/setup.js";
import { loadConfig, readConfigFile, type Config } from "../../src/config/schema.js";
import { createServer } from "../../src/mcp/server.js";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { buildServices, type Wiring } from "../../src/services/index.js";
import { FakeKeyring, RecordingRegistrar, fakeCookies } from "../auth/helpers.js";
import { noXattrs } from "../config/helpers.js";
import { ROOT, SEASON, fixtureFetchPlus, makeWorld, type World } from "../mcp/helpers/world.js";

/** A composition-root test's own limit (real setups and probes; the unit default detects hangs). */
const ROOT_TEST_MS = 180_000;

let w: World;
let kr: FakeKeyring;
let home: string;
let wirings: Wiring[];
/** The Cookie header of every request the provider made (kept in memory; compared, never printed). */
let sent: (string | null)[];

beforeEach(async () => {
  w = await makeWorld();
  home = path.join(w.root, "home");
  for (const d of ["alt", "alt2"]) mkdirSync(path.join(home, d), { mode: 0o700 });
  kr = new FakeKeyring();
  wirings = [];
  sent = [];
});
afterEach(() => {
  for (const x of wirings) x.close();
  w.cleanup();
});

/** A path a shell's EFF_CREDENTIAL_FILE names (each in its own 0700 directory). */
const alt = (name: "alt" | "alt2" = "alt"): string => path.join(home, name, "session.json");

/** What a process resolves at start: its own env over the config.json on disk (loadConfigFromProcess). */
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

/** `eff setup [--storage kind]` from a shell whose env names `envFile` (or none): the CLI's own resolution. */
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

/** The server as `eff serve` composes it, started from a client env block (no EFF_CREDENTIAL_FILE). */
function serve(): Wiring {
  const wiring = buildServices({
    config: resolveConfig(null),
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

/** The row as `eff status` and the daily credential check read it. */
function row(): Record<string, unknown> | null {
  const r = w.store.repos.credentialState.get();
  return r === null
    ? null
    : { league_id: r.league_id, state: r.state, store: r.store, stored_at: r.stored_at };
}

/** The keychain reads so far (service/account only — never a value). */
const keychainReads = (): number => kr.calls.filter((c) => c.op === "get").length;

/** Whether every cookie the provider sent since the last reset is exactly `c`'s, and one was sent. */
const sentOnly = (c: EspnCookies): boolean =>
  sent.some((x) => x !== null) &&
  sent.filter((x) => x !== null).every((x) => x === buildCookieHeader(c));

describe("`EFF_CREDENTIAL_FILE=<alt> eff setup --storage file` while the server runs", () => {
  it(
    "the very next read sends the value at the path config.json records, from a probe and a tool call; the row stays",
    async () => {
      const [a, b, c] = [fakeCookies("cp-a"), fakeCookies("cp-b"), fakeCookies("cp-c")];
      expect(await setup(a, w.clock.nowIso(), "keychain", null)).toBe(0);
      const wiring = serve();
      const services = wiring.services;
      expect(resolveConfig(null).credentialFile).toBe(
        path.join(w.config.configDir, "session.json"),
      );
      expect(services.status.credential()).toMatchObject({ state: "validated", store: "keychain" });
      expect((await services.auth.probe(services.league)).accepted).toBe(true);
      expect(sentOnly(a)).toBe(true);

      // another terminal, a shell naming <alt>: config.json records the file store at <alt>
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

      // espn_check_auth as the first call after the switch: <alt>'s value, no keychain read
      w.clock.advance(60_000);
      sent = [];
      const before = keychainReads();
      expect(await services.auth.probe(services.league)).toMatchObject({ accepted: true });
      expect(sentOnly(b)).toBe(true);
      expect(keychainReads()).toBe(before);
      expect(row()).toEqual(switched);

      // a cookie-bearing tool call over the MCP surface sends it too, and the label says where it is
      const server = createServer(services, wiring.options);
      const client = new Client({ name: "eff-test-client", version: "0.0.0" });
      const [t1, t2] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(t1), client.connect(t2)]);
      try {
        sent = [];
        const r = await client.callTool({
          name: "espn_get_roster",
          arguments: { force_refresh: true },
        });
        expect((r as { isError?: boolean }).isError ?? false).toBe(false);
        expect(sentOnly(b)).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
      expect(services.auth.state()).toBe("validated");
      expect(services.status.credential()).toMatchObject({ state: "validated", store: "file" });
      expect(row()).toEqual(switched);

      // the user re-runs setup in another shell (whatever it names, the recorded path wins — plan
      // 03 §3): the new value is read at the next call, no restart
      w.clock.advance(60_000);
      const t7 = w.clock.nowIso();
      expect(await setup(c, t7, null, alt("alt2"))).toBe(0);
      expect(readConfigFile(w.config.configDir)).toMatchObject({ EFF_CREDENTIAL_FILE: alt() });
      w.clock.advance(60_000);
      sent = [];
      expect(await services.auth.probe(services.league)).toMatchObject({ accepted: true });
      expect(sentOnly(c)).toBe(true);
      expect(row()).toEqual({ ...switched, stored_at: t7 });
    },
    ROOT_TEST_MS,
  );
});
