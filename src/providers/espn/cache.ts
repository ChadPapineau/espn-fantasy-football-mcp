// cache.ts — the ESPN cache policy (plan 01 §5.3, §5.4, §5.2 classes): the canonical key (season,
// league, views in whitelist order, scoringPeriodId, canonical filter — two spellings of one request
// hit one entry), the freshness class per view (a composite takes its strictest member), the
// force_refresh gate (once per 60 s per key), in-process coalescing (N concurrent identical requests
// → one upstream call), and the PII rule for what is stored (plan 02 §2.4: member names,
// notification settings and any `clientAddress` never enter the parsed cache; the raw body only in
// fixture-recording mode).
import {
  freshnessClass,
  type FreshnessClass,
  type FreshnessClassId,
} from "../../config/freshness.js";
import { FORCE_REFRESH_MIN_INTERVAL_MS } from "../platform.js";
import type { EspnTarget } from "./path.js";
import type { EspnView } from "./types.js";

/** The cache key format version (a change re-keys every entry). */
export const CACHE_KEY_VERSION = 1;

/** The freshness class of each view (plan 01 §5.2). */
export const VIEW_FRESHNESS: Readonly<Record<EspnView, FreshnessClassId>> = Object.freeze({
  mSettings: "espn_settings",
  mNav: "espn_settings",
  mTeam: "espn_standings",
  mStandings: "espn_standings",
  mRoster: "espn_roster",
  mMatchup: "espn_matchups",
  mScoreboard: "espn_matchups",
  mMatchupScore: "espn_live",
  mBoxscore: "espn_live",
  mDraftDetail: "espn_draft",
  mTransactions2: "espn_transactions",
  mPendingTransactions: "espn_transactions",
  mPositionalRatings: "espn_positional_ratings",
  kona_player_info: "espn_pool",
  kona_playercard: "espn_player_card",
  kona_league_communication: "espn_transactions",
  proTeamSchedules_wl: "espn_pro_schedule",
  players_wl: "espn_players",
});

/** Views never cached (the board probe's body is discarded — plan 02 §2.1). */
export const UNCACHED_VIEWS: readonly EspnView[] = Object.freeze(["kona_league_communication"]);

/** The class a request's views share: the one with the smallest fresh TTL (ties: the first). */
export function classForViews(views: readonly EspnView[]): FreshnessClass {
  let best: FreshnessClass | null = null;
  for (const v of views) {
    const c = freshnessClass(VIEW_FRESHNESS[v]);
    const ttl = c.ttlSeconds ?? Number.POSITIVE_INFINITY;
    const bestTtl =
      best === null ? Number.POSITIVE_INFINITY : (best.ttlSeconds ?? Number.POSITIVE_INFINITY);
    if (best === null || ttl < bestTtl) best = c;
  }
  if (best === null) throw new RangeError("cache: no views");
  return best;
}

/**
 * The canonical cache key of a request (plan 01 §5.3): route, season, league (or `-`), views in
 * whitelist order, scoringPeriodId, and the canonical filter string.
 */
export function cacheKey(
  target: EspnTarget,
  leagueId: string | null,
  filter: string | null,
): string {
  return [
    `espn:v${String(CACHE_KEY_VERSION)}`,
    target.route,
    String(target.season),
    leagueId ?? "-",
    target.views.join(","),
    target.scoringPeriodId === null ? "sp=-" : `sp=${String(target.scoringPeriodId)}`,
    `f=${filter ?? "-"}`,
  ].join("|");
}

/** Member keys dropped before a body is cached (plan 02 §2.4; plan 07 legend: no member names). */
const MEMBER_DROPPED_KEYS: ReadonlySet<string> = new Set([
  "displayName",
  "firstName",
  "lastName",
  "notificationSettings",
]);
/** Keys dropped wherever they appear (an IP and its wrapper; notification settings). */
const ANYWHERE_DROPPED_KEYS: ReadonlySet<string> = new Set([
  "clientAddress",
  "lastUpdateInfo",
  "notificationSettings",
]);
/** Nesting deeper than this is cut (a hostile body cannot recurse the walk). */
const MAX_STRIP_DEPTH = 40;

/**
 * A copy of a parsed body safe to persist: `members[]` keep only non-name fields (ids — needed for
 * own-team resolution — and flags), every `clientAddress` / `lastUpdateInfo` /
 * `notificationSettings` removed, `__proto__` never copied. Team names and outlooks stay: the
 * normaliser wraps them on every read.
 */
export function stripForCache(body: unknown): unknown {
  const walk = (v: unknown, depth: number, inMembers: boolean): unknown => {
    if (depth > MAX_STRIP_DEPTH) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, inMembers));
    if (typeof v !== "object" || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "__proto__" || ANYWHERE_DROPPED_KEYS.has(k)) continue;
      if (inMembers && MEMBER_DROPPED_KEYS.has(k)) continue;
      Object.defineProperty(out, k, {
        value: walk(x, depth + 1, k === "members"),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  return walk(body, 0, false);
}

/** The force_refresh gate: honoured at most once per 60 s per key (plan 01 §5.3). */
export class ForceRefreshGate {
  private readonly last = new Map<string, number>();
  /** Whether a force_refresh at `nowMs` is honoured (and records it when it is). */
  allow(key: string, nowMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < FORCE_REFRESH_MIN_INTERVAL_MS) return false;
    this.last.set(key, nowMs);
    if (this.last.size > 4096) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    return true;
  }
}

/** In-process single flight: concurrent identical requests share one promise (plan 01 §5.3). */
export class Coalescer<T> {
  private readonly inflight = new Map<string, Promise<T>>();
  /** Calls in flight now. */
  get size(): number {
    return this.inflight.size;
  }
  /** Joins the in-flight call for `key`, or starts `run`; `joined` says which. */
  run(
    key: string,
    run: () => Promise<T>,
  ): { readonly promise: Promise<T>; readonly joined: boolean } {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return { promise: existing, joined: true };
    const p = run().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return { promise: p, joined: false };
  }
}

/** Parses `x-fantasy-server-time` (RFC 1123, UTC) to ISO; null when absent or unparseable. */
export function serverTimeIso(header: string | undefined): string | null {
  if (header === undefined || header.length > 64) return null;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
