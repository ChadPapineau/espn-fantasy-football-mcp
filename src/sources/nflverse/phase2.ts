// phase2.ts — what the Phase-2 parquet DataSources share (plan 10 §3.2 sources and acceptance B1;
// plan 01 §5.2 rows, §5.5 refresh model and D9: version → fetch into temp files → schema + codec
// assertion → publish into a fresh per-source dataset file; plan 06 §1.3 jobs). Built on the
// Phase-1 machinery in base.ts / release.ts / parquet.ts / rows.ts, with three differences:
//   * the expected upstream columns come from the Phase-2 contract PER FILE SEASON
//     (src/store/datasets/tables.ts `phase2UpstreamKinds`): the depth-chart layout changed in 2025,
//     and a file whose season no layout of its source covers fails the assertion naming the season;
//   * the tables and the `columns_hash` are the contract's (`contractTablesFor`,
//     `contractColumnsHash`), so a Phase-2 or history file is held to its own contract;
//   * each source comes with its HISTORY twin (`<source>_history`, tables.ts HISTORY_DATASET_SOURCES:
//     the two prior seasons for the soft backtests, plan 10 §3.2 [A-3]) — same URLs, same loader,
//     its own file, a monthly version bucket (see `historyVersion`).
// Rows are built from the contract's own `derivation` text (`rowBuilder`): a column whose derivation
// this module does not know and no source overrides throws at module load, so a contract change
// cannot silently store the wrong value. Every upstream value is data; nothing here interprets text.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_REGISTRY, type DatasetSourceId } from "../../config/freshness.js";
import { defaultSeason } from "../../config/schema.js";
import type { IsoInstant } from "../../domain/league/types.js";
import { flag01, fraction01, wholeNumber } from "../../store/datasets/derive.js";
import {
  HISTORY_OF,
  contractColumnsHash,
  contractTablesFor,
  historySeasonsFor,
  isHistoryDatasetSource,
  isPhase1DatasetSource,
  phase2UpstreamKinds,
  seasonInRange,
  type ContractSourceId,
  type HistoryDatasetSourceId,
  type Phase2TableContract,
} from "../../store/datasets/tables.js";
import {
  SOURCE_RATE_LIMITS,
  type DataSource,
  type DatasetTableSpec,
  type DatasetWriter,
  type ReleaseVersion,
  type SeasonGate,
  type SourceContext,
  type TempFile,
} from "../source.js";
import {
  assertSchemaOf,
  eachRowOf,
  publishStatsWith,
  type ExpectedColumns,
  type NflversePublishStats,
  type NflverseSchemaReport,
} from "./base.js";
import {
  MAX_RELEASE_FILE_BYTES,
  NflverseSourceError,
  downloadAsset,
  isNotFound,
  mayBeUnpublished,
  releaseAssetUrl,
  releaseVersionAt,
  runSeasons,
  sourceTempDir,
} from "./release.js";
import { TableLoader, asInt, asReal, asText, type RawRow } from "./rows.js";
import { EXPECTED_COLUMNS, isNflverseSourceId } from "./schemas.js";

/** The current-season Phase-2 parquet sources (tables.ts PHASE_2_PARQUET_SOURCES minus history). */
export const PHASE_2_PARQUET_CURRENT = [
  "nflverse:stats_team_week",
  "nflverse:pbp",
  "nflverse:snap_counts",
  "nflverse:depth_charts",
  "ffopportunity:ep_weekly",
] as const satisfies readonly DatasetSourceId[];
/** One of them. */
export type Phase2ParquetId = (typeof PHASE_2_PARQUET_CURRENT)[number];

/** The history twin of each (tables.ts HISTORY_OF, inverted; a test holds the two equal). */
export const PHASE_2_HISTORY_TWIN = Object.freeze({
  "nflverse:stats_team_week": "nflverse:stats_team_week_history",
  "nflverse:pbp": "nflverse:pbp_history",
  "nflverse:snap_counts": "nflverse:snap_counts_history",
  "nflverse:depth_charts": "nflverse:depth_charts_history",
  "ffopportunity:ep_weekly": "ffopportunity:ep_weekly_history",
} as const satisfies Record<Phase2ParquetId, HistoryDatasetSourceId>);

/**
 * A history dataset source: a DataSource whose id is a `<source>_history` id. Those ids are not yet
 * `DatasetSourceId`s (src/config/freshness.ts owns that list — needs_from_others), so the type
 * differs from DataSource in `id` only; once the ids are registered it is assignable to DataSource
 * unchanged. `current` names the current-season source it repeats (licence, attribution, job).
 */
export interface HistoryDataSource extends Omit<DataSource, "id"> {
  readonly id: HistoryDatasetSourceId;
  readonly current: DatasetSourceId;
}

/** What a Phase-2 publish function writes into: the file's source id, its tables, its size cap. */
export interface PublishTarget {
  readonly id: ContractSourceId;
  readonly tables: readonly DatasetTableSpec[];
  /** The source's per-file cap (the files were downloaded under it; they are read under it). */
  readonly maxBytes: number;
}

/** A Phase-2 per-source publish: fills `target.tables` from the files; returns loaders + warnings. */
export type Phase2PublishFn = (
  files: readonly TempFile[],
  into: DatasetWriter,
  target: PublishTarget,
) => Promise<{ readonly loaders: readonly TableLoader[]; readonly warnings: readonly string[] }>;

/** Where a source's release lives and how its `timestamp.txt` reads. */
export interface ReleaseRef {
  /** `https://github.com/<owner>/<repo>/releases/download`. */
  readonly base: string;
  readonly tag: string;
  /** Names the release in errors (our text, never upstream's), e.g. `nflverse pbp`. */
  readonly label: string;
  /** The stamp parser (default: nflverse's `YYYY-MM-DD HH:MM:SS EDT`). */
  readonly parse?: (text: string) => IsoInstant | null;
}

/** How one Phase-2 parquet source differs from the others. */
export interface Phase2SourceDef {
  readonly id: Phase2ParquetId;
  readonly release: ReleaseRef;
  /** The per-season release file name. */
  readonly file: (season: number) => string;
  readonly seasonGate: SeasonGate;
  /** Download + read cap per file (default MAX_RELEASE_FILE_BYTES). */
  readonly maxBytes?: number;
  readonly publish: Phase2PublishFn;
}

/** A current-season source and its history twin, built from one definition. */
export interface Phase2SourcePair {
  readonly current: DataSource;
  readonly history: HistoryDataSource;
}

// --- expected columns ---------------------------------------------------------------------------------

/**
 * The upstream columns (→ kind) a contract source's file for `season` must carry, or null when no
 * table of the source covers that season (or the season is unknown): the Phase-2 contract's kinds
 * (`phase2UpstreamKinds`); a history twin of a Phase-1 dataset reads the Phase-1 source's columns
 * (schemas.ts EXPECTED_COLUMNS — the prior seasons' files have the same layout).
 */
export function expectedColumnsFor(
  source: ContractSourceId,
  season: number | null,
): ExpectedColumns | null {
  if (season === null || !Number.isInteger(season)) return null;
  if (isHistoryDatasetSource(source)) {
    const cur = HISTORY_OF[source];
    if (isPhase1DatasetSource(cur)) return isNflverseSourceId(cur) ? EXPECTED_COLUMNS[cur] : null;
  }
  const tables = contractTablesFor(source) as readonly Phase2TableContract[];
  if (!tables.some((t) => seasonInRange(t.seasons, season))) return null;
  const kinds = phase2UpstreamKinds(source, season);
  return Object.keys(kinds).length === 0 ? null : kinds;
}

// --- rows from the contract's derivations ---------------------------------------------------------------

/** A stored value. */
export type Phase2Value = string | number | null;
/** One column's value from a raw upstream row. */
export type ColumnFn = (raw: RawRow) => Phase2Value;

const VERBATIM: Readonly<Record<string, (v: unknown) => Phase2Value>> = Object.freeze({
  TEXT: asText,
  INTEGER: asInt,
  REAL: asReal,
});

/** The derivation functions a column may name that this builder applies generically. */
const GENERIC_DERIVATIONS: Readonly<Record<string, (v: unknown) => Phase2Value>> = Object.freeze({
  wholeNumber,
  flag01,
  fraction01,
});

/**
 * Builds a contract row function for one table: each column, in spec order, is its override when
 * given, else verbatim (`derivation` null or "verbatim …": TEXT through emptyToNull, INTEGER a safe
 * integer, REAL a finite number — NaN/±Infinity → NULL), else the generic derivation its text names
 * (`wholeNumber(x)`, `flag01(x)`, `fraction01(x)` of the column's first `from`). A column with any
 * other derivation and no override, or an override naming no column, throws HERE (module load).
 */
export function rowBuilder(
  spec: DatasetTableSpec,
  overrides: Readonly<Record<string, ColumnFn>> = {},
): (raw: RawRow) => Record<string, Phase2Value> {
  const names = new Set(spec.columns.map((c) => c.name));
  for (const k of Object.keys(overrides)) {
    if (!names.has(k)) throw new Error(`phase2: ${spec.name} has no column ${k} to override`);
  }
  const plan: [string, ColumnFn][] = spec.columns.map((c) => {
    const own = Object.hasOwn(overrides, c.name) ? overrides[c.name] : undefined;
    if (own) return [c.name, own];
    const contract = c as {
      readonly derivation?: string | null;
      readonly from?: readonly string[];
    };
    const d = contract.derivation ?? null;
    const from = contract.from?.[0] ?? c.name;
    if (d === null || d.startsWith("verbatim ")) {
      const fn = VERBATIM[c.type];
      if (!fn) throw new Error(`phase2: ${spec.name}.${c.name} has a type no loader stores`);
      return [c.name, (r: RawRow) => fn(r[from])];
    }
    const name = /^([A-Za-z][A-Za-z0-9]*)\(/.exec(d)?.[1];
    const g = name !== undefined && Object.hasOwn(GENERIC_DERIVATIONS, name) ? name : undefined;
    const fn = g === undefined ? undefined : GENERIC_DERIVATIONS[g];
    if (!fn) throw new Error(`phase2: no loader for ${spec.name}.${c.name} (${d})`);
    return [c.name, (r: RawRow) => fn(r[from])];
  });
  return (raw: RawRow) => {
    const row: Record<string, Phase2Value> = {};
    for (const [name, fn] of plan) row[name] = fn(raw);
    return row;
  };
}

/** The contract spec named `name` among `target.tables` (throws: a source/contract mismatch). */
export function tableOf(target: PublishTarget, name: string): DatasetTableSpec {
  const t = target.tables.find((s) => s.name === name);
  if (!t) throw new Error(`phase2: ${target.id} has no table ${name}`);
  return t;
}

// --- versions, seasons, files ----------------------------------------------------------------------------

/** History files are re-fetched at most once per UTC calendar month (see `historyVersion`). */
export function historyBucket(nowMs: number): string {
  const d = new Date(nowMs);
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The prior seasons a history refresh covers now: [current − 2, current − 1] (tables.ts). */
export function historyRefreshSeasons(nowMs: number): readonly number[] {
  return historySeasonsFor(defaultSeason(nowMs));
}

/**
 * A history run's seasons: the run's seasons, validated and de-duplicated, every one BEFORE the
 * current season (config `defaultSeason`) — a history file never holds the current season (that is
 * the current-season source's file). A current or later season is a caller bug: it throws.
 */
export function historyRunSeasons(id: string, ctx: SourceContext): readonly number[] {
  const seasons = runSeasons(ctx.seasons);
  const current = defaultSeason(ctx.clock.nowMs());
  for (const s of seasons) {
    if (s >= current) {
      throw new NflverseSourceError(
        "bad_season",
        `${id}: a history file holds prior seasons only (season ${String(s)} is not before ${String(current)})`,
      );
    }
  }
  return seasons;
}

/**
 * A history source's version: `h<YYYY-MM>_<s1>-<s2>…` — the UTC month and the seasons, with NO
 * network request. Prior seasons are final (an nflverse rebuild of a past season is rare: the 2024
 * depth-chart file is dated 2025-02-13), while the release tag's `timestamp.txt` moves with every
 * current-season rebuild (several times a game day), so polling it would re-download ~41 MB of
 * prior-season pbp each time. A month bounds the staleness of a rebuilt prior season; a new season
 * set (a new current season) or `--force` republishes at once; an unchanged run makes no request.
 */
export function historyVersion(id: string, ctx: SourceContext): ReleaseVersion {
  const seasons = historyRunSeasons(id, ctx);
  return {
    version: `h${historyBucket(ctx.clock.nowMs())}_${seasons.join("-")}`,
    released_at: null,
  };
}

/**
 * Downloads one file per season into a private directory of the run's temp dir. A 404 for a season
 * that may not be published yet (`mayBeUnpublished`: the current season before its grace period)
 * is reported through `ctx.notPublished`; any other failure removes the directory and throws.
 */
export async function fetchSeasonFiles(
  ctx: SourceContext,
  slug: string,
  seasons: readonly number[],
  urlOf: (season: number) => string,
  maxBytes: number,
): Promise<readonly TempFile[]> {
  if (seasons.length === 0) return [];
  const dir = await sourceTempDir(ctx, slug);
  const out: TempFile[] = [];
  try {
    for (const s of seasons) {
      try {
        out.push(
          await downloadAsset(ctx, urlOf(s), join(dir, `${String(s)}.parquet`), s, maxBytes),
        );
      } catch (err) {
        if (!isNotFound(err) || !mayBeUnpublished(s, ctx)) throw err;
        ctx.notPublished(s);
      }
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return out;
}

// --- building the sources --------------------------------------------------------------------------------

/** `fn()` as a promise: a throw rejects it (a DataSource method never throws synchronously). */
function settle<T>(fn: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(fn());
  });
}

async function publishInto(
  def: Phase2SourceDef,
  id: ContractSourceId,
  files: readonly TempFile[],
  into: DatasetWriter,
): Promise<NflversePublishStats> {
  const target: PublishTarget = {
    id,
    tables: contractTablesFor(id),
    maxBytes: def.maxBytes ?? MAX_RELEASE_FILE_BYTES,
  };
  const { loaders, warnings } = await def.publish(files, into, target);
  return publishStatsWith(contractColumnsHash(id), loaders, warnings);
}

/**
 * Builds a Phase-2 parquet source and its history twin from one definition (registry fields from
 * config/freshness SOURCE_REGISTRY — the history twin carries its current source's licence,
 * attribution, freshness class and job).
 */
export function makePhase2Sources(def: Phase2SourceDef): Phase2SourcePair {
  const info = SOURCE_REGISTRY[def.id];
  const maxBytes = def.maxBytes ?? MAX_RELEASE_FILE_BYTES;
  const urlOf = (season: number): string =>
    releaseAssetUrl(def.release.base, def.release.tag, def.file(season));
  const stampUrl = releaseAssetUrl(def.release.base, def.release.tag, "timestamp.txt");
  const historyId: HistoryDatasetSourceId = PHASE_2_HISTORY_TWIN[def.id];
  const common = {
    license: info.license,
    attribution: info.attribution,
    freshness: info.freshness,
    job: info.job,
    limiter: SOURCE_RATE_LIMITS.github_release,
  };
  const current: DataSource = Object.freeze({
    id: def.id,
    ...common,
    versioning: "release" as const,
    seasonGate: def.seasonGate,
    tables: contractTablesFor(def.id),
    version: async (ctx: SourceContext): Promise<ReleaseVersion | null> =>
      releaseVersionAt(
        stampUrl,
        def.release.label,
        ctx,
        runSeasons(ctx.seasons),
        def.release.parse,
      ),
    fetch: async (_v: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> =>
      fetchSeasonFiles(ctx, def.id.replace(":", "-"), runSeasons(ctx.seasons), urlOf, maxBytes),
    assertSchema: (files: readonly TempFile[]): Promise<NflverseSchemaReport> =>
      assertSchemaOf(def.id, files, (f) => expectedColumnsFor(def.id, f.season), maxBytes),
    publish: (files: readonly TempFile[], into: DatasetWriter): Promise<NflversePublishStats> =>
      publishInto(def, def.id, files, into),
  });
  const history: HistoryDataSource = Object.freeze({
    id: historyId,
    current: def.id,
    ...common,
    versioning: "time_bucket" as const,
    // prior seasons do not follow the current season's calendar: the monthly version is the gate
    seasonGate: "always" as const,
    tables: contractTablesFor(historyId),
    version: (ctx: SourceContext): Promise<ReleaseVersion | null> =>
      settle(() => historyVersion(historyId, ctx)),
    fetch: async (_v: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> =>
      fetchSeasonFiles(
        ctx,
        historyId.replace(":", "-"),
        historyRunSeasons(historyId, ctx),
        urlOf,
        maxBytes,
      ),
    assertSchema: (files: readonly TempFile[]): Promise<NflverseSchemaReport> =>
      assertSchemaOf(historyId, files, (f) => expectedColumnsFor(historyId, f.season), maxBytes),
    publish: (files: readonly TempFile[], into: DatasetWriter): Promise<NflversePublishStats> =>
      publishInto(def, historyId, files, into),
  });
  return { current, history };
}

/**
 * The history twin of a Phase-1 nflverse source (`stats_player_week`, `injuries`): the current
 * source's own fetch and publish over the prior seasons (same tables, so the same columns hash —
 * checked here) and its expected columns (reported under the history id), versioned by
 * `historyVersion`.
 */
export function phase1HistorySource(
  id: HistoryDatasetSourceId,
  current: DataSource,
): HistoryDataSource {
  if (HISTORY_OF[id] !== current.id) throw new Error(`phase2: ${id} does not repeat ${current.id}`);
  if (contractColumnsHash(id) !== contractColumnsHash(current.id))
    throw new Error(`phase2: ${id} and ${current.id} differ in tables`);
  return Object.freeze({
    id,
    current: current.id,
    license: current.license,
    attribution: current.attribution,
    freshness: current.freshness,
    job: current.job,
    limiter: current.limiter,
    versioning: "time_bucket" as const,
    seasonGate: "always" as const,
    tables: contractTablesFor(id),
    version: (ctx: SourceContext): Promise<ReleaseVersion | null> =>
      settle(() => historyVersion(id, ctx)),
    fetch: async (v: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> =>
      current.fetch(v, { ...ctx, seasons: historyRunSeasons(id, ctx) }),
    // the Phase-1 source's expected columns, reported under the history id
    assertSchema: (files: readonly TempFile[]): Promise<NflverseSchemaReport> =>
      assertSchemaOf(id, files, (f) => expectedColumnsFor(id, f.season)),
    publish: (files: readonly TempFile[], into: DatasetWriter) => current.publish(files, into),
  });
}

/**
 * Runs `fn` over every row of the files, each file read with its own expected columns
 * (`expectedColumnsFor` of the target's source and the file's season) under the target's size cap.
 */
export function eachContractRow(
  target: PublishTarget,
  files: readonly TempFile[],
  fn: (raw: RawRow, file: TempFile) => void,
): Promise<void> {
  return eachRowOf(
    target.id,
    files,
    (f) => expectedColumnsFor(target.id, f.season),
    fn,
    target.maxBytes,
  );
}

/**
 * Whether a row's season (as the source reads it) is its file's season; a row of another season is
 * an upstream anomaly: dropped and counted on `loader` (base.ts `inFileSeason`, for derived seasons).
 */
export function rowInFileSeason(
  loader: TableLoader,
  season: number | null,
  file: TempFile,
): boolean {
  if (season === file.season) return true;
  loader.drop("season differs from the file's season");
  return false;
}
