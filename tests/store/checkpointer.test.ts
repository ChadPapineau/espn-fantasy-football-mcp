// checkpointer.test.ts — the stdio server's WAL checkpoints run on a worker thread, never inside a
// commit on the event loop (src/store/checkpointer.ts; plan 01 §5.1; plan 03 §1.2; plan 10 A16a —
// the Linux CI latency stall of round 4: the commit that took the log past 1 000 frames ran the
// checkpoint's copy and two syncs on the server's thread, 50–84 ms with ~9 ms of its CPU). The
// server's connection runs no checkpoint however far its log grows; the worker checkpoints at
// SQLite's own threshold with a connection of its own, PASSIVE (never the writer lock), and a worker
// that cannot start or fails hands checkpoints back. eff serve opens its store this way; the CLI's
// stores keep SQLite's own. No network.
import { openSync, readSync, closeSync, existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve } from "../../src/cli/serve.js";
import {
  CHECKPOINT_WORKER_SOURCE,
  WAL_CHECKPOINT_FRAMES,
  startCheckpointer,
  walFramesPending,
} from "../../src/store/checkpointer.js";
import { storeFactory } from "../../src/store/index.js";
import { storeInternalsOf } from "../../src/store/store.js";
import type { Store, StoreFactory, StoreOpenOptions } from "../../src/store/types.js";
import { ESPN_FIXTURES, ROOT, T0, runningClock } from "../mcp/helpers/world.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let stores: Store[];
beforeEach(() => {
  t = tempCache("eff-ckpt-");
  stores = [];
});
afterEach(() => {
  for (const s of stores) s.close();
  t.cleanup();
});

/** Frames of the store's WAL not yet in the store file (the WAL-index header in -shm). */
function pending(): number | null {
  const shm = `${t.storePath}-shm`;
  if (!existsSync(shm)) return null;
  const fd = openSync(shm, "r");
  try {
    const buf = Buffer.alloc(100);
    return readSync(fd, buf, 0, 100, 0) < 100 ? null : walFramesPending(buf);
  } finally {
    closeSync(fd);
  }
}

/** Commits about `frames` WAL frames through the server's own connection, one row a commit. */
function writeFrames(s: Store, frames: number): void {
  const db = storeInternalsOf(s)?.db;
  if (db === undefined) throw new Error("no internals");
  db.exec("CREATE TABLE IF NOT EXISTS ckpt_probe (id INTEGER PRIMARY KEY, b BLOB)");
  // a 3 000-byte blob fills a page of its own: each commit writes ~2 frames (the row's page, the
  // table's root), so frames / 2 commits pass `frames`
  const ins = db.prepare("INSERT INTO ckpt_probe (b) VALUES (randomblob(3000))");
  for (let i = 0; i < Math.ceil(frames / 2); i++) ins.run();
}

async function until<T>(f: () => T | null | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const autocheckpoint = (s: Store): number => {
  const db = storeInternalsOf(s)?.db;
  const r = db?.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number };
  return r.wal_autocheckpoint;
};

describe("walFramesPending: the WAL-index header's mxFrame less nBackfill", () => {
  it("reads both counters in the host's byte order; a short header is unread", () => {
    const buf = Buffer.alloc(136);
    const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    const put = (at: number, v: number) =>
      le ? buf.writeUInt32LE(v, at) : buf.writeUInt32BE(v, at);
    put(16, 1500);
    put(96, 400);
    expect(walFramesPending(buf)).toBe(1100);
    put(96, 1500);
    expect(walFramesPending(buf)).toBe(0);
    // a torn read (nBackfill past mxFrame) reads as nothing pending, never a negative count
    put(96, 1600);
    expect(walFramesPending(buf)).toBe(0);
    expect(walFramesPending(buf.subarray(0, 99))).toBeNull();
  });
});

describe("the server's store: its connection never checkpoints, the worker does", () => {
  it("a log past 1 000 frames stays whole on the server's connection; the worker's PASSIVE checkpoint copies it", async () => {
    // the worker's own poll is off: only an asked checkpoint runs, so what the server's connection
    // did is seen alone
    const s = openStore(t, { offThreadCheckpoint: true }, { checkpointer: { pollMs: 3_600_000 } });
    stores.push(s);
    expect(autocheckpoint(s)).toBe(0);
    writeFrames(s, 2 * WAL_CHECKPOINT_FRAMES);
    // SQLite's own auto-checkpoint (wal_autocheckpoint 1000) copied the log inside the commit that
    // passed 1 000 frames: here every frame is still pending
    const before = pending();
    expect(before, "the WAL-index header").not.toBeNull();
    expect(before).toBeGreaterThanOrEqual(2 * WAL_CHECKPOINT_FRAMES - 10);
    const cp = storeInternalsOf(s)?.checkpointer;
    expect(cp).toBeTruthy();
    const r = await cp?.checkpointNow();
    expect(r).not.toBeNull();
    expect(r?.busy).toBe(0);
    expect(r?.checkpointed).toBe(r?.log);
    expect(pending()).toBe(0);
    expect(cp?.stats().fellBack).toBe(false);
    // the server's writes go on after it, and nothing is lost through a close and a reopen
    writeFrames(s, 20);
    const db = storeInternalsOf(s)?.db;
    const n = (db?.prepare("SELECT COUNT(*) AS n FROM ckpt_probe").get() as { n: number }).n;
    s.close();
    stores = [];
    const again = openStore(t);
    stores.push(again);
    const db2 = storeInternalsOf(again)?.db;
    expect((db2?.prepare("SELECT COUNT(*) AS n FROM ckpt_probe").get() as { n: number }).n).toBe(n);
  }, 30_000);

  it("the worker checkpoints on its own once the log passes the threshold", async () => {
    const s = openStore(t, { offThreadCheckpoint: true }, { checkpointer: { pollMs: 10 } });
    stores.push(s);
    const cp = storeInternalsOf(s)?.checkpointer;
    // a log ~1.3 thresholds long: the worker, beside the writes, copies it once it passes 1 000
    // frames (once or twice), and what is left is under the threshold
    writeFrames(s, Math.round(1.3 * WAL_CHECKPOINT_FRAMES));
    await until(
      () =>
        (cp?.stats().checkpoints ?? 0) > 0 && (pending() ?? Infinity) < WAL_CHECKPOINT_FRAMES
          ? true
          : null,
      10_000,
      "a checkpoint",
    );
    expect(cp?.stats().last?.busy).toBe(0);
    // a barrier, not a pause: the worker's messages arrive in order, so the reply to an asked
    // checkpoint comes after every threshold checkpoint it ran before (a second one of the long
    // log, posted while a loaded main thread had not yet read it, was counted after `runs` and
    // failed this test under the full suite's load), and the log is empty after it
    expect((await cp?.checkpointNow())?.busy).toBe(0);
    // under the threshold it waits: nothing more is copied, however many polls pass
    const runs = cp?.stats().checkpoints ?? 0;
    const left = pending();
    writeFrames(s, 40);
    await new Promise((r) => setTimeout(r, 150));
    expect(cp?.stats().checkpoints).toBe(runs);
    expect(pending()).toBeGreaterThanOrEqual((left ?? 0) + 1);
    expect(cp?.stats().fellBack).toBe(false);
  }, 30_000);

  it("a CLI store keeps SQLite's own checkpoints (no worker)", () => {
    const s = openStore(t);
    stores.push(s);
    expect(autocheckpoint(s)).toBe(WAL_CHECKPOINT_FRAMES);
    expect(storeInternalsOf(s)?.checkpointer).toBeNull();
    writeFrames(s, 2 * WAL_CHECKPOINT_FRAMES);
    expect(pending()).toBeLessThan(WAL_CHECKPOINT_FRAMES);
  });

  it("a worker that cannot start, or fails, hands the checkpoints back to the connection, said once", async () => {
    const codes: string[] = [];
    const s = openStore(
      t,
      { offThreadCheckpoint: true, onWarning: (c) => codes.push(c) },
      {
        checkpointer: {
          spawn: () => {
            throw new Error("no worker");
          },
        },
      },
    );
    stores.push(s);
    expect(autocheckpoint(s)).toBe(WAL_CHECKPOINT_FRAMES);
    expect(storeInternalsOf(s)?.checkpointer?.stats().fellBack).toBe(true);
    expect(await storeInternalsOf(s)?.checkpointer?.checkpointNow()).toBeNull();
    expect(codes).toEqual(["checkpoint_worker_failed"]);
    // a worker that says it failed (its connection could not open), and one that exits
    for (const code of [
      `require("node:worker_threads").parentPort.postMessage({ kind: "failed", reason: "open" });`,
      `process.exit(3);`,
    ]) {
      const t2 = tempCache("eff-ckpt-");
      try {
        const reasons: string[] = [];
        const s2 = openStore(
          t2,
          { offThreadCheckpoint: true },
          {
            checkpointer: {
              spawn: () => new Worker(code, { eval: true }),
              onFallback: (r) => reasons.push(r),
            },
          },
        );
        await until(
          () => (storeInternalsOf(s2)?.checkpointer?.stats().fellBack === true ? true : null),
          10_000,
          "the fallback",
        );
        const db = storeInternalsOf(s2)?.db;
        expect(
          (db?.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number })
            .wal_autocheckpoint,
        ).toBe(WAL_CHECKPOINT_FRAMES);
        s2.close();
      } finally {
        t2.cleanup();
      }
    }
  }, 30_000);

  it("startCheckpointer: a stopped checkpointer answers null and never falls back; the worker's code reads only builtins", async () => {
    const s = openStore(t);
    stores.push(s);
    const db = storeInternalsOf(s)?.db;
    if (db === undefined) throw new Error("no internals");
    const reasons: string[] = [];
    const cp = startCheckpointer(db, t.storePath, { onFallback: (r) => reasons.push(r) });
    expect(autocheckpoint(s)).toBe(0);
    cp.stop();
    cp.stop();
    expect(await cp.checkpointNow()).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(reasons).toEqual([]);
    expect(cp.stats().fellBack).toBe(false);
    // the worker's text: node builtins only, one statement, never a write
    const requires = [...CHECKPOINT_WORKER_SOURCE.matchAll(/require\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(new Set(requires)).toEqual(new Set(["node:worker_threads", "node:sqlite", "node:fs"]));
    const sql = [...CHECKPOINT_WORKER_SOURCE.matchAll(/(?:prepare|exec)\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect([...sql].sort()).toEqual([
      "PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0",
      "PRAGMA wal_checkpoint(PASSIVE)",
    ]);
  });
});

describe("eff serve opens its store with the off-thread checkpointer", () => {
  it("the factory is asked for offThreadCheckpoint, and the server's connection runs no checkpoint", async () => {
    const seen: StoreOpenOptions[] = [];
    const opened: Store[] = [];
    const factory: StoreFactory = {
      ...storeFactory,
      open: (o) => {
        seen.push(o);
        const st = storeFactory.open(o);
        opened.push(st);
        return st;
      },
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.resume();
    stderr.resume();
    const env = {
      HOME: t.root,
      ESPN_LEAGUE_ID: "0",
      ESPN_SEASON: "2026",
      EFF_CONFIG_DIR: `${t.root}/config`,
      EFF_CACHE_DIR: t.cache,
      EFF_FIXTURE_DIR: ESPN_FIXTURES,
    };
    const code = serve(
      { argv: [], env, stdin, stdout, stderr },
      { clock: runningClock(T0), signals: false, packageRoot: ROOT, factory },
    );
    await until(() => (opened.length > 0 ? true : null), 10_000, "the store");
    const st = opened[0];
    if (st === undefined) throw new Error("no store");
    expect(seen[0]?.offThreadCheckpoint).toBe(true);
    expect(autocheckpoint(st)).toBe(0);
    expect(storeInternalsOf(st)?.checkpointer?.stats().fellBack).toBe(false);
    stdin.end();
    expect(await code).toBe(0);
  }, 30_000);
});
