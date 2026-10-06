// parquet-writer.ts — a minimal, dependency-free parquet WRITER for tests and fixture generation only
// (plan 05 §3: hyparquet reads only; the committed nflverse fixtures are text — the secret scanner
// refuses binary parquet — so the tests rebuild parquet from them with this writer). Ported from
// sibling @521f9f3, adapted: real (greedy) snappy compression instead of literal-only blocks,
// RLE_DICTIONARY string columns the way Arrow writes them, several row groups, INT64 / DATE / FLOAT.
// Flat OPTIONAL/REQUIRED columns, v1 data pages, RLE definition levels. `codecLabel` can claim any
// codec so the loader's codec assertion can be exercised. Never shipped: nothing in src/ imports it.

export type PhysicalType = "BOOLEAN" | "INT32" | "INT64" | "FLOAT" | "DOUBLE" | "BYTE_ARRAY";
export type Codec = "UNCOMPRESSED" | "SNAPPY" | "GZIP" | "LZO" | "BROTLI" | "LZ4" | "ZSTD";
export type Logical = "STRING" | "DATE";

/** One column to write. `values[i]` null/undefined = null (OPTIONAL columns only). */
export interface WriterColumn {
  readonly name: string;
  readonly type: PhysicalType;
  /** STRING (UTF8) for BYTE_ARRAY text; DATE for an INT32 day count (a Date or `YYYY-MM-DD`). */
  readonly logical?: Logical;
  readonly required?: boolean;
  readonly values: readonly unknown[];
  /** Codec written into this column's chunk metadata (default: the file's storage codec). */
  readonly codecLabel?: Codec;
  /** Dictionary-encode this column (default: true for BYTE_ARRAY, as Arrow does). */
  readonly dictionary?: boolean;
}

export interface WriteOptions {
  /** How pages are actually stored. Default SNAPPY (real compression). */
  readonly storage?: "UNCOMPRESSED" | "SNAPPY";
  readonly keyValue?: Readonly<Record<string, string>>;
  readonly createdBy?: string;
  /** Rows per row group (default: all rows in one group). */
  readonly rowGroupRows?: number;
}

const TYPE_ID: Record<PhysicalType, number> = {
  BOOLEAN: 0,
  INT32: 1,
  INT64: 2,
  FLOAT: 4,
  DOUBLE: 5,
  BYTE_ARRAY: 6,
};
const CODEC_ID: Record<Codec, number> = {
  UNCOMPRESSED: 0,
  SNAPPY: 1,
  GZIP: 2,
  LZO: 3,
  BROTLI: 4,
  LZ4: 5,
  ZSTD: 6,
};
const ENC = { PLAIN: 0, RLE: 3, RLE_DICTIONARY: 8 } as const;
const DAY_MS = 86_400_000;

// --- byte sink ---------------------------------------------------------------------------------------

class Sink {
  private buf = new Uint8Array(1024);
  private len = 0;
  private readonly scratch = new DataView(new ArrayBuffer(8));
  private readonly scratchBytes = new Uint8Array(this.scratch.buffer);
  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number): void {
    this.reserve(1);
    this.buf[this.len++] = b & 0xff;
  }
  bytes(u: Uint8Array | readonly number[]): void {
    this.reserve(u.length);
    this.buf.set(u, this.len);
    this.len += u.length;
  }
  uvarint(n: bigint | number): void {
    let v = BigInt(n);
    if (v < 0n) throw new Error("uvarint: negative");
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) b |= 0x80;
      this.byte(b);
    } while (v > 0n);
  }
  zigzag(n: bigint | number): void {
    const v = BigInt(n);
    this.uvarint(v >= 0n ? v << 1n : (-v << 1n) - 1n);
  }
  u32le(n: number): void {
    this.scratch.setUint32(0, n, true);
    this.bytes(this.scratchBytes.subarray(0, 4));
  }
  i32le(n: number): void {
    this.scratch.setInt32(0, n, true);
    this.bytes(this.scratchBytes.subarray(0, 4));
  }
  i64le(n: bigint): void {
    this.scratch.setBigInt64(0, n, true);
    this.bytes(this.scratchBytes);
  }
  f32le(n: number): void {
    this.scratch.setFloat32(0, n, true);
    this.bytes(this.scratchBytes.subarray(0, 4));
  }
  f64le(n: number): void {
    this.scratch.setFloat64(0, n, true);
    this.bytes(this.scratchBytes);
  }
  get length(): number {
    return this.len;
  }
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// --- thrift compact protocol (just what parquet metadata needs) --------------------------------------

type TValue =
  | { t: "i32"; v: number }
  | { t: "i64"; v: bigint | number }
  | { t: "bin"; v: string | Uint8Array }
  | { t: "struct"; v: readonly (readonly [number, TValue])[] }
  | { t: "list"; elem: "i32" | "bin" | "struct"; v: readonly TValue[] };

const CT = { i32: 5, i64: 6, bin: 8, list: 9, struct: 12 } as const;

function writeValue(s: Sink, val: TValue): void {
  switch (val.t) {
    case "i32":
    case "i64":
      s.zigzag(val.v);
      return;
    case "bin": {
      const b = typeof val.v === "string" ? new TextEncoder().encode(val.v) : val.v;
      s.uvarint(b.length);
      s.bytes(b);
      return;
    }
    case "struct":
      writeStruct(s, val.v);
      return;
    case "list": {
      const n = val.v.length;
      const et = CT[val.elem];
      if (n < 15) s.byte((n << 4) | et);
      else {
        s.byte(0xf0 | et);
        s.uvarint(n);
      }
      for (const x of val.v) writeValue(s, x);
      return;
    }
  }
}

function writeStruct(s: Sink, fields: readonly (readonly [number, TValue])[]): void {
  let last = 0;
  for (const [id, val] of fields) {
    const delta = id - last;
    const type = CT[val.t];
    if (delta > 0 && delta <= 15) s.byte((delta << 4) | type);
    else {
      s.byte(type);
      s.zigzag(id);
    }
    writeValue(s, val);
    last = id;
  }
  s.byte(0);
}

const i32 = (v: number): TValue => ({ t: "i32", v });
const i64 = (v: bigint | number): TValue => ({ t: "i64", v });
const bin = (v: string | Uint8Array): TValue => ({ t: "bin", v });
const struct = (v: readonly (readonly [number, TValue])[]): TValue => ({ t: "struct", v });
const i32list = (v: readonly number[]): TValue => ({ t: "list", elem: "i32", v: v.map(i32) });

// --- snappy (raw format, greedy hash matcher) ----------------------------------------------------------

function emitLiteral(s: Sink, src: Uint8Array, from: number, to: number): void {
  for (let off = from; off < to; off += 65536) {
    const end = Math.min(to, off + 65536);
    const n = end - off - 1;
    if (n < 60) s.byte(n << 2);
    else if (n < 0x100) {
      s.byte(60 << 2);
      s.byte(n);
    } else {
      s.byte(61 << 2);
      s.byte(n & 0xff);
      s.byte(n >> 8);
    }
    s.bytes(src.subarray(off, end));
  }
}

function emitCopy(s: Sink, offset: number, length: number): void {
  let left = length;
  while (left > 0) {
    const n = Math.min(left, 64);
    s.byte(((n - 1) << 2) | 2); // copy with a 2-byte offset, length 1..64
    s.byte(offset & 0xff);
    s.byte(offset >> 8);
    left -= n;
  }
}

/** Snappy-compresses `raw` (blocks of 64 KiB, 2-byte-offset copies) — a valid raw snappy stream. */
export function snappyCompress(raw: Uint8Array): Uint8Array {
  const s = new Sink();
  s.uvarint(raw.length);
  for (let block = 0; block < raw.length; block += 65536) {
    const end = Math.min(raw.length, block + 65536);
    const table = new Map<number, number>();
    let lit = block;
    let i = block;
    while (i + 4 <= end) {
      const key =
        (raw[i] ?? 0) |
        ((raw[i + 1] ?? 0) << 8) |
        ((raw[i + 2] ?? 0) << 16) |
        ((raw[i + 3] ?? 0) << 24);
      const cand = table.get(key);
      table.set(key, i);
      if (cand !== undefined && i - cand < 65536) {
        let len = 4;
        while (i + len < end && raw[cand + len] === raw[i + len]) len++;
        if (lit < i) emitLiteral(s, raw, lit, i);
        emitCopy(s, i - cand, len);
        i += len;
        lit = i;
      } else i++;
    }
    if (lit < end) emitLiteral(s, raw, lit, end);
  }
  return s.toBytes();
}

/** Literal-only snappy (kept for tests that want an uncompressible-but-valid stream). */
export function snappyLiteral(raw: Uint8Array): Uint8Array {
  const s = new Sink();
  s.uvarint(raw.length);
  emitLiteral(s, raw, 0, raw.length);
  return s.toBytes();
}

// --- encoders -----------------------------------------------------------------------------------------

/** RLE runs (RLE/bit-packed hybrid, RLE runs only) without the 4-byte length prefix. */
function rleRuns(values: readonly number[], bitWidth: number): Uint8Array {
  const s = new Sink();
  const width = Math.ceil(bitWidth / 8);
  let i = 0;
  while (i < values.length) {
    const v = values[i] ?? 0;
    let j = i;
    while (j < values.length && values[j] === v) j++;
    s.uvarint((j - i) << 1);
    for (let b = 0; b < width; b++) s.byte((v >> (8 * b)) & 0xff);
    i = j;
  }
  return s.toBytes();
}

function dayCount(v: unknown, name: string): number {
  if (v instanceof Date) return Math.round(v.getTime() / DAY_MS);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return Math.round(Date.parse(`${v}T00:00:00.000Z`) / DAY_MS);
  }
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new Error(`DATE column ${name}: ${String(v)}`);
}

function plainValues(col: WriterColumn, present: readonly unknown[]): Uint8Array {
  const s = new Sink();
  if (col.type === "BOOLEAN") {
    let cur = 0;
    let bit = 0;
    for (const v of present) {
      if (v === true) cur |= 1 << bit;
      bit++;
      if (bit === 8) {
        s.byte(cur);
        cur = 0;
        bit = 0;
      }
    }
    if (bit > 0) s.byte(cur);
    return s.toBytes();
  }
  const enc = new TextEncoder();
  for (const v of present) {
    switch (col.type) {
      case "INT32": {
        const n = col.logical === "DATE" ? dayCount(v, col.name) : Number(v);
        if (!Number.isInteger(n)) throw new Error(`INT32 column ${col.name}: ${String(v)}`);
        s.i32le(n);
        break;
      }
      case "INT64":
        s.i64le(BigInt(v as bigint | number));
        break;
      case "FLOAT":
        s.f32le(Number(v));
        break;
      case "DOUBLE":
        s.f64le(Number(v));
        break;
      case "BYTE_ARRAY": {
        const b = v instanceof Uint8Array ? v : enc.encode(String(v));
        s.u32le(b.length);
        s.bytes(b);
        break;
      }
    }
  }
  return s.toBytes();
}

/** A dictionary key that tells distinct values apart (strings, numbers, bigints). */
function dictKey(v: unknown): string {
  return `${typeof v}:${String(v)}`;
}

// --- the writer -----------------------------------------------------------------------------------------

interface ChunkOut {
  readonly meta: TValue;
  readonly uncompressed: number;
}

function writeChunk(
  out: Sink,
  c: WriterColumn,
  values: readonly unknown[],
  storage: "UNCOMPRESSED" | "SNAPPY",
): ChunkOut {
  const numRows = values.length;
  const levels = values.map((v) => (v === null || v === undefined ? 0 : 1));
  if (c.required && levels.includes(0)) throw new Error(`required column ${c.name} has nulls`);
  const present = values.filter((v) => v !== null && v !== undefined);
  const compress = (raw: Uint8Array): Uint8Array =>
    storage === "SNAPPY" ? snappyCompress(raw) : raw;
  const useDict = (c.dictionary ?? c.type === "BYTE_ARRAY") && c.type !== "BOOLEAN";

  let dictOffset: number | null = null;
  let uncompressedTotal = 0;
  let compressedTotal = 0;
  const body = new Sink();
  if (!c.required) {
    const rle = rleRuns(levels, 1);
    body.u32le(rle.length);
    body.bytes(rle);
  }
  if (useDict) {
    const index = new Map<string, number>();
    const dict: unknown[] = [];
    const ids = present.map((v) => {
      const k = dictKey(v);
      let id = index.get(k);
      if (id === undefined) {
        id = dict.length;
        index.set(k, id);
        dict.push(v);
      }
      return id;
    });
    const rawDict = plainValues(c, dict);
    const storedDict = compress(rawDict);
    const dh = new Sink();
    writeStruct(dh, [
      [1, i32(2)], // DICTIONARY_PAGE
      [2, i32(rawDict.length)],
      [3, i32(storedDict.length)],
      [
        7,
        struct([
          [1, i32(dict.length)],
          [2, i32(ENC.PLAIN)],
        ]),
      ],
    ]);
    dictOffset = out.length;
    const dhb = dh.toBytes();
    out.bytes(dhb);
    out.bytes(storedDict);
    uncompressedTotal += dhb.length + rawDict.length;
    compressedTotal += dhb.length + storedDict.length;
    const bitWidth = Math.max(1, Math.ceil(Math.log2(Math.max(dict.length, 2))));
    body.byte(bitWidth);
    body.bytes(rleRuns(ids, bitWidth));
  } else {
    body.bytes(plainValues(c, present));
  }
  const raw = body.toBytes();
  const stored = compress(raw);
  const header = new Sink();
  writeStruct(header, [
    [1, i32(0)], // DATA_PAGE
    [2, i32(raw.length)],
    [3, i32(stored.length)],
    [
      5,
      struct([
        [1, i32(numRows)],
        [2, i32(useDict ? ENC.RLE_DICTIONARY : ENC.PLAIN)],
        [3, i32(ENC.RLE)],
        [4, i32(ENC.RLE)],
      ]),
    ],
  ]);
  const dataOffset = out.length;
  const hb = header.toBytes();
  out.bytes(hb);
  out.bytes(stored);
  uncompressedTotal += hb.length + raw.length;
  compressedTotal += hb.length + stored.length;
  const codec = c.codecLabel ?? storage;
  const encodings = useDict ? [ENC.PLAIN, ENC.RLE, ENC.RLE_DICTIONARY] : [ENC.PLAIN, ENC.RLE];
  const md: (readonly [number, TValue])[] = [
    [1, i32(TYPE_ID[c.type])],
    [2, i32list(encodings)],
    [3, { t: "list", elem: "bin", v: [bin(c.name)] }],
    [4, i32(CODEC_ID[codec])],
    [5, i64(numRows)],
    [6, i64(uncompressedTotal)],
    [7, i64(compressedTotal)],
    [9, i64(dataOffset)],
  ];
  if (dictOffset !== null) md.push([11, i64(dictOffset)]);
  return {
    meta: struct([
      [2, i64(dictOffset ?? dataOffset)],
      [3, struct(md)],
    ]),
    uncompressed: uncompressedTotal,
  };
}

/** Writes a parquet file (one or more row groups). All columns must have the same length. */
export function writeParquet(
  columns: readonly WriterColumn[],
  opts: WriteOptions = {},
): Uint8Array {
  const storage = opts.storage ?? "SNAPPY";
  const numRows = columns[0]?.values.length ?? 0;
  for (const c of columns) {
    if (c.values.length !== numRows) throw new Error(`column ${c.name}: ragged length`);
  }
  const groupRows = Math.max(1, opts.rowGroupRows ?? Math.max(numRows, 1));
  const out = new Sink();
  out.bytes(new TextEncoder().encode("PAR1"));
  const groups: TValue[] = [];
  for (let start = 0; start < numRows || (numRows === 0 && start === 0); start += groupRows) {
    const end = Math.min(numRows, start + groupRows);
    const chunks: TValue[] = [];
    let total = 0;
    for (const c of columns) {
      const r = writeChunk(out, c, c.values.slice(start, end), storage);
      chunks.push(r.meta);
      total += r.uncompressed;
    }
    groups.push(
      struct([
        [1, { t: "list", elem: "struct", v: chunks }],
        [2, i64(total)],
        [3, i64(end - start)],
      ]),
    );
    if (numRows === 0) break;
  }
  const schema: TValue[] = [
    struct([
      [4, bin("schema")],
      [5, i32(columns.length)],
    ]),
    ...columns.map((c) => {
      const f: (readonly [number, TValue])[] = [
        [1, i32(TYPE_ID[c.type])],
        [3, i32(c.required ? 0 : 1)],
        [4, bin(c.name)],
      ];
      if (c.logical === "STRING") f.push([6, i32(0)], [10, struct([[1, struct([])]])]);
      if (c.logical === "DATE") f.push([6, i32(6)], [10, struct([[6, struct([])]])]);
      return struct(f);
    }),
  ];
  const kv = Object.entries(opts.keyValue ?? {}).map(([k, v]) =>
    struct([
      [1, bin(k)],
      [2, bin(v)],
    ]),
  );
  const meta: (readonly [number, TValue])[] = [
    [1, i32(2)],
    [2, { t: "list", elem: "struct", v: schema }],
    [3, i64(numRows)],
    [4, { t: "list", elem: "struct", v: groups }],
  ];
  if (kv.length > 0) meta.push([5, { t: "list", elem: "struct", v: kv }]);
  meta.push([6, bin(opts.createdBy ?? "espn-fantasy-football-mcp test writer")]);
  const footer = new Sink();
  writeStruct(footer, meta);
  const fb = footer.toBytes();
  out.bytes(fb);
  out.u32le(fb.length);
  out.bytes(new TextEncoder().encode("PAR1"));
  return out.toBytes();
}
