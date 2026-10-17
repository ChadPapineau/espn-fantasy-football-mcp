// fixture-mode-guard.test.ts — fixture mode's guard at the serve composition root (plan 05 §3.1
// step 5: "`ESPN_LEAGUE_ID=0` in this mode. Not reachable when a credential store holds a value (a
// guard test)"; plan 05 §4.4: "fixture mode unreachable with a stored credential" is in the security
// regression set; Stage C finding config-fixture-mode-guard-bypassed). Before the fix the root never
// built a CredentialAuthority in fixture mode, so the provider's guard never fired: with a credential
// stored and any league id the server started, served fx-10h as that league, wrote it into the
// configured league's cache key and reported the stored credential as absent. Now fixtureModeIssues
// refuses — judged from the startup label's own evidence (the credential_state row of any league, a
// stat of session.json), never a credential-store read — and buildServices throws a ConfigError
// (exit-2 semantics) before anything is wired. Nothing here touches the network, a keychain,
// ~/.config or ~/.cache: every directory is a fresh temp one and every value a placeholder.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeLeagueId } from "../../scripts/ci/secret-fixtures.mjs";
import { sessionFileBody } from "../../src/auth/file.js";
import type { CredentialStateRow } from "../../src/auth/types.js";
import { createLogger } from "../../src/cli/log.js";
import { EXIT, serve } from "../../src/cli/serve.js";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import {
  CREDENTIAL_STATES,
  ConfigError,
  loadConfig,
  type CredentialState,
} from "../../src/config/schema.js";
import {
  FIXTURE_LEAGUE_ID,
  FIXTURE_MODE_REFUSALS,
  buildServices,
  fixtureModeIssues,
} from "../../src/services/index.js";
import { storeFactory } from "../../src/store/index.js";
import type { Store } from "../../src/store/types.js";
import { ESPN_FIXTURES, ROOT, T0, runningClock } from "./helpers/world.js";

const FX10H = path.join(ROOT, "fixtures", "espn", "fx-10h");
/** A configured league that is not the fixture league (derived at run time — never a literal). */
const OTHER_LEAGUE = fakeLeagueId("fixture-mode-guard", 9);
const COOKIES = {
  espn_s2: `AE${"a1B2c3D4".repeat(8)}`,
  swid: "{00000000-0000-4000-8000-000000000001}",
};
const META = { storedAt: "2026-08-01T00:00:00.000Z", format_version: 1, fingerprint: "abcdef" };

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly config: string;
  readonly cache: string;
  readonly session: string;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-fxguard-")));
  chmodSync(root, 0o700);
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const dirs = { home: "home", config: "config", cache: "cache" };
  for (const d of Object.values(dirs)) mkdirSync(path.join(root, d), { mode: 0o700 });
  return {
    root,
    home: path.join(root, "home"),
    config: path.join(root, "config"),
    cache: path.join(root, "cache"),
    session: path.join(root, "config", "session.json"),
  };
}

function openStore(s: Sandbox): Store {
  const store = storeFactory.open({
    path: storePath(s.cache),
    datasetDir: datasetDir(s.cache),
    backupDir: backupDir(s.cache),
    clock: runningClock(T0),
    migrate: true,
  });
  cleanups.push(() => {
    store.close();
  });
  return store;
}

function row(league: string, state: CredentialState): CredentialStateRow {
  return {
    league_id: league,
    state,
    store: "file",
    stored_at: state === "not_configured" ? null : META.storedAt,
    last_accepted_at: state === "validated" ? "2026-10-05T00:00:00.000Z" : null,
    last_rejected_at: state === "rejected" ? "2026-10-06T00:00:00.000Z" : null,
    rejected_since: state === "rejected" ? "2026-10-06T00:00:00.000Z" : null,
    next_probe_at: null,
    rejected_view: null,
    board_probe_discriminates: null,
    updated_at: "2026-10-06T00:00:00.000Z",
    updated_by: "setup",
  };
}

const writeSession = (file: string): void => {
  writeFileSync(file, sessionFileBody(COOKIES, META), { mode: 0o600 });
};

/** The fixture-mode composition over the sandbox, its log lines kept (raw and parsed). */
function wire(s: Sandbox, store: Store, env: Record<string, string> = {}, loadKeyring = vi.fn()) {
  const config = loadConfig({
    env: {
      ESPN_LEAGUE_ID: FIXTURE_LEAGUE_ID,
      ESPN_SEASON: "2026",
      EFF_CONFIG_DIR: s.config,
      EFF_CACHE_DIR: s.cache,
      EFF_FIXTURE_DIR: ESPN_FIXTURES,
      ...env,
    },
    file: undefined,
    home: s.home,
    repoRoot: ROOT,
    nowMs: Date.parse(T0),
  });
  const raw: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => raw.push(l) });
  const build = () =>
    buildServices({
      config,
      store,
      clock: runningClock(T0),
      logger,
      packageRoot: ROOT,
      home: s.home,
      loadKeyring: loadKeyring as never,
    });
  const lines = () => raw.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { build, raw, lines, loadKeyring };
}

/** The ConfigError a refused composition throws (or a failure naming what was thrown instead). */
function refusal(f: () => unknown): ConfigError {
  try {
    f();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw new Error(`expected a ConfigError, got ${e instanceof Error ? e.name : typeof e}`);
  }
  throw new Error("expected fixture mode to be refused, but it started");
}

describe("fixtureModeIssues (the guard, pure over its evidence)", () => {
  it("league 0 with nothing stored may start; a non-zero league id is refused on ESPN_LEAGUE_ID", () => {
    const s = sandbox();
    const none = { get: () => null };
    const cfg = { leagueId: FIXTURE_LEAGUE_ID, credentialStore: "keychain" as const };
    expect(fixtureModeIssues({ ...cfg, credentialFile: s.session }, none)).toEqual([]);
    expect(
      fixtureModeIssues({ ...cfg, leagueId: OTHER_LEAGUE, credentialFile: s.session }, none),
    ).toEqual([{ key: "ESPN_LEAGUE_ID", reason: FIXTURE_MODE_REFUSALS.league_id }]);
  });

  it("a row saying a value is stored — for this league or any other — refuses; a not_configured row does not", () => {
    const s = sandbox();
    const cfg = {
      leagueId: FIXTURE_LEAGUE_ID,
      credentialStore: "keychain" as const,
      credentialFile: s.session,
    };
    for (const league of [FIXTURE_LEAGUE_ID, OTHER_LEAGUE]) {
      for (const state of ["stored", "validated", "rejected"] as const)
        expect(fixtureModeIssues(cfg, { get: () => row(league, state) }), state).toEqual([
          { key: "EFF_FIXTURE_DIR", reason: FIXTURE_MODE_REFUSALS.credential_stored },
        ]);
      expect(fixtureModeIssues(cfg, { get: () => row(league, "not_configured") })).toEqual([]);
    }
  });

  it("a session.json at the configured path refuses whichever store config.json names", () => {
    const s = sandbox();
    writeSession(s.session);
    for (const credentialStore of ["file", "keychain"] as const)
      expect(
        fixtureModeIssues(
          { leagueId: FIXTURE_LEAGUE_ID, credentialStore, credentialFile: s.session },
          { get: () => null },
        ),
        credentialStore,
      ).toEqual([{ key: "EFF_FIXTURE_DIR", reason: FIXTURE_MODE_REFUSALS.credential_stored }]);
  });

  it("evidence that cannot be read refuses (fail closed): a failing row read, a failing stat", () => {
    const s = sandbox();
    const cfg = { leagueId: FIXTURE_LEAGUE_ID, credentialStore: "file" as const };
    const unknown = [{ key: "EFF_FIXTURE_DIR", reason: FIXTURE_MODE_REFUSALS.credential_unknown }];
    const broken = {
      get: () => {
        throw new Error("database disk image is malformed");
      },
    };
    expect(fixtureModeIssues({ ...cfg, credentialFile: s.session }, broken)).toEqual(unknown);
    // a path component longer than NAME_MAX: the stat fails with ENAMETOOLONG, not ENOENT
    const unstattable = path.join(s.config, "x".repeat(300), "session.json");
    expect(fixtureModeIssues({ ...cfg, credentialFile: unstattable }, { get: () => null })).toEqual(
      unknown,
    );
  });

  it("property: refused iff the league is not 0, or session.json exists, or a row says a value is stored — value-free", () => {
    const s = sandbox();
    const present = path.join(s.config, "present.json");
    writeSession(present);
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.record({ ours: fc.boolean(), state: fc.constantFrom(...CREDENTIAL_STATES) }), {
          nil: null,
        }),
        fc.boolean(),
        fc.constantFrom("keychain" as const, "file" as const),
        (zero, r, file, credentialStore) => {
          const issues = fixtureModeIssues(
            {
              leagueId: zero ? FIXTURE_LEAGUE_ID : OTHER_LEAGUE,
              credentialStore,
              credentialFile: file ? present : s.session,
            },
            {
              get: () =>
                r === null ? null : row(r.ours ? FIXTURE_LEAGUE_ID : OTHER_LEAGUE, r.state),
            },
          );
          const stored = file || (r !== null && r.state !== "not_configured");
          const want = [
            ...(zero ? [] : ["ESPN_LEAGUE_ID"]),
            ...(stored ? ["EFF_FIXTURE_DIR"] : []),
          ];
          expect(issues.map((i) => i.key).sort()).toEqual(want.sort());
          for (const i of issues) {
            expect(i.reason).not.toContain(OTHER_LEAGUE);
            expect(i.reason).not.toContain(s.root);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("buildServices in fixture mode (the composition root)", () => {
  it("positive control: league 0, nothing stored → it starts, no refusal, no keychain touched", async () => {
    const s = sandbox();
    const store = openStore(s);
    const w = wire(s, store);
    const wiring = w.build();
    try {
      expect(wiring.options.fixtureMode).toBe(true);
      expect(wiring.services.status.credential()).toMatchObject({
        state: "not_configured",
        present: false,
      });
      const league = await wiring.provider.getLeague(wiring.services.league);
      expect(league.value.size).toBe(10);
    } finally {
      wiring.close();
    }
    expect(w.raw.join("\n")).not.toContain("services.fixture_mode_refused");
    expect(w.loadKeyring).not.toHaveBeenCalled();
  });

  it("a non-zero league id throws a ConfigError on ESPN_LEAGUE_ID (exit-2 semantics), logged without the id", () => {
    const s = sandbox();
    const store = openStore(s);
    const w = wire(s, store, { ESPN_LEAGUE_ID: OTHER_LEAGUE });
    const e = refusal(w.build);
    expect(e.issues).toEqual([{ key: "ESPN_LEAGUE_ID", reason: FIXTURE_MODE_REFUSALS.league_id }]);
    expect(e.exitCode).toBe(EXIT.usage);
    expect(w.lines().filter((l) => l.event === "services.fixture_mode_refused")).toEqual([
      expect.objectContaining({
        level: "error",
        key: "ESPN_LEAGUE_ID",
        reason: FIXTURE_MODE_REFUSALS.league_id,
      }),
    ]);
    expect(w.raw.join("\n")).not.toContain(OTHER_LEAGUE);
  });

  it("a stored credential row (setup's evidence) is refused, and the keychain is never read to tell", () => {
    const s = sandbox();
    const store = openStore(s);
    store.repos.credentialState.put(row(OTHER_LEAGUE, "validated"));
    const w = wire(s, store);
    const e = refusal(w.build);
    expect(e.issues).toEqual([
      { key: "EFF_FIXTURE_DIR", reason: FIXTURE_MODE_REFUSALS.credential_stored },
    ]);
    expect(w.lines().some((l) => l.event === "services.fixture_mode_refused")).toBe(true);
    expect(w.loadKeyring).not.toHaveBeenCalled();
    // under the test stubs too: a keychain access would have exited the process (99)
    const stubs = wire(s, store, { EFF_TEST_STUBS: "1" });
    expect(refusal(stubs.build).issues.map((i) => i.key)).toEqual(["EFF_FIXTURE_DIR"]);
  });

  it("a file-store credential (session.json) is refused, together with a non-zero league id", () => {
    const s = sandbox();
    const store = openStore(s);
    writeSession(s.session);
    const w = wire(s, store, {
      ESPN_LEAGUE_ID: OTHER_LEAGUE,
      EFF_CREDENTIAL_STORE: "file",
      EFF_CREDENTIAL_FILE: s.session,
    });
    expect(
      refusal(w.build)
        .issues.map((i) => i.key)
        .sort(),
    ).toEqual(["EFF_FIXTURE_DIR", "ESPN_LEAGUE_ID"]);
    expect(w.raw.join("\n")).not.toMatch(/espn_s2|SWID|a1B2c3D4/);
  });
});

describe("the finding's repro through `eff serve` (in process)", () => {
  it("fixture mode with a stored file credential and a non-zero league id never starts and writes nothing", async () => {
    const s = sandbox();
    writeFileSync(
      path.join(s.config, "config.json"),
      JSON.stringify({ EFF_CREDENTIAL_STORE: "file", EFF_CREDENTIAL_FILE: s.session }),
      { mode: 0o600 },
    );
    writeSession(s.session);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const code = serve(
      {
        argv: [],
        env: {
          HOME: s.home,
          ESPN_LEAGUE_ID: OTHER_LEAGUE,
          ESPN_SEASON: "2026",
          EFF_CONFIG_DIR: s.config,
          EFF_CACHE_DIR: s.cache,
          EFF_FIXTURE_DIR: FX10H,
          EFF_TEST_STUBS: "1",
          EFF_LOG_LEVEL: "debug",
        },
        stdin,
        stdout,
        stderr,
      },
      { clock: runningClock(T0), signals: false, packageRoot: ROOT },
    );
    // what a client sends at once: initialize, then a read of the league (which, unguarded, wrote
    // the fixture league into the cache under the configured league's key)
    const send = (m: unknown): void => {
      stdin.write(`${JSON.stringify(m)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture-guard-test", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "espn_get_league", arguments: {} },
    });
    const run = { exited: false };
    void code.then(() => {
      run.exited = true;
    });
    const until = Date.now() + 20_000;
    while (!run.exited && !out.includes('"id":2') && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    stdin.end();
    const exit = await code;

    const events = err
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((l) => l.event === "serve.ready")).toBe(false);
    expect(
      events
        .filter((l) => l.event === "services.fixture_mode_refused")
        .map((l) => l.key)
        .sort(),
    ).toEqual(["EFF_FIXTURE_DIR", "ESPN_LEAGUE_ID"]);
    expect(exit).not.toBe(EXIT.ok);
    expect(out).toBe("");
    expect(err).not.toContain(OTHER_LEAGUE);
    const db = new DatabaseSync(storePath(s.cache), { readOnly: true });
    try {
      const n = db.prepare("SELECT COUNT(*) AS n FROM espn_cache").get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      db.close();
    }
  }, 60_000);
});
