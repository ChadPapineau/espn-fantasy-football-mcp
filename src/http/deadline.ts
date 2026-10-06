// deadline.ts — one ESPN-fact upstream call under its total deadline (plan 01 §6 + ADV OBJ-20: every
// call carries a total upstream deadline of ≤ 20 s WITH the retries inside it — a retry starts only
// if the deadline leaves room; backoff 1, 2, 4, 8 s ±25 % jitter, max 3 attempts, Retry-After
// honoured, only on 429 / 5xx / timeouts (and ECONNRESET, plan 05 §4.1); 4xx, ENOTFOUND and
// ECONNREFUSED never retried; the breaker is consulted before EVERY attempt and fed after it).
// So a black-holed network costs one ≤ 20 s call, not ≈ 48 s of serial timeouts. The deadline is
// clamped to PER_CALL_DEADLINE_MS from the start whatever the caller passes. Pure orchestration over
// an injected clock, rng and sleep; the attempt itself is the caller's (usually client.espnGet).
import { ESPN_BACKOFF, type RequestOutcome } from "../config/schema.js";
import { ATTEMPT_TIMEOUT_MS, PER_CALL_DEADLINE_MS } from "../providers/platform.js";
import type { CircuitBreaker } from "./breaker.js";
import { HttpError, requestOutcomeOf, type HttpErrorKind } from "./errors.js";
import { abortableSleep, type Sleep } from "./sleep.js";

/** A retry starts only when at least this much of the deadline remains after its backoff. */
export const MIN_ATTEMPT_MS = 1_000;

/** Backoff tuning (config ESPN_BACKOFF). */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  /** ± fraction of the nominal delay (0.25 = ±25 %). */
  readonly jitter: number;
  readonly maxAttempts: number;
}

/** The source of "now" (domain/clock.ts Clock satisfies it). */
export interface NowClock {
  nowMs(): number;
}

/** A float source in [0, 1) (domain/clock.ts Rng satisfies it). */
export interface RandomSource {
  next(): number;
}

/**
 * The delay before retry number `retry` (1 = the first retry): min(maxMs, baseMs·2^(retry−1)) scaled
 * by 1 ± jitter from `u` ∈ [0, 1). Never negative; a bad `u` reads as the nominal delay.
 */
export function backoffDelayMs(retry: number, policy: BackoffPolicy, u: number): number {
  const n = Math.max(1, Math.floor(retry));
  const nominal = Math.min(policy.maxMs, policy.baseMs * 2 ** (n - 1));
  const r = Number.isFinite(u) && u >= 0 && u < 1 ? u : 0.5;
  return Math.max(0, Math.round(nominal * (1 + policy.jitter * (2 * r - 1))));
}

/** What one attempt is given. */
export interface AttemptContext {
  /** Aborts when the caller aborts or this attempt's timeout fires. */
  readonly signal: AbortSignal;
  /** This attempt's timeout: min(ATTEMPT_TIMEOUT_MS, the deadline's remainder). */
  readonly timeoutMs: number;
  /** 1-based. */
  readonly attempt: number;
}

/** One attempt's record (for the espn_requests row and logs). */
export interface AttemptRecord {
  readonly attempt: number;
  /** null = no upstream verdict (refused before sending, or the caller aborted). */
  readonly outcome: RequestOutcome | null;
  readonly kind: HttpErrorKind | null;
  readonly ms: number;
}

/** The call's options. */
export interface UpstreamCallOptions<T> {
  /** Epoch ms after which no attempt may run (UpstreamBudget.deadline_at_ms); clamped to start + 20 s. */
  readonly deadlineAtMs: number;
  /** The caller's cancellation. */
  readonly signal: AbortSignal;
  readonly clock: NowClock;
  readonly rng: RandomSource;
  readonly sleep?: Sleep;
  /** Consulted before every attempt and fed every outcome; null/absent = no breaker. */
  readonly breaker?: CircuitBreaker | null;
  readonly policy?: BackoffPolicy;
  readonly attemptTimeoutMs?: number;
  /** Runs before every attempt, after the breaker allows it (the cross-process limiter). May throw. */
  readonly beforeAttempt?: (attempt: number) => void | Promise<void>;
  /** The outcome of a returned value (304 → `not_modified`, 4xx → `client_error`); default `ok`. */
  readonly outcomeOf?: (value: T) => RequestOutcome;
  /** Called after every attempt. Must not throw (a throw is swallowed). */
  readonly onAttempt?: (r: AttemptRecord) => void;
}

/** A successful call. */
export interface UpstreamCallResult<T> {
  readonly value: T;
  readonly attempts: number;
}

/** Races `p` against the attempt's timer and the caller's signal; settles exactly once. */
function raceAttempt<T>(
  p: Promise<T>,
  timeoutMs: number,
  caller: AbortSignal,
  attemptCtl: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (): void => {
      done = true;
      clearTimeout(timer);
      caller.removeEventListener("abort", onCaller);
    };
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      attemptCtl.abort();
      reject(new HttpError({ kind: "timeout", causeCode: "ATTEMPT_TIMEOUT", espn: true }));
    }, timeoutMs);
    const onCaller = (): void => {
      if (done) return;
      finish();
      attemptCtl.abort();
      reject(new HttpError({ kind: "aborted", espn: true }));
    };
    caller.addEventListener("abort", onCaller, { once: true });
    p.then(
      (v) => {
        if (done) return;
        finish();
        resolve(v);
      },
      (e: unknown) => {
        if (done) return;
        finish();
        reject(e instanceof Error ? e : new Error("attempt rejected with a non-Error"));
      },
    );
  });
}

/**
 * Runs `attempt` under the call's deadline, retry policy and breaker. Resolves with the first value;
 * rejects with the last HttpError (or `deadline` / `breaker_open` / `aborted` when no attempt could
 * run), or with whatever non-HttpError an attempt or `beforeAttempt` threw (never retried).
 */
export async function runUpstreamCall<T>(
  attempt: (ctx: AttemptContext) => Promise<T>,
  opts: UpstreamCallOptions<T>,
): Promise<UpstreamCallResult<T>> {
  const policy = opts.policy ?? ESPN_BACKOFF;
  const sleep = opts.sleep ?? abortableSleep;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  if (!Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0)
    throw new RangeError("deadline: attemptTimeoutMs must be a positive number");
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1)
    throw new RangeError("deadline: maxAttempts must be an integer ≥ 1");
  if (!(opts.signal instanceof AbortSignal)) throw new RangeError("deadline: signal is required");
  const now = (): number => opts.clock.nowMs();
  // read through a function: the signal flips during awaits, which TS's narrowing cannot see
  const aborted = (): boolean => opts.signal.aborted;
  const start = now();
  if (!Number.isFinite(start)) throw new RangeError("deadline: the clock must be finite");
  const deadline = Math.min(
    Number.isFinite(opts.deadlineAtMs) ? opts.deadlineAtMs : start,
    start + PER_CALL_DEADLINE_MS,
  );
  const report = (r: AttemptRecord): void => {
    try {
      opts.onAttempt?.(r);
    } catch {
      // a reporting hook never changes the call's result
    }
  };
  let last: HttpError | null = null;

  // every iteration returns, throws, or (a retryable failure with room left) continues; the
  // n ≥ maxAttempts check inside ends the loop
  for (let n = 1; ; n++) {
    if (aborted()) throw last ?? new HttpError({ kind: "aborted", espn: true });
    const t = now();
    if (t >= deadline || (n > 1 && deadline - t < MIN_ATTEMPT_MS))
      throw last ?? new HttpError({ kind: "deadline", espn: true });
    const verdict = opts.breaker?.check(t) ?? ({ allowed: true, probe: false } as const);
    if (!verdict.allowed) {
      const retryAfterS = Number.isFinite(verdict.retry_at_ms)
        ? Math.max(0, Math.ceil((verdict.retry_at_ms - t) / 1000))
        : null;
      throw last ?? new HttpError({ kind: "breaker_open", retryAfterS, espn: true });
    }
    try {
      await opts.beforeAttempt?.(n);
    } catch (e) {
      opts.breaker?.record(null, now());
      throw e;
    }
    const begun = now();
    const timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, deadline - begun));
    const ctl = new AbortController();
    let value: T;
    try {
      const p = attempt({ signal: ctl.signal, timeoutMs, attempt: n });
      p.catch(() => undefined);
      value = await raceAttempt(p, timeoutMs, opts.signal, ctl);
    } catch (e) {
      const end = now();
      if (!(e instanceof HttpError)) {
        opts.breaker?.record(null, end);
        report({ attempt: n, outcome: null, kind: null, ms: end - begun });
        throw e;
      }
      const err =
        aborted() && e.kind !== "aborted" ? new HttpError({ kind: "aborted", espn: true }) : e;
      const outcome = requestOutcomeOf(err);
      opts.breaker?.record(outcome, end);
      report({ attempt: n, outcome, kind: err.kind, ms: end - begun });
      last = err;
      if (!err.retryable || n >= policy.maxAttempts || aborted()) throw err;
      const delay =
        err.retryAfterS !== null
          ? err.retryAfterS * 1000
          : backoffDelayMs(n, policy, opts.rng.next());
      if (end + delay + MIN_ATTEMPT_MS > deadline) throw err;
      try {
        await sleep(delay, opts.signal);
      } catch {
        throw err;
      }
      continue;
    }
    const end = now();
    let outcome: RequestOutcome = "ok";
    try {
      outcome = opts.outcomeOf?.(value) ?? "ok";
    } catch {
      // a classifying hook never turns a received answer into a failure
    }
    opts.breaker?.record(outcome, end);
    report({ attempt: n, outcome, kind: null, ms: end - begun });
    return { value, attempts: n };
  }
}
