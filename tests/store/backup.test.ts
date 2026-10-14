// backup.test.ts — consistent backups (plan 03 L7 / §7; T-15(b); plan 06 §1.3 `store backup`): VACUUM
// INTO a fresh 0600 file under the process lock, including another process's committed rows that
// live only in its WAL; an existing destination is refused; a held lock is waited for; weekly paths
// and their keep-4 retention (a new name always ranks newest, so no backup is deleted by its own
// rotation); and the process lock itself (exclusive, stale/dead holders broken).
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
import fc from "fast-check";
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

  // Stage C, store-backup-rotation-deletes-newest: `eff backup` names the file, writes it, then
  // rotates (src/cli/maintenance.ts: weeklyBackupPath → Store.backup → pruneWeeklyBackups). Once the
  // rotation had deleted the day's bare-named first backup, the next same-day run took the bare name
  // again; the bare name ranks as the day's FIRST, so that run's own rotation deleted the copy it had
  // just written and the command still reported success. A new name now always ranks newest, or the
  // backup is refused before anything is written.
  const listing = (): string[] => {
    try {
      return readdirSync(t.backupDir).sort();
    } catch {
      return [];
    }
  };
  /** One `eff backup` without the store (a placeholder file): name, write, rotate. */
  const backupOnce = (nowMs: number): string => {
    mkdirSync(t.backupDir, { recursive: true, mode: 0o700 });
    const dest = weeklyBackupPath(t.backupDir, nowMs);
    writeFileSync(dest, "x", { mode: 0o600, flag: "wx" });
    pruneWeeklyBackups(t.backupDir);
    return path.basename(dest);
  };

  it("six same-day `eff backup` runs through Store.backup: each survives its own rotation, the newest four remain", async () => {
    const t0 = Date.parse("2026-10-11T14:00:00.000Z");
    mkdirSync(t.backupDir, { recursive: true, mode: 0o700 });
    const written: string[] = [];
    const removedPerRun: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const dest = weeklyBackupPath(t.backupDir, t0 + i * 1000);
      const res = await s.backup(dest); // VACUUM INTO under the process lock, as the CLI runs it
      expect(res.path).toBe(dest);
      const removed = pruneWeeklyBackups(t.backupDir);
      removedPerRun.push(removed);
      const name = path.basename(dest);
      written.push(name);
      // the copy this run reported writing is still there after its own rotation
      expect(removed, `run ${String(i + 1)}`).not.toContain(name);
      expect(existsSync(dest), `run ${String(i + 1)}`).toBe(true);
      expect(rowsIn(dest)).toBe(0); // a complete database, readable on its own
    }
    expect(written[0]).toBe("store-2026-10-11.sqlite");
    expect(new Set(written).size).toBe(6); // the bare name is never taken back
    expect(listing()).toEqual(written.slice(2).sort());
    // runs 5 and 6 each rotated out exactly the oldest copy
    expect(removedPerRun.slice(4)).toEqual([[written[0]], [written[1]]]);
  });

  it("a same-day clock that reads earlier still names a backup newer than the day's others", () => {
    mkdirSync(t.backupDir, { recursive: true, mode: 0o700 });
    const late = Date.parse("2026-10-11T20:00:00.000Z");
    writeFileSync(path.join(t.backupDir, "store-2026-10-11.sqlite"), "x", { mode: 0o600 });
    writeFileSync(path.join(t.backupDir, `store-2026-10-11-${String(late)}.sqlite`), "x", {
      mode: 0o600,
    });
    expect(weeklyBackupPath(t.backupDir, late - 60_000)).toBe(
      path.join(t.backupDir, `store-2026-10-11-${String(late + 1)}.sqlite`),
    );
    // a suffix no newer name can follow is refused, never written and then pruned
    writeFileSync(path.join(t.backupDir, "store-2026-10-11-9999999999999999.sqlite"), "x", {
      mode: 0o600,
    });
    expect(() => weeklyBackupPath(t.backupDir, late)).toThrow(RangeError);
    // the next day is unaffected; an unreadable directory names the bare file
    expect(weeklyBackupPath(t.backupDir, Date.parse("2026-10-12T01:00:00.000Z"))).toBe(
      path.join(t.backupDir, "store-2026-10-12.sqlite"),
    );
    const absent = path.join(t.backupDir, "absent");
    expect(weeklyBackupPath(absent, late)).toBe(path.join(absent, "store-2026-10-11.sqlite"));
    expect(() => weeklyBackupPath(t.backupDir, Number.NaN)).toThrow(RangeError);
  });

  it("a clock behind a backup already taken (a later-dated one exists): refused, nothing written or deleted", () => {
    mkdirSync(t.backupDir, { recursive: true, mode: 0o700 });
    const future = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
    for (const d of future)
      writeFileSync(path.join(t.backupDir, `store-${d}.sqlite`), "x", { mode: 0o600 });
    const before = listing();
    // the bare name for 2026-10-11 would rank below four newer copies: its own rotation would
    // delete it — so no name is offered at all
    expect(() => weeklyBackupPath(t.backupDir, Date.parse("2026-10-11T14:00:00.000Z"))).toThrow(
      /dated after 2026-10-11/,
    );
    expect(listing()).toEqual(before);
    expect(pruneWeeklyBackups(t.backupDir)).toEqual([]);
    // one later-dated copy is enough to refuse (a new name must rank newest, not merely survive)
    for (const d of future.slice(1)) rmSync(path.join(t.backupDir, `store-${d}.sqlite`));
    expect(() => weeklyBackupPath(t.backupDir, Date.parse("2026-10-19T23:59:59.999Z"))).toThrow(
      RangeError,
    );
    // from the later day on, names resume
    expect(weeklyBackupPath(t.backupDir, Date.parse("2026-10-20T08:00:00.000Z"))).toBe(
      path.join(
        t.backupDir,
        `store-2026-10-20-${String(Date.parse("2026-10-20T08:00:00.000Z"))}.sqlite`,
      ),
    );
    // other files in the directory never matter
    writeFileSync(path.join(t.backupDir, "store.sqlite.bak-v9"), "x", { mode: 0o600 });
    writeFileSync(path.join(t.backupDir, "store-2099-01-01.sqlite.part"), "x", { mode: 0o600 });
    expect(weeklyBackupPath(t.backupDir, Date.parse("2026-10-21T08:00:00.000Z"))).toBe(
      path.join(t.backupDir, "store-2026-10-21.sqlite"),
    );
  });

  it("property: over any run of backups — clock steps forward or back — each is refused untouched or survives its rotation; the newest four written remain", () => {
    const day0 = Date.parse("2026-09-06T00:00:00.000Z");
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dayStep: fc.integer({ min: -1, max: 2 }),
            msInDay: fc.integer({ min: 0, max: 86_399_999 }),
          }),
          { minLength: 1, maxLength: 14 },
        ),
        (runs) => {
          rmSync(t.backupDir, { recursive: true, force: true });
          let day = 0;
          let newestDay = -Infinity;
          const written: string[] = [];
          for (const r of runs) {
            day += r.dayStep;
            const nowMs = day0 + day * 86_400_000 + r.msInDay;
            const before = listing();
            let name: string;
            try {
              name = backupOnce(nowMs);
            } catch (e) {
              // refused only when a later-dated backup exists, and then nothing changed
              if (!(e instanceof RangeError) || !(newestDay > day)) return false;
              if (JSON.stringify(listing()) !== JSON.stringify(before)) return false;
              continue;
            }
            newestDay = Math.max(newestDay, day);
            written.push(name);
            if (!listing().includes(name)) return false;
          }
          return (
            new Set(written).size === written.length &&
            JSON.stringify(listing()) === JSON.stringify(written.slice(-KEEP_WEEKLY_BACKUPS).sort())
          );
        },
      ),
      { numRuns: 80 },
    );
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
