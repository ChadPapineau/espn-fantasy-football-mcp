// schema.test.ts — the schema + codec assertion (plan 01 §5.5 and D9; plan 05 §2 `sources/*`): a
// renamed column fails NAMING it, an extra column passes with a warning, a ZSTD/GZIP/… column chunk
// fails naming column and codec (publish refuses it too), wrong types fail, and non-parquet or empty
// input never passes. Ported from sibling @521f9f3, adapted (report `error` codes; five sources).
import type { FileMetaData, SchemaElement } from "hyparquet";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_COLUMNS,
  NFLVERSE_SOURCES,
  injuriesSource,
  playersSource,
  rosterWeeklySource,
  schedulesSource,
  statsPlayerWeekSource,
  type NflverseSchemaReport,
} from "../../../src/sources/nflverse/index.js";
import { checkParquet, kindMatches } from "../../../src/sources/nflverse/parquet.js";
import { MAX_RELEASE_FILE_BYTES } from "../../../src/sources/nflverse/release.js";
import { isNflverseSourceId, kindsFor } from "../../../src/sources/nflverse/schemas.js";
import type { DataSource } from "../../../src/sources/source.js";
import { PARQUET_SOURCES, requiredUpstreamColumns } from "../../../src/store/datasets/tables.js";
import { OBSERVED_PARQUET } from "../../store/datasets/observed-columns.js";
import { FX } from "./helpers/fixtures.js";
import { SqliteWriter, makeCtx, type Ctx } from "./helpers/harness.js";
import { writeParquet } from "./helpers/parquet-writer.js";
import { rewrite, tempFile } from "./helpers/rewrite.js";

const open: Ctx[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.cleanup();
});
function dir(): string {
  const c = makeCtx([2026]);
  open.push(c);
  return c.tempDir;
}
const assert = async (
  s: DataSource,
  bytes: Uint8Array,
  season: number | null = 2026,
): Promise<NflverseSchemaReport> =>
  (await s.assertSchema([tempFile(dir(), "f.parquet", bytes, season)])) as NflverseSchemaReport;

describe("expected columns", () => {
  it("cover exactly the contract's required upstream columns, for every parquet source", () => {
    expect([...Object.keys(EXPECTED_COLUMNS)].sort()).toEqual([...PARQUET_SOURCES].sort());
    for (const [id, cols] of Object.entries(EXPECTED_COLUMNS)) {
      expect(isNflverseSourceId(id)).toBe(true);
      expect(Object.keys(cols).sort()).toEqual([
        ...requiredUpstreamColumns(id as keyof typeof EXPECTED_COLUMNS),
      ]);
    }
    expect(isNflverseSourceId("nflverse:pbp")).toBe(false);
    expect(EXPECTED_COLUMNS["nflverse:roster_weekly"].birth_date).toBe("date");
    expect(EXPECTED_COLUMNS["nflverse:roster_weekly"].espn_id).toBe("string");
    expect(EXPECTED_COLUMNS["nflverse:roster_weekly"].jersey_number).toBe("int");
    expect(EXPECTED_COLUMNS["nflverse:players"].jersey_number).toBe("string");
    expect(EXPECTED_COLUMNS["nflverse:stats_player_week"].def_sacks).toBe("double");
    expect(EXPECTED_COLUMNS["nflverse:stats_player_week"].fumble_recovery_opp).toBe("int");
    expect(EXPECTED_COLUMNS["nflverse:schedules"].spread_line).toBe("double");
    expect(EXPECTED_COLUMNS["nflverse:schedules"].espn).toBe("string");
    expect(Object.isFrozen(EXPECTED_COLUMNS["nflverse:schedules"])).toBe(true);
  });

  it("every required column exists in the real 2026 release file (grounding, observed-columns.ts)", () => {
    for (const id of PARQUET_SOURCES) {
      const observed = new Set(OBSERVED_PARQUET[id]?.columns ?? []);
      for (const c of Object.keys(EXPECTED_COLUMNS[id]))
        expect(observed.has(c), `${id}.${c}`).toBe(true);
    }
  });

  it("kindsFor is deterministic and frozen", () => {
    expect(kindsFor("nflverse:injuries")).toEqual(EXPECTED_COLUMNS["nflverse:injuries"]);
  });

  it("every fixture passes as-is (types and codecs are nflverse's own)", async () => {
    const cases: [DataSource, string][] = [
      [injuriesSource, FX.injuries],
      [statsPlayerWeekSource, FX.stats],
      [schedulesSource, FX.games],
      [rosterWeeklySource, FX.roster],
      [playersSource, FX.players],
    ];
    for (const [s, rel] of cases) {
      const r = await assert(s, rewrite(rel));
      expect(r.ok, `${s.id}: ${r.warnings.join("; ")}`).toBe(true);
      expect(r.error).toBeNull();
    }
  });
});

describe("renamed, missing and extra columns", () => {
  it("a renamed column fails, naming the column (and the new name is the extra one)", async () => {
    const r = await assert(
      injuriesSource,
      rewrite(FX.injuries, { rename: { report_status: "status_report" } }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("schema_mismatch");
    expect(r.missing_columns).toEqual(["report_status"]);
    expect(r.extra_columns).toContain("status_report");
    expect(r.warnings.join("\n")).toMatch(/missing or renamed column\(s\): report_status/);
  });

  it.each([
    [schedulesSource, FX.games, "espn"],
    [schedulesSource, FX.games, "gametime"],
    [rosterWeeklySource, FX.roster, "espn_id"],
    [rosterWeeklySource, FX.roster, "gsis_id"],
    [statsPlayerWeekSource, FX.stats, "fumble_recovery_opp"],
    [statsPlayerWeekSource, FX.stats, "fg_made_60_"],
    [playersSource, FX.players, "espn_id"],
  ] as const)("%s: a renamed %s fails naming it", async (s, rel, col) => {
    const r = await assert(s, rewrite(rel, { rename: { [col]: `${col}_v2` } }));
    expect(r.ok).toBe(false);
    expect(r.missing_columns).toEqual([col]);
    expect(r.warnings.join("\n")).toContain(`missing or renamed column(s): ${col}`);
  });

  it("dropped columns fail the stats source, naming every one", async () => {
    const r = await assert(
      statsPlayerWeekSource,
      rewrite(FX.stats, { drop: ["passing_yards", "def_sacks"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.missing_columns).toEqual(["def_sacks", "passing_yards"]);
  });

  it("an extra column passes with a warning", async () => {
    const r = await assert(
      injuriesSource,
      rewrite(FX.injuries, {
        extra: [{ name: "date_modified", type: "BYTE_ARRAY", logical: "STRING" }],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.extra_columns).toContain("date_modified");
    expect(r.warnings.join("\n")).toMatch(/extra column\(s\) tolerated: .*date_modified/);
  });

  it("publish refuses a file that fails the assertion (never a partial table)", async () => {
    const d = dir();
    const f = tempFile(d, "bad.parquet", rewrite(FX.injuries, { drop: ["gsis_id"] }), 2026);
    const w = new SqliteWriter(d);
    await expect(injuriesSource.publish([f], w)).rejects.toMatchObject({
      reason: "schema",
      code: "schema_mismatch",
    });
    expect(w.batches).toEqual([]);
    w.close();
  });
});

describe("codec assertion (plan 01 D9; ADV OBJ-19(d))", () => {
  it.each(["ZSTD", "GZIP", "BROTLI", "LZ4", "LZO"] as const)(
    "a %s column chunk fails naming column + codec",
    async (codec) => {
      const r = await assert(injuriesSource, rewrite(FX.injuries, { codec: { full_name: codec } }));
      expect(r.ok).toBe(false);
      expect(r.error).toBe("codec");
      expect(r.bad_codecs).toEqual([{ column: "full_name", codec }]);
      expect(r.warnings.join("\n")).toContain(`column full_name uses codec ${codec}`);
    },
  );

  it("a foreign codec on a column the contract never reads still fails (every chunk is asserted)", async () => {
    const r = await assert(injuriesSource, rewrite(FX.injuries, { codec: { first_name: "ZSTD" } }));
    expect(r.ok).toBe(false);
    expect(r.bad_codecs).toEqual([{ column: "first_name", codec: "ZSTD" }]);
  });

  it("a wrong codec beats a missing column in the report's error code", async () => {
    const r = await assert(
      injuriesSource,
      rewrite(FX.injuries, { codec: { team: "ZSTD" }, drop: ["week"] }),
    );
    expect(r).toMatchObject({ ok: false, error: "codec", missing_columns: ["week"] });
  });

  it("publish refuses a wrong-codec file with the codec error code", async () => {
    const d = dir();
    const f = tempFile(d, "z.parquet", rewrite(FX.stats, { codec: { team: "ZSTD" } }), 2026);
    const w = new SqliteWriter(d);
    await expect(statsPlayerWeekSource.publish([f], w)).rejects.toMatchObject({
      reason: "codec",
      code: "codec",
    });
    w.close();
  });

  it("SNAPPY and UNCOMPRESSED both pass, stored either way", async () => {
    for (const codec of ["SNAPPY", "UNCOMPRESSED"] as const) {
      const r = await assert(injuriesSource, rewrite(FX.injuries, { codec: { full_name: codec } }));
      expect(r.ok).toBe(true);
    }
    const raw = await assert(
      injuriesSource,
      rewrite(FX.injuries, { options: { storage: "UNCOMPRESSED" } }),
    );
    expect(raw.ok).toBe(true);
  });

  it("a file whose pages lie about their codec fails at publish as corrupt, nothing written", async () => {
    // labelled SNAPPY, stored raw: the footer passes, the page does not decode
    const bytes = rewrite(FX.injuries, {
      codec: Object.fromEntries(
        ["season", "game_type", "team", "week", "gsis_id"].map((c) => [c, "SNAPPY" as const]),
      ),
      options: { storage: "UNCOMPRESSED" },
    });
    const d = dir();
    const w = new SqliteWriter(d);
    await expect(
      injuriesSource.publish([tempFile(d, "c.parquet", bytes, 2026)], w),
    ).rejects.toMatchObject({
      reason: "corrupt",
      code: "schema_mismatch",
    });
    expect(w.batches).toEqual([]);
    w.close();
  });
});

describe("types", () => {
  it("a numeric column turned into text fails, naming column, expected and found", async () => {
    const r = await assert(
      injuriesSource,
      rewrite(FX.injuries, { retype: { week: { type: "BYTE_ARRAY", logical: "STRING" } } }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("schema_mismatch");
    expect(r.type_mismatches).toEqual([
      { column: "week", expected: "int", found: "BYTE_ARRAY/STRING" },
    ]);
    expect(r.warnings.join("\n")).toContain("column week expected int, found BYTE_ARRAY/STRING");
  });

  it("an int column widened to INT64 passes; a double where an int is expected fails", async () => {
    expect(
      (await assert(injuriesSource, rewrite(FX.injuries, { retype: { week: { type: "INT64" } } })))
        .ok,
    ).toBe(true);
    const r = await assert(
      injuriesSource,
      rewrite(FX.injuries, { retype: { week: { type: "DOUBLE" } } }),
    );
    expect(r.type_mismatches.map((m) => m.column)).toEqual(["week"]);
  });

  it("an ESPN id column that turns numeric fails (it is decimal TEXT upstream)", async () => {
    const r = await assert(
      rosterWeeklySource,
      rewrite(FX.roster, { retype: { espn_id: { type: "INT64" } } }),
    );
    expect(r.type_mismatches).toEqual([{ column: "espn_id", expected: "string", found: "INT64" }]);
  });

  it("a double column that arrives as integers passes (widening); as text it fails", async () => {
    const ints = await assert(
      schedulesSource,
      rewrite(FX.games, {
        retype: { spread_line: { type: "INT64" } },
        rows: (rows) => rows.map((r) => ({ ...r, spread_line: null })),
      }),
    );
    expect(ints.ok).toBe(true);
    const r = await assert(
      schedulesSource,
      rewrite(FX.games, { retype: { total_line: { type: "BYTE_ARRAY", logical: "STRING" } } }),
    );
    expect(r.ok).toBe(false);
  });

  it("kindMatches: the whole table", () => {
    const el = (type: SchemaElement["type"], logical?: string): SchemaElement =>
      ({
        name: "c",
        type,
        ...(logical ? { logical_type: { type: logical } } : {}),
      }) as SchemaElement;
    const rows: [SchemaElement, Record<string, boolean>][] = [
      [el("BYTE_ARRAY", "STRING"), { string: true, int: false, double: false, date: true }],
      [el("BYTE_ARRAY"), { string: true, int: false, double: false, date: true }],
      [el("BYTE_ARRAY", "JSON"), { string: false, int: false, double: false, date: false }],
      [el("INT32"), { string: false, int: true, double: true, date: false }],
      [el("INT64", "INTEGER"), { string: false, int: true, double: true, date: false }],
      [el("INT32", "DATE"), { string: false, int: false, double: false, date: true }],
      [el("INT64", "TIMESTAMP"), { string: false, int: false, double: false, date: false }],
      [el("DOUBLE"), { string: false, int: false, double: true, date: false }],
      [el("FLOAT"), { string: false, int: false, double: true, date: false }],
      [el("BOOLEAN"), { string: false, int: false, double: false, date: false }],
      [{ name: "c", type: "INT32", converted_type: "INT_16" }, { int: true }],
      [{ name: "c", type: "BYTE_ARRAY", converted_type: "UTF8" }, { string: true }],
    ];
    for (const [e, want] of rows) {
      for (const [kind, ok] of Object.entries(want)) {
        expect(kindMatches(e, kind as "string"), `${JSON.stringify(e)} ${kind}`).toBe(ok);
      }
    }
  });

  it("a nested (group) column counts as extra, or as a mismatch when its name is expected", () => {
    const md = {
      version: 2,
      num_rows: 1n,
      row_groups: [],
      metadata_length: 0,
      schema: [
        { name: "schema", num_children: 3 },
        { name: "season", type: "INT32" },
        { name: "nested", num_children: 2 },
        { name: "a", type: "INT32" },
        { name: "inner", num_children: 1 },
        { name: "b", type: "INT32" },
        { name: "week", num_children: 1 },
        { name: "x", type: "INT32" },
      ],
    } as unknown as FileMetaData;
    const r = checkParquet(md, { season: "int", week: "int", team: "string" });
    expect(r.missing).toEqual(["team"]);
    expect(r.extra).toEqual(["nested"]);
    expect(r.mismatches).toEqual([{ column: "week", expected: "int", found: "GROUP" }]);
    expect(r.nflverseTimestamp).toBeNull();
  });

  it("chunks without metadata are skipped; one entry per column + codec; an oversize stamp is dropped", () => {
    const chunk = (codec: string, path: string) => ({
      file_offset: 0n,
      meta_data: { codec, path_in_schema: [path] },
    });
    const md = {
      version: 2,
      num_rows: 2n,
      metadata_length: 0,
      schema: [{ name: "schema", num_children: 0 }],
      key_value_metadata: [{ key: "nflverse_timestamp", value: "x".repeat(65) }],
      row_groups: [
        { num_rows: 1n, total_byte_size: 0n, columns: [chunk("ZSTD", "a"), { file_offset: 0n }] },
        { num_rows: 1n, total_byte_size: 0n, columns: [chunk("ZSTD", "a"), chunk("GZIP", "a")] },
      ],
    } as unknown as FileMetaData;
    const r = checkParquet(md, {});
    expect(r.badCodecs).toEqual([
      { column: "a", codec: "ZSTD" },
      { column: "a", codec: "GZIP" },
    ]);
    expect(r.nflverseTimestamp).toBeNull();
  });
});

describe("files that are not usable parquet", () => {
  it.each([
    ["an empty file", new Uint8Array(0)],
    ["a truncated file", new TextEncoder().encode("PAR1")],
    ["HTML from a captive portal", new TextEncoder().encode("<html><body>Sign in</body></html>")],
    [
      "magic but no footer",
      new TextEncoder().encode("PAR1\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000PAR1"),
    ],
    [
      "a footer length past the file",
      Uint8Array.from([
        0x50, 0x41, 0x52, 0x31, 1, 2, 3, 4, 0xff, 0xff, 0xff, 0x7f, 0x50, 0x41, 0x52, 0x31,
      ]),
    ],
  ])("%s fails without throwing", async (_label, bytes) => {
    const r = await assert(injuriesSource, bytes);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("schema_mismatch");
    expect(r.warnings.join("\n")).toMatch(/not parquet|unreadable parquet footer/);
  });

  it("a valid file with zero rows fails (never replaces good data with nothing)", async () => {
    const r = await assert(injuriesSource, rewrite(FX.injuries, { rows: () => [] }));
    expect(r.ok).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.warnings.join("\n")).toMatch(/no rows in any file/);
  });

  it("one empty season among populated ones passes with a warning", async () => {
    const d = dir();
    const r = (await injuriesSource.assertSchema([
      tempFile(d, "a.parquet", rewrite(FX.injuries, { rows: () => [] }), 2025),
      tempFile(d, "b.parquet", rewrite(FX.injuries), 2026),
    ])) as NflverseSchemaReport;
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(1052);
    expect(r.warnings).toContain("nflverse:injuries season 2025: file has no rows");
    expect(r.files.map((f) => f.season)).toEqual([2025, 2026]);
  });

  it("no files at all fails as not published", async () => {
    const r = (await injuriesSource.assertSchema([])) as NflverseSchemaReport;
    expect(r).toMatchObject({ ok: false, error: "not_published" });
    expect(r.warnings).toEqual(["nflverse:injuries: no files to check"]);
  });

  it("a file past the release size cap is refused before it is parsed", async () => {
    const big = new Uint8Array(MAX_RELEASE_FILE_BYTES + 1);
    big.set([0x50, 0x41, 0x52, 0x31], 0);
    big.set([0x50, 0x41, 0x52, 0x31], big.length - 4);
    const r = await assert(injuriesSource, big);
    expect(r.ok).toBe(false);
    expect(r.warnings.join("\n")).toMatch(/exceeds the size cap/);
  });

  it("a missing temp file fails without throwing", async () => {
    const r = await injuriesSource.assertSchema([
      { path: "/nonexistent/x.parquet", bytes: 0, season: null },
    ]);
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual(["nflverse:injuries file: unreadable file"]);
  });

  it("a parquet file with none of the expected columns fails naming all of them", async () => {
    for (const s of Object.values(NFLVERSE_SOURCES)) {
      const r = await assert(s, writeParquet([{ name: "x", type: "INT32", values: [1] }]));
      expect(r.ok).toBe(false);
      expect(r.missing_columns).toEqual(
        Object.keys(EXPECTED_COLUMNS[s.id as keyof typeof EXPECTED_COLUMNS]).sort(),
      );
    }
  });
});
