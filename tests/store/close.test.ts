// close.test.ts — a store's and a publisher's close never wait for another connection (plan 03 §1.3
// "close with a WAL checkpoint"; plan 05 §4.2 and plan 10 A15a "stdin EOF → exit 0 within 3 s";
// Stage C finding store-close-checkpoint-blocks-exit): the closing TRUNCATE checkpoint ran under the
// connection's 5-s busy_timeout, so ANY open read transaction elsewhere — the weekly VACUUM INTO
// backup, doctor's quick_check, `eff status`, a job's read — or another process's writer lock held
// close() for the whole BUSY_TIMEOUT_MS (5.3 s measured; `eff serve` exited 5.4 s after EOF). Now it
// checkpoints what it can at once; the next opener (or the last connection's close) does the rest,
// and nothing written is lost. Without contention the WAL is still truncated at close.
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUSY_TIMEOUT_MS, type Store } from "../../src/store/types.js";
import { emptyTables, publishTables } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";
import { run, type Child } from "./helpers/spawn.js";

/** A close that waited for the busy handler would take BUSY_TIMEOUT_MS; one that does not, ms. */
const CLOSE_BOUND_MS = BUSY_TIMEOUT_MS / 5;
/** How long a holder keeps its transaction open — well past the busy timeout. */
const HOLD_MS = 3 * BUSY_TIMEOUT_MS;

let t: TempCache;
let children: Child[];
beforeEach(() => {
  t = tempCache();
  children = [];
});
afterEach(async () => {
  for (const c of children) {
    c.proc.kill("SIGKILL");
    await c.exited();
  }
  t.cleanup();
});

const AT = "2026-10-06T12:00:00.000Z";
const walBytes = (): number => {
  const wal = `${t.storePath}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
};

/** A store with committed rows still in its WAL (the frames a closing checkpoint folds in). */
function storeWithFrames(): Store {
  const s = openStore(t);
  for (let i = 0; i < 20; i++)
    s.repos.probeLog.record({
      at: AT,
      kind: "host",
      ok: true,
      status: "green",
      upstream_status: 200,
      error: null,
    });
  expect(walBytes()).toBeGreaterThan(0);
  return s;
}

function timed(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/** What a later opener reads: every row written before the busy close is there. */
function rowsAfterReopen(): number {
  const s = openStore(t, { migrate: false });
  try {
    return s.repos.probeLog.recent(50).length;
  } finally {
    s.close();
  }
}

async function spawnHolder(helper: "reader-holder.mjs" | "lock-holder.mjs"): Promise<Child> {
  const c = run(helper, [t.storePath, String(HOLD_MS)]);
  children.push(c);
  await c.waitFor(helper === "reader-holder.mjs" ? /^READING/ : /^LOCKED/);
  return c;
}

describe("close never waits for another connection (store-close-checkpoint-blocks-exit)", () => {
  it("with an open read transaction on another connection: close returns at once, nothing lost", () => {
    const s = storeWithFrames();
    const reader = new DatabaseSync(t.storePath);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM probe_log").get();
    const ms = timed(() => {
      s.close();
    });
    expect(ms).toBeLessThan(CLOSE_BOUND_MS);
    reader.exec("COMMIT");
    reader.close();
    expect(rowsAfterReopen()).toBe(20);
    // with nobody else reading, the next close folds the log in and truncates it
    expect(walBytes()).toBe(0);
  });

  it("with another PROCESS's read transaction (a backup, quick_check, eff status)", async () => {
    const s = storeWithFrames();
    await spawnHolder("reader-holder.mjs");
    const ms = timed(() => {
      s.close();
    });
    expect(ms).toBeLessThan(CLOSE_BOUND_MS);
  });

  it("with another PROCESS holding the writer lock (BEGIN IMMEDIATE)", async () => {
    const s = storeWithFrames();
    await spawnHolder("lock-holder.mjs");
    const ms = timed(() => {
      s.close();
    });
    expect(ms).toBeLessThan(CLOSE_BOUND_MS);
  });

  it("the publisher's close: the same bound behind another process's reader", async () => {
    const s = openStore(t);
    s.close();
    const pub = openPublisher(t);
    expect(
      (await publishTables(pub, "nflverse:injuries", "v1", emptyTables("nflverse:injuries"))).ok,
    ).toBe(true);
    expect(walBytes()).toBeGreaterThan(0);
    await spawnHolder("reader-holder.mjs");
    const ms = timed(() => {
      pub.close();
    });
    expect(ms).toBeLessThan(CLOSE_BOUND_MS);
  });

  it("without contention the closing checkpoint still truncates the WAL", () => {
    const s = storeWithFrames();
    s.close();
    expect(walBytes()).toBe(0);
    expect(rowsAfterReopen()).toBe(20);
  });
});
