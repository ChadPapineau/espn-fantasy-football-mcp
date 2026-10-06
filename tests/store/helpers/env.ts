// env.ts — temp cache directories and store/publisher openers for the store tests (plan 05 §2
// `store`): real files, because modes, inodes, renames and locks are what is under test.
// Ported from sibling @cf3b015, adapted.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backupDir, datasetDir, storePath } from "../../../src/config/paths.js";
import { fixedClock, type FixedClock } from "../../../src/domain/clock.js";
import { createStoreFactory } from "../../../src/store/index.js";
import type { PublisherInternals } from "../../../src/store/publisher.js";
import type { StoreInternals } from "../../../src/store/store.js";
import type { DatasetPublisher, Store, StoreOpenOptions } from "../../../src/store/types.js";

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/** The fixed start instant of every test clock. */
export const T0 = "2026-10-06T12:00:00.000Z";

/** A temp cache layout (`<root>/cache/{store.sqlite, datasets/, backups/}`), 0700, real path. */
export interface TempCache {
  readonly root: string;
  readonly cache: string;
  readonly storePath: string;
  readonly datasetDir: string;
  readonly backupDir: string;
  readonly clock: FixedClock;
  cleanup(): void;
}

export function tempCache(prefix = "eff-store-"): TempCache {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  const cache = path.join(root, "cache");
  mkdirSync(cache, { mode: 0o700 });
  return {
    root,
    cache,
    storePath: storePath(cache),
    datasetDir: datasetDir(cache),
    backupDir: backupDir(cache),
    clock: fixedClock(T0),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type Internals = StoreInternals & PublisherInternals;

export function openStore(
  t: TempCache,
  extra: Partial<StoreOpenOptions> = {},
  internals: Internals = {},
): Store {
  return createStoreFactory(internals).open({
    path: t.storePath,
    datasetDir: t.datasetDir,
    backupDir: t.backupDir,
    clock: t.clock,
    migrate: true,
    ...extra,
  });
}

export function openPublisher(t: TempCache, internals: Internals = {}): DatasetPublisher {
  return createStoreFactory(internals).openPublisher({
    storePath: t.storePath,
    datasetDir: t.datasetDir,
    clock: t.clock,
  });
}

/** Nearest-rank percentile of a sample. */
export function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? Number.NaN;
}
