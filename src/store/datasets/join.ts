// join.ts — the on-demand cross-source SQL join (plan 01 §5.5, ADV OBJ-22): a query family that
// truly needs one SQL statement over several dataset files gets a SHORT-LIVED in-memory connection
// with those files ATTACHed read-only (`file:…?mode=ro`), at most MAX_ON_DEMAND_ATTACHMENTS (8,
// below SQLite's limit of 10) — asserted in code before anything is attached. Writes are refused by
// the open mode and by an authorizer; the connection is closed when `fn` returns. Phase 1's readers
// need no join (every READER_QUERIES statement runs on one file); this is the sanctioned path.
import { lstatSync } from "node:fs";
import { constants as C, DatabaseSync } from "node:sqlite";
import { isDatasetSourceId, type DatasetSourceId } from "../../config/freshness.js";
import { isWriteAction } from "../sqlite.js";
import { MAX_ON_DEMAND_ATTACHMENTS } from "../types.js";
import { checkDatasetFile, datasetFileOf } from "./connections.js";

/** A schema name for an attached source: `nflverse:stats_player_week` → `src_nflverse__stats_player_week`. */
export function joinSchemaName(source: DatasetSourceId): string {
  return `src_${source.replace(":", "__")}`;
}

/** A SQLite URI for a read-only attach: every path segment percent-encoded (`?`, `#`, `%`, unicode). */
export function readOnlyUri(file: string): string {
  const enc = file
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file:${enc}?mode=ro`;
}

/** The join ceiling was exceeded (refused before any ATTACH). */
export class JoinCeilingError extends RangeError {
  constructor(requested: number) {
    super(
      `store: an on-demand join may attach at most ${String(MAX_ON_DEMAND_ATTACHMENTS)} dataset files (asked for ${String(requested)})`,
    );
    this.name = "JoinCeilingError";
  }
}

/** Why a source could not be attached (it is then absent from the join, never an exception). */
export interface JoinOutcome<T> {
  readonly value: T;
  /** Sources attached, as `joinSchemaName(source)` names them in SQL. */
  readonly attached: readonly DatasetSourceId[];
  /** Sources skipped: no file, or a file this binary would not serve. */
  readonly skipped: readonly DatasetSourceId[];
}

/**
 * Runs `fn` on a short-lived in-memory connection with each source's published dataset file
 * attached read-only under `joinSchemaName(source)`. More than MAX_ON_DEMAND_ATTACHMENTS distinct
 * sources → JoinCeilingError (nothing attached). The connection is always closed.
 */
export function withDatasetJoin<T>(
  datasetDir: string,
  sources: readonly DatasetSourceId[],
  fn: (db: DatabaseSync) => T,
): JoinOutcome<T> {
  const distinct = [...new Set(sources)];
  for (const s of distinct)
    if (typeof s !== "string" || !isDatasetSourceId(s))
      throw new RangeError("store: unknown dataset source");
  if (distinct.length > MAX_ON_DEMAND_ATTACHMENTS) throw new JoinCeilingError(distinct.length);
  const db = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: false });
  const attached: DatasetSourceId[] = [];
  const skipped: DatasetSourceId[] = [];
  try {
    db.enableDefensive(true);
    db.exec("PRAGMA trusted_schema = OFF");
    let attaching = true;
    db.setAuthorizer((action) => {
      if (isWriteAction(action)) return C.SQLITE_DENY;
      if ((action === C.SQLITE_ATTACH || action === C.SQLITE_DETACH) && !attaching)
        return C.SQLITE_DENY;
      return C.SQLITE_OK;
    });
    for (const source of distinct) {
      const file = datasetFileOf(datasetDir, source);
      // Serve only a file this binary would serve on its own connection (stamp, layout, tables):
      // probed on a separate read-only connection BEFORE it is attached.
      let served = false;
      try {
        if (lstatSync(file).isFile()) {
          const probe = new DatabaseSync(file, { readOnly: true });
          try {
            served = checkDatasetFile(probe, source).ok;
          } finally {
            probe.close();
          }
        }
      } catch {
        served = false;
      }
      if (!served) {
        skipped.push(source);
        continue;
      }
      // The ceiling, asserted at the attach itself (the count check above makes it unreachable).
      if (attached.length >= MAX_ON_DEMAND_ATTACHMENTS)
        throw new JoinCeilingError(attached.length + 1);
      db.prepare(`ATTACH DATABASE ? AS "${joinSchemaName(source)}"`).run(readOnlyUri(file));
      attached.push(source);
    }
    attaching = false;
    db.exec("PRAGMA query_only = ON");
    return { value: fn(db), attached, skipped };
  } finally {
    db.close();
  }
}
