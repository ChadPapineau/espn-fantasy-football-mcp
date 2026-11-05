// fixture-credential.test.ts — fixture mode's credential-state test seam (changelog §R9, ruling
// R9-3; plan 09 §5.2 variants auth-rejected and public-league; plan 05 §3.1 step 5, §4.4). A derived
// fx-10h variant scripts the credential state it stands for in its manifest's `harness` block, and
// fixture mode — only fixture mode — reports it through espn_get_status and answers the one
// espn_check_auth with the scripted result. Asserted here: the reader's contract (null outside
// fixture mode, null for a variant scripting nothing, a ConfigError for a block it does not
// understand); the scripted authority is a label and a fixed result — no store, no time stamp, no
// request, no cookie-shaped field — whose probe moves the label as a real probe would; through the
// real composition root and the real tools the state reaches the model and every read stays keyless
// (the derived fixture fetch refuses any Cookie header); the seam is unreachable outside fixture
// mode, and fixture mode still refuses to start with a credential stored, before the seam is read.
// Nothing here touches the network, a keychain, ~/.config or ~/.cache: temp directories only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/cli/log.js";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { ConfigError, loadConfig } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import { buildServices } from "../../src/services/index.js";
import {
  SCRIPTED_CREDENTIAL_REFUSALS,
  SCRIPTED_CREDENTIAL_STATES,
  readScriptedCredential,
  scriptedAuth,
} from "../../src/services/fixture-credential.js";
import { storeFactory } from "../../src/store/index.js";
import type { Store } from "../../src/store/types.js";
import { ESPN_FIXTURES, ROOT, call, connect, makeWorld } from "../mcp/helpers/world.js";

const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
const CLOCK_AT = "2026-10-07T01:00:00.000Z";
/** Words that would mean a credential value or its carrier left the seam. */
const COOKIE_WORDS = /espn_s2|swid|cookie|header|fingerprint/i;

let tmp: string;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-fxcred-")));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A derived-league manifest with this `harness` block, in a fresh directory. */
function manifestDir(harness: unknown, kind = "derived_league"): string {
  const dir = mkdtempSync(path.join(tmp, "m-"));
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ kind, league: "fx-10h/x", ...(harness === undefined ? {} : { harness }) }),
  );
  return dir;
}

describe("readScriptedCredential (the variant's harness block)", () => {
  it("is null outside fixture mode, for a directory with no derived manifest, and for a variant scripting nothing", () => {
    expect(readScriptedCredential(null)).toBeNull();
    expect(readScriptedCredential(path.join(ESPN_FIXTURES, "recorded"))).toBeNull();
    expect(readScriptedCredential(FX)).toBeNull(); // the base: not_configured
    for (const v of ["writes-on", "owner-mismatch", "drift-mRoster", "inj-tradeblock"])
      expect(readScriptedCredential(path.join(FX, v)), v).toBeNull();
    expect(readScriptedCredential(manifestDir(undefined))).toBeNull();
    // a manifest that is not a derived league scripts nothing, whatever it carries
    expect(
      readScriptedCredential(manifestDir({ credential_state: "stored" }, "recorded")),
    ).toBeNull();
  });

  it("reads the two committed variants: auth-rejected (rejected; the probe still rejects) and public-league (stored; the board cannot tell)", () => {
    expect(readScriptedCredential(path.join(FX, "auth-rejected"))).toEqual({
      state: "rejected",
      probe: { accepted: false, reason: null, probe: "board" },
    });
    expect(readScriptedCredential(path.join(FX, "public-league"))).toEqual({
      state: "stored",
      probe: { accepted: null, reason: "board_not_discriminating", probe: "board" },
    });
    expect([...SCRIPTED_CREDENTIAL_STATES].sort()).toEqual(["rejected", "stored"]);
  });

  it("refuses (ConfigError on EFF_FIXTURE_DIR, value-free) a state or a probe it does not understand — a case never runs against a state it did not ask for", () => {
    const ok = { accepted: null, reason: "board_not_discriminating", probe: "board" };
    const cases: [unknown, string][] = [
      [{ credential_state: "validated", probe: ok }, SCRIPTED_CREDENTIAL_REFUSALS.state],
      [{ credential_state: 3 }, SCRIPTED_CREDENTIAL_REFUSALS.state],
      ["rejected", SCRIPTED_CREDENTIAL_REFUSALS.state],
      [{ credential_state: "stored" }, SCRIPTED_CREDENTIAL_REFUSALS.probe],
      [
        { credential_state: "stored", probe: { ...ok, accepted: true } },
        SCRIPTED_CREDENTIAL_REFUSALS.probe,
      ],
      [
        {
          credential_state: "rejected",
          probe: { accepted: false, reason: "not_configured", probe: "board" },
        },
        SCRIPTED_CREDENTIAL_REFUSALS.probe,
      ],
      [
        { credential_state: "stored", probe: { ...ok, probe: "keychain" } },
        SCRIPTED_CREDENTIAL_REFUSALS.probe,
      ],
      [
        { credential_state: "stored", probe: { ...ok, header: "x" } },
        SCRIPTED_CREDENTIAL_REFUSALS.probe,
      ],
    ];
    for (const [harness, reason] of cases) {
      let thrown: unknown = null;
      try {
        readScriptedCredential(manifestDir(harness));
      } catch (e) {
        thrown = e;
      }
      expect(thrown, JSON.stringify(harness)).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).issues).toEqual([{ key: "EFF_FIXTURE_DIR", reason }]);
    }
    const broken = mkdtempSync(path.join(tmp, "b-"));
    writeFileSync(path.join(broken, "manifest.json"), "{not json");
    expect(() => readScriptedCredential(broken)).toThrow(ConfigError);
  });
});

describe("scriptedAuth (a label and a fixed result)", () => {
  const clock = fixedClock(CLOCK_AT);

  it("reports the scripted state with no store and no time stamp, and its probe answers without a request", async () => {
    const a = scriptedAuth(
      {
        state: "stored",
        probe: { accepted: null, reason: "board_not_discriminating", probe: "board" },
      },
      clock,
    );
    expect(a.view()).toEqual({
      state: "stored",
      store: null,
      present: true,
      stored_at: null,
      last_accepted_at: null,
      last_rejected_at: null,
      rejected_since: null,
      next_probe_at: null,
    });
    const r = await a.probe();
    expect(r).toEqual({
      accepted: null,
      probe: "board",
      upstream_status: null,
      reason: "board_not_discriminating",
      checked_at: CLOCK_AT,
    });
    // an undecided probe leaves the label
    expect(a.state()).toBe("stored");
    expect(JSON.stringify([a.view(), r])).not.toMatch(COOKIE_WORDS);
  });

  it("an accepting probe moves the label to validated, a rejecting one to rejected (plan 02 §2.1), in memory only", async () => {
    const accept = scriptedAuth(
      { state: "rejected", probe: { accepted: true, reason: null, probe: "settings" } },
      clock,
    );
    expect(accept.state()).toBe("rejected");
    await accept.probe();
    expect(accept.state()).toBe("validated");
    expect(accept.view().state).toBe("validated");
    const reject = scriptedAuth(
      { state: "stored", probe: { accepted: false, reason: null, probe: "board" } },
      clock,
    );
    await reject.probe();
    expect(reject.state()).toBe("rejected");
  });
});

describe("through the real composition root and tools (fixture mode)", () => {
  it("auth-rejected: espn_get_status says rejected, the one probe answers the scripted rejection, and every read stays keyless", async () => {
    const w = await makeWorld({
      env: { EFF_FIXTURE_DIR: path.join(FX, "auth-rejected") },
      teamId: 2,
      clock: CLOCK_AT,
    });
    const c = await connect(w);
    try {
      const status = await call(c.client, "espn_get_status", { include_checks: true });
      expect(status.isError).toBe(false);
      const cred = (status.body.data as Record<string, Record<string, unknown>>).credential;
      expect(cred).toMatchObject({ state: "rejected", present: true, store: null });
      const probe = await call(c.client, "espn_check_auth", {});
      expect(probe.isError).toBe(false);
      expect(probe.body.data).toMatchObject({
        accepted: false,
        probe: "board",
        reason: null,
        state: "rejected",
        upstream_status: null,
      });
      // the derived fixture fetch refuses a Cookie header: these reads succeed only keyless
      for (const [tool, args] of [
        ["espn_get_league", {}],
        ["espn_list_transactions", { week: 2 }],
        ["espn_get_roster", {}],
      ] as const) {
        const r = await call(c.client, tool, args);
        expect(r.isError, `${tool}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(false);
      }
      const scripted = w.logLines.filter((l) => l.includes("services.fixture_credential_scripted"));
      expect(scripted).toHaveLength(1);
      expect(JSON.parse(scripted[0] ?? "{}")).toMatchObject({ state: "rejected" });
      expect(w.logLines.join("\n")).not.toMatch(/espn_s2|swid=/i);
    } finally {
      await c.close();
      w.cleanup();
    }
  }, 120_000);

  it("public-league: stored, and the probe says the board cannot tell (accepted null)", async () => {
    const w = await makeWorld({
      env: { EFF_FIXTURE_DIR: path.join(FX, "public-league") },
      teamId: 2,
      clock: CLOCK_AT,
    });
    const c = await connect(w);
    try {
      const status = await call(c.client, "espn_get_status", {});
      expect(
        (status.body.data as Record<string, Record<string, unknown>>).credential,
      ).toMatchObject({ state: "stored", present: true });
      const probe = await call(c.client, "espn_check_auth", {});
      expect(probe.body.data).toMatchObject({
        accepted: null,
        reason: "board_not_discriminating",
        state: "stored",
        upstream_status: null,
      });
    } finally {
      await c.close();
      w.cleanup();
    }
  }, 120_000);
});

describe("the seam is unreachable outside fixture mode, and the guard runs before it", () => {
  let root: string;
  let store: Store;
  const clock = fixedClock(CLOCK_AT);
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-fxcred-root-")));
    for (const d of ["home", "config", "cache"]) mkdirSync(path.join(root, d), { mode: 0o700 });
    const cache = path.join(root, "cache");
    store = storeFactory.open({
      path: storePath(cache),
      datasetDir: datasetDir(cache),
      backupDir: backupDir(cache),
      clock,
      migrate: true,
    });
  });
  afterAll(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const wire = (env: Record<string, string>) => {
    const lines: string[] = [];
    const config = loadConfig({
      env: {
        ESPN_LEAGUE_ID: "0",
        ESPN_SEASON: "2026",
        EFF_CONFIG_DIR: path.join(root, "config"),
        EFF_CACHE_DIR: path.join(root, "cache"),
        EFF_CREDENTIAL_STORE: "file",
        EFF_CREDENTIAL_FILE: path.join(root, "config", "session.json"),
        ...env,
      },
      file: undefined,
      home: path.join(root, "home"),
      repoRoot: ROOT,
      nowMs: clock.nowMs(),
    });
    const build = () =>
      buildServices({
        config,
        store,
        clock,
        logger: createLogger({ level: "debug", sink: (l) => lines.push(l) }),
        // the package root holds every variant's manifest: a real-mode server never reads one
        packageRoot: ROOT,
        home: path.join(root, "home"),
        fetch: () => Promise.reject(new Error("no network in tests")),
        loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
      });
    return { build, lines };
  };

  it("a server with no EFF_FIXTURE_DIR reports its own store's state, never a variant's", async () => {
    store.repos.credentialState.clear();
    const { build, lines } = wire({});
    const w = build();
    try {
      expect(w.options.fixtureMode).toBe(false);
      expect(w.services.status.credential().state).toBe("not_configured");
      expect(w.services.auth.state()).toBe("not_configured");
      const r = await w.services.auth.probe(w.services.league);
      expect(r).toMatchObject({ accepted: null, reason: "not_configured" });
      expect(lines.some((l) => l.includes("fixture_credential_scripted"))).toBe(false);
    } finally {
      w.close();
    }
  });

  // changelog §R10, R10-33: the eval seed's path (EFF_FIXTURE_SEED) is unreachable outside fixture
  // mode — the real path is unchanged, and no scripted state is read or disarmed
  it("EFF_FIXTURE_SEED=1 with no EFF_FIXTURE_DIR is ignored: the own store's state, never a variant's", async () => {
    store.repos.credentialState.clear();
    for (const v of ["1", "true"]) {
      const { build, lines } = wire({ EFF_FIXTURE_SEED: v });
      const w = build();
      try {
        expect(w.options.fixtureMode).toBe(false);
        expect(w.services.status.credential().state).toBe("not_configured");
        expect(w.services.auth.state()).toBe("not_configured");
        const r = await w.services.auth.probe(w.services.league);
        expect(r).toMatchObject({ accepted: null, reason: "not_configured" });
        expect(lines.some((l) => l.includes("fixture_credential_scripted"))).toBe(false);
      } finally {
        w.close();
      }
    }
  });

  it("with a credential stored, fixture mode on auth-rejected or public-league is refused before the seam is read", () => {
    for (const state of ["stored", "rejected", "validated"] as const) {
      store.repos.credentialState.put({
        league_id: "0",
        state,
        store: "file",
        stored_at: "2026-08-01T00:00:00.000Z",
        last_accepted_at: state === "validated" ? "2026-10-05T00:00:00.000Z" : null,
        last_rejected_at: state === "rejected" ? "2026-10-06T00:00:00.000Z" : null,
        rejected_since: state === "rejected" ? "2026-10-06T00:00:00.000Z" : null,
        next_probe_at: null,
        rejected_view: null,
        board_probe_discriminates: null,
        updated_at: "2026-10-06T00:00:00.000Z",
        updated_by: "setup",
      });
      // the private variants too, the session rejected mid-procedure among them (changelog §R10,
      // R10-27, R10-28): the guard runs before any scripted state is read
      for (const v of [
        "auth-rejected",
        "public-league",
        "private-league-none",
        "private-expiring",
      ]) {
        // the seed's path too (R10-33): the guard runs first, before the flag is read
        for (const seed of [{}, { EFF_FIXTURE_SEED: "1" }]) {
          const { build, lines } = wire({
            EFF_FIXTURE_DIR: path.join(FX, v),
            EFF_TEST_STUBS: "1",
            ...seed,
          });
          expect(build, `${state} ${v} ${JSON.stringify(seed)}`).toThrow(ConfigError);
          expect(lines.some((l) => l.includes("fixture_credential_scripted"))).toBe(false);
          expect(lines.some((l) => l.includes("services.fixture_mode_refused"))).toBe(true);
        }
      }
    }
    store.repos.credentialState.clear();
  });
});
