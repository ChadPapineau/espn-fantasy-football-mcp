// cache.ts — the ESPN cache policy (plan 01 §5.3, §5.4, §5.2 classes): the canonical key (season,
// league, views in whitelist order, scoringPeriodId, canonical filter — two spellings of one request
// hit one entry), the freshness class per view (a composite takes its strictest member) and the
// immutable class an answer takes once the weeks it covers are past their correction window, the
// force_refresh gate (once per 60 s per key), in-process coalescing (N concurrent identical requests
// → one upstream call, each reader still bound by its own call's deadline and cancellation — plan 01
// §6), and the PII rule for what is stored (plan 02 §2.4: member names,
// notification settings and any `clientAddress` never enter the parsed cache; the raw body only in
// fixture-recording mode), and what outlives a process in the cache's own namespaces: the league's
// publicity (cachedPublicity), the settings invalidation marks (cachedSettingsMarks — plan 01 §5.2,
// plan 08 §9) and ESPN's Retry-After hold on the read host (cachedRetryAfter — plan 01 §6).
import {
  freshnessClass,
  type FreshnessClass,
  type FreshnessClassId,
} from "../../config/freshness.js";
import type { Clock } from "../../domain/clock.js";
import type { EspnCacheEntry, EspnCacheRepository } from "../../store/types.js";
import { FORCE_REFRESH_MIN_INTERVAL_MS } from "../platform.js";
import type { PublicityStore } from "./auth-gate.js";
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
 * The immutable class a view's answer takes once every scoring period it covers is past its 7-day
 * stat-correction window (plan 01 §5.4 "ESPN immutable (draft; final weeks past the correction
 * window)": fresh always, no hard limit; §5.2: mMatchup rows immutable 7 days after the week's last
 * game, the player card's weekly actuals immutable for weeks past the window). A view absent here
 * never turns immutable: rosters, the pool, standings and settings change whatever the week.
 */
export const FINAL_VIEW_FRESHNESS: Readonly<Partial<Record<EspnView, FreshnessClassId>>> =
  Object.freeze({
    mMatchup: "espn_matchups_final",
    mScoreboard: "espn_matchups_final",
    mMatchupScore: "espn_matchups_final",
    mBoxscore: "espn_matchups_final",
    kona_playercard: "espn_player_stats_final",
  });

/** The immutable class every view of a request shares once final, or null (some view never is). */
export function finalClassForViews(views: readonly EspnView[]): FreshnessClass | null {
  let id: FreshnessClassId | null = null;
  for (const v of views) {
    const c = FINAL_VIEW_FRESHNESS[v];
    if (c === undefined || (id !== null && c !== id)) return null;
    id = c;
  }
  return id === null ? null : freshnessClass(id);
}

/**
 * The espn_cache row a league's publicity is kept under (auth-gate.ts PublicityStore): not a
 * request's key — its own namespace — so no read ever serves it as a body.
 */
export function publicityKey(leagueId: string): string {
  return [`espn:v${String(CACHE_KEY_VERSION)}`, "publicity", leagueId].join("|");
}

/** How long a persisted publicity is trusted: a later process re-learns an older one (one read). */
export const PUBLICITY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * The league's publicity over the provider's cache (Stage C finding
 * espn-missing-season-404-not-cached): every process that learns `settings.isPublic` — from any
 * league body, or a keyless 401 — writes it here, and the next process reads it instead of sending
 * the anonymous mSettings read again. Best effort both ways: no row, a row older than
 * PUBLICITY_MAX_AGE_MS or an unreadable one reads as unknown (the read learns it once).
 */
export function cachedPublicity(
  cache: Pick<EspnCacheRepository, "get" | "put">,
  leagueId: string,
  clock: Pick<Clock, "nowMs" | "nowIso">,
): PublicityStore {
  const key = publicityKey(leagueId);
  return {
    load: () => {
      const e = cache.get(key);
      if (e === null) return null;
      const at = Date.parse(e.fetched_at);
      if (!Number.isFinite(at) || clock.nowMs() - at > PUBLICITY_MAX_AGE_MS) return null;
      const v = (JSON.parse(e.parsed_json) as { isPublic?: unknown } | null)?.isPublic;
      return typeof v === "boolean" ? v : null;
    },
    save: (isPublic) => {
      cache.put({
        key,
        parsed_json: JSON.stringify({ isPublic }),
        fetched_at: clock.nowIso(),
        server_time: null,
        etag: null,
        http_status: 200,
        raw_body: null,
      });
    },
  };
}

/** The espn_cache row a league's board-probe control is kept under (its own namespace, like publicity). */
export function boardControlKey(leagueId: string, season: number): string {
  return [`espn:v${String(CACHE_KEY_VERSION)}`, "board_control", leagueId, String(season)].join(
    "|",
  );
}

/** A kept yes/no fact about the league (absent, too old or unreadable reads as null). */
export interface KeptFlag {
  load(): boolean | null;
  save(v: boolean): void;
}

/**
 * Whether the league's board probe discriminates — its ANONYMOUS control answered 401 (plan 02
 * §2.1, ADV OBJ-26) — kept over the provider's cache for a league whose credential_state row holds
 * no setup control (`board_probe_discriminates` null: setup ran while the league was private, or the
 * row was recreated after a wiped cache): learned once by a probe and then read, never re-sent
 * before every probe (plan 03 §2.1 step 5 "cached with the league settings"; plan 06 §1.4 "exactly
 * one probe per run"; Stage C finding auth-probe-definitive-plan-unwired). Best effort both ways
 * (never throws); trusted for PUBLICITY_MAX_AGE_MS, like the publicity, so a board that changes is
 * re-learned within a week.
 */
export function cachedBoardControl(
  cache: Pick<EspnCacheRepository, "get" | "put">,
  leagueId: string,
  season: number,
  clock: Pick<Clock, "nowMs" | "nowIso">,
): KeptFlag {
  const key = boardControlKey(leagueId, season);
  return {
    load: () => {
      try {
        const e = cache.get(key);
        if (e === null) return null;
        const at = Date.parse(e.fetched_at);
        if (!Number.isFinite(at) || clock.nowMs() - at > PUBLICITY_MAX_AGE_MS) return null;
        const v = (JSON.parse(e.parsed_json) as { discriminates?: unknown } | null)?.discriminates;
        return typeof v === "boolean" ? v : null;
      } catch {
        return null;
      }
    },
    save: (discriminates) => {
      try {
        cache.put({
          key,
          parsed_json: JSON.stringify({ discriminates }),
          fetched_at: clock.nowIso(),
          server_time: null,
          etag: null,
          http_status: 200,
          raw_body: null,
        });
      } catch {
        // unwritten: the next probe learns it again (one anonymous request)
      }
    },
  };
}

/** A non-negative finite number, else null (what a kept row or a body's status field may hold). */
function instant(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** A league answer's status instants (epoch ms, ESPN's clock — research 03 §A.4), or nulls. */
export interface StatusInstants {
  /** `status.standingsUpdateDate`. */
  readonly standings_ms: number | null;
  /** `status.waiverLastExecutionDate`. */
  readonly waivers_ms: number | null;
}

/** The status instants a body carries (`status.standingsUpdateDate` / `waiverLastExecutionDate`). */
export function statusInstantsOf(body: unknown): StatusInstants {
  const s =
    typeof body === "object" && body !== null ? (body as { status?: unknown }).status : undefined;
  if (typeof s !== "object" || s === null) return { standings_ms: null, waivers_ms: null };
  const st = s as { standingsUpdateDate?: unknown; waiverLastExecutionDate?: unknown };
  return {
    standings_ms: instant(st.standingsUpdateDate),
    waivers_ms: instant(st.waiverLastExecutionDate),
  };
}

/**
 * What invalidates a league-season's cached settings before their 24 h TTL (plan 01 §5.2 "League
 * settings" row: `status.standingsUpdateDate` / `waiverLastExecutionDate` change, a scoring golden
 * mismatch; plan 08 §9: the E6 > 10 % rule, `eff refresh espn:settings`): the newest status instants
 * any league answer carried (ESPN's clock), when they were last seen to move (our clock), and the
 * last explicit invalidation (our clock).
 */
export interface SettingsMarks extends StatusInstants {
  readonly moved_at_ms: number | null;
  readonly dirty_at_ms: number | null;
}

/** The kept marks of one league-season (best effort both ways: never throws). */
export interface SettingsMarksStore {
  load(): SettingsMarks | null;
  /** Records the status instants of a league answer fetched at `atMs`; a later one moves the marks. */
  observe(status: StatusInstants, atMs: number): void;
  /** Marks every settings answer fetched before `atMs` outdated (an explicit invalidation). */
  invalidate(atMs: number): void;
}

/** The espn_cache row a league-season's observed status instants are kept under (own namespace). */
export function settingsMarksKey(leagueId: string, season: number): string {
  return [`espn:v${String(CACHE_KEY_VERSION)}`, "settings_marks", leagueId, String(season)].join(
    "|",
  );
}

/** The espn_cache row a league-season's explicit settings invalidation is kept under. */
export function settingsDirtyKey(leagueId: string, season: number): string {
  return [`espn:v${String(CACHE_KEY_VERSION)}`, "settings_dirty", leagueId, String(season)].join(
    "|",
  );
}

/** A kept row's JSON object: absent or unreadable JSON → `v: null`; a store that throws → `ok: false`. */
type KeptRow =
  { readonly ok: true; readonly v: Record<string, unknown> | null } | { readonly ok: false };

function keptRow(cache: Pick<EspnCacheRepository, "get">, key: string): KeptRow {
  let e: EspnCacheEntry | null;
  try {
    e = cache.get(key);
  } catch {
    return { ok: false };
  }
  if (e === null) return { ok: true, v: null };
  try {
    const v = JSON.parse(e.parsed_json) as unknown;
    return {
      ok: true,
      v: typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null,
    };
  } catch {
    return { ok: true, v: null };
  }
}

/**
 * The settings marks of a league-season over the provider's cache, shared by every process that
 * reads the league (the server, the jobs, the CLI): two small rows, written only when an instant
 * moves or an invalidation is asked — never per read. The observed instants and the explicit
 * invalidation are kept apart, so neither write can undo the other, in this process or another one
 * (a read-then-write of one shared row let a status observation erase an invalidation another
 * process had just kept). A store that cannot be read writes nothing for an observation (the next
 * answer that carries the move writes it) and reads as none; an unreadable row reads as none and the
 * next write replaces it.
 */
export function cachedSettingsMarks(
  cache: Pick<EspnCacheRepository, "get" | "put">,
  leagueId: string,
  season: number,
  clock: Pick<Clock, "nowIso">,
): SettingsMarksStore {
  const marksKey = settingsMarksKey(leagueId, season);
  const dirtyKey = settingsDirtyKey(leagueId, season);
  const save = (key: string, v: Record<string, number | null>): void => {
    try {
      cache.put({
        key,
        parsed_json: JSON.stringify(v),
        fetched_at: clock.nowIso(),
        server_time: null,
        etag: null,
        http_status: 200,
        raw_body: null,
      });
    } catch {
      // unwritten: the next answer that carries the move (or the next invalidation) writes it
    }
  };
  const later = (seen: number | null, kept: number | null): boolean =>
    seen !== null && (kept === null || seen > kept);
  const max = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);
  return {
    load: () => {
      const m = keptRow(cache, marksKey);
      const d = keptRow(cache, dirtyKey);
      const marks = m.ok ? m.v : null;
      const dirty = d.ok ? d.v : null;
      if (marks === null && dirty === null) return null;
      return {
        standings_ms: instant(marks?.standings_ms),
        waivers_ms: instant(marks?.waivers_ms),
        moved_at_ms: instant(marks?.moved_at_ms),
        dirty_at_ms: instant(dirty?.dirty_at_ms),
      };
    },
    observe: (status, atMs) => {
      if (!Number.isFinite(atMs)) return;
      const row = keptRow(cache, marksKey);
      if (!row.ok) return;
      const keptStandings = instant(row.v?.standings_ms);
      const keptWaivers = instant(row.v?.waivers_ms);
      if (!later(status.standings_ms, keptStandings) && !later(status.waivers_ms, keptWaivers))
        return;
      save(marksKey, {
        standings_ms: max(status.standings_ms, keptStandings),
        waivers_ms: max(status.waivers_ms, keptWaivers),
        moved_at_ms: max(atMs, instant(row.v?.moved_at_ms)),
      });
    },
    invalidate: (atMs) => {
      if (!Number.isFinite(atMs)) return;
      const row = keptRow(cache, dirtyKey);
      save(dirtyKey, { dirty_at_ms: max(atMs, row.ok ? instant(row.v?.dirty_at_ms) : null) });
    },
  };
}

/**
 * Whether a cached settings answer, fresh by its TTL, is outdated by the marks: an explicit
 * invalidation came after it was fetched, or a status instant newer than the one it carries was seen
 * to move after it was fetched. A move outdates each earlier answer ONCE: an answer fetched after the
 * move is kept whatever instant it carries, so a lagging body can never make every read refetch.
 */
export function settingsOutdated(
  marks: SettingsMarks | null,
  carried: StatusInstants,
  fetchedAtMs: number,
): boolean {
  if (marks === null || !Number.isFinite(fetchedAtMs)) return false;
  if (marks.dirty_at_ms !== null && fetchedAtMs < marks.dirty_at_ms) return true;
  if (marks.moved_at_ms === null || fetchedAtMs >= marks.moved_at_ms) return false;
  const newer = (seen: number | null, own: number | null): boolean =>
    seen !== null && (own === null || seen > own);
  return (
    newer(marks.standings_ms, carried.standings_ms) || newer(marks.waivers_ms, carried.waivers_ms)
  );
}

/** The espn_cache row the read host's Retry-After hold is kept under (its own namespace). */
export function retryAfterKey(host: string): string {
  return [`espn:v${String(CACHE_KEY_VERSION)}`, "retry_after", host].join("|");
}

/** An instant kept across processes (absent, unreadable or invalid reads as null; never throws). */
export interface KeptInstant {
  load(): number | null;
  /** Keeps `ms` when it is later than the kept one. */
  save(ms: number): void;
}

/**
 * ESPN's Retry-After on the read host, kept over the provider's cache (Stage C finding
 * espn-retry-after-not-persisted): the instant before which no request goes to the host, honoured by
 * every process that reads it — not only the read that received the hint (plan 01 §6 "honour
 * Retry-After if it ever appears"; the limiter is "shared by every tool and every process").
 */
export function cachedRetryAfter(
  cache: Pick<EspnCacheRepository, "get" | "put">,
  host: string,
  clock: Pick<Clock, "nowIso">,
): KeptInstant {
  const key = retryAfterKey(host);
  const load = (): number | null => {
    try {
      const e = cache.get(key);
      if (e === null) return null;
      return instant((JSON.parse(e.parsed_json) as { until_ms?: unknown } | null)?.until_ms);
    } catch {
      return null;
    }
  };
  return {
    load,
    save: (ms) => {
      if (!Number.isFinite(ms)) return;
      const kept = load();
      if (kept !== null && kept >= ms) return;
      try {
        cache.put({
          key,
          parsed_json: JSON.stringify({ until_ms: ms }),
          fetched_at: clock.nowIso(),
          server_time: null,
          etag: null,
          http_status: 200,
          raw_body: null,
        });
      } catch {
        // unwritten: this process still holds off (its own instant); another one may send once
      }
    },
  };
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

/** One reader of a coalesced run: its own call's deadline and cancellation (plan 01 §6). */
export interface CoalesceParty {
  /** Epoch ms past which this reader no longer waits (its call's ≤ 20 s deadline, ADV OBJ-20). */
  readonly deadlineAtMs: number;
  /** This reader's cancellation (its call's budget signal), or null. */
  readonly signal: AbortSignal | null;
}

/** What a coalesced run's work reads at EVERY step (never once): the union of its readers' limits. */
export interface SharedLimits {
  /** Aborts once every reader has stopped waiting (cancelled, or past its own deadline). */
  readonly signal: AbortSignal;
  /** The latest deadline among the readers still waiting; −∞ once none is. */
  deadline(): number;
  /** Whether a request or a retry may start at `atMs`: some reader still waits and has the time. */
  canStart(atMs: number): boolean;
}

/** Why a reader stopped waiting before the shared run settled. */
export type LeaveReason = "aborted" | "deadline";

/** A settled run (or a reader's own leave), carried as a value: one reader's promise unwraps it. */
type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** A reader's promise: the value, or the outcome's error thrown as is. */
function unwrap<T>(p: Promise<Outcome<T>>): Promise<T> {
  return p.then((o) => {
    if (o.ok) return o.value;
    throw o.error;
  });
}

/** One waiting reader. */
interface Waiter {
  readonly party: CoalesceParty;
  timer: ReturnType<typeof setTimeout> | null;
  /** Stops this reader's wait (its promise rejects with the leave error). */
  readonly leave: (why: LeaveReason) => void;
}

/** One shared run: its readers, its abort and its outcome. */
class SharedRun<T> implements SharedLimits {
  readonly waiters = new Set<Waiter>();
  settled = false;
  private readonly controller = new AbortController();
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  deadline(): number {
    let d = Number.NEGATIVE_INFINITY;
    for (const w of this.waiters) if (w.party.deadlineAtMs > d) d = w.party.deadlineAtMs;
    return d;
  }
  canStart(atMs: number): boolean {
    return !this.controller.signal.aborted && Number.isFinite(atMs) && atMs < this.deadline();
  }
  abort(): void {
    this.controller.abort();
  }
  /** Set once by `Coalescer.run`, before any reader can observe it; never rejects. */
  outcome!: Promise<Outcome<T>>;
}

/**
 * In-process single flight (plan 01 §5.3: two concurrent calls for one key make one request) that
 * never lends one call's limits to another (Stage C finding espn-coalesced-read-leader-budget: the
 * shared read ran under the FIRST caller's budget, so cancelling that call, or that call being near
 * its deadline, failed a parallel call that was never cancelled). The shared run reads the union of
 * its readers' limits (`SharedLimits`): it is aborted only once every reader has stopped waiting, and
 * no request or retry starts past the latest deadline of the readers still waiting. Each reader
 * stops waiting at its OWN cancellation or deadline — its promise rejects with `leaveError(why)`
 * while the run goes on for the others. A reader's deadline timer is armed only while the run may
 * outlive it (a reader with a later deadline is waiting too), so a lone reader is bounded by the
 * run's own timing exactly as before; the timers are unreferenced and cleared when the wait ends.
 */
export class Coalescer<T> {
  private readonly inflight = new Map<string, SharedRun<T>>();
  private readonly nowMs: () => number;
  constructor(nowMs: () => number = Date.now) {
    this.nowMs = nowMs;
  }
  /** Runs in flight now. */
  get size(): number {
    return this.inflight.size;
  }
  /** Whether a run for `key` is in flight (a reader would join it, not start one). */
  has(key: string): boolean {
    return this.inflight.has(key);
  }
  /**
   * Joins the in-flight run for `key` as `party`, or starts `start` (which reads the shared limits);
   * `joined` says which. The promise settles with the run's outcome, or rejects with
   * `leaveError(why)` once `party` stops waiting first. A party whose signal has already aborted
   * starts and joins nothing.
   */
  run(
    key: string,
    party: CoalesceParty,
    start: (limits: SharedLimits) => Promise<T>,
    leaveError: (why: LeaveReason) => unknown,
  ): { readonly promise: Promise<T>; readonly joined: boolean } {
    const existing = this.inflight.get(key);
    if (party.signal?.aborted === true)
      return {
        promise: unwrap(Promise.resolve({ ok: false, error: leaveError("aborted") })),
        joined: existing !== undefined,
      };
    if (existing !== undefined)
      return { promise: unwrap(this.wait(key, existing, party, leaveError)), joined: true };
    const run = new SharedRun<T>();
    this.inflight.set(key, run);
    // the reader joins before the work starts: the work reads limits that include it
    let release!: (p: Promise<Outcome<T>>) => void;
    run.outcome = new Promise<Outcome<T>>((resolve) => {
      release = (p) => {
        resolve(p);
      };
    });
    const promise = unwrap(this.wait(key, run, party, leaveError));
    // a synchronous throw from `start` settles the run like a rejection
    const work = (async (): Promise<T> => start(run))();
    release(
      work
        .then(
          (value): Outcome<T> => ({ ok: true, value }),
          (error: unknown): Outcome<T> => ({ ok: false, error }),
        )
        .finally(() => {
          run.settled = true;
          if (this.inflight.get(key) === run) this.inflight.delete(key);
        }),
    );
    return { promise, joined: false };
  }

  /** One reader's wait: the run's outcome, or this reader's own leave — whichever comes first. */
  private wait(
    key: string,
    run: SharedRun<T>,
    party: CoalesceParty,
    leaveError: (why: LeaveReason) => unknown,
  ): Promise<Outcome<T>> {
    return new Promise<Outcome<T>>((resolve) => {
      const inflight = this.inflight;
      let done = false;
      const w: Waiter = { party, timer: null, leave };
      function end(o: Outcome<T>): void {
        done = true;
        if (w.timer !== null) clearTimeout(w.timer);
        w.timer = null;
        party.signal?.removeEventListener("abort", onAbort);
        run.waiters.delete(w);
        resolve(o);
      }
      function leave(why: LeaveReason): void {
        if (done) return;
        end({ ok: false, error: leaveError(why) });
        // the last reader gone: the run stops, and a later reader starts a run of its own
        if (!run.settled && run.waiters.size === 0) {
          run.abort();
          if (inflight.get(key) === run) inflight.delete(key);
        }
      }
      function onAbort(): void {
        leave("aborted");
      }
      run.waiters.add(w);
      party.signal?.addEventListener("abort", onAbort, { once: true });
      void run.outcome.then((o) => {
        if (!done) end(o);
      });
      // every reader whose deadline is now earlier than the run's gets a timer of its own
      for (const x of run.waiters) this.arm(x, run);
    });
  }

  /** Arms `w`'s own deadline timer when the run may outlive it (once; cleared when its wait ends). */
  private arm(w: Waiter, run: SharedRun<T>): void {
    if (w.timer !== null || !(run.deadline() > w.party.deadlineAtMs)) return;
    const t = setTimeout(
      () => {
        w.leave("deadline");
      },
      Math.max(0, w.party.deadlineAtMs - this.nowMs()),
    );
    t.unref();
    w.timer = t;
  }
}

/** Parses `x-fantasy-server-time` (RFC 1123, UTC) to ISO; null when absent or unparseable. */
export function serverTimeIso(header: string | undefined): string | null {
  if (header === undefined || header.length > 64) return null;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
