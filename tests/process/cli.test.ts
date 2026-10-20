// cli.test.ts — process tests for the non-serve `eff` subcommands (plan 05 §1 process level, §4.2;
// plan 10 A15a, A17b): spawn the real CLI (src/cli.ts through tsx; `dist/cli.js` when
// EFF_PROCESS_TEST_DIST=1, as the CI process job does after `npm run build`) with a temp HOME and
// temp EFF_CONFIG_DIR/EFF_CACHE_DIR, so nothing touches the real ~/.config, ~/.cache, LaunchAgents
// or keychain item. No test reaches the network: a preload replaces fetch (no-network.cjs exits 98),
// and EFF_TEST_STUBS=1 makes any network call or keychain load exit 99. launchctl is never run
// (install-launchd --dry-run only). The preload is .cjs so tsconfig's allowJs never reads its
// `globalThis.fetch =` as a declaration of the global (that retyped fetch tree-wide). SIGINT and
// SIGTERM (Stage C finding cli-first-signal-swallowed): the first one ends a command that does not
// claim it, by the signal; a scope that claims it (the setup page) stops cleanly on the first.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST = path.join(ROOT, "dist", "cli.js");
const USE_DIST = process.env.EFF_PROCESS_TEST_DIST === "1";
const TSX = import.meta.resolve("tsx");
const NO_NETWORK = path.join(import.meta.dirname, "fixtures", "no-network.cjs");

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempRoot(): {
  dir: string;
  home: string;
  config: string;
  cache: string;
  env: Record<string, string>;
} {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-proc-")));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  const config = path.join(dir, "config");
  const cache = path.join(dir, "cache");
  return {
    dir,
    home,
    config,
    cache,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      EFF_CONFIG_DIR: config,
      EFF_CACHE_DIR: cache,
    },
  };
}

/** The node argv for `eff <args>` with optional preloads. */
function argvFor(args: readonly string[], preload: readonly string[] = []): string[] {
  const imports = preload.flatMap((p) => ["--import", p]);
  return USE_DIST
    ? [...imports, DIST, ...args]
    : ["--import", TSX, ...imports, path.join(ROOT, "src", "cli.ts"), ...args];
}

/** Runs `eff <args>` with exactly `env` (no inherited EFF_*, ESPN_* or CLAUDECODE). */
function eff(
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  opts: { input?: string; preload?: readonly string[] } = {},
): Run {
  const r = spawnSync(process.execPath, argvFor(args, opts.preload), {
    env,
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    input: opts.input ?? "",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A fake espn_s2 / SWID made at run time (never a literal in the repo). */
function fakeCookies(): { swid: string; s2: string } {
  const h = randomBytes(6).toString("hex").toUpperCase();
  return { swid: `{00000000-0000-4000-8000-${h}}`, s2: `x${randomBytes(60).toString("hex")}` };
}

describe("eff (process)", () => {
  it("version: exit 0, one line on stdout, nothing on stderr", () => {
    const t = tempRoot();
    const r = eff(["version"], t.env, t.dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^eff \d+\.\d+\.\d+ \(node \d+\.\d+\.\d+\)\n$/);
    expect(r.stderr).toBe("");
  });

  it("usage errors exit 2 with the message on stderr and nothing on stdout", () => {
    const t = tempRoot();
    for (const args of [[], ["nope"], ["status", "--bogus"], ["refresh"], ["print-config"]]) {
      const r = eff(args, t.env, t.dir);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr.length).toBeGreaterThan(0);
    }
  });

  it("print-config: valid JSON, absolute paths, no secrets — or exit 1 naming the missing build", () => {
    const t = tempRoot();
    const key = randomBytes(20).toString("hex");
    const r = eff(
      ["print-config", "--client", "desktop"],
      { ...t.env, ESPN_LEAGUE_ID: "0", ODDS_API_KEY: key },
      t.dir,
      { preload: [NO_NETWORK] },
    );
    if (!existsSync(DIST)) {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("npm run build");
      return;
    }
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const e = doc.mcpServers["espn-fantasy-football"]!;
    expect(path.isAbsolute(e.command)).toBe(true);
    expect(e.args).toEqual([DIST, "serve"]);
    expect(path.isAbsolute(e.args[0] ?? "")).toBe(true);
    expect(e.env.ESPN_LEAGUE_ID).toBe("0");
    expect(r.stdout + r.stderr).not.toContain(key);
    expect(r.stdout).not.toContain("EFF_CREDENTIAL");
  });

  it.skipIf(!existsSync(DIST))(
    "print-config warns when the runtime install sits under a synced folder",
    () => {
      const t = tempRoot();
      // HOME/Documents points at the checkout's parent: the install now reads as "in Documents"
      symlinkSync(path.dirname(ROOT), path.join(t.home, "Documents"));
      const r = eff(
        ["print-config", "--client", "code"],
        { ...t.env, ESPN_LEAGUE_ID: "0" },
        t.dir,
        { preload: [NO_NETWORK] },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("claude mcp add espn-fantasy-football --scope user");
      expect(r.stderr).toContain("file-provider (iCloud) or synced directory");
    },
  );

  it("doctor --json on a fresh temp config/cache: a stable report, exit 3, no network, no keychain", () => {
    const t = tempRoot();
    const r = eff(
      ["doctor", "--json"],
      { ...t.env, EFF_TEST_STUBS: "1", EFF_CREDENTIAL_STORE: "file" },
      t.dir,
      { preload: [NO_NETWORK] },
    );
    expect(r.stderr).not.toContain("EFF_TEST_STUBS");
    expect(r.stderr).not.toContain("EFF-PROCESS-TEST");
    expect(r.code).toBe(3);
    const doc = JSON.parse(r.stdout) as {
      exit_code: number;
      online: boolean;
      rows: { n: number; id: string; status: string }[];
    };
    expect(doc.exit_code).toBe(3);
    expect(doc.online).toBe(false);
    expect(doc.rows.map((x) => x.n)).toEqual(Array.from({ length: 26 }, (_, i) => i));
    expect(doc.rows.find((x) => x.id === "credential_store")?.status).toBe("credentials");
    expect(existsSync(path.join(t.cache, "store.sqlite"))).toBe(false);
  });

  it("status on a fresh install: exit 0, never a credential value; refresh in fixture mode is refused (2)", () => {
    const t = tempRoot();
    const r = eff(["status", "--json"], { ...t.env, EFF_TEST_STUBS: "1" }, t.dir, {
      preload: [NO_NETWORK],
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ store: { state: "missing" } });
    const f = eff(
      ["refresh", "all"],
      { ...t.env, EFF_FIXTURE_DIR: path.join(ROOT, "fixtures", "espn") },
      t.dir,
      { preload: [NO_NETWORK] },
    );
    expect(f.code).toBe(2);
  });

  it("install-launchd --dry-run: absolute plists, generic labels, no credential keys, nothing written", () => {
    const t = tempRoot();
    const r = eff(
      ["install-launchd", "--dry-run", "--jobs", "probe,credential-check"],
      { ...t.env, ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" },
      t.dir,
      { preload: [NO_NETWORK] },
    );
    expect(r.code).toBe(0);
    const plists = r.stdout.split("<?xml").slice(1);
    expect(plists).toHaveLength(2);
    for (const p of plists) {
      expect(p).toContain("<key>Label</key>");
      expect(p).toMatch(
        /<string>io\.github\.espn-fantasy-football-mcp\.eff\.(probe|credential-check)<\/string>/,
      );
      const args = [...p.matchAll(/<array>([\s\S]*?)<\/array>/g)][0]?.[1] ?? "";
      const strings = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1] ?? "");
      expect(path.isAbsolute(strings[0] ?? "")).toBe(true);
      expect(path.isAbsolute(strings[1] ?? "")).toBe(true);
      expect(p).not.toContain("EFF_CREDENTIAL");
      expect(p).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    }
    expect(existsSync(path.join(t.home, "Library", "LaunchAgents"))).toBe(false);
  });

  // The two setup tests below stop BEFORE anything is stored: three refused espn_s2 answers end the
  // run (exit 2). A run that went on would delete the other store's items — the REAL keychain service
  // — so no process test ever lets setup reach the store step outside `--service-name eff-test-…`.
  // EFF_TEST_STUBS=1 proves it: any keychain load or network call would exit 99.
  it("setup with piped input never echoes a value; refused answers end it before any store or network (exit 2)", () => {
    const t = tempRoot();
    const c = fakeCookies();
    const short = [1, 2, 3].map(() => randomBytes(19).toString("hex") + "z");
    const r = eff(
      ["setup", "--storage", "file"],
      { ...t.env, ESPN_LEAGUE_ID: "0", EFF_TEST_STUBS: "1" },
      t.dir,
      { preload: [NO_NETWORK], input: `${c.swid}\n${short.join("\n")}\n` },
    );
    const all = r.stdout + r.stderr;
    expect(r.code).toBe(2);
    expect(all).not.toContain("EFF_TEST_STUBS");
    expect(all).not.toContain("EFF-PROCESS-TEST");
    for (const v of short) expect(all).not.toContain(v);
    expect(all).not.toContain(c.swid);
    expect(r.stdout).toContain("espn_s2 is shorter than 40 characters");
    expect(r.stdout).toContain("Too many invalid attempts");
    expect(existsSync(path.join(t.config, "session.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "setup under a pty: the hidden espn_s2 is never echoed to the terminal",
    async () => {
      const t = tempRoot();
      const c = fakeCookies();
      const short = [1, 2, 3].map(() => randomBytes(19).toString("hex") + "z");
      const q = (a: string): string => `'${a.replaceAll("'", `'\\''`)}'`;
      const cmd = [process.execPath, ...argvFor(["setup", "--storage", "file"], [NO_NETWORK])]
        .map(q)
        .join(" ");
      // node's stdio pipes are sockets, which script(1) refuses: real pipes on both sides
      const pty =
        process.platform === "darwin"
          ? `/usr/bin/script -q /dev/null /bin/sh -c ${q(cmd)}`
          : `script -qec ${q(cmd)} /dev/null`;
      const child = spawn("/bin/sh", ["-c", `cat | ${pty} | cat`], {
        env: { ...t.env, ESPN_LEAGUE_ID: "0", EFF_TEST_STUBS: "1" },
        cwd: t.dir,
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      const waitFor = async (pred: () => boolean): Promise<void> => {
        for (let i = 0; i < 600 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
        if (!pred()) throw new Error(`timed out; output so far: ${out.slice(-300)}`);
      };
      const count = (s: string): number => out.split(s).length - 1;
      const closed = new Promise<void>((resolve) =>
        child.on("close", () => {
          resolve();
        }),
      );
      await waitFor(() => out.includes("SWID (visible as you type): "));
      child.stdin.write(`${c.swid}\r`);
      for (let i = 0; i < 3; i++) {
        await waitFor(() => count("espn_s2 (hidden, nothing appears as you paste): ") > i);
        child.stdin.write(`${short[i] ?? ""}\r`);
      }
      await waitFor(() => out.includes("Too many invalid attempts"));
      child.stdin.end();
      await closed;
      for (const v of short) expect(out).not.toContain(v);
      expect(out).toContain("espn_s2 is shorter than 40 characters");
      expect(out).not.toContain("EFF_TEST_STUBS");
    },
    60_000,
  );

  it("setup --service-name eff-test-…: no network call, no store.sqlite, no config.json, values never echoed", () => {
    const t = tempRoot();
    const c = fakeCookies();
    const builtOnMac = process.platform === "darwin" && existsSync(DIST);
    if (builtOnMac && process.env.EFF_KEYCHAIN_PROCESS_TEST !== "1") return; // the real launchd self-test is opt-in here
    const service = `eff-test-${randomBytes(4).toString("hex")}`;
    const r = eff(["setup", "--service-name", service], { ...t.env }, t.dir, {
      preload: [NO_NETWORK],
      input: `${c.swid}\n${c.s2}\n`,
    });
    const all = r.stdout + r.stderr;
    expect(all).not.toContain("EFF-PROCESS-TEST");
    expect([0, 1]).toContain(r.code);
    expect(all).not.toContain(c.s2.slice(0, 24));
    expect(all).not.toContain(c.swid);
    expect(existsSync(path.join(t.cache, "store.sqlite"))).toBe(false);
    expect(existsSync(path.join(t.config, "config.json"))).toBe(false);
    if (r.code === 0 && process.platform === "darwin") {
      // a passing self-test stored three items under the TEST service only: remove them (plan 05 §4.2)
      for (const account of ["espn_s2", "SWID", "meta"])
        spawnSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account], {
          stdio: "ignore",
        });
    }
    expect(readFileSync(NO_NETWORK, "utf8")).toContain("exit(98)");
  });
});

// Stage C finding cli-first-signal-swallowed: the entry listened for SIGINT/SIGTERM for every
// command — which takes Node's default exit away — while only a refresh and the setup page acted on
// them, so the first Ctrl-C (or a launchd bootout's SIGTERM) to any other command did nothing and
// only a second one ended it. Now only a scope that honours cancellation claims the signals
// (src/cli/interrupt.ts): any other command ends on the first one, by the signal.
describe("eff (process): SIGINT and SIGTERM", () => {
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  interface Started {
    readonly child: ChildProcessWithoutNullStreams;
    readonly out: () => string;
    readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  }

  /** Spawns `eff <args>` with stdin a pipe held open (nothing is ever written to it). */
  function start(args: readonly string[], env: Record<string, string>, cwd: string): Started {
    const child = spawn(process.execPath, argvFor(args, [NO_NETWORK]), { env, cwd });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("exit", (code, signal) => {
          resolve({ code, signal });
        });
      },
    );
    return { child, out: () => out, exited };
  }

  /** Waits (bounded) until stdout shows `text`. */
  async function waitFor(s: Started, text: string): Promise<void> {
    for (let i = 0; i < 1800 && !s.out().includes(text); i++) await delay(50);
    expect(s.out()).toContain(text);
  }

  /** The exit, or "alive" when the process still runs `ms` after the call. */
  function exitWithin(
    s: Started,
    ms: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null } | "alive"> {
    return Promise.race([s.exited, delay(ms).then(() => "alive" as const)]);
  }

  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = createServer();
      s.on("error", reject);
      s.listen({ host: "127.0.0.1", port: 0 }, () => {
        const a = s.address();
        const port = typeof a === "object" && a !== null ? a.port : 0;
        s.close(() => {
          resolve(port);
        });
      });
    });
  }

  /** Whether 127.0.0.1:`port` can be bound now (the page let it go). */
  function portFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const s = createServer();
      s.on("error", () => {
        resolve(false);
      });
      s.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        s.close(() => {
          resolve(true);
        });
      });
    });
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const)
    it(`the first ${sig} ends a command that does not claim it (setup waiting at its prompt on a pipe), by the signal, nothing stored`, async () => {
      const t = tempRoot();
      const s = start(
        ["setup", "--storage", "file"],
        { ...t.env, ESPN_LEAGUE_ID: "0", EFF_TEST_STUBS: "1" },
        t.dir,
      );
      try {
        await waitFor(s, "SWID (visible as you type): ");
        s.child.kill(sig);
        // before the fix the process was still waiting here; only a second signal ended it
        expect(await exitWithin(s, 10_000)).toEqual({ code: null, signal: sig });
      } finally {
        s.child.kill("SIGKILL");
      }
      expect(existsSync(path.join(t.config, "session.json"))).toBe(false);
    }, 150_000);

  it("a scope that claims the signals stops cleanly on the first one (setup --page): exit 1, nothing stored, the port free", async () => {
    const t = tempRoot();
    const port = await freePort();
    const s = start(
      ["setup", "--page"],
      {
        ...t.env,
        ESPN_LEAGUE_ID: "0",
        EFF_TEST_STUBS: "1",
        EFF_CREDENTIAL_STORE: "file",
        EFF_SETUP_PORT: String(port),
      },
      t.dir,
    );
    try {
      await waitFor(s, `http://127.0.0.1:${String(port)}/setup/`);
      s.child.kill("SIGINT");
      expect(await exitWithin(s, 10_000)).toEqual({ code: 1, signal: null });
    } finally {
      s.child.kill("SIGKILL");
    }
    expect(s.out()).toContain("Stopped: nothing was stored.");
    expect(await portFree(port)).toBe(true);
    expect(existsSync(path.join(t.config, "session.json"))).toBe(false);
  }, 150_000);
});
