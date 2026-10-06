// foundation.test.ts — the CLI's plumbing: io (execFile only, closed pipes, the EFF_TEST_STUBS
// switch), runtime (redaction of the configured ids, ConfigError reporting without values),
// config-file (plan 03 §3: no secrets in config.json; atomic 0600; known keys only), job-state
// (numbers and tokens only, fail-open), and the store-access classifiers.
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid, fakeLeagueId } from "../../scripts/ci/secret-fixtures.mjs";
import {
  ConfigWriteError,
  WRITABLE_CONFIG_KEYS,
  mergeConfigPatch,
  patchConfigFile,
} from "../../src/cli/config-file.js";
import {
  defaultExec,
  defaultIo,
  distEntry,
  isTty,
  testStubsRequested,
  tolerateClosedPipe,
  write,
  writeLine,
} from "../../src/cli/io.js";
import {
  JOB_STATE_FILE,
  readJobState,
  stateNumber,
  stateToken,
  updateJobState,
} from "../../src/cli/job-state.js";
import {
  bootLevel,
  loadLenientRuntime,
  loadRuntime,
  makeLogger,
  registerConfigRedaction,
} from "../../src/cli/runtime.js";
import {
  errorText,
  newerStoreMessage,
  openExistingStore,
  storeOpenReason,
} from "../../src/cli/store-access.js";
import { ConfigError } from "../../src/config/schema.js";
import { Capture, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

describe("io", () => {
  it("defaultExec runs a program with an argument array and never rejects", async () => {
    sb = sandbox();
    const ok = await defaultExec(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(ok).toEqual({ code: 0, stdout: "hi", stderr: "" });
    const bad = await defaultExec(process.execPath, ["-e", "process.exit(3)"]);
    expect(bad.code).toBe(3);
    const missing = await defaultExec(path.join(sb.dir, "no-such-binary"), []);
    expect(missing.code).toBeNull();
    // a shell metacharacter is an argument, never interpreted
    const literal = await defaultExec(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      "; echo pwned",
    ]);
    expect(literal.stdout).toBe("; echo pwned");
  });
  it("EFF_TEST_STUBS is read as 1/true only; defaultIo carries the real process io", () => {
    sb = sandbox();
    expect(testStubsRequested({ EFF_TEST_STUBS: "1" })).toBe(true);
    expect(testStubsRequested({ EFF_TEST_STUBS: " true " })).toBe(true);
    expect(testStubsRequested({ EFF_TEST_STUBS: "0" })).toBe(false);
    expect(testStubsRequested({})).toBe(false);
    const io = defaultIo();
    expect(io.stdout).toBe(process.stdout);
    expect(path.isAbsolute(io.packageRoot)).toBe(true);
    expect(distEntry("/a/b")).toBe("/a/b/dist/cli.js");
  });
  it("write resolves on a destroyed stream; tolerateClosedPipe swallows EPIPE only", async () => {
    sb = sandbox();
    const dead = new PassThrough();
    dead.destroy();
    await write(dead, "x");
    const c = new Capture();
    await writeLine(c, "line");
    expect(c.text).toBe("line\n");
    const s = new PassThrough();
    tolerateClosedPipe(s);
    tolerateClosedPipe(s);
    expect(() => s.emit("error", Object.assign(new Error("x"), { code: "EPIPE" }))).not.toThrow();
    expect(() => s.emit("error", Object.assign(new Error("boom"), { code: "EACCES" }))).toThrow(
      "boom",
    );
    const throwing = new Writable({
      write: () => {
        throw new Error("sync");
      },
    });
    throwing.write = () => {
      throw new Error("sync");
    };
    await write(throwing, "x");
    expect(isTty(new PassThrough())).toBe(false);
  });
});

describe("runtime", () => {
  it("registers the configured league ids so a log line never carries them", async () => {
    sb = sandbox();
    const league = fakeLeagueId("cli-runtime", 9);
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: league, EFF_LOG_LEVEL: "debug" } });
    const { log } = await loadRuntime(io);
    log.info("x", { note: `league ${league} here`, leagueId: Number(league) });
    expect(io.err.text).not.toContain(league);
    expect(io.err.text).toContain("[league]");
  });
  it("lenient mode needs no league id; strict mode reports the key only and rethrows", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    const { config } = await loadLenientRuntime(io);
    expect(config.leagueId).toBeNull();
    await expect(loadRuntime(io)).rejects.toBeInstanceOf(ConfigError);
    expect(io.err.text).toContain("eff: config: ESPN_LEAGUE_ID");
  });
  it("bootLevel falls back to warn; a config warning is logged without values", async () => {
    sb = sandbox();
    expect(bootLevel({ EFF_LOG_LEVEL: "debug" })).toBe("debug");
    expect(bootLevel({ EFF_LOG_LEVEL: "loud" })).toBe("warn");
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", EFF_TYPO_KEY: "x" } });
    await loadRuntime(io);
    expect(io.err.text).toContain("config.warning");
    const log = makeLogger(io, "error");
    registerConfigRedaction(log, (await loadLenientRuntime(makeIo(sb))).config);
  });
});

describe("config-file", () => {
  it("merges known keys, removes nulls, refuses unknown keys and control characters", () => {
    sb = sandbox();
    expect(mergeConfigPatch({ a: "keep" }, { ESPN_TEAM_ID: "3" })).toEqual({
      a: "keep",
      ESPN_TEAM_ID: "3",
    });
    expect(mergeConfigPatch({ ESPN_TEAM_ID: "3" }, { ESPN_TEAM_ID: null })).toEqual({});
    expect(() => mergeConfigPatch({}, { NOT_A_KEY: "x" })).toThrow(ConfigWriteError);
    expect(() => mergeConfigPatch({}, { ESPN_TEAM_ID: "3\n4" })).toThrow(ConfigWriteError);
    expect(() => mergeConfigPatch({}, { ESPN_TEAM_ID: "x".repeat(5000) })).toThrow(
      ConfigWriteError,
    );
    expect(WRITABLE_CONFIG_KEYS).toContain("seeding_confirmed_at");
    expect(WRITABLE_CONFIG_KEYS).not.toContain("ODDS_API_KEY");
  });
  it("never writes a credential-shaped value (an espn_s2 run or a member GUID)", () => {
    sb = sandbox();
    expect(() => mergeConfigPatch({}, { EFF_PROBE_LEAGUE_ID: fakeEspnS2("cfg", 200) })).toThrow(
      /credential-shaped/,
    );
    expect(() => mergeConfigPatch({}, { ESPN_TEAM_ID: `{${fakeGuid("cfg")}}` })).toThrow(
      /credential-shaped/,
    );
  });
  it("writes config.json 0600 in a created 0700 dir, atomically, sorted, merging the existing file", () => {
    sb = sandbox();
    const t = { configDir: sb.configDir, home: sb.home, repoRoot: sb.dir + "/nowhere" };
    patchConfigFile(t, { ESPN_TEAM_ID: "7" });
    const out = patchConfigFile(t, { EFF_CREDENTIAL_STORE: "file", ESPN_TEAM_ID: null });
    expect(out).toEqual({ EFF_CREDENTIAL_STORE: "file" });
    const file = path.join(sb.configDir, "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(sb.configDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ EFF_CREDENTIAL_STORE: "file" });
  });
  it("refuses a config dir inside a repository and an existing non-object or invalid file", () => {
    sb = sandbox();
    mkdirSync(path.join(sb.dir, "repo", ".git"), { recursive: true });
    const inRepo = {
      configDir: path.join(sb.dir, "repo", "cfg"),
      home: sb.home,
      repoRoot: path.join(sb.dir, "x"),
    };
    expect(() => patchConfigFile(inRepo, { ESPN_TEAM_ID: "1" })).toThrow(
      /inside a git working tree/,
    );
    mkdirSync(sb.configDir, { mode: 0o700 });
    const t = { configDir: sb.configDir, home: sb.home, repoRoot: sb.dir + "/nowhere" };
    writeFileSync(path.join(sb.configDir, "config.json"), "[1,2]");
    expect(() => patchConfigFile(t, { ESPN_TEAM_ID: "1" })).toThrow(/not a JSON object/);
    writeFileSync(path.join(sb.configDir, "config.json"), "{nope");
    expect(() => patchConfigFile(t, { ESPN_TEAM_ID: "1" })).toThrow(/not valid JSON/);
  });
});

describe("job-state", () => {
  it("stores numbers and tokens only; drops invalid keys/values; null removes", () => {
    sb = sandbox();
    expect(
      updateJobState(sb.cacheDir, {
        "a.b": 1,
        tok: "x_y",
        "BAD KEY": 2,
        bad: "a b",
        inf: Number.POSITIVE_INFINITY,
      }),
    ).toBe(true);
    const s = readJobState(sb.cacheDir);
    expect(s).toEqual({ "a.b": 1, tok: "x_y" });
    expect(stateNumber(s, "a.b")).toBe(1);
    expect(stateNumber(s, "tok")).toBeNull();
    expect(stateToken(s, "tok")).toBe("x_y");
    expect(stateToken(s, "a.b")).toBeNull();
    updateJobState(sb.cacheDir, { tok: null });
    expect(readJobState(sb.cacheDir)).toEqual({ "a.b": 1 });
    expect(statSync(path.join(sb.cacheDir, JOB_STATE_FILE)).mode & 0o777).toBe(0o600);
  });
  it("a foreign, malformed or symlinked file reads as empty; a write that cannot happen returns false", () => {
    sb = sandbox({ create: true });
    const f = path.join(sb.cacheDir, JOB_STATE_FILE);
    writeFileSync(f, "{oops", { mode: 0o600 });
    expect(readJobState(sb.cacheDir)).toEqual({});
    writeFileSync(f, JSON.stringify([1]), { mode: 0o600 });
    expect(readJobState(sb.cacheDir)).toEqual({});
    writeFileSync(f, "{}", { mode: 0o644 });
    expect(readJobState(sb.cacheDir)).toEqual({});
    writeFileSync(path.join(sb.dir, "plain-file"), "x");
    expect(updateJobState(path.join(sb.dir, "plain-file", "x"), { a: 1 })).toBe(false);
    const other = path.join(sb.dir, "elsewhere.json");
    writeFileSync(other, '{"a":1}', { mode: 0o600 });
    const linkDir = path.join(sb.dir, "linked");
    mkdirSync(linkDir, { mode: 0o700 });
    symlinkSync(other, path.join(linkDir, JOB_STATE_FILE));
    expect(readJobState(linkDir)).toEqual({});
    expect(lstatSync(path.join(linkDir, JOB_STATE_FILE)).isSymbolicLink()).toBe(true);
  });
});

describe("store-access", () => {
  it("classifies sqlite failures; errorText prefers a fixed detail", () => {
    sb = sandbox();
    expect(storeOpenReason({ errcode: 26 })).toBe("not_a_database");
    expect(storeOpenReason({ errcode: 11 })).toBe("corrupt");
    expect(storeOpenReason({ errcode: 8 })).toBe("readonly");
    expect(storeOpenReason({ errcode: 5 })).toBe("busy");
    expect(storeOpenReason({ errcode: 6 })).toBe("busy");
    expect(storeOpenReason({ errcode: 14 })).toBe("cannot_open");
    expect(storeOpenReason({ errcode: 99 })).toBe("other");
    expect(storeOpenReason(new TypeError("db.x is not a function"))).toBe("unsupported_node");
    expect(storeOpenReason(null)).toBe("other");
    expect(errorText(Object.assign(new Error("long"), { detail: "fixed" }))).toBe("Error: fixed");
    expect(errorText(new RangeError("r"))).toBe("RangeError: r");
    expect(errorText("x")).toBe("unknown error");
    expect(newerStoreMessage(7, 5)).toContain("newer version (v7)");
  });
  it("openExistingStore: missing, and a file that is not a database", async () => {
    sb = sandbox({ create: true });
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config, log } = await loadRuntime(io);
    expect(openExistingStore(config, io.clock, log).kind).toBe("missing");
    writeFileSync(path.join(sb.cacheDir, "store.sqlite"), "not sqlite at all".repeat(100), {
      mode: 0o600,
    });
    const ex = openExistingStore(config, io.clock, log);
    expect(ex.kind).toBe("error");
  });
});
