// schema-bounds.test.ts — the parquet SCHEMA is checked before hyparquet walks it (Stage C
// remediation nflverse-parquet-negative-children-hang): a 35-byte file whose one leaf claims
// num_children −1 held parquetMetadata's GeoParquet pass in an endless synchronous loop at 100 %
// CPU, ignoring SIGTERM, so a scheduled refresh spun forever, wrote no refresh_log row and piled up
// stuck processes. The fix opens the footer with GeoParquet off, refuses a negative/oversized child
// count and a DECIMAL converted type (hyparquet converts a DECIMAL column's statistics with a
// super-quadratic BigInt loop DURING the parse) in the bounded footer walk, and then requires one
// well-formed schema tree (`assertSchemaTree`) so this scan, checkParquet and hyparquet's decoder
// all resolve a column to the SAME element. Every hostile file is built byte by byte
// (helpers/hostile-parquet.ts) next to a control that opens; the finding's own 35-byte file is
// written from its hex. The end-to-end leg runs in a child process under a hard deadline, because a
// regression would hang the test runner, not fail it (decode-bounds.test.ts asserts the refresh
// result; this asserts the process returns at all). No network, no cookie.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileMetaData, SchemaElement } from "hyparquet";
import { EXPECTED_COLUMNS } from "../../../src/sources/nflverse/index.js";
import { openParquet } from "../../../src/sources/nflverse/parquet.js";
import {
  assertSchemaTree,
  PARQUET_DECODE_LIMITS,
  scanParquetPages,
} from "../../../src/sources/nflverse/parquet-bounds.js";
import { NflverseSourceError } from "../../../src/sources/nflverse/release.js";
import {
  hostileParquet,
  nullPage,
  thrift,
  type HostileColumn,
  type ThriftField,
} from "./helpers/hostile-parquet.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function write(bytes: Uint8Array): string {
  const d = mkdtempSync(join(tmpdir(), "eff-schema-bounds-"));
  dirs.push(d);
  const p = join(d, "f.parquet");
  writeFileSync(p, bytes);
  return p;
}

/** Opens `bytes` and returns the NflverseSourceError it is refused with (fails if it opens). */
async function refusal(bytes: Uint8Array): Promise<NflverseSourceError> {
  try {
    await openParquet(write(bytes));
  } catch (e) {
    if (e instanceof NflverseSourceError) return e;
    throw e;
  }
  throw new Error("openParquet resolved; expected a refusal");
}

/** The finding's hex, byte for byte: PAR1, a footer whose schema LIST holds a root (num_children 1)
 *  and one BYTE_ARRAY leaf with num_children −1, the footer length, PAR1. */
const FINDING_HEX =
  "50415231 1504192c4801731502 00 150c3801611501 00 1600190c00 17000000 50415231".replace(/ /g, "");
const findingFile = (): Uint8Array =>
  Uint8Array.from(FINDING_HEX.match(/../g)!.map((h) => Number.parseInt(h, 16)));

/** A root named `schema` with `childCount` claimed, then `children` flat elements. */
function schema(
  childCount: number,
  children: readonly (readonly ThriftField[])[],
): ThriftField[][] {
  return [
    [
      [4, thrift.bin("schema")],
      [5, thrift.i32(childCount)],
    ],
    ...children.map((f) => [...f]),
  ];
}
/** One flat leaf element: type (6 = BYTE_ARRAY), repetition (1 = OPTIONAL), name, UTF8. */
const leaf = (name: string, fields: readonly ThriftField[] = []): ThriftField[] => [
  [1, thrift.i32(6)],
  [3, thrift.i32(1)],
  [4, thrift.bin(name)],
  [6, thrift.i32(0)],
  ...fields,
];
const col = (name: string): HostileColumn => ({
  name,
  type: "BYTE_ARRAY",
  utf8: true,
  pages: [nullPage(1)],
});

describe("the finding's file: a 35-byte parquet with a negative schema num_children", () => {
  it("is 35 bytes and refused as schema_mismatch, not opened (it looped forever before the fix)", async () => {
    const finding = findingFile();
    expect(finding.length).toBe(35);
    const e = await refusal(finding);
    expect(e.reason).toBe("not_parquet");
    expect(e.code).toBe("schema_mismatch");
    expect(e.message).toMatch(/child count/);
  });
});

describe("openParquet refuses a hostile schema before hyparquet walks it", () => {
  it("control: a flat two-column file opens", async () => {
    const bytes = hostileParquet({ groupRows: 1, columns: [col("a"), col("b")] });
    const opened = await openParquet(write(bytes));
    expect(opened.metadata.schema).toHaveLength(3); // root + 2
  });

  it("a negative num_children on a leaf (the finding's shape, built through the helper)", async () => {
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [col("a")],
      schema: schema(1, [leaf("a", [[5, thrift.i32(-1)]])]),
    });
    expect((await refusal(bytes)).message).toMatch(/child count/);
  });

  it("a DOUBLE-typed num_children (hyparquet steps by it; a non-integer never ends the walk)", async () => {
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [col("a")],
      schema: schema(1, [leaf("a", [[5, thrift.double(1.5)]])]),
    });
    expect((await refusal(bytes)).message).toMatch(/child count/);
  });

  it("a DECIMAL converted type (hyparquet parses its statistics with a super-quadratic BigInt loop)", async () => {
    // a 200 KB statistics min bytes on a DECIMAL column hangs parquetMetadata at HEAD; the bounded
    // footer walk refuses the converted type before the parse, so parseDecimal never runs.
    const big = new Uint8Array(200_000).fill(0x7f);
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [{ ...col("a"), type: "INT32", utf8: false, statistics: [[2, thrift.bin(big)]] }],
      schema: schema(1, [
        [
          [1, thrift.i32(1)], // INT32
          [3, thrift.i32(1)],
          [4, thrift.bin("a")],
          [6, thrift.i32(5)], // converted_type DECIMAL
        ],
      ]),
    });
    expect((await refusal(bytes)).message).toMatch(/DECIMAL/);
  });

  it("a DATE converted type and other integer converted types still open (only DECIMAL is refused)", async () => {
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [{ ...col("a"), type: "INT32", utf8: false }],
      schema: schema(1, [
        [
          [1, thrift.i32(1)],
          [3, thrift.i32(1)],
          [4, thrift.bin("a")],
          [6, thrift.i32(6)], // converted_type DATE
        ],
      ]),
    });
    const opened = await openParquet(write(bytes));
    expect(opened.metadata.schema[1]?.converted_type).toBe("DATE");
  });

  it("two children of one group sharing a name (the scan and the decoder would pick different ones)", async () => {
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [col("dup")],
      schema: schema(2, [leaf("dup"), leaf("dup")]),
    });
    expect((await refusal(bytes)).message).toMatch(/share a name/);
  });

  it("a REPEATED root (hyparquet counts the root's repetition in every column's level)", async () => {
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [col("a")],
      schema: [
        [
          [3, thrift.i32(2)], // REPEATED
          [4, thrift.bin("schema")],
          [5, thrift.i32(1)],
        ],
        leaf("a"),
      ],
    });
    expect((await refusal(bytes)).message).toMatch(/repeated root/);
  });
});

describe("assertSchemaTree: one well-formed tree, or NflverseSourceError not_parquet", () => {
  const el = (o: Partial<SchemaElement>): SchemaElement => ({ name: "x", ...o });
  const root = (num_children: number): SchemaElement => el({ name: "schema", num_children });

  it("accepts a flat tree and a legitimately nested one within the depth bound", () => {
    expect(() => {
      assertSchemaTree([
        root(2),
        el({ name: "a", type: "INT32" }),
        el({ name: "b", type: "DOUBLE" }),
      ]);
    }).not.toThrow();
    // root → group g (1 child) → leaf: depth 2
    expect(() => {
      assertSchemaTree([
        root(1),
        el({ name: "g", num_children: 1 }),
        el({ name: "leaf", type: "INT32" }),
      ]);
    }).not.toThrow();
  });

  it.each<[string, readonly SchemaElement[], RegExp]>([
    ["no root", [], /no root/],
    ["a negative child count", [root(-1)], /not a count/],
    [
      "a non-integer child count",
      [el({ name: "schema", num_children: 1.5 }), el({ name: "a", type: "INT32" })],
      /not a count/,
    ],
    [
      "an element outside the root's tree (root claims one child, two follow)",
      [root(1), el({ name: "a", type: "INT32" }), el({ name: "b", type: "INT32" })],
      /outside the root's tree/,
    ],
    [
      "a group with fewer children than it claims (root claims two, one follows)",
      [root(2), el({ name: "a", type: "INT32" })],
      /fewer children than it claims/,
    ],
    [
      "a nested group with fewer children than it claims (claims one, none follow)",
      [root(1), el({ name: "g", num_children: 1 })],
      /fewer children than it claims/,
    ],
    [
      "two children of one group sharing a name",
      [root(2), el({ name: "a", type: "INT32" }), el({ name: "a", type: "DOUBLE" })],
      /share a name/,
    ],
    [
      "a repeated root",
      [el({ name: "schema", num_children: 0, repetition_type: "REPEATED" })],
      /repeated root/,
    ],
  ])("refuses %s", (_label, schemaList, re) => {
    expect(() => {
      assertSchemaTree(schemaList);
    }).toThrow(re);
    expect(() => {
      assertSchemaTree(schemaList);
    }).toThrow(NflverseSourceError);
  });

  it("refuses nesting past maxSchemaDepth, and the bound scales with the limit given", () => {
    // a chain of groups: root → g1 → g2 → … ; each group claims one child
    const chain = (depth: number): SchemaElement[] => {
      const out: SchemaElement[] = [root(1)];
      for (let i = 1; i < depth; i++) out.push(el({ name: `g${String(i)}`, num_children: 1 }));
      out.push(el({ name: "leaf", type: "INT32" }));
      return out;
    };
    expect(() => {
      assertSchemaTree(chain(PARQUET_DECODE_LIMITS.maxSchemaDepth + 5));
    }).toThrow(/nested deeper than the bound/);
    expect(() => {
      assertSchemaTree(chain(5), { ...PARQUET_DECODE_LIMITS, maxSchemaDepth: 3 });
    }).toThrow(/nested deeper than the bound/);
    expect(() => {
      assertSchemaTree(chain(5), { ...PARQUET_DECODE_LIMITS, maxSchemaDepth: 10 });
    }).not.toThrow();
  });
});

describe("the page scan requires a chunk's type to be its column's", () => {
  // hyparquet decodes a chunk by the chunk's ColumnMetaData type; this scan reads its schema
  // element's type. A chunk declaring INT32 under a BYTE_ARRAY element would decode as a different
  // physical type than the scan verified — refuse the disagreement. (This guard cannot hang, so it
  // is exercised in process, editing the chunk's type the way decode-bounds.test.ts edits metadata.)
  it("refuses a column chunk whose ColumnMetaData type differs from its schema element's", async () => {
    const col0 = Object.keys(EXPECTED_COLUMNS["nflverse:players"])[0];
    expect(col0).toBeDefined();
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [{ name: col0!, type: "BYTE_ARRAY", utf8: true, pages: [nullPage(1)] }],
    });
    const opened = await openParquet(write(bytes));
    const edited = structuredClone<FileMetaData>(opened.metadata);
    const md = edited.row_groups[0]?.columns[0]?.meta_data;
    if (md === undefined) throw new Error("no chunk");
    (md as { type: string }).type = "INT32"; // the schema element stays BYTE_ARRAY
    expect(() => {
      scanParquetPages(new Uint8Array(bytes), edited, [col0!]);
    }).toThrow(/type is not its column's/);
    // unedited: the same file scans
    expect(() => {
      scanParquetPages(new Uint8Array(bytes), opened.metadata, [col0!]);
    }).not.toThrow();
  });
});

interface ChildResult {
  readonly opened: string;
  readonly status: string;
  readonly source_error: string | null;
  readonly published: number;
  readonly logged: string | null;
}

describe("end to end, in a child process (a regression HANGS the runner, so it is spawned)", () => {
  const CHILD = join(import.meta.dirname, "procs", "open-parquet-child.ts");
  const ROOT = join(import.meta.dirname, "..", "..", "..");
  const run = (p: string): { status: number | null; result: ChildResult } => {
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, p], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 25_000,
    });
    return { status: r.status, result: JSON.parse(r.stdout.trim()) as ChildResult };
  };

  it("the 35-byte finding file: the process returns, fails schema_mismatch, publishes nothing", () => {
    const { status, result } = run(write(findingFile()));
    expect(status).toBe(0); // not killed by the deadline (it hung at HEAD)
    expect(result.opened).toMatch(/child count/);
    expect(result.status).toBe("failed");
    expect(result.source_error).toBe("schema_mismatch");
    expect(result.published).toBe(0);
    expect(result.logged).toBe("schema_mismatch");
  });

  it("a DECIMAL-statistics file (a quadratic parse at HEAD): the process returns and refuses it", () => {
    const big = new Uint8Array(300_000).fill(0x7f);
    const bytes = hostileParquet({
      groupRows: 1,
      columns: [
        { name: "x", type: "INT32", pages: [nullPage(1)], statistics: [[2, thrift.bin(big)]] },
      ],
      schema: schema(1, [
        [
          [1, thrift.i32(1)],
          [3, thrift.i32(1)],
          [4, thrift.bin("x")],
          [6, thrift.i32(5)], // DECIMAL
        ],
      ]),
    });
    const { status, result } = run(write(bytes));
    expect(status).toBe(0);
    expect(result.status).toBe("failed");
  });

  it("a control file publishes (the schema checks pass a real, flat parquet)", () => {
    const columns: HostileColumn[] = Object.entries(EXPECTED_COLUMNS["nflverse:players"]).map(
      ([name, kind]) => ({
        name,
        type: kind === "int" ? "INT32" : kind === "double" ? "DOUBLE" : "BYTE_ARRAY",
        utf8: kind === "string" || kind === "date",
        pages: [nullPage(1)],
      }),
    );
    const { status, result } = run(write(hostileParquet({ groupRows: 1, columns })));
    expect(status).toBe(0);
    expect(result.opened).toBe("opened");
    expect(result.published).toBe(1);
  });
});
