// errors.ts — the plan 01 §4.3 error-code table as data, the EffError class, and the one mapper
// from any thrown value to a tool error result (`isError: true`). Messages and hints are fixed
// strings from the table: never an upstream body, never a stack, never a thrown object's message,
// never a secret; the only upstream string that may appear is an allow-listed `details[].type`
// (`upstream_type`, else `UNKNOWN`). The 401 message never says "expired" as a fact (the read host
// cannot tell expired from not-your-league — research 03 §C.3); the hint says "usually".
// Ported from sibling @d72e03b, adapted (ESPN codes; the cross-layer `effCode`/`effDetails`).
// SDK note (sibling critic C-02): SDK 2.2.0 validates inputSchema before the handler with its own
// free-text error, so tools register `deferValidation(schema)` with `wrapHandler(schema, fn)`.
import { randomBytes } from "node:crypto";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod/v4";
import { isEspnView, upstreamTypeOrUnknown } from "../providers/platform.js";
import { INVALID_ID_MESSAGE, REQUEST_ID_RE, type ToolSuccessResult } from "./envelope.js";

/** Every tool error code (plan 01 §4.3; UPSTREAM_UNAVAILABLE is the shared name of §0.4). */
export const ERROR_CODES = [
  "ESPN_AUTH_REJECTED",
  "ESPN_REQUIRES_COOKIES",
  "ESPN_DRIFT_DETECTED",
  "ESPN_UPSTREAM_UNAVAILABLE",
  "ESPN_LEAGUE_NOT_FOUND",
  "ESPN_HOST_MOVED",
  "RATE_LIMITED",
  "STALE_ONLY",
  "VALIDATION",
  "NOT_FOUND",
  "UPSTREAM_UNAVAILABLE",
  // PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; D11): nothing raises the six gate codes below.
  "WRITES_DISABLED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "PRECONDITION_CHANGED",
  "CONFIRMATION_DENIED",
  "ESPN_TRANSACTION_REJECTED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** One row of the error table. */
export interface ErrorSpec {
  readonly message: string;
  readonly hint: string;
  readonly retryable: boolean;
}

/** The error table (plan 01 §4.3). The gate codes are kept so the contract is complete (Phase W). */
// prettier-ignore
export const ERROR_TABLE: Readonly<Record<ErrorCode, ErrorSpec>> = Object.freeze({
  ESPN_AUTH_REJECTED: {
    message: "ESPN did not accept the stored session cookies for this league.",
    hint: "In a terminal run: eff setup — then retry here. This usually means espn_s2 expired; cookie-bearing calls stay paused until setup or a successful re-check (espn_check_auth, eff doctor --online, or the daily check).",
    retryable: false,
  },
  ESPN_REQUIRES_COOKIES: {
    message: "This needs your ESPN session cookies, and none are stored.",
    hint: "In a terminal run: eff setup (never paste cookies into chat), then retry here.",
    retryable: false,
  },
  ESPN_DRIFT_DETECTED: {
    message: "ESPN's response no longer has the shape this server expects.",
    hint: "A human must review the change: espn_get_status shows the diff. Cached data may still answer with allow_stale: true.",
    retryable: false,
  },
  ESPN_UPSTREAM_UNAVAILABLE: {
    message: "ESPN could not be reached or answered with an error.",
    hint: "Retry shortly; espn_get_status shows the breaker and the last success.",
    retryable: true,
  },
  ESPN_LEAGUE_NOT_FOUND: {
    message: "ESPN has no league with the configured id for this season.",
    hint: "Check ESPN_LEAGUE_ID and ESPN_SEASON with eff doctor --online in a terminal.",
    retryable: false,
  },
  ESPN_HOST_MOVED: {
    message: "ESPN's read host answered with a redirect or a non-JSON body.",
    hint: "ESPN moved its API: retry with allow_stale: true for cached data; the operator override EFF_ESPN_READ_HOST (hours) or a release (days) fixes it.",
    retryable: false,
  },
  RATE_LIMITED: {
    message: "The request budget for ESPN is exhausted for now.",
    hint: "Wait retry_after_s seconds, then retry once.",
    retryable: true,
  },
  STALE_ONLY: {
    message: "Only data older than its hard limit is available.",
    hint: "Retry with allow_stale: true, or run eff refresh <source> in a terminal.",
    retryable: true,
  },
  VALIDATION: {
    message: "The arguments are invalid.",
    hint: "Check field and reason, fix the arguments, and call again.",
    retryable: false,
  },
  NOT_FOUND: {
    message: "The requested team, player or week is not in this league.",
    hint: "Check the id or week; list tools return valid ids.",
    retryable: false,
  },
  UPSTREAM_UNAVAILABLE: {
    message: "An upstream data source could not be reached.",
    hint: "Retry shortly; espn_get_status shows each source's last success.",
    retryable: true,
  },
  WRITES_DISABLED: {
    message: "Writes are not available: this server is read-only.",
    hint: "Make the change in the ESPN app or website.",
    retryable: false,
  },
  CONFIRMATION_REQUIRED: {
    message: "This write needs a human confirmation first.",
    hint: "Follow how_to_confirm from the prepare result.",
    retryable: false,
  },
  CONFIRMATION_EXPIRED: {
    message: "The prepared write expired before it was confirmed.",
    hint: "Prepare it again and show the new diff to the user.",
    retryable: false,
  },
  PRECONDITION_CHANGED: {
    message: "The roster, lock state or scoring period changed since the write was prepared.",
    hint: "Prepare it again and show the new diff to the user.",
    retryable: false,
  },
  CONFIRMATION_DENIED: {
    message: "The user did not approve the prepared write.",
    hint: "Do not retry unless the user asks again.",
    retryable: false,
  },
  ESPN_TRANSACTION_REJECTED: {
    message: "ESPN rejected the transaction.",
    hint: "upstream_type carries ESPN's reason; prepare again after fixing it.",
    retryable: false,
  },
  INTERNAL: {
    message: "Internal server error.",
    hint: "The server log (stderr) has details under this request_id.",
    retryable: false,
  },
});

/** Whether a value is a known error code. */
export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v);
}

/** Server-authored hints that may replace a table hint (never text from a file or upstream). */
export const SERVER_HINTS = Object.freeze({
  datasetNeverLoaded: "That dataset was never loaded: run eff refresh in a terminal, then retry.",
  myTeamUnresolved: "Pass team_id, or run eff setup in a terminal so your team is recorded.",
  weekOutOfRange: "week is 1-18; kicker weeks 19-22 appear only inside ESPN's own splits.",
  seasonTooOld: "Seasons before 2018 use a different ESPN route and are not supported.",
  scoringRefused: "Scoring does not reproduce ESPN for this league: run the onboard Skill.",
  checkAuthTooSoon: "espn_check_auth runs at most once per minute; wait retry_after_s seconds.",
});
const SERVER_HINT_SET: ReadonlySet<string> = new Set(Object.values(SERVER_HINTS));

/** Value-free extras an error may carry into the result (each re-validated by the mapper). */
export interface EffErrorDetails {
  /** VALIDATION: the argument path, e.g. `players.player_ids[2]`. */
  readonly field?: string;
  /** VALIDATION: a short fixed reason code, e.g. `too_big`, `invalid_id`. */
  readonly reason?: string;
  /** RATE_LIMITED: seconds to wait. */
  readonly retry_after_s?: number;
  readonly upstream_status?: number;
  /** An ESPN `details[].type`; anything off the allow-list becomes `UNKNOWN`. */
  readonly upstream_type?: string;
  /** ESPN_DRIFT_DETECTED: the view (whitelisted name) and the JSON path (ESPN key vocabulary). */
  readonly view?: string;
  readonly path?: string;
  /** One of SERVER_HINTS. */
  readonly hint?: string;
}

/**
 * The server's coded error. Its `message` is the table's fixed text. Layers that may not import
 * src/mcp (providers, store, auth, config) throw their own Errors carrying an own `effCode`
 * property and, optionally, an own `effDetails` object — the mapper honours both.
 */
export class EffError extends Error {
  readonly code: ErrorCode;
  readonly effCode: ErrorCode;
  readonly details: EffErrorDetails;
  constructor(code: ErrorCode, details: EffErrorDetails = {}, options?: { cause?: unknown }) {
    super(ERROR_TABLE[code].message, options);
    this.name = "EffError";
    this.code = code;
    this.effCode = code;
    this.details = details;
  }
}

/** The JSON body of an error result (plan 01 §4.3 shape). */
export interface ToolErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly hint: string;
    readonly retryable: boolean;
    readonly request_id: string;
    readonly field?: string;
    readonly reason?: string;
    readonly retry_after_s?: number;
    readonly upstream_status?: number;
    readonly upstream_type?: string;
    readonly view?: string;
    readonly path?: string;
  };
}

/** An MCP tool error result (in-process form, with structuredContent). */
export interface ToolErrorResult {
  readonly isError: true;
  readonly content: [{ type: "text"; text: string }];
  readonly structuredContent: ToolErrorBody & Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** The wire form: the text block only — a tool's outputSchema describes its success envelope. */
export interface ToolWireErrorResult {
  readonly isError: true;
  readonly content: [{ type: "text"; text: string }];
  readonly [key: string]: unknown;
}

/** A fresh request id: `r-` + 12 hex chars (links a result to its stderr log lines). */
export function newRequestId(): string {
  return `r-${randomBytes(6).toString("hex")}`;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_]{1,40}$/;
const SAFE_REASON = /^[a-z_]{1,40}$/;
const SAFE_JSON_PATH = /^[A-Za-z0-9_.[\]<>]{1,120}$/;

/** Renders a zod issue path safely: odd segments become `?` (keys may be attacker-chosen). */
export function safeFieldPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path.slice(0, 8)) {
    if (typeof seg === "number" && Number.isInteger(seg) && seg >= 0 && seg < 100_000)
      out += `[${String(seg)}]`;
    else if (typeof seg === "string" && SAFE_SEGMENT.test(seg)) out += out === "" ? seg : `.${seg}`;
    else out += out === "" ? "?" : ".?";
  }
  return out === "" ? "(root)" : out;
}

/** Network failure codes that classify as ESPN_UPSTREAM_UNAVAILABLE (plan 01 §6), never INTERNAL. */
export const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function ownProp(o: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key)
    ? (o as Record<string, unknown>)[key]
    : undefined;
}

function isZodError(
  e: unknown,
): e is { issues: { code?: unknown; path?: unknown; message?: unknown }[] } {
  return (
    e instanceof Error && e.name === "ZodError" && Array.isArray((e as { issues?: unknown }).issues)
  );
}

/** Whether a thrown value is a network failure (system error, undici, fetch TypeError, abort/timeout). */
export function isNetworkError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 4; depth++) {
    const code = ownProp(cur, "code");
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
    if (cur.name === "TimeoutError" || cur.name === "AbortError") return true;
    if (cur.name === "TypeError" && cur.message === "fetch failed") return true;
    cur = cur.cause;
  }
  return false;
}

/** Re-validates cross-layer details into the value-free subset (anything odd is dropped). */
function sanitizeDetails(raw: unknown): EffErrorDetails {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, unknown> = {};
  const status = ownProp(raw, "upstream_status");
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
    out.upstream_status = status;
  const type = ownProp(raw, "upstream_type");
  if (type !== undefined) out.upstream_type = upstreamTypeOrUnknown(type);
  const retry = ownProp(raw, "retry_after_s");
  if (typeof retry === "number" && Number.isFinite(retry) && retry >= 0) out.retry_after_s = retry;
  const view = ownProp(raw, "view");
  if (typeof view === "string" && isEspnView(view)) out.view = view;
  const path = ownProp(raw, "path");
  if (typeof path === "string" && SAFE_JSON_PATH.test(path)) out.path = path;
  const hint = ownProp(raw, "hint");
  if (typeof hint === "string" && SERVER_HINT_SET.has(hint)) out.hint = hint;
  const reason = ownProp(raw, "reason");
  if (typeof reason === "string" && SAFE_REASON.test(reason)) out.reason = reason;
  return out;
}

/**
 * Classifies any thrown value to a code + value-free details. Never reads a foreign message; a
 * hostile value (throwing getters, proxies) classifies as INTERNAL instead of throwing.
 */
export function classifyError(e: unknown): { code: ErrorCode; details: EffErrorDetails } {
  try {
    return classifyUnsafe(e);
  } catch {
    return { code: "INTERNAL", details: {} };
  }
}

function classifyUnsafe(e: unknown): { code: ErrorCode; details: EffErrorDetails } {
  if (e instanceof EffError) return { code: e.code, details: e.details };
  if (isZodError(e)) {
    const first = e.issues[0];
    const path = Array.isArray(first?.path) ? (first.path as PropertyKey[]) : [];
    const reasonRaw = typeof first?.code === "string" ? first.code : "invalid";
    const field = safeFieldPath(path);
    if (first?.message === INVALID_ID_MESSAGE)
      return { code: "VALIDATION", details: { field, reason: "invalid_id" } };
    return {
      code: "VALIDATION",
      details: {
        field: reasonRaw === "unrecognized_keys" ? `${field} (unknown key)` : field,
        reason: SAFE_REASON.test(reasonRaw) ? reasonRaw : "invalid",
      },
    };
  }
  if (e instanceof Error) {
    const code = ownProp(e, "effCode");
    if (isErrorCode(code)) return { code, details: sanitizeDetails(ownProp(e, "effDetails")) };
    if (isNetworkError(e)) return { code: "ESPN_UPSTREAM_UNAVAILABLE", details: {} };
  }
  return { code: "INTERNAL", details: {} };
}

/**
 * Maps ANY thrown value to a tool error result (plan 01 §4.3). Message and hint come from the
 * table (a SERVER_HINTS hint may replace the table hint); the only caller-derived content is the
 * re-validated details. `structuredContent` is for in-process callers; the wire uses `toWireError`.
 */
export function toToolError(e: unknown, requestId: string): ToolErrorResult {
  const { code, details } = classifyError(e);
  const spec = ERROR_TABLE[code];
  const error: Record<string, unknown> = {
    code,
    message: spec.message,
    hint:
      typeof details.hint === "string" && SERVER_HINT_SET.has(details.hint)
        ? details.hint
        : spec.hint,
    retryable: spec.retryable,
    request_id: REQUEST_ID_RE.test(requestId) ? requestId : "r-unknown",
  };
  if (typeof details.field === "string") error.field = details.field.slice(0, 120);
  if (typeof details.reason === "string" && SAFE_REASON.test(details.reason))
    error.reason = details.reason;
  if (
    typeof details.retry_after_s === "number" &&
    Number.isFinite(details.retry_after_s) &&
    details.retry_after_s >= 0
  )
    error.retry_after_s = Math.min(Math.ceil(details.retry_after_s), 86_400);
  if (
    typeof details.upstream_status === "number" &&
    Number.isInteger(details.upstream_status) &&
    details.upstream_status >= 100 &&
    details.upstream_status <= 599
  )
    error.upstream_status = details.upstream_status;
  if (details.upstream_type !== undefined)
    error.upstream_type = upstreamTypeOrUnknown(details.upstream_type);
  if (typeof details.view === "string" && isEspnView(details.view)) error.view = details.view;
  if (typeof details.path === "string" && SAFE_JSON_PATH.test(details.path))
    error.path = details.path;
  const body = { error } as unknown as ToolErrorBody & Readonly<Record<string, unknown>>;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

/** The wire form of an error result: the same text block, no structuredContent. */
export function toWireError(e: unknown, requestId: string): ToolWireErrorResult {
  return { isError: true, content: toToolError(e, requestId).content };
}

/**
 * A log-safe description of a thrown value for the stderr logger (which redacts and truncates
 * further): name/code/message and one level of cause — never sent to a client.
 */
export function describeForLog(e: unknown): Record<string, unknown> {
  try {
    if (!(e instanceof Error)) return { thrown: typeof e };
    const out: Record<string, unknown> = { name: e.name, message: e.message };
    const code = ownProp(e, "code") ?? ownProp(e, "effCode");
    if (typeof code === "string") out.code = code;
    if (e.cause !== undefined)
      out.cause =
        e.cause instanceof Error
          ? { name: e.cause.name, message: e.cause.message }
          : typeof e.cause;
    return out;
  } catch {
    return { thrown: "unreadable" };
  }
}

// --- SDK integration: deferred validation + the handler wrapper -------------------------------------

/**
 * A Standard Schema for `registerTool({ inputSchema })` that ADVERTISES `schema`'s JSON Schema but
 * passes arguments through unvalidated, so validation happens in `wrapHandler` and its failures
 * become coded VALIDATION results instead of the SDK's free-text error (which echoes paths).
 */
export function deferValidation(schema: z.ZodType): StandardSchemaWithJSON<unknown, unknown> {
  const std = schema["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "eff-deferred",
      validate: (value: unknown) => ({ value }),
      jsonSchema: std.jsonSchema,
    },
  };
}

/** What `wrapHandler` gives a tool implementation besides its parsed arguments. */
export interface HandlerContext {
  /** This call's request id: put it in `meta.request_id` and every log line. */
  readonly requestId: string;
}

/** Options for `wrapHandler`. */
export interface WrapOptions {
  readonly onError?: (e: unknown, requestId: string) => void;
  readonly newId?: () => string;
}

/**
 * Wraps a tool implementation so no code path can skip the error contract: mints the request id,
 * parses the raw arguments with `schema` (failure → VALIDATION), runs `fn`, and maps ANY throw.
 */
export function wrapHandler<S extends z.ZodType>(
  schema: S,
  fn: (args: z.output<S>, ctx: HandlerContext) => Promise<ToolSuccessResult> | ToolSuccessResult,
  opts: WrapOptions = {},
): (raw: unknown) => Promise<ToolSuccessResult | ToolWireErrorResult> {
  return async (raw: unknown) => {
    const requestId = (opts.newId ?? newRequestId)();
    try {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) return toWireError(parsed.error, requestId);
      return await fn(parsed.data, { requestId });
    } catch (e) {
      try {
        opts.onError?.(e, requestId);
      } catch {
        // a failing logger must not change the result
      }
      return toWireError(e, requestId);
    }
  };
}
