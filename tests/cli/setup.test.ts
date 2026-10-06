// setup.test.ts — `eff setup` wiring (plan 03 §2.1, §2.2; plan 02 §2; changelog V8): the hidden
// prompt (piped input here — nothing is ever echoed), the file and keychain stores (an in-memory
// keyring — never the real keychain), config.json records, the credential_state row, the
// definitive check over an injected network, `--service-name eff-test-…` (no store.sqlite, no
// config.json, no network), `--seeding`, `--reset`, `--page` end to end over loopback. Every line
// printed is checked never to contain the SWID or espn_s2 value.
import { existsSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupNetwork } from "../../src/auth/setup.js";
import type { KeychainSelftestResult } from "../../src/auth/selftest.js";
import { main } from "../../src/cli/main.js";
import { checkSetupFlags, configPatchOf, fixedAnswers, setup } from "../../src/cli/setup.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { containsFragment, fakeCookies } from "../auth/helpers.js";
import { FakeKeyring, makeIo, sandbox, type Sandbox, type TestIo } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const COOKIES = fakeCookies("cli-setup");

/** A network whose answers a test sets; counts calls (a test-mode run must make none). */
function network(
  over: Partial<Record<keyof SetupNetwork, unknown>> = {},
): SetupNetwork & { calls: string[] } {
  const calls: string[] = [];
  const answer =
    <T>(name: string, v: T) =>
    () => {
      calls.push(name);
      return Promise.resolve(v);
    };
  return {
    calls,
    anonymousSettings: answer("anonymousSettings", over.anonymousSettings ?? { status: 401 }),
    anonymousBoard: answer("anonymousBoard", over.anonymousBoard ?? { status: 401 }),
    settingsWithCookies: answer("settingsWithCookies", over.settingsWithCookies ?? { status: 200 }),
    boardWithCookies: answer("boardWithCookies", over.boardWithCookies ?? { status: 200 }),
    resolveTeam: answer("resolveTeam", over.resolveTeam ?? { kind: "one", teamId: 7 }),
  } as unknown as SetupNetwork & { calls: string[] };
}

const selftest = (outcome: KeychainSelftestResult["outcome"]) => () =>
  Promise.resolve<KeychainSelftestResult>({
    outcome,
    reason: outcome === "ok" ? "ok" : "read_timeout",
    code: null,
    at: "2026-10-06T18:00:00.000Z",
    cleanup: "deleted",
  });

function feed(io: TestIo, ...lines: string[]): void {
  (io.stdin as unknown as NodeJS.WritableStream).write(lines.map((l) => `${l}\n`).join(""));
}

function noValues(io: TestIo): void {
  const all = io.out.text + io.err.text;
  expect(containsFragment(all, COOKIES.espn_s2)).toBe(false);
  expect(all).not.toContain(COOKIES.swid);
  expect(all).not.toContain(COOKIES.swid.slice(1, 9));
}

function configJson(): Record<string, string> {
  return JSON.parse(readFileSync(path.join(sb.configDir, "config.json"), "utf8")) as Record<
    string,
    string
  >;
}

describe("flags", () => {
  it("validates combinations (usage errors) and maps patches", () => {
    sb = sandbox();
    const base = {
      reset: false,
      storage: undefined,
      seeding: undefined,
      serviceName: undefined,
      page: false,
    };
    expect(() => {
      checkSetupFlags({ ...base, storage: "cloud" });
    }).toThrow(/keychain or file/);
    expect(() => {
      checkSetupFlags({ ...base, seeding: "coin_flip" });
    }).toThrow(/espn_rule or points_only/);
    expect(() => {
      checkSetupFlags({ ...base, seeding: "points_only", reset: true });
    }).toThrow(/its own action/);
    expect(() => {
      checkSetupFlags({ ...base, serviceName: "espn-fantasy-football-mcp" });
    }).toThrow(/test-only/);
    expect(() => {
      checkSetupFlags({ ...base, serviceName: "eff-test-x", page: true });
    }).toThrow(/--page/);
    expect(() => {
      checkSetupFlags({ ...base, page: true, reset: true });
    }).toThrow(/--reset/);
    expect(() => {
      checkSetupFlags({ ...base, serviceName: "eff-test-ok.1" });
    }).not.toThrow();
    expect(configPatchOf({ ESPN_TEAM_ID: null, EFF_CREDENTIAL_STORE: "file" })).toEqual({
      ESPN_TEAM_ID: null,
      EFF_CREDENTIAL_STORE: "file",
    });
  });
  it("fixedAnswers answers in order then reports closed input", async () => {
    sb = sandbox();
    const p = fixedAnswers(["a"]);
    expect(await p.ask("q", { hidden: false, timeoutMs: 1 })).toEqual({
      kind: "answer",
      value: "a",
    });
    expect(await p.ask("q", { hidden: true, timeoutMs: 1 })).toEqual({ kind: "closed" });
  });
  it("main maps a bad --service-name to exit 2 before touching anything", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["setup", "--service-name", "real-service"], io)).toBe(2);
    expect(existsSync(sb.configDir)).toBe(false);
  });
});

describe("setup", () => {
  it("--storage file on a private league: stored 0600, validated, team recorded, no value printed", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    feed(io, COOKIES.swid, ` ${COOKIES.espn_s2} `);
    const net = network();
    const code = await setup(
      io,
      { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: false },
      { network: net, selftest: selftest("ok") },
    );
    expect(code).toBe(0);
    expect(net.calls).toEqual(["anonymousSettings", "settingsWithCookies", "resolveTeam"]);
    const session = path.join(sb.configDir, "session.json");
    expect(statSync(session).mode & 0o777).toBe(0o600);
    expect(configJson()).toEqual({
      EFF_CREDENTIAL_STORE: "file",
      EFF_CREDENTIAL_FILE: session,
      ESPN_TEAM_ID: "7",
    });
    expect(io.out.text).toContain(`espn_s2 ok (${String(COOKIES.espn_s2.length)} chars)`);
    expect(io.out.text).toContain("private: yes; probe: settings");
    noValues(io);
    const { config, log } = await loadLenientRuntime(makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } }));
    const store = openStore(config, io.clock, log, { migrate: false });
    expect(store.repos.credentialState.get()?.state).toBe("validated");
    store.close();
  });
  it("a fresh install whose keychain self-test times out records the file store for the whole install", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    feed(io, COOKIES.swid, COOKIES.espn_s2);
    expect(
      await setup(
        io,
        {
          reset: false,
          storage: undefined,
          seeding: undefined,
          serviceName: undefined,
          page: false,
        },
        { network: network(), selftest: selftest("timeout") },
      ),
    ).toBe(0);
    expect(configJson()).toMatchObject({
      EFF_CREDENTIAL_STORE: "file",
      keychain_selftest_outcome: "timeout",
    });
    expect(io.out.text).toContain("Keychain check: timeout");
    noValues(io);
  });
  it("a self-test that passes stores in the keychain (the in-memory keyring), meta last", async () => {
    sb = sandbox();
    const keyring = new FakeKeyring();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" }, keyring });
    feed(io, COOKIES.swid, COOKIES.espn_s2);
    expect(
      await setup(
        io,
        {
          reset: false,
          storage: undefined,
          seeding: undefined,
          serviceName: undefined,
          page: false,
        },
        { network: network(), selftest: selftest("ok") },
      ),
    ).toBe(0);
    const sets = keyring.calls.filter((c) => c.op === "set").map((c) => c.account);
    expect(sets).toEqual(["espn_s2", "SWID", "meta"]);
    expect(keyring.calls.every((c) => c.service === "espn-fantasy-football-mcp")).toBe(true);
    expect(existsSync(path.join(sb.configDir, "session.json"))).toBe(false);
    noValues(io);
  });
  it("ESPN refusing the cookies (401) deletes what was stored: exit 3, no session.json, row cleared", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    feed(io, COOKIES.swid, COOKIES.espn_s2);
    expect(
      await setup(
        io,
        { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: false },
        { network: network({ settingsWithCookies: { status: 401 } }), selftest: selftest("ok") },
      ),
    ).toBe(3);
    expect(existsSync(path.join(sb.configDir, "session.json"))).toBe(false);
    expect(io.out.text).toContain("ESPN did not accept these cookies");
    noValues(io);
  });
  it("invalid answers are refused with a reason (never the value), then too many attempts is exit 2", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    feed(io, "no-braces", `SWID=${COOKIES.swid}`, COOKIES.swid.slice(1, -1));
    expect(
      await setup(
        io,
        { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: false },
        { network: network(), selftest: selftest("ok") },
      ),
    ).toBe(2);
    expect(io.out.text).toContain("Too many invalid attempts");
    noValues(io);
  });
  it("--service-name eff-test-…: keychain only under the test service, no store.sqlite, no config.json, no network", async () => {
    sb = sandbox();
    const keyring = new FakeKeyring();
    const io = makeIo(sb, { keyring });
    feed(io, COOKIES.swid, COOKIES.espn_s2);
    const net = network();
    expect(
      await setup(
        io,
        {
          reset: false,
          storage: undefined,
          seeding: undefined,
          serviceName: "eff-test-cli",
          page: false,
        },
        { network: net, selftest: selftest("ok") },
      ),
    ).toBe(0);
    expect(net.calls).toEqual([]);
    expect(keyring.calls.length).toBeGreaterThan(0);
    expect(keyring.calls.every((c) => c.service === "eff-test-cli")).toBe(true);
    expect(existsSync(path.join(sb.cacheDir, "store.sqlite"))).toBe(false);
    expect(existsSync(path.join(sb.configDir, "config.json"))).toBe(false);
    expect(io.out.text).toContain(
      "Test service name: the ESPN check and team resolution were skipped",
    );
    noValues(io);
  });
  it("--service-name with a failing self-test refuses the keychain: exit 1, nothing stored", async () => {
    sb = sandbox();
    const keyring = new FakeKeyring();
    const io = makeIo(sb, { keyring });
    feed(io, COOKIES.swid, COOKIES.espn_s2);
    expect(
      await setup(
        io,
        {
          reset: false,
          storage: "keychain",
          seeding: undefined,
          serviceName: "eff-test-cli2",
          page: false,
        },
        { network: network(), selftest: selftest("error") },
      ),
    ).toBe(1);
    expect(keyring.calls.filter((c) => c.op === "set")).toEqual([]);
  });
  it("closed input before an answer is exit 1 with nothing stored", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    (io.stdin as unknown as NodeJS.WritableStream).end();
    expect(
      await setup(
        io,
        { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: false },
        { network: network(), selftest: selftest("ok") },
      ),
    ).toBe(1);
    expect(io.out.text).toContain("Input ended");
  });
  it("--reset removes both stores and the row; --seeding records the reading and acknowledges settings_changed", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    feed(io, COOKIES.swid, COOKIES.espn_s2);
    await setup(
      io,
      { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: false },
      { network: network(), selftest: selftest("ok") },
    );
    const r = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(
      await setup(
        r,
        {
          reset: true,
          storage: undefined,
          seeding: undefined,
          serviceName: undefined,
          page: false,
        },
        { network: network() },
      ),
    ).toBe(0);
    expect(existsSync(path.join(sb.configDir, "session.json"))).toBe(false);
    expect(r.out.text).toContain("Reset done");
    const { config, log } = await loadLenientRuntime(makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } }));
    const store = openStore(config, r.clock, log, { migrate: false });
    expect(store.repos.credentialState.get()).toBeNull();
    store.repos.leagueSettings.raiseCheck({
      id: "settings_changed",
      status: "warn",
      detail: { n: 1 },
      raised_at: "2026-10-05T00:00:00.000Z",
      settings_hash: null,
      acknowledged: false,
      acknowledged_at: null,
      acknowledged_by: null,
    });
    store.close();
    const s = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", EFF_SEEDING_MODE: "espn_rule" } });
    expect(await main(["setup", "--seeding", "points_only"], s)).toBe(0);
    expect(configJson()).toMatchObject({
      EFF_SEEDING_MODE: "points_only",
      seeding_confirmed_at: "2026-10-06T18:00:00.000Z",
    });
    expect(s.out.text).toContain("1 settings-changed check(s) acknowledged");
    expect(s.out.text).toContain("also set in the environment");
  });
  it("a missing league id is exit 2 for a real setup (test mode needs none)", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(
      await setup(
        io,
        { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: false },
        { network: network() },
      ),
    ).toBe(2);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => {
        resolve(port);
      });
    });
  });
}

function post(url: string, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        host: "127.0.0.1",
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("setup --page (loopback)", () => {
  it("serves one form, accepts the first valid POST, prints the result in the terminal, frees the port", async () => {
    sb = sandbox();
    const port = await freePort();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", EFF_SETUP_PORT: String(port) } });
    const run = setup(
      io,
      { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: true },
      { network: network(), selftest: selftest("ok") },
    );
    let url = "";
    for (let i = 0; i < 200 && url === ""; i++) {
      const m = /http:\/\/127\.0\.0\.1:\d+\/setup\/[0-9a-f]{64}/.exec(io.out.text);
      if (m !== null) url = m[0];
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(url).not.toBe("");
    const token = url.slice(-64);
    const origin = `http://127.0.0.1:${String(port)}`;
    const form = new URLSearchParams({
      token,
      swid: COOKIES.swid,
      espn_s2: COOKIES.espn_s2,
    }).toString();
    expect(await post(url, form, { origin: "http://evil.example" })).toBe(404);
    expect(await post(url, form, { origin, host: `localhost:${String(port)}` })).toBe(404);
    expect(
      await post(
        url,
        new URLSearchParams({
          token: "0".repeat(64),
          swid: COOKIES.swid,
          espn_s2: COOKIES.espn_s2,
        }).toString(),
        { origin },
      ),
    ).toBe(404);
    expect(
      await post(
        url,
        new URLSearchParams({ token, swid: "bad", espn_s2: COOKIES.espn_s2 }).toString(),
        { origin },
      ),
    ).toBe(400);
    expect(await post(url, form, { origin })).toBe(200);
    expect(await run).toBe(0);
    expect(await freePort()).toBeGreaterThan(0);
    expect(io.out.text).toContain("league check ok");
    noValues(io);
  });
});

describe("setup failure paths", () => {
  it("--page: a busy explicit port is exit 2 with the owner; an interrupt stops it with nothing stored", async () => {
    sb = sandbox();
    const busy = await new Promise<import("node:net").Server>((resolve) => {
      const s = createServer();
      s.listen({ host: "127.0.0.1", port: 0 }, () => {
        resolve(s);
      });
    });
    const a = busy.address();
    const port = typeof a === "object" && a !== null ? a.port : 0;
    try {
      const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", EFF_SETUP_PORT: String(port) } });
      expect(
        await setup(
          io,
          { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: true },
          { network: network(), selftest: selftest("ok") },
        ),
      ).toBe(2);
      expect(io.err.text).toContain(`Port ${String(port)} is in use`);
    } finally {
      busy.close();
    }
    const ctl = new AbortController();
    ctl.abort();
    const io2 = makeIo(sb, {
      env: { ESPN_LEAGUE_ID: "0", EFF_SETUP_PORT: String(await freePort()) },
    });
    expect(
      await setup(
        io2,
        { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: true },
        { network: network(), selftest: selftest("ok"), signal: ctl.signal },
      ),
    ).toBe(1);
    expect(io2.out.text).toContain("Stopped: nothing was stored.");
    expect(existsSync(path.join(sb.configDir, "session.json"))).toBe(false);
  });
  it("a store that cannot open is exit 1; a config.json that cannot be written fails closed", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", EFF_CACHE_DIR: "/dev/null/nope" } });
    expect(
      await setup(
        io,
        { reset: false, storage: "file", seeding: undefined, serviceName: undefined, page: false },
        { network: network() },
      ),
    ).toBe(1);
    expect(io.err.text).toContain("store.sqlite could not be opened");
    // a config dir that is a FILE: the seeding record and the setup record both refuse
    const s2 = sandbox();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(s2.configDir, "not a dir");
      const seed = makeIo(s2, { env: { ESPN_LEAGUE_ID: "0" } });
      expect(await main(["setup", "--seeding", "espn_rule"], seed)).toBe(2);
    } finally {
      s2.cleanup();
    }
  });
});
