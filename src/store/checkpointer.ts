// checkpointer.ts — the stdio server's WAL checkpoints, off the event loop (plan 01 §5.1 one store
// file in WAL mode, synchronous NORMAL; plan 03 §1.2: the loop never blocks longer than one SQLite
// statement or one ≤ 20 ms CPU batch; plan 10 A16a's ≤ 50 ms stall bound). Under WAL with
// synchronous NORMAL a commit never syncs, but the commit that takes the log past
// wal_autocheckpoint pages (1 000) runs a checkpoint inside the statement: it copies the log into
// the store file and syncs both, on the committing thread. On a disk whose fsync is slow that one
// statement held the server's event loop 50–84 ms while its thread ran ~9 ms with no involuntary
// switch (the Linux CI `process` job's latency stall, round 4; reproduced on the owner's Mac with
// `checkpoint_fullfsync`, a real flush: 14.5–15.7 ms inside one `INSERT OR REPLACE INTO
// espn_cache` in the full P1 analytics window). So the server's own connection never
// checkpoints (`wal_autocheckpoint = 0`), and a worker thread with a connection of its own runs the
// PASSIVE checkpoint SQLite's auto-checkpoint would have run, at the same threshold: PASSIVE never
// takes the writer lock and never waits (busy_timeout 0), so the main thread's writes go on while
// the worker copies and syncs. The worker reads how many frames are not yet in the store from the
// WAL-index header (sqlite.org/walformat.html §2.2: mxFrame at byte 16, nBackfill at byte 96,
// native byte order) and checkpoints at WAL_CHECKPOINT_FRAMES; when the header cannot be read it
// checkpoints on a slow cadence. A worker that cannot start or fails hands checkpointing back to the
// main connection (wal_autocheckpoint restored): the store never grows its log without bound.
// The close checkpoint stays sqlite.ts closingCheckpoint's. CLI jobs keep SQLite's own checkpoints
// (their stalls bound nothing). New here.
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";

/** The frames past which the worker checkpoints: SQLite's default wal_autocheckpoint. */
export const WAL_CHECKPOINT_FRAMES = 1000;
/** How often the worker reads the WAL-index header (ms). */
export const WAL_POLL_MS = 250;
/** How often it checkpoints when the header cannot be read (ms). */
export const WAL_FALLBACK_MS = 10_000;

/** What the checkpointer has done (diagnostics and tests). */
export interface CheckpointerStats {
  /** Checkpoints the worker ran. */
  readonly checkpoints: number;
  /** The last one's result: frames in the log, frames in the store file, busy (1) or not. */
  readonly last: {
    readonly log: number;
    readonly checkpointed: number;
    readonly busy: number;
  } | null;
  /** The worker failed and the main connection checkpoints again (wal_autocheckpoint restored). */
  readonly fellBack: boolean;
}

/** A running checkpointer. */
export interface Checkpointer {
  stats(): CheckpointerStats;
  /** Asks the worker for a checkpoint now; resolves with its result (tests, diagnostics). */
  checkpointNow(): Promise<CheckpointerStats["last"]>;
  /** Stops the worker (its connection closed); idempotent, never throws, never waits. */
  stop(): void;
}

/** How a checkpointer is started (tests shorten the poll or inject a failing worker). */
export interface CheckpointerOptions {
  readonly pollMs?: number;
  readonly thresholdFrames?: number;
  readonly fallbackMs?: number;
  /** Called once when the worker fails and the main connection takes checkpoints back. */
  readonly onFallback?: (reason: string) => void;
  /** Builds the worker (tests). */
  readonly spawn?: (source: string, data: WorkerData) => Worker;
}

/** What the worker is started with. */
export interface WorkerData {
  readonly path: string;
  readonly pollMs: number;
  readonly thresholdFrames: number;
  readonly fallbackMs: number;
}

/**
 * The frames of the WAL not yet copied into the store file, from the WAL-index header in `-shm`
 * (sqlite.org/walformat.html §2.2): mxFrame (u32 at byte 16) less nBackfill (u32 at byte 96), in
 * the host's byte order. Null when the header cannot be read (no -shm, a short read). The header is
 * read without SQLite's locks, so a torn read is possible: it only decides when to checkpoint.
 */
export function walFramesPending(buf: Uint8Array): number | null {
  if (buf.length < 100) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const mx = v.getUint32(16, le);
  const bf = v.getUint32(96, le);
  return mx >= bf ? mx - bf : 0;
}

/**
 * The worker's code (CommonJS, node builtins only, run with `eval`: the same text in the built
 * package and under the test runner, no module path to resolve). Its own connection: defensive,
 * untrusted schema, busy_timeout 0, and it only ever runs `PRAGMA wal_checkpoint(PASSIVE)`.
 */
export const CHECKPOINT_WORKER_SOURCE = `"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const { path, pollMs, thresholdFrames, fallbackMs } = workerData;
const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const head = Buffer.alloc(100);
let db = null;
let shm = null;
let lastRun = Date.now();
let timer = null;
const pending = () => {
  try {
    if (shm === null) shm = fs.openSync(path + "-shm", "r");
    if (fs.readSync(shm, head, 0, 100, 0) < 100) return null;
    const mx = le ? head.readUInt32LE(16) : head.readUInt32BE(16);
    const bf = le ? head.readUInt32LE(96) : head.readUInt32BE(96);
    return mx >= bf ? mx - bf : 0;
  } catch {
    if (shm !== null) { try { fs.closeSync(shm); } catch {} shm = null; }
    return null;
  }
};
const run = (reason) => {
  lastRun = Date.now();
  const r = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
  return { kind: "checkpointed", reason, busy: Number(r.busy), log: Number(r.log), checkpointed: Number(r.checkpointed) };
};
const stop = () => {
  if (timer !== null) clearInterval(timer);
  timer = null;
  try { if (shm !== null) fs.closeSync(shm); } catch {}
  shm = null;
  try { if (db !== null) db.close(); } catch {}
  db = null;
  parentPort.close();
};
try {
  db = new DatabaseSync(path, { timeout: 0, enableDoubleQuotedStringLiterals: false });
  db.enableDefensive(true);
  db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0");
} catch (e) {
  parentPort.postMessage({ kind: "failed", reason: "open", error: e && e.name ? String(e.name) : "unknown" });
  stop();
}
if (db !== null) {
parentPort.on("message", (m) => {
  if (m && m.kind === "stop") return stop();
  if (m && m.kind === "now" && db !== null) {
    try { parentPort.postMessage({ ...run("asked"), id: m.id }); }
    catch (e) { parentPort.postMessage({ kind: "failed", reason: "checkpoint", id: m.id, error: e && e.name ? String(e.name) : "unknown" }); }
  }
});
timer = setInterval(() => {
  if (db === null) return;
  try {
    const p = pending();
    if (p === null ? Date.now() - lastRun >= fallbackMs : p >= thresholdFrames)
      parentPort.postMessage(run(p === null ? "cadence" : "threshold"));
  } catch (e) {
    parentPort.postMessage({ kind: "failed", reason: "checkpoint", error: e && e.name ? String(e.name) : "unknown" });
    stop();
  }
}, pollMs);
parentPort.postMessage({ kind: "ready" });
}
`;

const defaultSpawn = (source: string, data: WorkerData): Worker =>
  new Worker(source, { eval: true, workerData: data });

/**
 * Starts the checkpointer for the store at `path` whose server connection is `db`: the connection's
 * own checkpoints are turned off (`wal_autocheckpoint = 0`) and the worker runs them; if the worker
 * cannot start or fails, they are turned back on (SQLite's default, WAL_CHECKPOINT_FRAMES) and
 * `onFallback` is told once. The worker never keeps the process alive.
 */
export function startCheckpointer(
  db: DatabaseSync,
  path: string,
  opts: CheckpointerOptions = {},
): Checkpointer {
  let checkpoints = 0;
  let last: CheckpointerStats["last"] = null;
  let fellBack = false;
  let stopped = false;
  let nextId = 1;
  const waiting = new Map<number, (r: CheckpointerStats["last"]) => void>();
  const fallBack = (reason: string): void => {
    if (fellBack) return;
    fellBack = true;
    try {
      db.exec(`PRAGMA wal_autocheckpoint = ${String(WAL_CHECKPOINT_FRAMES)}`);
    } catch {
      // a closed connection checkpoints nothing more
    }
    for (const done of waiting.values()) done(null);
    waiting.clear();
    try {
      opts.onFallback?.(reason);
    } catch {
      // a throwing sink never breaks the store
    }
  };
  const data: WorkerData = {
    path,
    pollMs: opts.pollMs ?? WAL_POLL_MS,
    thresholdFrames: opts.thresholdFrames ?? WAL_CHECKPOINT_FRAMES,
    fallbackMs: opts.fallbackMs ?? WAL_FALLBACK_MS,
  };
  db.exec("PRAGMA wal_autocheckpoint = 0");
  let worker: Worker | null = null;
  try {
    worker = (opts.spawn ?? defaultSpawn)(CHECKPOINT_WORKER_SOURCE, data);
    worker.unref();
  } catch {
    fallBack("spawn");
  }
  worker?.on("message", (m: unknown) => {
    const msg = m as {
      kind?: unknown;
      id?: unknown;
      reason?: unknown;
      busy?: unknown;
      log?: unknown;
      checkpointed?: unknown;
    };
    const id = typeof msg.id === "number" ? msg.id : null;
    if (msg.kind === "checkpointed") {
      checkpoints += 1;
      last = {
        log: Number(msg.log),
        checkpointed: Number(msg.checkpointed),
        busy: Number(msg.busy),
      };
      if (id !== null) {
        waiting.get(id)?.(last);
        waiting.delete(id);
      }
    } else if (msg.kind === "failed") {
      if (!stopped) fallBack(typeof msg.reason === "string" ? msg.reason : "worker");
    }
  });
  worker?.on("error", () => {
    if (!stopped) fallBack("error");
  });
  worker?.on("exit", () => {
    if (!stopped) fallBack("exit");
    for (const done of waiting.values()) done(null);
    waiting.clear();
  });
  return {
    stats: () => ({ checkpoints, last, fellBack }),
    checkpointNow: () =>
      new Promise((resolve) => {
        if (worker === null || stopped || fellBack) {
          resolve(null);
          return;
        }
        const id = nextId++;
        waiting.set(id, resolve);
        worker.postMessage({ kind: "now", id });
      }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const done of waiting.values()) done(null);
      waiting.clear();
      try {
        worker?.postMessage({ kind: "stop" });
      } catch {
        // already gone
      }
    },
  };
}
