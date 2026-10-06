// errors.ts — the HTTP failure taxonomy (plan 01 §4.3 error codes, §6 retry rules: backoff only on
// 429 / 5xx / timeouts, ENOTFOUND / ECONNREFUSED never retried; plan 05 §4.1 network fault rows; plan
// 02 §2.3 redaction). Messages are fixed strings: never an upstream body, a URL, a header, a cookie
// or a thrown object's message — and an HttpError keeps NO raw `cause`, so nothing a hostile fetch
// put in its error can reach a log line. Ported from sibling @cf3b015, adapted (ESPN scope and
// effCode/effDetails for src/mcp/errors.ts, request outcomes for the breaker, no raw cause).
import type { RequestOutcome } from "../config/schema.js";

/** Every way an HTTP call can fail. */
export const HTTP_ERROR_KINDS = [
  /** The URL does not parse. */
  "invalid_url",
  /** Not `https:` (or a non-default port). */
  "scheme_refused",
  /** The URL carries `user:password@`. */
  "credentials_refused",
  /** The host is not on the allow-list of the call's mode (refused before any DNS lookup). */
  "host_not_allowed",
  /** A Cookie header was offered for a URL that is not on the ESPN read host (never sent). */
  "cookie_refused",
  /** A redirect without a usable Location, or to a URL the allow-list refuses (never fetched). */
  "redirect_refused",
  /** More than MAX_REDIRECT_HOPS redirects. */
  "too_many_redirects",
  "dns",
  /** Connection refused / host or network unreachable. */
  "connect",
  /** Connection reset or closed mid-response. */
  "reset",
  /** Connect (headers) or total timeout. */
  "timeout",
  "tls",
  /** A 4xx other than 429 (408 is transient). */
  "http_4xx",
  "http_5xx",
  /** Any other unexpected status (1xx, a 3xx that is not a followable redirect, a stray 304). */
  "http_status",
  /** Upstream 429. */
  "rate_limited",
  /** The per-source daily cap of this process is spent (not retryable in this run). */
  "quota_exhausted",
  /** The body (wire or decoded) exceeds the call's maxBytes. */
  "too_large",
  /** A gzip body that does not decode. */
  "decode",
  /** The caller's signal aborted the call. */
  "aborted",
  /** The circuit breaker is open: no request was sent (plan 01 §6). */
  "breaker_open",
  /** The per-call upstream deadline left no room for an attempt: no request was sent (ADV OBJ-20). */
  "deadline",
  /** Any other network failure (`fetch failed` without a known cause). */
  "network",
] as const;
/** An HTTP failure kind. */
export type HttpErrorKind = (typeof HTTP_ERROR_KINDS)[number];

/**
 * Kinds a retry may cure (plan 01 §6: backoff only on 429, 5xx and timeouts; plan 05 §4.1 groups
 * ECONNRESET with them). `dns` (ENOTFOUND, EAI_*) and `connect` (ECONNREFUSED, unreachable) are
 * deliberately absent: they fail fast (ADV OBJ-20). An unknown `network` failure is not retried.
 */
const RETRYABLE_KINDS: ReadonlySet<HttpErrorKind> = new Set<HttpErrorKind>([
  "reset",
  "timeout",
  "http_5xx",
  "rate_limited",
]);

/** Kinds that are our own policy refusing a request (a bug or a hostile redirect, not an outage). */
export const POLICY_KINDS: ReadonlySet<HttpErrorKind> = new Set<HttpErrorKind>([
  "invalid_url",
  "scheme_refused",
  "credentials_refused",
  "host_not_allowed",
  "cookie_refused",
]);

/** Kinds where no request reached upstream, so no upstream verdict exists (the breaker ignores them). */
const NO_VERDICT_KINDS: ReadonlySet<HttpErrorKind> = new Set<HttpErrorKind>([
  ...POLICY_KINDS,
  "aborted",
  "breaker_open",
  "deadline",
  "quota_exhausted",
]);

const MESSAGES: Readonly<Record<HttpErrorKind, string>> = Object.freeze({
  invalid_url: "http: the URL does not parse",
  scheme_refused: "http: only https on the default port is allowed",
  credentials_refused: "http: URLs carrying credentials are refused",
  host_not_allowed: "http: host is not on the allow-list",
  cookie_refused: "http: a cookie is only ever sent to the ESPN read host",
  redirect_refused: "http: redirect refused",
  too_many_redirects: "http: too many redirects",
  dns: "http: DNS lookup failed",
  connect: "http: connection refused or unreachable",
  reset: "http: connection reset",
  timeout: "http: request timed out",
  tls: "http: TLS failure",
  http_4xx: "http: upstream answered with a client error",
  http_5xx: "http: upstream answered with a server error",
  http_status: "http: upstream answered with an unexpected status",
  rate_limited: "http: upstream is rate-limiting",
  quota_exhausted: "http: per-source request cap reached",
  too_large: "http: response exceeds the size cap",
  decode: "http: response body could not be decoded",
  aborted: "http: request aborted",
  breaker_open: "http: circuit breaker open; no request sent",
  deadline: "http: the call's upstream deadline passed; no request sent",
  network: "http: network failure",
});

/**
 * The src/mcp/errors.ts codes an HttpError maps to (http may not import src/mcp; a test holds
 * every value inside ERROR_CODES and SOURCE_ERROR_CODES).
 */
export type HttpEffCode =
  | "INTERNAL"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "ESPN_UPSTREAM_UNAVAILABLE"
  | "ESPN_HOST_MOVED";

/** The value-free details src/mcp/errors.ts re-validates (`sanitizeDetails`). */
export interface HttpEffDetails {
  readonly reason: HttpErrorKind;
  readonly upstream_status?: number;
  readonly retry_after_s?: number;
}

/** A value-free description of a failed call. */
export interface HttpErrorInit {
  readonly kind: HttpErrorKind;
  /** The host the failing request targeted (lower-case, from a parsed URL). */
  readonly host?: string | null;
  readonly status?: number | null;
  /** Seconds from `Retry-After` on a 429 / 5xx, when numeric. */
  readonly retryAfterS?: number | null;
  /** The underlying system/undici code (`ENOTFOUND`, `ERR_TLS_…`), when one was seen. */
  readonly causeCode?: string | null;
  /** True when the call targeted the ESPN read host (its errors map to the ESPN_* codes). */
  readonly espn?: boolean;
}

const SAFE_CODE = /^[A-Z0-9_]{1,48}$/;
const SAFE_HOST = /^[a-z0-9.-]{1,253}$/;

function effCodeFor(kind: HttpErrorKind, espn: boolean): HttpEffCode {
  if (POLICY_KINDS.has(kind)) return "INTERNAL";
  if (kind === "rate_limited" || kind === "quota_exhausted") return "RATE_LIMITED";
  if (espn && (kind === "redirect_refused" || kind === "too_many_redirects"))
    return "ESPN_HOST_MOVED";
  return espn ? "ESPN_UPSTREAM_UNAVAILABLE" : "UPSTREAM_UNAVAILABLE";
}

/**
 * An HTTP failure. `effCode`/`effDetails` let src/mcp/errors.ts map it (policy refusals → INTERNAL,
 * 429 and a spent quota → RATE_LIMITED, an off-host redirect from the ESPN read host →
 * ESPN_HOST_MOVED, everything else → (ESPN_)UPSTREAM_UNAVAILABLE — never INTERNAL for an outage).
 * `retryable` is what the per-call deadline runner and the refresh runner retry on.
 */
export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly code: string;
  readonly effCode: HttpEffCode;
  readonly effDetails: HttpEffDetails;
  readonly retryable: boolean;
  readonly espn: boolean;
  readonly host: string | null;
  readonly status: number | null;
  readonly retryAfterS: number | null;
  readonly causeCode: string | null;

  constructor(init: HttpErrorInit) {
    super(MESSAGES[init.kind]);
    this.name = "HttpError";
    this.kind = init.kind;
    this.code = `EFF_HTTP_${init.kind.toUpperCase()}`;
    const status = init.status ?? null;
    this.status =
      status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    this.espn = init.espn === true;
    this.retryable =
      RETRYABLE_KINDS.has(init.kind) || (init.kind === "http_4xx" && this.status === 408);
    this.effCode = effCodeFor(init.kind, this.espn);
    const host = init.host ?? null;
    this.host = host !== null && SAFE_HOST.test(host) ? host : null;
    const ra = init.retryAfterS ?? null;
    this.retryAfterS = ra !== null && Number.isFinite(ra) && ra >= 0 ? ra : null;
    const cc = init.causeCode ?? null;
    this.causeCode = cc !== null && SAFE_CODE.test(cc) ? cc : null;
    this.effDetails = Object.freeze({
      reason: init.kind,
      ...(this.status === null ? {} : { upstream_status: this.status }),
      ...(this.retryAfterS === null ? {} : { retry_after_s: this.retryAfterS }),
    });
  }
}

/**
 * The `espn_requests.outcome` an HttpError stands for (plan 01 §6; config REQUEST_OUTCOMES), or null
 * when no request reached upstream (a policy refusal, the breaker, the deadline, a spent quota, the
 * caller's abort) — such calls are no evidence about the host and the breaker ignores them.
 */
export function requestOutcomeOf(e: HttpError): RequestOutcome | null {
  if (NO_VERDICT_KINDS.has(e.kind)) return null;
  switch (e.kind) {
    case "http_5xx":
      return "server_error";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "http_4xx":
      return "client_error";
    default:
      return "network_error";
  }
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA"]);
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
]);
const RESET_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "HOSTNAME_MISMATCH",
  "EPROTO",
]);

/** The kind a system/undici error code denotes, or null when the code is unknown. */
export function kindForCode(code: string): HttpErrorKind | null {
  if (DNS_CODES.has(code)) return "dns";
  if (CONNECT_CODES.has(code)) return "connect";
  if (RESET_CODES.has(code)) return "reset";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_"))
    return "tls";
  return null;
}

function ownString(o: object, key: string): string | null {
  try {
    if (!Object.prototype.hasOwnProperty.call(o, key)) return null;
    const v = (o as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function causeOf(e: Error): unknown {
  try {
    return e.cause;
  } catch {
    return undefined;
  }
}

function nameOf(e: Error): string {
  try {
    return typeof e.name === "string" ? e.name : "";
  } catch {
    return "";
  }
}

/** Why an in-flight call was aborted by the client itself, when it was. */
export type AbortReason = "connect_timeout" | "total_timeout" | "caller" | null;

/**
 * Maps anything `fetch` (or a body read) threw to an HttpError. Walks the `cause` chain (undici
 * wraps the system error as `TypeError: fetch failed` → `cause`) for a known code; our own timers
 * and the caller's signal take precedence over the AbortError they produce. Never throws, and never
 * copies a message, a stack or the thrown object itself into the result.
 */
export function classifyFetchError(
  e: unknown,
  abort: AbortReason,
  host: string | null,
  espn = false,
): HttpError {
  if (e instanceof HttpError) return e;
  if (abort === "connect_timeout" || abort === "total_timeout")
    return new HttpError({ kind: "timeout", host, causeCode: abort.toUpperCase(), espn });
  if (abort === "caller") return new HttpError({ kind: "aborted", host, espn });
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = ownString(cur, "code");
    if (code !== null) {
      const kind = kindForCode(code);
      if (kind !== null) return new HttpError({ kind, host, causeCode: code, espn });
    }
    if (nameOf(cur) === "TimeoutError") return new HttpError({ kind: "timeout", host, espn });
    cur = causeOf(cur);
  }
  return new HttpError({ kind: "network", host, espn });
}

/**
 * Whether a thrown value is a failure worth retrying in the same run: a retryable HttpError, or a
 * raw error whose `cause` chain carries a known retryable code (a source that did not go through
 * src/http). Unknown failures are not retried (plan 01 §6 "backoff only on 429/5xx/timeouts").
 */
export function isRetryableError(e: unknown): boolean {
  if (e instanceof HttpError) return e.retryable;
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = ownString(cur, "code");
    const kind = code === null ? null : kindForCode(code);
    if (kind !== null) return RETRYABLE_KINDS.has(kind);
    if (nameOf(cur) === "TimeoutError") return true;
    cur = causeOf(cur);
  }
  return false;
}

/**
 * Whether a thrown value is an upstream outage (any network failure, retryable or not) rather than
 * our own policy refusal or a caller abort — what a refresh records as an upstream error.
 */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof HttpError) return !POLICY_KINDS.has(e.kind) && e.kind !== "aborted";
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = ownString(cur, "code");
    if (code !== null && kindForCode(code) !== null) return true;
    const name = nameOf(cur);
    if (name === "TimeoutError") return true;
    if (name === "TypeError" && ownMessage(cur) === "fetch failed") return true;
    cur = causeOf(cur);
  }
  return false;
}

function ownMessage(e: Error): string | null {
  try {
    return typeof e.message === "string" ? e.message : null;
  } catch {
    return null;
  }
}
