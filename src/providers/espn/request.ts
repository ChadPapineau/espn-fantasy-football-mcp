// request.ts — the read pipeline every provider method goes through (plan 01 §5.3 cache-first, §5.6
// the per-call budget, §6 limiter/backoff/breaker/deadline, §7 in-call drift; plan 02 §2.1 the
// credential rules; plan 02 T2 "TLS to ESPN, then zod"): cache → (fresh: done) → breaker → budget →
// coalesce (each reader keeps its own deadline and cancellation) → TLS policy → cookie decision →
// (limiter → attempt)+ (each attempt its own limiter row; 429/5xx/timeouts/resets retried with
// jitter inside the ≤ 20 s deadline, never sooner than the backoff, never once the breaker is open;
// 400/401/403/404, fail-fast network codes and TLS failures never) → classify → JSON → drift +
// schema → cache write. A failure falls back to the cached entry within its hard limit
// (`degraded`), or past it under `allow_stale` or while the host is moved; never an upstream body
// in any error. Nothing is sent while certificate verification is off process-wide.
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
import { yieldTurn } from "../../domain/analytics/cooperative.js";
import { checkResponse, failsResponse, type DriftCheck } from "../../drift/detect.js";
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
  type UpstreamBudget,
} from "../platform.js";
import {
  cacheKey,
  classForViews,
  Coalescer,
  ForceRefreshGate,
  serverTimeIso,
  stripForCache,
  UNCACHED_VIEWS,
  type CoalesceParty,
  type LeaveReason,
  type SharedLimits,
} from "./cache.js";
import { classifyAnswer, EspnDriftError, EspnUpstreamError } from "./errors.js";
import {
  backoffMs,
  EspnBreakerOpenError,
  EspnLimiter,
  EspnRateLimitedError,
  realSleep,
  type LimiterTicket,
  type Sleep,
} from "./limiter.js";
import { primaryView, type EspnTarget } from "./path.js";
import {
  EspnTlsPolicyError,
  sendAttempt,
  tlsVerificationDisabled,
  type AttemptAnswer,
  type FetchLike,
} from "./transport.js";
import { CookieGate, type CookieUse, type PublicityStore } from "./auth-gate.js";
import { ESPN_BACKOFF } from "../../config/schema.js";
import type { EspnView } from "./types.js";
import { absentMeansEmptyPaths } from "./views/index.js";

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
  /** Where the league's publicity outlives this process (auth-gate.ts PublicityStore). */
  readonly publicity?: PublicityStore;
  /**
   * Whether certificate verification is off process-wide, asked before every request (default:
   * transport.ts `tlsVerificationDisabled`, Node's own rule, read at each request). Only fixture
   * mode, which opens no connection at all, answers false regardless (index.ts).
   */
  readonly tlsVerificationDisabled?: () => boolean;
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

/**
 * Lets the event loop run (timers, stdin, the shutdown handler) before the next synchronous step,
 * through the process-wide turn gate (src/domain/analytics/cooperative.ts `yieldTurn`): a plain
 * setImmediate per read let every in-flight call's slice run in the same check phase, N slices back
 * to back at N parallel calls (Stage C finding analytics-parallel-calls-stall-loop; plan 03 §1.2).
 */
export function yieldToLoop(): Promise<void> {
  return yieldTurn();
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

/** A reader's own limits: its call's budget, or the default ≤ 20 s window from now (no budget). */
function partyOf(budget: UpstreamBudget | undefined, nowMs: number): CoalesceParty {
  return {
    deadlineAtMs: budget?.deadline_at_ms ?? nowMs + PER_CALL_DEADLINE_MS,
    signal: budget?.signal ?? null,
  };
}

/**
 * What a reader that stopped waiting on a shared read gets: its own cancellation (`aborted`: no
 * upstream verdict), or its own deadline passing while the read goes on for a later reader — the
 * answer that call would have had alone (`attempt_timeout`). Neither is a request: nothing records it.
 */
function leaveError(why: LeaveReason, view: EspnView): EspnUpstreamError {
  return why === "aborted"
    ? new EspnUpstreamError("aborted", { view, reason: "aborted" })
    : new EspnUpstreamError("timeout", { view, reason: "attempt_timeout" });
}

/** The pipeline. One per provider instance (its coalescer, gate and limiter are per process). */
export class EspnRequester {
  readonly limiter: EspnLimiter;
  readonly drift: DriftStateWriter;
  readonly cookies: CookieGate;
  private readonly deps: RequestDeps;
  private readonly coalescer: Coalescer<Fresh>;
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
    this.coalescer = new Coalescer<Fresh>(() => deps.clock.nowMs());
    this.limiter = new EspnLimiter({
      repo: deps.limiter,
      clock: deps.clock,
      origin: deps.origin,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      onEvent: (e) => deps.log?.debug(e),
    });
    this.drift = new DriftStateWriter(deps.driftState, deps.clock, deps.host);
    this.cookies = new CookieGate(
      deps.credentials,
      deps.clock,
      deps.observer,
      deps.publicity ?? null,
    );
  }

  /**
   * Refuses to send while certificate verification is off process-wide (Stage C finding
   * espn-tls-verify-disabled-unguarded): checked before the cookie is asked for and before any
   * limiter row — nothing is sent, no row is written, the cookie never leaves the authority. A
   * policy that cannot be read refuses too (fail closed).
   */
  private assertTlsVerified(view: EspnView): void {
    let off: boolean;
    try {
      off = (this.deps.tlsVerificationDisabled ?? tlsVerificationDisabled)();
    } catch {
      off = true;
    }
    if (!off) return;
    this.deps.log?.warn("espn.tls_verification_disabled", { view });
    throw new EspnTlsPolicyError(view);
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

    // this reader's own limits: its call's deadline and cancellation (plan 01 §6, ADV OBJ-20). A
    // reader that can no longer start a request takes part in none; only the reader that STARTS
    // the request pays for it (a joiner shares it — plan 01 §5.3), and a shared read never runs
    // under one reader's limits (cache.ts Coalescer; Stage C finding espn-coalesced-read-leader-
    // budget: a cancelled or nearly-spent first caller failed a parallel call)
    const budget = opts.budget;
    if (budget !== undefined && !budget.canStart(now))
      throw new UpstreamBudgetExhausted(view, "deadline");
    if (budget !== undefined && !this.coalescer.has(key) && !budget.tryConsume())
      throw new UpstreamBudgetExhausted(view, "budget");
    const run = this.coalescer.run(
      key,
      partyOf(budget, now),
      (limits) => this.fetchFresh(spec, usable?.entry ?? null, limits, key, cacheable),
      (why) => leaveError(why, view),
    );
    let fresh: Fresh;
    try {
      fresh = await run.promise;
    } catch (e) {
      if (e instanceof UpstreamBudgetExhausted) throw e;
      return fallback(e);
    }
    const joined = run.joined;
    // an upstream answer resumes its readers outside the turn gate (an I/O completion, every joiner
    // of a coalesced read at once): each takes a gated turn before its synchronous work — the parse
    // below and the caller's own steps — so parallel calls never share a turn (plan 03 §1.2; Stage C
    // finding analytics-parallel-calls-stall-loop)
    await yieldToLoop();
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

  /**
   * The in-call drift check (plan 01 §7) with the seed paths whose absence means "none" on this
   * answer (views `absentMeansEmptyPaths`: listed in ABSENT_MEANS_EMPTY, on an answer to a
   * recognised view) read as empty lists: such a signal is never drift and never reaches
   * `drift_state`; a view whose only failing signals they are is judged without them, and every
   * other signal — an unrecognised-view skeleton included — stands as the detector gave it.
   */
  private checkBody(views: readonly EspnView[], body: unknown): DriftCheck {
    const check = checkResponse(views, body, this.deps.observations);
    if (!check.drifted) return check;
    const excused = (s: DriftSignal): boolean =>
      (s.kind === "skeleton" || s.kind === "missing_required_key") &&
      absentMeansEmptyPaths(s.view, body).includes(s.path);
    const failing = check.signals.filter(failsResponse);
    if (!failing.some(excused)) return check;
    for (const s of failing.filter(excused))
      this.deps.log?.debug("espn.absent_means_empty", { view: s.view, path: s.path });
    if (failing.some((s) => !excused(s))) {
      const signals = check.signals.filter((s) => !excused(s));
      return {
        signals,
        drifted: true,
        skeleton: signals.some((s) => s.kind === "skeleton"),
        first: signals.find(failsResponse) ?? null,
      };
    }
    // every failing signal is an absent list: the views they name pass (their enum/additive
    // observations, if a manifest ever records any, are not read on this answer); the other views
    // are checked as usual, observations included
    const cleared = new Set(failing.map((s) => s.view));
    return checkResponse(
      views.filter((v) => !cleared.has(v)),
      body,
      this.deps.observations,
    );
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

  /**
   * The wait before retry `attempt` (1-based): the backoff schedule, never shortened by a
   * `Retry-After` — a hint longer than the backoff lengthens it, a shorter one (`0`) does not
   * collapse the retries into a burst (plan 01 §6 "honour Retry-After" inside the 1/2/4 s floor).
   */
  private retryWaitMs(err: EspnUpstreamError, attempt: number): number {
    return Math.max(
      backoffMs(attempt, this.deps.random?.() ?? Math.random()),
      err.retryAfterMs ?? 0,
    );
  }

  /**
   * One fresh upstream read (inside the coalescer): TLS policy → cookie → (limiter → attempt)+ →
   * JSON → drift → cache. Every attempt — the first and each retry — is one upstream request and
   * passes the limiter on its own (its own `espn_requests` row: the 30/min and 1/s windows, the job
   * fleet's daily caps, the cross-process concurrency cap; plan 01 §6 "each request inserts a row …
   * before sending"). A retry is not a new request for the call's budget (platform.ts
   * UpstreamBudget) but must fit the deadline; one the limiter cannot fit before the deadline ends
   * the read with the last upstream failure, and none is sent once the breaker is open. The deadline
   * and the signal are the SHARED read's (`limits`, read at every step): the latest deadline of the
   * readers still waiting, and an abort once none is.
   */
  private async fetchFresh<T>(
    spec: ReadSpec<T>,
    entry: EspnCacheEntry | null,
    limits: SharedLimits,
    key: string,
    cacheable: boolean,
  ): Promise<Fresh> {
    const target = spec.target;
    const view = primaryView(target);
    const signal = limits.signal;
    this.assertTlsVerified(view);
    const cookie = await this.cookies.forRequest(spec.cookies, target.route);
    let last: EspnUpstreamError | null = null;
    for (let attempt = 1; ; attempt++) {
      let ticket: LimiterTicket;
      try {
        ticket = await this.limiter.acquire({
          keyless: cookie === null,
          deadlineAtMs: () => limits.deadline(),
          signal,
        });
      } catch (e) {
        if (last !== null && e instanceof EspnRateLimitedError) throw last;
        throw e;
      }
      // what the row records when the attempt ends before an upstream verdict was classified:
      // nothing went out (our own refusal) — never a network failure the breaker would count
      let outcome: RequestOutcome = "client_error";
      let wait: number;
      try {
        // the limiter recorded the send only before the deadline (it refuses one that cannot
        // start, so no unsent request spends the window): the attempt has what the deadline leaves
        // from that instant
        const timeoutMs = Math.min(
          this.deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
          limits.deadline() - ticket.atMs,
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
          return this.notModifiedAnswer(entry, answer, key, target.views);
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
        // an error with its own code from the fetch itself (fixture mode's refusal) sent nothing
        if (!(failure instanceof EspnUpstreamError)) throw failure;
        const err = failure;
        outcome = err.outcome;
        last = err;
        await this.afterFailure(err, cookie !== null, view);
        if (!err.retryable || attempt >= ESPN_BACKOFF.maxAttempts) throw err;
        wait = this.retryWaitMs(err, attempt);
        if (!limits.canStart(this.deps.clock.nowMs() + wait)) throw err;
      } finally {
        ticket.finish(outcome);
      }
      // the breaker opened (this read's failures or another process's): no further request
      if (this.limiter.breaker.isOpen()) throw last;
      this.deps.log?.debug("espn.retry", { view, attempt, kind: last.kind });
      await (this.deps.sleep ?? realSleep)(wait, signal);
    }
  }

  /**
   * One probe request (plan 02 §2.1): through the limiter and the breaker, never cached, never
   * retried; the body is discarded — only the status is returned. A 3xx or a non-JSON 2xx is still
   * ESPN_HOST_MOVED; a network failure is still classified. It runs inside the probe CALL's budget
   * (plan 01 §6 / ADV OBJ-20: the whole probe ends within its ≤ 20 s deadline — Stage C finding
   * auth-probe-definitive-plan-unwired): no request starts past it, and the attempt has what the
   * deadline leaves. Without a budget it gets its own ≤ 20 s window.
   */
  async probeSend(
    target: EspnTarget,
    filter: string | null,
    cookie: string | null,
    budget?: UpstreamBudget,
  ): Promise<number> {
    if (this.limiter.breaker.isOpen()) throw new EspnBreakerOpenError();
    const view = primaryView(target);
    this.assertTlsVerified(view);
    const now = this.deps.clock.nowMs();
    const deadline = budget?.deadline_at_ms ?? now + PER_CALL_DEADLINE_MS;
    // nothing is sent past the call's deadline or beyond its request cap (no row is written either)
    if (budget !== undefined && !budget.canStart(now))
      throw new EspnUpstreamError("timeout", { view, reason: "call_deadline" });
    if (budget !== undefined && !budget.tryConsume())
      throw new EspnUpstreamError("client_error", { view, reason: "call_budget" });
    const signal = budget?.signal ?? null;
    const ticket = await this.limiter.acquire({
      keyless: cookie === null,
      deadlineAtMs: deadline,
      signal,
    });
    // nothing classified yet: nothing went out (see fetchFresh) — never a counted network failure
    let outcome: RequestOutcome = "client_error";
    try {
      const timeoutMs = Math.min(
        this.deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
        deadline - ticket.atMs,
      );
      const answer = await sendAttempt(this.deps.fetch, {
        target,
        filter,
        cookie,
        ifNoneMatch: null,
        timeoutMs,
        signal,
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

  /**
   * A 304: ESPN says the latest answer for `views` IS the cached body, and only an entry that parsed
   * under the views' schemas in this process is ever revalidated (`read` passes the usable entry
   * only) — so the 304 verifies them exactly as a complete 200 does, and their removed keys clear
   * (src/drift applyRecovered, `schema`). ESPN answers conditional reads with 304: without this, one
   * incomplete answer kept a view red — and every scoring call refused — for as long as the content
   * did not change (Stage C finding drift-red-never-clears).
   */
  private notModifiedAnswer(
    entry: EspnCacheEntry,
    answer: AttemptAnswer,
    key: string,
    views: readonly EspnView[],
  ): Fresh {
    const day = Math.floor(this.deps.clock.nowMs() / 86_400_000);
    this.notModified =
      this.notModified.day === day ? { day, count: this.notModified.count + 1 } : { day, count: 1 };
    const fetchedAt = this.deps.clock.nowIso();
    try {
      this.deps.cache.put({ ...entry, key, fetched_at: fetchedAt });
    } catch {
      this.deps.log?.warn("espn.cache.write_failed");
    }
    try {
      this.drift.recovered(views, "schema");
    } catch {
      this.deps.log?.warn("espn.drift_state.write_failed");
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
    const check = this.checkBody(spec.target.views, body);
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
      // this answer passed every requested view's required keys AND its schema: drift is a fact
      // about the latest answer, so the views it verified clear their removed keys (src/drift
      // applyRecovered, `schema`) — and a good answer from the configured host ends a host move
      this.drift.recovered(spec.target.views, "schema");
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
