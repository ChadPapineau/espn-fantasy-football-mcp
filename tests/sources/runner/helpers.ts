// helpers.ts — fakes for the refresh runner: a scriptable DataSource, publisher, refresh log and
// ESPN pro-schedule reader. Only temp dirs under os.tmpdir() are touched; no network, no ~/.cache.
// Ported from sibling @cf3b015, adapted (ProScheduleReader instead of the nflverse schedules).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTRIBUTIONS, type DatasetSourceId } from "../../../src/config/freshness.js";
import type {
  DatasetResult,
  DatasetStamp,
  ProScheduleReader,
} from "../../../src/domain/analytics/types.js";
import type { ProGame, ProTeam } from "../../../src/domain/league/types.js";
import type {
  DataSource,
  HttpDownload,
  HttpGet,
  ReleaseVersion,
  SchemaReport,
  SourceContext,
  TempFile,
} from "../../../src/sources/source.js";
import type {
  DatasetPublisher,
  DatasetRow,
  DatasetTableSpec,
  DatasetWriter,
  PublishOutcome,
  PublishStats,
  RefreshLogRow,
} from "../../../src/store/types.js";

export const OK_REPORT: SchemaReport = {
  ok: true,
  missing_columns: [],
  extra_columns: ["new_col"],
  bad_codecs: [],
  rows: 3,
  warnings: ["extra column new_col"],
};

export const STATS: PublishStats = {
  rows: 3,
  tables: [{ name: "ds_test", rows: 3 }],
  seasons: [2026],
  columns_hash: "abc",
};

export const NO_HTTP: HttpGet = () => Promise.reject(new Error("no network in this test"));
export const NO_DOWNLOAD: HttpDownload = () => Promise.reject(new Error("no network in this test"));

export interface FakeSourceOpts {
  id?: DatasetSourceId;
  versioning?: "release" | "time_bucket";
  seasonGate?: "always" | "in_season";
  limiter?: { minIntervalMs: number; maxPerDay: number | null };
  version?: (ctx: SourceContext, n: number) => Promise<ReleaseVersion | null>;
  fetch?: (v: ReleaseVersion, ctx: SourceContext, n: number) => Promise<readonly TempFile[]>;
  assertSchema?: (files: readonly TempFile[]) => Promise<SchemaReport>;
  publish?: (files: readonly TempFile[], w: DatasetWriter) => Promise<PublishStats>;
}

export interface FakeSource extends DataSource {
  readonly calls: { version: number; fetch: number; assert: number; publish: number };
  readonly contexts: SourceContext[];
  readonly files: TempFile[];
}

/** A source whose default fetch writes one temp file into ctx.tempDir. */
export function fakeSource(o: FakeSourceOpts = {}): FakeSource {
  const calls = { version: 0, fetch: 0, assert: 0, publish: 0 };
  const contexts: SourceContext[] = [];
  const files: TempFile[] = [];
  return {
    id: o.id ?? "nflverse:injuries",
    license: "CC-BY-4.0",
    attribution: ATTRIBUTIONS.nflverse,
    freshness: "nflverse_injuries",
    job: "nflverse:daily",
    limiter: o.limiter ?? { minIntervalMs: 0, maxPerDay: null },
    versioning: o.versioning ?? "release",
    seasonGate: o.seasonGate ?? "always",
    tables: [],
    calls,
    contexts,
    files,
    version(ctx) {
      calls.version++;
      contexts.push(ctx);
      return o.version
        ? o.version(ctx, calls.version)
        : Promise.resolve({
            version: "2026-09-30T13:36:27Z",
            released_at: "2026-09-30T13:36:27.000Z",
          });
    },
    async fetch(v, ctx) {
      calls.fetch++;
      contexts.push(ctx);
      if (o.fetch) return o.fetch(v, ctx, calls.fetch);
      const path = join(ctx.tempDir, "release.parquet");
      await writeFile(path, "PAR1");
      const f = { path, bytes: 4, season: 2026 };
      files.push(f);
      return [f];
    },
    assertSchema(f) {
      calls.assert++;
      return o.assertSchema ? o.assertSchema(f) : Promise.resolve(OK_REPORT);
    },
    publish(f, w) {
      calls.publish++;
      return o.publish ? o.publish(f, w) : Promise.resolve(STATS);
    },
  };
}

/** A writer that records what it was asked to do. */
export function recordingWriter(): DatasetWriter & {
  tables: DatasetTableSpec[];
  rows: Map<string, DatasetRow[]>;
} {
  const tables: DatasetTableSpec[] = [];
  const rows = new Map<string, DatasetRow[]>();
  return {
    path: "/staging/fake.tmp",
    tables,
    rows,
    createTable(spec) {
      tables.push(spec);
      rows.set(spec.name, []);
    },
    insert(table, r) {
      rows.get(table)?.push(...r);
      return r.length;
    },
  };
}

export interface FakePublisher extends DatasetPublisher {
  readonly published: { source: DatasetSourceId; version: string; released: string | null }[];
  readonly unchanged: { source: DatasetSourceId; version: string; at: string }[];
  readonly options: ({ readonly skipIfCurrent?: boolean } | undefined)[];
  readonly writer: ReturnType<typeof recordingWriter>;
}

/** A publisher that runs `fill` against a recording writer and returns `outcome` (or ok). */
export function fakePublisher(
  outcome?: (stats: PublishStats) => PublishOutcome,
  opts: { throwOnPublish?: boolean; throwOnUnchanged?: boolean } = {},
): FakePublisher {
  const published: FakePublisher["published"] = [];
  const unchanged: FakePublisher["unchanged"] = [];
  const options: FakePublisher["options"] = [];
  const writer = recordingWriter();
  return {
    published,
    unchanged,
    options,
    writer,
    async publish(source, version, released, fill, o) {
      if (opts.throwOnPublish === true) throw new Error("disk full");
      published.push({ source, version, released });
      options.push(o);
      const stats = await fill(writer);
      return outcome
        ? outcome(stats)
        : { ok: true, file: `/cache/ds/${source}.sqlite`, file_version: version, stats };
    },
    recordUnchanged(source, version, at) {
      if (opts.throwOnUnchanged === true) throw new Error("busy");
      unchanged.push({ source, version, at });
    },
    close() {
      /* nothing */
    },
  };
}

/** An in-memory refresh log (sync, as the store's port is). */
export function fakeRefreshLog(initial: RefreshLogRow[] = []): {
  rows: RefreshLogRow[];
  record(row: RefreshLogRow): void;
  current(): readonly RefreshLogRow[];
} {
  const rows = [...initial];
  return {
    rows,
    record(row) {
      rows.push(row);
    },
    current() {
      return rows.filter((r) => r.ok);
    },
  };
}

/** A previous successful refresh_log row. */
export function okRow(
  source: DatasetSourceId,
  file_version: string,
  file: string | null = `/cache/ds/${source}.sqlite`,
): RefreshLogRow {
  return {
    source,
    file,
    file_version,
    release_updated_at: null,
    seasons: [2026],
    rows: 10,
    columns_hash: "h",
    started_at: "2026-09-29T10:00:00.000Z",
    finished_at: "2026-09-29T10:00:05.000Z",
    ok: true,
    error: null,
    checked_at: "2026-09-29T10:00:05.000Z",
  };
}

/** An ESPN pro game (synthetic id) between two ESPN pro-team ids. */
export function proGame(id: number, kickoff: string | null, extra: Partial<ProGame> = {}): ProGame {
  return {
    espn_game_id: id,
    season: 2026,
    week: 5,
    kickoff,
    start_time_tbd: false,
    valid_for_locking: true,
    stats_official: false,
    home_pro_team_id: 5,
    away_pro_team_id: 6,
    ...extra,
  };
}

/** The ESPN pro teams the fakes use (ESPN spellings; ids as research 03 §B.2 lists them). */
export const PRO_TEAMS: readonly ProTeam[] = [
  { id: 1, abbrev: "ATL", bye_week: 5 },
  { id: 5, abbrev: "CLE", bye_week: 9 },
  { id: 6, abbrev: "DAL", bye_week: 10 },
  { id: 8, abbrev: "DET", bye_week: 8 },
  { id: 9, abbrev: "GB", bye_week: 11 },
  { id: 3, abbrev: "CHI", bye_week: 7 },
  { id: 11, abbrev: "IND", bye_week: 11 },
  { id: 14, abbrev: "LAR", bye_week: 8 },
  { id: 13, abbrev: "LV", bye_week: 8 },
  { id: 16, abbrev: "MIN", bye_week: 6 },
  { id: 18, abbrev: "NO", bye_week: 11 },
  { id: 21, abbrev: "PHI", bye_week: 9 },
  { id: 22, abbrev: "ARI", bye_week: 8 },
  { id: 28, abbrev: "WSH", bye_week: 12 },
  { id: 30, abbrev: "JAX", bye_week: 8 },
  { id: 34, abbrev: "HOU", bye_week: 6 },
];

const STAMP: DatasetStamp = {
  source: "espn:pro_schedule",
  as_of: "2026-09-30T15:58:07.000Z",
  fetched_at: "2026-09-30T16:00:00.000Z",
  checked_at: "2026-09-30T16:00:00.000Z",
  freshness_class: "espn_pro_schedule",
  file_version: "v1",
};

/** A pro-schedule reader over fixed games; `loaded: false` → stamp null (never loaded). */
export function fakeProSchedule(
  games: readonly ProGame[],
  loaded = true,
  teams: readonly ProTeam[] = PRO_TEAMS,
): ProScheduleReader & { queries: { season: number; weeks: readonly number[] | null }[] } {
  const queries: { season: number; weeks: readonly number[] | null }[] = [];
  return {
    queries,
    games(season, weeks): DatasetResult<ProGame> {
      queries.push({ season, weeks });
      return {
        rows: games.filter(
          (g) => g.season === season && (weeks === null || weeks.includes(g.week)),
        ),
        stamp: loaded ? STAMP : null,
      };
    },
    teams(): DatasetResult<ProTeam> {
      return { rows: loaded ? teams : [], stamp: loaded ? STAMP : null };
    },
  };
}
