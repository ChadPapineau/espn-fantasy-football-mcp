// espn-http.ts — the few ESPN requests the CLI sends itself, outside the provider (plan 03 §2.1
// steps 5–6: `eff setup`'s anonymous and cookie-bearing probes and the `mTeam` team resolution;
// plan 06 §1.2: `eff probe`'s keyless host and shape probes; plan 03 §5 #14 clock skew). Every one
// goes through the ONE http client (src/http: read-host allow-list, never the write host, redirects
// refused, cookie only to the read host, bounded bodies) and the cross-process limiter table (plan
// 01 §6: a request whose row cannot be written is not sent; the jobs' daily caps), and records its
// outcome for the breaker view. Bodies are parsed only where a check needs them; a board body is
// discarded unread (plan 02 §2.1).
import {
  HTTP_ERROR_KINDS,
  HttpError,
  requestOutcomeOf,
  type HttpErrorKind,
} from "../http/errors.js";
import type { HttpClient } from "../http/client.js";
import type { Clock } from "../domain/clock.js";
import { boardProbeFilter } from "../providers/espn/filter.js";
import { limiterRequest, trySlot } from "../providers/espn/limiter.js";
import { communicationTarget, leagueTarget } from "../providers/espn/path.js";
import type { SetupNetwork, TeamResolution } from "../auth/setup.js";
import type { CookieHeader } from "../auth/types.js";
import type { LimiterRepository, RequestOrigin } from "../store/types.js";
import { tlsVerificationDisabled, type RequestOutcome } from "../config/schema.js";
import type { HttpGet } from "../sources/source.js";

/** One answered request: the status, the (capped) body and the headers. */
export interface EspnAnswer {
  readonly status: number;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * ESPN's numeric `Retry-After` on a 429 / 5xx the client turned into an error (its body and
   * headers are not kept then), so a caller that retries can honour it (plan 01 §6).
   */
  readonly retryAfterS?: number | null;
}

/** An unanswered request: a fixed-vocabulary code (never a message). */
export interface EspnFailure {
  readonly error: string;
}

/** What the CLI's ESPN requests need. */
export interface EspnHttpDeps {
  readonly http: Pick<HttpClient, "espnGet">;
  /** The limiter table (null only where no request is ever made: setup's test mode). */
  readonly limiter: LimiterRepository | null;
  readonly clock: Clock;
  readonly origin: RequestOrigin;
  /** Waits for a full window (default: a real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The longest a CLI request waits, in total, for full limiter windows before it reports
 * `rate_limited` (the sum of every wait: a window that is still full when the timer fires — the store
 * counts its boundary millisecond as inside — is waited for again, as the provider's limiter does).
 */
export const MAX_LIMITER_WAIT_MS = 5_000;

/**
 * The real wait: a REFERENCED timer. While a CLI request waits for the limiter nothing else may hold
 * the event loop (undici's idle keep-alive sockets are unreferenced), so an unreferenced timer let
 * Node end the process mid-command with exit 13 ("unsettled top-level await") before the request
 * was sent and before any output was written. The wait is bounded by MAX_LIMITER_WAIT_MS.
 */
export const limiterSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/**
 * The HttpError kinds that are an ANSWER: ESPN sent this status, and only its body was not kept
 * (a 4xx, a 5xx, a 429, another unexpected status). Every other kind with a status — `too_large`,
 * `decode` — is a refused body: the request is unanswered.
 */
const ANSWERED_STATUS_KINDS: ReadonlySet<HttpErrorKind> = new Set<HttpErrorKind>([
  "http_4xx",
  "http_5xx",
  "http_status",
  "rate_limited",
]);

function outcomeOfStatus(status: number): RequestOutcome {
  if (status === 304) return "not_modified";
  if (status >= 200 && status < 300) return "ok";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

/** Resolves when `p` settles or `signal` aborts, whichever comes first (never rejects). */
function untilAborted(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return p;
  return new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
    p.then(done, done);
  });
}

/**
 * One ESPN GET under the limiter (one send: the CLI never retries a probe). It takes its slot as
 * every ESPN request does (trySlot: the cross-process in-flight cap of plan 01 §6 D7, decided inside
 * the store's transaction, then the windows and the jobs' daily caps — Stage C finding
 * limiter-concurrency-per-process: this path recorded its row with tryRecord alone, outside the
 * cap). A full window or no free in-flight slot is waited for — again and again while it stays so —
 * until the waits would exceed MAX_LIMITER_WAIT_MS in total; then `rate_limited`, with nothing
 * sent. A spent daily cap is refused at once. The caller's `signal` (a refresh's claim on
 * SIGINT/SIGTERM) ends it at once: before a slot is taken or during a wait, `aborted` with nothing
 * recorded or sent; during the request, `aborted` (no upstream verdict: the breaker never counts it).
 */
export async function espnRequest(
  deps: EspnHttpDeps,
  req: {
    readonly url: string;
    readonly cookie: CookieHeader | null;
    readonly fantasyFilter?: string;
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
  },
): Promise<EspnAnswer | EspnFailure> {
  // certificate verification off process-wide: nothing is sent and no limiter row is written (the
  // client refuses too, as the last line) — the cookie would reach an impostor (plan 02 T2; Stage C
  // finding espn-tls-verify-disabled-unguarded)
  if (tlsVerificationDisabled()) return { error: "tls_verification_disabled" };
  const limiter = deps.limiter;
  if (limiter === null) return { error: "no_limiter" };
  const keyless = req.cookie === null;
  const sleep = deps.sleep ?? limiterSleep;
  let waited = 0;
  let id: number;
  for (;;) {
    if (req.signal?.aborted === true) return { error: "aborted" };
    let verdict;
    try {
      verdict = trySlot(limiter, limiterRequest(deps.clock.nowMs(), keyless, deps.origin));
    } catch {
      return { error: "limiter_unavailable" };
    }
    if (verdict.ok) {
      id = verdict.id;
      break;
    }
    if (verdict.reason === "daily_cap") return { error: "daily_cap" };
    // the store's windows count their boundary millisecond as inside: a retry that wakes exactly on
    // it is refused again, so the wait repeats (at least 1 ms each time) until the budget is spent
    const wait = Math.max(1, Math.ceil(verdict.retry_after_ms));
    if (!Number.isFinite(wait) || waited + wait > MAX_LIMITER_WAIT_MS)
      return { error: "rate_limited" };
    waited += wait;
    await untilAborted(sleep(wait), req.signal);
  }
  const record = (o: RequestOutcome): void => {
    try {
      limiter.recordOutcome(id, o);
    } catch {
      // the row stays `pending`; the breaker view ignores pending rows
    }
  };
  try {
    const timeout = AbortSignal.timeout(20_000);
    const r = await deps.http.espnGet(req.url, {
      signal: req.signal === undefined ? timeout : AbortSignal.any([req.signal, timeout]),
      cookie: req.cookie,
      ...(req.fantasyFilter === undefined ? {} : { fantasyFilter: req.fantasyFilter }),
      ...(req.maxBytes === undefined ? {} : { maxBytes: req.maxBytes }),
    });
    record(outcomeOfStatus(r.status));
    return { status: r.status, body: r.body, headers: r.headers };
  } catch (e) {
    if (e instanceof HttpError) {
      const o = requestOutcomeOf(e);
      if (o !== null) record(o);
      if (e.kind === "redirect_refused" || e.kind === "too_many_redirects")
        return { error: "host_moved" };
      // an error status ESPN answered (its body is not kept) is an answered request; a body the
      // client REFUSED — over the size cap, or a gzip that does not decode — is not, whatever its
      // status line said: passed on as an empty 200 it read as host_moved to the probe and as
      // accepted cookies to setup (Stage C finding cli-espn-refused-body-reads-as-200)
      if (e.status !== null && ANSWERED_STATUS_KINDS.has(e.kind))
        return {
          status: e.status,
          body: new Uint8Array(),
          headers: {},
          retryAfterS: e.retryAfterS,
        };
      return { error: e.kind };
    }
    record("network_error");
    return { error: "network" };
  }
}

/**
 * An HttpGet for the keyless ESPN season sources (src/sources/espn_season): each GET is one
 * `espnRequest` (the limiter row, the outcome, a 3xx refused as a host move) with no cookie, and a
 * non-2xx answer or a refusal becomes the HttpError the refresh runner classifies (404 → the season
 * is not published yet; 429/5xx → retried; a spent daily cap → RATE_LIMITED). A limiter that cannot
 * record the request sends nothing (INTERNAL).
 *
 * ESPN's `Retry-After` is honoured (plan 01 §6 "honour Retry-After if it ever appears"; Stage C
 * finding cli-season-get-drops-retry-after: the hint was dropped, so `eff refresh espn:*` retried a
 * 429 after ~0.6 s): the error carries it — the runner's retry waits at least that long, up to its
 * own cap — and until the hinted instant no request of this run goes to that host at all: a call
 * inside the window is refused here, nothing sent, `rate_limited` with the time left.
 *
 * The caller's `signal` reaches the request (Stage C finding cli-first-signal-swallowed: it was
 * dropped, so the first Ctrl-C to `eff refresh espn:*` waited out the request in flight): its abort
 * ends the request or the limiter wait at once, as the `aborted` HttpError the runner reports.
 */
export function seasonGet(deps: EspnHttpDeps): HttpGet {
  const notBefore = new Map<string, number>();
  return async (url, opts) => {
    const host = new URL(url).hostname;
    const until = notBefore.get(host);
    const now = deps.clock.nowMs();
    if (until !== undefined && now < until)
      throw new HttpError({
        kind: "rate_limited",
        host,
        retryAfterS: Math.max(1, Math.ceil((until - now) / 1000)),
        espn: true,
      });
    const r = await espnRequest(deps, {
      url,
      cookie: null,
      ...(opts.fantasyFilter === undefined ? {} : { fantasyFilter: opts.fantasyFilter }),
      maxBytes: opts.maxBytes,
      signal: opts.signal,
    });
    if ("error" in r) {
      if (r.error === "daily_cap")
        throw new HttpError({ kind: "quota_exhausted", host, espn: true });
      if (r.error === "rate_limited")
        throw new HttpError({ kind: "rate_limited", host, espn: true });
      if (r.error === "host_moved")
        throw new HttpError({ kind: "redirect_refused", host, espn: true });
      if (r.error === "limiter_unavailable" || r.error === "no_limiter")
        throw new Error("espn season: the limiter could not record the request");
      const kind = (HTTP_ERROR_KINDS as readonly string[]).includes(r.error)
        ? (r.error as HttpErrorKind)
        : "network";
      throw new HttpError({ kind, host, espn: true });
    }
    if (r.status < 200 || r.status > 299) {
      const kind = r.status === 429 ? "rate_limited" : r.status >= 500 ? "http_5xx" : "http_4xx";
      const retryAfterS = kind === "http_4xx" ? null : (r.retryAfterS ?? null);
      if (retryAfterS !== null) notBefore.set(host, deps.clock.nowMs() + retryAfterS * 1000);
      throw new HttpError({ kind, host, status: r.status, retryAfterS, espn: true });
    }
    return { status: r.status, body: r.body, headers: r.headers, final_url: url };
  };
}

/** Parses a JSON body (bounded by the client); null when it is not JSON. */
export function jsonBody(a: EspnAnswer): unknown {
  try {
    return JSON.parse(Buffer.from(a.body).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** The SWID grammar compared case-insensitively, braces kept. */
function sameGuid(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toUpperCase() === b.toUpperCase();
}

/**
 * The user's team from an `mTeam` body (plan 03 §2.1 step 6): every team whose `owners[]` holds
 * the SWID. Never returns or prints a name.
 */
export function teamsOwnedBy(body: unknown, swid: string): number[] {
  if (typeof body !== "object" || body === null) return [];
  const teams = (body as { teams?: unknown }).teams;
  if (!Array.isArray(teams)) return [];
  const out: number[] = [];
  for (const t of teams.slice(0, 64)) {
    if (typeof t !== "object" || t === null) continue;
    const { id, owners } = t as { id?: unknown; owners?: unknown };
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    if (Array.isArray(owners) && owners.some((o) => sameGuid(o, swid)) && !out.includes(id))
      out.push(id);
  }
  return out;
}

/** The ESPN requests `eff setup` makes (src/auth/setup.ts SetupNetwork), over `espnRequest`. */
export function createSetupNetwork(
  deps: EspnHttpDeps,
  league: { readonly host: string; readonly season: number; readonly leagueId: string },
): SetupNetwork {
  const settingsUrl = leagueTarget({ ...league, views: ["mSettings"] }).url;
  const teamUrl = leagueTarget({ ...league, views: ["mTeam"] }).url;
  const boardUrl = communicationTarget(league).url;
  const status = async (
    url: string,
    cookie: CookieHeader | null,
    filter?: string,
  ): Promise<{ status: number } | { error: string }> => {
    const r = await espnRequest(deps, {
      url,
      cookie,
      ...(filter === undefined ? {} : { fantasyFilter: filter }),
    });
    return "error" in r ? { error: r.error } : { status: r.status };
  };
  return {
    anonymousSettings: () => status(settingsUrl, null),
    anonymousBoard: () => status(boardUrl, null, boardProbeFilter()),
    settingsWithCookies: (header) => status(settingsUrl, header),
    boardWithCookies: (header) => status(boardUrl, header, boardProbeFilter()),
    resolveTeam: async (header, swid): Promise<TeamResolution> => {
      const r = await espnRequest(deps, { url: teamUrl, cookie: header });
      if ("error" in r) return { kind: "error", code: r.error };
      if (r.status !== 200) return { kind: "error", code: `http_${String(r.status)}` };
      const ids = teamsOwnedBy(jsonBody(r), swid);
      if (ids.length === 1 && ids[0] !== undefined) return { kind: "one", teamId: ids[0] };
      return ids.length === 0 ? { kind: "none" } : { kind: "many", count: ids.length };
    },
  };
}
