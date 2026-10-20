// status-store-label.test.ts — espn_get_status's `credential.store` across `eff setup --storage …`
// while the server runs (Stage C finding status-credential-store-label-stale; plan 07 G1
// `credential.store`, the session-check Skill's "where stored"; plan 02 §2.2 "One store per
// install", "Multiple processes"; plan 03 L6). The server is the real composition root
// (src/services/index.ts buildServices) over a real store.sqlite, the real EspnProvider and a
// private-league fixture fetch; setup is the real orchestration (src/auth/setup.ts) writing
// config.json through the CLI's own writer, in "another terminal" over the same keychain (an
// in-memory keyring) and file paths. The label names the backend the credential authority reads
// now — the one this league's `credential_state` row records — from the moment setup records it:
// the next read goes exactly there (observed: which backend served it and whose value was sent),
// and a process started now (`eff status`) says the same. No network, no real keychain, temp paths.
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
import { loadConfig, readConfigFile } from "../../src/config/schema.js";
import { createServer } from "../../src/mcp/server.js";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { buildServices, type Wiring } from "../../src/services/index.js";
import { FakeKeyring, RecordingRegistrar, fakeCookies } from "../auth/helpers.js";
import { noXattrs } from "../config/helpers.js";
import { ROOT, body, fixtureFetchPlus, makeWorld, type World } from "../mcp/helpers/world.js";

type J = Record<string, unknown>;

/** A composition-root test's own limit (real setups and probes; the unit default detects hangs). */
const ROOT_TEST_MS = 180_000;

let w: World;
let kr: FakeKeyring;
let home: string;
let wiring: Wiring | null;
/** The Cookie header of every request the provider made (kept in memory; compared, never printed). */
let sent: (string | null)[];

beforeEach(async () => {
  w = await makeWorld({ env: { EFF_CREDENTIAL_STORE: "keychain" } });
  home = path.join(w.root, "home");
  kr = new FakeKeyring();
  wiring = null;
  sent = [];
});
afterEach(() => {
  wiring?.close();
  w.cleanup();
});

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

/** `eff setup [--storage kind | --reset]` in another terminal (the CLI's store and path, config.json written). */
async function setup(
  cookies: EspnCookies,
  at: string,
  storage: CredentialStoreKind | null,
  opts: { readonly reset?: boolean } = {},
): Promise<number> {
  const recorded = readConfigFile(w.config.configDir) as J | undefined;
  const recordedStore = recorded?.EFF_CREDENTIAL_STORE;
  const answers: PromptAnswer[] = [
    { kind: "answer", value: cookies.swid },
    { kind: "answer", value: cookies.espn_s2 },
  ];
  const r = await runSetup(
    {
      reset: opts.reset ?? false,
      storage,
      serviceName: null,
      leagueId: w.config.leagueId,
      season: w.config.season,
      recordedStore:
        recordedStore === "keychain" || recordedStore === "file" ? recordedStore : null,
      filePath: w.config.credentialFile,
    },
    {
      prompt: { ask: () => Promise.resolve(answers.shift() ?? { kind: "closed" }) },
      out: () => undefined,
      now: () => at,
      stores: openCredentialStores({
        filePath: w.config.credentialFile,
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
            { configDir: w.config.configDir, home, repoRoot: ROOT, xattr: noXattrs },
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

/** The server, as `eff serve` composes it (started from a client env block naming the keychain). */
function serve(): Wiring {
  wiring = buildServices({
    config: w.config,
    store: w.store,
    clock: w.clock,
    logger: w.logger,
    packageRoot: ROOT,
    home,
    fetch: privateLeague(fixtureFetchPlus("league-a", [])),
    loadKeyring: () => Promise.resolve(kr),
  });
  return wiring;
}

/** What a process started now reports (`eff status` reads config.json's recorded store). */
function startedNowStore(): string {
  return loadConfig({
    env: {
      ESPN_LEAGUE_ID: "0",
      ESPN_SEASON: "2026",
      EFF_CONFIG_DIR: w.config.configDir,
      EFF_CACHE_DIR: w.cache,
      EFF_CREDENTIAL_STORE: "keychain",
    },
    file: readConfigFile(w.config.configDir),
    home,
    repoRoot: ROOT,
    nowMs: w.clock.nowMs(),
    xattr: noXattrs,
  }).credentialStore;
}

/** The keychain reads so far (service/account only — never a value). */
const keychainReads = (): number => kr.calls.filter((c) => c.op === "get").length;

/** espn_get_status's and espn-ff://status's `credential` over the MCP surface. */
async function surfaces(x: Wiring): Promise<{ tool: J; resource: J }> {
  const server = createServer(x.services, x.options);
  const client = new Client({ name: "eff-test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const st = body(await client.callTool({ name: "espn_get_status", arguments: {} }));
    const raw = (await client.readResource({ uri: "espn-ff://status" })) as unknown as {
      contents: { text: string }[];
    };
    const res = JSON.parse(raw.contents[0]?.text ?? "{}") as J;
    return {
      tool: (st.data as { credential: J }).credential,
      resource: (res.data as { credential: J }).credential,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("credential.store follows `eff setup --storage …` while the server runs (the finding's repro)", () => {
  it(
    "keychain → file → keychain: the label names the backend the next read goes to, from the moment setup records it",
    async () => {
      const [a, b, c] = [fakeCookies("lbl-a"), fakeCookies("lbl-b"), fakeCookies("lbl-c")];
      expect(await setup(a, w.clock.nowIso(), "keychain")).toBe(0);
      const server0 = serve();
      const services = server0.services;
      expect(services.status.credential()).toMatchObject({ state: "validated", store: "keychain" });

      // `eff setup --storage file` (the same default session.json path), no server call in between
      w.clock.advance(60_000);
      expect(await setup(b, w.clock.nowIso(), "file")).toBe(0);
      expect(w.store.repos.credentialState.get()).toMatchObject({
        state: "validated",
        store: "file",
      });
      expect(kr.items.size).toBe(0); // setup emptied the keychain: the value is in session.json
      expect(startedNowStore()).toBe("file");
      expect(services.status.credential()).toMatchObject({ state: "validated", store: "file" });
      const s1 = await surfaces(server0);
      expect(s1.tool).toMatchObject({ present: true, state: "validated", store: "file" });
      expect(s1.resource).toMatchObject({ present: true, state: "validated", store: "file" });

      // the authority's next read goes exactly there: session.json's value, no keychain read
      w.clock.advance(60_000);
      sent = [];
      const before = keychainReads();
      expect(await services.auth.probe(services.league)).toMatchObject({ accepted: true });
      expect(keychainReads()).toBe(before);
      expect(sent.filter((x) => x !== null).every((x) => x === buildCookieHeader(b))).toBe(true);
      expect(sent.some((x) => x !== null)).toBe(true);
      expect(services.status.credential()).toMatchObject({ state: "validated", store: "file" });

      // and back: `eff setup --storage keychain`
      w.clock.advance(60_000);
      expect(await setup(c, w.clock.nowIso(), "keychain")).toBe(0);
      expect(startedNowStore()).toBe("keychain");
      expect(services.status.credential()).toMatchObject({ state: "validated", store: "keychain" });
      w.clock.advance(60_000);
      sent = [];
      const before2 = keychainReads();
      expect(await services.auth.probe(services.league)).toMatchObject({ accepted: true });
      expect(keychainReads()).toBeGreaterThan(before2);
      expect(sent.filter((x) => x !== null).every((x) => x === buildCookieHeader(c))).toBe(true);
      expect(services.status.credential()).toMatchObject({ state: "validated", store: "keychain" });

      // `eff setup --reset`: once the authority's next cookie-bearing read finds nothing stored (plan
      // 03 §1.1 step 4: a row without items → not_configured), no store is named
      w.clock.advance(60_000);
      expect(await setup(c, w.clock.nowIso(), null, { reset: true })).toBe(0);
      expect(w.store.repos.credentialState.get()).toBeNull();
      const server = createServer(services, server0.options);
      const client = new Client({ name: "eff-test-client", version: "0.0.0" });
      const [t1, t2] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(t1), client.connect(t2)]);
      try {
        await client.callTool({ name: "espn_get_roster", arguments: { force_refresh: true } });
      } finally {
        await client.close();
        await server.close();
      }
      expect(services.auth.state()).toBe("not_configured");
      expect(services.status.credential()).toMatchObject({
        state: "not_configured",
        present: false,
        store: null,
      });
    },
    ROOT_TEST_MS,
  );

  it(
    "no row for this league: the install store's own backend (the kind it starts on), never another league's row",
    () => {
      w.store.repos.credentialState.put({
        league_id: "999",
        state: "validated",
        store: "file",
        stored_at: "2026-10-01T00:00:00.000Z",
        last_accepted_at: "2026-10-01T00:00:00.000Z",
        last_rejected_at: null,
        rejected_since: null,
        next_probe_at: null,
        rejected_view: null,
        board_probe_discriminates: null,
        updated_at: "2026-10-01T00:00:00.000Z",
        updated_by: "setup",
      });
      const services = serve().services;
      // a row for another league reads as `stored` (plan 03 §1.1 step 4); it names no backend for
      // this league, so the install store stays on the kind config.json named at start
      expect(services.status.credential()).toMatchObject({ state: "stored", store: "keychain" });
    },
    ROOT_TEST_MS,
  );
});
