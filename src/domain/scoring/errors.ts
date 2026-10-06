// errors.ts — the scoring engine's one error type: plan 08 §3.1 ("fail loudly" normaliser errors),
// §3.3 (a non-numeric ESPN value fails the entry as drift), §4.1 (bracket overlap / exclusivity →
// INTERNAL naming the family), P11 (no NaN reaches a score). Ported from sibling @cf3b015, adapted.

/** Why the engine refused (a fixed vocabulary; `detail` names the offending ids/families). */
export type ScoringErrorCode =
  /** A settings field is malformed or out of range (the normaliser refused it). */
  | "invalid_settings"
  /** Two rules map to one canonical name in one position class (plan 08 §3.1). */
  | "duplicate_canonical"
  /** A bracket family overlaps, or a union id is scored beside its parts (plan 08 §4.1). */
  | "bracket_bounds"
  /** An exclusive family has two members set, or a member outside [0, 1] (plan 08 §4.1). */
  | "bracket_exclusivity"
  /** A stat line is malformed: non-finite / absurd value, bad position or class (P11). */
  | "invalid_line"
  /** An ESPN wire value is not what the contract says (plan 08 §3.3: fails the entry). */
  | "drift";

/** The most `detail` entries kept, and the longest one — hostile names can never bloat an error. */
const MAX_DETAIL = 10;
const MAX_DETAIL_LEN = 80;

/** A refusal by the scoring engine. The MCP layer classifies it as INTERNAL (plan 01 §4.3). */
export class ScoringError extends Error {
  override readonly name = "ScoringError";
  /** Fixed-vocabulary reason. */
  readonly code: ScoringErrorCode;
  /** The offending canonical names, ESPN stat ids or family names (truncated, at most 10). */
  readonly detail: readonly string[];

  constructor(code: ScoringErrorCode, message: string, detail: readonly string[] = []) {
    const kept = detail.slice(0, MAX_DETAIL).map((d) => d.slice(0, MAX_DETAIL_LEN));
    super(kept.length > 0 ? `${message}: ${kept.join(", ")}` : message);
    this.code = code;
    this.detail = Object.freeze(kept);
  }
}
