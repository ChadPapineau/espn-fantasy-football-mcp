// store-switch-services.test.ts — the finding auth-store-switch-deletes-credential-row through the
// composition root itself (src/services/index.ts buildServices, unchanged): a server wired on the
// keychain store config.json recorded at start, over a real store.sqlite, the real EspnProvider and a
// private-league fetch (anonymous league reads answer 401; cookie-bearing ones are served from the
// recorded fixtures). `eff setup --storage file` then runs in "another terminal" (src/auth/setup.ts
// over the same keychain and file paths). Afterwards espn_check_auth and espn_get_roster send
// the new value with no restart, and the `credential_state` row stays (state validated, store file),
// so `eff status` and the daily credential check keep seeing it (plan 02 §2.1, §2.2; plan 03 L6;
// plan 06 §1.4). No network, no real keychain: an in-memory keyring and temp paths only.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCookieHeader } from "../../src/auth/format.js";
import type { KeychainSelftestResult } from "../../src/auth/selftest.js";
import { runSetup, type PromptAnswer } from "../../src/auth/setup.js";
import { openCredentialStores } from "../../src/auth/stores.js";
import type { CredentialStoreKind, EspnCookies } from "../../src/auth/types.js";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { buildServices, type Wiring } from "../../src/services/index.js";
import { noXattrs } from "../config/helpers.js";
import {
  ROOT,
  call,
  connect,
  fixtureFetchPlus,
  makeWorld,
  type World,
} from "../mcp/helpers/world.js";
import { FakeKeyring, RecordingRegistrar, fakeCookies } from "./helpers.js";

let w: World;
let kr: FakeKeyring;
let wiring: Wiring | null = null;
/** The Cookie header of every request the provider made (kept in memory; compared, never printed). */
let sent: (string | null)[];

beforeEach(async () => {
  w = await makeWorld({ env: { EFF_CREDENTIAL_STORE: "keychain" } });
  kr = new FakeKeyring();
  sent = [];
});
afterEach(() => {
  wiring?.close();
  wiring = null;
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

const cfg = () => ({
  filePath: w.config.credentialFile,
  home: path.join(w.root, "home"),
  repoRoot: ROOT,
  xattr: noXattrs,
  loadKeyring: () => Promise.resolve(kr),
});

async function setup(
  cookies: EspnCookies,
  at: string,
  storage: CredentialStoreKind,
  recordedStore: CredentialStoreKind | null,
): Promise<number> {
  const answers: PromptAnswer[] = [
    { kind: "answer", value: cookies.swid },
    { kind: "answer", value: cookies.espn_s2 },
  ];
  const r = await runSetup(
    {
      reset: false,
      storage,
      serviceName: null,
      leagueId: w.config.leagueId,
      season: w.config.season,
      recordedStore,
      filePath: w.config.credentialFile,
    },
    {
      prompt: { ask: () => Promise.resolve(answers.shift() ?? { kind: "closed" }) },
      out: () => undefined,
      now: () => at,
      stores: openCredentialStores(cfg()),
      runSelftest: (): Promise<KeychainSelftestResult> =>
        Promise.resolve({ outcome: "ok", reason: "ok", code: null, at, cleanup: "deleted" }),
      network: {
        anonymousSettings: () => Promise.resolve({ status: 401 }),
        anonymousBoard: () => Promise.resolve({ error: "unused" }),
        settingsWithCookies: () => Promise.resolve({ status: 200 }),
        boardWithCookies: () => Promise.resolve({ error: "unused" }),
        resolveTeam: () => Promise.resolve({ kind: "one", teamId: 1 }),
      },
      config: { record: () => Promise.resolve() },
      credentialState: w.store.repos.credentialState,
      registrar: new RecordingRegistrar(),
    },
  );
  return r.exitCode;
}

describe("a running server across `eff setup --storage file` (composition root)", () => {
  it("espn_check_auth and espn_get_roster use the file's value; the row stays", async () => {
    const a = fakeCookies("svc-switch-a");
    const b = fakeCookies("svc-switch-b");
    const t0 = w.clock.nowIso();
    expect(await setup(a, t0, "keychain", null)).toBe(0);
    wiring = buildServices({
      config: w.config,
      store: w.store,
      clock: w.clock,
      logger: w.logger,
      packageRoot: ROOT,
      home: path.join(w.root, "home"),
      fetch: privateLeague(fixtureFetchPlus("league-a", [])),
      loadKeyring: () => Promise.resolve(kr),
    });
    const services = wiring.services;
    expect(services.auth.state()).toBe("validated");
    const first = await services.auth.probe(services.league);
    expect(first.accepted).toBe(true);
    expect(sent.at(-1) === buildCookieHeader(a)).toBe(true);

    w.clock.advance(60_000);
    expect(await setup(b, w.clock.nowIso(), "file", "keychain")).toBe(0);
    const t5 = w.store.repos.credentialState.get()?.stored_at;

    // espn_check_auth as the first call after the switch
    w.clock.advance(60_000);
    sent = [];
    const probe = await services.auth.probe(services.league);
    expect(probe).toMatchObject({ accepted: true, reason: null });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((c) => c !== null).every((c) => c === buildCookieHeader(b))).toBe(true);

    // espn_get_roster over the MCP surface (the finding's ESPN_REQUIRES_COOKIES): the file's value
    sent = [];
    const c = await connect({ services, options: wiring.options });
    try {
      const roster = await call(c.client, "espn_get_roster", { force_refresh: true });
      expect(roster.isError ? (roster.body.error as { code: string }).code : "ok").toBe("ok");
      expect(sent.some((x) => x === buildCookieHeader(b))).toBe(true);
      expect(sent.some((x) => x === buildCookieHeader(a))).toBe(false);
    } finally {
      await c.close();
    }

    // eff status / the daily credential check read this row: still there, validated, file
    const row = w.store.repos.credentialState.get();
    expect(row).toMatchObject({
      league_id: w.config.leagueId,
      state: "validated",
      store: "file",
      stored_at: t5,
    });
  });
});
