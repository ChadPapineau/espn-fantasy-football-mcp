// release.ts — nflverse release access (plan 01 §5.5 + D9: `timestamp.txt` → download to a temp file;
// research 04 §B.2 `releases/download/{tag}/{file}`, a 24-byte `timestamp.txt` per tag). Versions come
// from timestamp.txt; files arrive through the runner's injected HttpGet / HttpDownload (never global
// fetch) inside the run's temp dir. Ported from sibling @521f9f3, adapted (SourceContext's required
// download + tempDir, the ESPN pro schedule as the season-start clock, SourceErrorCode errors).
// Phase 2 (plan 10 §3.2), additive: the Phase-2 tags, a per-call size cap (the pbp files are ~21 MB
// a season), and the release machinery parameterised by base URL, tag and stamp parser so the
// ffopportunity release (`ffverse/ffopportunity`, tag `latest-data`) reuses it.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SourceErrorCode } from "../../config/freshness.js";
import { defaultSeason } from "../../config/schema.js";
import type { IsoInstant } from "../../domain/league/types.js";
import type { HttpGet, ReleaseVersion, SourceContext, TempFile } from "../source.js";

/** Where every nflverse release asset lives (research 04 §B.2). */
export const NFLVERSE_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

/** The release tags the Phase-1 sources read. */
export const NFLVERSE_TAGS = [
  "schedules",
  "injuries",
  "weekly_rosters",
  "stats_player",
  "players",
] as const;
/**
 * The release tags the Phase-2 sources read (plan 10 §3.2). Kept apart from NFLVERSE_TAGS, which
 * `eff doctor` polls one by one (src/cli/doctor-online.ts) — adding a tag there is that owner's call.
 */
export const NFLVERSE_PHASE_2_TAGS = ["stats_team", "pbp", "snap_counts", "depth_charts"] as const;
export type NflverseTag = (typeof NFLVERSE_TAGS)[number] | (typeof NFLVERSE_PHASE_2_TAGS)[number];

/** timestamp.txt is 24 bytes today; anything past this is not a timestamp. */
export const TIMESTAMP_MAX_BYTES = 256;
/** Cap per release file (the 2026 files are 35 KB – 3.4 MB; plan 01 §5.8 "< 5 MB each"). */
export const MAX_RELEASE_FILE_BYTES = 16 * 1024 * 1024;
/**
 * Cap per pbp release file (Phase 2): a full season is ~21 MB (2024: 20,597,560 B; 2025: 20,337,029 B,
 * observed 2026-10-06), so 64 MiB leaves 3× headroom while still refusing a runaway body. The file
 * is read whole by hyparquet, so this also bounds the run's peak memory.
 */
export const PBP_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** The oldest and newest season a URL may be built for (nflverse starts in 1999). */
export const MIN_SEASON = 1999;
export const MAX_SEASON = 2100;
/**
 * How long after a season's first kickoff a per-season file may still be missing upstream before a
 * 404 for it is a real failure: nflverse builds a season's stats after its first games and its
 * injury reports from the first practice report; two weeks covers both with margin.
 */
export const SEASON_PUBLISH_GRACE_DAYS = 14;
const DAY_MS = 86_400_000;

/** Why an nflverse step failed — the detail behind the fixed-vocabulary `code`. */
export type NflverseFailure =
  "bad_timestamp" | "bad_season" | "download" | "not_parquet" | "schema" | "codec" | "corrupt";

const CODE_OF: Readonly<Record<NflverseFailure, SourceErrorCode>> = Object.freeze({
  bad_timestamp: "schema_mismatch",
  bad_season: "INTERNAL",
  download: "UPSTREAM_UNAVAILABLE",
  not_parquet: "schema_mismatch",
  schema: "schema_mismatch",
  codec: "codec",
  corrupt: "schema_mismatch",
});

/**
 * An nflverse source failed in a way the run must report. `code` is the refresh_log / G1 vocabulary
 * (config/freshness.ts SOURCE_ERROR_CODES); the message names only what WE built (a URL, a column,
 * a codec) — never upstream text.
 */
export class NflverseSourceError extends Error {
  readonly reason: NflverseFailure;
  readonly code: SourceErrorCode;
  /** The HTTP status of a non-200 answer, else null. */
  readonly status: number | null;
  constructor(reason: NflverseFailure, message: string, status: number | null = null) {
    super(message);
    this.name = "NflverseSourceError";
    this.reason = reason;
    this.status = status;
    this.code = reason === "download" && status === 429 ? "RATE_LIMITED" : CODE_OF[reason];
  }
}

const SAFE_ASSET_PART_RE = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * The URL of an asset of a GitHub release: `<base>/<tag>/<file>`; `tag` and `file` must be plain
 * names (no `/`, no `..`) — both come from code constants and validated seasons, never upstream.
 */
export function releaseAssetUrl(base: string, tag: string, file: string): string {
  for (const part of [tag, file]) {
    if (!SAFE_ASSET_PART_RE.test(part) || part.includes("..")) {
      throw new NflverseSourceError("download", "nflverse: refusing an unsafe release file name");
    }
  }
  return `${base}/${tag}/${file}`;
}

/** The URL of a release asset; `file` must be a plain file name. */
export function releaseUrl(tag: NflverseTag, file: string): string {
  return releaseAssetUrl(NFLVERSE_RELEASE_BASE, tag, file);
}

/** A season fit for a URL; anything else throws (seasons come from config, never upstream). */
export function assertSeason(season: unknown): number {
  if (
    typeof season !== "number" ||
    !Number.isInteger(season) ||
    season < MIN_SEASON ||
    season > MAX_SEASON
  ) {
    throw new NflverseSourceError(
      "bad_season",
      `nflverse: a season must be an integer ${String(MIN_SEASON)}–${String(MAX_SEASON)}`,
    );
  }
  return season;
}

/** The run's seasons, validated, de-duplicated, in the caller's order. */
export function runSeasons(seasons: readonly number[]): readonly number[] {
  const out: number[] = [];
  for (const s of seasons) if (!out.includes(assertSeason(s))) out.push(s);
  return out;
}

const ZONE_OFFSET_MIN: Readonly<Record<string, number>> = Object.freeze({
  EDT: -240,
  EST: -300,
  UTC: 0,
  GMT: 0,
  Z: 0,
});

const TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?\s*(EDT|EST|UTC|GMT|Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parses nflverse's `timestamp.txt` (`2026-10-06 02:02:02 EDT` — a US Eastern wall time with its zone
 * abbreviation, NOT ISO; the parquet key-value `nflverse_timestamp` has the same form) or an ISO-8601
 * instant into an ISO-8601 UTC instant (whole seconds). An unknown zone abbreviation, an impossible
 * date or anything else → null: a zone is never guessed.
 */
export function parseNflverseTimestamp(text: unknown): IsoInstant | null {
  if (typeof text !== "string" || text.length > TIMESTAMP_MAX_BYTES) return null;
  const m = TS_RE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  const zone = m[7] ?? "";
  let offsetMin = ZONE_OFFSET_MIN[zone];
  if (offsetMin === undefined) {
    // TS_RE admits only the named zones or ±HH[:]MM here.
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.replace(/[^0-9]/g, "");
    const hh = Number(digits.slice(0, 2));
    const mm = Number(digits.slice(2));
    if (hh > 14 || mm > 59) return null;
    offsetMin = sign * (hh * 60 + mm);
  }
  return new Date(naive - offsetMin * 60_000).toISOString();
}

/**
 * The version string for a release instant and a run's seasons: `YYYYMMDDTHHMMSSZ_<s1>-<s2>…`
 * (`YYYYMMDDTHHMMSSZ` alone for a season-less source) — filename-safe (the staging file is
 * `<stem>.<version>.<rand>.tmp`), and it changes when the seasons asked for change, so a run covering
 * another season set is never skipped as "unchanged" against a file that lacks those seasons.
 */
export function versionString(releasedAt: IsoInstant, seasons: readonly number[]): string {
  const compact = releasedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return seasons.length === 0 ? compact : `${compact}_${seasons.join("-")}`;
}

/** Whether `err` asks to be retried in the same run (src/http's HttpError carries `retryable`). */
export function isRetryable(err: unknown): boolean {
  return err instanceof Error && (err as { readonly retryable?: unknown }).retryable === true;
}

/** Whether `err` is upstream answering 404 (an HttpError's `status`, or ours from a returned status). */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as { readonly status?: unknown }).status === 404;
}

async function timestampBody(
  http: HttpGet,
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  try {
    const res = await http(url, { signal, maxBytes: TIMESTAMP_MAX_BYTES, accept: "text/plain" });
    if (res.status !== 200 || res.body.length > TIMESTAMP_MAX_BYTES) return null;
    return res.body;
  } catch (err) {
    // A cancelled run and a retryable failure (429, 5xx, reset, timeout) propagate — the runner
    // stops or retries (plan 01 §5.7, ≤ 3 attempts); anything else reads as "unreachable".
    if (signal.aborted || isRetryable(err)) throw err;
    return null;
  }
}

/**
 * Reads `{tag}/timestamp.txt` → the release version for the run's seasons (`seasonless`: none), or
 * null when upstream is unreachable or answers non-200 (the DataSource.version contract). A reachable
 * but unparseable stamp throws (`schema_mismatch`): a format change fails loudly, never as an outage.
 */
export async function releaseVersion(
  tag: NflverseTag,
  ctx: SourceContext,
  seasonless = false,
): Promise<ReleaseVersion | null> {
  return releaseVersionAt(
    releaseUrl(tag, "timestamp.txt"),
    `nflverse ${tag}`,
    ctx,
    seasonless ? [] : runSeasons(ctx.seasons),
  );
}

/**
 * `releaseVersion` for any release's `timestamp.txt` URL: `label` names the release in errors (our
 * text, never upstream's); `parse` reads the stamp (default: nflverse's form). The same contract:
 * null when unreachable or non-200; a reachable but unparseable stamp throws `schema_mismatch`.
 */
export async function releaseVersionAt(
  url: string,
  label: string,
  ctx: SourceContext,
  seasons: readonly number[],
  parse: (text: string) => IsoInstant | null = parseNflverseTimestamp,
): Promise<ReleaseVersion | null> {
  const body = await timestampBody(ctx.http, url, ctx.signal);
  if (body === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new NflverseSourceError("bad_timestamp", `${label}: timestamp.txt is not UTF-8`);
  }
  const releasedAt = parse(text);
  if (releasedAt === null) {
    throw new NflverseSourceError("bad_timestamp", `${label}: unparseable timestamp.txt`);
  }
  return { version: versionString(releasedAt, seasons), released_at: releasedAt };
}

/** A private directory for one source's files inside the run's temp dir (concurrency-safe). */
export async function sourceTempDir(ctx: SourceContext, slug: string): Promise<string> {
  return mkdtemp(join(ctx.tempDir, `eff-${slug}-`));
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Downloads one release asset to `dest` through the runner's streaming HttpDownload (a new 0600 file,
 * created exclusively). A non-200 status, a non-https final URL or an oversize body fails naming the
 * URL; the partial file is removed on every failure path. `maxBytes` (default
 * MAX_RELEASE_FILE_BYTES) is the per-source cap: the pbp files need more (PBP_MAX_FILE_BYTES).
 */
export async function downloadAsset(
  ctx: SourceContext,
  url: string,
  dest: string,
  season: number | null,
  maxBytes: number = MAX_RELEASE_FILE_BYTES,
): Promise<TempFile> {
  try {
    const res = await ctx.download(url, {
      signal: ctx.signal,
      maxBytes,
      dest,
      accept: "application/octet-stream",
    });
    if (res.status !== 200) {
      throw new NflverseSourceError(
        "download",
        `nflverse: ${url} answered ${String(res.status)}`,
        res.status,
      );
    }
    if (!isHttps(res.final_url)) {
      throw new NflverseSourceError("download", `nflverse: ${url} was not served over https`);
    }
    if (!Number.isSafeInteger(res.bytes) || res.bytes < 0 || res.bytes > maxBytes) {
      throw new NflverseSourceError("download", `nflverse: ${url} exceeds the size cap`);
    }
    return { path: dest, bytes: res.bytes, season };
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  }
}

/**
 * The earliest known kickoff of a season's week 1 from the ESPN pro schedule (the dataset the run is
 * given — SourceContext.datasets), or null when the schedule does not know it (absent, unreadable,
 * every week-1 kickoff still TBD).
 */
export function firstKickoffMs(season: number, ctx: SourceContext): number | null {
  try {
    const { rows } = ctx.datasets.proSchedule.games(season, [1]);
    let first: number | null = null;
    for (const g of rows) {
      if (g.start_time_tbd || g.kickoff === null) continue;
      const ms = Date.parse(g.kickoff);
      if (Number.isFinite(ms) && (first === null || ms < first)) first = ms;
    }
    return first;
  } catch {
    return null;
  }
}

/**
 * Whether a 404 for `season`'s file may mean "not published yet" rather than a real failure: the
 * season is the current one (config `defaultSeason`) or later, and has not been under way for
 * SEASON_PUBLISH_GRACE_DAYS since its first kickoff (unknown kickoff → it cannot be proven started).
 * A past season's file always exists, so its 404 is a failure.
 */
export function mayBeUnpublished(season: number, ctx: SourceContext): boolean {
  const now = ctx.clock.nowMs();
  if (season < defaultSeason(now)) return false;
  const kickoff = firstKickoffMs(season, ctx);
  return kickoff === null || now < kickoff + SEASON_PUBLISH_GRACE_DAYS * DAY_MS;
}
