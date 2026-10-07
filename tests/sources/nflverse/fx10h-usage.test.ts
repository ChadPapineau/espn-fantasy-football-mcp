// fx10h-usage.test.ts — the fx-10h usage supplements (fixtures/fx10h-usage/; plan 10 B2; plan 05 §3
// fixtures are small real excerpts with provenance): every part hashes to its manifest entry, each
// supplement has its shared excerpt's exact schema and stamps, adds only rows the shared excerpt
// lacks (no key twice in the union), only for players on an fx-10h roster, only in the shared
// excerpt's week range, and the seed serves the union at the release URL (a parquet with both row
// sets) while every other suite's routes stay the shared excerpts alone.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { describe, expect, it } from "vitest";
import { seedRoutes } from "../../integration/helpers/seed.js";
import {
  FX10H_USAGE_POSITIONS,
  supplementManifest,
  supplementTables,
  supplementedParquet,
  withFx10hUsage,
  type SupplementFile,
} from "./helpers/fx10h-usage.js";
import type { Row } from "./helpers/fixtures.js";
import { allFixtureRoutes } from "./helpers/phase2-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const m = supplementManifest();

/** The (gsis or pfr) ids of every fx-10h rostered QB/RB/WR/TE/K (all recorded periods). */
function rosteredEspnIds(): Set<number> {
  const dir = path.join(ROOT, "fixtures/espn/fx-10h/league");
  const out = new Set<number>();
  for (const f of readdirSync(dir).filter((x) => /^mRoster\.sp\d+\.json$/.test(x))) {
    const body = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
      teams: {
        roster: {
          entries: { playerPoolEntry: { player: { id: number; defaultPositionId: number } } }[];
        };
      }[];
    };
    for (const t of body.teams)
      for (const e of t.roster.entries)
        if (FX10H_USAGE_POSITIONS.includes(e.playerPoolEntry.player.defaultPositionId))
          out.add(e.playerPoolEntry.player.id);
  }
  return out;
}

const KEYS: Readonly<Record<string, (r: Row) => string>> = {
  "nflverse:roster_weekly": (r) => `${String(r.gsis_id)}|${String(r.week)}`,
  "nflverse:stats_player_week": (r) =>
    `${String(r.player_id)}|${String(r.week)}|${String(r.season_type)}`,
  "nflverse:snap_counts": (r) => `${String(r.game_id)}|${String(r.pfr_player_id)}`,
  "ffopportunity:ep_weekly": (r) => `${String(r.player_id)}|${String(r.week)}`,
};
const MAX_WEEK: Readonly<Record<string, number>> = {
  "nflverse:roster_weekly": 4,
  "nflverse:stats_player_week": 3,
  "nflverse:snap_counts": 3,
  "ffopportunity:ep_weekly": 3,
};
const file = (dataset: string): SupplementFile => {
  const f = m.files.find((x) => x.dataset === dataset);
  if (f === undefined) throw new Error(`no supplement for ${dataset}`);
  return f;
};

describe("the fx-10h usage supplements", () => {
  it("cover the four usage files; every part ≤ 240 KB and hash-checked on read", () => {
    expect(m.files.map((f) => f.dataset).sort()).toEqual(Object.keys(KEYS).sort());
    expect(m.resolved_gsis).toBe(m.rostered_players);
    for (const f of m.files) {
      for (const p of f.parts) expect(p.bytes).toBeLessThanOrEqual(240 * 1024);
      const t = supplementTables(f); // throws on a hash mismatch
      expect(t.rows.length).toBe(f.rows);
      expect(t.rows.length).toBeGreaterThan(0);
    }
  });

  it("each has its shared excerpt's exact schema and key-value stamps", () => {
    for (const f of m.files) {
      const t = supplementTables(f);
      expect(t.header.schema, f.path).toEqual(t.base.header.schema);
      expect(t.header.key_value, f.path).toEqual(t.base.header.key_value);
    }
  });

  it("adds only rows the shared excerpt lacks, inside its week range (each key once)", () => {
    for (const f of m.files) {
      const key = KEYS[f.dataset];
      if (key === undefined) throw new Error(f.dataset);
      const t = supplementTables(f);
      // (the shared excerpt keeps its own edge rows — null ids among them — as they are)
      const base = new Set(t.base.rows.map(key));
      const added = t.rows.map(key);
      expect(new Set(added).size, f.path).toBe(added.length);
      for (const k of added) expect(base.has(k), `${f.path} ${k}`).toBe(false);
      for (const r of t.rows) {
        expect(Number(r.week)).toBeGreaterThanOrEqual(1);
        expect(Number(r.week)).toBeLessThanOrEqual(MAX_WEEK[f.dataset] ?? 0);
      }
    }
  });

  it("only players on an fx-10h roster: by espn_id, then the gsis and pfr ids it maps to", () => {
    const espn = rosteredEspnIds();
    const roster = supplementTables(file("nflverse:roster_weekly")).rows;
    for (const r of roster) expect(espn.has(Number(r.espn_id)), String(r.gsis_id)).toBe(true);
    // the shared roster excerpt's rows of the same players count too (the 24 fixture-roster ones)
    const base = supplementTables(file("nflverse:roster_weekly")).base.rows.filter((r) =>
      espn.has(Number(r.espn_id)),
    );
    const gsis = new Set([...roster, ...base].map((r) => String(r.gsis_id)));
    const pfr = new Set([...roster, ...base].map((r) => String(r.pfr_id)));
    for (const r of supplementTables(file("nflverse:stats_player_week")).rows)
      expect(gsis.has(String(r.player_id))).toBe(true);
    for (const r of supplementTables(file("ffopportunity:ep_weekly")).rows)
      expect(gsis.has(String(r.player_id))).toBe(true);
    for (const r of supplementTables(file("nflverse:snap_counts")).rows)
      expect(pfr.has(String(r.pfr_player_id))).toBe(true);
    // no D/ST and no team-level row
    for (const r of supplementTables(file("nflverse:stats_player_week")).rows)
      expect(r.player_id).not.toBeNull();
  });

  it("the seed serves base ∪ supplement at the release URL; the shared routes stay the excerpts", async () => {
    const shared = allFixtureRoutes();
    const seeded = seedRoutes();
    for (const f of m.files) {
      const bytes = seeded.get(f.url);
      expect(bytes, f.url).toBeInstanceOf(Uint8Array);
      expect(bytes).toEqual(supplementedParquet(f));
      const ab = (b: Uint8Array) =>
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      const t = supplementTables(f);
      const rows = await parquetReadObjects({ file: ab(bytes as Uint8Array) });
      expect(rows.length).toBe(t.base.rows.length + t.rows.length);
      const sharedBytes = shared.get(f.url);
      if (sharedBytes === undefined) throw new Error(`no shared route ${f.url}`);
      expect(Number(parquetMetadata(ab(sharedBytes)).num_rows)).toBe(t.base.rows.length);
    }
    expect(() => withFx10hUsage(new Map())).toThrow(/no shared excerpt is served/);
  });
});
