// data.test.ts — the committed C1 backtest excerpt (plan 10 C1, D9: three nflverse seasons, 2023
// tuning and 2024–2025 held out): every part re-hashes to the manifest, the tables have their
// columns and counts, the 2024–2025 scoring columns equal the B7 excerpt's cut from the same release
// files cell for cell, every player-week's team-week exists, the injury rows carry no free text,
// ffopportunity stays in its own (CC BY-SA) files, and the ESPN crosswalk covers league-b's recorded
// box-score players. Read-only; nothing is fetched.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBacktestSeason } from "../../../backtest/helpers/waiver-excerpt.js";
import { REPLACEMENT_DATA_DIR } from "../../../backtest/helpers/replacement-data.js";
import {
  buildWorld,
  espnWeekRows,
  excerptManifest,
  loadTable,
  referenceLeagueSettings,
} from "./helpers/data.js";
import {
  DATA_DIR,
  EXCERPT_SEASONS,
  MAX_PART_BYTES,
  PLAYER_WEEK_COLUMNS,
  TABLE_COLUMNS,
} from "./helpers/excerpt-format.js";

describe("the C1 excerpt", () => {
  it("lists every file in the data directory and nothing else", () => {
    const m = excerptManifest();
    const listed = new Set(m.files.flatMap((f) => [f.path, ...f.parts.map((p) => p.path)]));
    const onDisk = readdirSync(DATA_DIR).filter(
      (f) => f.endsWith(".tsv") || f.endsWith(".excerpt.json"),
    );
    expect(new Set(onDisk)).toEqual(listed);
    for (const f of m.files) {
      expect(f.columns).toEqual(TABLE_COLUMNS[f.table]);
      for (const p of f.parts) expect(p.bytes).toBeLessThanOrEqual(MAX_PART_BYTES);
      const header = JSON.parse(readFileSync(join(DATA_DIR, f.path), "utf8")) as {
        rows: number;
        parts: string[];
      };
      expect(header.rows).toBe(f.rows);
      expect(header.parts).toEqual(f.parts.map((p) => p.path));
      for (const u of f.upstream) expect(u.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("holds three seasons of every table and the crosswalk; loads re-hash", () => {
    for (const s of EXCERPT_SEASONS)
      for (const t of ["player_week", "team_week", "injury_week", "ep_week"] as const)
        expect(loadTable(t, s).length).toBeGreaterThan(500);
    expect(loadTable("team_week", 2024)).toHaveLength(544);
    expect(loadTable("espn_xwalk", null).length).toBeGreaterThan(200);
    expect(() => loadTable("player_week", 2019)).toThrow(/no excerpt/);
  });

  it("ffopportunity values live only in the ep_week files (CC BY-SA), nflverse in the rest", () => {
    for (const f of excerptManifest().files) {
      expect(f.licence).toBe(f.table === "ep_week" ? "CC-BY-SA-4.0" : "CC-BY-4.0");
      for (const u of f.upstream)
        expect(u.url.includes("ffopportunity")).toBe(f.table === "ep_week");
    }
  });

  it("2024–2025 scoring columns equal the B7 excerpt's, cell for cell (same release files)", () => {
    const shared = PLAYER_WEEK_COLUMNS.filter((c) =>
      [
        "passing_yards",
        "passing_tds",
        "passing_interceptions",
        "passing_2pt_conversions",
        "sack_fumbles_lost",
        "rushing_yards",
        "rushing_tds",
        "rushing_fumbles_lost",
        "rushing_2pt_conversions",
        "receptions",
        "receiving_yards",
        "receiving_tds",
        "receiving_fumbles_lost",
        "receiving_2pt_conversions",
        "special_teams_tds",
        "fumble_recovery_own",
        "fumble_recovery_tds",
      ].includes(c),
    );
    for (const season of [2024, 2025]) {
      const b7 = loadBacktestSeason(season, REPLACEMENT_DATA_DIR);
      if (b7 === null) throw new Error("the B7 excerpt is missing");
      const mine = new Map(
        loadTable("player_week", season).map((r) => [
          `${String(r.player_id)}|${String(r.week)}`,
          r,
        ]),
      );
      let compared = 0;
      for (const r of b7) {
        const m = mine.get(`${String(r.player_id)}|${String(r.week)}`);
        expect(m).toBeDefined();
        for (const c of shared) expect(m?.[c]).toBe(r[c]);
        compared += 1;
      }
      expect(compared).toBe(b7.length);
      expect(compared).toBeGreaterThan(5000);
    }
  });

  it("every player-week's team-week exists; the market line is the team's side", () => {
    for (const s of EXCERPT_SEASONS) {
      const tw = new Set(
        loadTable("team_week", s).map((r) => `${String(r.team)}|${String(r.week)}`),
      );
      for (const r of loadTable("player_week", s))
        expect(tw.has(`${String(r.team)}|${String(r.week)}`)).toBe(true);
      // spreads come in opposite pairs per game
      const rows = loadTable("team_week", s);
      const by = new Map(rows.map((r) => [`${String(r.team)}|${String(r.week)}`, r]));
      for (const r of rows) {
        const opp = by.get(`${String(r.opponent)}|${String(r.week)}`);
        if (typeof r.spread === "number" && typeof opp?.spread === "number")
          expect(r.spread).toBe(-opp.spread);
      }
    }
  });

  it("injury rows carry statuses only (no injury text, no names)", () => {
    const statuses = new Set<unknown>();
    for (const s of EXCERPT_SEASONS)
      for (const r of loadTable("injury_week", s)) {
        statuses.add(r.report_status);
        expect(Object.keys(r).sort()).toEqual([...TABLE_COLUMNS.injury_week].sort());
      }
    // the official enum (nflverse also carries a rare "Note" — two 2024 rows — read as Questionable)
    for (const v of statuses)
      expect(["Doubtful", "Out", "Questionable", "Note", null]).toContain(v);
    expect(statuses.has("Questionable")).toBe(true);
  });

  it("the crosswalk covers league-b's recorded box-score players; the world joins it", () => {
    const rows = espnWeekRows([2024]);
    expect(rows.length).toBeGreaterThan(1500);
    expect(rows.filter((r) => r.gsis_id !== null).length / rows.length).toBeGreaterThan(0.99);
    for (const r of rows.slice(0, 50)) {
      expect(Number.isFinite(r.projection)).toBe(true);
      expect(r.week).toBeGreaterThanOrEqual(1);
    }
    const world = buildWorld("reference", referenceLeagueSettings());
    expect(world.players.length).toBeGreaterThan(800);
    expect(world.team_games).toHaveLength(544 * 3);
    const g = world.players[0]?.games[0];
    expect(Number.isFinite(g?.points)).toBe(true);
  });
});
