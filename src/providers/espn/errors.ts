// errors.ts — the ESPN response classifier (plan 01 §4.3, §6, §7; plan 02 §2.1; research 03 §A.4,
// §C.3): ESPN's typed error envelope `{"messages":[…],"details":[{"type":…}]}` is read for its
// `details[].type` ONLY (allow-listed, else UNKNOWN — the prose is never read into a result);
// 401/403 on a cookie-bearing request → ESPN_AUTH_REJECTED, NEVER retried (the state machine
// short-circuits further calls), keyless → ESPN_REQUIRES_COOKIES; 404 GENERAL_NOT_FOUND →
// ESPN_LEAGUE_NOT_FOUND; 400 FILTER_LIMIT_MISSING_SORT → INTERNAL (our builder makes it impossible);
// 429/5xx/timeouts retryable; ENOTFOUND/ECONNREFUSED never; a 3xx or a non-JSON 2xx → ESPN_HOST_MOVED.
// Errors carry an own `effCode`/`effDetails` (a provider may not import src/mcp).
import type { RequestOutcome } from "../../config/schema.js";
import type { EspnRoute } from "./path.js";
import { upstreamTypeOrUnknown, type EspnView } from "./types.js";

/** Every way one ESPN request can fail. */
export const ESPN_FAILURE_KINDS = [
  "auth_rejected",
  "requires_cookies",
  "league_not_found",
  "not_found",
  "bad_request",
  "client_error",
  "edge_blocked",
  "rate_limited",
  "server_error",
  "host_moved",
  "malformed",
  "too_large",
  "timeout",
  "network",
  "network_transient",
  "unexpected_status",
] as const;
export type EspnFailureKind = (typeof ESPN_FAILURE_KINDS)[number];

/** The plan 01 §4.3 codes this classifier produces (a subset of src/mcp/errors.ts ERROR_CODES). */
export type EspnErrorCode =
  | "ESPN_AUTH_REJECTED"
  | "ESPN_REQUIRES_COOKIES"
  | "ESPN_LEAGUE_NOT_FOUND"
  | "ESPN_UPSTREAM_UNAVAILABLE"
  | "ESPN_HOST_MOVED"
  | "ESPN_DRIFT_DETECTED"
  | "RATE_LIMITED"
  | "INTERNAL";

/** One kind's consequences: the code, the persisted outcome, whether a retry may cure it. */
export interface FailureSpec {
  readonly effCode: EspnErrorCode;
  readonly outcome: RequestOutcome;
  readonly retryable: boolean;
}

/** The classifier table (plan 01 §6: 400/401/403/404 and ENOTFOUND/ECONNREFUSED never retried). */
export const FAILURE_TABLE: Readonly<Record<EspnFailureKind, FailureSpec>> = Object.freeze({
  auth_rejected: { effCode: "ESPN_AUTH_REJECTED", outcome: "client_error", retryable: false },
  requires_cookies: { effCode: "ESPN_REQUIRES_COOKIES", outcome: "client_error", retryable: false },
  league_not_found: { effCode: "ESPN_LEAGUE_NOT_FOUND", outcome: "client_error", retryable: false },
  not_found: { effCode: "ESPN_UPSTREAM_UNAVAILABLE", outcome: "client_error", retryable: false },
  bad_request: { effCode: "INTERNAL", outcome: "client_error", retryable: false },
  client_error: { effCode: "ESPN_UPSTREAM_UNAVAILABLE", outcome: "client_error", retryable: false },
  edge_blocked: { effCode: "ESPN_UPSTREAM_UNAVAILABLE", outcome: "client_error", retryable: false },
  rate_limited: { effCode: "RATE_LIMITED", outcome: "rate_limited", retryable: true },
  server_error: { effCode: "ESPN_UPSTREAM_UNAVAILABLE", outcome: "server_error", retryable: true },
  host_moved: { effCode: "ESPN_HOST_MOVED", outcome: "client_error", retryable: false },
  malformed: { effCode: "ESPN_UPSTREAM_UNAVAILABLE", outcome: "server_error", retryable: false },
  too_large: { effCode: "ESPN_UPSTREAM_UNAVAILABLE", outcome: "server_error", retryable: false },
  timeout: { effCode: "ESPN_UPSTREAM_UNAVAILABLE", outcome: "timeout", retryable: true },
  network: { effCode: "ESPN_UPSTREAM_UNAVAILABLE", outcome: "network_error", retryable: false },
  network_transient: {
    effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    outcome: "network_error",
    retryable: true,
  },
  unexpected_status: {
    effCode: "ESPN_UPSTREAM_UNAVAILABLE",
    outcome: "server_error",
    retryable: false,
  },
});

/** Value-free details an ESPN error carries into the result (re-validated by src/mcp/errors.ts). */
export interface EspnErrorDetails {
  readonly upstream_status?: number;
  readonly upstream_type?: string;
  readonly view?: EspnView;
  readonly path?: string;
  readonly retry_after_s?: number;
  readonly reason?: string;
}

/**
 * A classified ESPN failure. The message is a fixed string (never upstream text, never a URL).
 * `retryAfterMs` is ESPN's `Retry-After` when it ever sends one (never observed — research 03 §A.4).
 */
export class EspnUpstreamError extends Error {
  readonly effCode: EspnErrorCode;
  readonly effDetails: EspnErrorDetails;
  readonly kind: EspnFailureKind;
  readonly outcome: RequestOutcome;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(
    kind: EspnFailureKind,
    details: EspnErrorDetails = {},
    opts: { readonly retryAfterMs?: number | null; readonly cause?: unknown } = {},
  ) {
    super(`espn: ${kind}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "EspnUpstreamError";
    const spec = FAILURE_TABLE[kind];
    this.kind = kind;
    this.effCode = spec.effCode;
    this.outcome = spec.outcome;
    this.retryable = spec.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.effDetails = Object.freeze({ ...details });
  }
}

/** Whether a thrown value is a classified ESPN failure. */
export function isEspnUpstreamError(e: unknown): e is EspnUpstreamError {
  return e instanceof EspnUpstreamError;
}

/** A drift failure: a missing required key or a skeleton (plan 01 §7) — never retried, never cached. */
export class EspnDriftError extends Error {
  readonly effCode = "ESPN_DRIFT_DETECTED" as const;
  readonly effDetails: { readonly view: EspnView; readonly path: string };
  constructor(view: EspnView, path: string) {
    super("espn: drift detected");
    this.name = "EspnDriftError";
    this.effDetails = Object.freeze({ view, path });
  }
}

const JSON_CT_RE = /^\s*application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;
/** Only this much of an error body is ever parsed for its `details[].type`. */
export const ERROR_BODY_PARSE_MAX = 64 * 1024;

/** Whether a content-type header names JSON (`application/json`, `application/x+json`, params ok). */
export function isJsonContentType(ct: string | null | undefined): boolean {
  return typeof ct === "string" && JSON_CT_RE.test(ct);
}

/**
 * The allow-listed `details[0].type` of an ESPN error body (research 03 §A.4), `UNKNOWN` for a JSON
 * body whose type is off the list, or null when there is no typed JSON body at all. Never throws.
 */
export function upstreamTypeOf(contentType: string | null, bodyText: string): string | null {
  if (!isJsonContentType(contentType) || bodyText.length > ERROR_BODY_PARSE_MAX) return null;
  try {
    const b = JSON.parse(bodyText) as unknown;
    if (typeof b !== "object" || b === null || Array.isArray(b)) return null;
    const details = (b as { details?: unknown }).details;
    if (!Array.isArray(details) || details.length === 0) return null;
    const first: unknown = details[0];
    if (typeof first !== "object" || first === null) return null;
    return upstreamTypeOrUnknown((first as { type?: unknown }).type);
  } catch {
    return null;
  }
}

/** `Retry-After` in ms when it is a small integer of seconds; else null (an HTTP-date is ignored). */
export function retryAfterMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^\s*\d{1,5}\s*$/.test(value)) return null;
  return Number(value.trim()) * 1000;
}

/** What the classifier needs to know about one answered request. */
export interface AnsweredRequest {
  readonly status: number;
  readonly contentType: string | null;
  readonly bodyText: string;
  readonly retryAfter: string | null;
  readonly cookieBearing: boolean;
  readonly route: EspnRoute;
  readonly view: EspnView;
}

/**
 * Classifies an answered request: null for a 2xx with a JSON content type (the caller parses it);
 * otherwise the failure. 3xx is never followed — it is ESPN_HOST_MOVED (research 03 §A.1 P02).
 */
export function classifyAnswer(r: AnsweredRequest): EspnUpstreamError | null {
  const status = r.status;
  const type = upstreamTypeOf(r.contentType, r.bodyText);
  const details: EspnErrorDetails = {
    upstream_status: status,
    view: r.view,
    ...(type === null ? {} : { upstream_type: type }),
  };
  if (status >= 200 && status <= 299)
    return isJsonContentType(r.contentType)
      ? null
      : new EspnUpstreamError("host_moved", { ...details, reason: "non_json_body" });
  if (status >= 300 && status <= 399)
    return new EspnUpstreamError("host_moved", { ...details, reason: "redirect_not_followed" });
  if (status === 401 || status === 403) {
    if (r.cookieBearing) return new EspnUpstreamError("auth_rejected", details);
    if (!isJsonContentType(r.contentType)) return new EspnUpstreamError("edge_blocked", details);
    return new EspnUpstreamError("requires_cookies", details);
  }
  if (status === 404)
    return new EspnUpstreamError(
      type === "GENERAL_NOT_FOUND" && (r.route === "league" || r.route === "communication")
        ? "league_not_found"
        : "not_found",
      details,
    );
  if (status === 429) {
    const after = retryAfterMs(r.retryAfter);
    return new EspnUpstreamError(
      "rate_limited",
      after === null ? details : { ...details, retry_after_s: after / 1000 },
      { retryAfterMs: after },
    );
  }
  if (status >= 500 && status <= 599)
    return new EspnUpstreamError("server_error", details, {
      retryAfterMs: retryAfterMs(r.retryAfter),
    });
  if (status === 400 || status === 405) return new EspnUpstreamError("bad_request", details);
  if (status >= 400 && status <= 499) return new EspnUpstreamError("client_error", details);
  return new EspnUpstreamError("unexpected_status", details);
}

/** Network failure codes that are never retried (plan 01 §6: they fail fast). */
export const FAIL_FAST_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function ownCode(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const c = Object.prototype.hasOwnProperty.call(e, "code")
    ? (e as { code?: unknown }).code
    : undefined;
  return typeof c === "string" ? c : null;
}

/**
 * Classifies a thrown fetch failure: our own attempt timeout → `timeout` (retryable, counted by the
 * breaker); a fail-fast DNS/refused code anywhere in the cause chain → `network` (never retried);
 * anything else (resets, sockets, `fetch failed`) → `network_transient` (retryable).
 */
export function classifyThrown(e: unknown, timedOut: boolean, view: EspnView): EspnUpstreamError {
  if (timedOut) return new EspnUpstreamError("timeout", { view, reason: "attempt_timeout" });
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur !== undefined && cur !== null; depth++) {
    const code = ownCode(cur);
    if (code !== null && FAIL_FAST_NETWORK_CODES.has(code))
      return new EspnUpstreamError("network", { view, reason: "unreachable" }, { cause: e });
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return new EspnUpstreamError("network_transient", { view, reason: "network" }, { cause: e });
}
