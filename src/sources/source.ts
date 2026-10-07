// source.ts — the DataSource contract (plan 01 §9 as amended by §5.5): a source never loads rows
// into store.sqlite. `eff refresh` asks it for the release `version()`, `fetch`es into temp files,
// `assertSchema`s them (expected columns AND the parquet codec — plan 01 D9; ADV OBJ-19(d)), then
// `publish`es into a FRESH per-source dataset file through a DatasetWriter; the publisher fsyncs and
// renames it, and the server opens it read-only. License + attribution are fields (plan 01 §9).
// The two keyless ESPN season views are sources too (plan 06 J3). Ported from sibling @d72e03b,
// adapted (ESPN season sources; `espn-unofficial` license; the host allow-list lives in src/http).
import type {
  Attribution,
  DatasetSourceId,
  FreshnessClassId,
  License,
  RefreshJob,
} from "../config/freshness.js";
import { ESPN_JOB_DAILY_CAPS } from "../config/schema.js";
import type { NflGamesReader, ProScheduleReader } from "../domain/analytics/types.js";
import type { Clock } from "../domain/clock.js";
import type { IsoInstant, Week } from "../domain/league/types.js";
import type { DatasetTableSpec, DatasetWriter, PublishStats } from "../store/types.js";

export type { Attribution, DatasetSourceId, License, RefreshJob } from "../config/freshness.js";
export type { DatasetTableSpec, DatasetWriter, PublishStats } from "../store/types.js";

/** A downloaded release file in the run's temp dir; removed by the runner on every path. */
export interface TempFile {
  readonly path: string;
  readonly bytes: number;
  /** The season the file holds; null for a season-less source. */
  readonly season: number | null;
}

/** Per-source politeness limits (plan 01 §6 "per-source limiters"). */
export interface RateLimit {
  readonly minIntervalMs: number;
  readonly maxPerDay: number | null;
  /**
   * When set, a run's DOWNLOADS are spaced by this instead of `minIntervalMs` (their own limiter, its
   * own day count): `minIntervalMs` then governs the GETs alone — the release poll plan 01 §6 limits
   * to one per 15 min — and a run's release assets are not held 15 min apart (integration fix).
   */
  readonly downloadMinIntervalMs?: number;
}

/** The per-source limits plan 01 §6 names. */
export const SOURCE_RATE_LIMITS = Object.freeze({
  /**
   * GitHub releases: poll `timestamp.txt` at most every 15 min; never the GitHub API in the hot path.
   * The poll is the limit (plan 01 §6); a run's asset downloads after it are spaced 1 s apart.
   */
  github_release: { minIntervalMs: 15 * 60 * 1000, maxPerDay: null, downloadMinIntervalMs: 1_000 },
  /** Sleeper ≤ 10/min. */
  sleeper: { minIntervalMs: 6_000, maxPerDay: null },
  /** Open-Meteo / NWS ≤ 1 per venue per hour (the runner keys it per venue). */
  weather: { minIntervalMs: 60 * 60 * 1000, maxPerDay: null },
  /** RSS every 15 min. */
  rss: { minIntervalMs: 15 * 60 * 1000, maxPerDay: null },
  /** The Odds API ≤ 3/day. */
  odds: { minIntervalMs: 60 * 60 * 1000, maxPerDay: 3 },
  /** The keyless ESPN season views: counted against the jobs' keyless cap (≤ 30/day; changelog V7). */
  espn_season: { minIntervalMs: 60 * 1000, maxPerDay: ESPN_JOB_DAILY_CAPS.keyless },
} satisfies Record<string, RateLimit>);

/** Release downloads time out after 60 s (plan 01 §6). */
export const RELEASE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Refresh jobs retry 3× with jitter inside one run, then stop and report (plan 01 §5.7). */
export const REFRESH_MAX_ATTEMPTS = 3;
/** Most redirect hops a GET follows, each re-checked against the host allow-list (plan 01 §6). */
export const MAX_REDIRECT_HOPS = 3;

/**
 * A bounded HTTP GET injected by the runner (implemented over src/http with its host allow-list):
 * redirects followed manually, ≤ MAX_REDIRECT_HOPS, every hop re-checked before it is requested.
 */
export type HttpGet = (
  url: string,
  opts: {
    readonly signal: AbortSignal;
    readonly maxBytes: number;
    readonly accept?: string;
    /**
     * The `X-Fantasy-Filter` header (additive, B1): accepted only for a URL on the ESPN read host
     * (the keyless `players_wl` view needs a root-level `filterActive`); refused for any other host.
     */
    readonly fantasyFilter?: string;
  },
) => Promise<{
  readonly status: number;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly final_url: string;
}>;

/** A bounded GET streaming to a new 0600 file (`dest`, created exclusively); partial files removed. */
export type HttpDownload = (
  url: string,
  opts: {
    readonly signal: AbortSignal;
    readonly maxBytes: number;
    readonly dest: string;
    readonly accept?: string;
  },
) => Promise<{
  readonly status: number;
  readonly bytes: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly final_url: string;
  readonly path: string;
}>;

/** When a job runs (plan 06: "jobs are season-aware"). */
export type SeasonGate = "always" | "in_season";

/** What the runner gives a source for one run. */
export interface SourceContext {
  readonly http: HttpGet;
  readonly download: HttpDownload;
  readonly signal: AbortSignal;
  readonly clock: Clock;
  /** The seasons this run covers, newest last. */
  readonly seasons: readonly number[];
  /** The week the run targets (weather: the coming week); null for season-wide sources. */
  readonly week: Week | null;
  /** Already-published datasets a source is driven by (weather ← the pro schedule's outdoor games). */
  readonly datasets: {
    readonly proSchedule: ProScheduleReader;
    /**
     * nflverse schedules (additive, B1; optional): the per-game roof a retractable-roof venue needs
     * (weather fetches only when it says `open`/`outdoors`). Absent → such a venue is assumed closed.
     */
    readonly nflGames?: NflGamesReader;
  };
  /** The run's private temp dir (created and removed by the runner). */
  readonly tempDir: string;
  /** Reports that a season's data is not published upstream yet (a new season's 404). */
  readonly notPublished: (season: number) => void;
}

/** How a source versions its data. */
export type Versioning = "release" | "time_bucket";

/** A source's current version. */
export interface ReleaseVersion {
  readonly version: string;
  readonly released_at: IsoInstant | null;
}

/** A parquet column chunk's codec. */
export interface ColumnCodec {
  readonly column: string;
  readonly codec: string;
}

/** The schema + codec assertion result (plan 01 §5.5): missing columns fail; extra columns warn. */
export interface SchemaReport {
  readonly ok: boolean;
  readonly missing_columns: readonly string[];
  readonly extra_columns: readonly string[];
  readonly bad_codecs: readonly ColumnCodec[];
  readonly rows: number;
  readonly warnings: readonly string[];
}

/** The parquet codecs accepted at load (nflverse writes snappy — plan 01 D9). */
export const ALLOWED_PARQUET_CODECS: readonly string[] = Object.freeze(["SNAPPY", "UNCOMPRESSED"]);

/** One external dataset (plan 01 §9). */
export interface DataSource {
  readonly id: DatasetSourceId;
  readonly license: License;
  readonly attribution: Attribution;
  readonly freshness: FreshnessClassId;
  /** The `eff refresh <job>` that runs it (plan 06 §1.3). */
  readonly job: RefreshJob;
  readonly limiter: RateLimit;
  readonly versioning: Versioning;
  readonly seasonGate: SeasonGate;
  readonly tables: readonly DatasetTableSpec[];
  /** The current version; null when upstream is unreachable (the run fails, nothing is written). */
  version(ctx: SourceContext): Promise<ReleaseVersion | null>;
  fetch(version: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]>;
  assertSchema(files: readonly TempFile[]): Promise<SchemaReport>;
  /** Writes every season's rows into the fresh staging file; never touches store.sqlite. */
  publish(files: readonly TempFile[], into: DatasetWriter): Promise<PublishStats>;
}
