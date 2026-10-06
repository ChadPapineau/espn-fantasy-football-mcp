// errors.ts — the analytics engines' one error type (plan 01 §4.3 codes through the cross-layer
// `effCode`/`effDetails` the MCP error mapper honours — src/mcp/errors.ts; plan 07 E1 "S missing →
// no projection (the engine refuses)", E2/E3 degradations, E5 "faab is P1").
// Ported from sibling @f6ba81e (src/domain/analytics/errors.ts), adapted (effCode, ESPN codes).

/** Why an engine refused (fixed vocabulary). */
export type AnalyticsErrorCode =
  /** The request is outside what the engine accepts (bounds, positions, empty roster). */
  | "invalid_request"
  /** The league's scoring settings are missing (plan 07 E1: the engine refuses). */
  | "no_settings"
  /** A required dataset was never loaded (no file attached). */
  | "dataset_never_loaded"
  /** A capability that is not P0 (E5 `mode: faab`, usage-first detection). */
  | "not_in_phase";

const EFF_CODE = Object.freeze({
  invalid_request: "VALIDATION",
  no_settings: "STALE_ONLY",
  dataset_never_loaded: "STALE_ONLY",
  not_in_phase: "VALIDATION",
} as const);

/** Field paths and reasons the mapper accepts (src/mcp/errors.ts SAFE_FIELD_RE / SAFE_REASON). */
const FIELD_RE = /^[A-Za-z0-9_.[\]]{1,80}$/;

/** A refusal by an analytics engine; `effCode` is what src/mcp/errors.ts maps. */
export class AnalyticsError extends Error {
  override readonly name = "AnalyticsError";
  readonly code: AnalyticsErrorCode;
  /** The plan 01 §4.3 code the MCP layer answers with. */
  readonly effCode: (typeof EFF_CODE)[AnalyticsErrorCode];
  /** Fixed-vocabulary details for the mapper (`field`, `reason`) — never data values. */
  readonly effDetails: { readonly field?: string; readonly reason: string };

  constructor(code: AnalyticsErrorCode, message: string, field?: string) {
    super(message);
    this.code = code;
    this.effCode = EFF_CODE[code];
    this.effDetails =
      field !== undefined && FIELD_RE.test(field) ? { field, reason: code } : { reason: code };
  }
}

/** Throws `invalid_request` unless `ok`. */
export function ensure(ok: boolean, message: string, field?: string): asserts ok {
  if (!ok) throw new AnalyticsError("invalid_request", message, field);
}
