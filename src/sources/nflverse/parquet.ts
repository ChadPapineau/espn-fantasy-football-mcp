// parquet.ts — reading nflverse release files with hyparquet (plan 01 D9: parquet via hyparquet, the
// codec asserted per column chunk — nflverse writes Arrow's default SNAPPY; §5.5: the expected column
// set asserted before anything is written). Rows are decoded one row group at a time and only for the
// columns the contract needs. The byte caps bound the download, not the decode: a few bytes of a
// hostile file can claim millions of values, so the footer is walked by a bounded reader before
// hyparquet parses it, and every page the decode will touch is checked before a row group is decoded
// (parquet-bounds.ts, PARQUET_DECODE_LIMITS — Stage C remediation nflverse-parquet-decode-bomb).
// Ported from sibling @521f9f3, adapted (errors carry a SourceErrorCode).
import { readFile } from "node:fs/promises";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData, SchemaElement } from "hyparquet";
import { ALLOWED_PARQUET_CODECS, type ColumnCodec } from "../source.js";
import { assertBoundedFooter, scanParquetPages } from "./parquet-bounds.js";
import { MAX_RELEASE_FILE_BYTES, NflverseSourceError } from "./release.js";
import type { ColumnKind } from "./schemas.js";

/** A column whose physical/logical type is not the expected kind. */
export interface ColumnTypeMismatch {
  readonly column: string;
  readonly expected: ColumnKind;
  /** e.g. `DOUBLE`, `BYTE_ARRAY/STRING`, `INT32/DATE`, `GROUP`. */
  readonly found: string;
}

/** One file's schema + codec check. */
export interface ParquetCheck {
  readonly rows: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly mismatches: readonly ColumnTypeMismatch[];
  readonly badCodecs: readonly ColumnCodec[];
  /** nflverse's own stamp in the key-value metadata (`nflverse_timestamp`), when present. */
  readonly nflverseTimestamp: string | null;
}

/** An opened parquet file: its bytes and parsed footer. */
export interface OpenedParquet {
  readonly buffer: ArrayBuffer;
  readonly metadata: FileMetaData;
}

const MAGIC = [0x50, 0x41, 0x52, 0x31]; // "PAR1"

/**
 * Reads and parses a parquet file; anything that is not one fails with `not_parquet`. `maxBytes`
 * (default MAX_RELEASE_FILE_BYTES) is the source's cap — the pbp source passes PBP_MAX_FILE_BYTES.
 */
export async function openParquet(
  path: string,
  maxBytes: number = MAX_RELEASE_FILE_BYTES,
): Promise<OpenedParquet> {
  const b = await readFile(path);
  const n = b.length;
  if (n > maxBytes) {
    throw new NflverseSourceError("not_parquet", "nflverse: file exceeds the size cap");
  }
  const magicOk =
    n >= 12 && MAGIC.every((m, i) => b[i] === m) && MAGIC.every((m, i) => b[n - 4 + i] === m);
  if (!magicOk) throw new NflverseSourceError("not_parquet", "nflverse: file is not parquet");
  assertBoundedFooter(b);
  const buffer = b.buffer.slice(b.byteOffset, b.byteOffset + n);
  let metadata: FileMetaData;
  try {
    metadata = parquetMetadata(buffer);
  } catch {
    throw new NflverseSourceError("not_parquet", "nflverse: unreadable parquet footer");
  }
  return { buffer, metadata };
}

function logicalOf(el: SchemaElement): string | undefined {
  return el.logical_type?.type ?? el.converted_type;
}

function describe(el: SchemaElement): string {
  const logical = logicalOf(el);
  const type = el.type ?? "GROUP";
  return logical ? `${type}/${logical}` : type;
}

/**
 * Whether a schema element decodes to the expected kind: `string` = BYTE_ARRAY (STRING/UTF8 or
 * unannotated); `int` = INT32/INT64 (no date/time annotation); `double` = DOUBLE/FLOAT or an integer
 * (widening loses nothing); `date` = INT32 DATE or a string (`players.birth_date` is `YYYY-MM-DD`).
 */
export function kindMatches(el: SchemaElement, kind: ColumnKind): boolean {
  const logical = logicalOf(el);
  const isString =
    el.type === "BYTE_ARRAY" &&
    (logical === undefined || logical === "STRING" || logical === "UTF8");
  const isInt =
    (el.type === "INT32" || el.type === "INT64") &&
    (logical === undefined || logical === "INTEGER" || /^U?INT_\d+$/.test(logical));
  switch (kind) {
    case "string":
      return isString;
    case "int":
      return isInt;
    case "double":
      return el.type === "DOUBLE" || el.type === "FLOAT" || isInt;
    case "date":
      return (el.type === "INT32" && logical === "DATE") || isString;
  }
}

/** The root's direct children by name (a group column's subtree is skipped). */
function topLevel(metadata: FileMetaData): Map<string, SchemaElement> {
  const top = new Map<string, SchemaElement>();
  const rootChildren = metadata.schema[0]?.num_children ?? 0;
  let skip = 0;
  let taken = 0;
  for (const el of metadata.schema.slice(1)) {
    if (skip > 0) {
      skip += (el.num_children ?? 0) - 1;
      continue;
    }
    if (taken === rootChildren) break;
    taken++;
    top.set(el.name, el);
    skip = el.num_children ?? 0;
  }
  return top;
}

/**
 * Checks a file's top-level columns against the expected kinds (missing → fail, wrong type → fail,
 * a REPEATED column → fail, extra → reported) and EVERY column chunk's codec against
 * ALLOWED_PARQUET_CODECS (plan 01 D9) — a column the contract never reads still fails on a foreign
 * codec. Nested columns count as extra.
 */
export function checkParquet(
  metadata: FileMetaData,
  expected: Readonly<Record<string, ColumnKind>>,
): ParquetCheck {
  const top = topLevel(metadata);
  const missing: string[] = [];
  const mismatches: ColumnTypeMismatch[] = [];
  for (const [name, kind] of Object.entries(expected)) {
    const el = top.get(name);
    if (!el) missing.push(name);
    else if (
      (el.num_children ?? 0) > 0 ||
      el.repetition_type === "REPEATED" ||
      !kindMatches(el, kind)
    ) {
      mismatches.push({
        column: name,
        expected: kind,
        found: el.num_children
          ? "GROUP"
          : el.repetition_type === "REPEATED"
            ? `REPEATED ${describe(el)}`
            : describe(el),
      });
    }
  }
  const extra = [...top.keys()].filter((n) => !Object.hasOwn(expected, n));
  const seen = new Set<string>();
  const badCodecs: ColumnCodec[] = [];
  for (const rg of metadata.row_groups) {
    for (const chunk of rg.columns) {
      const md = chunk.meta_data;
      if (!md) continue;
      if (ALLOWED_PARQUET_CODECS.includes(md.codec)) continue;
      const column = md.path_in_schema.join(".");
      const key = `${column}\u0000${md.codec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      badCodecs.push({ column, codec: md.codec });
    }
  }
  const ts = metadata.key_value_metadata?.find((k) => k.key === "nflverse_timestamp")?.value;
  return {
    rows: Number(metadata.num_rows),
    missing: missing.sort(),
    extra: extra.sort(),
    mismatches: mismatches.sort((a, b) => (a.column < b.column ? -1 : 1)),
    badCodecs,
    nflverseTimestamp: typeof ts === "string" && ts.length <= 64 ? ts : null,
  };
}

/**
 * Checks that decoding `columns` of an opened file stays within the decode bounds (every page the
 * decode will read; PARQUET_DECODE_LIMITS). Throws NflverseSourceError `corrupt`.
 */
export function assertDecodable(file: OpenedParquet, columns: readonly string[]): void {
  scanParquetPages(new Uint8Array(file.buffer), file.metadata, columns);
}

/**
 * Yields the rows of `columns` one row group at a time (hyparquet decodes a row group's chunks
 * whole). Values are hyparquet's: numbers, bigints (INT64), strings, Dates (DATE), null. Nothing is
 * decoded before `assertDecodable` passes the whole file; a page that does not decode fails with
 * `corrupt` (never a partial publish).
 */
export async function* readRowGroups(
  file: OpenedParquet,
  columns: readonly string[],
): AsyncGenerator<readonly Readonly<Record<string, unknown>>[]> {
  assertDecodable(file, columns);
  let start = 0;
  for (const rg of file.metadata.row_groups) {
    const n = Number(rg.num_rows);
    if (n > 0) {
      let rows: Readonly<Record<string, unknown>>[];
      try {
        rows = await parquetReadObjects({
          file: file.buffer,
          metadata: file.metadata,
          columns: [...columns],
          rowStart: start,
          rowEnd: start + n,
        });
      } catch {
        throw new NflverseSourceError("corrupt", "nflverse: a parquet page does not decode");
      }
      yield rows;
    }
    start += n;
  }
}
