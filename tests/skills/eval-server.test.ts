// eval-server.test.ts — scripts/skills/eval-server.mjs, the launcher every Lane 2 eval server starts
// through (plan 09 §5.2; plan 10 B15; Stage C finding eval-recorded-state-preconditions-missing):
// each start runs `dist/cli.js serve` on a FRESH COPY of the plugin's pristine state (every mode
// kept — the server refuses group/other bits), outside every git tree, and removes the copy when the
// server exits, so no run of a case can change what another run starts from. Adversarial: a state
// inside a git tree, a symlink in the state, a missing dist/, a server that cannot start, a signal.
// The real-process test runs a stand-in `dist/cli.js` (never the server), so nothing touches ESPN.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPY_PREFIX,
  ENV_KEY_RE,
  NO_SOCKET,
  SERVER_ENV_RE,
  STATE_DIRS,
  USAGE_EXIT,
  copyTree,
  exitCodeOf,
  freshCopy,
  main,
  parseArgs,
  serverEnvFor,
  stateProblem,
} from "../../scripts/skills/eval-server.mjs";
import { ROOT } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const temp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => {
    rmSync(d, { recursive: true, force: true });
  });
  return d;
};
/** A pristine state as the build writes it: three 0700 directories, a 0600 store file in cache/. */
const pristine = (): string => {
  const s = path.join(temp("eff-es-state-"), "base--core");
  for (const d of Object.keys(STATE_DIRS))
    mkdirSync(path.join(s, d), { recursive: true, mode: 0o700 });
  chmodSync(s, 0o700);
  mkdirSync(path.join(s, "cache", "datasets"), { mode: 0o700 });
  writeFileSync(path.join(s, "cache", "store.sqlite"), "seeded log", { mode: 0o600 });
  writeFileSync(path.join(s, "cache", "datasets", "x.parquet"), "rows", { mode: 0o600 });
  return s;
};
/** A repository stand-in with a dist/cli.js (contents chosen per test). */
const repo = (cli = "// stand-in\n"): string => {
  const r = temp("eff-es-root-");
  mkdirSync(path.join(r, "dist"));
  writeFileSync(path.join(r, "dist", "cli.js"), cli);
  return r;
};
const mode = (p: string) => statSync(p).mode & 0o777;
const copiesIn = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(COPY_PREFIX));

/** A fake child: records the spawn, exits when told. */
function fakeSpawn() {
  const ev = new EventEmitter();
  const st = {
    spawned: [] as { cmd: string; args: string[]; env: Record<string, string>; stdio: string }[],
    killed: [] as (string | undefined)[],
    exit: (code: number | null, signal: NodeJS.Signals | null = null) =>
      ev.emit("exit", code, signal),
    fail: (e: Error) => ev.emit("error", e),
    spawnImpl: (
      cmd: string,
      args: string[],
      o: { env: Record<string, string>; stdio: "inherit" },
    ) => {
      st.spawned.push({ cmd, args, env: o.env, stdio: o.stdio });
      return {
        on: (e: string, fn: (...a: never[]) => void) => ev.on(e, fn as (...a: unknown[]) => void),
        kill: (sig?: NodeJS.Signals) => {
          st.killed.push(sig);
        },
      };
    },
  };
  return st;
}

/** The keys a plugin's .mcp.json declares, as the build passes them. */
const KEEP = ["EFF_TOOLSET", "ESPN_LEAGUE_ID"];
const KEEP_ARG = ["--keep-env", KEEP.join(",")];

describe("arguments and the pristine state", () => {
  it("parses --state, --root and --keep-env, all three, and nothing else", () => {
    const want = { state: "/s", root: "/r", keep: KEEP };
    expect(parseArgs(["--state", "/s", "--root", "/r", ...KEEP_ARG])).toEqual(want);
    expect(parseArgs([...KEEP_ARG, "--root", "/r", "--state", "/s"])).toEqual(want);
    expect(parseArgs(["--state", "/s", ...KEEP_ARG])).toBeNull();
    expect(parseArgs(["--state", "/s", "--root", "/r", "--keep-env"])).toBeNull();
    expect(parseArgs(["--state", "/a", "--state", "/b", "--root", "/r", ...KEEP_ARG])).toBeNull();
    expect(parseArgs(["--state", "/s", "--root", "/r", ...KEEP_ARG, "--frobnicate"])).toBeNull();
    expect(parseArgs(["--state", "/s", "--root", "/r", ...KEEP_ARG, ...KEEP_ARG])).toBeNull();
  });

  // the round-3 verifiers' V-2: without the list the launcher would pass the inherited env on whole
  it("refuses a launch with no key list, or a malformed one", () => {
    expect(parseArgs(["--state", "/s", "--root", "/r"])).toBeNull();
    for (const bad of [
      "",
      "EFF_TOOLSET,",
      ",EFF_TOOLSET",
      "EFF_TOOLSET,,ESPN_LEAGUE_ID",
      "eff_toolset",
      "EFF TOOLSET",
      "EFF_TOOLSET,EFF_TOOLSET",
      "EFF-TOOLSET",
      `E${"X".repeat(64)}`,
    ])
      expect(parseArgs(["--state", "/s", "--root", "/r", "--keep-env", bad]), bad).toBeNull();
    expect(ENV_KEY_RE.test("EFF_TEST_STUBS")).toBe(true);
  });

  it("a state must exist outside every git tree and hold home/, config/ and cache/", () => {
    const s = pristine();
    expect(stateProblem(s)).toBeNull();
    expect(stateProblem(path.join(s, "nope"))).toMatch(/no state directory/);
    rmSync(path.join(s, "config"), { recursive: true });
    expect(stateProblem(s)).toMatch(/no config\/ directory/);
    const git = temp("eff-es-git-");
    mkdirSync(path.join(git, ".git"));
    for (const d of Object.keys(STATE_DIRS)) mkdirSync(path.join(git, "s", d), { recursive: true });
    expect(stateProblem(path.join(git, "s"))).toMatch(/inside a git working tree/);
  });
});

describe("the fresh copy", () => {
  it("copies every entry with its mode, in a new 0700 directory outside every git tree, and leaves the pristine state alone", () => {
    const s = pristine();
    const base = temp("eff-es-tmp-");
    const a = freshCopy(s, base);
    const b = freshCopy(s, base);
    expect(a).not.toBe(b);
    expect(path.basename(a).startsWith(COPY_PREFIX)).toBe(true);
    for (const c of [a, b]) {
      expect(mode(c)).toBe(0o700);
      for (const d of Object.keys(STATE_DIRS)) expect(mode(path.join(c, d))).toBe(0o700);
      expect(mode(path.join(c, "cache", "datasets"))).toBe(0o700);
      expect(mode(path.join(c, "cache", "store.sqlite"))).toBe(0o600);
      expect(readFileSync(path.join(c, "cache", "store.sqlite"), "utf8")).toBe("seeded log");
      expect(readFileSync(path.join(c, "cache", "datasets", "x.parquet"), "utf8")).toBe("rows");
    }
    writeFileSync(path.join(a, "cache", "store.sqlite"), "a run logged a retro");
    expect(readFileSync(path.join(s, "cache", "store.sqlite"), "utf8")).toBe("seeded log");
    expect(readFileSync(path.join(b, "cache", "store.sqlite"), "utf8")).toBe("seeded log");
  });

  it("refuses a symbolic link in the state (never followed) and leaves no half-made copy", () => {
    const s = pristine();
    symlinkSync("/etc/hosts", path.join(s, "cache", "link"));
    const base = temp("eff-es-tmp-");
    expect(() => freshCopy(s, base)).toThrow(/symbolic link/);
    expect(copiesIn(base)).toEqual([]);
    expect(() => {
      copyTree(path.join(s, "cache", "link"), path.join(base, "x"));
    }).toThrow(/symbolic link/);
  });

  it("points the server's state directories at the copy, the declared and the non-ESPN variables kept", () => {
    expect(
      serverEnvFor(
        { PATH: "/bin", EFF_TOOLSET: "core", HOME: "/elsewhere", U: undefined },
        "/c",
        KEEP,
      ),
    ).toEqual({
      PATH: "/bin",
      EFF_TOOLSET: "core",
      HOME: path.join("/c", "home"),
      EFF_CONFIG_DIR: path.join("/c", "config"),
      EFF_CACHE_DIR: path.join("/c", "cache"),
    });
  });

  // V-2: a variable exported in the shell that runs the suite changed the graded fixture state
  // (ESPN_TEAM_ID on owner-mismatch, EFF_SEEDING_MODE on points-only-seeding) or stopped the server
  // (an invalid EFF_WEATHER_SOURCE): every undeclared ESPN_* / EFF_* variable is dropped
  it("drops every inherited ESPN_* and EFF_* variable the plugin does not declare", () => {
    const inherited = {
      PATH: "/bin",
      TMPDIR: "/t",
      EFF_TOOLSET: "core",
      ESPN_LEAGUE_ID: "0",
      ESPN_TEAM_ID: "7",
      EFF_SEEDING_MODE: "espn_rule",
      EFF_WEATHER_SOURCE: "bogus",
      EFF_CREDENTIAL_STORE: "file",
      ESPN_S2: "x",
      EFF_CONFIG_DIR: "/real/config",
    };
    const out = serverEnvFor(inherited, "/c", KEEP);
    expect(Object.keys(out).sort()).toEqual(
      [
        "EFF_CACHE_DIR",
        "EFF_CONFIG_DIR",
        "EFF_TOOLSET",
        "ESPN_LEAGUE_ID",
        "HOME",
        "PATH",
        "TMPDIR",
      ].sort(),
    );
    expect(out.EFF_CONFIG_DIR).toBe(path.join("/c", "config"));
    // owner-mismatch declares no ESPN_TEAM_ID: an inherited one never reaches its server
    expect(serverEnvFor(inherited, "/c", ["EFF_TOOLSET"]).ESPN_TEAM_ID).toBeUndefined();
    // a declared key is kept with whatever value the harness gives it (the .mcp.json value)
    expect(serverEnvFor(inherited, "/c", [...KEEP, "ESPN_TEAM_ID"]).ESPN_TEAM_ID).toBe("7");
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/), fc.string(), { maxKeys: 12 }),
        fc.array(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/), { maxLength: 6 }),
        (env, keep) => {
          const STATE_KEYS: string[] = Object.values(STATE_DIRS);
          const o = serverEnvFor(env, "/c", keep);
          for (const k of Object.keys(o))
            if (!STATE_KEYS.includes(k) && SERVER_ENV_RE.test(k)) expect(keep).toContain(k);
          for (const [k, v] of Object.entries(env))
            if (!SERVER_ENV_RE.test(k) && !STATE_KEYS.includes(k)) expect(o[k]).toBe(v);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("maps an exit to the server's code, or 128 + the signal's number", () => {
    expect(exitCodeOf(0, null)).toBe(0);
    expect(exitCodeOf(98, null)).toBe(98);
    expect(exitCodeOf(null, "SIGTERM")).toBe(143);
    expect(exitCodeOf(null, null)).toBe(1);
  });
});

describe("main (a fake server)", () => {
  it("runs dist/cli.js serve under the no-socket preload on a fresh copy, then removes the copy and returns the server's code", async () => {
    const s = pristine();
    const r = repo();
    const base = temp("eff-es-tmp-");
    const f = fakeSpawn();
    const signals = new Map<string, () => void>();
    const done = main(["--state", s, "--root", r, ...KEEP_ARG], {
      env: { PATH: "/bin", EFF_TOOLSET: "core", ESPN_TEAM_ID: "7", EFF_SEEDING_MODE: "espn_rule" },
      spawnImpl: f.spawnImpl,
      node: "/n",
      tmp: base,
      onSignal: (sig, fn) => signals.set(sig, fn),
    });
    expect(f.spawned).toHaveLength(1);
    const sp = f.spawned[0]!;
    expect(sp.cmd).toBe("/n");
    expect(sp.args).toEqual([
      "--import",
      path.join(r, NO_SOCKET),
      path.join(r, "dist", "cli.js"),
      "serve",
    ]);
    expect(sp.stdio).toBe("inherit");
    const copy = path.dirname(sp.env.EFF_CACHE_DIR!);
    expect(path.dirname(copy)).toBe(base);
    expect(copy).not.toBe(s);
    expect(sp.env).toMatchObject({
      PATH: "/bin",
      EFF_TOOLSET: "core",
      HOME: path.join(copy, "home"),
    });
    // the undeclared variables the shell exported never reach the server
    expect(sp.env.ESPN_TEAM_ID).toBeUndefined();
    expect(sp.env.EFF_SEEDING_MODE).toBeUndefined();
    expect(readFileSync(path.join(copy, "cache", "store.sqlite"), "utf8")).toBe("seeded log");
    // a signal to the launcher reaches the server
    expect([...signals.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    signals.get("SIGTERM")!();
    expect(f.killed).toEqual(["SIGTERM"]);
    f.exit(0);
    expect(await done).toBe(0);
    expect(existsSync(copy)).toBe(false);
    expect(copiesIn(base)).toEqual([]);
    expect(readFileSync(path.join(s, "cache", "store.sqlite"), "utf8")).toBe("seeded log");
  });

  it("passes on the server's failure code and a signal's, and cleans up when the server cannot start", async () => {
    const s = pristine();
    const r = repo();
    const base = temp("eff-es-tmp-");
    const quiet = { stderr: () => undefined, onSignal: () => undefined, tmp: base };
    const a = fakeSpawn();
    const pa = main(["--state", s, "--root", r, ...KEEP_ARG], { ...quiet, spawnImpl: a.spawnImpl });
    a.exit(98);
    expect(await pa).toBe(98);
    const b = fakeSpawn();
    const pb = main(["--state", s, "--root", r, ...KEEP_ARG], { ...quiet, spawnImpl: b.spawnImpl });
    b.exit(null, "SIGKILL");
    expect(await pb).toBe(137);
    const c = fakeSpawn();
    const lines: string[] = [];
    const pc = main(["--state", s, "--root", r, ...KEEP_ARG], {
      ...quiet,
      stderr: (x) => lines.push(x),
      spawnImpl: c.spawnImpl,
    });
    c.fail(new Error("spawn ENOENT"));
    c.exit(null, null); // a late exit after the error changes nothing
    expect(await pc).toBe(1);
    expect(lines.join("")).toMatch(/the server did not start \(spawn ENOENT\)/);
    expect(copiesIn(base)).toEqual([]);
  });

  it("refuses a bad argument, a bad state and a missing dist/ — exit 2, nothing spawned", async () => {
    const f = fakeSpawn();
    const lines: string[] = [];
    const deps = {
      spawnImpl: f.spawnImpl,
      stderr: (x: string) => lines.push(x),
      onSignal: () => undefined,
    };
    expect(await main(["--state"], deps)).toBe(USAGE_EXIT);
    expect(await main(["--state", pristine(), "--root", repo()], deps)).toBe(USAGE_EXIT);
    expect(
      await main(
        ["--state", path.join(tmpdir(), "eff-es-none"), "--root", repo(), ...KEEP_ARG],
        deps,
      ),
    ).toBe(USAGE_EXIT);
    expect(
      await main(["--state", pristine(), "--root", temp("eff-es-nodist-"), ...KEEP_ARG], deps),
    ).toBe(USAGE_EXIT);
    const linked = pristine();
    symlinkSync("/etc/hosts", path.join(linked, "home", "link"));
    expect(
      await main(["--state", linked, "--root", repo(), ...KEEP_ARG], {
        ...deps,
        tmp: temp("eff-es-tmp-"),
      }),
    ).toBe(USAGE_EXIT);
    expect(f.spawned).toEqual([]);
    expect(lines.join("")).toMatch(/usage: eval-server\.mjs/);
    expect(lines.join("")).toMatch(/no state directory/);
    expect(lines.join("")).toMatch(/dist\/cli\.js is missing/);
    expect(lines.join("")).toMatch(/symbolic link/);
  });
});

describe("a real start (a stand-in dist/cli.js, never the server)", () => {
  it("two starts each see the pristine state; what one writes reaches neither the pristine state nor the next start", () => {
    const s = pristine();
    // the stand-in reads the store, appends to it, and reports what it saw and where — on stderr
    const r = repo(
      [
        'const fs = require("node:fs");',
        'const p = require("node:path").join(process.env.EFF_CACHE_DIR, "store.sqlite");',
        'process.stderr.write(JSON.stringify({ saw: fs.readFileSync(p, "utf8"), cache: process.env.EFF_CACHE_DIR, mode: fs.statSync(p).mode & 0o777, keys: Object.keys(process.env).filter((k) => /^(ESPN|EFF)_/.test(k)).sort() }) + "\\n");',
        'fs.appendFileSync(p, " + a retro this run logged");',
        "process.exit(7);",
      ].join("\n"),
    );
    // dist/cli.js is loaded as CommonJS here (no package.json "type" in the stand-in root)
    const runOnce = () => {
      const p = spawnSync(
        process.execPath,
        [
          "--import",
          path.join(ROOT, NO_SOCKET),
          path.join(ROOT, "scripts", "skills", "eval-server.mjs"),
          "--state",
          s,
          "--root",
          r,
          "--keep-env",
          "EFF_TOOLSET",
        ],
        {
          // the shell running the suite exports variables the plugin does not declare (V-2)
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            EFF_TOOLSET: "core",
            ESPN_TEAM_ID: "7",
            EFF_SEEDING_MODE: "espn_rule",
            EFF_WEATHER_SOURCE: "bogus",
          },
          encoding: "utf8",
          input: "",
        },
      );
      return {
        code: p.status,
        out: p.stdout,
        seen: JSON.parse(p.stderr.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>,
      };
    };
    // the launcher runs <root>/tests/e2e/fixtures/no-socket.cjs before the server: the stand-in root
    // carries the real preload
    mkdirSync(path.join(r, "tests", "e2e", "fixtures"), { recursive: true });
    writeFileSync(path.join(r, NO_SOCKET), readFileSync(path.join(ROOT, NO_SOCKET), "utf8"));
    const one = runOnce();
    const two = runOnce();
    expect(one.code).toBe(7);
    expect(two.code).toBe(7);
    expect(one.out).toBe("");
    expect(one.seen.saw).toBe("seeded log");
    expect(two.seen.saw).toBe("seeded log");
    expect(one.seen.mode).toBe(0o600);
    // only the declared variable and the state directories reach the server
    expect(one.seen.keys).toEqual(["EFF_CACHE_DIR", "EFF_CONFIG_DIR", "EFF_TOOLSET"]);
    expect(one.seen.cache).not.toBe(two.seen.cache);
    expect(existsSync(String(one.seen.cache))).toBe(false);
    expect(existsSync(String(two.seen.cache))).toBe(false);
    expect(readFileSync(path.join(s, "cache", "store.sqlite"), "utf8")).toBe("seeded log");
  });
});
