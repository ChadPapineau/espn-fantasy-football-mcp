// caches.ts — the best-effort cache tables (plan 01 §5.3 the ESPN cache: parsed object, fetched_at,
// server time, weak ETag, status; the raw body ONLY in fixture-recording mode; plan 08 §9
// points_cache, a bounded LRU by last write). Every write waits at most BEST_EFFORT_BUSY_MS; a busy
// lock is a counted miss, never an error. Reads never write (plan 03 §1.2).
import type { BestEffortOutcome } from "../../domain/analytics/types.js";
import type { IsoInstant } from "../../domain/league/types.js";
import type { EspnCacheEntry, EspnCacheRepository, PointsCacheRepository } from "../types.js";
import { intIn, isoMs, isoMsOrNull, keyString, num, type RepoDeps } from "./common.js";

/** Longest cache key (season + league + views + period + canonical filter JSON). */
export const ESPN_CACHE_KEY_MAX = 4096;
/** Largest parsed object stored (a parsed whole-league roster is ~50 KB; 8 MB is the body cap). */
export const ESPN_CACHE_PARSED_MAX = 16 * 1024 * 1024;
/** Largest raw body kept in recording mode (plan 05 §4.1 oversized-body cap is 8 MB). */
export const ESPN_CACHE_RAW_MAX = 16 * 1024 * 1024;
/** Longest weak ETag kept. */
export const ETAG_MAX = 512;
/** Longest points_cache key part and result. */
export const POINTS_KEY_MAX = 128;
export const POINTS_RESULT_MAX = 1024 * 1024;

interface CacheRow {
  key: string;
  parsed_json: string;
  fetched_at: string;
  server_time: string | null;
  etag: string | null;
  http_status: number;
  raw_body: string | null;
}

function checkEntry(e: EspnCacheEntry): number {
  keyString(e.key, "cache key", ESPN_CACHE_KEY_MAX);
  if (typeof e.parsed_json !== "string" || e.parsed_json.length > ESPN_CACHE_PARSED_MAX)
    throw new RangeError("store: parsed_json must be a string of bounded size");
  const ms = isoMs(e.fetched_at, "fetched_at");
  isoMsOrNull(e.server_time, "server_time");
  if (e.etag !== null) keyString(e.etag, "etag", ETAG_MAX);
  intIn(e.http_status, 100, 599, "http_status");
  if (
    e.raw_body !== null &&
    (typeof e.raw_body !== "string" || e.raw_body.length > ESPN_CACHE_RAW_MAX)
  )
    throw new RangeError("store: raw_body must be a string of bounded size");
  return ms;
}

export function espnCacheRepository(deps: RepoDeps): EspnCacheRepository {
  const { db, writes } = deps;
  return {
    get(key) {
      if (typeof key !== "string" || key.length === 0 || key.length > ESPN_CACHE_KEY_MAX)
        return null;
      const r = db
        .prepare(
          "SELECT key, parsed_json, fetched_at, server_time, etag, http_status, raw_body FROM espn_cache WHERE key = ?",
        )
        .get(key) as CacheRow | undefined;
      if (r === undefined) return null;
      return {
        key: r.key,
        parsed_json: r.parsed_json,
        fetched_at: r.fetched_at,
        server_time: r.server_time,
        etag: r.etag,
        http_status: num(r.http_status),
        raw_body: r.raw_body,
      };
    },
    put(e): BestEffortOutcome {
      const ms = checkEntry(e);
      // Plan 01 §5.3: raw ESPN bodies carry GUIDs, names and an IP — kept only when recording.
      const raw = deps.recordRawBodies ? e.raw_body : null;
      return writes.bestEffort(() => {
        db.prepare(
          `INSERT OR REPLACE INTO espn_cache (key, parsed_json, fetched_at, fetched_ms, server_time, etag, http_status, raw_body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(e.key, e.parsed_json, e.fetched_at, ms, e.server_time, e.etag, e.http_status, raw);
      });
    },
    prune(before: IsoInstant) {
      const ms = isoMs(before, "before");
      return writes.required("espn_cache", () =>
        Number(db.prepare("DELETE FROM espn_cache WHERE fetched_ms < ?").run(ms).changes),
      );
    },
  };
}

export function pointsCacheRepository(deps: RepoDeps): PointsCacheRepository {
  const { db, writes, clock } = deps;
  return {
    get(lineHash, settingsHash) {
      if (typeof lineHash !== "string" || typeof settingsHash !== "string") return null;
      const r = db
        .prepare("SELECT result_json FROM points_cache WHERE line_hash = ? AND settings_hash = ?")
        .get(lineHash, settingsHash) as { result_json: string } | undefined;
      return r?.result_json ?? null;
    },
    put(lineHash, settingsHash, resultJson) {
      keyString(lineHash, "line_hash", POINTS_KEY_MAX);
      keyString(settingsHash, "settings_hash", POINTS_KEY_MAX);
      if (typeof resultJson !== "string" || resultJson.length > POINTS_RESULT_MAX)
        throw new RangeError("store: result_json must be a string of bounded size");
      const used = clock.nowMs();
      return writes.bestEffort(() => {
        db.prepare(
          "INSERT OR REPLACE INTO points_cache (line_hash, settings_hash, result_json, used_ms) VALUES (?, ?, ?, ?)",
        ).run(lineHash, settingsHash, resultJson, used);
      });
    },
  };
}
