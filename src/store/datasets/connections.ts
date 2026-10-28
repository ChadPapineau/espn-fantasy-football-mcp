// connections.ts — the server's view of the per-source dataset files (plan 01 §5.5 after ADV OBJ-22;
// plan 03 §1.1 step 3): each file named in refresh_log is opened LAZILY as its OWN read-only
// connection on first use and re-opened when refresh_log names a new version — another than the one
// it was opened under, never compared with the file's own stamp, which a restored store's refresh_log
// may not name (Stage C, datasets-restore-version-mismatch-reopen); there is no attach
// loop, so the eleven sources of `full` never meet SQLite's limit of 10 attachments. A reader
// opened before a publish keeps its inode (the old rows) until it re-opens; the OS frees the old
// inode at its last close. A missing, foreign, unstamped or other-layout file is never served — its
// source reads as never loaded (`stamp: null`) and a fixed-vocabulary warning is raised.
import { lstatSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SOURCE_REGISTRY, type DatasetSourceId } from "../../config/freshness.js";
import { datasetFileStem } from "../../config/paths.js";
import type { DatasetStamp } from "../../domain/analytics/types.js";
import type { Clock } from "../../domain/clock.js";
import { currentRefreshRow, refreshRowFor } from "../repos/ops.js";
import { openDatasetConnection, type StatementGuard } from "../sqlite.js";
import type { OpenDataset } from "../types.js";
import { contractColumnsHash, contractTablesFor, isContractDatasetSource } from "./tables.js";

/** The metadata table the publisher stamps into every dataset file (not a ds_* table). */
export const DATASET_META_TABLE = "dataset_meta";
/**
 * The dataset-file layout version (plan 03 §7 `ds_schema`): bumped when the meaning of a ds_* table
 * changes without its columns changing. A file of another layout — or whose columns hash differs
 * from this binary's contract — is never served and never "current"; the next refresh rewrites it.
 */
export const DS_SCHEMA_VERSION = 1;

/** The keys the publisher writes into dataset_meta. */
export const DATASET_META_KEYS = [
  "source",
  "file_version",
  "release_updated_at",
  "published_at",
  "ds_schema",
  "columns_hash",
  "rows",
  "seasons",
] as const;

/** The published path of a source's dataset file: `<datasetDir>/<stem>.sqlite`. */
export function datasetFileOf(datasetDir: string, source: DatasetSourceId): string {
  return path.join(datasetDir, `${datasetFileStem(source)}.sqlite`);
}

/** dataset_meta as a plain map (a "__proto__" key stays data); empty when the table is absent. */
export function readDatasetMeta(db: DatabaseSync): Readonly<Record<string, string>> {
  const out = Object.create(null) as Record<string, string>;
  const has = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(DATASET_META_TABLE);
  if (has === undefined) return out;
  for (const r of db.prepare(`SELECT key, value FROM ${DATASET_META_TABLE}`).all() as unknown as {
    key: unknown;
    value: unknown;
  }[])
    if (typeof r.key === "string" && typeof r.value === "string") out[r.key] = r.value;
  return out;
}

/** A `ds_schema` value as a layout version: digits only, else null. */
export function parseDsSchema(value: string | undefined): number | null {
  return typeof value === "string" && /^[0-9]{1,9}$/.test(value) ? Number(value) : null;
}

/** Why a dataset file is refused (the warning codes; fixed vocabulary). */
export type DatasetRefusal =
  | "dataset_symlink_refused"
  | "dataset_not_regular_file"
  | "dataset_missing"
  | "dataset_unreadable"
  | "dataset_unstamped"
  | "dataset_source_mismatch"
  | "dataset_schema_mismatch"
  | "dataset_tables_missing";

/**
 * Whether an open dataset connection holds a file this binary serves for `source`: stamped with
 * this source and layout, the contract's columns hash (every contract source: Phase 1, Phase 2 and
 * the history files), every contract table.
 * Returns the meta, or the refusal code.
 */
export function checkDatasetFile(
  db: DatabaseSync,
  source: DatasetSourceId,
): { ok: true; meta: Readonly<Record<string, string>> } | { ok: false; code: DatasetRefusal } {
  let meta: Readonly<Record<string, string>>;
  try {
    meta = readDatasetMeta(db);
  } catch {
    return { ok: false, code: "dataset_unreadable" };
  }
  if (meta.source === undefined || meta.file_version === undefined || meta.ds_schema === undefined)
    return { ok: false, code: "dataset_unstamped" };
  if (meta.source !== source) return { ok: false, code: "dataset_source_mismatch" };
  if (parseDsSchema(meta.ds_schema) !== DS_SCHEMA_VERSION)
    return { ok: false, code: "dataset_schema_mismatch" };
  if (isContractDatasetSource(source) && meta.columns_hash !== contractColumnsHash(source))
    return { ok: false, code: "dataset_schema_mismatch" };
  const want = contractTablesFor(source).map((t) => t.name);
  if (want.length > 0) {
    const have = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    if (!want.every((n) => have.has(n))) return { ok: false, code: "dataset_tables_missing" };
  }
  return { ok: true, meta };
}

/** One open dataset connection. */
export interface DatasetConnection extends OpenDataset {
  readonly db: DatabaseSync;
  readonly meta: Readonly<Record<string, string>>;
  /**
   * The version refresh_log named as current when this connection was opened: the connection is
   * re-opened only when refresh_log names ANOTHER version. The file's own `file_version` may differ —
   * a store restored from a backup names an older publish than the file the nightly publishes left on
   * disk (or a publish renamed its file and could not record it, PUBLISH_UNRECORDED) — and comparing
   * that with refresh_log re-opened and re-checked the file on EVERY read until the next publish of
   * the source: months for an off-season or history source (Stage C finding
   * datasets-restore-version-mismatch-reopen).
   */
  readonly opened_for: string | null;
}

/** What the connection manager is built from. */
export interface DatasetConnectionsOptions {
  /** The main store connection (refresh_log reads only). */
  readonly storeDb: DatabaseSync;
  readonly datasetDir: string;
  readonly clock: Clock;
  readonly guard: StatementGuard;
  readonly warn: (code: string) => void;
}

export class DatasetConnections {
  private readonly open = new Map<DatasetSourceId, DatasetConnection>();
  /**
   * The refresh_log version a refused file was refused at, and why: no re-try (or warning) until the
   * version moves, and the code `refusal` reports for it.
   */
  private readonly refusedAt = new Map<
    DatasetSourceId,
    { readonly version: string | null; readonly code: DatasetRefusal }
  >();
  private closed = false;

  constructor(private readonly o: DatasetConnectionsOptions) {}

  /** The published file path of a source's dataset. */
  fileOf(source: DatasetSourceId): string {
    return datasetFileOf(this.o.datasetDir, source);
  }

  /** Every open connection, as `stats().open_datasets` reports it. */
  list(): readonly OpenDataset[] {
    return [...this.open.values()]
      .sort((a, b) => a.source.localeCompare(b.source))
      .map(({ source, file, file_version, inode, opened_at }) => ({
        source,
        file,
        file_version,
        inode,
        opened_at,
      }));
  }

  private close(source: DatasetSourceId): void {
    const c = this.open.get(source);
    if (c === undefined) return;
    this.open.delete(source);
    this.o.guard.forget(c.db);
    try {
      c.db.close();
    } catch {
      // already closed
    }
  }

  /** Refuses `source`'s file opened for `openedFor`: warned once, remembered with its code. */
  private refuse(source: DatasetSourceId, openedFor: string | null, code: DatasetRefusal): null {
    this.o.warn(code);
    this.refusedAt.set(source, { version: openedFor, code });
    return null;
  }

  private openFile(source: DatasetSourceId, openedFor: string | null): DatasetConnection | null {
    const file = this.fileOf(source);
    let ino: number;
    try {
      const st = lstatSync(file);
      if (st.isSymbolicLink()) return this.refuse(source, openedFor, "dataset_symlink_refused");
      if (!st.isFile()) return this.refuse(source, openedFor, "dataset_not_regular_file");
      ino = st.ino;
    } catch {
      return this.refuse(source, openedFor, "dataset_missing");
    }
    let db: DatabaseSync;
    try {
      db = openDatasetConnection(file, this.o.guard, source);
    } catch {
      return this.refuse(source, openedFor, "dataset_unreadable");
    }
    const checked = checkDatasetFile(db, source);
    if (!checked.ok) {
      this.o.guard.forget(db);
      db.close();
      return this.refuse(source, openedFor, checked.code);
    }
    this.refusedAt.delete(source);
    const conn: DatasetConnection = {
      source,
      file,
      file_version: checked.meta.file_version ?? "unknown",
      inode: ino,
      opened_at: this.o.clock.nowIso(),
      db,
      meta: checked.meta,
      opened_for: openedFor,
    };
    this.open.set(source, conn);
    return conn;
  }

  /**
   * The connection to read `source` from: opened on first use, re-opened when refresh_log's current
   * version differs from the one it was opened under (`opened_for` — never the file's own version,
   * which a restored store's refresh_log may not name), or null when refresh_log names no version
   * (never loaded) or the file cannot be served.
   */
  use(source: DatasetSourceId): DatasetConnection | null {
    if (this.closed) throw new Error("store: closed");
    const cur = currentRefreshRow({ db: this.o.storeDb }, source);
    if (cur === null) {
      this.close(source);
      return null;
    }
    const existing = this.open.get(source);
    if (existing?.opened_for === cur.file_version) return existing;
    if (existing === undefined && this.refusedAt.get(source)?.version === cur.file_version)
      return null;
    this.close(source);
    return this.openFile(source, cur.file_version);
  }

  /**
   * Why `source`'s CURRENT file (the version refresh_log names) is not served — the code `use`
   * refused it with, judged exactly as a reader's first read judges it (opened lazily, or the open
   * connection kept) — or null when it is served or refresh_log names no version (never loaded:
   * nothing to refuse). What espn_get_status reports instead of refresh_log's "fresh" for a file every
   * reader reads as never loaded (Stage C finding status-damaged-dataset-reported-fresh).
   */
  refusal(source: DatasetSourceId): DatasetRefusal | null {
    if (this.use(source) !== null) return null;
    const cur = currentRefreshRow({ db: this.o.storeDb }, source);
    if (cur === null) return null;
    const r = this.refusedAt.get(source);
    return r?.version === cur.file_version ? r.code : null;
  }

  /** The provenance stamp of an open file: its refresh_log row, else its own dataset_meta. */
  stamp(c: DatasetConnection): DatasetStamp {
    const row = refreshRowFor({ db: this.o.storeDb }, c.source, c.file_version);
    const published = c.meta.published_at ?? c.opened_at;
    const fetched = row?.finished_at ?? published;
    return {
      source: c.source,
      as_of: row?.release_updated_at ?? c.meta.release_updated_at ?? fetched,
      fetched_at: fetched,
      checked_at: row?.checked_at ?? fetched,
      freshness_class: SOURCE_REGISTRY[c.source].freshness,
      file_version: c.file_version,
    };
  }

  /**
   * Re-opens every OPEN dataset whose refresh_log version changed since it was opened (`opened_for`);
   * returns those sources.
   */
  reopenChanged(): readonly DatasetSourceId[] {
    const changed: DatasetSourceId[] = [];
    this.refusedAt.clear();
    for (const [source, c] of [...this.open]) {
      const cur = currentRefreshRow({ db: this.o.storeDb }, source);
      if (cur !== null && cur.file_version === c.opened_for) continue;
      this.close(source);
      if (cur !== null) this.openFile(source, cur.file_version);
      changed.push(source);
    }
    return changed.sort();
  }

  /** Closes every connection; idempotent. */
  closeAll(): void {
    for (const s of [...this.open.keys()]) this.close(s);
    this.closed = true;
  }
}
