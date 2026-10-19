// errors.ts — the analytics engines' one error type (plan 01 §4.3 codes through the cross-layer
// `effCode`/`effDetails` the MCP error mapper honours — src/mcp/errors.ts; plan 07 E1 "S missing →
// no projection (the engine refuses)", E2/E3 degradations, E5 "faab is P1").
// Ported from sibling @f6ba81e (src/domain/analytics/errors.ts), adapted (effCode, ESPN codes).
// Stage C round 2 (finding analytics-empty-roster-validation): an empty roster is a league state —
// before the draft every roster is empty — not an argument error, so it is refused as `roster_empty`
// (plan 01 §4.3 NOT_FOUND, reason `roster_empty`, with a fixed server message and hint), never as
// VALIDATION's "fix the arguments".

/** Why an engine refused (fixed vocabulary). */
export type AnalyticsErrorCode =
  /** The request is outside what the engine accepts (bounds, positions, duplicates). */
  | "invalid_request"
  /** The roster the call is about has no players (a league state: the draft has not filled it). */
  | "roster_empty"
  /** The league's scoring settings are missing (plan 07 E1: the engine refuses). */
  | "no_settings"
  /** A required dataset was never loaded (no file attached). */
  | "dataset_never_loaded"
  /** A capability that is not P0 (E5 `mode: faab`, usage-first detection). */
  | "not_in_phase";

const EFF_CODE = Object.freeze({
  invalid_request: "VALIDATION",
  roster_empty: "NOT_FOUND",
  no_settings: "STALE_ONLY",
  dataset_never_loaded: "STALE_ONLY",
  not_in_phase: "VALIDATION",
} as const);

/**
 * The fixed server texts a `roster_empty` refusal carries (plan 01 §4.3: messages are fixed strings
 * from a table). The MCP mapper shows a `message` / `hint` only when its own server table lists the
 * same string (src/mcp/errors.ts SERVER_MESSAGES / SERVER_HINTS), never text from data.
 */
export const ROSTER_EMPTY_TEXT = Object.freeze({
  message: "The roster has no players yet.",
  hint: "A roster is empty until the league's draft fills it: there is nothing to analyse until then.",
});

/** Field paths and reasons the mapper accepts (src/mcp/errors.ts SAFE_FIELD_RE / SAFE_REASON). */
const FIELD_RE = /^[A-Za-z0-9_.[\]]{1,80}$/;

/** The value-free details the mapper re-validates (src/mcp/errors.ts sanitizeDetails). */
export interface AnalyticsErrorDetails {
  readonly field?: string;
  readonly reason: string;
  /** One of the fixed server messages (ROSTER_EMPTY_TEXT); never data. */
  readonly message?: string;
  /** One of the fixed server hints (ROSTER_EMPTY_TEXT); never data. */
  readonly hint?: string;
}

/** A refusal by an analytics engine; `effCode` is what src/mcp/errors.ts maps. */
export class AnalyticsError extends Error {
  override readonly name = "AnalyticsError";
  readonly code: AnalyticsErrorCode;
  /** The plan 01 §4.3 code the MCP layer answers with. */
  readonly effCode: (typeof EFF_CODE)[AnalyticsErrorCode];
  /** Fixed-vocabulary details for the mapper (`field`, `reason`, the fixed texts) — never data values. */
  readonly effDetails: AnalyticsErrorDetails;

  constructor(code: AnalyticsErrorCode, message: string, field?: string) {
    super(message);
    this.code = code;
    this.effCode = EFF_CODE[code];
    const base =
      field !== undefined && FIELD_RE.test(field) ? { field, reason: code } : { reason: code };
    this.effDetails =
      code === "roster_empty"
        ? { ...base, message: ROSTER_EMPTY_TEXT.message, hint: ROSTER_EMPTY_TEXT.hint }
        : base;
  }
}

/** Throws `invalid_request` unless `ok`. */
export function ensure(ok: boolean, message: string, field?: string): asserts ok {
  if (!ok) throw new AnalyticsError("invalid_request", message, field);
}

/**
 * Throws `roster_empty` when the roster the call is about has no player (`count` 0): a league state
 * (before the draft), answered as one — the bounds above it stay `invalid_request`.
 */
export function ensurePlayers(count: number, field: string): void {
  if (count === 0) throw new AnalyticsError("roster_empty", "the roster has no players", field);
}
