// fx10h-usage.ts — the fx-10h usage supplements (fixtures/fx10h-usage/, written by
// make-fx10h-usage.ts; plan 10 B2: usage for ≥ 95 % of the fixture league's rostered players). Each
// supplement holds the rows of the fx-10h rostered QB/RB/WR/TE/K that its shared excerpt lacks, in
// the shared excerpt's schema; `withFx10hUsage` serves base ∪ supplement at the release URL (the
// seed's routes — tests/integration/helpers/seed.ts), every part hash-checked on read. Nothing else
// reads these files, so every other suite keeps the shared excerpts unchanged. No network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writerColumns, type FixtureHeader, type Row } from "./fixtures.js";
import { writeParquet } from "./parquet-writer.js";
import { decodeTsv } from "./tsv.js";

const ROOT = new URL("../../../../", import.meta.url).pathname;
export const FX10H_USAGE_DIR = join(ROOT, "fixtures/fx10h-usage");
/** ESPN default position ids with a player row in nflverse/ffopportunity: QB, RB, WR, TE, K. */
export const FX10H_USAGE_POSITIONS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);

/** Where a supplement lives and what it extends. */
export interface SupplementSpec {
  /** The header, relative to FX10H_USAGE_DIR. */
  readonly path: string;
  /** The release asset it adds rows to. */
  readonly url: string;
  /** The shared excerpt it extends (repo-relative header path). */
  readonly base: string;
  readonly dataset: string;
}

/** One manifest entry. */
export interface SupplementFile extends SupplementSpec {
  readonly season: number;
  readonly rows: number;
  readonly parts: readonly {
    readonly path: string;
    readonly rows: number;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly excerpt: string;
  readonly upstream: {
    readonly bytes: number;
    readonly rows: number;
    readonly sha256: string;
    readonly nflverse_timestamp: string | null;
  };
}

/** fixtures/fx10h-usage/manifest.json. */
export interface SupplementManifest {
  readonly $comment: string;
  readonly retrieved: string;
  readonly rostered_players: number;
  readonly resolved_gsis: number;
  readonly files: readonly SupplementFile[];
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function supplementManifest(): SupplementManifest {
  return JSON.parse(
    readFileSync(join(FX10H_USAGE_DIR, "manifest.json"), "utf8"),
  ) as SupplementManifest;
}

/** A header and its rows as objects, every part checked against its manifest hash. */
function readTable(
  root: string,
  rel: string,
  parts?: SupplementFile["parts"],
): { header: FixtureHeader; rows: Row[] } {
  const header = JSON.parse(readFileSync(join(root, rel), "utf8")) as FixtureHeader;
  const values = header.parts.flatMap((p) => {
    const buf = readFileSync(join(root, dirname(rel), p));
    const want = parts?.find((x) => x.path === join(dirname(rel), p))?.sha256;
    if (parts !== undefined && want !== sha(buf))
      throw new Error(`${join(dirname(rel), p)}: does not hash to its manifest entry`);
    return decodeTsv(header.schema, buf.toString("utf8"));
  });
  if (values.length !== header.rows) throw new Error(`${rel}: row count differs from its parts`);
  const rows = values.map((cells) => {
    const r: Row = {};
    header.schema.forEach((c, j) => {
      r[c.name] = cells[j] ?? null;
    });
    return r;
  });
  return { header, rows };
}

/** One supplement: its header, its rows, and the shared excerpt's. */
export function supplementTables(f: SupplementFile): {
  readonly header: FixtureHeader;
  readonly rows: readonly Row[];
  readonly base: { readonly header: FixtureHeader; readonly rows: readonly Row[] };
} {
  const { header, rows } = readTable(FX10H_USAGE_DIR, f.path, f.parts);
  return { header, rows, base: readTable(ROOT, f.base) };
}

/** The parquet file of base ∪ supplement (the shared excerpt's schema and key-value stamps). */
export function supplementedParquet(f: SupplementFile): Uint8Array {
  const t = supplementTables(f);
  const names = (h: FixtureHeader) => JSON.stringify(h.schema);
  if (names(t.header) !== names(t.base.header))
    throw new Error(`${f.path}: schema differs from ${f.base}`);
  return writeParquet(writerColumns(t.base.header.schema, [...t.base.rows, ...t.rows]), {
    keyValue: t.base.header.key_value,
    createdBy: "espn-fantasy-football-mcp fixture writer",
  });
}

/** `routes` with every supplemented release URL serving base ∪ supplement (a new map). */
export function withFx10hUsage(routes: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  const out = new Map(routes);
  for (const f of supplementManifest().files) {
    if (!out.has(f.url)) throw new Error(`${f.path}: no shared excerpt is served at ${f.url}`);
    out.set(f.url, supplementedParquet(f));
  }
  return out;
}
