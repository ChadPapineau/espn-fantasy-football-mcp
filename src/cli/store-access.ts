// store-access.ts — how the non-serve subcommands open the store (plan 03 §1.1 step 3, §7: a store
// newer than the binary → exit 1 with the message; plan 01 §5.1 paths). Jobs (`refresh`, `probe`,
// `snapshot`, `prune`, `backup`, `setup`) open it creating and migrating as the server does;
// `status` and `doctor` are diagnostics and never create or migrate a store — a missing store or a
// pending migration is a finding, not a side effect. The one restore procedure every "restore a
// backup" message points to lives here (`restoreSteps`; Stage C finding store-restore-advice-stale-wal).
// Ported from sibling @5daa625, adapted.
import { lstatSync } from "node:fs";
import path from "node:path";
import { backupDir, datasetDir, PathSecurityError, storePath } from "../config/paths.js";
import type { LenientConfig } from "../config/schema.js";
import type { Clock } from "../domain/clock.js";
import { storeFactory } from "../store/index.js";
import {
  StoreMigrationPendingError,
  StoreVersionError,
  type Store,
  type StoreFactory,
} from "../store/types.js";
import type { Logger } from "./log.js";

/** The config fields the store needs. */
export type StoreConfig = Pick<LenientConfig, "cacheDir" | "weatherSource" | "fixtureRecord">;

/** Opens (creating/migrating when `migrate`) the store for `config`. */
export function openStore(
  config: StoreConfig,
  clock: Clock,
  log: Logger,
  opts: { readonly migrate: boolean; readonly factory?: StoreFactory },
): Store {
  return (opts.factory ?? storeFactory).open({
    path: storePath(config.cacheDir),
    datasetDir: datasetDir(config.cacheDir),
    backupDir: backupDir(config.cacheDir),
    clock,
    migrate: opts.migrate,
    weatherSource: config.weatherSource,
    recordRawBodies: config.fixtureRecord,
    onWarning: (code) => {
      log.warn("store.warning", { code });
    },
  });
}

/**
 * Why a store could not be opened, as a fixed vocabulary (safe in a log line or a doctor row):
 * SQLite's primary result code of a `node:sqlite` error (`errcode & 0xff`: 26 NOTADB, 11 CORRUPT,
 * 8 READONLY, 5/6 BUSY/LOCKED, 14 CANTOPEN), a Node without the API this build uses, a directory or
 * file of ours a path rule refused (`insecure_path` — the store itself may be healthy: Stage C
 * finding doctor-fix-skips-cache-subdirs), or `other`.
 */
export type StoreOpenReason =
  | "not_a_database"
  | "corrupt"
  | "readonly"
  | "busy"
  | "cannot_open"
  | "unsupported_node"
  | "insecure_path"
  | "other";

/** Classifies a store-open failure (see `StoreOpenReason`). Never throws. */
export function storeOpenReason(e: unknown): StoreOpenReason {
  if (e instanceof PathSecurityError) return "insecure_path";
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") {
    switch (errcode & 0xff) {
      case 26:
        return "not_a_database";
      case 11:
        return "corrupt";
      case 8:
        return "readonly";
      case 5:
      case 6:
        return "busy";
      case 14:
        return "cannot_open";
      default:
        return "other";
    }
  }
  if (e instanceof TypeError && e.message.includes("is not a function")) return "unsupported_node";
  return "other";
}

/** The outcome of opening an existing store without side effects. */
export type ExistingStore =
  | { readonly kind: "open"; readonly store: Store }
  | { readonly kind: "missing" }
  | { readonly kind: "newer"; readonly storeVersion: number; readonly binaryVersion: number }
  | { readonly kind: "pending"; readonly storeVersion: number; readonly binaryVersion: number }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly reason: StoreOpenReason;
      /** The path a path rule refused (`insecure_path` only) — local diagnostics (`eff doctor`). */
      readonly path?: string;
    };

/** Opens the store only if its file exists, never migrating (status/doctor). */
export function openExistingStore(
  config: StoreConfig,
  clock: Clock,
  log: Logger,
  factory?: StoreFactory,
): ExistingStore {
  try {
    lstatSync(storePath(config.cacheDir));
  } catch {
    return { kind: "missing" };
  }
  try {
    return {
      kind: "open",
      store: openStore(config, clock, log, { migrate: false, ...(factory ? { factory } : {}) }),
    };
  } catch (e) {
    if (e instanceof StoreVersionError)
      return { kind: "newer", storeVersion: e.storeVersion, binaryVersion: e.binaryVersion };
    if (e instanceof StoreMigrationPendingError)
      return { kind: "pending", storeVersion: e.storeVersion, binaryVersion: e.binaryVersion };
    return {
      kind: "error",
      message: errorText(e),
      reason: storeOpenReason(e),
      ...(e instanceof PathSecurityError ? { path: e.path } : {}),
    };
  }
}

/**
 * A one-line, value-free description of an error for CLI output (a fixed `detail` wins). A path rule's
 * refusal keeps the name of the directory or file at fault ("dataset directory: group/other …" — its
 * message is a fixed label plus the fixed reason, never the path); a store written by a newer binary
 * says where the restore steps are.
 */
export function errorText(e: unknown): string {
  if (e instanceof PathSecurityError) return `${e.name}: ${e.message}`;
  if (e instanceof StoreVersionError)
    return `${e.name}: ${newerStoreMessage(e.storeVersion, e.binaryVersion)}`;
  if (e instanceof Error) {
    const detail = (e as { detail?: unknown }).detail;
    if (typeof detail === "string") return `${e.name}: ${detail}`;
    return `${e.name}: ${e.message.slice(0, 200)}`;
  }
  return "unknown error";
}

/**
 * The message a store newer than the binary prints (plan 03 §7, verbatim shape), plus where the
 * restore steps are: a restore done by hand with a -wal left behind is not a restore.
 */
export function newerStoreMessage(storeVersion: number, binaryVersion: number): string {
  return `store.sqlite was written by a newer version (v${String(storeVersion)}); this binary supports v${String(binaryVersion)}. Upgrade the package or restore the backup (\`eff doctor\` lists the steps).`;
}

/** Which backup a restore takes: the newest copy, or the one taken before an upgrade's migration. */
export type RestoreFrom =
  { readonly kind: "newest" } | { readonly kind: "pre_migration"; readonly binaryVersion: number };

/**
 * The safe way to restore a store backup, as numbered steps with this install's paths (Stage C
 * finding store-restore-advice-stale-wal). store.sqlite runs in WAL mode and SQLite does not tie a
 * -wal file (or a hot -journal) to its database: a store.sqlite-wal left beside the copied backup — after a
 * killed job or a force-quit client, the usual cause of a damaged store, or with a server or job still
 * running — is replayed over it, so rows newer than the backup come back or the restored store reads
 * as malformed. So everything that opens the store stops first, the store's files move out together,
 * and only then is the backup copied in. A store written by a newer binary takes the backup its
 * migration made (`store.sqlite.bak-v<N>`, N = the version this binary supports); any other takes
 * the newest copy. `eff doctor` row 5 prints these steps; every other "restore" message points there.
 */
export function restoreSteps(cacheDir: string, from: RestoreFrom): string[] {
  const store = storePath(cacheDir);
  const name = path.basename(store);
  const backups = backupDir(cacheDir);
  const backup =
    from.kind === "pre_migration"
      ? `${backups}/${name}.bak-v${String(from.binaryVersion)} (the copy taken before the upgrade migrated it; with a -<ms> suffix when there are several, the newest)`
      : `the newest of ${backups}/store-<date>.sqlite and ${backups}/${name}.bak-v<N>`;
  return [
    "restore, step 1: stop everything that opens the store — quit the MCP clients that run this server (Claude Desktop, Claude Code sessions) and run `eff uninstall-launchd` (`eff install-launchd` puts the jobs back)",
    `restore, step 2: move ${name}, ${name}-wal, ${name}-shm and ${name}-journal (those present) out of ${cacheDir} together, e.g. into a new folder — never leave one behind: SQLite replays a leftover -wal (or a -journal) over the restored file`,
    `restore, step 3: copy ${backup} to ${store}, then \`chmod 600 ${store}\``,
    "restore, step 4: run `eff doctor` (row 5 checks the restored store), then `eff install-launchd` and restart the clients",
  ];
}
