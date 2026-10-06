// sqlite.ts — the one place the store opens `node:sqlite` connections (plan 01 §5.1 WAL + pragmas;
// §5.5 each dataset file its OWN read-only connection, no attach; plan 03 §1.1 step 3 busy_timeout
// 5000; plan 05 §2 the statement trace: zero ds_* DML from the server). Ported from sibling
// @cf3b015, adapted (separate read-only dataset connections; synchronous required writes).
import { closeSync, constants as fsc, openSync } from "node:fs";
import { constants as C, DatabaseSync } from "node:sqlite";
import {
  BEST_EFFORT_BUSY_MS,
  BUSY_TIMEOUT_MS,
  StoreBusyError,
  type BestEffortOutcome,
} from "./types.js";

/** SQLite primary result codes meaning "the lock is held by someone else". */
const BUSY_CODES: ReadonlySet<number> = new Set([5 /* SQLITE_BUSY */, 6 /* SQLITE_LOCKED */]);

/** Whether `e` is a node:sqlite error for a busy/locked database (extended codes included). */
export function isBusyError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { errcode?: unknown }).errcode;
  return typeof code === "number" && BUSY_CODES.has(code & 0xff);
}

/**
 * Creates `file` as an empty 0600 regular file when it does not exist (`O_EXCL | O_NOFOLLOW`: never
 * follows a pre-placed symlink). SQLite opens an empty file as a new database, so the store, every
 * staging dataset file and every backup are born private instead of inheriting the umask. Returns
 * false when the file already existed.
 */
export function createPrivateFile(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  closeSync(fd);
  return true;
}

// --- the statement guard (dataset write denial + trace) ------------------------------------------

/** Authorizer actions that write data or change schema. */
export const WRITE_ACTIONS: ReadonlySet<number> = new Set([
  C.SQLITE_INSERT,
  C.SQLITE_UPDATE,
  C.SQLITE_DELETE,
  C.SQLITE_CREATE_INDEX,
  C.SQLITE_CREATE_TABLE,
  C.SQLITE_CREATE_TRIGGER,
  C.SQLITE_CREATE_VIEW,
  C.SQLITE_DROP_INDEX,
  C.SQLITE_DROP_TABLE,
  C.SQLITE_DROP_TRIGGER,
  C.SQLITE_DROP_VIEW,
  C.SQLITE_ALTER_TABLE,
  C.SQLITE_REINDEX,
  C.SQLITE_ANALYZE,
  C.SQLITE_CREATE_VTABLE,
  C.SQLITE_DROP_VTABLE,
  C.SQLITE_CREATE_TEMP_INDEX,
  C.SQLITE_CREATE_TEMP_TABLE,
  C.SQLITE_CREATE_TEMP_TRIGGER,
  C.SQLITE_CREATE_TEMP_VIEW,
  C.SQLITE_DROP_TEMP_INDEX,
  C.SQLITE_DROP_TEMP_TABLE,
  C.SQLITE_DROP_TEMP_TRIGGER,
  C.SQLITE_DROP_TEMP_VIEW,
]);

/** Whether an authorizer action writes data or schema. */
export function isWriteAction(action: number): boolean {
  return WRITE_ACTIONS.has(action);
}

/** Whether an object name is a dataset table/index (`ds_*`, case-insensitive). */
export function isDatasetObject(object: string | null): boolean {
  return object?.toLowerCase().startsWith("ds_") === true;
}

/** One authorizer decision recorded by the statement trace. */
export interface TraceEntry {
  /** Which connection prepared it: `store`, or the dataset source id. */
  readonly connection: string;
  /** SQLite authorizer action code (`constants.SQLITE_INSERT`, …). */
  readonly action: number;
  /** Table (or other object) the action names; null when SQLite gives none. */
  readonly object: string | null;
  /** Schema (`main`, `temp`, an attachment); null when SQLite gives none. */
  readonly schema: string | null;
  readonly denied: boolean;
}

/** How a connection's authorizer decides. */
export type GuardMode =
  /** The main store: deny any write to a `ds_*` object, to an attached schema, and ATTACH itself. */
  | "store"
  /** A dataset file: deny every write and every ATTACH/DETACH (read-only by open mode as well). */
  | "dataset";

function denies(
  mode: GuardMode,
  action: number,
  object: string | null,
  schema: string | null,
): boolean {
  if (action === C.SQLITE_ATTACH || action === C.SQLITE_DETACH) return true;
  if (!WRITE_ACTIONS.has(action)) return false;
  if (mode === "dataset") return true;
  const onAttachment = schema !== null && schema !== "main" && schema !== "temp";
  return onAttachment || isDatasetObject(object);
}

/**
 * The authorizer every server connection carries: denies dataset writes (and, on dataset files,
 * every write) and, while tracing, records every decision so a test can prove the server prepared
 * zero `ds_*` DML (plan 05 §2 `store`). Authorizers run at prepare time, so the trace sees every
 * statement the store prepares. One guard serves all of a store's connections.
 */
export class StatementGuard {
  /** Most trace entries kept (oldest dropped), so a long trace stays bounded. */
  static readonly MAX_TRACE = 200_000;
  private readonly entries: TraceEntry[] = [];
  private tracing = false;
  private readonly installed = new Map<DatabaseSync, { label: string; mode: GuardMode }>();

  install(db: DatabaseSync, label: string, mode: GuardMode): void {
    this.installed.set(db, { label, mode });
    db.setAuthorizer((action, a1, _a2, schema) => {
      const denied = denies(mode, action, a1, schema);
      if (this.tracing) {
        if (this.entries.length >= StatementGuard.MAX_TRACE) this.entries.shift();
        this.entries.push({ connection: label, action, object: a1, schema, denied });
      }
      return denied ? C.SQLITE_DENY : C.SQLITE_OK;
    });
  }

  /** Forgets a closed connection. */
  forget(db: DatabaseSync): void {
    this.installed.delete(db);
  }

  /**
   * Runs `fn` with the guard lifted on `db`. Only for `VACUUM INTO`, which attaches and writes its
   * own temporary schema; never around a caller's SQL.
   */
  bypass<T>(db: DatabaseSync, fn: () => T): T {
    const cfg = this.installed.get(db);
    if (cfg === undefined) return fn();
    db.setAuthorizer(null);
    try {
      return fn();
    } finally {
      this.install(db, cfg.label, cfg.mode);
    }
  }

  /** Starts (and clears) the trace. */
  startTrace(): void {
    this.entries.length = 0;
    this.tracing = true;
  }

  /** Stops tracing and returns what was recorded. */
  stopTrace(): readonly TraceEntry[] {
    this.tracing = false;
    return [...this.entries];
  }
}

// --- connections ----------------------------------------------------------------------------------

/**
 * Opens a store-role connection (plan 01 §5.1): WAL, synchronous NORMAL, foreign keys, defensive
 * mode, untrusted schema, double-quoted string literals off, busy_timeout `busyMs`, the guard.
 */
export function openStoreConnection(
  file: string,
  guard: StatementGuard,
  busyMs: number = BUSY_TIMEOUT_MS,
): DatabaseSync {
  const db = new DatabaseSync(file, {
    timeout: busyMs,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    db.enableDefensive(true);
    const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: unknown };
    if (mode.journal_mode !== "wal") throw new Error("store: could not enable WAL");
    db.exec("PRAGMA synchronous = NORMAL; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON");
    guard.install(db, "store", "store");
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/**
 * Opens a published dataset file as its OWN read-only connection (plan 01 §5.5; ADV OBJ-22):
 * `readOnly` open mode, `query_only`, defensive, untrusted schema, the dataset guard (every write
 * and every ATTACH denied). Never attached to anything.
 */
export function openDatasetConnection(
  file: string,
  guard: StatementGuard | null,
  label: string,
): DatabaseSync {
  const db = new DatabaseSync(file, {
    readOnly: true,
    timeout: BUSY_TIMEOUT_MS,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    db.enableDefensive(true);
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    guard?.install(db, label, "dataset");
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** Runs `fn` inside `BEGIN IMMEDIATE … COMMIT` (the writer lock is taken up front). */
export function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

// --- write classes (plan 01 §5.3; WRITE_CLASS in types.ts) ----------------------------------------

/**
 * After a best-effort write found the lock busy, further best-effort writes inside this window are
 * counted as misses WITHOUT waiting (a circuit breaker): a long foreign writer lock then costs the
 * stdio loop one BEST_EFFORT_BUSY_MS wait per window, not one per cache write.
 */
export const BEST_EFFORT_BACKOFF_MS = 250;
/** How long a best-effort write sleeps between non-blocking tries. */
export const BEST_EFFORT_POLL_MS = 10;

const monoMs = (): number => performance.now();
const pauseCell = new Int32Array(new SharedArrayBuffer(4));
/** Blocks this thread for about `ms` (a best-effort write's short wait is synchronous by design). */
export function blockFor(ms: number): void {
  Atomics.wait(pauseCell, 0, 0, ms);
}

/**
 * The write-class executor. REQUIRED writes run under the connection's busy_timeout
 * (BUSY_TIMEOUT_MS, plan 03 §1.1) and a lock still busy after it becomes StoreBusyError — the
 * caller fails closed (a request whose limiter row cannot be written is not sent). BEST-EFFORT
 * writes (one autocommit statement each) poll with busy_timeout 0 until a monotonic deadline of
 * `bestEffortMs` — never SQLite's busy handler, whose summed intended sleeps overshoot on a loaded
 * host — and a busy lock is a counted miss, never an error.
 */
export class WriteExecutor {
  private misses = 0;
  private busyUntil = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly db: DatabaseSync,
    private readonly busyMs: number = BUSY_TIMEOUT_MS,
    private readonly bestEffortMs: number = BEST_EFFORT_BUSY_MS,
  ) {}

  /** Best-effort writes skipped because the lock was busy. */
  get cacheMissesBusy(): number {
    return this.misses;
  }

  bestEffort(fn: () => void): BestEffortOutcome {
    if (monoMs() < this.busyUntil) {
      this.misses += 1;
      return { written: false, reason: "busy" };
    }
    const deadline = monoMs() + this.bestEffortMs;
    for (;;) {
      try {
        this.tryNow(fn);
        return { written: true };
      } catch (e) {
        if (!isBusyError(e)) throw e;
      }
      const left = deadline - monoMs();
      if (left <= 0) {
        this.misses += 1;
        this.busyUntil = monoMs() + BEST_EFFORT_BACKOFF_MS;
        return { written: false, reason: "busy" };
      }
      blockFor(Math.min(left, BEST_EFFORT_POLL_MS));
    }
  }

  /** One non-blocking try: busy_timeout 0 for its duration, restored after. */
  private tryNow(fn: () => void): void {
    this.db.exec("PRAGMA busy_timeout = 0");
    try {
      fn();
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${String(this.busyMs)}`);
    }
  }

  /** A required write: a lock still busy after busy_timeout → StoreBusyError (fail closed). */
  required<T>(table: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (isBusyError(e)) throw new StoreBusyError(table);
      throw e;
    }
  }

  /** A required read-modify-write under BEGIN IMMEDIATE. */
  requiredTx<T>(table: string, fn: () => T): T {
    return this.required(table, () => immediate(this.db, fn));
  }
}
