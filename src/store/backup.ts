// backup.ts — consistent store backups (plan 03 L7 / §7; T-15(b): a file copy of a WAL database
// with another process live is not a backup): `VACUUM INTO` a fresh 0600 file — one read
// transaction, so another process's committed-but-uncheckpointed WAL rows are included — run under
// the process-wide store lock by the caller. Pre-migration backups keep the last two versions
// (plan 03 §7); the weekly `store backup` keeps four (plan 06 §1.3). Ported from sibling @cf3b015,
// adapted (VACUUM INTO only, as plan 03 §7 names it).
import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { STORE_FILE_NAME } from "../config/paths.js";
import { createPrivateFile, type StatementGuard } from "./sqlite.js";

/** Pre-migration backups of this many most recent schema versions are kept (plan 03 §7). */
export const KEEP_BACKUP_VERSIONS = 2;
/** Weekly `store backup` files kept (plan 06 §1.3 "keep 4"). */
export const KEEP_WEEKLY_BACKUPS = 4;

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `VACUUM main INTO dest`: `dest` must not exist; it is created empty and 0600 first (SQLite accepts
 * an empty file as the target), and removed again if the statement fails. The guard is lifted for
 * the statement only (VACUUM INTO attaches and writes its own temporary schema).
 */
export function vacuumInto(db: DatabaseSync, dest: string, guard: StatementGuard | null): void {
  if (exists(dest)) throw new Error("store: backup destination already exists");
  createPrivateFile(dest);
  try {
    const run = (): void => {
      db.prepare("VACUUM main INTO ?").run(dest);
    };
    if (guard === null) run();
    else guard.bypass(db, run);
  } catch (e) {
    rmSync(dest, { force: true });
    throw e;
  }
}

const PRE_RE = new RegExp(
  `^${STORE_FILE_NAME.replace(".", "\\.")}\\.bak-v(\\d{1,9})(?:-\\d{1,16})?$`,
);

/** `<backups>/store.sqlite.bak-v<old>` (a `-<ms>` suffix when one exists already). */
export function preMigrationBackupPath(backupDir: string, version: number, nowMs: number): string {
  const base = path.join(backupDir, `${STORE_FILE_NAME}.bak-v${String(version)}`);
  return exists(base) ? `${base}-${String(nowMs)}` : base;
}

/** Deletes pre-migration backups older than the newest KEEP_BACKUP_VERSIONS versions; returns names. */
export function prunePreMigrationBackups(backupDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  const byVersion = new Map<number, string[]>();
  for (const n of names) {
    const m = PRE_RE.exec(n);
    if (m?.[1] === undefined) continue;
    const v = Number.parseInt(m[1], 10);
    byVersion.set(v, [...(byVersion.get(v) ?? []), n]);
  }
  const keep = new Set([...byVersion.keys()].sort((a, b) => b - a).slice(0, KEEP_BACKUP_VERSIONS));
  const removed: string[] = [];
  for (const [v, files] of byVersion) {
    if (keep.has(v)) continue;
    for (const f of files) {
      const p = path.join(backupDir, f);
      if (lstatSync(p).isFile()) {
        rmSync(p, { force: true });
        removed.push(f);
      }
    }
  }
  return removed.sort();
}

const WEEKLY_RE = /^store-(\d{4}-\d{2}-\d{2})(?:-(\d{1,16}))?\.sqlite$/;

/** Newest first: by date, then by the same-day `-<ms>` suffix (none = the day's first). */
function weeklyNewestFirst(a: string, b: string): number {
  const ma = WEEKLY_RE.exec(a);
  const mb = WEEKLY_RE.exec(b);
  const da = ma?.[1] ?? "";
  const db = mb?.[1] ?? "";
  if (da !== db) return da < db ? 1 : -1;
  return Number(mb?.[2] ?? 0) - Number(ma?.[2] ?? 0);
}

/** `<backups>/store-<YYYY-MM-DD>.sqlite` for the UTC date of `nowMs` (a `-<ms>` suffix if taken). */
export function weeklyBackupPath(backupDir: string, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const base = path.join(backupDir, `store-${day}.sqlite`);
  return exists(base) ? path.join(backupDir, `store-${day}-${String(nowMs)}.sqlite`) : base;
}

/** Deletes weekly backups beyond the newest `keep` (by name: date, then suffix); returns names. */
export function pruneWeeklyBackups(
  backupDir: string,
  keep: number = KEEP_WEEKLY_BACKUPS,
): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError("store: keep must be ≥ 1");
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  const weekly = names.filter((n) => WEEKLY_RE.test(n)).sort(weeklyNewestFirst);
  const removed: string[] = [];
  for (const f of weekly.slice(keep)) {
    const p = path.join(backupDir, f);
    if (lstatSync(p).isFile()) {
      rmSync(p, { force: true });
      removed.push(f);
    }
  }
  return removed.sort();
}
