// serve.test.ts — `eff serve` as a real child process (plan 03 §1.1–§1.3; plan 05 §4.2): spawned
// through src/cli.ts (tsx; `dist/cli.js` when EFF_PROCESS_TEST_DIST=1) in fixture mode with a temp
// HOME/EFF_CONFIG_DIR/EFF_CACHE_DIR, a no-network preload (exit 98) and EFF_TEST_STUBS=1 (exit 99 on
// any network call or keychain load). Initialize is answered over stdio with only JSON-RPC on stdout;
// EOF, SIGTERM, SIGINT, SIGHUP and EPIPE exit 0; a missing league id or an argument exits 2; a store
// from a newer binary exits 1 with plan 03 §7's message; a second SIGINT during a held close exits 5.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const USE_DIST = process.env.EFF_PROCESS_TEST_DIST === "1";
const ENTRY = USE_DIST ? path.join(ROOT, "dist", "cli.js") : path.join(ROOT, "src", "cli.ts");
const SERVE_MODULE = USE_DIST
  ? path.join(ROOT, "dist", "cli", "serve.js")
  : path.join(ROOT, "src", "cli", "serve.ts");
const TSX = import.meta.resolve("tsx");
const NO_NETWORK = path.join(import.meta.dirname, "fixtures", "no-network.cjs");
const FIXTURES = path.join(ROOT, "fixtures", "espn");

type Msg = Record<string, unknown>;

let dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempEnv(extra: Record<string, string> = {}): {
  dir: string;
  cache: string;
  env: Record<string, string>;
} {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-serve-proc-")));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  const cache = path.join(dir, "cache");
  return {
    dir,
    cache,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ESPN_LEAGUE_ID: "0",
      ESPN_SEASON: "2026",
      EFF_CONFIG_DIR: path.join(dir, "config"),
      EFF_CACHE_DIR: cache,
      EFF_FIXTURE_DIR: FIXTURES,
      EFF_TEST_STUBS: "1",
      ...extra,
    },
  };
}

interface Child {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly frames: Msg[];
  readonly logs: Msg[];
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
  send(m: Msg): void;
  reply(id: number): Promise<Msg>;
  log(event: string): Promise<Msg>;
}

async function until<T>(f: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function run(argv: readonly string[], env: Record<string, string>, cwd: string): Child {
  const proc = spawn(process.execPath, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  children.push(proc);
  const frames: Msg[] = [];
  const logs: Msg[] = [];
  let out = "";
  let err = "";
  let ob = "";
  let eb = "";
  proc.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
    ob += c.toString("utf8");
    let i = ob.indexOf("\n");
    while (i >= 0) {
      frames.push(JSON.parse(ob.slice(0, i)) as Msg);
      ob = ob.slice(i + 1);
      i = ob.indexOf("\n");
    }
  });
  proc.stderr.on("data", (c: Buffer) => {
    err += c.toString("utf8");
    eb += c.toString("utf8");
    let i = eb.indexOf("\n");
    while (i >= 0) {
      const line = eb.slice(0, i);
      eb = eb.slice(i + 1);
      i = eb.indexOf("\n");
      try {
        logs.push(JSON.parse(line) as Msg);
      } catch {
        logs.push({ event: "non_json_stderr", line });
      }
    }
  });
  proc.stdin.on("error", () => undefined);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return {
    proc,
    frames,
    logs,
    exit,
    stdout: () => out,
    stderr: () => err,
    send: (m) => proc.stdin.write(`${JSON.stringify(m)}\n`),
    reply: (id) => until(() => frames.find((f) => f.id === id), 30_000, `reply ${String(id)}`),
    log: (event) => until(() => logs.find((l) => l.event === event), 30_000, event),
  };
}

function serveCli(env: Record<string, string>, cwd: string, args: readonly string[] = []): Child {
  const preload = ["--import", NO_NETWORK];
  const argv = USE_DIST
    ? [...preload, ENTRY, "serve", ...args]
    : ["--import", TSX, ...preload, ENTRY, "serve", ...args];
  return run(argv, env, cwd);
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "process-test", version: "0" },
  },
};

async function ready(c: Child): Promise<Msg> {
  c.send(INIT);
  const r = await c.reply(1);
  c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await c.log("serve.ready");
  return r;
}

function expectCleanStdout(c: Child): void {
  for (const f of c.frames) expect(f.jsonrpc).toBe("2.0");
  if (c.stdout().length > 0) expect(c.stdout().endsWith("\n")).toBe(true);
  expect(c.stderr()).not.toContain("EFF-PROCESS-TEST");
  expect(c.stderr()).not.toContain("EFF_TEST_STUBS");
}

describe("eff serve (process)", { timeout: 90_000 }, () => {
  it("answers initialize and tools/list over stdio; stdout is JSON-RPC only; EOF exits 0", async () => {
    const t = tempEnv();
    const c = serveCli(t.env, t.dir);
    const init = await ready(c);
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "espn-fantasy-football-mcp-server",
    );
    expect(typeof (init.result as { instructions?: unknown }).instructions).toBe("string");
    c.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await c.reply(2);
    expect((list.result as { tools: unknown[] }).tools.length).toBeGreaterThanOrEqual(18);
    c.proc.stdin.end();
    expect(await c.exit).toEqual({ code: 0, signal: null });
    expectCleanStdout(c);
    expect(c.logs.find((l) => l.event === "serve.shutdown")).toMatchObject({ reason: "stdin" });
    expect(c.logs.some((l) => l.event === "non_json_stderr")).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("%s exits 0 after the close", async (sig) => {
    const t = tempEnv();
    const c = serveCli(t.env, t.dir);
    await ready(c);
    c.proc.kill(sig);
    expect(await c.exit).toEqual({ code: 0, signal: null });
    expect(c.logs.find((l) => l.event === "serve.shutdown")).toMatchObject({
      reason: sig.toLowerCase(),
    });
    expectCleanStdout(c);
  });

  it("a closed stdout (EPIPE) exits 0", async () => {
    const t = tempEnv();
    const c = serveCli(t.env, t.dir);
    await ready(c);
    c.proc.stdout.destroy();
    for (let i = 0; i < 5; i++)
      c.send({ jsonrpc: "2.0", id: 10 + i, method: "tools/list", params: {} });
    const r = await c.exit;
    expect(r).toEqual({ code: 0, signal: null });
    expect(["epipe", "stdout_error", "transport_closed"]).toContain(
      c.logs.find((l) => l.event === "serve.shutdown")?.reason,
    );
  });

  it("a missing league id or any argument exits 2 with nothing on stdout", async () => {
    const t = tempEnv();
    const { ESPN_LEAGUE_ID: _omit, ...noLeague } = t.env;
    const a = serveCli(noLeague, t.dir);
    expect((await a.exit).code).toBe(2);
    expect(a.stdout()).toBe("");
    expect(a.stderr()).toContain("ESPN_LEAGUE_ID");
    const b = serveCli(t.env, t.dir, ["--stdio"]);
    expect((await b.exit).code).toBe(2);
    expect(b.stdout()).toBe("");
  });

  it("a store written by a newer binary exits 1 with the upgrade message", async () => {
    const t = tempEnv();
    mkdirSync(t.cache, { mode: 0o700 });
    const file = path.join(t.cache, "store.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      999,
      "2030-01-01T00:00:00.000Z",
    );
    db.close();
    chmodSync(file, 0o600);
    const c = serveCli(t.env, t.dir);
    expect((await c.exit).code).toBe(1);
    expect(c.stdout()).toBe("");
    expect(c.stderr()).toContain("written by a newer version (v999)");
  });

  it("a second SIGINT during a held close forces exit 5", async () => {
    const t = tempEnv();
    const script = path.join(t.dir, "held-close.mjs");
    writeFileSync(
      script,
      [
        `import { serve } from ${JSON.stringify(SERVE_MODULE)};`,
        "const code = await serve(",
        "  { argv: [], env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },",
        "  { closeDelayMs: 20000 },",
        ");",
        "process.exit(code);",
        "",
      ].join("\n"),
    );
    const argv = USE_DIST
      ? ["--import", NO_NETWORK, script]
      : ["--import", TSX, "--import", NO_NETWORK, script];
    expect(existsSync(SERVE_MODULE)).toBe(true);
    const c = run(argv, t.env, t.dir);
    await ready(c);
    c.proc.kill("SIGINT");
    await c.log("serve.shutdown");
    c.proc.kill("SIGINT");
    expect(await c.exit).toEqual({ code: 5, signal: null });
    expect(c.logs.find((l) => l.event === "serve.forced_exit")).toMatchObject({
      reason: "second_signal",
    });
  });
});
