// rows.ts — decoded parquet rows → contract rows, written in batches (plan 01 §5.5 publish into a
// fresh dataset file through DatasetWriter; the tables.ts conventions: TEXT through `emptyToNull`, a
// NOT NULL violation drops the ROW and is counted — never failing the publish —, a malformed text id
// becomes NULL and is counted; tables are STRICT, so every value is coerced to its column type here).
// Ported from sibling @521f9f3, adapted (counted notes beside counted drops; decimal-id helper).
import { emptyToNull, parseDecimalId } from "../../store/datasets/derive.js";
import type { DatasetColumnType, DatasetRow } from "../../store/types.js";
import type { DatasetTableSpec, DatasetWriter } from "../source.js";

/** Rows per DatasetWriter.insert call (one transaction each): bounded memory, few transactions. */
export const INSERT_BATCH_ROWS = 500;

type Value = string | number | null;
/** One decoded upstream row. */
export type RawRow = Readonly<Record<string, unknown>>;

/** A TEXT value: a string through emptyToNull; anything else is null. */
export function asText(v: unknown): string | null {
  return emptyToNull(v);
}

/** An INTEGER value: a safe integer (number or bigint), else null. */
export function asInt(v: unknown): number | null {
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : null;
  }
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

/** A REAL value: a finite number (or a safe bigint), else null — NaN/±Infinity are never stored. */
export function asReal(v: unknown): number | null {
  if (typeof v === "bigint") return asInt(v);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerces a value to a column type (BLOB is never produced by an nflverse source). */
export function coerce(type: DatasetColumnType, v: unknown): Value {
  switch (type) {
    case "TEXT":
      return asText(v);
    case "INTEGER":
      return asInt(v);
    case "REAL":
      return asReal(v);
    case "BLOB":
      return null;
  }
}

/** A column's value derived from the raw row (tables.ts `derivation`). */
export type Derivation = (raw: RawRow) => unknown;

/**
 * Builds a contract row: every spec column in spec order — `derived[name](raw)` when given, else the
 * raw value of the same name — coerced to the column type.
 */
export function buildRow(
  spec: DatasetTableSpec,
  raw: RawRow,
  derived: Readonly<Record<string, Derivation>> = {},
): Record<string, Value> {
  const row: Record<string, Value> = {};
  for (const c of spec.columns) {
    const fn = Object.hasOwn(derived, c.name) ? derived[c.name] : undefined;
    row[c.name] = coerce(c.type, fn ? fn(raw) : raw[c.name]);
  }
  return row;
}

/**
 * Writes one table: creates it, enforces NOT NULL (the row is dropped, counted by column), drops a
 * repeated primary key (the first row wins, counted), batches inserts, and counts every note.
 */
export class TableLoader {
  readonly spec: DatasetTableSpec;
  private readonly writer: DatasetWriter;
  private readonly keys = new Set<string>();
  private readonly pending: DatasetRow[] = [];
  private readonly dropped = new Map<string, number>();
  private readonly notes = new Map<string, number>();
  private readonly seasonSet = new Set<number>();
  private inserted = 0;

  constructor(writer: DatasetWriter, spec: DatasetTableSpec) {
    this.writer = writer;
    this.spec = spec;
    writer.createTable(spec);
  }

  /** Counts a row the caller filtered out before `add`. */
  drop(reason: string): void {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
  }

  /** Counts a kept row's anomaly (e.g. a malformed id stored as NULL). */
  note(reason: string): void {
    this.notes.set(reason, (this.notes.get(reason) ?? 0) + 1);
  }

  /** Adds one row; returns whether it was kept. */
  add(row: DatasetRow): boolean {
    for (const c of this.spec.columns) {
      if (!c.nullable && (row[c.name] ?? null) === null) {
        this.drop(`null ${c.name}`);
        return false;
      }
    }
    if (this.spec.primary_key) {
      const key = JSON.stringify(this.spec.primary_key.map((k) => row[k] ?? null));
      if (this.keys.has(key)) {
        this.drop("duplicate primary key");
        return false;
      }
      this.keys.add(key);
    }
    const season = row.season;
    if (typeof season === "number") this.seasonSet.add(season);
    this.pending.push(row);
    if (this.pending.length >= INSERT_BATCH_ROWS) this.flush();
    return true;
  }

  /** Inserts what is pending (one writer transaction). */
  flush(): void {
    if (this.pending.length === 0) return;
    this.inserted += this.writer.insert(this.spec.name, this.pending.splice(0));
  }

  /** Flushes and reports (warnings sorted, so the report is deterministic). */
  finish(): {
    readonly name: string;
    readonly rows: number;
    readonly seasons: readonly number[];
    readonly warnings: readonly string[];
  } {
    this.flush();
    const warnings = [
      ...[...this.dropped].map(([r, n]) => `${this.spec.name}: dropped ${String(n)} row(s) — ${r}`),
      ...[...this.notes].map(([r, n]) => `${this.spec.name}: ${String(n)} row(s) — ${r}`),
    ].sort();
    return {
      name: this.spec.name,
      rows: this.inserted,
      seasons: [...this.seasonSet].sort((a, b) => a - b),
      warnings,
    };
  }
}

/**
 * A text id column stored as INTEGER (tables.ts `decimalId`): `parseDecimalId`, and a value that was
 * present but malformed is noted on `loader` (it becomes NULL — never another player's id).
 */
export function decimalIdOf(loader: TableLoader, column: string, v: unknown): number | null {
  const id = parseDecimalId(v);
  if (id === null && (asText(v) !== null || asInt(v) !== null)) {
    loader.note(`malformed ${column} stored as NULL`);
  }
  return id;
}
