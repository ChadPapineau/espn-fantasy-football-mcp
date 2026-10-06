// helpers.ts — an in-memory CliIo for the `eff` unit tests: captured stdout/stderr, a temp HOME with
// config/cache dirs, a fixed clock, a recording fake executor (launchctl, osascript, lsof are never
// run), a fake keyring (never the real keychain), an xattr reader that reports nothing (or what a
// test plants), and a fetch that fails the test if anything reaches the network. Ported from
// sibling @5daa625, adapted.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { KeyringPort } from "../../src/auth/keychain.js";
import type { CliIo, Exec, ExecResult } from "../../src/cli/io.js";
import type { XattrReader } from "../../src/config/paths.js";
import { fixedClock, type FixedClock } from "../../src/domain/clock.js";
import type { FetchLike } from "../../src/http/client.js";
import { FakeKeyring } from "../auth/helpers.js";

export { FakeKeyring } from "../auth/helpers.js";

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
/** The instant every test starts at (a Tuesday in week 5 of the 2026 season). */
export const NOW = "2026-10-06T18:00:00.000Z";

/** A captured writable stream. */
export class Capture extends PassThrough {
  private chunks: string[] = [];
  constructor() {
    super();
    this.on("data", (c: Buffer) => this.chunks.push(c.toString("utf8")));
  }
  get text(): string {
    return this.chunks.join("");
  }
}

/** One recorded exec call. */
export interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
}

/** A fake executor: records calls; `respond` decides the result (default exit 0). */
export function fakeExec(
  respond: (c: ExecCall) => Partial<ExecResult> | Promise<Partial<ExecResult>> = () => ({}),
): {
  exec: Exec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: Exec = async (file, args) => {
    const c = { file, args: [...args] };
    calls.push(c);
    const r = await respond(c);
    return {
      code: r.code === undefined ? 0 : r.code,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };
  return { exec, calls };
}

/** A fetch that throws — offline code must never call it. */
export const noNetwork: FetchLike = () => {
  throw new Error("network access in a test");
};

/** A fetch that records URLs and answers from `route` (default 404). */
export function fakeFetch(
  route: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    new Response(null, { status: 404 }),
): { fetch: FetchLike; urls: string[]; inits: RequestInit[] } {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  return {
    urls,
    inits,
    fetch: async (url, init) => {
      urls.push(url);
      inits.push(init);
      return route(url, init);
    },
  };
}

/** An xattr reader: no attributes, or `marks` (path → names) for the listed paths. */
export function fakeXattr(marks: Readonly<Record<string, readonly string[]>> = {}): XattrReader {
  return (paths) => new Map(paths.map((p) => [p, marks[p] ?? []]));
}

/** A temp sandbox: HOME, config and cache dirs (not created unless asked), cleanup. */
export interface Sandbox {
  readonly dir: string;
  readonly home: string;
  readonly configDir: string;
  readonly cacheDir: string;
  cleanup(): void;
}

/** Creates a sandbox under the OS temp dir (realpath'd; 0700). */
export function sandbox(opts: { create?: boolean } = {}): Sandbox {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-cli-")));
  chmodSync(dir, 0o700);
  const home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  const configDir = path.join(dir, "config");
  const cacheDir = path.join(dir, "cache");
  if (opts.create === true) {
    mkdirSync(configDir, { mode: 0o700 });
    mkdirSync(cacheDir, { mode: 0o700 });
  }
  return {
    dir,
    home,
    configDir,
    cacheDir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let pkgCounter = 0;
/** A fake package root with a built `dist/cli.js` (print-config, install-launchd). */
export function fakePackage(sb: Sandbox, opts: { built?: boolean } = {}): string {
  pkgCounter++;
  const root = path.join(sb.dir, `pkg${String(pkgCounter)}`);
  mkdirSync(path.join(root, "dist"), { recursive: true });
  if (opts.built !== false)
    writeFileSync(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
  return root;
}

/** The io under test. */
export interface TestIo extends CliIo {
  readonly out: Capture;
  readonly err: Capture;
  readonly clock: FixedClock;
  readonly keyring: FakeKeyring;
}

/** An io over a sandbox. `env` is merged over EFF_CONFIG_DIR/EFF_CACHE_DIR pointing into it. */
export function makeIo(
  sb: Sandbox,
  over: Partial<Omit<CliIo, "stdout" | "stderr" | "clock">> & {
    clock?: FixedClock;
    keyring?: FakeKeyring;
  } = {},
): TestIo {
  const out = new Capture();
  const err = new Capture();
  const keyring = over.keyring ?? new FakeKeyring();
  const env = { EFF_CONFIG_DIR: sb.configDir, EFF_CACHE_DIR: sb.cacheDir, ...(over.env ?? {}) };
  const loadKeyring: () => Promise<KeyringPort> = () => Promise.resolve(keyring);
  return {
    home: sb.home,
    stdin: new PassThrough(),
    platform: "linux",
    exec: fakeExec().exec,
    fetch: noNetwork,
    loadKeyring,
    xattr: fakeXattr(),
    packageRoot: ROOT,
    execPath: process.execPath,
    nodeVersion: "24.21.0",
    uid: 501,
    pid: 4242,
    ...over,
    env,
    stdout: out,
    stderr: err,
    out,
    err,
    keyring,
    clock: over.clock ?? fixedClock(NOW),
  };
}

/** A JSON response. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** A fixed clock that moves `stepMs` forward on every read (the 1/s limiter window never blocks). */
export function movingClock(start: string = NOW, stepMs = 1100): FixedClock {
  const c = fixedClock(start);
  return {
    nowMs: () => {
      c.advance(stepMs);
      return c.nowMs();
    },
    nowIso: () => new Date(c.nowMs()).toISOString(),
    advance: (ms) => {
      c.advance(ms);
    },
    set: (at) => {
      c.set(at);
    },
  };
}
