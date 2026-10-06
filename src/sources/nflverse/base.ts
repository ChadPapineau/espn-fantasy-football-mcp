// base.ts — what the nflverse DataSources share (plan 01 §9 DataSource as amended by §5.5: version →
// fetch into temp files → assertSchema (columns AND codec, D9) → publish into a fresh per-source
// dataset file through a DatasetWriter; plan 05 §2 `sources/*`): release versioning from
// timestamp.txt, one TempFile per season, the schema + codec assertion over every file, and the
// publish loop reading row groups into contract rows. Ported from sibling @521f9f3, adapted
// (registry-driven job/limiter/season gate, not-published seasons, SourceErrorCode reports, the
// store's `columnsHash`, a season-less source).
import { constants } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_REGISTRY, type SourceErrorCode } from "../../config/freshness.js";
import { DATASET_TABLES, columnsHash } from "../../store/datasets/tables.js";
import {
  SOURCE_RATE_LIMITS,
  type DataSource,
  type DatasetWriter,
  type PublishStats,
  type ReleaseVersion,
  type SchemaReport,
  type SeasonGate,
  type SourceContext,
  type TempFile,
} from "../source.js";
import { checkParquet, openParquet, readRowGroups, type ColumnTypeMismatch } from "./parquet.js";
import {
  NflverseSourceError,
  downloadAsset,
  isNotFound,
  mayBeUnpublished,
  releaseUrl,
  releaseVersion,
  runSeasons,
  sourceTempDir,
  type NflverseTag,
} from "./release.js";
import type { RawRow, TableLoader } from "./rows.js";
import { EXPECTED_COLUMNS, type NflverseSourceId } from "./schemas.js";

/** SchemaReport plus what the nflverse loader also reports (additive; SchemaReport stays intact). */
export interface NflverseSchemaReport extends SchemaReport {
  /** Columns present with the wrong type (fail, naming the column, expected and found). */
  readonly type_mismatches: readonly ColumnTypeMismatch[];
  /** Per file: season, rows and nflverse's own `nflverse_timestamp` metadata. */
  readonly files: readonly {
    readonly season: number | null;
    readonly rows: number;
    readonly nflverse_timestamp: string | null;
  }[];
  /** The refresh_log error code when `ok` is false (`codec` beats `schema_mismatch`), else null. */
  readonly error: SourceErrorCode | null;
}

/** PublishStats plus the rows dropped or noted and why (counts only, never values). */
export interface NflversePublishStats extends PublishStats {
  readonly warnings: readonly string[];
}

/** A per-source publish: fills the tables from the files; returns its loaders and extra warnings. */
export type PublishFn = (
  files: readonly TempFile[],
  into: DatasetWriter,
) => Promise<{ readonly loaders: readonly TableLoader[]; readonly warnings: readonly string[] }>;

/** One file for every season (`schedules`) or one season-less file (`players`). */
export interface SharedFile {
  readonly all: string;
  readonly seasonless: boolean;
}

/** How one nflverse source differs from the others. */
export interface NflverseSourceDef {
  readonly id: NflverseSourceId;
  readonly tag: NflverseTag;
  /** A per-season file name, or one shared file. */
  readonly file: ((season: number) => string) | SharedFile;
  readonly seasonGate: SeasonGate;
  readonly publish: PublishFn;
}

const label = (f: TempFile): string => (f.season === null ? "file" : `season ${String(f.season)}`);

/** Asserts columns, types and codecs of every file (plan 01 §5.5, D9). Never throws on data. */
export async function assertNflverseSchema(
  id: NflverseSourceId,
  files: readonly TempFile[],
): Promise<NflverseSchemaReport> {
  const expected = EXPECTED_COLUMNS[id];
  const missing = new Set<string>();
  const extra = new Set<string>();
  const mismatches = new Map<string, ColumnTypeMismatch>();
  const codecs = new Map<string, { column: string; codec: string }>();
  const warnings: string[] = [];
  const perFile: { season: number | null; rows: number; nflverse_timestamp: string | null }[] = [];
  let rows = 0;
  let unreadable = false;
  if (files.length === 0) warnings.push(`${id}: no files to check`);
  for (const f of files) {
    let check;
    try {
      check = checkParquet((await openParquet(f.path)).metadata, expected);
    } catch (err) {
      unreadable = true;
      const why = err instanceof NflverseSourceError ? err.message : "unreadable file";
      warnings.push(`${id} ${label(f)}: ${why}`);
      continue;
    }
    check.missing.forEach((c) => missing.add(c));
    check.extra.forEach((c) => extra.add(c));
    for (const mm of check.mismatches) mismatches.set(mm.column, mm);
    for (const bc of check.badCodecs) codecs.set(`${bc.column}\u0000${bc.codec}`, bc);
    if (check.rows === 0) warnings.push(`${id} ${label(f)}: file has no rows`);
    rows += check.rows;
    perFile.push({
      season: f.season,
      rows: check.rows,
      nflverse_timestamp: check.nflverseTimestamp,
    });
  }
  const missingList = [...missing].sort();
  const extraList = [...extra].sort();
  const mismatchList = [...mismatches.values()].sort((a, b) => (a.column < b.column ? -1 : 1));
  const badCodecs = [...codecs.values()];
  if (missingList.length > 0) {
    warnings.push(`${id}: missing or renamed column(s): ${missingList.join(", ")}`);
  }
  for (const mm of mismatchList) {
    warnings.push(`${id}: column ${mm.column} expected ${mm.expected}, found ${mm.found}`);
  }
  for (const bc of badCodecs) {
    warnings.push(
      `${id}: column ${bc.column} uses codec ${bc.codec} (allowed: SNAPPY, UNCOMPRESSED)`,
    );
  }
  if (extraList.length > 0) {
    warnings.push(
      `${id}: ${String(extraList.length)} extra column(s) tolerated: ${extraList.join(", ")}`,
    );
  }
  if (files.length > 0 && !unreadable && rows === 0) warnings.push(`${id}: no rows in any file`);
  const ok =
    files.length > 0 &&
    !unreadable &&
    rows > 0 &&
    missingList.length === 0 &&
    mismatchList.length === 0 &&
    badCodecs.length === 0;
  const error: SourceErrorCode | null = ok
    ? null
    : files.length === 0
      ? "not_published"
      : badCodecs.length > 0
        ? "codec"
        : "schema_mismatch";
  return {
    ok,
    missing_columns: missingList,
    extra_columns: extraList,
    bad_codecs: badCodecs,
    type_mismatches: mismatchList,
    rows,
    warnings,
    files: perFile,
    error,
  };
}

/**
 * Calls `fn` for every row of every file, one row group at a time, reading only the asserted
 * columns. A file that fails the assertion throws before any of its rows is handed out (defence in
 * depth: the runner calls assertSchema first, but publish never trusts that it did).
 */
export async function eachRow(
  id: NflverseSourceId,
  files: readonly TempFile[],
  fn: (raw: RawRow, file: TempFile) => void,
): Promise<void> {
  const expected = EXPECTED_COLUMNS[id];
  const columns = Object.keys(expected);
  for (const f of files) {
    const opened = await openParquet(f.path);
    const check = checkParquet(opened.metadata, expected);
    if (check.badCodecs.length > 0) {
      throw new NflverseSourceError("codec", `${id}: ${label(f)} uses a codec that is not allowed`);
    }
    if (check.missing.length > 0 || check.mismatches.length > 0) {
      throw new NflverseSourceError("schema", `${id}: ${label(f)} fails the schema assertion`);
    }
    for await (const group of readRowGroups(opened, columns)) {
      for (const raw of group) fn(raw, f);
    }
  }
}

/** Collects loader reports into PublishStats (`columns_hash` = the store's ds_schema fingerprint). */
export function publishStats(
  id: NflverseSourceId,
  loaders: readonly TableLoader[],
  extraWarnings: readonly string[],
): NflversePublishStats {
  const reports = loaders.map((l) => l.finish());
  const seasons = new Set<number>();
  for (const r of reports) r.seasons.forEach((s) => seasons.add(s));
  return {
    rows: reports.reduce((n, r) => n + r.rows, 0),
    tables: reports.map((r) => ({ name: r.name, rows: r.rows })),
    seasons: [...seasons].sort((a, b) => a - b),
    columns_hash: columnsHash(id),
    warnings: [...reports.flatMap((r) => r.warnings), ...extraWarnings],
  };
}

/**
 * Whether a row belongs to its file's season (a per-season file holding another season's row is an
 * upstream anomaly: the row is dropped and counted on `loader`).
 */
export function inFileSeason(loader: TableLoader, season: number | null, file: TempFile): boolean {
  if (file.season === null || season === file.season) return true;
  loader.drop("season differs from the file's season");
  return false;
}

async function fetchFiles(
  def: NflverseSourceDef,
  ctx: SourceContext,
  slug: string,
): Promise<readonly TempFile[]> {
  const shared = typeof def.file === "function" ? null : def.file;
  const seasons = shared?.seasonless ? [] : runSeasons(ctx.seasons);
  if (!shared?.seasonless && seasons.length === 0) return [];
  const dir = await sourceTempDir(ctx, slug);
  const out: TempFile[] = [];
  try {
    if (typeof def.file === "function") {
      for (const s of seasons) {
        const url = releaseUrl(def.tag, def.file(s));
        try {
          out.push(await downloadAsset(ctx, url, join(dir, `${String(s)}.parquet`), s));
        } catch (err) {
          // A new season's file does not exist until the season has data: the runner publishes the
          // other seasons; any other 404 (a past season) fails the run.
          if (!isNotFound(err) || !mayBeUnpublished(s, ctx)) throw err;
          ctx.notPublished(s);
        }
      }
    } else if (shared?.seasonless) {
      out.push(
        await downloadAsset(ctx, releaseUrl(def.tag, def.file.all), join(dir, "all.parquet"), null),
      );
    } else {
      // One upstream file holds every season: one download, then one copy per season so each
      // TempFile carries the season its rows are filtered to at publish.
      const all = await downloadAsset(
        ctx,
        releaseUrl(def.tag, def.file.all),
        join(dir, "all.parquet"),
        null,
      );
      for (const s of seasons) {
        const dest = join(dir, `${String(s)}.parquet`);
        await copyFile(all.path, dest, constants.COPYFILE_EXCL);
        out.push({ path: dest, bytes: all.bytes, season: s });
      }
      await rm(all.path, { force: true });
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return out;
}

/** Builds an nflverse DataSource from its definition (fields from config/freshness SOURCE_REGISTRY). */
export function makeNflverseSource(def: NflverseSourceDef): DataSource {
  const info = SOURCE_REGISTRY[def.id];
  const slug = def.id.replace(":", "-");
  const seasonless = typeof def.file !== "function" && def.file.seasonless;
  return Object.freeze({
    id: def.id,
    license: info.license,
    attribution: info.attribution,
    freshness: info.freshness,
    job: info.job,
    limiter: SOURCE_RATE_LIMITS.github_release,
    versioning: "release" as const,
    seasonGate: def.seasonGate,
    tables: DATASET_TABLES[def.id],
    version: (ctx: SourceContext): Promise<ReleaseVersion | null> =>
      releaseVersion(def.tag, ctx, seasonless),
    fetch: (_version: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> =>
      fetchFiles(def, ctx, slug),
    assertSchema: (files: readonly TempFile[]): Promise<NflverseSchemaReport> =>
      assertNflverseSchema(def.id, files),
    async publish(files: readonly TempFile[], into: DatasetWriter): Promise<NflversePublishStats> {
      const { loaders, warnings } = await def.publish(files, into);
      return publishStats(def.id, loaders, warnings);
    },
  });
}
