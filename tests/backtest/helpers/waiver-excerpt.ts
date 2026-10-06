// waiver-excerpt.ts — the nflverse excerpt behind plan 10 A9a's soft part ("the hindsight replay of
// research 05 §1.6 over the nflverse 2024–2025 excerpt"; research 05 §8.4 #4; plan 05 §3.2): of each
// `stats_player/stats_player_week_<season>.parquet`, the QB/RB/WR/TE rows of the regular season,
// weeks 1–17, and only the columns the reference scoring reads (every column of a whole season would
// be megabytes). Text like every nflverse excerpt (fixtures/nflverse/ATTRIBUTION.md: a JSON header +
// TSV parts of JSON cells, each part ≤ 240 KB); its own manifest (`fixtures/nflverse/backtest/`)
// pins every part's sha256 and the upstream file's. `buildWaiverExcerpt` is pure (bytes in, text
// out); `make-waiver-excerpt.ts` writes the files; `loadBacktestSeason` reads them back, verifying
// every hash, or returns null while the excerpt is not committed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type {
  FixtureColumn,
  FixtureHeader,
  ManifestPart,
} from "../../sources/nflverse/helpers/fixtures.js";
import type { PhysicalType } from "../../sources/nflverse/helpers/parquet-writer.js";
import { decodeTsv, encodeTsv, tsvRow } from "../../sources/nflverse/helpers/tsv.js";

export const ROOT = new URL("../../../", import.meta.url).pathname;
/** Where the backtest excerpts and their manifest live. */
export const BACKTEST_DIR = join(ROOT, "fixtures/nflverse/backtest");
export const REL = "https://github.com/nflverse/nflverse-data/releases/download";
const MAX_PART_BYTES = 240 * 1024;

/** The fantasy positions the replay ranks (research 05 §1.6: QB/RB/WR/TE; K and D/ST stream apart). */
export const BACKTEST_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"] as const);
export type BacktestPosition = (typeof BACKTEST_POSITIONS)[number];
/** The last fantasy week the surplus counts (research 05 §1.6: Σ_{w ≥ t}^{17}). */
export const BACKTEST_FINAL_WEEK = 17;

/**
 * The columns kept: the keys, every column `statLineFromPlayerWeek` reads for a stat the reference
 * league scores (plan 07 §5.2's fx-10h `mSettings`: yardage, TDs, interceptions, receptions,
 * two-point conversions, fumbles lost, return and fumble-recovery TDs), and nflverse's own
 * `fantasy_points` / `fantasy_points_ppr` as a cross-check of the translation.
 */
export const BACKTEST_COLUMNS = Object.freeze([
  "player_id",
  "position",
  "position_group",
  "season",
  "week",
  "season_type",
  "team",
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
  "fantasy_points",
  "fantasy_points_ppr",
] as const);

/** The excerpt's row rule, in words (the manifest's `excerpt` field). */
export const BACKTEST_RULE = `regular-season rows (season_type REG) of weeks 1-${String(BACKTEST_FINAL_WEEK)} whose position_group is QB, RB, WR or TE; the ${String(BACKTEST_COLUMNS.length)} columns the reference scoring reads plus nflverse's fantasy_points and fantasy_points_ppr`;

/** One backtest excerpt in the manifest. */
export interface BacktestFile {
  /** The excerpt's JSON header, relative to fixtures/nflverse/backtest/. */
  readonly path: string;
  readonly url: string;
  readonly season: number;
  readonly rows: number;
  readonly parts: readonly ManifestPart[];
  readonly excerpt: string;
  readonly columns: readonly string[];
  readonly upstream: {
    readonly bytes: number;
    readonly rows: number;
    readonly sha256: string;
    readonly columns: number;
    readonly created_by: string | null;
    readonly nflverse_timestamp: string | null;
  };
}

/** fixtures/nflverse/backtest/manifest.json. */
export interface BacktestManifest {
  readonly $comment: string;
  readonly retrieved: string;
  readonly files: readonly BacktestFile[];
}

/** What `buildWaiverExcerpt` produces for one season (the caller writes it). */
export interface BuiltExcerpt {
  readonly header: FixtureHeader;
  /** Part file names (same directory as the header) and their text. */
  readonly parts: readonly { readonly name: string; readonly text: string }[];
  readonly entry: BacktestFile;
}

type Row = Record<string, unknown>;
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const PHYSICAL: readonly string[] = ["BOOLEAN", "INT32", "INT64", "FLOAT", "DOUBLE", "BYTE_ARRAY"];

function cell(v: unknown, column: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${column}: non-finite number cannot be JSON`);
    return v;
  }
  if (typeof v === "string" || typeof v === "boolean") return v;
  throw new Error(`${column}: unsupported value type ${typeof v}`);
}

/** Whether an upstream row belongs to the excerpt (BACKTEST_RULE). */
export function keepRow(r: Row): boolean {
  const week = r.week;
  return (
    r.season_type === "REG" &&
    typeof week === "number" &&
    week >= 1 &&
    week <= BACKTEST_FINAL_WEEK &&
    (BACKTEST_POSITIONS as readonly unknown[]).includes(r.position_group) &&
    typeof r.player_id === "string"
  );
}

/** The backtest excerpt of one `stats_player_week_<season>.parquet` (pure). */
export async function buildWaiverExcerpt(bytes: Uint8Array, season: number): Promise<BuiltExcerpt> {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const md = parquetMetadata(ab);
  const byName = new Map(md.schema.slice(1).map((el) => [el.name, el]));
  const schema = BACKTEST_COLUMNS.map((name): FixtureColumn => {
    const el = byName.get(name);
    if (el === undefined) throw new Error(`stats_player_week_${String(season)}: no column ${name}`);
    const type = el.type;
    if (type === undefined || !PHYSICAL.includes(type))
      throw new Error(
        `stats_player_week_${String(season)}: column ${name} has an unsupported type`,
      );
    const logical = el.logical_type?.type;
    return {
      name,
      type: type as PhysicalType,
      ...(logical === "STRING" || logical === "DATE" ? { logical } : {}),
    };
  });
  const all = (await parquetReadObjects({ file: ab, columns: [...BACKTEST_COLUMNS] })) as Row[];
  const rows = all.filter((r) => keepRow(r) && r.season === season);
  rows.sort(
    (a, b) =>
      Number(a.week) - Number(b.week) || String(a.player_id).localeCompare(String(b.player_id)),
  );
  const values = rows.map((r) => schema.map((c) => cell(r[c.name], c.name)));
  const stem = `stats_player_week_${String(season)}.excerpt`;
  const parts: { name: string; text: string }[] = [];
  const headerBytes = Buffer.byteLength(encodeTsv(schema, []));
  let start = 0;
  do {
    let end = start;
    let size = headerBytes;
    while (end < values.length) {
      const line = Buffer.byteLength(tsvRow(values[end] ?? [])) + 1;
      if (end > start && size + line > MAX_PART_BYTES) break;
      size += line;
      end++;
    }
    parts.push({
      name: `${stem}.${String(parts.length + 1)}.tsv`,
      text: encodeTsv(schema, values.slice(start, end)),
    });
    start = end;
  } while (start < values.length);
  const kv = (key: string): string | null =>
    md.key_value_metadata?.find((k) => k.key === key)?.value ?? null;
  const key_value: Record<string, string> = {};
  for (const k of ["nflverse_type", "nflverse_timestamp"]) {
    const v = kv(k);
    if (v !== null) key_value[k] = v;
  }
  const file = `stats_player_week_${String(season)}.parquet`;
  const header: FixtureHeader = {
    $comment: `nflverse data, CC-BY 4.0 (see ../ATTRIBUTION.md): an excerpt of ${REL}/stats_player/${file} — ${BACKTEST_RULE}. Rows are in the .tsv parts: a header line of column names, then one row per line, one JSON literal per cell. Generated by tests/backtest/helpers/make-waiver-excerpt.ts.`,
    schema,
    key_value,
    rows: rows.length,
    parts: parts.map((p) => p.name),
  };
  const entry: BacktestFile = {
    path: `${stem}.json`,
    url: `${REL}/stats_player/${file}`,
    season,
    rows: rows.length,
    parts: parts.map((p) => ({
      path: p.name,
      rows: partRows(p.text),
      bytes: Buffer.byteLength(p.text),
      sha256: sha(p.text),
    })),
    excerpt: BACKTEST_RULE,
    columns: [...BACKTEST_COLUMNS],
    upstream: {
      bytes: bytes.byteLength,
      rows: Number(md.num_rows),
      sha256: sha(bytes),
      columns: md.schema.length - 1,
      created_by: md.created_by ?? null,
      nflverse_timestamp: kv("nflverse_timestamp"),
    },
  };
  return { header, parts, entry };
}

/** Rows in one TSV part (lines after the header). */
function partRows(text: string): number {
  return text.split("\n").filter((l) => l !== "").length - 1;
}

/** The committed manifest, or null while no backtest excerpt is committed. */
export function backtestManifest(dir: string = BACKTEST_DIR): BacktestManifest | null {
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as BacktestManifest;
}

/**
 * One season's excerpt rows as objects, every part re-hashed against the manifest (a revised or
 * edited file fails here, never as a changed result); null when the season is not committed.
 */
export function loadBacktestSeason(season: number, dir: string = BACKTEST_DIR): Row[] | null {
  const m = backtestManifest(dir);
  const entry = m?.files.find((f) => f.season === season);
  if (entry === undefined) return null;
  const header = JSON.parse(readFileSync(join(dir, entry.path), "utf8")) as FixtureHeader;
  if (header.schema.map((c) => c.name).join(",") !== entry.columns.join(","))
    throw new Error(`${entry.path}: the header's columns differ from the manifest's`);
  const out: Row[] = [];
  for (const part of entry.parts) {
    const text = readFileSync(join(dir, part.path), "utf8");
    if (sha(text) !== part.sha256)
      throw new Error(`${part.path}: does not hash to its manifest entry`);
    const values = decodeTsv(header.schema, text);
    if (values.length !== part.rows) throw new Error(`${part.path}: row count differs`);
    for (const cells of values) {
      const r: Row = {};
      header.schema.forEach((c, j) => {
        r[c.name] = cells[j] ?? null;
      });
      out.push(r);
    }
  }
  if (out.length !== entry.rows) throw new Error(`${entry.path}: row count differs from its parts`);
  return out;
}
