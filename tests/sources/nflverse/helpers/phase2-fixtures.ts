// phase2-fixtures.ts — the committed Phase-2 fixtures (fixtures/nflverse/phase2/, CC-BY 4.0;
// fixtures/ffopportunity/, CC-BY-SA 4.0 — plan 05 §3; plan 10 §3.2) and the parquet files the tests
// rebuild from them, in the Phase-1 format (fixtures.ts: a JSON header + TSV parts of JSON cells).
// `phase2FixtureRoutes()` serves every excerpt at the release URL it stands in for (plus the tags'
// timestamp.txt) through the harness's fake HttpGet; `allFixtureRoutes()` adds the Phase-1 ones, for
// a world that publishes every nflverse/ffopportunity source through the real runner. No network.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  fixtureRoutes,
  writerColumns,
  type FixtureHeader,
  type FixtureManifest,
  type ManifestFile,
  type Row,
} from "./fixtures.js";
import { writeParquet } from "./parquet-writer.js";
import { decodeTsv } from "./tsv.js";

export const NFL_PHASE2 = new URL("../../../../fixtures/nflverse/phase2/", import.meta.url)
  .pathname;
export const FFO_FIXTURES = new URL("../../../../fixtures/ffopportunity/", import.meta.url)
  .pathname;
export const FFO_REL = "https://github.com/ffverse/ffopportunity/releases/download";

/** A Phase-2 manifest entry: a Phase-1 entry plus how many upstream columns the excerpt keeps. */
export interface Phase2ManifestFile extends Omit<ManifestFile, "season"> {
  readonly season: number;
  readonly columns_kept: number;
}

/** A Phase-2 manifest (fixtures/nflverse/phase2/manifest.json, fixtures/ffopportunity/manifest.json). */
export interface Phase2Manifest extends Omit<FixtureManifest, "files"> {
  readonly files: readonly Phase2ManifestFile[];
}

const readManifest = (root: string): Phase2Manifest =>
  JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Phase2Manifest;

/** Both Phase-2 manifests, by fixtures root. */
export const PHASE2_MANIFESTS: readonly { readonly root: string; readonly m: Phase2Manifest }[] = [
  { root: NFL_PHASE2, m: readManifest(NFL_PHASE2) },
  { root: FFO_FIXTURES, m: readManifest(FFO_FIXTURES) },
];

/** The excerpts, by `<dataset>@<season>` (the current-season source id, as observed-phase2.ts). */
export const P2: Readonly<
  Record<string, { readonly root: string; readonly f: Phase2ManifestFile }>
> = Object.fromEntries(
  PHASE2_MANIFESTS.flatMap(({ root, m }) =>
    m.files.map((f) => [`${f.dataset}@${String(f.season)}`, { root, f }]),
  ),
);

/** One loaded excerpt: its header and rows as objects (cells by column name). */
export interface Phase2Fixture extends FixtureHeader {
  readonly key: string;
  readonly url: string;
  readonly season: number;
  readonly objects: readonly Row[];
}

const cache = new Map<string, Phase2Fixture>();

/** Loads (and caches) the excerpt `<dataset>@<season>`; throws on an unknown key. */
export function p2Fixture(key: string): Phase2Fixture {
  const hit = cache.get(key);
  if (hit) return hit;
  const e = P2[key];
  if (!e) throw new Error(`no Phase-2 fixture ${key}`);
  const header = JSON.parse(readFileSync(join(e.root, e.f.path), "utf8")) as FixtureHeader;
  const values = header.parts.flatMap((p) =>
    decodeTsv(header.schema, readFileSync(join(e.root, dirname(e.f.path), p), "utf8")),
  );
  if (values.length !== header.rows) throw new Error(`${key}: row count differs from its parts`);
  const objects = values.map((cells) => {
    const r: Row = {};
    header.schema.forEach((c, j) => {
      r[c.name] = cells[j] ?? null;
    });
    return r;
  });
  const out: Phase2Fixture = { ...header, key, url: e.f.url, season: e.f.season, objects };
  cache.set(key, out);
  return out;
}

/** The rows of `<dataset>@<season>` (fresh copies the caller may edit). */
export function p2Rows(key: string): Row[] {
  return p2Fixture(key).objects.map((r) => ({ ...r }));
}

const parquetCache = new Map<string, Uint8Array>();

/** The parquet file rebuilt from an excerpt (cached; callers must not mutate it). */
export function p2Parquet(key: string): Uint8Array {
  const hit = parquetCache.get(key);
  if (hit) return hit;
  const f = p2Fixture(key);
  const bytes = writeParquet(writerColumns(f.schema, f.objects), {
    keyValue: f.key_value,
    createdBy: "espn-fantasy-football-mcp fixture writer",
  });
  parquetCache.set(key, bytes);
  return bytes;
}

/** Every Phase-2 release URL the fixtures stand in for → the bytes a fake HttpGet serves there. */
export function phase2FixtureRoutes(): Map<string, Uint8Array> {
  const routes = new Map<string, Uint8Array>();
  for (const { root, m } of PHASE2_MANIFESTS) {
    for (const t of Object.values(m.timestamps))
      routes.set(t.url, new Uint8Array(readFileSync(join(root, t.path))));
    for (const f of m.files) routes.set(f.url, p2Parquet(`${f.dataset}@${String(f.season)}`));
  }
  return routes;
}

/** The Phase-1 routes (fixtures.ts) plus the Phase-2 ones. */
export function allFixtureRoutes(): Map<string, Uint8Array> {
  const out = fixtureRoutes();
  for (const [k, v] of phase2FixtureRoutes()) out.set(k, v);
  return out;
}

/** The manifests' default seasons per source id (current [2026], history [2024, 2025]). */
export function p2DefaultSeasons(id: string): readonly number[] {
  for (const { m } of PHASE2_MANIFESTS) {
    const s = m.default_seasons[id];
    if (s) return s;
  }
  throw new Error(`no default seasons for ${id}`);
}
