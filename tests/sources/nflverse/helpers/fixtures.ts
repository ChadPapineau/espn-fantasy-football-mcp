// fixtures.ts — the committed nflverse fixtures (fixtures/nflverse/, CC-BY 4.0; plan 05 §3) and the
// parquet files the tests rebuild from them. The excerpts are gzipped columnar JSON because the repo's
// secret scanner refuses binary parquet; each is turned back into a parquet file with the SAME column
// names, order, physical and logical types and nflverse key-value metadata as the release file it
// stands in for, SNAPPY-compressed and dictionary-encoded the way Arrow writes nflverse's files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  writeParquet,
  type Logical,
  type PhysicalType,
  type WriterColumn,
} from "./parquet-writer.js";

export const FIXTURES = new URL("../../../../fixtures/nflverse/", import.meta.url).pathname;
export const REL = "https://github.com/nflverse/nflverse-data/releases/download";

/** One column of an excerpt's schema (the upstream file's). */
export interface FixtureColumn {
  readonly name: string;
  readonly type: PhysicalType;
  readonly logical?: Logical;
}

/** One excerpt file (columnar: `columns[name][i]` is row i). */
export interface FixtureFile {
  readonly $comment: string;
  readonly schema: readonly FixtureColumn[];
  readonly key_value: Readonly<Record<string, string>>;
  readonly rows: number;
  readonly columns: Readonly<Record<string, readonly unknown[]>>;
}

/** One manifest entry. */
export interface ManifestFile {
  readonly path: string;
  readonly url: string;
  readonly dataset: string;
  readonly season: number | null;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly excerpt: string;
  readonly upstream: {
    readonly bytes: number;
    readonly rows: number;
    readonly sha256: string;
    readonly columns: number;
    readonly created_by: string | null;
    readonly codecs: readonly string[];
    readonly encodings: readonly string[];
    readonly nflverse_timestamp: string | null;
  };
}

/** fixtures/nflverse/manifest.json. */
export interface FixtureManifest {
  readonly $comment: string;
  readonly retrieved: string;
  readonly timestamps: Readonly<
    Record<string, { readonly path: string; readonly url: string; readonly text: string }>
  >;
  readonly default_seasons: Readonly<Record<string, readonly number[]>>;
  readonly files: readonly ManifestFile[];
}

export const manifest = JSON.parse(
  readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
) as FixtureManifest;

/** The excerpt paths, by short name. */
export const FX = Object.freeze({
  games: "schedules/games.excerpt.json.gz",
  injuries: "injuries/injuries_2026.excerpt.json.gz",
  roster: "weekly_rosters/roster_weekly_2026.excerpt.json.gz",
  stats: "stats_player/stats_player_week_2026.excerpt.json.gz",
  players: "players/players.excerpt.json.gz",
});

const fileCache = new Map<string, FixtureFile>();

/** Reads (and caches) one excerpt. */
export function loadFixture(rel: string): FixtureFile {
  const hit = fileCache.get(rel);
  if (hit) return hit;
  const raw = readFileSync(join(FIXTURES, rel));
  const text = rel.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const f = JSON.parse(text) as FixtureFile;
  fileCache.set(rel, f);
  return f;
}

export type Row = Record<string, unknown>;

/** An excerpt's rows as objects (DATE columns as `YYYY-MM-DD` strings, as committed). */
export function fixtureRows(rel: string): Row[] {
  const f = loadFixture(rel);
  const out: Row[] = [];
  for (let i = 0; i < f.rows; i++) {
    const r: Row = {};
    for (const c of f.schema) r[c.name] = f.columns[c.name]?.[i] ?? null;
    out.push(r);
  }
  return out;
}

/** Writer columns for a schema and rows. */
export function writerColumns(
  schema: readonly FixtureColumn[],
  rows: readonly Row[],
): WriterColumn[] {
  return schema.map((c) => ({
    name: c.name,
    type: c.type,
    ...(c.logical ? { logical: c.logical } : {}),
    values: rows.map((r) => r[c.name] ?? null),
  }));
}

const parquetCache = new Map<string, Uint8Array>();

/** The parquet file rebuilt from an excerpt (cached; callers must not mutate it). */
export function fixtureParquet(rel: string): Uint8Array {
  const hit = parquetCache.get(rel);
  if (hit) return hit;
  const f = loadFixture(rel);
  const bytes = writeParquet(writerColumns(f.schema, fixtureRows(rel)), {
    keyValue: f.key_value,
    createdBy: "espn-fantasy-football-mcp fixture writer",
  });
  parquetCache.set(rel, bytes);
  return bytes;
}

/** Every release URL the fixtures stand in for → the bytes a fake HttpGet serves there. */
export function fixtureRoutes(): Map<string, Uint8Array> {
  const routes = new Map<string, Uint8Array>();
  for (const t of Object.values(manifest.timestamps)) {
    routes.set(t.url, readFileSync(join(FIXTURES, t.path)));
  }
  for (const f of manifest.files) routes.set(f.url, fixtureParquet(f.path));
  return routes;
}
