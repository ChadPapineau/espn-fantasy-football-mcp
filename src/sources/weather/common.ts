// common.ts — the shared weather DataSource machinery (plan 01 §5.2 weather row, §5.5 pipeline;
// plan 06 §1.3 `refresh weather` "hourly Wed → kickoff, outdoor games of the coming week only";
// research 04 §B.7/§B.8). A provider (Open-Meteo, NWS) supplies only how to fetch one venue and how
// to read one response; this file selects the games FROM THE ESPN PRO SCHEDULE (SourceContext
// .datasets.proSchedule — ESPN names no venue, so the nflverse game id is derived with
// `nflverseGameId` and the venue is `venueForGame`), writes the per-run temp file, asserts its shape
// and publishes the kickoff-hour rows into tables.ts DS_WEATHER_OPEN_METEO / DS_WEATHER_NWS.
//
// Roof rule: a fixed-roof venue never gets weather and an open-air venue always does (venues.ts
// `roof_default`, the physical roof); a RETRACTABLE venue fetches only when the game's own nflverse
// roof (the optional `datasets.nflGames`) says `open`/`outdoors` — unknown → assumed closed.
// Politeness: `version()` is the UTC hour bucket and the runner short-circuits a bucket already
// published, so each venue is asked at most once per hour (plan 01 §6); the provider's limiter
// spaces the venue requests inside a run. Games with an unconfirmed kickoff (`start_time_tbd`) are
// skipped — no forecast for a placeholder time. Ported from sibling @cf3b015, adapted.
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_REGISTRY, type DatasetSourceId } from "../../config/freshness.js";
import type { IsoInstant, ProGame, Week } from "../../domain/league/types.js";
import { HttpError, POLICY_KINDS } from "../../http/errors.js";
import { espnAbbrevToNflverse, nflverseGameId } from "../../store/datasets/derive.js";
import { columnsHash, type DatasetTableContract } from "../../store/datasets/tables.js";
import type { DatasetRow, DatasetWriter } from "../../store/types.js";
import type {
  DataSource,
  License,
  PublishStats,
  RateLimit,
  ReleaseVersion,
  SchemaReport,
  SourceContext,
  TempFile,
} from "../source.js";
import { venueForGame, type VenueReference } from "../venues.js";

/** The temp-file format marker (bumped if the shape changes). */
export const WEATHER_FILE_FORMAT = "eff-weather-v1";
/** Largest temp file assertSchema/publish will read back. */
export const MAX_WEATHER_FILE_BYTES = 64 * 1024 * 1024;
/** A game already this far past kickoff is no longer forecast. */
export const PAST_KICKOFF_GRACE_MS = 60 * 60 * 1000;
/** At most this many games are considered per run (a week has 16; a season-wide run ~272). */
export const MAX_WEATHER_GAMES = 400;

/** The provider keys, as used in the temp file. */
export type WeatherProviderKey = "open_meteo" | "nws";

/** One game the run forecasts, with the venue coordinates it was queried at. */
export interface WeatherGame {
  readonly game_id: string;
  readonly espn_game_id: number;
  readonly season: number;
  readonly week: number;
  readonly venue_id: string;
  readonly lat: number;
  readonly lon: number;
  readonly kickoff_utc: IsoInstant;
}

/** One venue's response as stored in the temp file (`body` is the parsed JSON, or null on failure). */
export interface VenueResponse {
  readonly venue_id: string;
  readonly body: unknown;
}

/** The per-run temp file (JSON). */
export interface WeatherFile {
  readonly format: typeof WEATHER_FILE_FORMAT;
  readonly provider: WeatherProviderKey;
  readonly fetched_at: IsoInstant;
  readonly games: readonly WeatherGame[];
  readonly responses: readonly VenueResponse[];
  readonly warnings: readonly string[];
}

/** The kickoff-hour values a provider reads from one response. */
export interface KickoffForecast {
  /** Start of the forecast hour (or period) containing kickoff, epoch ms. */
  readonly hourStartMs: number;
  readonly temp_f: number | null;
  readonly wind_mph: number | null;
  readonly gust_mph: number | null;
  /** A fraction 0..1. */
  readonly precip_prob: number | null;
}

/** What a weather provider supplies. */
export interface WeatherProvider {
  readonly id: Extract<DatasetSourceId, "weather:open_meteo" | "weather:nws">;
  readonly key: WeatherProviderKey;
  readonly table: DatasetTableContract;
  /** research 04 §B.7/§B.8: Open-Meteo non-commercial, NWS public domain. */
  readonly license: License;
  /** Spacing between this provider's requests inside one run (the hour bucket bounds re-asks). */
  readonly limiter: RateLimit;
  /** NWS covers US venues only (research 04 §B.8). */
  readonly usOnly: boolean;
  /** How far ahead the provider forecasts hourly. */
  readonly horizonHours: number;
  /** Fields that fail the schema when absent from EVERY response (drift, not a per-venue gap). */
  readonly requiredFields: readonly string[];
  /** Fetches one venue; returns the parsed JSON body. Throws HttpError on a network failure. */
  fetchVenue(venue: VenueReference, ctx: SourceContext): Promise<unknown>;
  /** Which of the provider's field names the body carries. */
  fieldsPresent(body: unknown): ReadonlySet<string>;
  /** The forecast for the hour containing `kickoffMs`, or null when the body does not cover it. */
  forecastAt(body: unknown, kickoffMs: number): KickoffForecast | null;
  /** The provider's stated issue time (NWS `updateTime`), or null. */
  issueTime(body: unknown): IsoInstant | null;
}

/** Options every weather source takes. */
export interface WeatherSourceOptions {
  /** An injected pro-game list (tests, or a caller that already read the schedule). */
  readonly games?: (ctx: SourceContext) => readonly ProGame[];
}

// --- small, hostile-input-safe readers ----------------------------------------------------------------

/** An own property of a plain object, or undefined (never walks the prototype). */
export function own(o: unknown, key: string): unknown {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return undefined;
  return Object.prototype.hasOwnProperty.call(o, key)
    ? (o as Record<string, unknown>)[key]
    : undefined;
}

/** A finite number, or null. */
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Rounds to 2 decimals and keeps it only inside [lo, hi]. */
export function inRange(v: number | null, lo: number, hi: number): number | null {
  if (v === null || !Number.isFinite(v) || v < lo || v > hi) return null;
  return Math.round(v * 100) / 100;
}

/** Temperature to °F from a unit label (Open-Meteo `°F`/`°C`, NWS `F`/`C`, WMO `wmoUnit:degC`). */
export function toFahrenheit(v: number | null, unit: string | null): number | null {
  if (v === null) return null;
  const u = (unit ?? "°F").toLowerCase().replace("wmounit:", "").replace("°", "");
  if (u === "f" || u === "degf") return inRange(v, -80, 140);
  if (u === "c" || u === "degc") return inRange((v * 9) / 5 + 32, -80, 140);
  return null;
}

const MPH_FACTOR: ReadonlyMap<string, number> = new Map([
  ["mp/h", 1],
  ["mph", 1],
  ["mi_h-1", 1],
  ["km/h", 1 / 1.609344],
  ["km_h-1", 1 / 1.609344],
  ["m/s", 2.2369363],
  ["m_s-1", 2.2369363],
  ["kn", 1.1507794],
  ["kt", 1.1507794],
]);

/** Wind speed to mph from a unit label (`mp/h`, `mph`, `km/h`, `m/s`, `kn`, WMO codes). */
export function toMph(v: number | null, unit: string | null): number | null {
  if (v === null) return null;
  const f = MPH_FACTOR.get((unit ?? "mp/h").toLowerCase().replace("wmounit:", ""));
  return f === undefined ? null : inRange(v * f, 0, 250);
}

/** A percent (0..100) to a fraction (0..1), or null. */
export function percentToFraction(v: number | null): number | null {
  if (v === null || v < 0 || v > 100) return null;
  return Math.round(v) / 100;
}

/** Parses an ISO instant to canonical `toISOString()`, or null. */
export function isoOrNull(v: unknown): IsoInstant | null {
  if (typeof v !== "string" || v.length > 64) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** UTF-8 JSON decode of an HTTP body; undefined when it is not valid UTF-8 JSON. */
export function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A value safe to put in a warning (ids only; anything else is elided). */
export function safeId(s: unknown): string {
  if (typeof s === "number" && Number.isSafeInteger(s)) return String(s);
  return typeof s === "string" && SAFE_ID.test(s) ? s : "?";
}

// --- game selection -------------------------------------------------------------------------------------

/** Whether a game at `venue` is played open-air (the roof rule in the header). */
export function needsWeather(gameRoof: string | null, venue: VenueReference): boolean {
  if (venue.retractable) {
    const r = (gameRoof ?? "").trim().toLowerCase();
    return r === "open" || r === "outdoors";
  }
  return venue.roof_default === "outdoors";
}

/** The nflverse roofs of `espnIds` from the optional nflGames reader (empty when absent / failing). */
function roofsOf(
  ctx: SourceContext,
  espnIds: readonly number[],
): ReadonlyMap<number, string | null> {
  const reader = ctx.datasets.nflGames;
  const out = new Map<number, string | null>();
  if (reader === undefined || espnIds.length === 0) return out;
  try {
    for (const g of reader.byEspnGameId(espnIds).rows)
      if (g.espn_game_id !== null) out.set(g.espn_game_id, g.roof);
  } catch {
    // an unreadable nflverse file only means retractable venues are assumed closed
  }
  return out;
}

/**
 * The games to forecast: the target season (the newest of `ctx.seasons`), the target week (or every
 * week when `ctx.week` is null), with a confirmed kickoff between one hour ago and the provider
 * horizon, at a known venue that is open-air for this game (US-only for NWS). Deduplicated by the
 * ESPN game id; at most MAX_WEATHER_GAMES are considered.
 */
export function selectGames(
  ctx: SourceContext,
  provider: Pick<WeatherProvider, "usOnly" | "horizonHours">,
  opts: WeatherSourceOptions,
): { games: WeatherGame[]; venues: Map<string, VenueReference>; warnings: string[] } {
  const warnings: string[] = [];
  const season = ctx.seasons[ctx.seasons.length - 1];
  const games: WeatherGame[] = [];
  const venues = new Map<string, VenueReference>();
  if (season === undefined) return { games, venues, warnings };
  const weeks: readonly Week[] | null = ctx.week === null ? null : [ctx.week];
  const candidates = (
    opts.games ? opts.games(ctx) : ctx.datasets.proSchedule.games(season, weeks).rows
  ).slice(0, MAX_WEATHER_GAMES);
  const abbrev = new Map<number, string>();
  for (const t of ctx.datasets.proSchedule.teams(season).rows) abbrev.set(t.id, t.abbrev);
  const now = ctx.clock.nowMs();
  const until = now + provider.horizonHours * 3_600_000;
  const seen = new Set<number>();
  const pending: { game: ProGame; gameId: string; kickoff: IsoInstant; venue: VenueReference }[] =
    [];
  for (const g of candidates) {
    if (seen.has(g.espn_game_id)) continue;
    seen.add(g.espn_game_id);
    if (g.start_time_tbd) continue;
    const kickoff = isoOrNull(g.kickoff);
    if (kickoff === null) continue;
    const k = Date.parse(kickoff);
    if (k < now - PAST_KICKOFF_GRACE_MS || k > until) continue;
    const away = espnAbbrevToNflverse(abbrev.get(g.away_pro_team_id));
    const home = espnAbbrevToNflverse(abbrev.get(g.home_pro_team_id));
    const gameId = nflverseGameId(g.season, g.week, away, home);
    if (gameId === null) {
      warnings.push(`no nflverse game id for ESPN game ${safeId(g.espn_game_id)}`);
      continue;
    }
    const venue = venueForGame(gameId, home);
    if (venue === null) {
      warnings.push(`no venue coordinates for game ${safeId(gameId)}`);
      continue;
    }
    if (provider.usOnly && venue.country !== "US") continue;
    pending.push({ game: g, gameId, kickoff, venue });
  }
  const roofs = roofsOf(
    ctx,
    pending.filter((p) => p.venue.retractable).map((p) => p.game.espn_game_id),
  );
  for (const p of pending) {
    if (!needsWeather(roofs.get(p.game.espn_game_id) ?? null, p.venue)) continue;
    venues.set(p.venue.stadium_id, p.venue);
    games.push(
      Object.freeze({
        game_id: p.gameId,
        espn_game_id: p.game.espn_game_id,
        season: p.game.season,
        week: p.game.week,
        venue_id: p.venue.stadium_id,
        lat: p.venue.lat,
        lon: p.venue.lon,
        kickoff_utc: p.kickoff,
      }),
    );
  }
  return { games, venues, warnings };
}

// --- temp file ------------------------------------------------------------------------------------------------

/** Reads and validates a weather temp file; throws on anything malformed. */
export async function readWeatherFile(
  path: string,
  expected: WeatherProviderKey,
): Promise<WeatherFile> {
  const st = await stat(path);
  if (!st.isFile() || st.size > MAX_WEATHER_FILE_BYTES)
    throw new Error("weather: temp file missing or too large");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (own(parsed, "format") !== WEATHER_FILE_FORMAT || own(parsed, "provider") !== expected)
    throw new Error("weather: temp file has the wrong format or provider");
  const fetched = isoOrNull(own(parsed, "fetched_at"));
  const games = own(parsed, "games");
  const responses = own(parsed, "responses");
  const warnings = own(parsed, "warnings");
  if (fetched === null || !Array.isArray(games) || !Array.isArray(responses))
    throw new Error("weather: temp file is incomplete");
  return {
    format: WEATHER_FILE_FORMAT,
    provider: expected,
    fetched_at: fetched,
    games: games as WeatherGame[],
    responses: responses as VenueResponse[],
    warnings: Array.isArray(warnings)
      ? warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}

/** The response body stored for a venue, or undefined. */
function bodyFor(file: WeatherFile, venueId: string): unknown {
  const r = file.responses.find((x) => own(x, "venue_id") === venueId);
  return r === undefined ? undefined : own(r, "body");
}

/** The rows a weather file yields (games whose response covers the kickoff hour), plus warnings. */
export function buildRows(
  file: WeatherFile,
  provider: WeatherProvider,
): { rows: DatasetRow[]; warnings: string[] } {
  const rows: DatasetRow[] = [];
  const warnings: string[] = [];
  for (const g of file.games) {
    const body = bodyFor(file, g.venue_id);
    if (body === undefined || body === null) {
      warnings.push(`no forecast for game ${safeId(g.game_id)} (venue fetch failed)`);
      continue;
    }
    const k = Date.parse(g.kickoff_utc);
    const f = Number.isFinite(k) ? provider.forecastAt(body, k) : null;
    if (f === null) {
      warnings.push(`no forecast hour covers the kickoff of game ${safeId(g.game_id)}`);
      continue;
    }
    rows.push(
      Object.freeze({
        game_id: g.game_id,
        espn_game_id: g.espn_game_id,
        season: g.season,
        week: g.week,
        venue_id: g.venue_id,
        lat: g.lat,
        lon: g.lon,
        kickoff_utc: g.kickoff_utc,
        forecast_hour_utc: new Date(f.hourStartMs).toISOString(),
        temp_f: f.temp_f,
        wind_mph: f.wind_mph,
        gust_mph: f.gust_mph,
        precip_prob: f.precip_prob,
        as_of: provider.issueTime(body) ?? file.fetched_at,
      }),
    );
  }
  return { rows, warnings };
}

/** The hour bucket `YYYY-MM-DDTHH` (UTC) of an instant — a time-bucket source's version. */
export function hourBucket(nowMs: number): string {
  return new Date(Math.floor(nowMs / 3_600_000) * 3_600_000).toISOString().slice(0, 13);
}

/**
 * Whether a venue failure is an upstream outage (offline, DNS, refused, 5xx, 429, timeout) rather
 * than a bad answer: before any venue succeeded, an outage fails the attempt (the runner retries a
 * retryable one) instead of publishing an empty table.
 */
function isOutage(e: unknown): boolean {
  return e instanceof HttpError && !POLICY_KINDS.has(e.kind) && e.kind !== "aborted";
}

/** Builds the DataSource for one provider. */
export function createWeatherSource(
  provider: WeatherProvider,
  opts: WeatherSourceOptions = {},
): DataSource {
  const info = SOURCE_REGISTRY[provider.id];
  return Object.freeze({
    id: provider.id,
    license: provider.license,
    attribution: info.attribution,
    freshness: info.freshness,
    job: info.job,
    limiter: provider.limiter,
    versioning: "time_bucket",
    seasonGate: "in_season",
    tables: Object.freeze([provider.table]),

    version(ctx: SourceContext): Promise<ReleaseVersion | null> {
      return Promise.resolve({ version: hourBucket(ctx.clock.nowMs()), released_at: null });
    },

    async fetch(_version: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> {
      const { games, venues, warnings } = selectGames(ctx, provider, opts);
      const responses: VenueResponse[] = [];
      let successes = 0;
      for (const venue of venues.values()) {
        if (ctx.signal.aborted) throw new HttpError({ kind: "aborted" });
        try {
          const body = await provider.fetchVenue(venue, ctx);
          if (body === undefined) {
            warnings.push(`venue ${venue.stadium_id}: response is not valid JSON`);
            responses.push({ venue_id: venue.stadium_id, body: null });
            continue;
          }
          successes++;
          responses.push({ venue_id: venue.stadium_id, body });
        } catch (e) {
          if (e instanceof HttpError && e.kind === "aborted") throw e;
          if (successes === 0 && isOutage(e)) throw e;
          const why = e instanceof HttpError ? e.kind : "invalid response";
          warnings.push(`venue ${venue.stadium_id}: ${why}`);
          responses.push({ venue_id: venue.stadium_id, body: null });
        }
      }
      const file: WeatherFile = {
        format: WEATHER_FILE_FORMAT,
        provider: provider.key,
        fetched_at: ctx.clock.nowIso(),
        games,
        responses,
        warnings,
      };
      const path = join(ctx.tempDir, `weather.${provider.key}.json`);
      const text = JSON.stringify(file);
      await writeFile(path, text, { mode: 0o600, flag: "wx" });
      return [{ path, bytes: Buffer.byteLength(text), season: null }];
    },

    async assertSchema(files: readonly TempFile[]): Promise<SchemaReport> {
      const bad = (warning: string, missing: readonly string[] = []): SchemaReport => ({
        ok: false,
        missing_columns: missing,
        extra_columns: [],
        bad_codecs: [],
        rows: 0,
        warnings: [warning],
      });
      const first = files[0];
      if (files.length !== 1 || first === undefined)
        return bad("expected exactly one weather file");
      let file: WeatherFile;
      try {
        file = await readWeatherFile(first.path, provider.key);
      } catch {
        return bad("the weather file is unreadable");
      }
      const usable = file.responses.filter(
        (r) => own(r, "body") !== null && own(r, "body") !== undefined,
      );
      const warnings = [...file.warnings];
      if (file.games.length > 0 && usable.length === 0)
        return {
          ...bad("no venue returned a usable forecast"),
          warnings: [...warnings, "no venue returned a usable forecast"],
        };
      const missing: string[] = [];
      for (const field of provider.requiredFields) {
        if (
          usable.length > 0 &&
          usable.every((r) => !provider.fieldsPresent(own(r, "body")).has(field))
        )
          missing.push(field);
      }
      for (const r of usable) {
        const present = provider.fieldsPresent(own(r, "body"));
        const gaps = provider.requiredFields.filter((f) => !present.has(f) && !missing.includes(f));
        if (gaps.length > 0)
          warnings.push(`venue ${safeId(own(r, "venue_id"))} lacks ${gaps.join(", ")} (nulls)`);
      }
      const built = buildRows(file, provider);
      return {
        ok: missing.length === 0,
        missing_columns: missing,
        extra_columns: [],
        bad_codecs: [],
        rows: built.rows.length,
        warnings: [...warnings, ...built.warnings],
      };
    },

    async publish(files: readonly TempFile[], into: DatasetWriter): Promise<PublishStats> {
      const first = files[0];
      if (first === undefined) throw new Error("weather: nothing to publish");
      const file = await readWeatherFile(first.path, provider.key);
      const { rows } = buildRows(file, provider);
      into.createTable(provider.table);
      const inserted = rows.length === 0 ? 0 : into.insert(provider.table.name, rows);
      const seasons = [...new Set(rows.map((r) => r.season as number))].sort((a, b) => a - b);
      return {
        rows: inserted,
        tables: [{ name: provider.table.name, rows: inserted }],
        seasons,
        columns_hash: columnsHash(provider.id),
      };
    },
  });
}
