// main.test.ts — the `eff` dispatcher (plan 03 §1.1 step 1 parseArgs, exit 2 on usage/config; §1.3
// exit codes; plan 01 §2: `serve` gets the raw streams and nothing else writes stdout). Adversarial:
// unknown commands and flags, pasted values as commands (never echoed), missing positionals.
import { afterEach, describe, expect, it } from "vitest";
import { fakeEspnS2 } from "../../scripts/ci/secret-fixtures.mjs";
import { COMMANDS, USAGE, main, parseCommand, type ServeFn } from "../../src/cli/main.js";
import { UsageError, worstExit } from "../../src/cli/exit.js";
import { VERSION } from "../../src/version.js";
import { makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

describe("parseCommand", () => {
  it("accepts every documented command's flags and refuses unknown ones (UsageError)", () => {
    sb = sandbox();
    expect(parseCommand("status", ["--json"]).values.json).toBe(true);
    expect(parseCommand("refresh", ["all", "--force"]).positionals).toEqual(["all"]);
    expect(() => parseCommand("status", ["--bogus"])).toThrow(UsageError);
    expect(() => parseCommand("refresh", ["a", "b"])).toThrow(/unexpected argument/);
    expect(() => parseCommand("print-config", ["--client"])).toThrow(/missing its value/);
    expect(() => parseCommand("nope", [])).toThrow(/unknown command 'nope'/);
  });
  it("never echoes a value-shaped command or flag (a pasted cookie in argv stays private)", () => {
    sb = sandbox();
    const s2 = fakeEspnS2("main-argv", 200);
    let msg = "";
    try {
      parseCommand(s2, []);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe("unknown command");
    try {
      parseCommand("status", [`--${s2}`]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(s2.slice(0, 20));
  });
  it("lists every command (the internal selftest-read included) and a usage text naming the exit codes", () => {
    sb = sandbox();
    expect(COMMANDS).toContain("selftest-read");
    expect(USAGE).toMatch(/3 credentials · 4 drift/);
    for (const c of COMMANDS.filter((x) => x !== "serve" && x !== "selftest-read"))
      expect(USAGE).toContain(c);
  });
  it("worstExit is the numeric maximum", () => {
    sb = sandbox();
    expect(worstExit([])).toBe(0);
    expect(worstExit([1, 4, 2, Number.NaN])).toBe(4);
  });
});

describe("main", () => {
  it("version: one line on stdout; --json carries node and the exec path", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(await main(["version"], io)).toBe(0);
    expect(io.out.text).toBe(`eff ${VERSION} (node 24.21.0)\n`);
    const io2 = makeIo(sb);
    expect(await main(["--version", "--json"], io2)).toBe(0);
    expect(JSON.parse(io2.out.text)).toEqual({
      version: VERSION,
      node: "24.21.0",
      exec_path: process.execPath,
    });
  });
  it("help and no command", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(await main(["-h"], io)).toBe(0);
    expect(io.out.text).toContain("usage: eff");
    const io2 = makeIo(sb);
    expect(await main([], io2)).toBe(2);
    expect(io2.out.text).toBe("");
    expect(io2.err.text).toContain("usage: eff");
  });
  it("usage errors exit 2 with one stderr line and nothing on stdout", async () => {
    sb = sandbox();
    for (const argv of [
      ["nope"],
      ["status", "--bogus"],
      ["refresh"],
      ["snapshot"],
      ["crosswalk", "x"],
      ["doctor", "--ack", "nope"],
    ]) {
      const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
      expect(await main(argv, io), argv.join(" ")).toBe(2);
      expect(io.out.text, argv.join(" ")).toBe("");
      expect(io.err.text).toMatch(/^eff: .*\(run `eff help`\)\n$/);
    }
  });
  it("a configuration error exits 2 naming the key, never the value", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "not-a-number-xyz" } });
    expect(await main(["status"], io)).toBe(2);
    expect(io.err.text).toContain("ESPN_LEAGUE_ID");
    expect(io.err.text).not.toContain("not-a-number-xyz");
  });
  it("commands that need a league refuse without ESPN_LEAGUE_ID (exit 2)", async () => {
    sb = sandbox();
    for (const c of [
      ["check-auth"],
      ["credential-check"],
      ["pre-kickoff"],
      ["transactions"],
      ["snapshot", "pool"],
    ]) {
      const io = makeIo(sb);
      expect(await main(c, io), c.join(" ")).toBe(2);
      expect(io.err.text).toContain("ESPN_LEAGUE_ID");
    }
  });
  it("serve is delegated untouched: argv rest, env and the raw streams; its code is returned", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    let seen: Parameters<ServeFn>[0] | null = null;
    const code = await main(["serve", "--x"], io, {
      loadServe: () =>
        Promise.resolve((opts) => {
          seen = opts;
          return Promise.resolve(5);
        }),
    });
    expect(code).toBe(5);
    expect(seen).not.toBeNull();
    const s = seen as unknown as Parameters<ServeFn>[0];
    expect(s.argv).toEqual(["--x"]);
    expect(s.stdout).toBe(io.stdout);
    expect(s.stdin).toBe(io.stdin);
    expect(io.out.text).toBe("");
  });
  it("serve without a server module exits 1 with a stderr line (stdout stays empty)", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(await main(["serve"], io, { loadServe: () => Promise.resolve(null) })).toBe(1);
    expect(io.out.text).toBe("");
    expect(io.err.text).toContain("not present");
  });
  it("an unexpected error is exit 1 with the error name only", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    // a non-absolute packageRoot makes print-config's launch spec throw a plain Error
    const broken = { ...io, packageRoot: "relative/root", execPath: "node" };
    expect(await main(["print-config", "--client", "desktop"], broken)).toBe(1);
    expect(io.err.text).toMatch(/unexpected error: Error/);
  });
  it("relative --client-log is a usage error", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(await main(["doctor", "--client-log", "logs/x.log"], io)).toBe(2);
    expect(io.err.text).toContain("--client-log must be an absolute path");
  });
});
