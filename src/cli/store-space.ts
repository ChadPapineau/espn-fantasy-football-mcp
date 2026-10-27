// store-space.ts — how much of store.sqlite is data, and when `eff prune` gives the rest back (plan 03
// §5 #5 "store size", plan 06 §1.3 `store prune` "freed space"). ONE predicate, `reclaimDue`, decides
// both whether a prune reclaims the space (VACUUM, then a TRUNCATE checkpoint) and whether doctor row
// 5 says it does, so the doctor never gives advice a prune ignores (Stage C finding
// store-never-vacuumed: prune reclaimed only at ≥ 8 MiB and ≥ 20 % free pages while the doctor
// promised a reclaim from 1 MiB on, and warned "store file > 500 MB, most of it free pages — `eff
// prune` reclaims them" for a file with 5.8 % free pages, which every prune then left alone).
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Store size above this warns (plan 03 §5 #5). */
export const MAX_STORE_BYTES = 500 * 1024 ** 2;
/** A routine prune reclaims only when the free pages are at least this many bytes … */
export const RECLAIM_MIN_FREE_BYTES = 8 * 1024 ** 2;
/** … and at least this share of the pages (a VACUUM rewrites every live page). */
export const RECLAIM_MIN_FREE_SHARE = 0.2;

/** The store's pages, and its size on disk. */
export interface StoreSpace {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freePages: number;
  /** store.sqlite plus store.sqlite-wal, in bytes. */
  readonly fileBytes: number;
}

/** The bytes the store's rows take (every page but the free ones). */
export const liveBytes = (s: StoreSpace): number => (s.pageCount - s.freePages) * s.pageSize;
/** The bytes of the free pages (a DELETE's pages go to the freelist; auto_vacuum is off). */
export const freeBytes = (s: StoreSpace): number => s.freePages * s.pageSize;

/** store.sqlite plus its write-ahead log, in bytes (a part that does not exist counts 0). */
export function storeFileBytes(file: string): number {
  let n = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      n += statSync(f).size;
    } catch {
      // no -wal right after a TRUNCATE checkpoint or the last close
    }
  }
  return n;
}

/** The page counts on an open connection, or null when SQLite answers something unusable. */
export function readStoreSpace(db: DatabaseSync, file: string): StoreSpace | null {
  const n = (pragma: string): number => {
    const r = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
    const v = r === undefined ? undefined : Object.values(r)[0];
    return typeof v === "number" ? v : Number(v ?? NaN);
  };
  const pageSize = n("page_size");
  const pageCount = n("page_count");
  const freePages = n("freelist_count");
  if (
    ![pageSize, pageCount, freePages].every((x) => Number.isInteger(x) && x >= 0) ||
    freePages > pageCount
  )
    return null;
  return { pageSize, pageCount, freePages, fileBytes: storeFileBytes(file) };
}

/** The page counts on a read-only connection of its own, or null. */
export function measureStoreSpace(file: string): StoreSpace | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return readStoreSpace(db, file);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Whether `eff prune` gives the space back now: routinely when the free pages are at least
 * RECLAIM_MIN_FREE_BYTES and RECLAIM_MIN_FREE_SHARE of the pages, and always when the file is over
 * the size limit while the data in it is not — the state doctor row 5 warns about, which only a
 * reclaim clears.
 */
export function reclaimDue(s: StoreSpace, maxStoreBytes = MAX_STORE_BYTES): boolean {
  if (s.pageCount <= 0) return false;
  if (s.fileBytes > maxStoreBytes && liveBytes(s) <= maxStoreBytes) return true;
  return (
    freeBytes(s) >= RECLAIM_MIN_FREE_BYTES && s.freePages / s.pageCount >= RECLAIM_MIN_FREE_SHARE
  );
}

const mb = (n: number): string => String(Math.round(n / 1024 ** 2));

/**
 * Doctor row 5's lines about space: whether the row warns, and the details. A line that says
 * `eff prune` reclaims something is written only when `reclaimDue` holds, so a prune does it.
 */
export function storeSpaceNotes(
  s: StoreSpace,
  maxStoreBytes = MAX_STORE_BYTES,
): { readonly warn: boolean; readonly details: readonly string[] } {
  const live = liveBytes(s);
  const free = freeBytes(s);
  const due = reclaimDue(s, maxStoreBytes);
  const details: string[] = [];
  if (free >= 1024 ** 2)
    details.push(
      due
        ? `${mb(free)} MB of the file are free pages (\`eff prune\` reclaims them)`
        : `${mb(free)} MB of the file are free pages (later writes reuse them; \`eff prune\` reclaims them once they are ${mb(RECLAIM_MIN_FREE_BYTES)} MB and ${String(RECLAIM_MIN_FREE_SHARE * 100)} % of the file)`,
    );
  if (live > maxStoreBytes) {
    details.push(
      `store holds ${mb(live)} MB of data > ${mb(maxStoreBytes)} MB — \`eff prune\` removes what is past its limits`,
    );
    return { warn: true, details };
  }
  if (s.fileBytes > maxStoreBytes) {
    // reclaimDue holds here: the file is over the limit and its data is not
    details.push(
      `store file ${mb(s.fileBytes)} MB > ${mb(maxStoreBytes)} MB with ${mb(live)} MB of data — \`eff prune\` reclaims the other ${mb(s.fileBytes - live)} MB`,
    );
    return { warn: true, details };
  }
  return { warn: false, details };
}
