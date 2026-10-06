// fixtures.test.ts — the committed nflverse fixtures (plan 05 §3: small real excerpts ≤ 300 KB under
// CC-BY 4.0 with ATTRIBUTION.md; plan 10 §3.1a: ≥ 3 final weeks for the fixture league's players;
// plan 08 §6 step 5: the upstream sha256 pinned beside the excerpt): every part hashes to its manifest
// entry, keeps the real file's schema (observed-columns.ts) and covers the fixture roster's weeks
// 1–3; the parquet rebuilt from it round-trips through hyparquet value for value; and the test-only
// writer's snappy and dictionary encodings decode.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { parquetMetadata, parquetReadObjects, snappyUncompress } from "hyparquet";
import { describe, expect, it } from "vitest";
import { parseNflverseTimestamp } from "../../../src/sources/nflverse/release.js";
import { OBSERVED_PARQUET } from "../../store/datasets/observed-columns.js";
import {
  FIXTURES,
  FX,
  REL,
  fixtureParquet,
  fixtureRows,
  loadFixture,
  manifest,
} from "./helpers/fixtures.js";
import { snappyCompress, snappyLiteral, writeParquet } from "./helpers/parquet-writer.js";
import { decodeTsv, encodeTsv } from "./helpers/tsv.js";

const roster = JSON.parse(
  readFileSync(new URL("../../../fixtures/players/fixture-roster.json", import.meta.url), "utf8"),
) as {
  players: { gsis_id: string; id_source: string; stat_weeks: number[]; espn_name: string }[];
  decoys: { gsis_id: string }[];
  stat_weeks: number[];
};
const toAb = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe("the manifest and the committed files", () => {
  it("every part hashes to its manifest entry and stays ≤ 300 KB; the rows add up", () => {
    expect(manifest.files.map((f) => f.path).sort()).toEqual(Object.values(FX).sort());
    for (const f of manifest.files) {
      expect(f.parts.length).toBeGreaterThan(0);
      for (const p of f.parts) {
        const bytes = readFileSync(join(FIXTURES, p.path));
        expect(createHash("sha256").update(bytes).digest("hex"), p.path).toBe(p.sha256);
        expect(bytes.length, p.path).toBe(p.bytes);
        expect(bytes.length, p.path).toBeLessThanOrEqual(300 * 1024);
      }
      expect(f.parts.reduce((a, p) => a + p.rows, 0)).toBe(f.rows);
      expect(loadFixture(f.path).parts).toEqual(f.parts.map((p) => p.path.split("/").pop()));
      expect(f.url.startsWith(`${REL}/`)).toBe(true);
      expect(f.upstream.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.upstream.codecs).toEqual(["SNAPPY"]);
      expect(f.upstream.created_by).toMatch(/^parquet-cpp-arrow/);
      expect(parseNflverseTimestamp(f.upstream.nflverse_timestamp)).not.toBeNull();
    }
  });

  it("each excerpt keeps the real release file's schema, in order (observed on 2026-10-06)", () => {
    for (const f of manifest.files) {
      const fx = loadFixture(f.path);
      const observed = OBSERVED_PARQUET[f.dataset];
      expect(observed, f.dataset).toBeDefined();
      expect(
        fx.schema.map((c) => c.name),
        f.path,
      ).toEqual(observed?.columns);
      expect(fx.schema).toHaveLength(f.upstream.columns);
      expect(f.upstream.bytes).toBe(observed?.bytes);
      expect(f.upstream.rows).toBe(observed?.rows);
      expect(fx.rows).toBe(f.rows);
      expect(fx.values).toHaveLength(fx.rows);
      for (const row of fx.values) expect(row).toHaveLength(fx.schema.length);
      expect(fx.key_value.nflverse_timestamp).toBe(f.upstream.nflverse_timestamp);
      expect(fx.$comment).toMatch(/CC-BY 4\.0/);
    }
  });

  it("the timestamp files are the verbatim 24-byte release stamps", () => {
    for (const t of Object.values(manifest.timestamps)) {
      const text = readFileSync(join(FIXTURES, t.path), "utf8");
      expect(statSync(join(FIXTURES, t.path)).size).toBe(24);
      expect(text.trim()).toBe(t.text);
      expect(t.url).toBe(`${REL}/${t.path}`);
    }
  });

  it("ATTRIBUTION.md names nflverse, CC-BY 4.0 and every fixture", () => {
    const md = readFileSync(join(FIXTURES, "ATTRIBUTION.md"), "utf8");
    expect(md).toContain("CC-BY 4.0");
    expect(md).toContain("https://github.com/nflverse/nflverse-data");
    expect(md).toContain("https://creativecommons.org/licenses/by/4.0/");
    for (const f of manifest.files) expect(md).toContain(f.path.split("/").pop() ?? "");
  });
});

describe("coverage of the shared fixture roster (weeks 1–3)", () => {
  it("every roster_weekly player has rows in weeks 1–4; every stat week is in the stats excerpt", () => {
    const rw = fixtureRows(FX.roster);
    const st = fixtureRows(FX.stats);
    expect(roster.stat_weeks).toEqual([1, 2, 3]);
    for (const p of roster.players.filter((x) => x.id_source === "nflverse:roster_weekly")) {
      const weeks = rw.filter((r) => r.gsis_id === p.gsis_id).map((r) => r.week);
      expect(weeks.sort(), p.espn_name).toEqual([1, 2, 3, 4]);
      const statWeeks = st.filter((r) => r.player_id === p.gsis_id).map((r) => r.week);
      expect(statWeeks.sort(), p.espn_name).toEqual(p.stat_weeks);
    }
    for (const d of roster.decoys) expect(rw.some((r) => r.gsis_id === d.gsis_id)).toBe(true);
    const fallback = roster.players.filter((x) => x.id_source === "nflverse:players");
    expect(fallback.length).toBeGreaterThan(0);
    const pl = fixtureRows(FX.players);
    for (const p of fallback)
      expect(
        pl.some((r) => r.gsis_id === p.gsis_id),
        p.espn_name,
      ).toBe(true);
  });

  it("the stats excerpt holds whole games: both teams' rows for every unit game", () => {
    const st = fixtureRows(FX.stats).filter((r) => r.player_id !== null && Number(r.week) <= 3);
    const games = new Map<string, Set<string>>();
    for (const r of st) {
      const g = games.get(String(r.game_id)) ?? new Set<string>();
      g.add(String(r.team));
      games.set(String(r.game_id), g);
    }
    for (const team of ["PHI", "DET", "LA", "WAS", "LAC"]) {
      for (const week of [1, 2, 3]) {
        const gid = st.find((r) => r.team === team && r.week === week)?.game_id;
        expect(gid, `${team} w${String(week)}`).toBeDefined();
        expect(games.get(String(gid))?.size, String(gid)).toBe(2);
      }
    }
  });
});

describe("the rebuilt parquet files", () => {
  it.each(Object.values(FX))("%s round-trips through hyparquet value for value", async (rel) => {
    const bytes = fixtureParquet(rel);
    const md = parquetMetadata(toAb(bytes));
    const fx = loadFixture(rel);
    expect(Number(md.num_rows)).toBe(fx.rows);
    expect(md.key_value_metadata?.find((k) => k.key === "nflverse_timestamp")?.value).toBe(
      fx.key_value.nflverse_timestamp,
    );
    for (const rg of md.row_groups)
      for (const c of rg.columns) expect(c.meta_data?.codec).toBe("SNAPPY");
    const back = (await parquetReadObjects({ file: toAb(bytes) })) as Record<string, unknown>[];
    const want = fixtureRows(rel);
    expect(back).toHaveLength(want.length);
    for (let i = 0; i < want.length; i++) {
      const got = back[i] ?? {};
      for (const c of fx.schema) {
        const v = got[c.name];
        const norm = v instanceof Date ? v.toISOString().slice(0, 10) : v;
        expect(norm, `${rel} row ${String(i)} ${c.name}`).toEqual(want[i]?.[c.name] ?? null);
      }
    }
  });

  it("strings are dictionary-encoded and the physical/logical types are the real file's", () => {
    const md = parquetMetadata(toAb(fixtureParquet(FX.roster)));
    const birth = md.schema.find((e) => e.name === "birth_date");
    expect(birth?.type).toBe("INT32");
    expect(birth?.logical_type?.type).toBe("DATE");
    const espn = md.row_groups[0]?.columns.find(
      (c) => c.meta_data?.path_in_schema[0] === "espn_id",
    );
    expect(espn?.meta_data?.encodings).toContain("RLE_DICTIONARY");
    expect(espn?.meta_data?.dictionary_page_offset).toBeDefined();
  });
});

describe("the test-only writer", () => {
  it("snappyCompress is a valid snappy stream for any input (property, decoded by hyparquet)", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 3000 }),
          fc.array(fc.constantFrom(0, 1, 2), { maxLength: 70_000 }).map((a) => Uint8Array.from(a)),
        ),
        (raw) => {
          for (const enc of [snappyCompress(raw), snappyLiteral(raw)]) {
            const out = new Uint8Array(raw.length);
            snappyUncompress(enc, out);
            if (Buffer.compare(Buffer.from(out), Buffer.from(raw)) !== 0) return false;
          }
          return true;
        },
      ),
      { numRuns: 60 },
    );
  });

  it("writes several row groups, booleans, floats and INT64, readable as written", async () => {
    const n = 10;
    const bytes = writeParquet(
      [
        {
          name: "b",
          type: "BOOLEAN",
          values: Array.from({ length: n }, (_, i) => (i % 3 === 0 ? null : i % 2 === 0)),
        },
        { name: "f", type: "FLOAT", values: Array.from({ length: n }, (_, i) => i / 2) },
        { name: "l", type: "INT64", values: Array.from({ length: n }, (_, i) => BigInt(i) * 10n) },
        {
          name: "s",
          type: "BYTE_ARRAY",
          logical: "STRING",
          required: true,
          values: Array.from({ length: n }, () => "x"),
        },
        {
          name: "d",
          type: "INT32",
          logical: "DATE",
          values: Array.from({ length: n }, () => new Date("2000-01-02T00:00:00Z")),
        },
      ],
      { rowGroupRows: 3 },
    );
    const md = parquetMetadata(toAb(bytes));
    expect(md.row_groups).toHaveLength(4);
    const back = (await parquetReadObjects({ file: toAb(bytes) })) as Record<string, unknown>[];
    expect(back.map((r) => r.b)).toEqual([
      null,
      false,
      true,
      null,
      true,
      false,
      null,
      false,
      true,
      null,
    ]);
    expect(back.map((r) => r.l)).toEqual(Array.from({ length: n }, (_, i) => BigInt(i) * 10n));
    expect(back.every((r) => r.s === "x")).toBe(true);
    expect(back.map((r) => (r.d as Date).toISOString().slice(0, 10))).toEqual(
      Array(n).fill("2000-01-02"),
    );
    expect(() =>
      writeParquet([{ name: "s", type: "INT32", required: true, values: [null] }]),
    ).toThrow(/nulls/);
    expect(() =>
      writeParquet([
        { name: "a", type: "INT32", values: [1] },
        { name: "b", type: "INT32", values: [] },
      ]),
    ).toThrow(/ragged/);
    expect(() => writeParquet([{ name: "a", type: "INT32", values: [1.5] }])).toThrow(/INT32/);
    expect(() =>
      writeParquet([{ name: "a", type: "INT32", logical: "DATE", values: ["01/02/2000"] }]),
    ).toThrow(/DATE/);
    expect(
      Number(
        parquetMetadata(toAb(writeParquet([{ name: "a", type: "INT32", values: [] }]))).num_rows,
      ),
    ).toBe(0);
  });
});

describe("the TSV excerpt encoding", () => {
  it("round-trips nulls, empty strings, tabs, newlines, unicode and numbers exactly", () => {
    const schema = [{ name: "a" }, { name: "b" }];
    const rows = [
      [null, ""],
      ["tab\there", "line\nbreak"],
      ["🏈 Ja'Marr \u202e", 1.5],
      [-0.25, 12345678901],
    ];
    expect(decodeTsv(schema, encodeTsv(schema, rows))).toEqual(rows);
    expect(encodeTsv(schema, [])).toBe("a\tb\n");
  });

  it("refuses a header that does not match the schema and a ragged row", () => {
    const schema = [{ name: "a" }, { name: "b" }];
    expect(() => decodeTsv(schema, "b\ta\n1\t2\n")).toThrow(/header/);
    expect(() => decodeTsv(schema, "a\tb\n1\n")).toThrow(/ragged/);
    expect(() => decodeTsv(schema, "a\tb\nnot json\t1\n")).toThrow();
  });
});
