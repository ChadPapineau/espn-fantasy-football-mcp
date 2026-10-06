// backup.test.ts — consistent backups (plan 03 L7 / §7; T-15(b); plan 06 §1.3 `store backup`): VACUUM
// INTO a fresh 0600 file under the process lock, including another process's committed rows that
// live only in its WAL; an existing destination is refused; a held lock is waited for; weekly paths
// and their keep-4 retention; and the process lock itself (exclusive, stale/dead holders broken).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEEP_WEEKLY_BACKUPS,
  pruneWeeklyBackups,
  vacuumInto,
  weeklyBackupPath,
} from "../../src/store/backup.js";
import {
  acquireLock,
  acquireLockSync,
  lockPathOf,
  pidAlive,
  STALE_LOCK_MS,
  StoreLockTimeoutError,
} from "../../src/store/lock.js";
import { PathSecurityError } from "../../src/config/paths.js";
import type { Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { run } from "./helpers/spawn.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const rowsIn = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM probe_log").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("Store.backup (VACUUM INTO under the process lock)", () => {
  it("includes another process's committed rows that live only in its WAL; the file is 0600", async () => {
    const child = run("wal-writer.mjs", [t.storePath, "250"]);
    await child.waitFor(/^READY/);
    const dest = path.join(t.backupDir, "store-2026-10-06.sqlite");
    const res = await s.backup(dest);
    expect(res).toEqual({
      path: dest,
      bytes: statSync(dest).size,
      taken_at: "2026-10-06T12:00:00.000Z",
    });
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(rowsIn(dest)).toBe(250);
    child.proc.stdin?.end();
    expect(await child.exited()).toBe(0);
    // the backup is a complete, self-contained database (no -wal needed)
    expect(existsSync(`${dest}-wal`)).toBe(false);
    expect(existsSync(lockPathOf(t.storePath))).toBe(false);
  });

  it("refuses an existing destination, a relative one, and a symlinked backup dir", async () => {
    const dest = path.join(t.backupDir, "taken.sqlite");
    mkdirSync(t.backupDir, { recursive: true, mode: 0o700 });
    writeFileSync(dest, "keep me", { mode: 0o600 });
    await expect(s.backup(dest)).rejects.toThrow(/already exists/);
    await expect(s.backup("relative.sqlite")).rejects.toThrow(PathSecurityError);
    const real = path.join(t.root, "real-backups");
    mkdirSync(real, { mode: 0o700 });
    const link = path.join(t.root, "linked-backups");
    symlinkSync(real, link);
    await expect(s.backup(path.join(link, "x.sqlite"))).rejects.toThrow(PathSecurityError);
  });

  it("waits for a lock held by a live process, then proceeds once it is released", async () => {
    writeFileSync(lockPathOf(t.storePath), `${String(process.pid)} 2026-10-06T12:00:00.000Z\n`, {
      mode: 0o600,
    });
    setTimeout(() => {
      rmSync(lockPathOf(t.storePath), { force: true });
    }, 200);
    const t0 = Date.now();
    const res = await s.backup(path.join(t.backupDir, "after-wait.sqlite"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(res.bytes).toBeGreaterThan(0);
  });

  it("a failed VACUUM INTO removes its partial destination", () => {
    const db = new DatabaseSync(":memory:");
    db.close();
    const dest = path.join(t.root, "never.sqlite");
    expect(() => {
      vacuumInto(db, dest, null);
    }).toThrow();
    expect(existsSync(dest)).toBe(false);
  });

  it("after close, backup is refused", async () => {
    s.close();
    await expect(s.backup(path.join(t.backupDir, "late.sqlite"))).rejects.toThrow(/closed/);
    s = openStore(t);
  });
});

describe("weekly backups (keep 4)", () => {
  it("names by UTC date with a same-day suffix and keeps the newest four", () => {
    mkdirSync(t.backupDir, { recursive: true, mode: 0o700 });
    const day = Date.parse("2026-10-04T03:10:00.000Z");
    expect(weeklyBackupPath(t.backupDir, day)).toBe(
      path.join(t.backupDir, "store-2026-10-04.sqlite"),
    );
    for (const d of ["2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04"])
      writeFileSync(path.join(t.backupDir, `store-${d}.sqlite`), "x", { mode: 0o600 });
    expect(weeklyBackupPath(t.backupDir, day)).toBe(
      path.join(t.backupDir, `store-2026-10-04-${String(day)}.sqlite`),
    );
    writeFileSync(path.join(t.backupDir, `store-2026-10-04-${String(day)}.sqlite`), "x", {
      mode: 0o600,
    });
    writeFileSync(path.join(t.backupDir, "store.sqlite.bak-v1"), "x", { mode: 0o600 });
    expect(KEEP_WEEKLY_BACKUPS).toBe(4);
    expect(pruneWeeklyBackups(t.backupDir)).toEqual([
      "store-2026-09-06.sqlite",
      "store-2026-09-13.sqlite",
    ]);
    expect(readdirSync(t.backupDir).sort()).toEqual([
      "store-2026-09-20.sqlite",
      "store-2026-09-27.sqlite",
      `store-2026-10-04-${String(day)}.sqlite`,
      "store-2026-10-04.sqlite",
      "store.sqlite.bak-v1",
    ]);
    expect(() => pruneWeeklyBackups(t.backupDir, 0)).toThrow(RangeError);
    expect(pruneWeeklyBackups(path.join(t.backupDir, "absent"))).toEqual([]);
  });
});

describe("the process lock", () => {
  it("is exclusive: a second acquirer times out while a live holder keeps it", async () => {
    const lock = lockPathOf(t.storePath);
    const held = acquireLockSync(lock);
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    expect(() => acquireLockSync(lock, 100)).toThrow(StoreLockTimeoutError);
    await expect(acquireLock(lock, 100)).rejects.toThrow(StoreLockTimeoutError);
    held.release();
    held.release(); // idempotent
    acquireLockSync(lock).release();
  });

  it("breaks a lock whose pid is dead, a stale one, and a symlinked one", async () => {
    const lock = lockPathOf(t.storePath);
    writeFileSync(lock, "999999999 2026-01-01T00:00:00.000Z\n", { mode: 0o600 });
    acquireLockSync(lock, 200).release();
    writeFileSync(lock, "garbage", { mode: 0o600 });
    (await acquireLock(lock, 200)).release();
    // a live holder whose lock is older than STALE_LOCK_MS
    writeFileSync(lock, `${String(process.pid)} x\n`, { mode: 0o600 });
    const { utimesSync } = await import("node:fs");
    const old = (Date.now() - STALE_LOCK_MS - 5000) / 1000;
    utimesSync(lock, old, old);
    acquireLockSync(lock, 200).release();
    symlinkSync(path.join(t.root, "nowhere"), lock);
    acquireLockSync(lock, 200).release();
    expect(existsSync(lock)).toBe(false);
  });

  it("pidAlive", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
    expect(pidAlive(999_999_999)).toBe(false);
  });
});
