// maintenance.ts — `eff prune` and `eff backup` (plan 06 §1.3 `store prune` weekly Sun 03:00: cache
// rows past their hard limits, snapshots > 30 d, espn_requests past their TTL, points_cache LRU,
// dataset debris, backups beyond two versions; never the recommendation log, league_settings,
// espn_projection, scoreboard_snapshot or write_journal (T-07); `store backup` weekly Sun 03:10: a
// `VACUUM INTO` copy under the process lock, keep 4 — plan 03 §7, T-15(b)). `backup --to <path>`
// writes a NEW 0600 file the user names (never a synced folder, the checkout, or a directory others
// can write into). Ported from sibling @5daa625, adapted (src/store's pruneStore and weekly backups).
import {
  closeSync,
  constants as fsc,
  fchmodSync,
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
import {
  assertNotSynced,
  assertOutsideRepo,
  backupDir,
  ensureSecureDir,
  insecureAncestors,
  PathSecurityError,
  resolveAbsolute,
  runTempDir,
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
  log.info("prune.done", {
    ...report.rows,
    files_removed: report.files_removed.length,
    backups_removed: report.backups_removed.length,
  });
  await writeLine(
    io.stdout,
    `pruned rows: ${rows}; ${String(report.files_removed.length)} dataset file(s), ${String(report.backups_removed.length)} old backup(s). Never pruned: recommendation log, league settings, ESPN projections, scoreboard snapshots, write journal.`,
  );
  return EXIT.ok;
}

/**
 * Validates a `--to` destination and returns where the file will be written: the parent resolved to
 * its real path plus the file name. Never a synced folder, never the checkout, never a directory
 * others can write into without the sticky bit. Every refusal is a UsageError (exit 2).
 */
export function resolveBackupDestination(to: string, home: string, repoRoot: string): string {
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
  try {
    assertNotSynced(abs, home, "--to");
    assertNotSynced(dest, home, "--to");
    assertOutsideRepo(abs, repoRoot, "--to");
    assertOutsideRepo(dest, repoRoot, "--to");
  } catch (e) {
    if (e instanceof PathSecurityError) throw new UsageError(`backup: --to: ${e.detail}`);
    throw e;
  }
  if (insecureAncestors(dest).length > 0)
    throw new UsageError(
      `backup: --to: ${realParent} (or a directory above it) is writable by others; choose a directory only you can write to`,
    );
  return dest;
}

/**
 * Copies a finished backup to `dest` as a NEW 0600 file: `O_CREAT|O_EXCL|O_NOFOLLOW` (never
 * overwrites, never follows a pre-placed symlink), fsynced; a partial file is removed.
 */
export function copyToNewPrivateFile(src: string, dest: string): number {
  let out: number;
  try {
    out = openSync(dest, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") throw new Error("backup destination already exists");
    throw e;
  }
  let bytes = 0;
  const input = openSync(src, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    fchmodSync(out, 0o600);
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
    closeSync(input);
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
    opts.to === undefined ? null : resolveBackupDestination(opts.to, io.home, io.packageRoot);
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
