// hostile-parquet.ts — a builder of structurally hostile parquet files for the decode-bounds tests
// (Stage C remediation nflverse-parquet-decode-bomb): every page header, page body, value count,
// row count and footer field is the caller's, so a test can write exactly what a hostile release
// file would claim — an RLE run past its page, a row group claiming ten million rows over one value,
// an oversized page, a V2 page, a footer varint of thousands of bytes. Test-only; nothing in src/
// imports it. The schema it writes passes checkParquet for the columns given (flat, typed).
// Stage C remediation nflverse-parquet-negative-children-hang: a file may also carry the caller's
// own schema list (`schema`: every element's raw thrift fields, of any thrift type — a negative or
// DOUBLE-typed child count, a duplicated name, a DECIMAL annotation) and a column chunk its own
// statistics (`statistics`), so the footer facts hyparquet's metadata parse acts on are the test's.
// Stage C remediation nflverse-parquet-dict-offset-scan-bypass: a column may carry its own raw
// dictionary page offset (`dictionaryPageOffset`, negative or past 2^53, or counted from the file's
// end), and a file pages outside every chunk (`hidden`), the bytes such an offset can point at.
import { snappyLiteral } from "./parquet-writer.js";

export type HostileType = "BOOLEAN" | "INT32" | "INT64" | "DOUBLE" | "BYTE_ARRAY";
const TYPE_ID: Record<HostileType, number> = {
  BOOLEAN: 0,
  INT32: 1,
  INT64: 2,
  DOUBLE: 5,
  BYTE_ARRAY: 6,
};

/** Encodings by their thrift value (parquet.thrift). */
export const ENC = {
  PLAIN: 0,
  PLAIN_DICTIONARY: 2,
  RLE: 3,
  DELTA_BINARY_PACKED: 5,
  RLE_DICTIONARY: 8,
  BYTE_STREAM_SPLIT: 9,
} as const;
/** Page types by their thrift value. */
export const PAGE = { DATA: 0, INDEX: 1, DICTIONARY: 2, DATA_V2: 3 } as const;

/** One page as written: `body` is the UNCOMPRESSED page bytes. */
export interface HostilePage {
  readonly type?: number;
  /** DATA_PAGE num_values, or DICTIONARY_PAGE num_values. */
  readonly numValues: number;
  readonly encoding?: number;
  readonly body: Uint8Array;
  /** Overrides the header's uncompressed_page_size (default: body length). */
  readonly uncompressedSize?: number;
}

export interface HostileColumn {
  readonly name: string;
  readonly type: HostileType;
  readonly utf8?: boolean;
  /** 0 REQUIRED, 1 OPTIONAL (default), 2 REPEATED. */
  readonly repetition?: 0 | 1 | 2;
  readonly pages: readonly HostilePage[];
  /** How the pages are stored and labelled (default SNAPPY). */
  readonly codec?: "SNAPPY" | "UNCOMPRESSED";
  /** The chunk's Statistics struct (ColumnMetaData field 12), raw; none by default. */
  readonly statistics?: readonly ThriftField[];
  /**
   * ColumnMetaData.dictionary_page_offset (field 11) as written, raw (negative or past 2^53 if the
   * test says so), in place of the first dictionary page's offset; or a function of where the file's
   * `hidden` pages start and of the file's length (the offset's own varint is in the footer, so the
   * file is rewritten until its length is stable).
   */
  readonly dictionaryPageOffset?: bigint | ((at: HiddenLayout) => bigint);
}

/** Where a file's `hidden` pages start, and the file's whole length. */
export interface HiddenLayout {
  readonly hidden: number;
  readonly fileLength: number;
}

export interface HostileFile {
  readonly columns: readonly HostileColumn[];
  /** The row group's num_rows (one row group). */
  readonly groupRows: number;
  /** The file's num_rows (default groupRows). */
  readonly fileRows?: number;
  /** Raw bytes appended inside the footer struct before its STOP (a hostile footer field). */
  readonly footerTail?: Uint8Array;
  /**
   * The footer's schema list, raw: each element's thrift fields, the root first. Default: a root
   * named `schema` with one child per column, then one flat element per column (`schemaOf`).
   */
  readonly schema?: readonly (readonly ThriftField[])[];
  /** The footer's key-value metadata (FileMetaData field 5), in order; none by default. */
  readonly keyValue?: Readonly<Record<string, string>>;
  /**
   * Pages written after every column chunk and before the footer, stored with the first column's
   * codec: inside no chunk's declared range, so only a hostile offset reaches them.
   */
  readonly hidden?: readonly HostilePage[];
}

// --- byte helpers --------------------------------------------------------------------------------------

export function uvarint(out: number[], n: number | bigint): void {
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
}
const zigzag = (n: number | bigint): bigint => {
  const v = BigInt(n);
  return v >= 0n ? v << 1n : (-v << 1n) - 1n;
};
const u32 = (out: number[], n: number): void => {
  out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
};

// --- thrift compact writer ------------------------------------------------------------------------------

/** One thrift struct field as written: its id and its value (whose `t` is the thrift type). */
export type ThriftField = readonly [number, ThriftValue];
/**
 * A thrift compact value: 1/2 a boolean struct field (no value bytes), 3 BYTE, 5 I32, 6 I64, 7
 * DOUBLE, 8 BINARY (a string is UTF-8 encoded), 12 STRUCT, 9 LIST.
 */
export type ThriftValue =
  | { t: 1 | 2 }
  | { t: 3; v: number }
  | { t: 5; v: number }
  | { t: 6; v: number | bigint }
  | { t: 7; v: number }
  | { t: 8; v: string | Uint8Array }
  | { t: 12; v: readonly ThriftField[] }
  | { t: 9; elem: 5 | 8 | 12; v: readonly ThriftValue[] };
type Field = ThriftField;
type Value = ThriftValue;

const i32 = (v: number): Value => ({ t: 5, v });
const i64 = (v: number | bigint): Value => ({ t: 6, v });
const bin = (v: string | Uint8Array): Value => ({ t: 8, v });
const struct = (v: readonly Field[]): Value => ({ t: 12, v });
const list = (elem: 5 | 8 | 12, v: readonly Value[]): Value => ({ t: 9, elem, v });

/** Constructors of every thrift value the writer emits (for a caller-built schema or statistics). */
export const thrift = Object.freeze({
  bool: (v: boolean): Value => ({ t: v ? 1 : 2 }),
  byte: (v: number): Value => ({ t: 3, v }),
  i32,
  i64,
  double: (v: number): Value => ({ t: 7, v }),
  bin,
  struct,
  list,
});

function writeValue(out: number[], val: Value): void {
  switch (val.t) {
    case 1:
    case 2:
      return; // a boolean field is its header's type
    case 3:
      out.push(val.v & 0xff);
      return;
    case 5:
    case 6:
      uvarint(out, zigzag(val.v));
      return;
    case 7: {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, val.v, true);
      out.push(...b);
      return;
    }
    case 8: {
      const b = typeof val.v === "string" ? new TextEncoder().encode(val.v) : val.v;
      uvarint(out, b.length);
      for (const x of b) out.push(x);
      return;
    }
    case 12:
      writeStruct(out, val.v);
      return;
    case 9:
      if (val.v.length < 15) out.push((val.v.length << 4) | val.elem);
      else {
        out.push(0xf0 | val.elem);
        uvarint(out, val.v.length);
      }
      for (const x of val.v) writeValue(out, x);
      return;
  }
}

function writeStruct(out: number[], fields: readonly Field[], tail?: Uint8Array): void {
  let last = 0;
  for (const [id, val] of fields) {
    const delta = id - last;
    if (delta > 0 && delta <= 15) out.push((delta << 4) | val.t);
    else {
      out.push(val.t);
      uvarint(out, zigzag(id));
    }
    writeValue(out, val);
    last = id;
  }
  if (tail !== undefined) for (const b of tail) out.push(b);
  out.push(0);
}

// --- page bodies ----------------------------------------------------------------------------------------

/** Definition levels of an optional column: one RLE run of `count` values `value` (u32 length first). */
export function defRun(count: number, value: 0 | 1 = 0): Uint8Array {
  const runs: number[] = [];
  uvarint(runs, BigInt(count) << 1n);
  runs.push(value);
  const out: number[] = [];
  u32(out, runs.length);
  out.push(...runs);
  return Uint8Array.from(out);
}

/** Concatenates byte arrays. */
export function concat(...parts: readonly (Uint8Array | readonly number[])[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A PLAIN BYTE_ARRAY dictionary body of `values`. */
export function plainStrings(values: readonly string[]): Uint8Array {
  const out: number[] = [];
  for (const v of values) {
    const b = new TextEncoder().encode(v);
    u32(out, b.length);
    out.push(...b);
  }
  return Uint8Array.from(out);
}

/** An all-null page of an optional column holding `numValues` values. */
export function nullPage(numValues: number): HostilePage {
  return { numValues, encoding: ENC.PLAIN, body: defRun(numValues, 0) };
}

/** A one-value page: a present value `v` (BYTE_ARRAY, PLAIN) in an optional column. */
export function onePresent(v: string): HostilePage {
  return { numValues: 1, encoding: ENC.PLAIN, body: concat(defRun(1, 1), plainStrings([v])) };
}

// --- the file -------------------------------------------------------------------------------------------

/**
 * The schema list a file of `columns` carries by default: a root named `schema` with one child per
 * column, then each column as a flat element (type, repetition, name, UTF8 when `utf8`).
 */
export function schemaOf(columns: readonly HostileColumn[]): ThriftField[][] {
  return [
    [
      [4, bin("schema")],
      [5, i32(columns.length)],
    ],
    ...columns.map((c) => {
      const fields: Field[] = [
        [1, i32(TYPE_ID[c.type])],
        [3, i32(c.repetition ?? 1)],
        [4, bin(c.name)],
      ];
      if (c.utf8 === true) fields.push([6, i32(0)]);
      return fields;
    }),
  ];
}

/** Writes one page: its header, then its body stored with `codec`. Returns the page's offset. */
function writePage(out: number[], p: HostilePage, codec: "SNAPPY" | "UNCOMPRESSED"): number {
  const at = out.length;
  const type = p.type ?? PAGE.DATA;
  const stored = codec === "SNAPPY" ? snappyLiteral(p.body) : p.body;
  const header: Field[] = [
    [1, i32(type)],
    [2, i32(p.uncompressedSize ?? p.body.length)],
    [3, i32(stored.length)],
  ];
  if (type === PAGE.DATA || type === PAGE.INDEX)
    header.push([
      5,
      struct([
        [1, i32(p.numValues)],
        [2, i32(p.encoding ?? ENC.PLAIN)],
        [3, i32(ENC.RLE)],
        [4, i32(ENC.RLE)],
      ]),
    ]);
  else if (type === PAGE.DICTIONARY)
    header.push([
      7,
      struct([
        [1, i32(p.numValues)],
        [2, i32(ENC.PLAIN)],
      ]),
    ]);
  else
    header.push([
      8,
      struct([
        [1, i32(p.numValues)],
        [2, i32(0)],
        [3, i32(p.numValues)],
        [4, i32(p.encoding ?? ENC.PLAIN)],
        [5, i32(0)],
        [6, i32(0)],
      ]),
    ]);
  writeStruct(out, header);
  for (const b of stored) out.push(b);
  return at;
}

/** Writes the file once, `fileLength` being the length a `dictionaryPageOffset` function is given. */
function build(f: HostileFile, fileLength: number): Uint8Array {
  const out: number[] = [0x50, 0x41, 0x52, 0x31];
  const laid: { start: number; size: number; dict: number | null; data: number | null }[] = [];
  for (const c of f.columns) {
    const codec = c.codec ?? "SNAPPY";
    const start = out.length;
    let dict: number | null = null;
    let data: number | null = null;
    for (const p of c.pages) {
      const at = writePage(out, p, codec);
      if ((p.type ?? PAGE.DATA) === PAGE.DICTIONARY) dict ??= at;
      else data ??= at;
    }
    laid.push({ start, size: out.length - start, dict, data });
  }
  const hidden = out.length;
  for (const p of f.hidden ?? []) writePage(out, p, f.columns[0]?.codec ?? "SNAPPY");
  const chunks: Value[] = f.columns.map((c, i) => {
    const at = laid[i];
    if (at === undefined) throw new Error("hostileParquet: a column was not laid out");
    const codec = c.codec ?? "SNAPPY";
    const md: Field[] = [
      [1, i32(TYPE_ID[c.type])],
      [2, list(5, [i32(ENC.PLAIN), i32(ENC.RLE)])],
      [3, list(8, [bin(c.name)])],
      [4, i32(codec === "SNAPPY" ? 1 : 0)],
      [5, i64(f.groupRows)],
      [6, i64(at.size)],
      [7, i64(at.size)],
      [9, i64(at.data ?? at.start)],
    ];
    const dpo = c.dictionaryPageOffset;
    const dict = typeof dpo === "function" ? dpo({ hidden, fileLength }) : (dpo ?? at.dict);
    if (dict !== null) md.push([11, i64(dict)]);
    if (c.statistics !== undefined) md.push([12, struct(c.statistics)]);
    return struct([
      [2, i64(at.start)],
      [3, struct(md)],
    ]);
  });
  const schema: Value[] = (f.schema ?? schemaOf(f.columns)).map((fields) => struct(fields));
  const footer: number[] = [];
  const fields: Field[] = [
    [1, i32(2)],
    [2, list(12, schema)],
    [3, i64(f.fileRows ?? f.groupRows)],
    [
      4,
      list(12, [
        struct([
          [1, list(12, chunks)],
          [2, i64(0)],
          [3, i64(f.groupRows)],
        ]),
      ]),
    ],
  ];
  if (f.keyValue !== undefined)
    fields.push([
      5,
      list(
        12,
        Object.entries(f.keyValue).map(([k, v]) =>
          struct([
            [1, bin(k)],
            [2, bin(v)],
          ]),
        ),
      ),
    ]);
  writeStruct(footer, fields, f.footerTail);
  for (const b of footer) out.push(b);
  u32(out, footer.length);
  out.push(0x50, 0x41, 0x52, 0x31);
  return Uint8Array.from(out);
}

/**
 * Writes the file: `PAR1`, every column's pages, the `hidden` pages, the footer, its length, `PAR1`.
 * A `dictionaryPageOffset` function sees the file's final length: the file is rewritten with the
 * last length until that length is stable.
 */
export function hostileParquet(f: HostileFile): Uint8Array {
  let out = build(f, 0);
  if (!f.columns.some((c) => typeof c.dictionaryPageOffset === "function")) return out;
  for (let i = 0; i < 8; i++) {
    const next = build(f, out.length);
    if (next.length === out.length) return next;
    out = next;
  }
  throw new Error("hostileParquet: the file's length does not settle");
}

/** A hostile file whose columns pass checkParquet for `expected` (kind → physical type). */
export function forContract(
  expected: Readonly<Record<string, "string" | "int" | "double" | "date">>,
  pages: (name: string) => readonly HostilePage[],
  rows: { readonly groupRows: number; readonly fileRows?: number },
): Uint8Array {
  return hostileParquet({
    ...rows,
    columns: Object.entries(expected).map(([name, kind]) => ({
      name,
      type: kind === "int" ? "INT32" : kind === "double" ? "DOUBLE" : "BYTE_ARRAY",
      utf8: kind === "string" || kind === "date",
      pages: pages(name),
    })),
  });
}

/**
 * A file whose footer is `PAR1`, a thrift metadata struct whose schema LIST holds `n` EMPTY structs
 * (one STOP byte each), its length and `PAR1` — the footer-amplification bomb. The bounded walk and
 * hyparquet both read `n` elements; hyparquet retains an object per element, so a few MB of footer
 * becomes gigabytes of heap unless the walk bounds the element count. Not a decodable file (it has
 * no row groups): it exists only to reach `assertBoundedFooter` / `openParquet` with `n` footer
 * nodes. `n` empty structs cost `n` bytes, so the file is ~`n` bytes.
 */
export function footerNodeBomb(n: number): Uint8Array {
  const head: number[] = [0x15, 0x02, 0x19, 0xfc]; // field 1 I32 (version 1), field 2 LIST<STRUCT>
  uvarint(head, n); // the list size (>= 15, so it is a varint after the 0xfc header)
  const footerLen = head.length + n + 1; // n empty-struct STOP bytes, then the outer struct STOP
  const out = new Uint8Array(4 + footerLen + 8);
  out.set([0x50, 0x41, 0x52, 0x31], 0);
  out.set(head, 4);
  // the n + 1 trailing bytes are already zero (n empty structs + the outer STOP)
  new DataView(out.buffer).setUint32(4 + footerLen, footerLen, true);
  out.set([0x50, 0x41, 0x52, 0x31], 4 + footerLen + 4);
  return out;
}
