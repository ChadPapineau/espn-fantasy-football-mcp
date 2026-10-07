// helpers.ts — the end-to-end harness (plan 05 §4.2; plan 10 A3a, A7a, A14a, A15a, A16a): the BUILT
// package (`node dist/cli.js serve`) as a real child process over real stdio, in fixture mode on the
// derived league fixtures/espn/fx-10h (or a variant), with a private temp HOME / config / cache, a
// preload that turns any network call into exit 98, and EFF_TEST_STUBS=1 (exit 99 on any network or
// keychain access). The SDK Client talks to it through ChildTransport — a stdio transport the test
// owns, so it can end stdin itself and observe the real exit code and timing. No network, no
// ~/.config, no ~/.cache, no keychain.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { derivedLeagueClock } from "../../src/providers/espn/fixture-league.js";
import { storeFactory } from "../../src/store/index.js";
import { runningClock } from "../mcp/helpers/world.js";
import { seedDatasets, type SeedReport } from "../integration/helpers/seed.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Client,
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DIST_ENTRY = path.join(ROOT, "dist", "cli.js");
export const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
export const NO_SOCKET = path.join(import.meta.dirname, "fixtures", "no-socket.cjs");
/** The stall probe preload (SIGUSR2 → one `e2e.heartbeat` log line with the window's max). */
export const HEARTBEAT = path.join(import.meta.dirname, "fixtures", "heartbeat.cjs");
/** serve's drain window after stdin EOF (src/cli/serve.ts drainMs default) plus close slack. */
export const DRAIN_DEADLINE_MS = 3000 + 2000;

/** Fails loudly (never skips) when the package is not built. */
export function requireDist(): void {
  if (!existsSync(DIST_ENTRY))
    throw new Error("dist/cli.js is missing — run `npm run build` before the end-to-end suites");
}

/** A private home for one server. */
export interface E2eHome {
  readonly root: string;
  readonly cache: string;
  readonly env: Record<string, string>;
  cleanup(): void;
}

/** A temp home over a fixture directory (default fx-10h, Team 02). `teamId: null` unsets it. */
export function makeHome(
  opts: { fixtureDir?: string; teamId?: number | null; env?: Record<string, string> } = {},
): E2eHome {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-e2e-")));
  chmodSync(root, 0o700);
  for (const d of ["home", "config", "cache"]) mkdirSync(path.join(root, d), { mode: 0o700 });
  const teamId = opts.teamId === undefined ? 2 : opts.teamId;
  return {
    root,
    cache: path.join(root, "cache"),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(root, "home"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ESPN_LEAGUE_ID: "0",
      ESPN_SEASON: "2026",
      EFF_CONFIG_DIR: path.join(root, "config"),
      EFF_CACHE_DIR: path.join(root, "cache"),
      EFF_FIXTURE_DIR: opts.fixtureDir ?? FX,
      EFF_TOOLSET: "core",
      EFF_TEST_STUBS: "1",
      EFF_LOG_LEVEL: "info",
      ...(teamId === null ? {} : { ESPN_TEAM_ID: String(teamId) }),
      ...(opts.env ?? {}),
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Seeds a home's cache with every fixture-backed dataset source of `full` (plan 10 §3.2 — the state
 * an `eff refresh all` leaves), published through the real runner + publisher at the fixture
 * league's own clock (so the built server, which starts its clock there, reads every file fresh),
 * then rebuilds the crosswalk. The server is spawned on this cache afterwards; no network.
 */
export async function seedHome(home: E2eHome, fixtureDir: string = FX): Promise<SeedReport> {
  const at = derivedLeagueClock(fixtureDir);
  if (at === null) throw new Error(`${fixtureDir} has no derived-league clock`);
  const clock = runningClock(at);
  const t = {
    storePath: storePath(home.cache),
    datasetDir: datasetDir(home.cache),
    cache: home.cache,
    clock,
    season: 2026,
  };
  const store = storeFactory.open({
    path: t.storePath,
    datasetDir: t.datasetDir,
    backupDir: backupDir(home.cache),
    clock,
    migrate: true,
  });
  try {
    const report = await seedDatasets(store, t);
    const failed = report.results.filter((r) => r.status !== "published");
    if (failed.length > 0)
      throw new Error(`seed: ${failed.map((r) => `${r.source} ${r.status}`).join(", ")}`);
    return report;
  } finally {
    store.close();
  }
}

/** How the child ended. */
export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** performance.now() at exit. */
  readonly at: number;
}

/** A stdio client transport over `node --import no-socket.cjs dist/cli.js serve` that the test owns. */
export class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Every stderr line (the server's JSON log). */
  readonly stderr: string[] = [];
  /** Every raw stdout chunk (must be JSON-RPC frames only). */
  stdoutText = "";
  exit!: Promise<ChildExit>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly buffer = new ReadBuffer();
  private readonly env: Record<string, string>;
  private readonly args: readonly string[];
  private readonly preloads: readonly string[];

  constructor(
    env: Record<string, string>,
    args: readonly string[] = ["serve"],
    preloads: readonly string[] = [],
  ) {
    this.env = env;
    this.args = args;
    this.preloads = preloads;
  }

  /** Sends a signal to the server (the stall probe's SIGUSR2). */
  signal(sig: NodeJS.Signals): void {
    this.child?.kill(sig);
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): Promise<void> {
    const imports = [NO_SOCKET, ...this.preloads].flatMap((p) => ["--import", p]);
    const child = spawn(process.execPath, [...imports, DIST_ENTRY, ...this.args], {
      env: this.env,
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let err = "";
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf8");
      const lines = err.split("\n");
      err = lines.pop() ?? "";
      this.stderr.push(...lines.filter(Boolean));
    });
    child.stdout.on("data", (b: Buffer) => {
      this.stdoutText += b.toString("utf8");
      this.buffer.append(b);
      for (;;) {
        let m: JSONRPCMessage | null;
        try {
          m = this.buffer.readMessage();
        } catch (e) {
          this.onerror?.(e instanceof Error ? e : new Error(String(e)));
          continue;
        }
        if (m === null) break;
        this.onmessage?.(m);
      }
    });
    child.stdin.on("error", () => undefined);
    this.exit = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        if (err !== "") this.stderr.push(err);
        resolve({ code, signal, at: performance.now() });
        this.onclose?.();
      });
    });
    return new Promise((resolve, reject) => {
      child.once("spawn", () => {
        resolve();
      });
      child.once("error", reject);
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (child === null) return Promise.reject(new Error("not started"));
    return new Promise((resolve) => {
      if (child.stdin.write(serializeMessage(message))) resolve();
      else child.stdin.once("drain", resolve);
    });
  }

  /** Ends stdin (EOF) — the server's clean shutdown path — and returns when stdin is closed. */
  endStdin(): number {
    this.child?.stdin.end();
    return performance.now();
  }

  /** The Client calls this on close: end stdin, wait for exit (a hung child is killed). */
  async close(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await this.exit;
      clearTimeout(timer);
    }
  }
}

/** A connected client over a spawned built server. */
export interface Served {
  readonly client: Client;
  readonly transport: ChildTransport;
  /** Milliseconds from spawn to a completed handshake. */
  readonly connectMs: number;
  /** Ends stdin and waits for the exit; returns it and how long it took. */
  stop(): Promise<{ exit: ChildExit; ms: number }>;
}

/** Spawns `node dist/cli.js serve` in `home` and connects (legacy initialize, or 2026-07-28 era). */
export async function serve(
  home: E2eHome,
  opts: { modern?: boolean; preloads?: readonly string[] } = {},
): Promise<Served> {
  requireDist();
  const transport = new ChildTransport(home.env, ["serve"], opts.preloads ?? []);
  const client = new Client(
    { name: "eff-e2e", version: "0.0.0" },
    opts.modern === true ? { versionNegotiation: { mode: "auto" } } : {},
  );
  const t0 = performance.now();
  await client.connect(transport);
  const connectMs = performance.now() - t0;
  return {
    client,
    transport,
    connectMs,
    stop: async () => {
      const t = transport.endStdin();
      const exit = await transport.exit;
      return { exit, ms: exit.at - t };
    },
  };
}

/** The parsed JSON log records of a stderr capture (a non-JSON line is kept as `{ raw }`). */
export function logRecords(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return { raw: l };
    }
  });
}

/** The envelope (or error body) of a tool result: the one text block, parsed. */
export function bodyOf(r: unknown): Record<string, unknown> {
  const content = (r as { content?: { type: string; text: string }[] }).content ?? [];
  const first = content[0];
  if (first?.type !== "text") throw new Error("a tool result without a text block");
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** One CLI run's result. */
export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node --import no-socket.cjs dist/cli.js <args>` with `env` (never a shell). */
export function runCli(env: Record<string, string>, args: readonly string[]): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", NO_SOCKET, DIST_ENTRY, ...args],
      { cwd: ROOT, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err === null ? 0 : typeof err.code === "number" ? err.code : err.killed ? 124 : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
