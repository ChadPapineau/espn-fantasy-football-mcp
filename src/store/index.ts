// index.ts — the store's public entry (plan 01 §5; plan 04 §1): the StoreFactory the composition
// root (src/cli) calls — `open` for the server and every job, `openPublisher` for `eff refresh` —
// plus the maintenance entry points (prune, weekly backup paths) and the on-demand join. Ported
// from sibling @cf3b015, adapted.
import { openPublisher, type PublisherInternals } from "./publisher.js";
import { openStore, type StoreInternals } from "./store.js";
import type { StoreFactory } from "./types.js";

export { KEEP_WEEKLY_BACKUPS, pruneWeeklyBackups, weeklyBackupPath } from "./backup.js";
export { DATASET_META_TABLE, DS_SCHEMA_VERSION, datasetFileOf } from "./datasets/connections.js";
export { JoinCeilingError, withDatasetJoin, joinSchemaName } from "./datasets/join.js";
export type { NflPlayerRow, NflPlayersPort } from "./datasets/readers.js";
export { lockPathOf } from "./lock.js";
export { MIGRATIONS, type Migration } from "./migrations/index.js";
export { pruneStore, type PruneOptions, type PruneReport } from "./prune.js";
export { PUBLISH_LOCK_STALE_MS, publishJob } from "./publisher.js";
export { nflPlayersReaderOf, statementGuardOf } from "./store.js";
export type { TraceEntry } from "./sqlite.js";
export * from "./types.js";

/** Builds a StoreFactory; `internals` are test hooks (migration list, busy budgets, fault points). */
export function createStoreFactory(
  internals: StoreInternals & PublisherInternals = {},
): StoreFactory {
  const factory: StoreFactory = {
    open: (opts) => openStore(opts, internals),
    openPublisher: (opts) => openPublisher(opts, internals),
  };
  return Object.freeze(factory);
}

/** The production StoreFactory. */
export const storeFactory: StoreFactory = createStoreFactory();
