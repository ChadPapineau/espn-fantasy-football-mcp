// phase2-rewrite.ts — hostile variants of the Phase-2 fixture files (rewrite.ts's changes — renamed /
// dropped / retyped columns, a foreign codec label, edited rows, extra columns — over the excerpts of
// phase2-fixtures.ts), written with the test-only parquet writer. The rows are the real rows; only
// the named change differs.
import { p2Fixture, p2Rows } from "./phase2-fixtures.js";
import { writeParquet, type WriterColumn } from "./parquet-writer.js";
import type { Rewrite } from "./rewrite.js";

export type { Rewrite } from "./rewrite.js";

/** Rewrites the excerpt `<dataset>@<season>` with the given changes; returns parquet bytes. */
export function rewritePhase2(key: string, change: Rewrite = {}): Uint8Array {
  const f = p2Fixture(key);
  let rows = p2Rows(key);
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
        if (re.type === "INT32") return Math.trunc(Number(v));
        return v;
      }),
    });
  }
  for (const e of change.extra ?? []) cols.push({ ...e, values: rows.map((): unknown => null) });
  return writeParquet(cols, { keyValue: f.key_value, ...change.options });
}
