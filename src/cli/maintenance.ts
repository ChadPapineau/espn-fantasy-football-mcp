// maintenance.ts — `eff prune` and `eff backup` (plan 06 §1.3 `store prune` weekly Sun 03:00: cache
// rows past their hard limits, snapshots > 30 d, espn_requests past their TTL, points_cache LRU,
// dataset debris, backups beyond two versions; never the recommendation log, league_settings,
// espn_projection, scoreboard_snapshot or write_journal (T-07) — and the space the deleted rows took
// is given back: a VACUUM when the free pages are a real share of the file; `store backup` weekly
// Sun 03:10: a `VACUUM INTO` copy under the process lock, keep 4 — plan 03 §7, T-15(b)). `backup --to
// <path>` writes a NEW 0600 file the user names (never a synced folder, the checkout, or a directory
// others can write into — by mode bits or by an ACL entry — and with no ACL entry of its directory
// left on it). Ported from sibling @5daa625, adapted (src/store's pruneStore and weekly backups).
import {
  closeSync,
  constants as fsc,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  backupDir,
  ensureSecureDir,
  foreignAclEntries,
  insecureAncestors,
  locationRefusals,
  PathSecurityError,
  resolveAbsolute,
  runTempDir,
  storePath,
  stripForeignAcl,
  systemAcl,
  type AclAccess,
  type XattrReader,
} from "../config/paths.js";
import type { LenientConfig } from "../config/schema.js";
import { pruneStore, pruneWeeklyBackups, weeklyBackupPath } from "../store/index.js";
import type { StoreFactory } from "../store/types.js";
import { EXIT, UsageError } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { createNotifier } from "./notify.js";
import { errorText, openStore } from "./store-access.js";

/** `eff prune`. */
export async function prune(
  io: CliIo,
  config: LenientConfig,
  log: Logger,
  opts: { readonly notify: boolean; readonly factory?: StoreFactory },
): Promise<number> {
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  let report;
  try {
    const store = openStore(config, io.clock, log, {
      migrate: true,
      ...(opts.factory ? { factory: opts.factory } : {}),
    });
    try {
      report = pruneStore(store);
    } finally {
      store.close();
    }
  } catch (e) {
    await writeLine(
      io.stderr,
      `eff prune: ${e instanceof PathSecurityError ? `${e.name}: ${e.message}` : errorText(e)}`,
    );
    if (opts.notify) await notifier.failure("store-prune", "prune");
    return EXIT.error;
  }
  const rows = Object.entries(report.rows)
    .map(([t, n]) => `${t} ${String(n)}`)
    .join(", ");
  // the deleted rows' pages only went to the freelist (auto_vacuum is off): give them back, or the
  // file never shrinks and doctor #5's size warning outlives every prune (Stage C finding
  // store-never-vacuumed)
  const reclaimed = reclaimFreePages(storePath(config.cacheDir));
  log.info("prune.done", {
    ...report.rows,
    files_removed: report.files_removed.length,
    backups_removed: report.backups_removed.length,
    reclaim: reclaimed.status,
    ...(reclaimed.status === "reclaimed" ? { reclaimed_bytes: reclaimed.freedBytes } : {}),
  });
  await writeLine(
    io.stdout,
    `pruned rows: ${rows}; ${String(report.files_removed.length)} dataset file(s), ${String(report.backups_removed.length)} old backup(s). Never pruned: recommendation log, league settings, ESPN projections, scoreboard snapshots, write journal.`,
  );
  if (reclaimed.status === "reclaimed")
    await writeLine(
      io.stdout,
      `reclaimed ${String(Math.round(reclaimed.freedBytes / 1024 ** 2))} MB of free pages (store.sqlite ${String(Math.round(reclaimed.beforeBytes / 1024 ** 2))} → ${String(Math.round(reclaimed.afterBytes / 1024 ** 2))} MB)`,
    );
  else if (reclaimed.status === "busy")
    await writeLine(
      io.stdout,
      "free pages not reclaimed now: another process holds the store (the next `eff prune` tries again)",
    );
  return EXIT.ok;
}

/** A prune VACUUMs only when the free pages are at least this many bytes … */
export const RECLAIM_MIN_FREE_BYTES = 8 * 1024 ** 2;
/** … and at least this share of the file (a VACUUM rewrites every live page). */
export const RECLAIM_MIN_FREE_SHARE = 0.2;

/** What reclaiming the store's free pages did. */
export type ReclaimResult =
  | {
      readonly status: "reclaimed";
      readonly beforeBytes: number;
      readonly afterBytes: number;
      readonly freedBytes: number;
    }
  | { readonly status: "not_needed" | "busy" | "missing" | "error" };

function fileBytes(file: string): number {
  let n = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      n += statSync(f).size;
    } catch {
      // no -wal right after a checkpoint
    }
  }
  return n;
}

/**
 * Gives the store's free pages back to the file system (plan 06 §1.3 "freed space"): the store runs
 * with auto_vacuum off, so a prune's DELETEs only move pages to the freelist. When they are at least
 * RECLAIM_MIN_FREE_BYTES and RECLAIM_MIN_FREE_SHARE of the file, one `VACUUM` on a connection of its
 * own (busy timeout 5 s: a server or job writing meanwhile is waited for, never interrupted —
 * SQLite's own locking; a VACUUM changes no row and no INTEGER PRIMARY KEY), then a TRUNCATE
 * checkpoint. Never throws: a busy or failing store is reported, the prune itself has succeeded.
 */
export function reclaimFreePages(file: string): ReclaimResult {
  try {
    statSync(file);
  } catch {
    return { status: "missing" };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { timeout: 5_000 });
    const n = (pragma: string): number => {
      const r = db?.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
      return Number(r === undefined ? NaN : Object.values(r)[0]);
    };
    const size = n("page_size");
    const count = n("page_count");
    const free = n("freelist_count");
    if (![size, count, free].every((x) => Number.isFinite(x) && x >= 0) || count === 0)
      return { status: "error" };
    if (free * size < RECLAIM_MIN_FREE_BYTES || free / count < RECLAIM_MIN_FREE_SHARE)
      return { status: "not_needed" };
    const beforeBytes = fileBytes(file);
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const afterBytes = fileBytes(file);
    return {
      status: "reclaimed",
      beforeBytes,
      afterBytes,
      freedBytes: Math.max(0, beforeBytes - afterBytes),
    };
  } catch (e) {
    const errcode = (e as { errcode?: unknown } | null)?.errcode;
    return typeof errcode === "number" && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6)
      ? { status: "busy" }
      : { status: "error" };
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Validates a `--to` destination and returns where the file will be written: the parent resolved to
 * its real path plus the file name. The SAME location rule as the config, cache and credential paths
 * (config/paths `locationRefusals`): never inside ANY git work tree (this checkout, the owner's
 * sibling repo, a dotfiles repo — a later `git add -A` would publish the store or the export, whose
 * records carry league ids), never a synced folder by name, never a directory carrying a
 * file-provider attribute (iCloud Drive, CloudStorage clients), and never a directory others can
 * write into without the sticky bit. Every refusal is a UsageError (exit 2).
 */
export function resolveBackupDestination(
  to: string,
  home: string,
  repoRoot: string,
  xattr?: XattrReader,
  acl: AclAccess = systemAcl,
): string {
  let abs: string;
  try {
    abs = resolveAbsolute(to, home, "--to");
  } catch {
    throw new UsageError("backup: --to: the path must be absolute (or start with ~/)");
  }
  const name = path.basename(abs);
  if (to.endsWith("/") || to === "~" || name === "" || name === "." || name === "..")
    throw new UsageError("backup: --to must name a file (e.g. ~/eff-store-backup.sqlite)");
  const parent = path.dirname(abs);
  let realParent: string;
  try {
    realParent = realpathSync.native(parent);
  } catch {
    throw new UsageError(`backup: --to: the directory ${parent} does not exist; create it first`);
  }
  if (!statSync(realParent).isDirectory())
    throw new UsageError(`backup: --to: ${parent} is not a directory`);
  const dest = path.join(realParent, name);
  for (const p of [abs, dest]) {
    const refused = locationRefusals(p, {
      home,
      repoRoot,
      what: "--to",
      ...(xattr === undefined ? {} : { xattr }),
    })[0];
    if (refused !== undefined) throw new UsageError(`backup: --to: ${refused.detail}`);
  }
  if (insecureAncestors(dest).length > 0 || aclWritableAncestors(dest, acl).length > 0)
    throw new UsageError(
      `backup: --to: ${realParent} (or a directory above it) is writable by others; choose a directory only you can write to`,
    );
  return dest;
}

/**
 * The ACL permissions that let someone else put, replace, rename or remove an entry of a directory,
 * or change who may (macOS `ls -le` names; `write`/`append` are a directory's add_file and
 * add_subdirectory under their file names).
 */
const DIR_WRITE_PERMS: ReadonlySet<string> = new Set([
  "add_file",
  "add_subdirectory",
  "delete_child",
  "write",
  "append",
  "writesecurity",
  "chown",
]);

/**
 * Every directory from `dest`'s parent up to the root (the spelled and the resolved chain) whose ACL
 * lets someone else write into it: "a directory others can write into" by an ACL entry as well as by
 * mode bits (Stage C finding paths-export-destination-acl-inherited). A directory whose ACL cannot be
 * read counts (fail closed).
 */
export function aclWritableAncestors(dest: string, acl: AclAccess = systemAcl): string[] {
  const out: string[] = [];
  const walk = (start: string): void => {
    let cur = path.dirname(start);
    for (;;) {
      if (!out.includes(cur)) {
        let writable = false;
        try {
          writable = foreignAclEntries(cur, "--to", acl).some(
            (e) => e.kind !== "deny" && e.perms.some((p) => DIR_WRITE_PERMS.has(p)),
          );
        } catch {
          writable = true;
        }
        if (writable) out.push(cur);
      }
      const parent = path.dirname(cur);
      if (parent === cur) return;
      cur = parent;
    }
  };
  const abs = path.resolve(dest);
  walk(abs);
  let real = abs;
  try {
    real = path.join(realpathSync.native(path.dirname(abs)), path.basename(abs));
  } catch {
    real = abs;
  }
  if (real !== abs) walk(real);
  return out;
}

/**
 * Makes a file this program has JUST created (O_EXCL, still empty, open as `fd`) private before a
 * byte is written: an ACL entry it took from its directory (`file_inherit`) is removed, and the
 * result checked on the open file's inode. Throws (`insecure_acl`, `acl_unverifiable`) when it cannot
 * be shown private — the caller then removes the file. The 0600 mode alone is not that: an inherited
 * entry still let every account in a group read (or write) the copy (Stage C finding
 * paths-export-destination-acl-inherited).
 */
export function privatizeNewFile(fd: number, file: string, acl: AclAccess = systemAcl): void {
  const pin = fstatSync(fd);
  stripForeignAcl(file, "--to", acl);
  const left = foreignAclEntries(file, "--to", acl);
  const now = lstatSync(file);
  if (now.dev !== pin.dev || now.ino !== pin.ino)
    throw new PathSecurityError("acl_unverifiable", file, "--to");
  if (left.length > 0) throw new PathSecurityError("insecure_acl", file, "--to");
}

/**
 * Copies a finished backup to `dest` as a NEW 0600 file: `O_CREAT|O_EXCL|O_NOFOLLOW` (never
 * overwrites, never follows a pre-placed symlink), private before a byte is written (an ACL entry
 * of its directory removed — `privatizeNewFile`), fsynced; a partial file is removed.
 */
export function copyToNewPrivateFile(
  src: string,
  dest: string,
  acl: AclAccess = systemAcl,
): number {
  let out: number;
  try {
    out = openSync(dest, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") throw new Error("backup destination already exists");
    throw e;
  }
  let bytes = 0;
  let input: number | null = null;
  try {
    fchmodSync(out, 0o600);
    privatizeNewFile(out, dest, acl);
    input = openSync(src, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(input, buf, 0, buf.length, bytes);
      if (n === 0) break;
      let off = 0;
      while (off < n) off += writeSync(out, buf, off, n - off);
      bytes += n;
    }
    fsyncSync(out);
  } catch (e) {
    closeSync(out);
    if (input !== null) closeSync(input);
    rmSync(dest, { force: true });
    throw e;
  }
  closeSync(out);
  closeSync(input);
  return bytes;
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** `eff backup [--to <abs path>]`. */
export async function backup(
  io: CliIo,
  config: LenientConfig,
  log: Logger,
  opts: {
    readonly to: string | undefined;
    readonly notify: boolean;
    readonly factory?: StoreFactory;
  },
): Promise<number> {
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  const userDest =
    opts.to === undefined
      ? null
      : resolveBackupDestination(opts.to, io.home, io.packageRoot, io.xattr);
  let rotated: string[] = [];
  try {
    if (userDest !== null && exists(userDest)) throw new Error("backup destination already exists");
    let dest: string;
    let staging: string | null = null;
    if (userDest !== null) {
      const tmp = runTempDir(config.cacheDir);
      ensureSecureDir(tmp, { create: true, what: "run temp directory" });
      staging = mkdtempSync(path.join(tmp, "backup-"));
      dest = path.join(staging, "store.sqlite");
    } else {
      const dir = backupDir(config.cacheDir);
      ensureSecureDir(dir, { create: true, what: "backups directory" });
      dest = weeklyBackupPath(dir, io.clock.nowMs());
    }
    try {
      const store = openStore(config, io.clock, log, {
        migrate: true,
        ...(opts.factory ? { factory: opts.factory } : {}),
      });
      let r;
      try {
        r = await store.backup(dest);
      } finally {
        store.close();
      }
      const written =
        userDest === null
          ? { path: r.path, bytes: r.bytes }
          : { path: userDest, bytes: copyToNewPrivateFile(dest, userDest) };
      await writeLine(
        io.stdout,
        `backup written: ${written.path} (${String(written.bytes)} bytes)`,
      );
    } finally {
      if (staging !== null) rmSync(staging, { recursive: true, force: true });
    }
    if (userDest === null) rotated = pruneWeeklyBackups(backupDir(config.cacheDir));
  } catch (e) {
    await writeLine(io.stderr, `eff backup: ${errorText(e)}`);
    if (opts.notify) await notifier.failure("store-backup", "backup");
    return EXIT.error;
  }
  if (rotated.length > 0)
    await writeLine(io.stdout, `removed ${String(rotated.length)} older weekly backup(s)`);
  return EXIT.ok;
}
