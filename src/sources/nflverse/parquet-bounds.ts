// parquet-bounds.ts — the decode bounds of an nflverse / ffverse release file (Stage C remediation
// nflverse-parquet-decode-bomb; plan 01 §5.5 "assert before anything is written", D9 the codec
// assertion; plan 02 §6.1 #3: release files are upstream data). hyparquet decodes what a file
// claims: an RLE run longer than its page writes past the page's value count, a row group's
// num_rows builds that many row objects whatever its pages hold, a footer varint of a million bytes
// is a quadratic BigInt, a list length allocates before it is read, and a footer whose schema list
// is millions of one-byte elements makes parquetMetadata build one retained object per element
// (~150 B each: an 8 MB footer of empty structs is > 1 GB of heap). A 1.5 KB file could abort the
// refresh with a fatal out-of-memory. So nothing reaches hyparquet unchecked:
//
//   • the footer is walked first by a bounded thrift-compact reader that mirrors hyparquet's own
//     traversal (same field and element rules, same int32 varint arithmetic) and refuses a varint
//     longer than its type allows, a list or binary longer than the bytes left, a nesting deeper
//     than PARQUET_DECODE_LIMITS.maxThriftDepth, MORE thrift elements than maxThriftNodes (so the
//     count of objects parquetMetadata will materialise from the footer is bounded, whatever shape
//     the footer takes — an element costs ≥ 1 byte but hyparquet retains it as a ~150 B object), or
//     an element type parquet never uses;
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
// The schema is checked too (Stage C remediation nflverse-parquet-negative-children-hang): hyparquet's
// metadata parse and decode walk the schema list by each element's `num_children` and resolve a
// column chunk to its element by name, so a 35-byte footer with a child count of −1 held
// parquetMetadata's GeoParquet pass in an endless synchronous loop (SIGTERM never ran). The footer
// walk now refuses, before hyparquet reads it, a schema element whose child count is not a
// non-negative integer or whose converted type is DECIMAL (nflverse writes none and the product reads
// none; hyparquet converts such a column's statistics with a BigInt loop that grows faster than the
// square of their length, inside the parse); openParquet parses with GeoParquet off (the product
// reads no geo type) and then `assertSchemaTree` requires one well-formed tree — every element
// inside the root's subtree, every group holding exactly its children, nesting within
// maxSchemaDepth, a named element, no two children of a group sharing a name, a root that is not
// REPEATED — so this scan, checkParquet and hyparquet's decoder always pick the same element for a
// column; and the page scan requires a chunk's own type to be its element's (hyparquet decodes by
// the chunk's). The scan walks exactly the bytes hyparquet slices for a chunk (Stage C remediation
// nflverse-parquet-dict-offset-scan-bypass: a negative or past-2^53 dictionary page offset sent
// hyparquet to bytes the scan never walked; `chunkBytes`).
//
// Every refusal is NflverseSourceError `corrupt` (refresh_log `schema_mismatch`): the run fails
// loudly before any large allocation and the previous dataset stays served. The caps bound the
// decode to a FINITE, non-fatal size — not to a small one: the heaviest real file decodes within
// ~1 GB, and an adversarial file at the cell cap peaks ~1.7 GB (measured, one row group and one
// file at a time) rather than the unbounded fatal abort this fixes.
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
  /**
   * Thrift elements (struct fields + list entries) the footer may hold. hyparquet retains ~one
   * object per element (~150 B), so this bounds the heap parquetMetadata builds from the footer,
   * whatever its shape; a real footer holds ~20 k (pbp's 372 columns with statistics).
   */
  readonly maxThriftNodes: number;
  /** Nesting of the schema tree below its root (every nflverse release file is flat: 1). */
  readonly maxSchemaDepth: number;
}

/**
 * The bounds, with headroom over the releases surveyed on 2026-10-10 (2023–2025 files of every tag
 * read): the largest file holds 613,196 rows (depth_charts 2026, 11 contract columns ≈ 6.7 M cells,
 * the most of any contract), the largest page is 1.1 MB uncompressed and the most page bytes 27 MB
 * (pbp, all columns), and the widest footer holds ~20 k thrift elements (pbp, 372 columns with
 * statistics). The caps leave ≥ 2.5× over every real file and bound one file's decode to a FINITE
 * size: the heaviest real file within ~1 GB, an adversarial file at the cell cap to ~1.7 GB peak
 * (the narrowest contract, 17 columns, 1<<24 / 17 ≈ 987 k rows; measured — 2.7 GB at the former
 * 1<<25) — never the unbounded fatal out-of-memory that an unchecked footer or page claim caused.
 * Every surveyed file's schema is flat (depth 1); maxSchemaDepth leaves room for a nested column a
 * future file might add while bounding hyparquet's per-level tree walk.
 */
export const PARQUET_DECODE_LIMITS: ParquetDecodeLimits = Object.freeze({
  maxRows: 1 << 21,
  maxCells: 1 << 24,
  maxPageBytes: 16 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxThriftDepth: 32,
  maxThriftNodes: 1 << 20,
  maxSchemaDepth: 32,
});

const corrupt = (what: string): NflverseSourceError =>
  new NflverseSourceError("corrupt", `nflverse: ${what}`);

/** A schema the reader refuses: `not_parquet` (refresh_log `schema_mismatch`), naming the rule. */
const badSchema = (what: string): NflverseSourceError =>
  new NflverseSourceError("not_parquet", `nflverse: unreadable parquet schema (${what})`);

// --- the bounded thrift-compact reader -----------------------------------------------------------------

/** A read position over `b[o, end)`; reading at or past `end` refuses. */
interface Cursor {
  readonly b: Uint8Array;
  o: number;
  readonly end: number;
  /** Thrift elements read so far through this cursor (bounds parquetMetadata's object count). */
  nodes: number;
  /** The element budget (PARQUET_DECODE_LIMITS.maxThriftNodes); reading past it refuses. */
  readonly maxNodes: number;
}

/** A cursor over `b[o, end)` with a fresh thrift-element budget (default: the shipped bound). */
const cursorAt = (
  b: Uint8Array,
  o: number,
  end: number,
  maxNodes: number = PARQUET_DECODE_LIMITS.maxThriftNodes,
): Cursor => ({ b, o, end, nodes: 0, maxNodes });

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
  // One object per element is what parquetMetadata retains; bound their count whatever the shape.
  if (++c.nodes > c.maxNodes) throw new ThriftBounds("more thrift elements than a footer may hold");
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
      const { elem, size } = listHeader(c);
      for (let i = 0; i < size; i++) readElement(c, elem, depth + 1, false);
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
 * A list's header, as hyparquet reads it: the element type (a boolean list's elements are bytes)
 * and the size. Every element takes at least one byte, so a list longer than the bytes left cannot
 * be real (hyparquet would allocate `new Array(size)` before failing).
 */
function listHeader(c: Cursor): { readonly elem: number; readonly size: number } {
  const head = byteAt(c);
  const elem = head & 0x0f;
  let size = head >> 4;
  if (size === 15) size = varint32(c);
  if (size < 0 || size > c.end - c.o) throw new ThriftBounds("a list longer than the bytes left");
  return { elem: elem === T.TRUE || elem === T.FALSE ? T.BYTE : elem, size };
}

/**
 * One struct, exactly as hyparquet's `deserializeTCompactProtocol` walks it (fields until STOP or the
 * end of the bytes; a zero delta reads the field id as a zigzag varint; a repeated id keeps the last
 * value). `keep` builds the fields (page headers, schema elements); otherwise the walk only
 * validates. `field`, when given, walks a field of THIS struct itself (the footer's schema list).
 */
function readStruct(
  c: Cursor,
  depth: number,
  keep: boolean,
  field?: (fid: number, type: number) => boolean,
): ThriftStruct {
  const out: Record<number, ThriftValue> = {};
  let fid = 0;
  while (c.o < c.end) {
    const byte = byteAt(c);
    const type = byte & 0x0f;
    if (type === T.STOP) break;
    const delta = byte >> 4;
    fid = delta !== 0 ? fid + delta : zigzag32(c);
    if (field?.(fid, type) === true) continue;
    const v = readElement(c, type, depth, keep);
    if (keep) out[fid] = v;
  }
  return out;
}

/** FileMetaData's schema list and the SchemaElement fields checked in it (parquet.thrift). */
const FOOTER_SCHEMA_FIELD = 2;
const ELEMENT_NUM_CHILDREN = 5;
const ELEMENT_CONVERTED_TYPE = 6;
/** ConvertedType DECIMAL (parquet.thrift; hyparquet's `ConvertedTypes[5]`). */
const CONVERTED_DECIMAL = 5;

/**
 * One SchemaElement of the footer, its fields kept, refused before hyparquet reads it when its
 * child count is not a non-negative integer (hyparquet's schema walks step by it: a negative count
 * never ends one) or its converted type is DECIMAL or not an integer (hyparquet maps a non-integer to
 * a converted type by its string form, and converts a DECIMAL column's statistics inside the parse).
 */
function checkSchemaElement(v: ThriftValue): void {
  if (typeof v !== "object" || !("struct" in v)) return; // not a struct: hyparquet reads no fields
  const children = v.struct[ELEMENT_NUM_CHILDREN];
  if (children !== undefined && !(typeof children === "number" && children >= 0))
    throw badSchema("a child count that is not a count");
  const converted = v.struct[ELEMENT_CONVERTED_TYPE];
  if (converted !== undefined && (typeof converted !== "number" || converted === CONVERTED_DECIMAL))
    throw badSchema("a DECIMAL or unreadable converted type");
}

/**
 * Walks a parquet footer before hyparquet parses it (the metadata struct starting `metadata_length`
 * bytes before the trailing length + magic, read — as hyparquet reads it — over the whole buffer).
 * Throws NflverseSourceError `not_parquet` on anything the bounded reader refuses, including a footer
 * holding more than `limits.maxThriftNodes` elements (parquetMetadata would build one object each)
 * and a schema element `checkSchemaElement` refuses (every occurrence of the schema list is checked,
 * though hyparquet keeps the last).
 */
export function assertBoundedFooter(
  file: Uint8Array,
  limits: ParquetDecodeLimits = PARQUET_DECODE_LIMITS,
): void {
  const n = file.length;
  const len = n >= 8 ? new DataView(file.buffer, file.byteOffset, n).getUint32(n - 8, true) : -1;
  if (len < 0 || len > n - 8)
    throw new NflverseSourceError("not_parquet", "nflverse: unreadable parquet footer");
  const c = cursorAt(file, n - 8 - len, n, limits.maxThriftNodes);
  // the schema list, element by element: the same node and depth accounting as readElement's LIST
  const schemaList = (fid: number, type: number): boolean => {
    if (fid !== FOOTER_SCHEMA_FIELD || type !== T.LIST) return false;
    if (++c.nodes > c.maxNodes)
      throw new ThriftBounds("more thrift elements than a footer may hold");
    const { elem, size } = listHeader(c);
    for (let i = 0; i < size; i++) checkSchemaElement(readElement(c, elem, 1, elem === T.STRUCT));
    return true;
  };
  try {
    readStruct(c, 0, false, schemaList);
  } catch (e) {
    if (e instanceof ThriftBounds)
      throw new NflverseSourceError("not_parquet", "nflverse: unreadable parquet footer");
    throw e;
  }
}

/**
 * Requires the parsed schema list to be ONE well-formed tree before anything walks it (checkParquet,
 * the page scan, hyparquet's decoder): the root first and not REPEATED (hyparquet counts the root's
 * repetition in every column's repetition level, though no level of a flat column is one), every
 * later element inside the root's subtree, every group holding exactly the children it claims,
 * nesting within `limits.maxSchemaDepth`, every element named, and no two children of one group
 * sharing a name (hyparquet takes the first, a name map the last: the scan and the decode would
 * read one chunk as two different columns). Throws NflverseSourceError `not_parquet`.
 */
export function assertSchemaTree(
  schema: readonly SchemaElement[],
  limits: ParquetDecodeLimits = PARQUET_DECODE_LIMITS,
): void {
  const childrenOf = (el: SchemaElement): number => {
    const k: unknown = el.num_children ?? 0;
    if (typeof k !== "number" || !Number.isSafeInteger(k) || k < 0)
      throw badSchema("a child count that is not a count");
    return k;
  };
  const root = schema[0];
  if (root === undefined) throw badSchema("no root");
  if (typeof root.name !== "string") throw badSchema("an element without a name");
  if (root.repetition_type === "REPEATED") throw badSchema("a repeated root");
  // the open groups, innermost last: how many children each still holds and the names taken
  const open: { left: number; readonly names: Set<string> }[] = [];
  const rootChildren = childrenOf(root);
  if (rootChildren > 0) open.push({ left: rootChildren, names: new Set() });
  for (let i = 1; i < schema.length; i++) {
    const el = schema[i];
    const group = open[open.length - 1];
    if (el === undefined || group === undefined)
      throw badSchema("an element outside the root's tree");
    if (typeof el.name !== "string") throw badSchema("an element without a name");
    if (group.names.has(el.name)) throw badSchema("two columns of one group share a name");
    group.names.add(el.name);
    group.left--;
    const k = childrenOf(el);
    if (k > 0) {
      if (open.length >= limits.maxSchemaDepth) throw badSchema("nested deeper than the bound");
      open.push({ left: k, names: new Set() });
    } else {
      while (open.length > 0 && open[open.length - 1]?.left === 0) open.pop();
    }
  }
  if (open.length > 0) throw badSchema("a group with fewer children than it claims");
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
  const c: Cursor = cursorAt(b, start, end);
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
      // hyparquet decodes a chunk by the chunk's own type; this scan reads its element's
      if (md.type !== el.type) throw corrupt("a column chunk's type is not its column's");
      scanChunk(bytes, md, el, groupRows, limits, budget);
    }
    for (const name of columns)
      if (chunks.get(name) !== 1) throw corrupt("a row group lacks or repeats a contract column");
  }
}

type ChunkMeta = NonNullable<FileMetaData["row_groups"][number]["columns"][number]["meta_data"]>;

/**
 * The bytes of one column chunk, exactly the bytes hyparquet decodes (Stage C remediation
 * nflverse-parquet-dict-offset-scan-bypass). hyparquet's parquetPlanGroup takes
 * `dictionary_page_offset || data_page_offset` — any value but an absent or zero one wins — and slices
 * the file from `Number()` of it to `Number()` of its sum with `total_compressed_size`: a negative
 * start counts from the file's end, a start past 2^53 is a chunk the scan never sees, and a bigint
 * does not add to a number (the read throws). Falling back to `data_page_offset` whenever the
 * dictionary offset is not a count walked one region while hyparquet decoded another, so every check
 * here was bypassed. So a dictionary offset that is present must be a whole number of bytes (zero
 * means none, to hyparquet too: `0n` is falsy), the start and the size are numbers of one kind, and
 * the chunk lies inside the file; anything else is refused as corrupt.
 */
function chunkBytes(bytes: Uint8Array, md: ChunkMeta): Uint8Array {
  const dictRaw: unknown = md.dictionary_page_offset;
  const dict = dictRaw === undefined ? 0 : safeCount(dictRaw);
  if (dict === null) throw corrupt("a column chunk's dictionary page offset is not an offset");
  const startRaw: unknown = dict > 0 ? dictRaw : md.data_page_offset;
  const sizeRaw: unknown = md.total_compressed_size;
  const start = safeCount(startRaw);
  const size = safeCount(sizeRaw);
  if (start === null || size === null || start + size > bytes.length)
    throw corrupt("a column chunk lies outside the file");
  if (typeof startRaw !== typeof sizeRaw)
    throw corrupt("a column chunk's offset and size are not numbers of one kind");
  return bytes.subarray(start, start + size);
}

/** One column chunk, walked page by page the way hyparquet's flat-column reader walks it. */
function scanChunk(
  bytes: Uint8Array,
  md: ChunkMeta,
  el: SchemaElement,
  groupRows: number,
  limits: ParquetDecodeLimits,
  budget: { cells: number; bytes: number },
): void {
  if (md.codec !== "SNAPPY" && md.codec !== "UNCOMPRESSED")
    throw corrupt("a column chunk's codec is not allowed");
  const chunk = chunkBytes(bytes, md);
  // hyparquet: an absent repetition type counts as optional (getMaxDefinitionLevel)
  const optional = el.repetition_type !== "REQUIRED";
  const perEntry = minEntryBytes(el);
  const c: Cursor = cursorAt(chunk, 0, chunk.length, limits.maxThriftNodes);
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
