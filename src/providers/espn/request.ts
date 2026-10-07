// request.ts — the read pipeline every provider method goes through (plan 01 §5.3 cache-first, §5.6
// the per-call budget, §6 limiter/backoff/breaker/deadline, §7 in-call drift; plan 02 §2.1 the
// credential rules): cache → (fresh: done) → breaker → budget → coalesce → cookie decision →
// limiter → attempts (429/5xx/timeouts retried with jitter inside the ≤ 20 s deadline; 400/401/403/
// 404 and fail-fast network codes never) → classify → JSON → drift + schema → cache write. A failure
// falls back to the cached entry within its hard limit (`degraded`), or past it under `allow_stale`
// or while the host is moved; never an upstream body in any error.
import {
  serveDecision,
  stampState,
  DEFAULT_TTL_CONTEXT,
  type FreshnessClass,
  type TtlContext,
} from "../../config/freshness.js";
import type { RequestOutcome } from "../../config/schema.js";
import type { CredentialAuthority, CredentialObserver } from "../../auth/types.js";
import type { Clock } from "../../domain/clock.js";
import {
  DEGRADED_CODES,
  type CacheOutcome,
  type DegradedCode,
  type DegradedRead,
  type PlatformStamp,
} from "../../domain/league/types.js";
import { checkResponse, failsResponse } from "../../drift/detect.js";
import { errorPath } from "../../drift/pattern.js";
import { DriftStateWriter, driftMetaFor } from "../../drift/state.js";
import type { DriftObservations, DriftSignal } from "../../drift/types.js";
import type {
  DriftStateRepository,
  EspnCacheEntry,
  EspnCacheRepository,
  LimiterRepository,
  RequestOrigin,
} from "../../store/types.js";
import {
  ATTEMPT_TIMEOUT_MS,
  PER_CALL_DEADLINE_MS,
  UpstreamBudgetExhausted,
  type ReadOptions,
} from "../platform.js";
import {
  cacheKey,
  classForViews,
  Coalescer,
  ForceRefreshGate,
  serverTimeIso,
  stripForCache,
  UNCACHED_VIEWS,
} from "./cache.js";
import { classifyAnswer, EspnDriftError, EspnUpstreamError } from "./errors.js";
import { backoffMs, EspnBreakerOpenError, EspnLimiter, realSleep, type Sleep } from "./limiter.js";
import { primaryView, type EspnTarget } from "./path.js";
import { sendAttempt, type AttemptAnswer, type FetchLike } from "./transport.js";
import { CookieGate, type CookieUse } from "./auth-gate.js";
import { ESPN_BACKOFF } from "../../config/schema.js";
import type { EspnView } from "./types.js";

/** Thrown inside a parse function when the body does not match a view schema (internal). */
export class SchemaSignals extends Error {
  readonly signals: readonly DriftSignal[];
  constructor(signals: readonly DriftSignal[]) {
    super("espn: schema mismatch");
    this.name = "SchemaSignals";
    this.signals = signals;
  }
}

/** A stale-only answer: only data past its hard limit exists (plan 01 §4.3 STALE_ONLY). */
export class EspnStaleOnlyError extends Error {
  readonly effCode = "STALE_ONLY" as const;
  readonly effDetails: { readonly view: EspnView };
  constructor(view: EspnView) {
    super("espn: only data past its hard limit is cached");
    this.name = "EspnStaleOnlyError";
    this.effDetails = Object.freeze({ view });
  }
}

/** A provider-side refusal that is a programming error (a league ref that is not the configured one). */
export class EspnProviderError extends Error {
  readonly effCode: "INTERNAL" | "NOT_FOUND" | "VALIDATION";
  readonly effDetails: { readonly reason: string };
  constructor(effCode: "INTERNAL" | "NOT_FOUND" | "VALIDATION", reason: string) {
    super(`espn provider: ${reason}`);
    this.name = "EspnProviderError";
    this.effCode = effCode;
    this.effDetails = Object.freeze({ reason });
  }
}

/** A logger surface (src/cli/log.ts `Logger` satisfies it); fields are ids and vocabulary only. */
export interface ProviderLog {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** What the pipeline needs, injected. */
export interface RequestDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly limiter: LimiterRepository;
  readonly cache: EspnCacheRepository;
  readonly driftState: DriftStateRepository;
  readonly credentials: CredentialAuthority | null;
  readonly host: string;
  readonly origin: RequestOrigin;
  readonly observer: CredentialObserver;
  readonly recordRawBodies: boolean;
  readonly observations?: DriftObservations;
  readonly ttlContext?: () => TtlContext;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly log?: ProviderLog;
  readonly attemptTimeoutMs?: number;
}

/** One read: the request, its cookie rule and the typed parse of its body. */
export interface ReadSpec<T> {
  readonly target: EspnTarget;
  readonly filter: string | null;
  /** The league id in the cache key (null for season routes). */
  readonly leagueId: string | null;
  readonly cookies: CookieUse;
  /** Parses a validated body; throws SchemaSignals when a view schema fails. */
  readonly parse: (body: unknown) => T;
  /** The stamp's provisional flag for this read (from the parsed value). */
  readonly provisional?: (value: T) => boolean;
  /** The stamp source (`espn:<view>` by default). */
  readonly source?: string;
}

/** A read's value, its stamp, and the response headers it came with (count headers). */
export interface ReadResult<T> {
  readonly value: T;
  readonly stamp: PlatformStamp;
  readonly headers: Readonly<Record<string, string>>;
}

interface Fresh {
  readonly body: unknown;
  /** The fetching spec's parse of `body` and the parse function that made it (reused when equal). */
  readonly parsed: unknown;
  readonly parsedBy: ((body: unknown) => unknown) | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchedAt: string;
  readonly serverTime: string | null;
  readonly cache: CacheOutcome;
}

/** A cached body longer than this yields to the event loop before it is parsed (see `read`). */
export const YIELD_BEFORE_PARSE_CHARS = 64 * 1024;

/** Parsed cache bodies kept per parse function (see `parseCached`). */
export const PARSED_MEMO_MAX = 16;

/**
 * Freezes a parsed body in place, every nested object and array (iterative — no recursion limit):
 * a memoised value is shared by every later read of the same stored entry, so a consumer that
 * tried to change it would throw instead of corrupting the next read.
 */
export function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== "object" || v === null || Object.isFrozen(v)) continue;
    Object.freeze(v);
    for (const x of Object.values(v)) if (typeof x === "object" && x !== null) stack.push(x);
  }
  return value;
}

/** What identifies one stored version of a cache entry for the parse memo. */
function memoStamp(e: EspnCacheEntry): string {
  return `${e.fetched_at}|${e.etag ?? ""}|${String(e.parsed_json.length)}`;
}

/** Lets the event loop run (timers, stdin, the shutdown handler) before the next synchronous step. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * JSON.parse that never builds a `__proto__` key (plan 02 §5 A-3: no prototype-pollution vector).
 * A reviver costs a JS call per value (≈ 50 ms of blocked main loop for a 1 MB roster body — the
 * end-to-end stall probe found it on every cached read, plan 10 A16a), so it runs only when the
 * text could spell the key: literally, or through a `\u` escape (JSON has no other way to write
 * `_`). Every other text cannot produce such a key and is parsed natively.
 */
export function parseJsonSafe(text: string): unknown {
  if (!text.includes("__proto__") && !text.includes("\\u")) return JSON.parse(text);
  return JSON.parse(text, (k: string, v: unknown) => (k === "__proto__" ? undefined : v));
}

/** The pipeline. One per provider instance (its coalescer, gate and limiter are per process). */
export class EspnRequester {
  readonly limiter: EspnLimiter;
  readonly drift: DriftStateWriter;
  readonly cookies: CookieGate;
  private readonly deps: RequestDeps;
  private readonly coalescer = new Coalescer<Fresh>();
  private readonly gate = new ForceRefreshGate();
  private readonly reportedSignals = new Set<string>();
  /**
   * Parsed cache bodies per parse function and cache key, valid while the stored entry is the same
   * (fetched_at, etag, length): a warm read of an unchanged entry skips the JSON parse and the view
   * schema (≈ 20 ms on a 1 MB roster — the largest synchronous step of most tool calls; plan 10 A16a
   * stall bound). At most PARSED_MEMO_MAX keys per parse function; values deep-frozen.
   */
  private readonly parsedMemo = new WeakMap<
    object,
    Map<string, { readonly stamp: string; readonly value: unknown }>
  >();
  private notModified = { day: 0, count: 0 };

  constructor(deps: RequestDeps) {
    this.deps = deps;
    this.limiter = new EspnLimiter({
      repo: deps.limiter,
      clock: deps.clock,
      origin: deps.origin,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      onEvent: (e) => deps.log?.debug(e),
    });
    this.drift = new DriftStateWriter(deps.driftState, deps.clock, deps.host);
    this.cookies = new CookieGate(deps.credentials, deps.clock, deps.observer);
  }

  /** Today's 304 count (UTC day) — `transportStatus().etag_304_count`. */
  etag304Today(): number {
    const day = Math.floor(this.deps.clock.nowMs() / 86_400_000);
    return this.notModified.day === day ? this.notModified.count : 0;
  }

  private ttl(): TtlContext {
    try {
      return this.deps.ttlContext?.() ?? DEFAULT_TTL_CONTEXT;
    } catch {
      return DEFAULT_TTL_CONTEXT;
    }
  }

  private cacheGet(key: string): EspnCacheEntry | null {
    try {
      return this.deps.cache.get(key);
    } catch {
      this.deps.log?.warn("espn.cache.read_failed");
      return null;
    }
  }

  private stateOf(cls: FreshnessClass, e: EspnCacheEntry) {
    return stampState(
      cls,
      { as_of: e.server_time ?? e.fetched_at, fetched_at: e.fetched_at, checked_at: null },
      this.deps.clock.nowMs(),
      this.ttl(),
    );
  }

  private hostMoved(): boolean {
    try {
      return this.drift.current()?.status === "host_moved";
    } catch {
      return false;
    }
  }

  private stamp<T>(
    spec: ReadSpec<T>,
    value: T,
    cls: FreshnessClass,
    at: { fetchedAt: string; serverTime: string | null },
    cache: CacheOutcome,
    degraded: DegradedRead | null,
  ): PlatformStamp {
    let row = null;
    try {
      row = this.drift.current();
    } catch {
      row = null;
    }
    return {
      source: spec.source ?? `espn:${primaryView(spec.target)}`,
      as_of: at.serverTime ?? at.fetchedAt,
      fetched_at: at.fetchedAt,
      freshness: cls.id,
      provisional: spec.provisional?.(value) ?? false,
      cache,
      drift: driftMetaFor(row, spec.target.views),
      degraded,
    };
  }

  /** The memoised parse of an unchanged stored entry, or undefined. */
  private memoOf<T>(spec: ReadSpec<T>, e: EspnCacheEntry): T | undefined {
    const hit = this.parsedMemo.get(spec.parse)?.get(e.key);
    return hit?.stamp === memoStamp(e) ? (hit.value as T) : undefined;
  }

  /**
   * Parses a cached body; null when it no longer matches the schemas (then it is refetched). A large
   * body (over YIELD_BEFORE_PARSE_CHARS) is parsed in turns of its own — the JSON, the view schema,
   * the freeze — with the event loop running before each: in one turn the three made a 30–40 ms
   * synchronous block on a cold 1 MB roster (plan 10 A16a's end-to-end stall probe).
   */
  private async parseCached<T>(spec: ReadSpec<T>, e: EspnCacheEntry): Promise<T | null> {
    const memo = this.memoOf(spec, e);
    if (memo !== undefined) return memo;
    const large = e.parsed_json.length > YIELD_BEFORE_PARSE_CHARS;
    let value: T;
    try {
      if (large) await yieldToLoop();
      const raw = parseJsonSafe(e.parsed_json);
      if (large) await yieldToLoop();
      const parsed = spec.parse(raw);
      if (large) await yieldToLoop();
      value = deepFreeze(parsed);
    } catch {
      return null;
    }
    let byKey = this.parsedMemo.get(spec.parse);
    if (byKey === undefined) {
      byKey = new Map();
      this.parsedMemo.set(spec.parse, byKey);
    }
    byKey.delete(e.key);
    byKey.set(e.key, { stamp: memoStamp(e), value });
    while (byKey.size > PARSED_MEMO_MAX) {
      const oldest = byKey.keys().next();
      if (oldest.done === true) break;
      byKey.delete(oldest.value);
    }
    return value;
  }

  /** The read (see the file header). */
  async read<T>(spec: ReadSpec<T>, opts: ReadOptions = {}): Promise<ReadResult<T>> {
    const views = spec.target.views;
    const view = primaryView(spec.target);
    const cls = classForViews(views);
    const cacheable = !views.some((v) => UNCACHED_VIEWS.includes(v));
    const key = cacheKey(spec.target, spec.leagueId, spec.filter);
    const entry = cacheable ? this.cacheGet(key) : null;
    // A large cached body's parse and schema check take tens of ms (a 1 MB roster). Cache hits
    // resolve as microtasks, so a tool's several reads would otherwise run as ONE macrotask and block
    // the event loop past the 50 ms stall bound (plan 03 §1.2; plan 10 A16a — found by the
    // end-to-end stall probe): parseCached gives each large parse's phases turns of their own. Small
    // bodies (settings, standings) parse in well under a millisecond; a memoised parse is free.
    const cached = entry === null ? null : await this.parseCached(spec, entry);
    const usable = entry !== null && cached !== null ? { entry, value: cached } : null;
    const now = this.deps.clock.nowMs();
    const force = opts.force_refresh === true && this.gate.allow(key, now);
    if (usable !== null && !force && this.stateOf(cls, usable.entry).state === "fresh")
      return {
        value: usable.value,
        stamp: this.stamp(spec, usable.value, cls, this.at(usable.entry), "hit", null),
        headers: {},
      };

    const fallback = (err: unknown): ReadResult<T> => {
      const code = (err as { effCode?: unknown } | null)?.effCode;
      if (usable === null || !(DEGRADED_CODES as readonly unknown[]).includes(code)) throw err;
      const st = this.stateOf(cls, usable.entry).state;
      const hostMoved = code === "ESPN_HOST_MOVED" || this.hostMoved();
      const decision = serveDecision(cls, st, { allowStale: opts.allow_stale === true, hostMoved });
      if (decision.outcome !== "serve") throw new EspnStaleOnlyError(view);
      const degraded: DegradedRead = {
        code: code as DegradedCode,
        served: "stale_cache",
        hard_limit_suspended: decision.hardLimitSuspended,
      };
      this.deps.log?.debug("espn.read.degraded", { view, code: degraded.code });
      return {
        value: usable.value,
        stamp: this.stamp(
          spec,
          usable.value,
          cls,
          this.at(usable.entry),
          code === "ESPN_UPSTREAM_UNAVAILABLE" && this.limiter.breaker.isOpen()
            ? "breaker"
            : "stale",
          degraded,
        ),
        headers: {},
      };
    };

    // while the host is moved (drift_state), an open breaker reports the move, not an outage
    if (this.limiter.breaker.isOpen())
      return fallback(
        this.hostMoved()
          ? new EspnUpstreamError("host_moved", { view, reason: "breaker_open" })
          : new EspnBreakerOpenError(),
      );

    let joined = false;
    let promise: Promise<Fresh>;
    try {
      const run = this.coalescer.run(key, async () => {
        const budget = opts.budget;
        if (budget !== undefined) {
          if (!budget.canStart(this.deps.clock.nowMs()))
            throw new UpstreamBudgetExhausted(view, "deadline");
          if (!budget.tryConsume()) throw new UpstreamBudgetExhausted(view, "budget");
        }
        return this.fetchFresh(spec, usable?.entry ?? null, opts, key, cacheable);
      });
      joined = run.joined;
      promise = run.promise;
    } catch (e) {
      return fallback(e);
    }
    let fresh: Fresh;
    try {
      fresh = await promise;
    } catch (e) {
      if (e instanceof UpstreamBudgetExhausted) throw e;
      return fallback(e);
    }
    let value: T;
    try {
      value = fresh.parsedBy === spec.parse ? (fresh.parsed as T) : spec.parse(fresh.body);
    } catch (e) {
      if (e instanceof SchemaSignals) throw this.driftError(e.signals);
      throw e;
    }
    return {
      value,
      stamp: this.stamp(spec, value, cls, fresh, joined ? "coalesced" : fresh.cache, null),
      headers: fresh.headers,
    };
  }

  private at(e: EspnCacheEntry): { fetchedAt: string; serverTime: string | null } {
    return { fetchedAt: e.fetched_at, serverTime: e.server_time };
  }

  /** Records drift signals (best effort — a failed write never changes the result) and builds the error. */
  private driftError(signals: readonly DriftSignal[]): EspnDriftError {
    try {
      this.drift.record(signals);
    } catch {
      this.deps.log?.warn("espn.drift_state.write_failed");
    }
    const first = signals.find(failsResponse) ?? signals[0];
    const view = first?.view ?? "mSettings";
    this.deps.log?.warn("espn.drift", { view, path: first?.path ?? "$", kind: first?.kind });
    return new EspnDriftError(view, errorPath(first?.path ?? "$"));
  }

  /** Records the non-failing signals once per process (enum and additive drift are counted, not fatal). */
  private reportSoftSignals(signals: readonly DriftSignal[]): void {
    const fresh = signals.filter((s) => {
      const k = `${s.kind}|${s.view}|${s.path}|${String(s.value)}`;
      if (this.reportedSignals.has(k)) return false;
      this.reportedSignals.add(k);
      return true;
    });
    if (fresh.length === 0) return;
    for (const s of fresh)
      this.deps.log?.debug("espn.drift.soft", { kind: s.kind, view: s.view, path: s.path });
    try {
      this.drift.record(fresh);
    } catch {
      this.deps.log?.warn("espn.drift_state.write_failed");
    }
  }

  /** One fresh upstream read (inside the coalescer): cookie → limiter → attempts → JSON → drift → cache. */
  private async fetchFresh<T>(
    spec: ReadSpec<T>,
    entry: EspnCacheEntry | null,
    opts: ReadOptions,
    key: string,
    cacheable: boolean,
  ): Promise<Fresh> {
    const target = spec.target;
    const view = primaryView(target);
    const deadline = opts.budget?.deadline_at_ms ?? this.deps.clock.nowMs() + PER_CALL_DEADLINE_MS;
    const signal = opts.budget?.signal ?? null;
    const cookie = await this.cookies.forRequest(spec.cookies, target.route);
    const ticket = await this.limiter.acquire({
      keyless: cookie === null,
      deadlineAtMs: deadline,
      signal,
    });
    let outcome: RequestOutcome = "network_error";
    try {
      let attempt = 0;
      for (;;) {
        attempt++;
        const now = this.deps.clock.nowMs();
        const timeoutMs = Math.min(
          this.deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
          deadline - now,
        );
        if (timeoutMs <= 0) throw new UpstreamBudgetExhausted(view, "deadline");
        let answer: AttemptAnswer | null = null;
        let failure: unknown = null;
        try {
          answer = await sendAttempt(this.deps.fetch, {
            target,
            filter: spec.filter,
            cookie,
            ifNoneMatch: entry?.etag ?? null,
            timeoutMs,
            signal,
            view,
          });
        } catch (e) {
          failure = e;
        }
        if (answer !== null && answer.status === 304 && entry !== null && entry.etag !== null) {
          outcome = "not_modified";
          return this.notModifiedAnswer(entry, answer, key);
        }
        if (answer !== null) {
          failure = classifyAnswer({
            status: answer.status,
            contentType: answer.headers["content-type"] ?? null,
            bodyText: answer.bodyText,
            retryAfter: answer.headers["retry-after"] ?? null,
            cookieBearing: cookie !== null,
            route: target.route,
            view,
          });
          if (failure === null) {
            outcome = "ok";
            return await this.success(spec, answer, cookie !== null, key, cacheable);
          }
        }
        const err = failure;
        if (err instanceof EspnUpstreamError) {
          outcome = err.outcome;
          await this.afterFailure(err, cookie !== null, view);
          const wait =
            err.retryAfterMs ?? backoffMs(attempt, this.deps.random?.() ?? Math.random());
          if (
            err.retryable &&
            attempt < ESPN_BACKOFF.maxAttempts &&
            opts.budget?.canStart(this.deps.clock.nowMs() + wait) !== false &&
            this.deps.clock.nowMs() + wait < deadline
          ) {
            this.limiter.breaker.record(err.outcome);
            this.deps.log?.debug("espn.retry", { view, attempt, kind: err.kind });
            await (this.deps.sleep ?? realSleep)(wait, signal);
            continue;
          }
        }
        throw err;
      }
    } finally {
      ticket.finish(outcome);
    }
  }

  /**
   * One probe request (plan 02 §2.1): through the limiter and the breaker, never cached, never
   * retried; the body is discarded — only the status is returned. A 3xx or a non-JSON 2xx is still
   * ESPN_HOST_MOVED; a network failure is still classified.
   */
  async probeSend(
    target: EspnTarget,
    filter: string | null,
    cookie: string | null,
  ): Promise<number> {
    if (this.limiter.breaker.isOpen()) throw new EspnBreakerOpenError();
    const view = primaryView(target);
    const now = this.deps.clock.nowMs();
    const ticket = await this.limiter.acquire({
      keyless: cookie === null,
      deadlineAtMs: now + PER_CALL_DEADLINE_MS,
      signal: null,
    });
    let outcome: RequestOutcome = "network_error";
    try {
      const answer = await sendAttempt(this.deps.fetch, {
        target,
        filter,
        cookie,
        ifNoneMatch: null,
        timeoutMs: this.deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
        signal: null,
        view,
      });
      const s = answer.status;
      outcome =
        s >= 200 && s <= 299
          ? "ok"
          : s === 429
            ? "rate_limited"
            : s >= 500
              ? "server_error"
              : "client_error";
      if (s <= 399) {
        const err = classifyAnswer({
          status: s,
          contentType: answer.headers["content-type"] ?? null,
          bodyText: "",
          retryAfter: null,
          cookieBearing: cookie !== null,
          route: target.route,
          view,
        });
        if (err !== null) {
          outcome = err.outcome;
          await this.afterFailure(err, cookie !== null, view);
          throw err;
        }
      }
      return s;
    } catch (e) {
      if (e instanceof EspnUpstreamError) outcome = e.outcome;
      throw e;
    } finally {
      ticket.finish(outcome);
    }
  }

  private notModifiedAnswer(entry: EspnCacheEntry, answer: AttemptAnswer, key: string): Fresh {
    const day = Math.floor(this.deps.clock.nowMs() / 86_400_000);
    this.notModified =
      this.notModified.day === day ? { day, count: this.notModified.count + 1 } : { day, count: 1 };
    const fetchedAt = this.deps.clock.nowIso();
    try {
      this.deps.cache.put({ ...entry, key, fetched_at: fetchedAt });
    } catch {
      this.deps.log?.warn("espn.cache.write_failed");
    }
    return {
      body: parseJsonSafe(entry.parsed_json),
      parsed: null,
      parsedBy: null,
      headers: answer.headers,
      fetchedAt,
      serverTime: serverTimeIso(answer.headers["x-fantasy-server-time"]) ?? entry.server_time,
      cache: "hit",
    };
  }

  /** After a classified failure: credential observation, host-move state, breaker. */
  private async afterFailure(
    err: EspnUpstreamError,
    cookieBearing: boolean,
    view: EspnView,
  ): Promise<void> {
    if (err.kind === "auth_rejected" && cookieBearing)
      await this.cookies.observe("rejected", err.effDetails.upstream_status ?? null, view);
    if (err.kind === "requires_cookies") this.cookies.learnPublic(false);
    if (err.kind === "host_moved") {
      this.limiter.breaker.forceOpen();
      try {
        this.drift.record([{ kind: "host_moved", view, path: "$", value: null }]);
      } catch {
        this.deps.log?.warn("espn.drift_state.write_failed");
      }
    }
    this.deps.log?.debug("espn.request.failed", {
      view,
      kind: err.kind,
      upstream_status: err.effDetails.upstream_status,
      upstream_type: err.effDetails.upstream_type,
    });
  }

  private async success<T>(
    spec: ReadSpec<T>,
    answer: AttemptAnswer,
    cookieBearing: boolean,
    key: string,
    cacheable: boolean,
  ): Promise<Fresh> {
    const view = primaryView(spec.target);
    // A large fresh body is parsed, drift-checked, schema-checked and stripped for the cache — each
    // tens of ms on a 1 MB roster; the event loop runs between the phases (the 50 ms stall bound,
    // plan 10 A16a; ADV OBJ-07 — found by the end-to-end stall probe), as `read` does for a hit.
    const large = answer.bodyText.length > YIELD_BEFORE_PARSE_CHARS;
    let body: unknown;
    try {
      body = parseJsonSafe(answer.bodyText);
    } catch {
      throw new EspnUpstreamError("malformed", { view, upstream_status: answer.status });
    }
    if (large) await yieldToLoop();
    const check = checkResponse(spec.target.views, body, this.deps.observations);
    if (check.drifted) throw this.driftError(check.signals);
    if (large) await yieldToLoop();
    let parsed: unknown;
    try {
      parsed = spec.parse(body);
    } catch (e) {
      if (e instanceof SchemaSignals) throw this.driftError(e.signals);
      throw e;
    }
    if (large) await yieldToLoop();
    this.reportSoftSignals(check.signals);
    this.cookies.learnFromBody(body);
    if (cookieBearing) await this.cookies.observe("accepted", answer.status, view);
    try {
      this.drift.recovered();
    } catch {
      this.deps.log?.warn("espn.drift_state.write_failed");
    }
    const fetchedAt = this.deps.clock.nowIso();
    const serverTime = serverTimeIso(answer.headers["x-fantasy-server-time"]);
    if (cacheable) {
      // the cache strip of a large body walks it whole: the loop runs before and after it
      const stripped = stripForCache(body);
      if (large) await yieldToLoop();
      try {
        this.deps.cache.put({
          key,
          parsed_json: JSON.stringify(stripped),
          fetched_at: fetchedAt,
          server_time: serverTime,
          etag: answer.headers.etag ?? null,
          http_status: answer.status,
          raw_body: this.deps.recordRawBodies ? answer.bodyText : null,
        });
      } catch {
        this.deps.log?.warn("espn.cache.write_failed");
      }
    }
    this.deps.log?.debug("espn.request.ok", {
      view,
      upstream_status: answer.status,
      bytes: answer.bytes,
    });
    return {
      body,
      parsed,
      parsedBy: spec.parse,
      headers: answer.headers,
      fetchedAt,
      serverTime,
      cache: "miss",
    };
  }
}
