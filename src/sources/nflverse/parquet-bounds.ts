// parquet-bounds.ts — the decode bounds of an nflverse / ffverse release file (Stage C remediation
// nflverse-parquet-decode-bomb; plan 01 §5.5 "assert before anything is written", D9 the codec
// assertion; plan 02 §6.1 #3: release files are upstream data). hyparquet decodes what a file
// claims: an RLE run longer than its page writes past the page's value count, a row group's
// num_rows builds that many row objects whatever its pages hold, a footer varint of a million bytes
// is a quadratic BigInt, a list length allocates before it is read. A 1.5 KB file could abort the
// refresh with a fatal out-of-memory. So nothing reaches hyparquet unchecked:
//
//   • the footer is walked first by a bounded thrift-compact reader that mirrors hyparquet's own
//     traversal (same field and element rules, same int32 varint arithmetic) and refuses a varint
//     longer than its type allows, a list or binary longer than the bytes left, a nesting deeper
//     than PARQUET_DECODE_LIMITS.maxThriftDepth, or an element type parquet never uses;
//   • before a row group is decoded, every page of every column chunk the contract reads is walked
//     the way hyparquet's flat-column reader walks it: each page header (the same bounded reader),
//     its sizes (inside the chunk, at most maxPageBytes uncompressed), its type (DATA_PAGE and
//     DICTIONARY_PAGE only), its encoding (PLAIN, PLAIN_DICTIONARY, RLE_DICTIONARY, and RLE for
//     booleans — nflverse's Arrow writer emits nothing else in the 2023–2025 releases surveyed;
//     a DATA_PAGE_V2, DELTA_* or BYTE_STREAM_SPLIT page is refused, never decoded unverified),
//     its definition levels and dictionary indices (no RLE run may pass the page's value count),
//     a dictionary's entry count against its bytes, and the pages' value counts summing to the row
//     group's num_rows exactly;
//   • a file's rows, decoded cells (rows × contract columns, plus every dictionary entry of the
//     chunks read — a dictionary of millions of empty strings is cells too) and decompressed page
//     bytes (a snappy stream expands ~21×: strings of the cap's size times 21 are bytes too) are
//     capped.
//
// Every refusal is NflverseSourceError `corrupt` (refresh_log `schema_mismatch`): the run fails
// loudly before any large allocation and the previous dataset stays served.
import { snappyUncompress } from "hyparquet";
import type { FileMetaData, SchemaElement } from "hyparquet";
import { NflverseSourceError } from "./release.js";

/** The decode bounds of one release file (a file past any of them fails as corrupt). */
export interface ParquetDecodeLimits {
  /** Rows a file may hold (Σ row-group num_rows). */
  readonly maxRows: number;
  /**
   * Decoded cells a file may produce: Σ row-group num_rows × the contract columns read, plus the
   * entries of every dictionary page of the chunks read.
   */
  readonly maxCells: number;
  /** Bytes of one page, uncompressed (hyparquet allocates this before it decompresses). */
  readonly maxPageBytes: number;
  /** Uncompressed bytes of every page of the chunks read, summed (strings are made of them). */
  readonly maxDecodedBytes: number;
  /** Nesting of thrift structs and lists (parquet metadata nests ~8 deep). */
  readonly maxThriftDepth: number;
}

/**
 * The bounds, with headroom over the releases surveyed on 2026-10-10 (2023–2025 files of every tag
 * read): the largest file holds 554,215 rows (depth_charts 2025, 12 columns ≈ 6.7 M cells), the
 * most cells are pbp's (all 372 columns ≈ 18.5 M values + 1.7 M dictionary entries; the contract
 * reads ~49 of them), the largest page is 1.1 MB uncompressed and the most page bytes 27 MB (pbp,
 * all columns). At these caps one file's decode stays within a few hundred MB whatever it claims.
 */
export const PARQUET_DECODE_LIMITS: ParquetDecodeLimits = Object.freeze({
  maxRows: 1 << 21,
  maxCells: 1 << 25,
  maxPageBytes: 16 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxThriftDepth: 32,
});

const corrupt = (what: string): NflverseSourceError =>
  new NflverseSourceError("corrupt", `nflverse: ${what}`);

// --- the bounded thrift-compact reader -----------------------------------------------------------------

/** A read position over `b[o, end)`; reading at or past `end` refuses. */
interface Cursor {
  readonly b: Uint8Array;
  o: number;
  readonly end: number;
}

/** Element types of the thrift compact protocol (hyparquet's thrift.js). */
const T = {
  STOP: 0,
  TRUE: 1,
  FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  STRUCT: 12,
} as const;

/** A field value the bounded reader keeps (numbers and booleans as hyparquet reads them). */
type ThriftValue = number | boolean | { readonly struct: ThriftStruct } | { readonly other: true };
type ThriftStruct = Readonly<Record<number, ThriftValue>>;
const OTHER = Object.freeze({ other: true as const });

class ThriftBounds extends Error {}

function byteAt(c: Cursor): number {
  if (c.o >= c.end) throw new ThriftBounds("past the end");
  return c.b[c.o++] ?? 0;
}

/** hyparquet's `readVarInt` (int32 arithmetic, identical results) refusing more than 5 bytes. */
function varint32(c: Cursor): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const byte = byteAt(c);
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
  throw new ThriftBounds("a 32-bit varint longer than 5 bytes");
}

/** hyparquet's `readZigZag`. */
function zigzag32(c: Cursor): number {
  const z = varint32(c);
  return (z >>> 1) ^ -(z & 1);
}

/** Skips a 64-bit varint (hyparquet reads it as a BigInt: a long one is quadratic) — ≤ 10 bytes. */
function skipVarint64(c: Cursor): void {
  for (let i = 0; i < 10; i++) if ((byteAt(c) & 0x80) === 0) return;
  throw new ThriftBounds("a 64-bit varint longer than 10 bytes");
}

function readElement(c: Cursor, type: number, depth: number, keep: boolean): ThriftValue {
  switch (type) {
    case T.TRUE:
      return true;
    case T.FALSE:
      return false;
    case T.BYTE: {
      const v = byteAt(c);
      return v > 127 ? v - 256 : v;
    }
    case T.I16:
    case T.I32:
      return zigzag32(c);
    case T.I64:
      skipVarint64(c);
      return OTHER;
    case T.DOUBLE:
      if (c.end - c.o < 8) throw new ThriftBounds("a double past the end");
      c.o += 8;
      return OTHER;
    case T.BINARY: {
      const n = varint32(c);
      if (n < 0 || n > c.end - c.o) throw new ThriftBounds("a binary longer than the bytes left");
      c.o += n;
      return OTHER;
    }
    case T.LIST: {
      if (depth >= PARQUET_DECODE_LIMITS.maxThriftDepth) throw new ThriftBounds("nested too deep");
      const head = byteAt(c);
      const elem = head & 0x0f;
      let size = head >> 4;
      if (size === 15) size = varint32(c);
      // every element takes at least one byte: a longer list cannot be real (hyparquet would
      // allocate `new Array(size)` before failing)
      if (size < 0 || size > c.end - c.o)
        throw new ThriftBounds("a list longer than the bytes left");
      const bool = elem === T.TRUE || elem === T.FALSE;
      for (let i = 0; i < size; i++) readElement(c, bool ? T.BYTE : elem, depth + 1, false);
      return OTHER;
    }
    case T.STRUCT: {
      if (depth >= PARQUET_DECODE_LIMITS.maxThriftDepth) throw new ThriftBounds("nested too deep");
      const s = readStruct(c, depth + 1, keep);
      return keep ? { struct: s } : OTHER;
    }
    default:
      throw new ThriftBounds("an element type parquet does not use");
  }
}

/**
 * One struct, exactly as hyparquet's `deserializeTCompactProtocol` walks it (fields until STOP or the
 * end of the bytes; a zero delta reads the field id as a zigzag varint; a repeated id keeps the last
 * value). `keep` builds the fields (page headers); otherwise the walk only validates (the footer).
 */
function readStruct(c: Cursor, depth: number, keep: boolean): ThriftStruct {
  const out: Record<number, ThriftValue> = {};
  let fid = 0;
  while (c.o < c.end) {
    const byte = byteAt(c);
    const type = byte & 0x0f;
    if (type === T.STOP) break;
    const delta = byte >> 4;
    fid = delta !== 0 ? fid + delta : zigzag32(c);
    const v = readElement(c, type, depth, keep);
    if (keep) out[fid] = v;
  }
  return out;
}

/**
 * Walks a parquet footer before hyparquet parses it (the metadata struct starting `metadata_length`
 * bytes before the trailing length + magic, read — as hyparquet reads it — over the whole buffer).
 * Throws NflverseSourceError `not_parquet` on anything the bounded reader refuses.
 */
export function assertBoundedFooter(file: Uint8Array): void {
  const n = file.length;
  const len = n >= 8 ? new DataView(file.buffer, file.byteOffset, n).getUint32(n - 8, true) : -1;
  if (len < 0 || len > n - 8)
    throw new NflverseSourceError("not_parquet", "nflverse: unreadable parquet footer");
  try {
    readStruct({ b: file, o: n - 8 - len, end: n }, 0, false);
  } catch (e) {
    if (e instanceof ThriftBounds)
      throw new NflverseSourceError("not_parquet", "nflverse: unreadable parquet footer");
    throw e;
  }
}

// --- the page scan -------------------------------------------------------------------------------------

/** hyparquet's `Encodings` table (constants.js), index = the thrift value. */
const ENCODINGS = [
  "PLAIN",
  "GROUP_VAR_INT",
  "PLAIN_DICTIONARY",
  "RLE",
  "BIT_PACKED",
  "DELTA_BINARY_PACKED",
  "DELTA_LENGTH_BYTE_ARRAY",
  "DELTA_BYTE_ARRAY",
  "RLE_DICTIONARY",
  "BYTE_STREAM_SPLIT",
] as const;
const PAGE = { DATA: 0, DICTIONARY: 2 } as const;

/** A whole non-negative number from a metadata value (hyparquet keeps i64 fields as bigints). */
function safeCount(v: unknown): number | null {
  const n = typeof v === "bigint" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const int = (s: ThriftStruct, id: number): number | null => {
  const v = s[id];
  return typeof v === "number" ? v : null;
};
const sub = (s: ThriftStruct, id: number): ThriftStruct | null => {
  const v = s[id];
  return typeof v === "object" && "struct" in v ? v.struct : null;
};

/** A page header as the scan needs it (every field typed the way hyparquet will read it). */
interface PageHeader {
  readonly type: number;
  readonly uncompressed: number;
  readonly compressed: number;
  /** DATA_PAGE: values; DICTIONARY_PAGE: entries. */
  readonly numValues: number;
  /** DATA_PAGE only: the values' encoding name. */
  readonly encoding: string | null;
}

function readPageHeader(c: Cursor): PageHeader {
  let h: ThriftStruct;
  try {
    h = readStruct(c, 0, true);
  } catch (e) {
    if (e instanceof ThriftBounds) throw corrupt("a page header does not read");
    throw e;
  }
  const type = int(h, 1);
  const uncompressed = int(h, 2);
  const compressed = int(h, 3);
  if (type === null || uncompressed === null || compressed === null)
    throw corrupt("a page header lacks its type or sizes");
  if (type === PAGE.DATA) {
    const d = sub(h, 5);
    const nv = d === null ? null : int(d, 1);
    const enc = d === null ? null : int(d, 2);
    if (nv === null || enc === null) throw corrupt("a data page header is incomplete");
    return { type, uncompressed, compressed, numValues: nv, encoding: ENCODINGS[enc] ?? "?" };
  }
  if (type === PAGE.DICTIONARY) {
    const d = sub(h, 7);
    const nv = d === null ? null : int(d, 1);
    if (nv === null) throw corrupt("a dictionary page header is incomplete");
    return { type, uncompressed, compressed, numValues: nv, encoding: null };
  }
  throw corrupt("a page type the reader does not verify (only DATA_PAGE and DICTIONARY_PAGE)");
}

/**
 * Walks an RLE / bit-packed hybrid run list from `o` the way hyparquet's `readRleBitPackedHybrid`
 * consumes it, until `expected` values are read; refuses an RLE run past `expected` (hyparquet would
 * write it whole) and any read past `end`. With `countOne`, returns how many values equal 1 (the
 * definition levels of a flat optional column: hyparquet compares the RLE value's whole bytes and a
 * bit-packed value's bit).
 */
function walkHybrid(
  b: Uint8Array,
  start: number,
  end: number,
  width: number,
  expected: number,
  countOne: boolean,
): number {
  const c: Cursor = { b, o: start, end };
  let seen = 0;
  let ones = 0;
  try {
    while (seen < expected) {
      const header = varint32(c);
      if ((header & 1) === 1) {
        const groups = header >>> 1;
        // hyparquet reads one byte up front, then exactly groups × width bytes in all
        const bytes = groups === 0 ? 1 : groups * width;
        if (bytes > end - c.o) throw new ThriftBounds("a bit-packed run past the page");
        const take = Math.min(groups * 8, expected - seen);
        if (countOne)
          for (let i = 0; i < take; i++) ones += ((b[c.o + (i >> 3)] ?? 0) >> (i & 7)) & 1;
        c.o += bytes;
        seen += take;
      } else {
        const count = header >>> 1;
        if (count > expected - seen) throw new ThriftBounds("an RLE run past the page's values");
        const valueBytes = (width + 7) >> 3;
        if (valueBytes > end - c.o) throw new ThriftBounds("an RLE value past the page");
        let value = 0;
        for (let i = 0; i < valueBytes; i++) value |= (b[c.o + i] ?? 0) << (i << 3);
        c.o += valueBytes;
        if (countOne && value === 1) ones += count;
        seen += count;
      }
    }
  } catch (e) {
    if (e instanceof ThriftBounds)
      throw corrupt(`a page's encoded values overrun it (${e.message})`);
    throw e;
  }
  return ones;
}

const u32le = (b: Uint8Array, o: number): number =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;

/** One DATA_PAGE (v1) of a flat column, decompressed: its levels and its values' run lists. */
function scanDataPage(
  page: Uint8Array,
  numValues: number,
  encoding: string,
  type: string,
  optional: boolean,
): void {
  let o = 0;
  let present = numValues;
  if (optional) {
    if (page.length < 4) throw corrupt("a data page lacks its definition levels");
    present = walkHybrid(page, 4, page.length, 1, numValues, true);
    o = 4 + u32le(page, 0);
  }
  switch (encoding) {
    case "PLAIN":
      return; // hyparquet reads `present` values and fails past the page's end
    case "RLE":
    case "PLAIN_DICTIONARY":
    case "RLE_DICTIONARY":
      if (type === "BOOLEAN") {
        // hyparquet: bit width 1, a 4-byte length first
        if (o + 4 > page.length) throw corrupt("a boolean page lacks its run lengths");
        walkHybrid(page, o + 4, page.length, 1, present, false);
        return;
      }
      if (encoding === "RLE") throw corrupt("an RLE value page that is not boolean");
      {
        if (o >= page.length) throw corrupt("a dictionary page lacks its index width");
        const width = page[o] ?? 0;
        if (width > 32) throw corrupt("a dictionary index wider than 32 bits");
        if (width > 0) walkHybrid(page, o + 1, page.length, width, present, false);
      }
      return;
    default:
      throw corrupt(`a page encoding the reader does not verify (${encoding})`);
  }
}

/** The fewest bytes one PLAIN dictionary entry of `el` takes. */
function minEntryBytes(el: SchemaElement): number {
  switch (el.type) {
    case "BOOLEAN":
      return 1 / 8;
    case "INT32":
    case "FLOAT":
    case "BYTE_ARRAY":
      return 4;
    case "INT64":
    case "DOUBLE":
      return 8;
    case "INT96":
      return 12;
    case "FIXED_LEN_BYTE_ARRAY":
      return el.type_length !== undefined && el.type_length > 0 ? el.type_length : Infinity;
    default:
      return Infinity;
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
 * Checks, before hyparquet decodes anything, that reading `columns` of the file stays within
 * `limits` (see the header). `bytes` is the whole file. Throws NflverseSourceError `corrupt`.
 */
export function scanParquetPages(
  bytes: Uint8Array,
  metadata: FileMetaData,
  columns: readonly string[],
  limits: ParquetDecodeLimits = PARQUET_DECODE_LIMITS,
): void {
  let rows = 0;
  for (const rg of metadata.row_groups) {
    const n = safeCount(rg.num_rows);
    if (n === null) throw corrupt("a row group's row count is not a count");
    rows += n;
    if (rows > limits.maxRows) throw corrupt("the file holds more rows than the decode bound");
  }
  if (safeCount(metadata.num_rows) !== rows)
    throw corrupt("the file's row count is not the sum of its row groups'");
  const budget = { cells: rows * columns.length, bytes: 0 };
  if (budget.cells > limits.maxCells)
    throw corrupt("the file holds more cells than the decode bound");
  const top = topLevel(metadata);
  const elements = new Map<string, SchemaElement>();
  for (const name of columns) {
    const el = top.get(name);
    if (el === undefined) throw corrupt("a contract column is not in the file");
    if ((el.num_children ?? 0) > 0 || el.repetition_type === "REPEATED" || el.type === undefined)
      throw corrupt("a contract column is not a flat leaf");
    elements.set(name, el);
  }
  const wanted = new Set(columns);
  for (const rg of metadata.row_groups) {
    const groupRows = safeCount(rg.num_rows) ?? 0;
    if (groupRows === 0) continue; // never decoded (readRowGroups skips an empty group)
    const chunks = new Map<string, number>();
    for (const chunk of rg.columns) {
      const md = chunk.meta_data;
      if (md === undefined) throw corrupt("a column chunk has no metadata");
      const name = md.path_in_schema[0];
      if (name === undefined || !wanted.has(name)) continue;
      if (md.path_in_schema.length !== 1) throw corrupt("a contract column chunk is nested");
      if (chunk.file_path !== undefined) throw corrupt("a column chunk lives in another file");
      chunks.set(name, (chunks.get(name) ?? 0) + 1);
      const el = elements.get(name);
      if (el === undefined) throw corrupt("a contract column is not in the file");
      scanChunk(bytes, md, el, groupRows, limits, budget);
    }
    for (const name of columns)
      if (chunks.get(name) !== 1) throw corrupt("a row group lacks or repeats a contract column");
  }
}

/** One column chunk, walked page by page the way hyparquet's flat-column reader walks it. */
function scanChunk(
  bytes: Uint8Array,
  md: NonNullable<FileMetaData["row_groups"][number]["columns"][number]["meta_data"]>,
  el: SchemaElement,
  groupRows: number,
  limits: ParquetDecodeLimits,
  budget: { cells: number; bytes: number },
): void {
  if (md.codec !== "SNAPPY" && md.codec !== "UNCOMPRESSED")
    throw corrupt("a column chunk's codec is not allowed");
  const dict = safeCount(md.dictionary_page_offset);
  const first = dict !== null && dict > 0 ? dict : safeCount(md.data_page_offset);
  const size = safeCount(md.total_compressed_size);
  if (first === null || size === null || first + size > bytes.length)
    throw corrupt("a column chunk lies outside the file");
  const chunk = bytes.subarray(first, first + size);
  // hyparquet: an absent repetition type counts as optional (getMaxDefinitionLevel)
  const optional = el.repetition_type !== "REQUIRED";
  const perEntry = minEntryBytes(el);
  const c: Cursor = { b: chunk, o: 0, end: chunk.length };
  let values = 0;
  while (values < groupRows) {
    if (c.o >= chunk.length - 1) break; // hyparquet: the end of the chunk
    const h = readPageHeader(c);
    if (h.compressed < 0 || h.compressed > chunk.length - c.o)
      throw corrupt("a page runs past its column chunk");
    if (h.uncompressed < 0 || h.uncompressed > limits.maxPageBytes)
      throw corrupt("a page is larger than the decode bound");
    if (md.codec === "UNCOMPRESSED" && h.uncompressed !== h.compressed)
      throw corrupt("an uncompressed page's sizes disagree");
    if (h.numValues < 0) throw corrupt("a page's value count is negative");
    budget.bytes += h.uncompressed;
    if (budget.bytes > limits.maxDecodedBytes)
      throw corrupt("the file's pages decompress to more bytes than the decode bound");
    const body = chunk.subarray(c.o, c.o + h.compressed);
    c.o += h.compressed;
    if (h.type === PAGE.DICTIONARY) {
      if (h.numValues * perEntry > h.uncompressed)
        throw corrupt("a dictionary claims more entries than its bytes hold");
      budget.cells += h.numValues;
      if (budget.cells > limits.maxCells)
        throw corrupt("the file's values and dictionary entries exceed the decode bound");
      continue;
    }
    if (h.numValues > groupRows - values)
      throw corrupt("a column chunk's pages hold more values than its row group's rows");
    let page = body;
    if (md.codec === "SNAPPY") {
      page = new Uint8Array(h.uncompressed);
      try {
        snappyUncompress(body, page);
      } catch {
        throw corrupt("a page does not decompress");
      }
    }
    scanDataPage(page, h.numValues, h.encoding ?? "?", el.type ?? "?", optional);
    values += h.numValues;
  }
  if (values !== groupRows)
    throw corrupt("a column chunk's pages do not hold its row group's rows");
}
