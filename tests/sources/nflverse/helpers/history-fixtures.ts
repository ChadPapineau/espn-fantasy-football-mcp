// history-fixtures.ts — the committed third backtest season (fixtures/history/, nflverse CC-BY 4.0;
// ffopportunity/ CC-BY-SA 4.0 — plan 05 §3; plan 10 §3.3 "≥ 3 historical seasons" [A-3]) and the
// parquet files the tests rebuild from it, in the Phase-1/Phase-2 text format (fixtures.ts: a JSON
// header + TSV parts of JSON cells). `historyFixtureRoutes()` serves every 2023 excerpt at the
// release URL it stands in for; the schedules excerpt is served MERGED with the Phase-1 games excerpt
// (fixtures/nflverse/schedules/), since one games.parquet holds every season. No network.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FX,
  fixtureRows,
  loadFixture,
  writerColumns,
  type FixtureHeader,
  type ManifestFile,
  type Row,
} from "./fixtures.js";
import { writeParquet } from "./parquet-writer.js";
import { decodeTsv } from "./tsv.js";

export const HISTORY_FIXTURES = new URL("../../../../fixtures/history/", import.meta.url).pathname;

/** A history manifest entry: a Phase-1 entry with a season and the columns the excerpt keeps. */
export interface HistoryManifestFile extends Omit<ManifestFile, "season"> {
  readonly season: number;
  readonly columns_kept: number;
}

/** fixtures/history/manifest.json. */
export interface HistoryManifest {
  readonly $comment: string;
  readonly retrieved: string;
  /** The one 2023 game every per-season excerpt is cut around. */
  readonly game: string;
  /** The backtest seasons the fixtures complete (with fixtures/nflverse/phase2's 2024 and 2025). */
  readonly backtest_seasons: readonly number[];
  readonly files: readonly HistoryManifestFile[];
}

export const historyManifest = JSON.parse(
  readFileSync(join(HISTORY_FIXTURES, "manifest.json"), "utf8"),
) as HistoryManifest;

/** The 2023 game of the excerpts (`2023_09_BUF_CIN`). */
export const GAME_2023 = historyManifest.game;

/** The excerpts, by `<dataset>@<season>` (the current-season source id, as phase2-fixtures.ts). */
export const H: Readonly<Record<string, HistoryManifestFile>> = Object.fromEntries(
  historyManifest.files.map((f) => [`${f.dataset}@${String(f.season)}`, f]),
);

/** One loaded excerpt: its header and rows as objects (cells by column name). */
export interface HistoryFixture extends FixtureHeader {
  readonly key: string;
  readonly url: string;
  readonly season: number;
  readonly objects: readonly Row[];
}

const cache = new Map<string, HistoryFixture>();

/** Loads (and caches) the excerpt `<dataset>@<season>`; throws on an unknown key. */
export function hFixture(key: string): HistoryFixture {
  const hit = cache.get(key);
  if (hit) return hit;
  const f = H[key];
  if (!f) throw new Error(`no history fixture ${key}`);
  const header = JSON.parse(readFileSync(join(HISTORY_FIXTURES, f.path), "utf8")) as FixtureHeader;
  const values = header.parts.flatMap((p) =>
    decodeTsv(header.schema, readFileSync(join(HISTORY_FIXTURES, dirname(f.path), p), "utf8")),
  );
  if (values.length !== header.rows) throw new Error(`${key}: row count differs from its parts`);
  const objects = values.map((cells) => {
    const r: Row = {};
    header.schema.forEach((c, j) => {
      r[c.name] = cells[j] ?? null;
    });
    return r;
  });
  const out: HistoryFixture = { ...header, key, url: f.url, season: f.season, objects };
  cache.set(key, out);
  return out;
}

/** The rows of `<dataset>@<season>` (fresh copies the caller may edit). */
export function hRows(key: string): Row[] {
  return hFixture(key).objects.map((r) => ({ ...r }));
}

/** A parquet file from an excerpt's schema and (possibly edited) rows, the release's stamps. */
export function hParquetOf(key: string, rows: readonly Row[]): Uint8Array {
  const f = hFixture(key);
  return writeParquet(writerColumns(f.schema, rows), {
    keyValue: f.key_value,
    createdBy: "espn-fantasy-football-mcp fixture writer",
  });
}

const parquetCache = new Map<string, Uint8Array>();

/** The parquet file rebuilt from an excerpt (cached; callers must not mutate it). */
export function hParquet(key: string): Uint8Array {
  const hit = parquetCache.get(key);
  if (hit) return hit;
  const bytes = hParquetOf(key, hFixture(key).objects);
  parquetCache.set(key, bytes);
  return bytes;
}

let mergedGames: Uint8Array | null = null;

/**
 * games.parquet as the merged fixture: the Phase-1 excerpt's rows (2025, 2026) then the 2023 week-9
 * games, under the Phase-1 header's schema (the generator checked the two schemas are equal) and
 * key-value stamps. Cached; callers must not mutate it.
 */
export function mergedGamesParquet(): Uint8Array {
  if (mergedGames) return mergedGames;
  const p1 = loadFixture(FX.games);
  const rows = [...fixtureRows(FX.games), ...hFixture("nflverse:schedules@2023").objects];
  mergedGames = writeParquet(writerColumns(p1.schema, rows), {
    keyValue: p1.key_value,
    createdBy: "espn-fantasy-football-mcp fixture writer",
  });
  return mergedGames;
}

/** Every release URL the 2023 excerpts stand in for → the bytes a fake HttpGet serves there. */
export function historyFixtureRoutes(): Map<string, Uint8Array> {
  const routes = new Map<string, Uint8Array>();
  for (const f of historyManifest.files) {
    const key = `${f.dataset}@${String(f.season)}`;
    routes.set(f.url, f.dataset === "nflverse:schedules" ? mergedGamesParquet() : hParquet(key));
  }
  return routes;
}
