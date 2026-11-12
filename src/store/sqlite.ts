// sqlite.ts — the one place the store opens `node:sqlite` connections (plan 01 §5.1 WAL + pragmas;
// §5.5 each dataset file its OWN read-only connection, no attach; plan 03 §1.1 step 3 busy_timeout
// 5000; plan 05 §2 the statement trace: zero ds_* DML from the server; plan 03 §1.2 the stall
// bound: each statement prepared once per connection — the guard's statement cache). Ported from
// sibling @cf3b015, adapted (separate read-only dataset connections; synchronous required writes).
import { closeSync, constants as fsc, openSync } from "node:fs";
import {
  constants as C,
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges,
  type StatementSync,
} from "node:sqlite";
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

/** What a cached statement may do: run to completion and reset (never `iterate()`). */
type CachedOp = "get" | "all" | "run";

/** One statement of a connection's cache. */
interface CachedEntry {
  readonly st: StatementSync;
  /** Runs of it under way: above 0 only while a run calls back into JS (a SQL function). */
  running: number;
}

/** A connection the guard holds: its authorizer's label and mode, and its statement cache. */
interface Guarded {
  readonly label: string;
  readonly mode: GuardMode;
  /** `bypass` depth: above 0 while the authorizer is lifted. */
  lifted: number;
  /**
   * A statement prepared at install and never run: node:sqlite finalizes every statement of a
   * connection when it closes, so a finalized sentinel means the handle the authorizer was set on
   * is gone (closed, or closed and re-opened on the same object — without the authorizer).
   */
  readonly sentinel: StatementSync;
  /** Its statements by SQL text, least recently used first. */
  readonly cache: Map<string, CachedEntry>;
}

/** The guard holding each connection (install/forget), so a repository needs only its `db`. */
const guardOfDb = new WeakMap<DatabaseSync, StatementGuard>();

function runOp(st: StatementSync, op: CachedOp, params: SQLInputValue[]): unknown {
  switch (op) {
    case "get":
      return st.get(...params);
    case "all":
      return st.all(...params);
    case "run":
      return st.run(...params);
  }
}

/** Whether node:sqlite binds `v` as a named-parameter object (any object but a buffer view). */
function isNamed(v: unknown): v is Record<string, SQLInputValue> {
  return (typeof v === "object" || typeof v === "function") && v !== null && !ArrayBuffer.isView(v);
}

/**
 * A run's parameters as they are bound: a named-parameter object first is copied to a plain one
 * (its own enumerable string keys, the ones node:sqlite binds), so each value is read once and
 * what boundSize measures is what is bound — a getter cannot answer the measure small and the
 * bind large. Anonymous parameters are the caller's own array, unchanged.
 */
function asBound(params: SQLInputValue[]): SQLInputValue[] {
  const first: unknown = params[0];
  if (!isNamed(first)) return params;
  return [{ ...first } as unknown as SQLInputValue, ...params.slice(1)];
}

/**
 * The intrinsic `byteLength` getters of typed arrays and DataView: what node:sqlite binds is a
 * view's own bytes, so they are read the way it reads them, never through a property an own or
 * inherited definition could answer small (verifier V3-1).
 */
const VIEW_PROTOS: readonly object[] = [
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  DataView.prototype,
];

/** A buffer view's real byte length; a view neither getter reads counts as never cacheable. */
function viewBytes(v: ArrayBufferView): number {
  for (const proto of VIEW_PROTOS)
    try {
      // the prototype's own accessor, called on the view (a getter throws on another kind of view)
      return Number(Reflect.get(proto, "byteLength", v));
    } catch {
      // not this kind of view: the other getter, then never cached
    }
  return Number.POSITIVE_INFINITY;
}

/** A bound value's size as the cache counts it: a string's length, a view's bytes, else 0. */
function sizeOf(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (ArrayBuffer.isView(v)) return viewBytes(v);
  return 0;
}

/** What a run binds in all (sizeOf each value, a named-parameter object's own values included). */
function boundSize(params: readonly SQLInputValue[]): number {
  let n = 0;
  for (let i = 0; i < params.length; i++) {
    const v: unknown = params[i];
    if (i === 0 && isNamed(v)) for (const w of Object.values(v)) n += sizeOf(w);
    else n += sizeOf(v);
  }
  return n;
}

/** Whether a statement is still live (node:sqlite refuses a finalized one's every member). */
function alive(st: StatementSync): boolean {
  try {
    return typeof st.sourceSQL === "string";
  } catch {
    return false;
  }
}

/**
 * The authorizer every server connection carries: denies dataset writes (and, on dataset files,
 * every write) and, while tracing, records every decision so a test can prove the server prepared
 * zero `ds_*` DML (plan 05 §2 `store`). Authorizers run at prepare time, so the trace sees every
 * statement the store prepares. One guard serves all of a store's connections.
 *
 * It also keeps each connection's statement cache (cachedGet/cachedAll/cachedRun): a statement is
 * prepared once per connection and reused, not compiled per lookup and dropped. E13 prepared ~2,576
 * statements per call (2,332 of them one projection lookup, twice per player-week) and freeing
 * them — V8's weak callbacks, one per StatementSync — was ~70 % of each young-generation pause
 * that landed in its stall window (CI read 40.6 ms over a 27.7 ms bound at 552e3d3). The cache
 * lives here, not in each repository, because the guard is what the cache must never weaken:
 * - a statement is cached only as prepared under its connection's authorizer, keyed by the
 *   connection, whose label and mode never change under it (a re-install with another drops it,
 *   and a bypass ends by re-arming the record held then, never one since replaced);
 * - nothing is prepared, cached or run through the cache while `bypass` lifts the authorizer;
 * - `forget` (every close) drops the connection's cache, and a handle found closed (a sentinel
 *   statement finalized) is never cached on again: a dataset re-open is a new connection, with a
 *   cache of its own;
 * - `startTrace` drops every cache, so every statement run while tracing is prepared — and its
 *   authorizer decisions recorded — while tracing (plan 05 §2 holds for a warm store too);
 * - only get/all/run, which run a statement to completion and reset it: no iterator is ever open
 *   on a cached statement, its options are never set (no setter is reachable) and node:sqlite
 *   clears its bindings before every run binds; a run re-entered from inside its own run (a SQL
 *   function) gets a statement of its own, never the running one;
 * - a statement keeps what its last run bound (SQLite keeps bindings across a reset), so a run
 *   binding more than MAX_CACHED_BOUND is prepared for its run only: no cached statement holds more
 *   than MAX_CACHED_BOUND of an ESPN body or a projection's samples. A smaller value (a small body,
 *   while recording a small raw body too) stays bound to its cached statement until that SQL text
 *   runs again or the connection closes — in this process's memory only, as the value itself was
 *   (verifier V3-3);
 * - at most MAX_CACHED statements per connection (least recently used dropped first), and SQL
 *   longer than MAX_CACHED_SQL is prepared for its run only.
 * (node:sqlite's own createTagStore was not used: it keys on template-literal call sites, hands
 * out iterate(), and knows nothing of the guard's bypass or trace.)
 */
export class StatementGuard {
  /** Most trace entries kept (oldest dropped), so a long trace stays bounded. */
  static readonly MAX_TRACE = 200_000;
  /** Most statements one connection keeps (the store's runs about 100 texts, a dataset's a few). */
  static readonly MAX_CACHED = 256;
  /** Longest SQL text cached (the store's longest is about 1 KB); a longer one is never kept. */
  static readonly MAX_CACHED_SQL = 16 * 1024;
  /**
   * Most a run may bind (boundSize: string lengths plus byte lengths, a named-parameter object's
   * values included) and still run on the cached statement; a run binding more prepares its own,
   * dropped after the run and freed — bindings and all — when V8 collects it, as before the cache.
   * SQLite keeps a statement's last bindings after its reset (node:sqlite clears them only at the
   * next bind), in SQLite's heap where V8 cannot see them: a cached espn_cache INSERT held its last
   * 4 MiB parsed_json (and, while recording, the raw body) until that text ran again, a projection
   * INSERT its samples (deflated from up to 64 MiB of JSON). 64 Ki: E13's lookups bind under 1 Ki
   * in all (ids, an ISO instant, a model name), and the most any routine statement bound over the
   * store and E13 tests was about 14 Ki (a league_settings INSERT); what binds more is a write of a
   * body fetched or a value built (an ESPN answer, a projection's samples, a snapshot), against
   * which one prepare is nothing; and the cache then holds at most MAX_CACHED × 64 Ki bound (each
   * unit at most 3 bytes in SQLite's UTF-8).
   */
  static readonly MAX_CACHED_BOUND = 64 * 1024;
  private readonly entries: TraceEntry[] = [];
  private tracing = false;
  private readonly installed = new Map<DatabaseSync, Guarded>();

  install(db: DatabaseSync, label: string, mode: GuardMode): void {
    const other = guardOfDb.get(db);
    if (other !== undefined && other !== this) other.forget(db);
    const prev = this.installed.get(db);
    // another label or mode, or another handle on the same object: a new cache
    if (prev?.label !== label || prev.mode !== mode || !alive(prev.sentinel)) {
      const sentinel = db.prepare("SELECT 1");
      this.installed.set(db, {
        label,
        mode,
        lifted: 0,
        sentinel,
        cache: new Map(),
      });
    }
    guardOfDb.set(db, this);
    this.arm(db, label, mode);
  }

  /** Sets the connection's authorizer (install, and the end of a bypass). */
  private arm(db: DatabaseSync, label: string, mode: GuardMode): void {
    db.setAuthorizer((action, a1, _a2, schema) => {
      const denied = denies(mode, action, a1, schema);
      if (this.tracing) {
        if (this.entries.length >= StatementGuard.MAX_TRACE) this.entries.shift();
        this.entries.push({ connection: label, action, object: a1, schema, denied });
      }
      return denied ? C.SQLITE_DENY : C.SQLITE_OK;
    });
  }

  /** Forgets a closed connection, and with it its statement cache. */
  forget(db: DatabaseSync): void {
    this.installed.delete(db);
    if (guardOfDb.get(db) === this) guardOfDb.delete(db);
  }

  /**
   * Runs `fn` with the guard lifted on `db`. Only for `VACUUM INTO`, which attaches and writes its
   * own temporary schema; never around a caller's SQL. The statement cache refuses `db` meanwhile.
   * Its end re-arms the record `db` holds then, not the one it lifted: after a re-install inside
   * `fn` (another label or mode) the authorizer is the new record's, the one its cache is kept
   * under; after `db` went to another guard, that guard's authorizer stays; forgotten (no guard
   * holds it, no cache), it gets back the one lifted, as after a forget outside a bypass; closed,
   * nothing (a closed handle takes no authorizer).
   */
  bypass<T>(db: DatabaseSync, fn: () => T): T {
    const cfg = this.installed.get(db);
    if (cfg === undefined) return fn();
    // lifted first, counted after: a handle that refuses it (closed, still installed) throws here
    // with nothing raised, so no record's cache is left refusing every later run
    db.setAuthorizer(null);
    cfg.lifted += 1;
    try {
      return fn();
    } finally {
      cfg.lifted -= 1;
      const now = this.installed.get(db) ?? (guardOfDb.has(db) ? undefined : cfg);
      if (now !== undefined && db.isOpen) this.arm(db, now.label, now.mode);
    }
  }

  /**
   * Runs `sql` once through `db`'s statement cache (cachedGet/cachedAll/cachedRun): the cached
   * statement, prepared on first use under the connection's authorizer — a denied or failing
   * prepare caches nothing. A connection this guard does not hold, or whose handle is gone,
   * prepares per run as before the cache; a lifted guard refuses; a run binding more than
   * MAX_CACHED_BOUND prepares its own (the cached statement, if any, keeps what it held).
   */
  execute(db: DatabaseSync, sql: string, op: CachedOp, args: SQLInputValue[]): unknown {
    const g = this.installed.get(db);
    if (g === undefined) return runOp(db.prepare(sql), op, args);
    if (g.lifted > 0)
      throw new Error("store: no statement runs from the cache while the guard is lifted");
    const params = asBound(args);
    if (boundSize(params) > StatementGuard.MAX_CACHED_BOUND)
      return runOp(db.prepare(sql), op, params);
    let e = g.cache.get(sql);
    if (e === undefined) {
      // about to cache: only on the handle the authorizer was set on (else per run from here on)
      if (!alive(g.sentinel)) return this.retire(g, db, sql, op, params);
      const st = db.prepare(sql);
      if (sql.length > StatementGuard.MAX_CACHED_SQL) return runOp(st, op, params);
      e = { st, running: 0 };
      g.cache.set(sql, e);
      // over the cap: the least recently used (the first key) goes
      if (g.cache.size > StatementGuard.MAX_CACHED)
        for (const oldest of g.cache.keys()) {
          g.cache.delete(oldest);
          break;
        }
    } else if (e.running > 0) {
      // re-entered from inside its own run: re-running it would reset the run under way
      return runOp(db.prepare(sql), op, params);
    } else {
      g.cache.delete(sql); // most recently used last
      g.cache.set(sql, e);
    }
    e.running += 1;
    try {
      return runOp(e.st, op, params);
    } catch (err) {
      // a closed handle's statements are finalized, refused before they run: never used again
      if (alive(g.sentinel)) throw err;
      return this.retire(g, db, sql, op, params);
    } finally {
      e.running -= 1;
    }
  }

  /**
   * The connection's handle is gone (closed — node:sqlite then refuses the prepare, "database is
   * not open" — or closed and re-opened without the authorizer): its cache is dropped, and with
   * the sentinel finalized nothing is cached on it again (each run prepares its own, as before the
   * cache) until a re-install on the new handle.
   */
  private retire(
    g: Guarded,
    db: DatabaseSync,
    sql: string,
    op: CachedOp,
    params: SQLInputValue[],
  ): unknown {
    g.cache.clear();
    return runOp(db.prepare(sql), op, params);
  }

  /** The SQL texts `db`'s cache holds, least recently used first (tests and diagnostics). */
  cachedSql(db: DatabaseSync): readonly string[] {
    return [...(this.installed.get(db)?.cache.keys() ?? [])];
  }

  /** Starts (and clears) the trace; drops every statement cache, so the trace sees every run. */
  startTrace(): void {
    for (const g of this.installed.values()) g.cache.clear();
    this.entries.length = 0;
    this.tracing = true;
  }

  /** Stops tracing and returns what was recorded. */
  stopTrace(): readonly TraceEntry[] {
    this.tracing = false;
    return [...this.entries];
  }
}

/** A cached statement's parameters: anonymous ones, or a named-parameter object then anonymous. */
export type SqlParams = SQLInputValue[] | [Record<string, SQLInputValue>, ...SQLInputValue[]];

function execute(db: DatabaseSync, sql: string, op: CachedOp, params: SqlParams): unknown {
  const p = params as SQLInputValue[];
  const guard = guardOfDb.get(db);
  return guard === undefined ? runOp(db.prepare(sql), op, p) : guard.execute(db, sql, op, p);
}

/**
 * `db.prepare(sql).get(...params)` through the connection's statement cache (StatementGuard): the
 * statement is prepared once per guarded connection. The statement itself never leaves the cache.
 */
export function cachedGet(
  db: DatabaseSync,
  sql: string,
  ...params: SqlParams
): Record<string, SQLOutputValue> | undefined {
  return execute(db, sql, "get", params) as Record<string, SQLOutputValue> | undefined;
}

/** `db.prepare(sql).all(...params)` through the connection's statement cache (cachedGet). */
export function cachedAll(
  db: DatabaseSync,
  sql: string,
  ...params: SqlParams
): Record<string, SQLOutputValue>[] {
  return execute(db, sql, "all", params) as Record<string, SQLOutputValue>[];
}

/** `db.prepare(sql).run(...params)` through the connection's statement cache (cachedGet). */
export function cachedRun(
  db: DatabaseSync,
  sql: string,
  ...params: SqlParams
): StatementResultingChanges {
  return execute(db, sql, "run", params) as StatementResultingChanges;
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

/**
 * The closing checkpoint of a store-role connection (plan 03 §1.3 "close with a WAL checkpoint"):
 * folds the log into the store and truncates it when that can be done NOW, and never waits. The
 * connection's busy_timeout drops to 0 first — it is about to close — so a TRUNCATE checkpoint that
 * would have to wait for another process's reader or writer checkpoints what it can without blocking
 * (SQLite then proceeds as PASSIVE and answers busy) and returns. With the connection's 5-s
 * busy_timeout it called the busy handler for the whole BUSY_TIMEOUT_MS behind any open read
 * transaction — the weekly VACUUM INTO backup, doctor's quick_check, `eff status`, a job's read — so
 * `eff serve` exited 5.4 s after stdin EOF (plan 05 §4.2, plan 10 A15a: within 3 s) and every CLI
 * job's close waited the same (Stage C finding store-close-checkpoint-blocks-exit). The frames left
 * behind are the next opener's (or the last connection's close's) to checkpoint. Never throws.
 */
export function closingCheckpoint(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // busy or unable: the next opener checkpoints
  }
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
