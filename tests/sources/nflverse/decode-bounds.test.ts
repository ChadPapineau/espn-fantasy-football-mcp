// decode-bounds.test.ts — a hostile release file never reaches hyparquet unchecked (Stage C
// remediation nflverse-parquet-decode-bomb; src/sources/nflverse/parquet-bounds.ts): a 1.5 KB file
// whose pages claim 2^25 nulls each passed the schema check and aborted the refresh with a fatal
// out-of-memory; a row group claiming ten million rows over one value built ten million row objects.
// Each is now refused as `corrupt` (refresh_log `schema_mismatch`) by the schema check and by
// publish, before any large allocation; the footer is walked by a bounded reader first. Every
// hostile file is built byte by byte (helpers/hostile-parquet.ts) next to a control that decodes.
// No network: the release is served by the fake transport.
import { afterEach, describe, expect, it } from "vitest";
import type { FileMetaData } from "hyparquet";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { assertNflverseSchema, eachRow } from "../../../src/sources/nflverse/base.js";
import { EXPECTED_COLUMNS, playersSource } from "../../../src/sources/nflverse/index.js";
import { checkParquet, openParquet, readRowGroups } from "../../../src/sources/nflverse/parquet.js";
import {
  assertBoundedFooter,
  PARQUET_DECODE_LIMITS,
  scanParquetPages,
  type ParquetDecodeLimits,
} from "../../../src/sources/nflverse/parquet-bounds.js";
import { NflverseSourceError } from "../../../src/sources/nflverse/release.js";
import { fsTempArea, runRefresh } from "../../../src/sources/runner.js";
import {
  fakeProSchedule,
  fakePublisher,
  fakeRefreshLog,
  proGame as runnerGame,
} from "../runner/helpers.js";
import { REL } from "./helpers/fixtures.js";
import { makeCtx, type Ctx } from "./helpers/harness.js";
import {
  concat,
  defRun,
  ENC,
  footerNodeBomb,
  forContract,
  hostileParquet,
  nullPage,
  onePresent,
  PAGE,
  plainStrings,
  uvarint,
  type HostileColumn,
  type HostilePage,
} from "./helpers/hostile-parquet.js";
import { tempFile } from "./helpers/rewrite.js";

const PLAYERS = EXPECTED_COLUMNS["nflverse:players"];
const open: Ctx[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.cleanup();
});
function dir(): string {
  const c = makeCtx([2026]);
  open.push(c);
  return c.tempDir;
}
const file = (bytes: Uint8Array) => tempFile(dir(), "f.parquet", bytes, null);

/** The nflverse:players contract, the same pages per column (a control unless they are hostile). */
const players = (page: () => readonly HostilePage[], groupRows = 1): Uint8Array =>
  forContract(PLAYERS, page, { groupRows });

/** Scans `bytes` for `columns` with `limits` (the default bounds unless given). */
async function scan(
  bytes: Uint8Array,
  columns: readonly string[],
  limits: ParquetDecodeLimits = PARQUET_DECODE_LIMITS,
  edit?: (md: FileMetaData) => FileMetaData,
): Promise<void> {
  const opened = await openParquet(file(bytes).path);
  scanParquetPages(bytes, edit ? edit(opened.metadata) : opened.metadata, columns, limits);
}

const one = (c: Omit<HostileColumn, "name" | "type"> & Partial<HostileColumn>): HostileColumn => ({
  name: "gsis_id",
  type: "BYTE_ARRAY",
  utf8: true,
  ...c,
});

describe("the finding's files: refused by the schema check and by publish, before decoding", () => {
  it("control: the same layout without the bomb passes and decodes one row", async () => {
    const bytes = players(() => [nullPage(1)]);
    const r = await assertNflverseSchema("nflverse:players", [file(bytes)]);
    expect(r).toMatchObject({ ok: true, rows: 1 });
    const rows: unknown[] = [];
    await eachRow("nflverse:players", [file(bytes)], (raw) => rows.push(raw));
    expect(rows).toHaveLength(1);
  });

  it("every column's page a 2^25-null RLE run with num_values 1 (1.5 KB): schema_mismatch, no decode", async () => {
    const bytes = players(() => [{ numValues: 1, encoding: ENC.PLAIN, body: defRun(2 ** 25, 0) }]);
    expect(bytes.length).toBeLessThan(2048);
    const r = await assertNflverseSchema("nflverse:players", [file(bytes)]);
    expect(r).toMatchObject({ ok: false, error: "schema_mismatch" });
    expect(r.warnings.join("\n")).toMatch(/overrun/);
    await expect(eachRow("nflverse:players", [file(bytes)], () => undefined)).rejects.toMatchObject(
      {
        reason: "corrupt",
        code: "schema_mismatch",
      },
    );
  });

  it("a row group claiming 10,000 rows over one value per column: refused (it built a row object per claimed row)", async () => {
    const bytes = players(() => [nullPage(1)], 10_000);
    const r = await assertNflverseSchema("nflverse:players", [file(bytes)]);
    expect(r).toMatchObject({ ok: false, error: "schema_mismatch" });
    expect(r.warnings.join("\n")).toMatch(/do not hold its row group's rows/);
    const opened = await openParquet(file(bytes).path);
    const it = readRowGroups(opened, Object.keys(PLAYERS));
    await expect(it.next()).rejects.toBeInstanceOf(NflverseSourceError);
  });

  it("ten million claimed rows, pages agreeing: refused by the row bound", async () => {
    const n = 10_000_000;
    const bytes = players(() => [nullPage(n)], n);
    await expect(scan(bytes, Object.keys(PLAYERS))).rejects.toThrow(
      /more rows than the decode bound/,
    );
  });

  it("through the runner: the release fails schema_mismatch, nothing is published, the process lives", async () => {
    const bomb = players(() => [{ numValues: 1, encoding: ENC.PLAIN, body: defRun(2 ** 25, 0) }]);
    const routes = new Map<string, Uint8Array>([
      [`${REL}/players/timestamp.txt`, new TextEncoder().encode("2026-10-06 01:46:36 EDT")],
      [`${REL}/players/players.parquet`, bomb],
    ]);
    const c = makeCtx([2026], { routes });
    open.push(c);
    const publisher = fakePublisher();
    const refreshLog = fakeRefreshLog();
    const r = await runRefresh(
      { source: playersSource, seasons: [2026], week: null },
      {
        http: c.ctx.http,
        download: c.ctx.download,
        clock: fixedClock("2026-10-06T12:00:00.000Z"),
        rng: seededRng(1),
        publisher,
        refreshLog,
        proSchedule: fakeProSchedule([runnerGame(1, "2026-10-04T17:00:00.000Z")]),
        temp: fsTempArea(`${c.tempDir}/tmp`),
        sleep: () => Promise.resolve(),
      },
    );
    expect(r).toMatchObject({ status: "failed", error: "schema", source_error: "schema_mismatch" });
    expect(publisher.published).toEqual([]);
    expect(refreshLog.rows.at(-1)).toMatchObject({ ok: false, error: "schema_mismatch" });
  });
});

describe("page checks (one flat column)", () => {
  const cols = ["gsis_id"];
  const single = (c: Omit<HostileColumn, "name" | "type">, groupRows = 1) =>
    hostileParquet({ groupRows, columns: [one(c)] });

  it("control: a dictionary page + an RLE_DICTIONARY page, and a PLAIN page, pass", async () => {
    const dict = plainStrings(["00-0000001"]);
    const idx = [1, 2, 0]; // bit width 1, one RLE run of 1 × index 0
    await scan(
      single({
        pages: [
          { type: PAGE.DICTIONARY, numValues: 1, body: dict },
          { numValues: 1, encoding: ENC.RLE_DICTIONARY, body: concat(defRun(1, 1), idx) },
        ],
      }),
      cols,
    );
    await scan(single({ pages: [onePresent("00-0000001")] }), cols);
    await scan(single({ pages: [onePresent("x")], codec: "UNCOMPRESSED" }), cols);
    await scan(
      single({ pages: [{ numValues: 1, body: plainStrings(["x"]) }], repetition: 0 }),
      cols,
    );
  });

  it("refuses a dictionary index RLE run past the page's values", async () => {
    const runs: number[] = [1]; // bit width 1
    uvarint(runs, 1 << 21); // an RLE run of 2^20 indices
    runs.push(0);
    await expect(
      scan(
        single({
          pages: [
            { type: PAGE.DICTIONARY, numValues: 1, body: plainStrings(["x"]) },
            { numValues: 1, encoding: ENC.RLE_DICTIONARY, body: concat(defRun(1, 1), runs) },
          ],
        }),
        cols,
      ),
    ).rejects.toThrow(/overrun/);
  });

  it("refuses a bit-packed run past its page and an RLE value past it", async () => {
    const levels: number[] = [];
    uvarint(levels, (1000 << 1) | 1); // 1000 bit-packed groups, no bytes behind them
    const body = concat([levels.length, 0, 0, 0], levels);
    await expect(scan(single({ pages: [{ numValues: 1, body }] }), cols)).rejects.toThrow(
      /bit-packed run past the page/,
    );
    const rle: number[] = [];
    uvarint(rle, 1 << 1); // an RLE run of 1, its value byte missing
    await expect(
      scan(single({ pages: [{ numValues: 1, body: concat([rle.length, 0, 0, 0], rle) }] }), cols),
    ).rejects.toThrow(/RLE value past the page/);
  });

  it("counts present values through bit-packed and RLE definition levels alike", async () => {
    // 3 values: bit-packed group [1,0,1] (+ padding), then the two present values' dictionary indices
    const levels = [3, 0b00000101]; // header (1 group << 1 | 1), bits LSB first
    const idx = [1, 4, 0]; // bit width 1, an RLE run of 2 × index 0
    await scan(
      single(
        {
          pages: [
            { type: PAGE.DICTIONARY, numValues: 1, body: plainStrings(["x"]) },
            {
              numValues: 3,
              encoding: ENC.RLE_DICTIONARY,
              body: concat([levels.length, 0, 0, 0], levels, idx),
            },
          ],
        },
        3,
      ),
      cols,
    );
    // three present values claimed by the levels but only two indices behind them: still decodable
    // (hyparquet stops at the end); a run of 3 where 2 are present overruns
    const over = [1, 6, 0];
    await expect(
      scan(
        single(
          {
            pages: [
              { type: PAGE.DICTIONARY, numValues: 1, body: plainStrings(["x"]) },
              {
                numValues: 3,
                encoding: ENC.RLE_DICTIONARY,
                body: concat([levels.length, 0, 0, 0], levels, over),
              },
            ],
          },
          3,
        ),
        cols,
      ),
    ).rejects.toThrow(/overrun/);
  });

  it("refuses a page larger than the bound, a dictionary claiming more entries than its bytes, a negative count", async () => {
    await expect(
      scan(
        single({
          pages: [{ ...onePresent("x"), uncompressedSize: PARQUET_DECODE_LIMITS.maxPageBytes + 1 }],
        }),
        cols,
      ),
    ).rejects.toThrow(/larger than the decode bound/);
    await expect(
      scan(
        single({
          pages: [
            { type: PAGE.DICTIONARY, numValues: 1_000_000, body: plainStrings(["x"]) },
            onePresent("x"),
          ],
        }),
        cols,
      ),
    ).rejects.toThrow(/more entries than its bytes hold/);
    await expect(
      scan(single({ pages: [{ ...nullPage(1), numValues: -1 }] }), cols),
    ).rejects.toThrow(/negative/);
  });

  it("refuses V2, index and unverified encodings (never decoded unchecked)", async () => {
    await expect(
      scan(single({ pages: [{ ...nullPage(1), type: PAGE.DATA_V2 }] }), cols),
    ).rejects.toThrow(/page type the reader does not verify/);
    await expect(
      scan(single({ pages: [{ ...nullPage(1), type: PAGE.INDEX }] }), cols),
    ).rejects.toThrow(/page type the reader does not verify/);
    for (const encoding of [ENC.DELTA_BINARY_PACKED, ENC.BYTE_STREAM_SPLIT, 77])
      await expect(scan(single({ pages: [{ ...nullPage(1), encoding }] }), cols)).rejects.toThrow(
        /page encoding the reader does not verify/,
      );
    await expect(
      scan(single({ pages: [{ ...nullPage(1), encoding: ENC.RLE }] }), cols),
    ).rejects.toThrow(/RLE value page that is not boolean/);
  });

  it("boolean RLE pages: their run lengths are checked like any other", async () => {
    const bool = (body: Uint8Array) =>
      hostileParquet({
        groupRows: 1,
        columns: [
          { name: "flag", type: "BOOLEAN", pages: [{ numValues: 1, encoding: ENC.RLE, body }] },
        ],
      });
    const ok = concat(defRun(1, 1), [2, 0, 0, 0, 2, 1]); // a 4-byte length, an RLE run of 1 × true
    await scan(bool(ok), ["flag"]);
    const over = concat(defRun(1, 1), [2, 0, 0, 0, 20, 1]); // an RLE run of 10
    await expect(scan(bool(over), ["flag"])).rejects.toThrow(/overrun/);
    await expect(scan(bool(defRun(1, 1)), ["flag"])).rejects.toThrow(/lacks its run lengths/);
  });

  it("refuses an index wider than 32 bits, a missing index width, missing levels", async () => {
    const page = (tail: readonly number[]) =>
      single({
        pages: [
          { type: PAGE.DICTIONARY, numValues: 1, body: plainStrings(["x"]) },
          { numValues: 1, encoding: ENC.RLE_DICTIONARY, body: concat(defRun(1, 1), tail) },
        ],
      });
    await expect(scan(page([40, 2, 0]), cols)).rejects.toThrow(/wider than 32 bits/);
    await expect(scan(page([]), cols)).rejects.toThrow(/lacks its index width/);
    await scan(page([0]), cols); // bit width 0: every index is 0, nothing to walk
    await expect(
      scan(single({ pages: [{ numValues: 1, body: new Uint8Array([1, 0]) }] }), cols),
    ).rejects.toThrow(/lacks its definition levels/);
  });

  it("refuses pages that disagree with the row group: too many values, too few, overflowing the chunk", async () => {
    await expect(scan(single({ pages: [nullPage(2)] }, 1), cols)).rejects.toThrow(
      /more values than its row group's rows/,
    );
    await expect(scan(single({ pages: [nullPage(1)] }, 2), cols)).rejects.toThrow(
      /do not hold its row group's rows/,
    );
    await expect(
      scan(
        single({ pages: [{ ...onePresent("x"), uncompressedSize: 3 }], codec: "UNCOMPRESSED" }),
        cols,
      ),
    ).rejects.toThrow(/uncompressed page's sizes disagree/);
    await expect(
      scan(single({ pages: [{ ...onePresent("x"), uncompressedSize: 999 }] }), cols),
    ).rejects.toThrow(/does not decompress/);
  });
});

describe("file-level checks (metadata the decode trusts)", () => {
  const base = hostileParquet({ groupRows: 2, columns: [one({ pages: [nullPage(2)] })] });
  const cols = ["gsis_id"];
  type Mutable = { -readonly [K in keyof FileMetaData]: FileMetaData[K] };
  const edit =
    (fn: (md: Mutable) => void) =>
    (md: FileMetaData): FileMetaData => {
      const copy = structuredClone<Mutable>(md);
      fn(copy);
      return copy;
    };
  const chunkMd = (md: Mutable) => {
    const m = md.row_groups[0]?.columns[0]?.meta_data;
    if (m === undefined) throw new Error("no chunk");
    return m;
  };

  it("dictionary entries count against the cell bound (millions of empty strings are cells too)", async () => {
    const empties = new Uint8Array(4 * 1000); // 1,000 zero-length BYTE_ARRAY entries
    const withDict = hostileParquet({
      groupRows: 1,
      columns: [
        one({
          pages: [{ type: PAGE.DICTIONARY, numValues: 1000, body: empties }, onePresent("x")],
        }),
      ],
    });
    await scan(withDict, cols, { ...PARQUET_DECODE_LIMITS, maxCells: 1001 });
    await expect(
      scan(withDict, cols, { ...PARQUET_DECODE_LIMITS, maxCells: 1000 }),
    ).rejects.toThrow(/dictionary entries exceed the decode bound/);
  });

  it("decompressed page bytes are summed against their bound (a 21× snappy expansion is bytes too)", async () => {
    const two = hostileParquet({
      groupRows: 2,
      columns: [one({ pages: [onePresent("abc"), onePresent("def")] })],
    });
    const perPage = defRun(1, 1).length + plainStrings(["abc"]).length;
    await scan(two, cols, { ...PARQUET_DECODE_LIMITS, maxDecodedBytes: 2 * perPage });
    await expect(
      scan(two, cols, { ...PARQUET_DECODE_LIMITS, maxDecodedBytes: 2 * perPage - 1 }),
    ).rejects.toThrow(/decompress to more bytes than the decode bound/);
  });

  it("the cell and row bounds scale with the limits given", async () => {
    await scan(base, cols);
    await expect(scan(base, cols, { ...PARQUET_DECODE_LIMITS, maxRows: 1 })).rejects.toThrow(
      /more rows/,
    );
    await expect(
      scan(base, ["gsis_id", "gsis_id"], { ...PARQUET_DECODE_LIMITS, maxCells: 3 }),
    ).rejects.toThrow(/more cells/);
  });

  it.each([
    [
      "a file row count that is not the groups' sum",
      (md: Mutable) => void (md.num_rows = 3n),
      /not the sum/,
    ],
    [
      "a row count that is not a count",
      (md: Mutable) => void ((md.row_groups[0] as { num_rows: unknown }).num_rows = -1n),
      /not a count/,
    ],
    [
      "a chunk outside the file",
      (md: Mutable) => void (chunkMd(md).total_compressed_size = 10n ** 9n),
      /outside the file/,
    ],
    [
      "a disallowed codec",
      (md: Mutable) => void (chunkMd(md).codec = "ZSTD"),
      /codec is not allowed/,
    ],
    [
      "a nested chunk path",
      (md: Mutable) => void (chunkMd(md).path_in_schema = ["gsis_id", "x"]),
      /nested/,
    ],
    [
      "a chunk in another file",
      (md: Mutable) =>
        void ((md.row_groups[0]?.columns[0] as { file_path?: string }).file_path = "x"),
      /another file/,
    ],
    [
      "a chunk without metadata",
      (md: Mutable) =>
        void ((md.row_groups[0]?.columns[0] as { meta_data?: unknown }).meta_data = undefined),
      /no metadata/,
    ],
    [
      "a repeated column",
      (md: Mutable) =>
        void ((md.schema[1] as { repetition_type?: string }).repetition_type = "REPEATED"),
      /not a flat leaf/,
    ],
    [
      "a group column",
      (md: Mutable) => void ((md.schema[1] as { num_children?: number }).num_children = 1),
      /not a flat leaf|not in the file/,
    ],
    [
      "a column chunk missing from the row group",
      (md: Mutable) => void ((md.row_groups[0] as { columns: unknown[] }).columns = []),
      /lacks or repeats/,
    ],
  ])("refuses %s", async (_label, fn, re) => {
    await expect(scan(base, cols, PARQUET_DECODE_LIMITS, edit(fn))).rejects.toThrow(re);
  });

  it("refuses a contract column the file lacks; an empty row group is never scanned", async () => {
    await expect(scan(base, ["other"])).rejects.toThrow(/not in the file/);
    await scan(
      base,
      cols,
      PARQUET_DECODE_LIMITS,
      edit((md) => {
        md.num_rows = 0n;
        (md.row_groups[0] as { num_rows: bigint }).num_rows = 0n;
      }),
    );
  });

  it("a REPEATED column fails the schema check naming it", async () => {
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [one({ repetition: 2, pages: [nullPage(1)] })],
    });
    const opened = await openParquet(file(bytes).path);
    expect(checkParquet(opened.metadata, { gsis_id: "string" }).mismatches).toEqual([
      { column: "gsis_id", expected: "string", found: "REPEATED BYTE_ARRAY/UTF8" },
    ]);
  });

  // The default cell cap bounds the peak of a WITHIN-cap file (every page honest): the narrowest
  // contract at the cap builds one row object per row. The cap was tightened to 1<<24 so that worst
  // case peaks ~1.7 GB, not the ~2.7 GB that 1<<25 allowed; 1<<24 still clears every real file (the
  // most cells of any contract is depth_charts 2026, 613,196 rows × 11 cols ≈ 6.7 M, a 2.5× margin).
  it("the default cell cap refuses a file the looser pre-fix cap allowed (nine columns at max rows)", async () => {
    const rows = PARQUET_DECODE_LIMITS.maxRows; // 1<<21
    const names = Array.from({ length: 9 }, (_, i) => `c${String(i)}`);
    const wide = hostileParquet({
      groupRows: rows,
      columns: names.map((name) => ({ name, type: "INT32" as const, pages: [nullPage(rows)] })),
    });
    // 9 × (1<<21) = 18.9 M cells: over the shipped 1<<24 (16.8 M), under the old 1<<25 (33.6 M)
    await expect(scan(wide, names)).rejects.toThrow(/more cells than the decode bound/);
    await scan(wide, names, { ...PARQUET_DECODE_LIMITS, maxCells: 1 << 25 });
  });
});

describe("the footer is walked by a bounded reader before hyparquet parses it", () => {
  const control = { groupRows: 1, columns: [one({ pages: [nullPage(1)] })] };
  const withTail = (tail: readonly number[]) =>
    hostileParquet({ ...control, footerTail: Uint8Array.from(tail) });
  const footerFails = async (bytes: Uint8Array) =>
    expect(openParquet(file(bytes).path)).rejects.toMatchObject({
      reason: "not_parquet",
      message: "nflverse: unreadable parquet footer",
    });

  // tail fields start at id 100 (long form: type, zigzag id 200 = 0xc8 0x01): hyparquet's footer
  // parse reads fields 1–6 only, so a valid tail parses there and only the bounded walk may refuse it
  const at100 = (type: number): number[] => [type, 0xc8, 0x01];

  it("control: every element type parquet uses is walked the way hyparquet reads it", async () => {
    // 100 BYTE, 101 I16, 102 DOUBLE, 103 TRUE, 104 FALSE, 105 a list of two bools, 106 a binary
    const tail = [
      ...at100(0x03),
      0x05,
      0x14,
      0x04,
      0x17,
      0,
      0,
      0,
      0,
      0,
      0,
      0xf0,
      0x3f,
      0x11,
      0x12,
      0x19,
      0x21,
      0x01,
      0x02,
      0x18,
      0x02,
      0x61,
      0x62,
    ];
    const opened = await openParquet(file(withTail(tail)).path);
    expect(Number(opened.metadata.num_rows)).toBe(1);
  });

  it("a 64-bit varint of 20,000 bytes (a quadratic BigInt in hyparquet) is refused", async () => {
    await footerFails(withTail([...at100(0x06), ...new Array<number>(20_000).fill(0x80), 0x01]));
  });

  it("a 32-bit varint longer than 5 bytes is refused (hyparquet would read garbage)", async () => {
    await footerFails(withTail([...at100(0x05), 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]));
  });

  it("structs or lists nested past the depth bound are refused", async () => {
    const structs = [
      ...at100(0x0c),
      ...new Array<number>(199).fill(0x1c),
      ...new Array<number>(200).fill(0),
    ];
    await footerFails(withTail(structs));
    const lists = [...at100(0x09), ...new Array<number>(40).fill(0x19), 0x05];
    await footerFails(withTail(lists));
  });

  it("a list or binary longer than the bytes left, or a type parquet never uses, is refused", async () => {
    await footerFails(withTail([...at100(0x09), 0xf5, 0xff, 0xff, 0xff, 0xff, 0x07]));
    await footerFails(withTail([...at100(0x08), 0xff, 0xff, 0x03]));
    await footerFails(withTail([...at100(0x0a), 0x00]));
  });

  it("a footer length past the file is refused; the bounded walk is linear", () => {
    expect(() => {
      assertBoundedFooter(Uint8Array.from([0x50, 0x41, 0x52, 0x31]));
    }).toThrow(NflverseSourceError);
    const bytes = withTail([]);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) assertBoundedFooter(bytes);
    expect(performance.now() - t0).toBeLessThan(5_000); // a hang detector, not a budget
  });

  // The amplification the first fix missed: the bounded walk bounded per-element structure, nesting
  // and byte-lengths, but NOT the element COUNT. A footer whose schema list is millions of one-byte
  // empty structs passed the walk, then parquetMetadata built one retained object per element — a
  // few MB of footer became gigabytes of heap and the refresh aborted with a fatal OOM (no
  // refresh_log row, later sources skipped: the finding, by a vector the page scan never sees).
  it("refuses a footer with more thrift elements than the node bound, however small each is", () => {
    // accepted below the bound (a real footer holds ~20k elements), refused above it
    expect(() => {
      assertBoundedFooter(footerNodeBomb(1000));
    }).not.toThrow();
    expect(() => {
      assertBoundedFooter(footerNodeBomb(PARQUET_DECODE_LIMITS.maxThriftNodes + 100_000));
    }).toThrow(NflverseSourceError);
  });

  it("the node bound scales with the limit given (the walk stays O(bound), not O(file))", () => {
    const bomb = footerNodeBomb(50);
    expect(() => {
      assertBoundedFooter(bomb, { ...PARQUET_DECODE_LIMITS, maxThriftNodes: 40 });
    }).toThrow(/unreadable parquet footer/);
    expect(() => {
      assertBoundedFooter(bomb, { ...PARQUET_DECODE_LIMITS, maxThriftNodes: 1000 });
    }).not.toThrow();
  });

  it("openParquet refuses the node bomb by the bounded walk, before hyparquet allocates", async () => {
    // ~2 MB of footer: at HEAD before the node bound this reached parquetMetadata and, scaled to the
    // release caps, aborted the process; now the walk refuses it first and openParquet never decodes.
    const bomb = footerNodeBomb(2_000_000);
    const t0 = performance.now();
    await expect(openParquet(file(bomb).path)).rejects.toMatchObject({
      reason: "not_parquet",
      message: "nflverse: unreadable parquet footer",
    });
    expect(performance.now() - t0).toBeLessThan(5_000); // a hang detector, not a budget
  });
});
