// roster.ts — IR eligibility and roster validity (plan 07 B1 `ir`, `empty_starting_slots[]`,
// `counts`; research 05 §4.3: only OUT or IR may move into the IR slot, SSPD never; a player whose
// designation clears while in IR makes the roster INVALID and blocks every add, Questionable or
// Doubtful may stay; research 03 §B.1 `positionLimits`). Pure; every list comes back sorted.
// Ported from sibling @56d9068 (src/domain/league/roster.ts), adapted: ESPN slot ids, per-player
// `eligibleSlots`, the IR stay rule and the forced-drop arithmetic.
import { isStartingSlot, slotClassOf, slotNameOf, slotRefusal, sortSlotIds } from "./slots.js";
import {
  isIrEligible,
  type InjuryStatus,
  type IrSection,
  type Roster,
  type RosterSlots,
} from "./types.js";

/** One occupied seat as validation sees it (built from a RosterEntry with `seatsOf`). */
export interface RosterSeat {
  readonly player_id: number;
  readonly slot_id: number;
  /** ESPN `eligibleSlots` — authoritative per player. */
  readonly eligible_slot_ids: readonly number[];
  readonly injury_status: InjuryStatus | null;
  /** Display position (`QB`, `D/ST`, …) for position limits; null when unknown. */
  readonly position: string | null;
  /** NFL team id (bye checks); null or 0 for a free agent. */
  readonly pro_team_id: number | null;
}

/** The seats of a domain roster. */
export function seatsOf(roster: Pick<Roster, "entries">): RosterSeat[] {
  return roster.entries.map((e) => ({
    player_id: e.player.ref.id,
    slot_id: e.slot_id,
    eligible_slot_ids: e.player.eligible_slot_ids,
    injury_status: e.player.injury_status,
    position: e.player.position,
    pro_team_id: e.player.pro_team_id,
  }));
}

/**
 * What a status means for a player ALREADY in the IR slot (research 05 §4.3 [V-docs]):
 * `eligible` — OUT or INJURY_RESERVE; `may_stay` — QUESTIONABLE or DOUBTFUL ("the user's roster is
 * NOT invalid"); `invalid` — no designation (ACTIVE or none: "the roster becomes INVALID") or
 * SUSPENSION (SSPD is never IR-eligible); `uncertain` — DAY_TO_DAY or a value ESPN added, which no
 * page rules on: listed for a warning, never silently counted as valid or invalid.
 */
export type IrStayStatus = "eligible" | "may_stay" | "invalid" | "uncertain";

/** The IR stay class of a status (see IrStayStatus). */
export function irStayStatus(status: InjuryStatus | null): IrStayStatus {
  if (isIrEligible(status)) return "eligible";
  switch (status) {
    case "QUESTIONABLE":
    case "DOUBTFUL":
      return "may_stay";
    case null:
    case "ACTIVE":
    case "SUSPENSION":
      return "invalid";
    default:
      return "uncertain";
  }
}

/** The IR audit: plan 07 B1's `ir` section plus what the Skills need to act on it. */
export interface IrAudit extends IrSection {
  /** IR seats not occupied. */
  readonly open_slots: number;
  /** IR occupants that are Questionable or Doubtful (valid; cannot be moved back in once out). */
  readonly may_stay_players: readonly number[];
  /** IR occupants whose status no ESPN page rules on (DAY_TO_DAY, new values) — check by hand. */
  readonly uncertain_players: readonly number[];
}

const asc = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

/**
 * Audits the IR slot (research 05 §4.3). `invalid` when an occupant's stay status is `invalid` or
 * IR holds more players than it has seats; then `blocked: ["adds"]`. `eligible_now` lists every
 * player outside IR who could move in now (OUT or IR, `eligibleSlots` lists IR). `forced_drop_needed`
 * is the arithmetic after the best legal shuffle: everyone who must leave IR returns to the active
 * roster, eligible players fill the freed IR seats, and a drop is needed only if the active roster
 * still exceeds starters + bench.
 */
export function auditIr(seats: readonly RosterSeat[], slots: RosterSlots): IrAudit {
  const inIr = seats.filter((s) => slotClassOf(s.slot_id) === "ir");
  const active = seats.length - inIr.length;
  const byClass = (c: IrStayStatus): number[] =>
    asc(inIr.filter((s) => irStayStatus(s.injury_status) === c).map((s) => s.player_id));
  const invalidPlayers = byClass("invalid");
  const eligibleNow = asc(
    seats
      .filter(
        (s) =>
          slotClassOf(s.slot_id) !== "ir" &&
          s.eligible_slot_ids.includes(21) &&
          isIrEligible(s.injury_status),
      )
      .map((s) => s.player_id),
  );
  const staying = inIr.length - invalidPlayers.length;
  const mustLeave = invalidPlayers.length + Math.max(0, staying - slots.ir);
  const freedSeats = Math.max(0, slots.ir - (inIr.length - mustLeave));
  const movers = Math.min(eligibleNow.length, freedSeats);
  const activeAfter = active + mustLeave - movers;
  const invalid = mustLeave > 0;
  const occupied = [...inIr]
    .sort((a, b) => a.player_id - b.player_id)
    .map((s) => Object.freeze({ player_id: s.player_id, injury_status: s.injury_status }));
  return Object.freeze({
    slots: slots.ir,
    occupied: Object.freeze(occupied),
    invalid,
    invalid_players: Object.freeze(invalidPlayers),
    eligible_now: Object.freeze(eligibleNow),
    forced_drop_needed: activeAfter > slots.starters + slots.bench,
    blocked: Object.freeze(invalid ? (["adds"] as const) : []),
    open_slots: Math.max(0, slots.ir - inIr.length),
    may_stay_players: Object.freeze(byClass("may_stay")),
    uncertain_players: Object.freeze(byClass("uncertain")),
  });
}

/** Plan 07 B1's `ir` exactly (the audit's extra fields dropped, for a strict output schema). */
export function irSectionOf(a: IrAudit): IrSection {
  return Object.freeze({
    slots: a.slots,
    occupied: a.occupied,
    invalid: a.invalid,
    invalid_players: a.invalid_players,
    eligible_now: a.eligible_now,
    forced_drop_needed: a.forced_drop_needed,
    blocked: a.blocked,
  });
}

/** Plan 07 B1's `counts`: occupied seats by class (`total` = every rostered player). */
export interface RosterCounts {
  readonly starters: number;
  readonly bench: number;
  readonly ir: number;
  readonly total: number;
}

/** Counts the occupied seats (an `other`-class seat counts toward `total` only). */
export function rosterCounts(seats: readonly RosterSeat[]): RosterCounts {
  let starters = 0;
  let bench = 0;
  let ir = 0;
  for (const s of seats) {
    const c = slotClassOf(s.slot_id);
    if (c === "starter" || c === "flex") starters++;
    else if (c === "bench") bench++;
    else if (c === "ir") ir++;
  }
  return Object.freeze({ starters, bench, ir, total: seats.length });
}

/** One entry per unfilled starting seat, in display order (`["RB", "FLEX"]`). */
export function emptyStartingSlots(seats: readonly RosterSeat[], slots: RosterSlots): string[] {
  const out: string[] = [];
  for (const s of slots.slots) {
    if (s.class !== "starter" && s.class !== "flex") continue;
    const n = seats.filter((x) => x.slot_id === s.slot_id).length;
    for (let i = n; i < s.count; i++) out.push(s.name);
  }
  return out;
}

/** A seat that breaks a placement rule. */
export interface SeatProblem {
  readonly player_id: number;
  readonly slot_id: number;
  readonly slot: string;
  readonly reason: "not_in_league" | "not_eligible";
}

/** A slot holding more players than its seats. */
export interface SlotOverflow {
  readonly slot_id: number;
  readonly slot: string;
  readonly occupied: number;
  readonly capacity: number;
}

/** A position at or beyond its roster limit. */
export interface PositionAtLimit {
  readonly position: string;
  readonly rostered: number;
  readonly limit: number;
}

/** Everything wrong (or merely notable) about a roster, in fixed vocabulary. */
export interface RosterValidation {
  readonly counts: RosterCounts;
  readonly empty_starting_slots: readonly string[];
  /** Players in a slot the league does not use, or a starting slot their `eligibleSlots` lacks. */
  readonly ineligible: readonly SeatProblem[];
  /**
   * Non-bench slots holding more players than their seats. The bench is elastic: every recorded
   * league sends `isBenchUnlimited: true` and a recorded roster holds 8 on a 7-seat bench beside an
   * empty D/ST slot, so only the active total (below) binds it.
   */
  readonly overflow: readonly SlotOverflow[];
  /** Bench players beyond the nominal bench seats (informational; see `overflow`). */
  readonly bench_over_nominal: number;
  /**
   * Positions rostered beyond their limit — informational: four of twelve teams in a recorded league
   * carry 7–8 WRs under a limit of 6 while ESPN treats the roster as normal; the limit binds ADDS.
   */
  readonly position_over_limit: readonly PositionAtLimit[];
  /** Positions at or beyond their limit: an add at one is refused (`TRAN_ROSTER_POSITION_LIMIT_EXCEEDED`). */
  readonly positions_at_limit: readonly PositionAtLimit[];
  readonly duplicates: readonly number[];
  /** Players outside IR. */
  readonly active_count: number;
  /** Starter + flex + bench seats. */
  readonly active_capacity: number;
  readonly over_capacity: boolean;
  /** Players in a starting slot whose NFL team is on bye (only when `on_bye` was given). */
  readonly starters_on_bye: readonly number[];
  readonly ir: IrAudit;
  /**
   * No violation: no invalid IR, no ineligible placement, no non-bench overflow, no duplicate, the
   * active roster within starters + bench. Empty starting seats, byes, an over-nominal bench,
   * position limits and uncertain IR statuses are reported but are not violations.
   */
  readonly legal: boolean;
}

/** Options for `validateRoster`. */
export interface ValidateRosterOptions {
  /** NFL team ids on bye in the validated week (enables `starters_on_bye`). */
  readonly on_bye?: ReadonlySet<number>;
}

/** Validates a roster against the league's slots. Never throws for any seat content. */
export function validateRoster(
  seats: readonly RosterSeat[],
  slots: RosterSlots,
  opts: ValidateRosterOptions = {},
): RosterValidation {
  const ineligible: SeatProblem[] = [];
  const occupied = new Map<number, number>();
  const seen = new Set<number>();
  const dup = new Set<number>();
  const byPosition = new Map<string, number>();
  const onBye: number[] = [];
  for (const s of seats) {
    if (seen.has(s.player_id)) dup.add(s.player_id);
    seen.add(s.player_id);
    occupied.set(s.slot_id, (occupied.get(s.slot_id) ?? 0) + 1);
    if (s.position !== null) byPosition.set(s.position, (byPosition.get(s.position) ?? 0) + 1);
    if (slotClassOf(s.slot_id) === "ir") continue; // the IR audit owns IR occupants
    const refusal = slotRefusal(s.slot_id, s, slots);
    if (refusal === "not_in_league" || refusal === "not_eligible")
      ineligible.push(
        Object.freeze({
          player_id: s.player_id,
          slot_id: s.slot_id,
          slot: slotNameOf(s.slot_id),
          reason: refusal,
        }),
      );
    const team = s.pro_team_id;
    if (
      opts.on_bye !== undefined &&
      isStartingSlot(s.slot_id) &&
      team !== null &&
      opts.on_bye.has(team)
    )
      onBye.push(s.player_id);
  }
  const overflow: SlotOverflow[] = [];
  let benchOver = 0;
  for (const id of sortSlotIds([...occupied.keys()])) {
    const capacity = slots.slots.find((x) => x.slot_id === id)?.count ?? 0;
    const n = occupied.get(id) ?? 0;
    if (capacity === 0 || n <= capacity) continue;
    if (slotClassOf(id) === "bench") benchOver = n - capacity;
    else overflow.push(Object.freeze({ slot_id: id, slot: slotNameOf(id), occupied: n, capacity }));
  }
  const atLimit: PositionAtLimit[] = [];
  for (const [position, rostered] of [...byPosition.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const limit = Object.hasOwn(slots.position_limits, position)
      ? slots.position_limits[position]
      : null;
    if (typeof limit === "number" && rostered >= limit)
      atLimit.push(Object.freeze({ position, rostered, limit }));
  }
  const counts = rosterCounts(seats);
  const ir = auditIr(seats, slots);
  const activeCount = seats.length - counts.ir;
  const activeCapacity = slots.starters + slots.bench;
  const overCapacity = activeCount > activeCapacity;
  ineligible.sort((a, b) => a.player_id - b.player_id || a.slot_id - b.slot_id);
  const duplicates = asc([...dup]);
  return Object.freeze({
    counts,
    empty_starting_slots: Object.freeze(emptyStartingSlots(seats, slots)),
    ineligible: Object.freeze(ineligible),
    overflow: Object.freeze(overflow),
    bench_over_nominal: benchOver,
    position_over_limit: Object.freeze(atLimit.filter((p) => p.rostered > p.limit)),
    positions_at_limit: Object.freeze(atLimit),
    duplicates: Object.freeze(duplicates),
    active_count: activeCount,
    active_capacity: activeCapacity,
    over_capacity: overCapacity,
    starters_on_bye: Object.freeze(asc(onBye)),
    ir,
    legal:
      !ir.invalid &&
      ineligible.length === 0 &&
      overflow.length === 0 &&
      duplicates.length === 0 &&
      !overCapacity,
  });
}
