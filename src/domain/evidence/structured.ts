// structured.ts — the structured-field comparator E10 is P1 for (plan 07 E10 "news-vs-stats
// disagreement flags with the structured-field comparator ESPN makes possible": `OUT` in slot 21 vs
// "cleared to play"; research 05 §6 rule 3 "structured fields win: injuryStatus, lineupSlotId,
// stats[], waiverProcessDate override any claim in text about the same fact"; case 3 → "the text
// becomes a claim_type: availability item … with a 'structured field disagrees' note"; plan 10 B8
// "`structured_disagrees` fires on `inj-ir-cleared` naming `injury_status`").
//
// The comparison is between CLASSES, not labels: ESPN's enum and the claim's designation each read
// as plays / uncertain / out (claims.ts `availabilityClass`), and only the two ends disagree — a
// questionable tag is consistent with any report, an OUT tag is not consistent with "cleared to
// play". The claim never changes the structured value; the comparator only names the conflict, and
// the caller keeps the structured value (no move is ever derived from the text).
//
// The claim's side is what it states OR IMPLIES about his availability (claims.ts
// `claimAvailability`; Stage C finding evidence-availability-claims-missed): "will start Sunday" is
// a role claim, and a start says he plays, so against an OUT player it names `injury_status` with
// `claim_value: "will_play"` like "will play Sunday" does — a start/sit decision hinges on exactly
// that contradiction.
import type { InjuryStatus } from "../league/types.js";
import {
  availabilityClass,
  claimAvailability,
  type AvailabilityClass,
  type RulesV1Claim,
} from "./claims.js";

/** The structured facts a claim is compared with (ESPN's view of the player). */
export interface StructuredFacts {
  /** ESPN `injuryStatus` (null = ESPN carries none: nothing to compare). */
  readonly injury_status: InjuryStatus | null;
}

/** E10 `structured_disagrees` (the subset this comparator decides: `injury_status`). */
export interface StructuredDisagreement {
  readonly field: "injury_status";
  readonly structured_value: string;
  readonly claim_value: string;
}

const STATUS_CLASS: Readonly<Record<string, AvailabilityClass>> = Object.freeze({
  ACTIVE: "plays",
  QUESTIONABLE: "uncertain",
  DAY_TO_DAY: "uncertain",
  DOUBTFUL: "out",
  OUT: "out",
  INJURY_RESERVE: "out",
  SUSPENSION: "out",
});

/** The availability class of an ESPN injury status; null for null or a status ESPN added later. */
export function statusClass(status: InjuryStatus | null): AvailabilityClass | null {
  if (status === null || !Object.prototype.hasOwnProperty.call(STATUS_CLASS, status)) return null;
  return STATUS_CLASS[status] ?? null;
}

/**
 * The disagreement between the availability a claim states or implies (`claimAvailability`: an
 * availability claim's designation, or a start's `will_play`) and ESPN's injury status, or null (no
 * claim, nothing it says about his availability, an unknown status, or the classes are not opposite
 * ends).
 */
export function structuredDisagreement(
  claim: RulesV1Claim | null,
  facts: StructuredFacts,
): StructuredDisagreement | null {
  const said = claimAvailability(claim);
  if (said === null) return null;
  const s = statusClass(facts.injury_status);
  if (s === null || facts.injury_status === null) return null;
  const c = availabilityClass(said);
  const opposite = (s === "plays" && c === "out") || (s === "out" && c === "plays");
  return opposite
    ? {
        field: "injury_status",
        structured_value: facts.injury_status,
        claim_value: said,
      }
    : null;
}
