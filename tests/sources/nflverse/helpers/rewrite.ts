// rewrite.ts — hostile variants of the real fixture files (renamed / dropped / retyped columns, a
// foreign codec label, duplicated or edited rows, extra columns), written with the test-only parquet
// writer as TempFiles. The rows are the real nflverse rows; only the named change differs. Ported from
// sibling @521f9f3, adapted (rows come from the committed columnar excerpts).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TempFile } from "../../../../src/sources/source.js";
import { fixtureRows, loadFixture, type Row } from "./fixtures.js";
import {
  writeParquet,
  type Codec,
  type Logical,
  type PhysicalType,
  type WriteOptions,
  type WriterColumn,
} from "./parquet-writer.js";

export type { Row } from "./fixtures.js";

export interface Rewrite {
  readonly rename?: Readonly<Record<string, string>>;
  readonly drop?: readonly string[];
  /** Re-type a column (values converted: text → String(v), DOUBLE → Number, INT64 → BigInt). */
  readonly retype?: Readonly<Record<string, { type: PhysicalType; logical?: Logical }>>;
  readonly codec?: Readonly<Record<string, Codec>>;
  readonly rows?: (rows: Row[]) => Row[];
  readonly extra?: readonly Omit<WriterColumn, "values">[];
  readonly options?: WriteOptions;
}

/** Rewrites a fixture with the given changes; returns parquet bytes. */
export function rewrite(rel: string, change: Rewrite = {}): Uint8Array {
  const f = loadFixture(rel);
  let rows = fixtureRows(rel);
  if (change.rows) rows = change.rows(rows);
  const cols: WriterColumn[] = [];
  for (const el of f.schema) {
    if (change.drop?.includes(el.name)) continue;
    const re = change.retype?.[el.name];
    const logical = re ? re.logical : el.logical;
    const type = re ? re.type : el.type;
    const name = change.rename?.[el.name] ?? el.name;
    const codecLabel = change.codec?.[el.name];
    cols.push({
      name,
      type,
      ...(logical ? { logical } : {}),
      ...(codecLabel ? { codecLabel } : {}),
      values: rows.map((r): unknown => {
        const v = r[el.name] ?? null;
        if (v === null || !re) return v;
        if (re.type === "BYTE_ARRAY") {
          return typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v);
        }
        if (re.type === "DOUBLE") return Number(v);
        if (re.type === "INT64") return BigInt(Math.trunc(Number(v)));
        return v;
      }),
    });
  }
  for (const e of change.extra ?? []) cols.push({ ...e, values: rows.map((): unknown => null) });
  return writeParquet(cols, { keyValue: f.key_value, ...change.options });
}

/** Writes bytes as a TempFile in `dir`. */
export function tempFile(
  dir: string,
  name: string,
  bytes: Uint8Array,
  season: number | null,
): TempFile {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length, season };
}
