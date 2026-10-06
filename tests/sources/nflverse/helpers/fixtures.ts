// fixtures.ts — the committed nflverse fixtures (fixtures/nflverse/, CC-BY 4.0; plan 05 §3) and the
// parquet files the tests rebuild from them. The excerpts are text (a JSON header + TSV parts of JSON
// cells, tsv.ts) because the repo's secret scanner refuses binary parquet; each is turned back into a
// parquet file with the SAME column names, order, physical and logical types and nflverse key-value
// metadata as the release file it stands in for, SNAPPY-compressed and dictionary-encoded the way
// Arrow writes nflverse's files.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  writeParquet,
  type Logical,
  type PhysicalType,
  type WriterColumn,
} from "./parquet-writer.js";
import { decodeTsv } from "./tsv.js";

export { encodeTsv, tsvRow } from "./tsv.js";

export const FIXTURES = new URL("../../../../fixtures/nflverse/", import.meta.url).pathname;
export const REL = "https://github.com/nflverse/nflverse-data/releases/download";

/** One column of an excerpt's schema (the upstream file's). */
export interface FixtureColumn {
  readonly name: string;
  readonly type: PhysicalType;
  readonly logical?: Logical;
}

/** An excerpt's JSON header (`*.excerpt.json`); its rows live in the `.tsv` parts beside it. */
export interface FixtureHeader {
  readonly $comment: string;
  readonly schema: readonly FixtureColumn[];
  readonly key_value: Readonly<Record<string, string>>;
  readonly rows: number;
  /** Part file names (same directory), in row order. */
  readonly parts: readonly string[];
}

/** A loaded excerpt: the header plus its rows as cell arrays in schema order. */
export interface FixtureFile extends FixtureHeader {
  readonly values: readonly (readonly unknown[])[];
}

/** One TSV part of an excerpt. */
export interface ManifestPart {
  readonly path: string;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
}

/** One manifest entry. */
export interface ManifestFile {
  /** The excerpt's JSON header. */
  readonly path: string;
  readonly url: string;
  readonly dataset: string;
  readonly season: number | null;
  readonly rows: number;
  readonly parts: readonly ManifestPart[];
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
  games: "schedules/games.excerpt.json",
  injuries: "injuries/injuries_2026.excerpt.json",
  roster: "weekly_rosters/roster_weekly_2026.excerpt.json",
  stats: "stats_player/stats_player_week_2026.excerpt.json",
  players: "players/players.excerpt.json",
});

const fileCache = new Map<string, FixtureFile>();

/** Reads (and caches) one excerpt. */
export function loadFixture(rel: string): FixtureFile {
  const hit = fileCache.get(rel);
  if (hit) return hit;
  const header = JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as FixtureHeader;
  const values = header.parts.flatMap((p) =>
    decodeTsv(header.schema, readFileSync(join(FIXTURES, dirname(rel), p), "utf8")),
  );
  if (values.length !== header.rows) throw new Error(`${rel}: row count differs from its parts`);
  const f: FixtureFile = { ...header, values };
  fileCache.set(rel, f);
  return f;
}

export type Row = Record<string, unknown>;

/** An excerpt's rows as objects (DATE columns as `YYYY-MM-DD` strings, as committed). */
export function fixtureRows(rel: string): Row[] {
  const f = loadFixture(rel);
  const out: Row[] = [];
  for (const cells of f.values) {
    const r: Row = {};
    f.schema.forEach((c, j) => {
      r[c.name] = cells[j] ?? null;
    });
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
