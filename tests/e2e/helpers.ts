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
    // the served league's own pro schedule (seed.ts SeedTarget.fixtureDir)
    fixtureDir,
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

// --- the stall bound's host control (plan 10 A16a) -----------------------------------------------

/** What a heartbeat window can be read from: the server's transport, or the idle control. */
export interface HeartbeatSource {
  signal(sig: NodeJS.Signals): void;
  readonly stderr: string[];
}

/** One heartbeat window (tests/e2e/fixtures/heartbeat.cjs). */
export interface Heartbeat {
  /** The event loop's longest delay (ms). */
  readonly max_ms: number;
  /** The longest gap between two ticks of its 5 ms timer (ms past the tick)… */
  readonly gap_ms: number;
  /** …the main thread's own CPU time inside it… */
  readonly gap_cpu_ms: number;
  /** …and the process's involuntary context switches inside it (the OS took a thread off the CPU). */
  readonly gap_invol: number;
  /**
   * The main thread's longest run on the CPU between two ticks anywhere in the window (ms): a
   * JavaScript block, seen even when a longer gap beside it is the window's longest. Null when the
   * line does not carry it as a finite, non-negative number (it cannot be read: changelog §R10,
   * R10-9 leaves such a measurement to R8-2, "cannot be measured").
   */
  readonly cpu_max_ms: number | null;
}

/** The window of a process running the heartbeat preload, and a fresh window. */
export async function heartbeatRecordOf(p: HeartbeatSource): Promise<Heartbeat> {
  const before = p.stderr.length;
  p.signal("SIGUSR2");
  const end = Date.now() + 5000;
  for (;;) {
    const rec = logRecords(p.stderr.slice(before)).find((l) => l.event === "e2e.heartbeat");
    if (rec !== undefined) {
      const num = (k: string): number => {
        const v = rec[k];
        return typeof v === "number" ? v : 0;
      };
      const cpuMax = rec.cpu_max_ms;
      return {
        max_ms: num("max_ms"),
        gap_ms: num("gap_ms"),
        gap_cpu_ms: num("gap_cpu_ms"),
        gap_invol: num("gap_invol"),
        cpu_max_ms:
          typeof cpuMax === "number" && Number.isFinite(cpuMax) && cpuMax >= 0 ? cpuMax : null,
      };
    }
    if (Date.now() > end) throw new Error("no heartbeat line");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The window maximum (ms) of a process running the heartbeat preload, and a fresh window. */
export async function heartbeatOf(p: HeartbeatSource): Promise<number> {
  return (await heartbeatRecordOf(p)).max_ms;
}

/**
 * An idle process's longest loop delay past which a window measured the HOST, not the server: an
 * idle Node process on a quiet machine stays within a few timer ticks of its 5 ms resolution.
 */
export const CONTROL_STARVED_MS = 25;
/** How many windows one stall measurement may take before it says the host cannot measure it. */
export const STALL_WINDOW_ATTEMPTS = 3;

/**
 * The control of the stall bounds: an IDLE child process beside the server — the same heartbeat
 * preload and a timer, nothing else — measured over the same windows. The heartbeat is wall-clock
 * event-loop delay, so on a loaded host (the final gate's Mac at load 34–85: Spotlight and an
 * orphaned test worker; a shared 4-vCPU CI runner) the OS's preemption reads as the server's stall:
 * 107 ms for six parallel lineup calls whose own stall was 21 ms when re-run, 80.6 and 128.5 ms on
 * CI. A window in which the idle control stalled too is evidence of the host, not of the server.
 */
export class StallControl implements HeartbeatSource {
  readonly stderr: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    let err = "";
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf8");
      const lines = err.split("\n");
      err = lines.pop() ?? "";
      this.stderr.push(...lines.filter(Boolean));
    });
  }

  /**
   * Spawns the idle control (no network: the same no-socket preload as the server) and waits until
   * its preloads are installed — a SIGUSR2 before the heartbeat's handler would end the process.
   */
  static async start(): Promise<StallControl> {
    const child = spawn(
      process.execPath,
      [
        "--import",
        NO_SOCKET,
        "--import",
        HEARTBEAT,
        "-e",
        'process.stderr.write("e2e.control.ready\\n"); setInterval(() => {}, 1_000_000);',
      ],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
    );
    const c = new StallControl(child);
    const end = Date.now() + 10_000;
    while (!c.stderr.includes("e2e.control.ready")) {
      if (child.exitCode !== null || Date.now() > end) {
        child.kill("SIGKILL");
        throw new Error("the stall control did not start");
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return c;
  }

  signal(sig: NodeJS.Signals): void {
    this.child.kill(sig);
  }

  stop(): void {
    this.child.kill("SIGKILL");
  }
}

/** One recorded window of a stall measurement: the server's heartbeat and the idle control's stall. */
export interface RecordedWindow {
  readonly server: Heartbeat;
  readonly control_ms: number;
}

/**
 * How a stall measurement ends (plan 10 A16a; ruling R8-2, amended by changelog §R10, R10-9):
 * `within` — its last window stayed within the bound (a plain pass); `host_set` — every window was
 * over the bound and set by the host by the control's stall, the server's own longest run on the CPU
 * under the bound in each (a pass, never reported as a plain one); `own` — the server's own stall (a
 * failure); `unmeasurable` — the host set every window and the R10-9 pass does not apply (a failure:
 * "cannot be measured").
 */
export type StallVerdict =
  | { readonly kind: "within" }
  | { readonly kind: "host_set"; readonly own_cpu_max_ms: number }
  | { readonly kind: "own" }
  | { readonly kind: "unmeasurable" };

/** What one more window tells a measurement: its verdict, or that the window is to be repeated. */
export type StallStep = StallVerdict | { readonly kind: "repeat" };

/**
 * The verdict over the windows a measurement took, in order (a pure function: what measureStall
 * decides after each window). A window within the bound, or over it with nothing showing the host
 * set it (hostSetStall: never a JavaScript block over the bound), ends the measurement: `within` or
 * `own`. A window the host set is repeated, at most STALL_WINDOW_ATTEMPTS windows in all (R8-2).
 * When the host set every one of them, changelog §R10, R10-9: a window whose `cpu_max_ms` reaches
 * the bound fails as the server's own stall; where one cannot be read, or one window's only evidence
 * was the process's involuntary switches (the idle control did not stall in it), R8-2 stands — it
 * cannot be measured; otherwise every window was set by the host by the control's stall with the
 * server's own longest run on the CPU under the bound, and the measurement passes as `host_set`,
 * with that longest run. Throws RangeError on no window, or on a window after one that ended it.
 */
export function judgeStall(windows: readonly RecordedWindow[], boundMs: number): StallStep {
  if (windows.length === 0) throw new RangeError("judgeStall: no window");
  for (const [i, w] of windows.entries()) {
    const ended =
      w.server.max_ms <= boundMs
        ? ({ kind: "within" } as const)
        : !hostSetStall(w.server, w.control_ms, boundMs)
          ? ({ kind: "own" } as const)
          : null;
    if (ended === null) continue;
    if (i !== windows.length - 1) throw new RangeError("judgeStall: a window after the last one");
    return ended;
  }
  if (windows.length < STALL_WINDOW_ATTEMPTS) return { kind: "repeat" };
  const runs = windows.map((w) => w.server.cpu_max_ms);
  if (runs.some((ms) => ms !== null && ms >= boundMs)) return { kind: "own" };
  if (runs.some((ms) => ms === null)) return { kind: "unmeasurable" };
  if (windows.some((w) => w.control_ms <= CONTROL_STARVED_MS)) return { kind: "unmeasurable" };
  return { kind: "host_set", own_cpu_max_ms: Math.max(...runs.map((ms) => ms ?? 0)) };
}

/** One measured stall window: the server's longest stall, the control's, and the windows taken. */
export interface StallWindow {
  readonly stall_ms: number;
  readonly control_ms: number;
  readonly attempts: number;
  /** The server window's preemption evidence (its longest timer gap). */
  readonly server: Heartbeat;
  /** Each window before it that was over the bound and repeated on the host's evidence. */
  readonly repeated: readonly RecordedWindow[];
  /** The measurement's verdict (judgeStall): `within` or `host_set` pass, `own` fails. */
  readonly verdict: Exclude<StallVerdict, { readonly kind: "unmeasurable" }>;
  /** The verdict as one line ("host-set; the server's own longest CPU run N ms" for R10-9's pass). */
  readonly report: string;
}

/** Whether a measured window passes its bound: within it, or host-set under R10-9. */
export function stallPassed(w: Pick<StallWindow, "verdict">): boolean {
  return w.verdict.kind === "within" || w.verdict.kind === "host_set";
}

/**
 * A verdict as one line (ms to 0.1): changelog §R10, R10-9's pass reads exactly "host-set; the
 * server's own longest CPU run N ms", never as a plain pass.
 */
export function stallReport(verdict: StallVerdict, stallMs: number, boundMs: number): string {
  const f = (x: number): string => x.toFixed(1);
  // a bound derived from a measurement (retrospective-stall's growth bound) to 0.1, a literal as is
  const b = Number.isInteger(boundMs) ? String(boundMs) : f(boundMs);
  switch (verdict.kind) {
    case "within":
      return `within the bound: ${f(stallMs)} ms <= ${b} ms`;
    case "host_set":
      return `host-set; the server's own longest CPU run ${f(verdict.own_cpu_max_ms)} ms`;
    case "own":
      return `the server's own stall: ${f(stallMs)} ms > ${b} ms`;
    case "unmeasurable":
      return `the ${b} ms bound cannot be measured on this machine now`;
  }
}

/**
 * A window's evidence as one line (ms to 0.1): the stall, the windows taken, the idle control's
 * stall, and the server's longest gap with its own CPU and involuntary switches and its longest run
 * on the CPU anywhere in the window, then every repeated window's. What a stall verdict rests on is
 * printed with it, so a red run says whether the server's own CPU or an unexcused wait set it.
 */
export function stallEvidence(
  w: Pick<StallWindow, "attempts" | "server" | "control_ms" | "repeated"> & {
    readonly stall_ms?: number;
  },
): string {
  const r = (x: number): number => Math.round(x * 10) / 10;
  const beat = (s: Heartbeat, controlMs: number) => ({
    stall_ms: r(s.max_ms),
    gap_ms: r(s.gap_ms),
    gap_cpu_ms: r(s.gap_cpu_ms),
    gap_invol: s.gap_invol,
    cpu_max_ms: s.cpu_max_ms === null ? null : r(s.cpu_max_ms),
    control_ms: r(controlMs),
  });
  return JSON.stringify({
    attempts: w.attempts,
    ...beat(w.server, w.control_ms),
    repeated: w.repeated.map((x) => beat(x.server, x.control_ms)),
  });
}

/**
 * Whether a server window over `boundMs` may have been set by the HOST: its longest gap holds no
 * more of the main thread's own CPU than the bound, AND something shows the host interfering — the
 * OS took a thread of the process off the CPU inside that gap (involuntary switches), or an idle
 * process beside it (the control) stalled past CONTROL_STARVED_MS in the same window. A JavaScript
 * block over the bound spends that time on the CPU, so it is the server's own and is never excused,
 * whatever the host did — wherever it sits in the window (ruling R8-2): the main thread's longest
 * run on the CPU between two ticks (cpu_max_ms) over the bound refuses the excuse even when a
 * longer gap the host set is the window's longest. (The switch count is process-wide: a synchronous
 * wait of the main thread that coincides with another thread's preemption is repeated, and a stall
 * that recurs in every window on that evidence alone ends in measureStall's "cannot be measured"
 * failure — never a pass: changelog §R10, R10-9's pass needs the idle control's stall in every
 * window, which such a wait does not cause.)
 */
export function hostSetStall(server: Heartbeat, controlMs: number, boundMs: number): boolean {
  // an unreadable cpu_max_ms refuses nothing here (R8-2's longest-gap reading); judgeStall then
  // never lets the measurement pass on the host's evidence (changelog §R10, R10-9)
  if (server.gap_cpu_ms > boundMs || (server.cpu_max_ms ?? 0) > boundMs) return false;
  return server.gap_invol > 0 || controlMs > CONTROL_STARVED_MS;
}

/**
 * The server's longest main-loop stall over one run of `work`, against `boundMs` (the heartbeat is
 * wall-clock event-loop delay, so the OS's preemption on a loaded host reads as the server's stall),
 * judged after each window by judgeStall. A window is measured when the server stayed within the
 * bound, or when nothing shows the host set it (hostSetStall) — `own`: the caller's stallPassed
 * check fails on the server's own stall. A window over the bound that the host set is repeated —
 * `work` is idempotent reads and analytics — up to STALL_WINDOW_ATTEMPTS windows. When the host set
 * every one, the measurement passes as `host_set` only by changelog §R10, R10-9 (the control stalled
 * in each, the server's own longest CPU run under the bound in each), reported so; otherwise it
 * throws, saying the bound cannot be measured: never a plain pass.
 */
export async function measureStall(
  server: HeartbeatSource,
  control: HeartbeatSource,
  work: () => Promise<void>,
  boundMs: number,
): Promise<StallWindow> {
  const windows: RecordedWindow[] = [];
  for (;;) {
    await heartbeatOf(server); // fresh windows: only `work` is measured
    await heartbeatOf(control);
    await work();
    const s = await heartbeatRecordOf(server);
    const ctl = await heartbeatOf(control);
    windows.push({ server: s, control_ms: ctl });
    const step = judgeStall(windows, boundMs);
    if (step.kind === "repeat") continue;
    const attempt = windows.length;
    if (step.kind === "unmeasurable")
      throw new Error(
        `the host set the server's stall in all ${String(attempt)} windows (the last: ${s.max_ms.toFixed(1)} ms, ${s.gap_cpu_ms.toFixed(1)} ms of its own CPU in its longest gap with ${String(s.gap_invol)} involuntary switches, its longest run on the CPU ${s.cpu_max_ms === null ? "unread" : `${s.cpu_max_ms.toFixed(1)} ms`}; an idle control process ${ctl.toFixed(1)} ms): the ${String(boundMs)} ms bound cannot be measured on this machine now — rerun when it is quieter`,
      );
    return {
      stall_ms: s.max_ms,
      control_ms: ctl,
      attempts: attempt,
      server: s,
      repeated: windows.slice(0, -1),
      verdict: step,
      report: stallReport(step, s.max_ms, boundMs),
    };
  }
}
