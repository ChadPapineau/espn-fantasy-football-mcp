// setup.test.ts — src/auth/setup.ts, `eff setup` over injected IO (plan 03 §2.1 steps 1–8 and its
// flags; plan 02 §2.1 definitive check, §2.2 one store per install; ADV OBJ-05, OBJ-14, OBJ-15,
// OBJ-25, OBJ-26; changelog V8; plan 10 A2b): the private and public probe paths, the 401 / 404
// deletions, the kept-value error paths, format retries, prompt timeouts, the self-test's store
// choice, `--storage`, `--service-name` (no network, no config, no row, file store untouched),
// `--reset`, team resolution — and no value, SWID or league id in any printed line.
import { describe, expect, it } from "vitest";
import { fakeLeagueId } from "../../scripts/ci/secret-fixtures.mjs";
import { CredentialStoreError } from "../../src/auth/errors.js";
import { buildCookieHeader } from "../../src/auth/format.js";
import type { KeychainSelftestResult } from "../../src/auth/selftest.js";
import {
  SETUP_MAX_ATTEMPTS,
  SETUP_PROMPT_TIMEOUT_MS,
  SETUP_TEXT,
  runSetup,
  selftestLine,
  type HttpProbeResult,
  type PromptAnswer,
  type SetupConfigPatch,
  type SetupRequest,
  type TeamResolution,
} from "../../src/auth/setup.js";
import { KEYCHAIN_SERVICE, type CookieHeader, type EspnCookies } from "../../src/auth/types.js";
import {
  MemoryStateRepo,
  MemoryStore,
  RecordingRegistrar,
  containsFragment,
  fakeCookies,
  stateRow,
} from "./helpers.js";

const NOW = "2026-10-06T12:00:00.000Z";
const LEAGUE = fakeLeagueId("auth-setup", 8);

interface NetPlan {
  anon?: HttpProbeResult;
  anonBoard?: HttpProbeResult;
  settings?: HttpProbeResult;
  board?: HttpProbeResult;
  team?: TeamResolution;
}

function harness(
  opts: {
    answers?: PromptAnswer[];
    net?: NetPlan;
    selftest?: Partial<KeychainSelftestResult>;
    service?: string;
    repo?: MemoryStateRepo | null;
    configFails?: (p: SetupConfigPatch) => boolean;
    cookies?: EspnCookies;
  } = {},
) {
  const c = opts.cookies ?? fakeCookies("setup");
  const keychain = new MemoryStore("keychain", opts.service ?? KEYCHAIN_SERVICE);
  const file = new MemoryStore("file");
  const repo = opts.repo === undefined ? new MemoryStateRepo() : opts.repo;
  const lines: string[] = [];
  const asked: { q: string; hidden: boolean; timeoutMs: number }[] = [];
  const answers = [
    ...(opts.answers ?? [
      { kind: "answer", value: c.swid },
      { kind: "answer", value: c.espn_s2 },
    ]),
  ];
  const calls: string[] = [];
  const headers: CookieHeader[] = [];
  const net: NetPlan = {
    anon: { status: 401 },
    settings: { status: 200 },
    team: { kind: "one", teamId: 3 },
    ...opts.net,
  };
  const patches: SetupConfigPatch[] = [];
  const selftests: string[] = [];
  const reg = new RecordingRegistrar();
  const deps = {
    prompt: {
      ask: (q: string, o: { hidden: boolean; timeoutMs: number }): Promise<PromptAnswer> => {
        asked.push({ q, ...o });
        return Promise.resolve(answers.shift() ?? { kind: "closed" });
      },
    },
    out: (l: string) => lines.push(l),
    now: () => NOW,
    stores: { keychain, file },
    runSelftest: (service: string): Promise<KeychainSelftestResult> => {
      selftests.push(service);
      return Promise.resolve({
        outcome: "ok",
        reason: "ok",
        code: null,
        at: NOW,
        cleanup: "deleted",
        ...opts.selftest,
      });
    },
    network: {
      anonymousSettings: () => (
        calls.push("anon"),
        Promise.resolve(net.anon ?? { error: "unset" })
      ),
      anonymousBoard: () => (
        calls.push("anonBoard"),
        Promise.resolve(net.anonBoard ?? { error: "unset" })
      ),
      settingsWithCookies: (h: CookieHeader) => (
        calls.push("settings"),
        headers.push(h),
        Promise.resolve(net.settings ?? { error: "unset" })
      ),
      boardWithCookies: (h: CookieHeader) => (
        calls.push("board"),
        headers.push(h),
        Promise.resolve(net.board ?? { error: "unset" })
      ),
      resolveTeam: (h: CookieHeader, swid: string) => {
        calls.push("team");
        headers.push(h);
        expect(swid).toBe(c.swid);
        return Promise.resolve<TeamResolution>(net.team ?? { kind: "error", code: "unset" });
      },
    },
    config: {
      record: (p: SetupConfigPatch) => {
        if (opts.configFails?.(p) === true) return Promise.reject(new Error("EACCES"));
        patches.push(p);
        return Promise.resolve();
      },
    },
    credentialState: repo,
    registrar: reg,
  };
  const req = (over: Partial<SetupRequest> = {}): SetupRequest => ({
    reset: false,
    storage: null,
    serviceName: null,
    leagueId: LEAGUE,
    season: 2026,
    recordedStore: null,
    filePath: "/nonexistent/eff-config/session.json",
    ...over,
  });
  /** Nothing printed carries a value, the SWID or the league id (plan 02 §2.3). */
  const assertClean = (): void => {
    const all = lines.join("\n");
    expect(containsFragment(all, c.espn_s2, 12)).toBe(false);
    let decoded = c.espn_s2;
    try {
      decoded = decodeURIComponent(c.espn_s2);
    } catch {
      // a value cut mid-escape has no decoded form
    }
    expect(containsFragment(all, decoded, 12)).toBe(false);
    expect(all).not.toContain(c.swid.slice(1, 9));
    expect(all).not.toContain(LEAGUE);
  };
  return {
    c,
    keychain,
    file,
    repo,
    lines,
    asked,
    calls,
    headers,
    patches,
    selftests,
    reg,
    deps,
    req,
    assertClean,
  };
}

describe("the private-league path (plan 03 §2.1; plan 02 §2.1: mSettings with cookies)", () => {
  it("fresh install: prompts, self-test ok → keychain, probe 200 → validated, team recorded", async () => {
    const h = harness();
    const r = await runSetup(h.req(), h.deps);
    expect(r).toEqual({
      exitCode: 0,
      state: "validated",
      store: "keychain",
      accepted: true,
      probe: "settings",
      teamId: 3,
      selftest: "ok",
    });
    expect(h.asked.map((a) => [a.hidden, a.timeoutMs])).toEqual([
      [false, SETUP_PROMPT_TIMEOUT_MS],
      [true, SETUP_PROMPT_TIMEOUT_MS],
    ]);
    expect(h.keychain.stored?.cookies).toEqual(h.c);
    expect(h.keychain.stored?.meta.storedAt).toBe(NOW);
    expect(h.file.deletes).toBe(1); // the other store is emptied first — one store per install
    expect(h.selftests).toEqual([KEYCHAIN_SERVICE]);
    expect(h.patches).toEqual([
      {
        keychain_selftest_outcome: "ok",
        keychain_selftest_at: NOW,
        EFF_CREDENTIAL_STORE: "keychain",
      },
      { ESPN_TEAM_ID: "3" },
    ]);
    expect(h.calls).toEqual(["anon", "settings", "team"]);
    expect(h.headers.every((x) => x === buildCookieHeader(h.c))).toBe(true);
    expect(h.repo?.row).toMatchObject({
      league_id: LEAGUE,
      state: "validated",
      store: "keychain",
      stored_at: NOW,
      last_accepted_at: NOW,
      updated_by: "setup",
    });
    expect(h.reg.registered.some((x) => x.value === h.c.espn_s2)).toBe(true);
    expect(h.lines).toContain(SETUP_TEXT.repaste);
    expect(h.lines.join("\n")).toContain("league check ok (private: yes; probe: settings)");
    expect(h.lines).toContain(`SWID ok (38 chars)`);
    expect(h.lines).toContain(`espn_s2 ok (${String(h.c.espn_s2.length)} chars)`);
    h.assertClean();
  });
  it("a re-run replaces the row (setup_rerun → stored → validated) with fresh observations", async () => {
    const repo = new MemoryStateRepo();
    repo.row = stateRow({
      league_id: LEAGUE,
      state: "rejected",
      rejected_since: "2026-09-01T00:00:00.000Z",
      rejected_view: "mTeam",
    });
    const h = harness({ repo });
    const r = await runSetup(h.req({ recordedStore: "keychain" }), h.deps);
    expect(r.state).toBe("validated");
    expect(h.selftests).toEqual([]); // recorded store: no self-test
    expect(repo.row).toMatchObject({
      state: "validated",
      rejected_since: null,
      rejected_view: null,
    });
  });
  it("401 → the value is deleted, the row cleared, exit 3 (plan 10 A2b)", async () => {
    const h = harness({ net: { settings: { status: 401 } } });
    const r = await runSetup(h.req(), h.deps);
    expect(r).toMatchObject({
      exitCode: 3,
      state: "not_configured",
      accepted: false,
      probe: "settings",
    });
    expect(h.keychain.stored).toBeNull();
    expect(h.repo?.row).toBeNull();
    expect(h.lines).toContain(SETUP_TEXT.rejected);
    expect(h.calls).not.toContain("team");
    h.assertClean();
  });
  it("403 is a rejection too", async () => {
    const h = harness({ net: { settings: { status: 403 } } });
    expect((await runSetup(h.req(), h.deps)).exitCode).toBe(3);
  });
  it("404 from mSettings with cookies → league id wrong: deleted, exit 2", async () => {
    const h = harness({ net: { settings: { status: 404 } } });
    const r = await runSetup(h.req(), h.deps);
    expect(r).toMatchObject({ exitCode: 2, state: "not_configured", accepted: null });
    expect(h.keychain.stored).toBeNull();
    expect(h.lines).toContain(SETUP_TEXT.leagueNotFound(2026));
  });
  it("404 from the anonymous read → league id wrong before any cookie is sent", async () => {
    const h = harness({ net: { anon: { status: 404 } } });
    const r = await runSetup(h.req(), h.deps);
    expect(r.exitCode).toBe(2);
    expect(h.calls).toEqual(["anon"]);
    expect(h.keychain.stored).toBeNull();
  });
  it.each([
    ["the anonymous read fails", { anon: { error: "timeout" } }, ["anon"]],
    ["the anonymous read is 500", { anon: { status: 500 } }, ["anon"]],
    ["the cookie probe fails", { settings: { error: "network" } }, ["anon", "settings"]],
    ["the cookie probe is 503", { settings: { status: 503 } }, ["anon", "settings"]],
  ] as const)(
    "%s → the value is KEPT (state stored), exit 1, no team request",
    async (_n, net, calls) => {
      const h = harness({ net });
      const r = await runSetup(h.req(), h.deps);
      expect(r).toMatchObject({ exitCode: 1, state: "stored", store: "keychain", accepted: null });
      expect(h.keychain.stored).not.toBeNull();
      expect(h.repo?.row?.state).toBe("stored");
      expect(h.calls).toEqual(calls);
      expect(h.lines.some((l) => l.startsWith("The ESPN check could not complete"))).toBe(true);
    },
  );
  it("a hostile network error code is never echoed", async () => {
    const h = harness({ net: { anon: { error: "\u001b]0;pwned\u0007\nfake line" } } });
    await runSetup(h.req(), h.deps);
    expect(h.lines.join("\n")).not.toContain("pwned");
    expect(h.lines).toContain(SETUP_TEXT.checkIncomplete("error"));
  });
});

describe("the public-league path (plan 02 §2.1; ADV OBJ-14, OBJ-26)", () => {
  it("anonymous control 401 → the board probe discriminates; 200 with cookies → validated", async () => {
    const h = harness({
      net: { anon: { status: 200 }, anonBoard: { status: 401 }, board: { status: 200 } },
    });
    const r = await runSetup(h.req(), h.deps);
    expect(r).toMatchObject({ exitCode: 0, state: "validated", accepted: true, probe: "board" });
    expect(h.calls).toEqual(["anon", "anonBoard", "board", "team"]);
    expect(h.repo?.row).toMatchObject({ state: "validated", board_probe_discriminates: true });
    expect(h.lines.join("\n")).toContain("private: no; probe: board");
  });
  it("the board's 404 with cookies (no board) is an acceptance", async () => {
    const h = harness({
      net: { anon: { status: 200 }, anonBoard: { status: 401 }, board: { status: 404 } },
    });
    expect((await runSetup(h.req(), h.deps)).accepted).toBe(true);
  });
  it("the board's 401 with cookies → rejected, deleted, exit 3", async () => {
    const h = harness({
      net: { anon: { status: 200 }, anonBoard: { status: 401 }, board: { status: 401 } },
    });
    const r = await runSetup(h.req(), h.deps);
    expect(r).toMatchObject({ exitCode: 3, probe: "board" });
    expect(h.keychain.stored).toBeNull();
  });
  it("anonymous control non-401 → cannot test here: kept as stored, accepted null, team still resolved", async () => {
    const h = harness({ net: { anon: { status: 200 }, anonBoard: { status: 404 } } });
    const r = await runSetup(h.req(), h.deps);
    expect(r).toMatchObject({
      exitCode: 0,
      state: "stored",
      accepted: null,
      probe: "board",
      teamId: 3,
    });
    expect(h.calls).toEqual(["anon", "anonBoard", "team"]);
    expect(h.repo?.row).toMatchObject({
      state: "stored",
      board_probe_discriminates: false,
      last_accepted_at: null,
    });
    expect(h.lines).toContain(SETUP_TEXT.notDiscriminating);
  });
  it.each([
    ["the control fails", { anon: { status: 200 }, anonBoard: { error: "timeout" } }],
    [
      "the cookie board probe fails",
      { anon: { status: 200 }, anonBoard: { status: 401 }, board: { error: "network" } },
    ],
    [
      "the cookie board probe is 500",
      { anon: { status: 200 }, anonBoard: { status: 401 }, board: { status: 500 } },
    ],
  ] as const)("%s → kept, exit 1", async (_n, net) => {
    const h = harness({ net });
    const r = await runSetup(h.req(), h.deps);
    expect(r).toMatchObject({ exitCode: 1, state: "stored", probe: "board" });
    expect(h.keychain.stored).not.toBeNull();
  });
  it("a store.sqlite hiccup while recording the control does not stop the probe", async () => {
    const repo = new MemoryStateRepo();
    let n = 0;
    repo.beforeTransition = () => {
      if (++n === 2) throw new Error("SQLITE_BUSY");
    };
    const h = harness({
      repo,
      net: { anon: { status: 200 }, anonBoard: { status: 401 }, board: { status: 200 } },
    });
    const r = await runSetup(h.req(), h.deps);
    expect(r.accepted).toBe(true);
  });
});

describe("format validation at the prompt (plan 02 §2.1; ADV OBJ-15)", () => {
  it("a wrong SWID and a 39-char espn_s2 are explained and re-asked; a 66-char one warns and proceeds", async () => {
    const c = fakeCookies("setup-short", 60);
    const h = harness({
      cookies: c,
      answers: [
        { kind: "answer", value: c.swid.slice(1, -1) },
        { kind: "answer", value: `  ${c.swid}\n` },
        { kind: "answer", value: c.espn_s2.slice(0, 39) },
        { kind: "answer", value: c.espn_s2 },
      ],
    });
    const r = await runSetup(h.req(), h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.lines).toContain("SWID must keep its braces: {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.");
    expect(h.lines.some((l) => l.startsWith("espn_s2 is shorter than 40 characters"))).toBe(true);
    expect(h.lines.some((l) => l.startsWith("espn_s2 is shorter than expected"))).toBe(true);
    expect(h.keychain.stored?.cookies).toEqual(c);
    h.assertClean();
  });
  it(`${String(SETUP_MAX_ATTEMPTS)} invalid answers → exit 2; nothing stored, no self-test, no config, no request`, async () => {
    const h = harness({
      answers: [
        { kind: "answer", value: "x" },
        { kind: "answer", value: "y" },
        { kind: "answer", value: "z" },
      ],
    });
    const r = await runSetup(h.req(), h.deps);
    expect(r.exitCode).toBe(2);
    expect(h.lines).toContain(SETUP_TEXT.tooManyAttempts);
    expect(
      h.keychain.writes + h.file.writes + h.selftests.length + h.patches.length + h.calls.length,
    ).toBe(0);
  });
  it.each([
    ["a timeout on SWID", [{ kind: "timeout" }], SETUP_TEXT.timeout],
    ["a closed stdin on SWID", [{ kind: "closed" }], SETUP_TEXT.closed],
  ] as const)("%s → exit 1, nothing stored (step 8)", async (_n, answers, text) => {
    const h = harness({ answers: [...answers] });
    const r = await runSetup(h.req(), h.deps);
    expect(r.exitCode).toBe(1);
    expect(h.lines).toContain(text);
    expect(h.keychain.writes + h.file.writes).toBe(0);
  });
  it("a timeout on espn_s2 (after a valid SWID) → exit 1, nothing stored", async () => {
    const c = fakeCookies("setup-timeout");
    const h = harness({ answers: [{ kind: "answer", value: c.swid }, { kind: "timeout" }] });
    expect((await runSetup(h.req(), h.deps)).exitCode).toBe(1);
    expect(h.keychain.writes).toBe(0);
  });
});

describe("one store per install (plan 02 §2.2; plan 03 §2.1 step 4; ADV OBJ-05, OBJ-25)", () => {
  it.each(["timeout", "error"] as const)(
    "fresh install, self-test %s → the file store for the whole install",
    async (outcome) => {
      const h = harness({
        selftest: { outcome, reason: outcome === "timeout" ? "read_timeout" : "missing" },
      });
      const r = await runSetup(h.req(), h.deps);
      expect(r).toMatchObject({ exitCode: 0, store: "file", selftest: outcome });
      expect(h.file.stored?.cookies).toEqual(h.c);
      expect(h.keychain.deletes).toBe(1);
      expect(h.keychain.stored).toBeNull();
      expect(h.patches[0]).toEqual({
        keychain_selftest_outcome: outcome,
        keychain_selftest_at: NOW,
        EFF_CREDENTIAL_STORE: "file",
        EFF_CREDENTIAL_FILE: "/nonexistent/eff-config/session.json",
      });
      expect(
        h.lines.some((l) => l.includes("Using the 0600 file store for this whole install")),
      ).toBe(true);
    },
  );
  it("--storage keychain runs the self-test and is refused unless ok (nothing stored, store unchanged)", async () => {
    const h = harness({ selftest: { outcome: "timeout", reason: "read_timeout" } });
    const r = await runSetup(h.req({ storage: "keychain" }), h.deps);
    expect(r).toMatchObject({ exitCode: 1, store: null, selftest: "timeout" });
    expect(h.keychain.writes + h.file.writes + h.keychain.deletes + h.file.deletes).toBe(0);
    expect(h.patches).toEqual([
      { keychain_selftest_outcome: "timeout", keychain_selftest_at: NOW },
    ]);
    expect(h.lines.some((l) => l.includes("--storage keychain refused"))).toBe(true);
  });
  it("--storage keychain with ok → keychain; the file copy is deleted first", async () => {
    const h = harness();
    const r = await runSetup(h.req({ storage: "keychain", recordedStore: "file" }), h.deps);
    expect(r.store).toBe("keychain");
    expect(h.file.deletes).toBe(1);
  });
  it("--storage file → no self-test; the keychain copy is deleted first", async () => {
    const h = harness();
    const r = await runSetup(h.req({ storage: "file" }), h.deps);
    expect(r).toMatchObject({ store: "file", selftest: null });
    expect(h.selftests).toEqual([]);
    expect(h.keychain.deletes).toBe(1);
    expect(h.patches[0]).toEqual({
      EFF_CREDENTIAL_STORE: "file",
      EFF_CREDENTIAL_FILE: "/nonexistent/eff-config/session.json",
    });
  });
  it("a recorded store is used as is (no self-test)", async () => {
    const h = harness();
    expect((await runSetup(h.req({ recordedStore: "file" }), h.deps)).store).toBe("file");
    expect(h.selftests).toEqual([]);
  });
  it("an unreachable keychain (no addon) does not block the file store", async () => {
    const h = harness();
    h.keychain.failDelete = new CredentialStoreError("keychain", "unavailable");
    expect((await runSetup(h.req({ storage: "file" }), h.deps)).exitCode).toBe(0);
  });
  it("a copy in the other store that cannot be removed → refuse to store (never two stores)", async () => {
    const h = harness();
    h.keychain.failDelete = new CredentialStoreError("keychain", "timeout");
    const r = await runSetup(h.req({ storage: "file" }), h.deps);
    expect(r.exitCode).toBe(1);
    expect(h.file.writes).toBe(0);
    expect(h.lines).toContain(SETUP_TEXT.otherStoreFailed("keychain"));
  });
  it("a self-test that could not delete its throwaway item says so", async () => {
    const h = harness({ selftest: { cleanup: "failed" } });
    await runSetup(h.req(), h.deps);
    expect(h.lines).toContain(SETUP_TEXT.selftestCleanupFailed);
  });
  it("selftestLine names the agent code on read_failed", () => {
    expect(
      selftestLine(
        { outcome: "error", reason: "read_failed", code: "launchctl", at: NOW, cleanup: "deleted" },
        false,
      ),
    ).toContain("read_failed: launchctl");
    expect(
      selftestLine({ outcome: "ok", reason: "ok", code: null, at: NOW, cleanup: "deleted" }, false),
    ).toContain("ok");
  });
});

describe("failures after the prompts leave nothing partial (plan 03 §2.1 step 8)", () => {
  it("config.json cannot be written → exit 1, nothing stored", async () => {
    const h = harness({ configFails: () => true });
    const r = await runSetup(h.req(), h.deps);
    expect(r.exitCode).toBe(1);
    expect(h.keychain.writes + h.file.writes).toBe(0);
    expect(h.lines).toContain(SETUP_TEXT.configFailed);
  });
  it("the store write fails → the store is emptied, exit 1", async () => {
    const h = harness();
    h.keychain.failWrite = new CredentialStoreError("keychain", "write_failed");
    const r = await runSetup(h.req(), h.deps);
    expect(r.exitCode).toBe(1);
    expect(h.keychain.deletes).toBe(1);
    expect(h.calls).toEqual([]);
  });
  it("an unsafe file location (iCloud, repo) → exit 2 with the reason", async () => {
    const h = harness();
    h.file.failWrite = new CredentialStoreError("file", "insecure_location", "file_provider");
    const r = await runSetup(h.req({ storage: "file" }), h.deps);
    expect(r.exitCode).toBe(2);
    expect(h.lines.some((l) => l.includes("file_provider"))).toBe(true);
  });
  it("an untyped store failure still reads as a fixed sentence", async () => {
    const h = harness();
    h.keychain.failWrite = new Error("raw native text");
    await runSetup(h.req(), h.deps);
    expect(h.lines.join("\n")).not.toContain("raw native text");
  });
  it("store.sqlite cannot record the row → the value is deleted, exit 1", async () => {
    const repo = new MemoryStateRepo();
    repo.failWrite = true;
    const h = harness({ repo });
    const r = await runSetup(h.req(), h.deps);
    expect(r.exitCode).toBe(1);
    expect(h.keychain.stored).toBeNull();
    expect(h.lines).toContain(SETUP_TEXT.rowFailed);
  });
  it("a failure clearing the row after a 401 is contained (the value is gone regardless)", async () => {
    const repo = new MemoryStateRepo();
    const h = harness({ repo, net: { settings: { status: 401 } } });
    const realClear = repo.clear.bind(repo);
    repo.clear = () => {
      realClear();
      throw new Error("SQLITE_BUSY");
    };
    expect((await runSetup(h.req(), h.deps)).exitCode).toBe(3);
    expect(h.keychain.stored).toBeNull();
  });
  it("a failure deleting after a 401 is contained too", async () => {
    const h = harness({ net: { settings: { status: 401 } } });
    h.keychain.failDelete = new Error("locked");
    expect((await runSetup(h.req(), h.deps)).exitCode).toBe(3);
  });
  it("a failure recording the acceptance is contained (re-observed by the first call)", async () => {
    const repo = new MemoryStateRepo();
    let n = 0;
    repo.beforeTransition = () => {
      if (++n === 2) throw new Error("SQLITE_BUSY");
    };
    const h = harness({ repo });
    const r = await runSetup(h.req(), h.deps);
    expect(r).toMatchObject({ exitCode: 0, accepted: true });
    expect(repo.row?.state).toBe("stored");
  });
});

describe("team resolution (plan 03 §2.1 step 6; the Own team gate)", () => {
  const resolved: [TeamResolution, SetupConfigPatch, string, number | null][] = [
    [{ kind: "none" }, { ESPN_TEAM_ID: null }, SETUP_TEXT.teamNone, null],
    [{ kind: "many", count: 2 }, { ESPN_TEAM_ID: null }, SETUP_TEXT.teamMany(2), null],
    [{ kind: "one", teamId: 12 }, { ESPN_TEAM_ID: "12" }, SETUP_TEXT.teamOne(12), 12],
  ];
  it.each(resolved)("%j", async (team, patch, line, teamId) => {
    const h = harness({ net: { team } });
    const r = await runSetup(h.req({ recordedStore: "keychain" }), h.deps);
    expect(r.teamId).toBe(teamId);
    expect(h.patches.at(-1)).toEqual(patch);
    expect(h.lines).toContain(line);
  });
  const unresolved: [TeamResolution, string][] = [
    [{ kind: "error", code: "timeout" }, "timeout"],
    [{ kind: "one", teamId: 0 }, "invalid_team_id"],
    [{ kind: "one", teamId: 1e9 }, "invalid_team_id"],
  ];
  it.each(unresolved)("%j → config unchanged, exit 0", async (team, code) => {
    const h = harness({ net: { team } });
    const r = await runSetup(h.req({ recordedStore: "keychain" }), h.deps);
    expect(r).toMatchObject({ exitCode: 0, teamId: null });
    expect(h.patches).toEqual([{ EFF_CREDENTIAL_STORE: "keychain" }]);
    expect(h.lines).toContain(SETUP_TEXT.teamError(code));
  });
  it("config.json refusing ESPN_TEAM_ID → exit 1, the cookies stay", async () => {
    const h = harness({ configFails: (p) => "ESPN_TEAM_ID" in p });
    const r = await runSetup(h.req({ recordedStore: "keychain" }), h.deps);
    expect(r).toMatchObject({ exitCode: 1, state: "validated", teamId: null });
    expect(h.keychain.stored).not.toBeNull();
    expect(h.lines).toContain(SETUP_TEXT.teamConfigFailed);
  });
});

describe("--service-name (test-only; changelog V8; plan 05 §4.2)", () => {
  it("eff-test-…: self-test on <name>, the value stored under it, NO request, NO config, NO row, file untouched", async () => {
    const repo = new MemoryStateRepo();
    const h = harness({ service: "eff-test-unit", repo });
    const r = await runSetup(h.req({ serviceName: "eff-test-unit", storage: "keychain" }), h.deps);
    expect(r).toEqual({
      exitCode: 0,
      state: "stored",
      store: "keychain",
      accepted: null,
      probe: "skipped",
      teamId: null,
      selftest: "ok",
    });
    expect(h.selftests).toEqual(["eff-test-unit"]);
    expect(h.calls).toEqual([]);
    expect(h.patches).toEqual([]);
    expect(repo.writes).toBe(0);
    expect(h.file.deletes + h.file.writes).toBe(0);
    expect(h.keychain.stored?.cookies).toEqual(h.c);
    expect(h.lines).toContain(SETUP_TEXT.testModeSkipped);
    h.assertClean();
  });
  it("test mode works without store.sqlite (credentialState null)", async () => {
    const h = harness({ service: "eff-test-unit", repo: null });
    expect((await runSetup(h.req({ serviceName: "eff-test-unit" }), h.deps)).exitCode).toBe(0);
  });
  it("test mode refuses the keychain when the self-test is not ok", async () => {
    const h = harness({
      service: "eff-test-unit",
      selftest: { outcome: "error", reason: "missing" },
    });
    const r = await runSetup(h.req({ serviceName: "eff-test-unit" }), h.deps);
    expect(r.exitCode).toBe(1);
    expect(h.keychain.writes).toBe(0);
    expect(h.patches).toEqual([]);
  });
  it.each([
    "eff-test-",
    "espn-fantasy-football-mcp",
    "other",
    "eff-test-a b",
    `eff-test-${"x".repeat(80)}`,
  ])("%j is refused (exit 2) before any prompt", async (name) => {
    const h = harness();
    const r = await runSetup(h.req({ serviceName: name }), h.deps);
    expect(r.exitCode).toBe(2);
    expect(h.asked).toEqual([]);
    expect(h.lines).toContain(SETUP_TEXT.badServiceName);
  });
  it("--service-name with --storage file is refused", async () => {
    const h = harness({ service: "eff-test-unit" });
    expect(
      (await runSetup(h.req({ serviceName: "eff-test-unit", storage: "file" }), h.deps)).exitCode,
    ).toBe(2);
  });
  it("the keychain store must use the requested service (the real item is never used by a test run)", async () => {
    const h = harness(); // real service
    const r = await runSetup(h.req({ serviceName: "eff-test-unit" }), h.deps);
    expect(r.exitCode).toBe(1);
    expect(h.lines).toContain(SETUP_TEXT.storeMismatch);
    expect(h.asked).toEqual([]);
  });
  it("a normal run needs store.sqlite", async () => {
    const h = harness({ repo: null });
    expect((await runSetup(h.req(), h.deps)).exitCode).toBe(1);
    expect(h.lines).toContain(SETUP_TEXT.noStateRepo);
  });
});

describe("--reset (plan 03 §2.1)", () => {
  it("deletes both stores and clears the observations", async () => {
    const repo = new MemoryStateRepo();
    repo.row = stateRow({ state: "validated", last_accepted_at: NOW });
    const h = harness({ repo });
    h.keychain.set(h.c, NOW);
    h.file.set(h.c, NOW);
    const r = await runSetup(h.req({ reset: true }), h.deps);
    expect(r).toMatchObject({ exitCode: 0, state: "not_configured" });
    expect(h.keychain.stored).toBeNull();
    expect(h.file.stored).toBeNull();
    expect(repo.row).toBeNull();
    expect(h.asked).toEqual([]);
  });
  it("an unreachable keychain is fine; a failing store or row → exit 1", async () => {
    const h1 = harness();
    h1.keychain.failDelete = new CredentialStoreError("keychain", "unavailable");
    expect((await runSetup(h1.req({ reset: true }), h1.deps)).exitCode).toBe(0);
    const h2 = harness();
    h2.file.failDelete = new CredentialStoreError("file", "delete_failed");
    expect((await runSetup(h2.req({ reset: true }), h2.deps)).exitCode).toBe(1);
    const repo = new MemoryStateRepo();
    repo.failWrite = true;
    const h3 = harness({ repo });
    expect((await runSetup(h3.req({ reset: true }), h3.deps)).exitCode).toBe(1);
  });
  it("in test mode only the test keychain items are deleted", async () => {
    const repo = new MemoryStateRepo();
    repo.row = stateRow();
    const h = harness({ service: "eff-test-unit", repo });
    const r = await runSetup(h.req({ reset: true, serviceName: "eff-test-unit" }), h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.keychain.deletes).toBe(1);
    expect(h.file.deletes).toBe(0);
    expect(repo.row).not.toBeNull();
  });
});
