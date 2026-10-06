// io.ts — everything an `eff` subcommand may touch, injected (plan 03 §1.1 step 1: args, env, paths;
// plan 01 §2 "protocol on stdout, everything else on stderr" — the non-serve subcommands print human
// output on stdout and JSON log lines on stderr): the process executor (`execFile` with an argument
// array only — launchctl, osascript, lsof, node --version; plan 02 §7), the transport under the one
// HTTP client, the keychain loader, the xattr reader, and the package layout plan 03 §4 prints
// (absolute `process.execPath` + absolute `dist/cli.js`). `EFF_TEST_STUBS=1` (plan 05 §4.2) makes any
// network call or keychain load exit 99. Ported from sibling @5daa625, adapted.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { loadNativeKeyring, type KeyringPort } from "../auth/keychain.js";
import { packageRoot, systemXattrReader, type Env, type XattrReader } from "../config/paths.js";
import { systemClock, type Clock } from "../domain/clock.js";
import type { FetchLike } from "../http/client.js";

/** The result of running a program. `code` is null when it was killed (timeout, signal). */
export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program with an argument array (never a shell). Never rejects: failures are results. */
export type Exec = (
  file: string,
  args: readonly string[],
  opts?: { readonly timeoutMs?: number },
) => Promise<ExecResult>;

/** Longest a child program may run before it is killed. */
export const EXEC_TIMEOUT_MS = 10_000;
/** Most output kept from a child program (per stream). */
export const EXEC_MAX_BUFFER = 1024 * 1024;
/** The exit code of a stubbed network call or keychain load (plan 05 §4.2). */
export const TEST_STUB_EXIT = 99;

/** The real executor: `execFile` (no shell), bounded time and output. */
export const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        timeout: opts?.timeoutMs ?? EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code =
          err === null ? 0 : typeof err.code === "number" && err.killed !== true ? err.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });

/** Everything a subcommand may touch, injected so tests never reach the real machine. */
export interface CliIo {
  /** The environment (EFF_*, ESPN_*, CLAUDECODE). */
  readonly env: Env;
  /** The user's home (resolves ~/.config, ~/.cache, ~/Library/LaunchAgents). */
  readonly home: string;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** Time source (default: the wall clock). */
  readonly clock: Clock;
  /** `process.platform` (launchd and the keychain self-test are darwin-only). */
  readonly platform: NodeJS.Platform;
  /** Program executor (launchctl, osascript, lsof, `node --version`). */
  readonly exec: Exec;
  /** The transport under the one HTTP client (src/http) and the provider. null = global fetch. */
  readonly fetch: FetchLike | null;
  /** The keychain addon loader (src/auth/keychain.ts loads it lazily; tests inject a fake). */
  readonly loadKeyring: () => Promise<KeyringPort>;
  /** The file-provider xattr reader (src/config/paths.ts; tests stub it). */
  readonly xattr: XattrReader;
  /** The package root (checkout or install): `dist/cli.js` lives under it. */
  readonly packageRoot: string;
  /** The node binary that runs `eff` (plan 03 L4: printed, never a bare `node`). */
  readonly execPath: string;
  /** The running Node version (`process.versions.node`). */
  readonly nodeVersion: string;
  /** This process's user id (launchctl's gui/<uid> domain); null where unsupported. */
  readonly uid: number | null;
  /** This process's pid. */
  readonly pid: number;
}

/** A fetch that ends the process with TEST_STUB_EXIT — `EFF_TEST_STUBS=1` (plan 05 §4.2). */
export function stubbedFetch(stderr: NodeJS.WritableStream): FetchLike {
  return () => {
    stderr.write("eff: EFF_TEST_STUBS: a network call was attempted\n");
    process.exit(TEST_STUB_EXIT);
  };
}

/** A keychain loader that ends the process with TEST_STUB_EXIT — `EFF_TEST_STUBS=1`. */
export function stubbedKeyring(stderr: NodeJS.WritableStream): () => Promise<KeyringPort> {
  return () => {
    stderr.write("eff: EFF_TEST_STUBS: a keychain access was attempted\n");
    process.exit(TEST_STUB_EXIT);
  };
}

/** Whether `EFF_TEST_STUBS` asks for the stubs (1 or true). */
export function testStubsRequested(env: Env): boolean {
  const v = env.EFF_TEST_STUBS?.trim();
  return v === "1" || v === "true";
}

/** The real process's io (the entry point's only use of ambient state). */
export function defaultIo(): CliIo {
  const stubs = testStubsRequested(process.env);
  return {
    env: process.env,
    home: homedir(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    clock: systemClock,
    platform: process.platform,
    exec: defaultExec,
    fetch: stubs ? stubbedFetch(process.stderr) : null,
    loadKeyring: stubs ? stubbedKeyring(process.stderr) : loadNativeKeyring,
    xattr: systemXattrReader,
    packageRoot: packageRoot(),
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    pid: process.pid,
  };
}

/** Whether a stream is an interactive terminal. */
export function isTty(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: unknown }).isTTY === true;
}

const pipeGuarded = new WeakSet<NodeJS.WritableStream>();

/**
 * Makes a reader that closes early (`eff status | head -1`) end the command's output quietly instead
 * of crashing it (an EPIPE 'error' event with no listener is an uncaught exception). The command
 * keeps running to its own end and exit code. `serve` never gets this: there a closed stdout is the
 * plan 03 §1.3 shutdown path. Idempotent per stream.
 */
export function tolerateClosedPipe(stream: NodeJS.WritableStream): void {
  if (pipeGuarded.has(stream)) return;
  pipeGuarded.add(stream);
  stream.on("error", (e: unknown) => {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
    throw e;
  });
}

/** Writes `text` and resolves once the stream accepted it (so `process.exit` cannot truncate it). */
export function write(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    if ((stream as { destroyed?: boolean }).destroyed === true) {
      resolve();
      return;
    }
    try {
      stream.write(text, () => {
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/** Writes one line (newline appended). */
export function writeLine(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return write(stream, `${text}\n`);
}

/** `<package>/dist/cli.js` — the absolute entry a client config and launchd plist must name. */
export function distEntry(root: string): string {
  return path.join(root, "dist", "cli.js");
}
