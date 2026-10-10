// history-fixtures.test.ts — the third backtest season's committed record (plan 10 §3.3 "≥ 3
// historical seasons" [A-3]; plan 05 §3 small real excerpts with ATTRIBUTION; plan 08 §6 step 5 the
// upstream sha256 pinned beside the excerpt; plan 01 §5.5 / D9 schema + codec): every 2023 excerpt's
// parts hash to the manifest, the manifest's upstream hashes to the observed release files, each
// excerpt's schema is the observed file's (columns in order, same physical types), and — offline,
// in CI — the contract's required upstream columns for 2023 exist in every observed 2023 file with
// a type the assertion admits, every codec an allowed one. The merged games route holds the Phase-1
// games plus 2023's week 9 exactly once. No network.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectedColumnsFor } from "../../../src/sources/nflverse/index.js";
import { kindMatches, readRowGroups, openParquet } from "../../../src/sources/nflverse/parquet.js";
import { HISTORY_OF, type HistoryDatasetSourceId } from "../../../src/store/datasets/tables.js";
import { OBSERVED_PHASE2 } from "../../store/datasets/observed-phase2.js";
import { FX, loadFixture } from "./helpers/fixtures.js";
import {
  H,
  HISTORY_FIXTURES,
  hFixture,
  historyManifest,
  mergedGamesParquet,
} from "./helpers/history-fixtures.js";
import { makeCtx } from "./helpers/harness.js";
import { OBSERVED_HISTORY_2023, OBSERVED_HISTORY_PUBLISH } from "./helpers/observed-history.js";
import { tempFile } from "./helpers/rewrite.js";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const TWIN: Readonly<Record<string, HistoryDatasetSourceId>> = {
  "nflverse:stats_player_week@2023": "nflverse:stats_player_week_history",
  "nflverse:stats_team_week@2023": "nflverse:stats_team_week_history",
  "nflverse:pbp@2023": "nflverse:pbp_history",
  "nflverse:snap_counts@2023": "nflverse:snap_counts_history",
  "nflverse:injuries@2023": "nflverse:injuries_history",
  "nflverse:depth_charts@2023": "nflverse:depth_charts_history",
  "ffopportunity:ep_weekly@2023": "ffopportunity:ep_weekly_history",
};

/** A schema element from an observed `TYPE[/LOGICAL]` string (what kindMatches reads). */
function element(name: string, t: string): Parameters<typeof kindMatches>[0] {
  const [type, logical] = t.split("/");
  return {
    name,
    type: type as never,
    ...(logical ? { logical_type: { type: logical } as never } : {}),
  };
}

describe("the committed excerpts (fixtures/history/manifest.json)", () => {
  it("every part hashes, sizes and counts as recorded; no part over 300 KB", () => {
    for (const f of historyManifest.files) {
      let rows = 0;
      for (const p of f.parts) {
        const b = readFileSync(join(HISTORY_FIXTURES, p.path));
        expect(sha(b), p.path).toBe(p.sha256);
        expect(b.length, p.path).toBe(p.bytes);
        expect(b.length, p.path).toBeLessThanOrEqual(300 * 1024);
        rows += p.rows;
      }
      expect(rows, f.path).toBe(f.rows);
      expect(hFixture(`${f.dataset}@${String(f.season)}`).rows, f.path).toBe(f.rows);
      expect(dirname(f.parts[0]?.path ?? ""), f.path).toBe(dirname(f.path));
    }
  });

  it("each excerpt was cut from the observed 2023 file (sha256, bytes, rows, columns)", () => {
    for (const [key, twin] of Object.entries(TWIN)) {
      const f = H[key];
      const o = OBSERVED_HISTORY_2023[key];
      expect(f, key).toBeDefined();
      expect(o, key).toBeDefined();
      if (!f || !o) continue;
      expect(twin in HISTORY_OF, key).toBe(true);
      expect(f.url, key).toBe(o.url);
      expect(f.upstream.sha256, key).toBe(o.sha256);
      expect(f.upstream.bytes, key).toBe(o.bytes);
      expect(f.upstream.rows, key).toBe(o.rows);
      expect(f.upstream.columns, key).toBe(o.columns.length);
      expect(f.upstream.codecs, key).toEqual(o.codecs);
    }
  });

  it("each excerpt keeps observed columns in upstream order with the observed physical types", () => {
    for (const key of Object.keys(TWIN)) {
      const o = OBSERVED_HISTORY_2023[key];
      if (!o) throw new Error(key);
      const types = new Map(o.columns.map((c, i) => [c, o.types[i] ?? ""]));
      const kept = hFixture(key).schema;
      let at = -1;
      for (const c of kept) {
        const i = o.columns.indexOf(c.name);
        expect(i, `${key}.${c.name}`).toBeGreaterThan(at);
        at = i;
        expect(types.get(c.name)?.split("/")[0], `${key}.${c.name}`).toBe(c.type);
      }
    }
  });

  it("licences: nflverse CC-BY 4.0; ffopportunity CC-BY-SA 4.0 with its own attribution file", () => {
    const top = readFileSync(join(HISTORY_FIXTURES, "ATTRIBUTION.md"), "utf8");
    expect(top).toContain("CC-BY 4.0");
    expect(top).toContain("CC BY-SA 4.0");
    const ffo = readFileSync(join(HISTORY_FIXTURES, "ffopportunity/ATTRIBUTION.md"), "utf8");
    expect(ffo).toContain("shared under the same licence (CC BY-SA 4.0)");
    for (const f of historyManifest.files) {
      const c = hFixture(`${f.dataset}@${String(f.season)}`).$comment;
      if (f.dataset.startsWith("ffopportunity:")) {
        expect(f.path.startsWith("ffopportunity/"), f.path).toBe(true);
        expect(c, f.path).toContain("CC-BY-SA 4.0");
      } else {
        expect(f.path.startsWith("nflverse/"), f.path).toBe(true);
        expect(c, f.path).toContain("CC-BY 4.0");
      }
    }
  });

  it("every per-season excerpt is the one game (or its week); 2023 only", () => {
    const game = historyManifest.game;
    expect(game).toBe("2023_09_BUF_CIN");
    for (const key of ["nflverse:pbp@2023", "nflverse:snap_counts@2023"]) {
      const rows = hFixture(key).objects;
      expect(new Set(rows.map((r) => r.game_id)), key).toEqual(new Set([game]));
    }
    for (const r of hFixture("nflverse:stats_player_week@2023").objects) expect(r.week).toBe(9);
    for (const r of hFixture("nflverse:injuries@2023").objects) expect(r.week).toBe(9);
    for (const r of hFixture("nflverse:schedules@2023").objects) {
      expect(r.season).toBe(2023);
      expect(r.week).toBe(9);
    }
    for (const f of historyManifest.files) expect(f.season).toBe(2023);
  });
});

describe("the contract on the observed 2023 files (offline grounding)", () => {
  it("every required upstream column exists in each 2023 file with an admitted type", () => {
    for (const [key, twin] of Object.entries(TWIN)) {
      const o = OBSERVED_HISTORY_2023[key];
      if (!o) throw new Error(key);
      const expected = expectedColumnsFor(twin, 2023);
      expect(expected, key).not.toBeNull();
      for (const [col, kind] of Object.entries(expected ?? {})) {
        const i = o.columns.indexOf(col);
        expect(i, `${key}: ${col} missing`).toBeGreaterThanOrEqual(0);
        expect(kindMatches(element(col, o.types[i] ?? ""), kind), `${key}.${col} as ${kind}`).toBe(
          true,
        );
      }
      expect(
        o.codecs.every((c) => c === "SNAPPY" || c === "UNCOMPRESSED"),
        key,
      ).toBe(true);
      expect(o.row_groups, key).toBe(1);
    }
  });

  it("2023 against 2024: one type change (pbp goal_to_go INT32 → DOUBLE), no column added or lost", () => {
    const diffs: string[] = [];
    for (const key of Object.keys(TWIN)) {
      const a = OBSERVED_HISTORY_2023[key];
      const b = OBSERVED_PHASE2[key.replace("@2023", "@2024")];
      if (!a || !b) throw new Error(key);
      expect(a.columns, key).toEqual(b.columns);
      a.types.forEach((t, i) => {
        if (t !== b.types[i])
          diffs.push(`${key}.${String(a.columns[i])}: ${t} → ${String(b.types[i])}`);
      });
    }
    expect(diffs).toEqual(["nflverse:pbp@2023.goal_to_go: INT32 → DOUBLE"]);
  });

  it("the publish record covers all seven twins with rows for three seasons each", () => {
    expect(Object.keys(OBSERVED_HISTORY_PUBLISH).sort()).toEqual(Object.values(TWIN).sort());
    for (const [id, p] of Object.entries(OBSERVED_HISTORY_PUBLISH)) {
      expect(Object.keys(p.upstream_rows).sort(), id).toEqual(["2023", "2024", "2025"]);
      for (const n of Object.values(p.tables)) expect(n, id).toBeGreaterThan(0);
    }
  });
});

describe("the merged games route", () => {
  it("holds the Phase-1 games and 2023's week 9 once each, under the Phase-1 schema", async () => {
    const c = makeCtx([]);
    try {
      const f = tempFile(c.tempDir, "games.parquet", mergedGamesParquet(), null);
      expect(existsSync(f.path) && statSync(f.path).size > 0).toBe(true);
      const opened = await openParquet(f.path, 16 * 1024 * 1024);
      const ids: string[] = [];
      for await (const g of readRowGroups(opened, ["game_id", "season"]))
        for (const r of g) ids.push(`${String(r.season)}/${String(r.game_id)}`);
      const p1 = loadFixture(FX.games).rows;
      const h = hFixture("nflverse:schedules@2023").rows;
      expect(ids).toHaveLength(p1 + h);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((x) => x.startsWith("2023/"))).toHaveLength(h);
      expect(opened.metadata.schema.slice(1).map((e) => e.name)).toEqual(
        loadFixture(FX.games).schema.map((s) => s.name),
      );
    } finally {
      c.cleanup();
    }
  });
});
