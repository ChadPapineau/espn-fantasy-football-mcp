#!/usr/bin/env node
// @ts-check
// eval-server.mjs — how every `claude plugin eval` server of the Lane 2 suite starts (plan 09 §5.2;
// plan 10 B15; build-plugin-evals.mjs writes it into each eval plugin's .mcp.json). A run of a case
// is one `claude -p` session, which starts its plugin's servers once; each start here gets a FRESH
// COPY of the plugin's pristine state — `<state>/{home,config,cache}`, written by the build and by
// `--seed` (the recorded log, the drifted view already read) — in a new temp directory outside every
// git tree, then runs `dist/cli.js serve` there in fixture mode under the no-socket preload, and
// removes the copy when the server exits. So every run of every case starts from the state its
// expected output describes, whatever an earlier run logged, and no run can change what a later one
// sees (before this, one state directory per plugin was shared by every run and case, so results
// depended on their order).
//
// Usage (generated; the env is the server's, minus its state directories):
//   node --import <repo>/tests/e2e/fixtures/no-socket.cjs eval-server.mjs --state <dir> --root <repo>
// stdin/stdout are the server's own (the MCP stdio transport, inherited): this process never writes
// to stdout. Exit: the server's code (128 + n when a signal ended it); 2 on a usage or state problem.
// Zero dependencies (Node built-ins and ./_lib.mjs).
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { isMain } from "./_lib.mjs";

/** The state directories a server owns (each 0700), and the env keys that point at them. */
export const STATE_DIRS = Object.freeze({
  home: "HOME",
  config: "EFF_CONFIG_DIR",
  cache: "EFF_CACHE_DIR",
});
/** The no-socket preload the server runs under (a network attempt ends it, exit 98). */
export const NO_SOCKET = "tests/e2e/fixtures/no-socket.cjs";
/** The prefix of every per-start copy (under the OS temp directory). */
export const COPY_PREFIX = "eff-eval-run-";
/** The exit code of a usage or state problem. */
export const USAGE_EXIT = 2;

/**
 * The first ancestor of `dir` (itself included) holding a `.git` entry, or null — the server refuses
 * a config or cache directory inside a git working tree (src/config/paths.ts).
 * @param {string} dir
 * @returns {string | null}
 */
export function gitTreeOf(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * Parse `--state <dir> --root <repo>`; null on anything else.
 * @param {readonly string[]} argv
 * @returns {{ state: string, root: string } | null}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let state;
  /** @type {string | undefined} */
  let root;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--state" && v !== undefined && state === undefined) state = path.resolve(v);
    else if (a === "--root" && v !== undefined && root === undefined) root = path.resolve(v);
    else return null;
    i++;
  }
  return state !== undefined && root !== undefined ? { state, root } : null;
}

/**
 * What is wrong with a pristine state directory, or null: it must exist outside every git tree and
 * hold the three state directories.
 * @param {string} state
 * @returns {string | null}
 */
export function stateProblem(state) {
  if (!existsSync(state) || !statSync(state).isDirectory()) return `no state directory at ${state}`;
  if (gitTreeOf(state) !== null) return "the state directory is inside a git working tree";
  for (const d of Object.keys(STATE_DIRS)) {
    const p = path.join(state, d);
    if (!existsSync(p) || !statSync(p).isDirectory()) return `the state has no ${d}/ directory`;
  }
  return null;
}

/**
 * Copy a directory tree keeping every entry's permission bits (the server refuses a state whose
 * directories are not 0700 or whose files are not 0600); a symbolic link is refused, never followed.
 * @param {string} src
 * @param {string} dst
 */
export function copyTree(src, dst) {
  const st = lstatSync(src);
  if (st.isSymbolicLink())
    throw new Error(`the state holds a symbolic link (${path.basename(src)})`);
  if (st.isDirectory()) {
    mkdirSync(dst, { mode: 0o700 });
    for (const name of readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name));
    chmodSync(dst, st.mode & 0o777);
  } else if (st.isFile()) {
    copyFileSync(src, dst);
    chmodSync(dst, st.mode & 0o777);
  }
}

/**
 * A fresh copy of the pristine state in a new temp directory, every entry's mode kept, outside
 * every git tree.
 * @param {string} state
 * @param {string} [base] where the copy goes (default: the OS temp directory)
 * @returns {string} the copy's root
 */
export function freshCopy(state, base = tmpdir()) {
  const copy = realpathSync(mkdtempSync(path.join(base, COPY_PREFIX)));
  chmodSync(copy, 0o700);
  if (gitTreeOf(copy) !== null) {
    rmSync(copy, { recursive: true, force: true });
    throw new Error("the temp directory is inside a git working tree");
  }
  try {
    for (const d of Object.keys(STATE_DIRS)) copyTree(path.join(state, d), path.join(copy, d));
  } catch (e) {
    rmSync(copy, { recursive: true, force: true });
    throw e;
  }
  return copy;
}

/**
 * The server's env for one start: the inherited env with its state directories pointed at the copy.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} copy
 * @returns {Record<string, string>}
 */
export function serverEnvFor(env, copy) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  for (const [d, key] of Object.entries(STATE_DIRS)) out[key] = path.join(copy, d);
  return out;
}

/**
 * The exit code for a child that ended with `code` or `signal`.
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 */
export function exitCodeOf(code, signal) {
  if (code !== null) return code;
  const n = signal === null ? undefined : constants.signals[signal];
  return typeof n === "number" ? 128 + n : 1;
}

/**
 * @typedef {{ on: ((ev: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown)
 *   & ((ev: "error", fn: (e: Error) => void) => unknown), kill: (sig?: NodeJS.Signals) => unknown }} ChildLike
 * @typedef {(cmd: string, args: string[], o: { env: Record<string, string>, stdio: "inherit" }) => ChildLike} SpawnLike
 */

/**
 * Run one eval server on a fresh copy of its state; resolves with the exit code once the server has
 * exited and the copy is gone.
 * @param {readonly string[]} argv
 * @param {{ env?: Readonly<Record<string, string | undefined>>, spawnImpl?: SpawnLike,
 *   node?: string, tmp?: string, stderr?: (s: string) => void,
 *   onSignal?: (sig: NodeJS.Signals, fn: () => void) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const err = deps.stderr ?? ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  if (args === null) {
    err("eval-server: usage: eval-server.mjs --state <pristine state dir> --root <repo>\n");
    return USAGE_EXIT;
  }
  const problem = stateProblem(args.state);
  if (problem !== null) {
    err(`eval-server: ${problem}\n`);
    return USAGE_EXIT;
  }
  const cli = path.join(args.root, "dist", "cli.js");
  if (!existsSync(cli)) {
    err("eval-server: dist/cli.js is missing — run `npm run build`\n");
    return USAGE_EXIT;
  }
  /** @type {string} */
  let copy;
  try {
    copy = freshCopy(args.state, deps.tmp);
  } catch (e) {
    err(`eval-server: ${e instanceof Error ? e.message : String(e)}\n`);
    return USAGE_EXIT;
  }
  const spawnImpl = deps.spawnImpl ?? /** @type {SpawnLike} */ (/** @type {unknown} */ (spawn));
  const child = spawnImpl(
    deps.node ?? process.execPath,
    ["--import", path.join(args.root, NO_SOCKET), cli, "serve"],
    { env: serverEnvFor(deps.env ?? process.env, copy), stdio: "inherit" },
  );
  const onSignal =
    deps.onSignal ??
    ((sig, fn) => {
      process.on(sig, fn);
    });
  for (const sig of /** @type {NodeJS.Signals[]} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
    onSignal(sig, () => {
      child.kill(sig);
    });
  return new Promise((resolve) => {
    let done = false;
    /** @param {number} code */
    const finish = (code) => {
      if (done) return;
      done = true;
      rmSync(copy, { recursive: true, force: true });
      resolve(code);
    };
    child.on("error", (e) => {
      err(`eval-server: the server did not start (${e.message})\n`);
      finish(1);
    });
    child.on("exit", (code, signal) => {
      finish(exitCodeOf(code, signal));
    });
  });
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
