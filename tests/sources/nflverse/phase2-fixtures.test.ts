// phase2-fixtures.test.ts — the committed Phase-2 fixtures (fixtures/nflverse/phase2/ CC-BY 4.0,
// fixtures/ffopportunity/ CC-BY-SA 4.0; plan 05 §3: small real excerpts ≤ 300 KB a part with
// ATTRIBUTION; plan 08 §6 step 5: the upstream sha256 pinned beside the excerpt): every part hashes
// to its manifest entry; each excerpt keeps the real release file's schema (observed-phase2.ts — in
// order, with physical/logical types; pbp a projection of it) and every column the dataset contract
// reads for that season; the upstream file is the one the contract was grounded on; the parquet
// rebuilt from it round-trips through hyparquet value for value; the licences are stated.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { describe, expect, it } from "vitest";
import { parseFfopportunityTimestamp } from "../../../src/sources/ffopportunity/index.js";
import { expectedColumnsFor, parseNflverseTimestamp } from "../../../src/sources/nflverse/index.js";
import {
  historyTwinOf,
  phase2RequiredUpstreamColumns,
  type ContractSourceId,
} from "../../../src/store/datasets/tables.js";
import { OBSERVED_PHASE2 } from "../../store/datasets/observed-phase2.js";
import {
  FFO_FIXTURES,
  NFL_PHASE2,
  P2,
  PHASE2_MANIFESTS,
  p2Fixture,
  p2Parquet,
  p2Rows,
  phase2FixtureRoutes,
} from "./helpers/phase2-fixtures.js";

const toAb = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const KEYS = Object.keys(P2).sort();
const typeOf = (c: { type: string; logical?: string }): string =>
  c.logical ? `${c.type}/${c.logical}` : c.type;

describe("the manifests and the committed files", () => {
  it("covers every observed Phase-2 file and season, nothing else", () => {
    expect(KEYS).toEqual(Object.keys(OBSERVED_PHASE2).sort());
    expect(KEYS).toHaveLength(19);
  });

  it("every part hashes to its manifest entry and stays ≤ 240 KB; the rows add up", () => {
    for (const { root, m } of PHASE2_MANIFESTS) {
      for (const f of m.files) {
        expect(f.parts.length).toBeGreaterThan(0);
        for (const p of f.parts) {
          const bytes = readFileSync(join(root, p.path));
          expect(createHash("sha256").update(bytes).digest("hex"), p.path).toBe(p.sha256);
          expect(bytes.length, p.path).toBe(p.bytes);
          expect(bytes.length, p.path).toBeLessThanOrEqual(240 * 1024);
        }
        expect(f.parts.reduce((a, p) => a + p.rows, 0)).toBe(f.rows);
        expect(p2Fixture(`${f.dataset}@${String(f.season)}`).rows).toBe(f.rows);
      }
    }
  });

  it("the upstream file of each excerpt is the one the contract was grounded on", () => {
    for (const key of KEYS) {
      const { f } = P2[key] ?? { f: null };
      const o = OBSERVED_PHASE2[key];
      expect(o, key).toBeDefined();
      expect(f?.url, key).toBe(o?.url);
      expect(f?.upstream.sha256, key).toBe(o?.sha256);
      expect(f?.upstream.bytes, key).toBe(o?.bytes);
      expect(f?.upstream.rows, key).toBe(o?.rows);
      expect(f?.upstream.columns, key).toBe(o?.columns.length);
      expect(f?.upstream.codecs, key).toEqual(["SNAPPY"]);
      expect(f?.upstream.created_by, key).toMatch(/^parquet-cpp-arrow/);
    }
  });

  it("each excerpt keeps the release file's schema in order (names and types); pbp projects it", () => {
    for (const key of KEYS) {
      const fx = p2Fixture(key);
      const o = OBSERVED_PHASE2[key];
      if (!o) throw new Error(key);
      const observed = o.columns.map((name, i) => ({ name, type: o.types[i] }));
      const kept = observed.filter((c) => fx.schema.some((s) => s.name === c.name));
      // the excerpt is the release file's columns in their order, each with its type
      expect(
        fx.schema.map((c) => ({ name: c.name, type: typeOf(c) })),
        key,
      ).toEqual(kept);
      const dropped = observed.length - kept.length;
      if (key.startsWith("nflverse:pbp@")) expect(dropped, key).toBe(372 - 55);
      else if (key === "nflverse:injuries@2024") {
        expect(observed.filter((c) => !kept.includes(c)).map((c) => c.name)).toEqual([
          "date_modified",
        ]);
      } else expect(dropped, key).toBe(0);
    }
  });

  it("each excerpt carries every upstream column its contract file reads for its season", () => {
    for (const key of KEYS) {
      const fx = p2Fixture(key);
      const [dataset, s] = key.split("@") as [ContractSourceId, string];
      const season = Number(s);
      // a prior season is read by the dataset's history twin
      const source = season < 2026 ? historyTwinOf(dataset) : dataset;
      if (source === null) throw new Error(key);
      const names = new Set(fx.schema.map((c) => c.name));
      const expected = expectedColumnsFor(source, season);
      expect(expected, key).not.toBeNull();
      for (const col of Object.keys(expected ?? {}))
        expect(names.has(col), `${key} ${col}`).toBe(true);
      for (const col of phase2RequiredUpstreamColumns(source, season))
        expect(names.has(col), `${key} ${col}`).toBe(true);
    }
  });

  it("the excerpts hold real rows of the documented selection", () => {
    const pbp = p2Rows("nflverse:pbp@2026");
    expect(new Set(pbp.map((r) => r.game_id))).toEqual(
      new Set(["2026_01_NO_DET", "2026_02_LV_LAC", "2026_03_LA_DEN"]),
    );
    const types = new Set(pbp.map((r) => r.play_type));
    for (const t of [null, "no_play", "pass", "run", "punt", "kickoff", "field_goal", "qb_kneel"])
      expect(types.has(t), String(t)).toBe(true);
    expect(pbp.some((r) => r.return_touchdown === 1)).toBe(true);
    expect(pbp.some((r) => r.safety === 1)).toBe(true);
    expect(pbp.some((r) => r.two_point_attempt === 1)).toBe(true);
    expect(pbp.every((r) => typeof r.desc === "string" || r.desc === null)).toBe(true);
    const legacy = p2Rows("nflverse:depth_charts@2024");
    expect(legacy.filter((r) => r.week === null)).toHaveLength(3);
    const ep = p2Rows("ffopportunity:ep_weekly@2026");
    expect(ep.filter((r) => r.player_id === null)).toHaveLength(2);
    expect(ep.every((r) => typeof r.season === "string")).toBe(true);
  });

  it("the timestamp files are the verbatim release stamps and parse", () => {
    for (const { root, m } of PHASE2_MANIFESTS) {
      for (const [tag, t] of Object.entries(m.timestamps)) {
        const text = readFileSync(join(root, t.path), "utf8");
        expect(text.trim(), tag).toBe(t.text);
        const parsed =
          root === FFO_FIXTURES ? parseFfopportunityTimestamp(text) : parseNflverseTimestamp(text);
        expect(parsed, tag).not.toBeNull();
      }
    }
  });

  it("the licences are stated where the data lives (CC-BY 4.0; CC-BY-SA 4.0, same licence)", () => {
    const nfl = readFileSync(join(NFL_PHASE2, "ATTRIBUTION.md"), "utf8");
    expect(nfl).toMatch(/CC-BY 4\.0/);
    const ffo = readFileSync(join(FFO_FIXTURES, "ATTRIBUTION.md"), "utf8");
    expect(ffo).toMatch(/CC BY-SA 4\.0/);
    expect(ffo).toMatch(/shared under the same licence/i);
    for (const key of KEYS) {
      const c = p2Fixture(key).$comment;
      expect(c, key).toMatch(key.startsWith("ffopportunity") ? /CC-BY-SA 4\.0/ : /CC-BY 4\.0/);
    }
  });
});

describe("the rebuilt parquet files", () => {
  it("round-trip through hyparquet value for value, SNAPPY, with nflverse's stamps", async () => {
    for (const key of KEYS) {
      const fx = p2Fixture(key);
      const bytes = p2Parquet(key);
      const md = parquetMetadata(toAb(bytes));
      expect(Number(md.num_rows), key).toBe(fx.rows);
      const codecs = new Set(
        md.row_groups.flatMap((g) => g.columns.map((c) => c.meta_data?.codec)),
      );
      expect([...codecs], key).toEqual(["SNAPPY"]);
      const kv = Object.fromEntries((md.key_value_metadata ?? []).map((k) => [k.key, k.value]));
      for (const [k, v] of Object.entries(fx.key_value)) expect(kv[k], `${key} ${k}`).toBe(v);
      const back = await parquetReadObjects({ file: toAb(bytes) });
      expect(back, key).toEqual(fx.objects);
    }
  });

  it("serves every excerpt and stamp at its release URL", () => {
    const routes = phase2FixtureRoutes();
    for (const key of KEYS) expect(routes.has(P2[key]?.f.url ?? ""), key).toBe(true);
    expect([...routes.keys()].filter((u) => u.endsWith("/timestamp.txt"))).toHaveLength(5);
  });
});
