// slots.ts — the slot model by lineup-slot id (plan 01 §9 roster slots `{name, class, count,
// eligible}`; plan 07 A1 `roster`, B1 `slot`/`slot_class`/`is_flex`; research 03 §B.1
// `lineupSlotCounts`/`positionLimits`, §B.2 slot ids ≠ position ids). Per-player `eligible_slot_ids`
// (ESPN `eligibleSlots`) is authoritative; the table's `eligible_positions` is descriptive. Pure.
// Ported from sibling @56d9068 (src/domain/league/slots.ts), adapted: ESPN names slots by a fixed
// numeric table instead of parsing flex spellings, and IR is gated by the injury status.
import {
  asSlotId,
  isIrEligible,
  type InjuryStatus,
  type RosterSettingsInput,
  type RosterSlot,
  type RosterSlots,
  type SlotClass,
  type SlotId,
} from "./types.js";

/** One lineup-slot id of ESPN's table. */
export interface SlotDefinition {
  readonly id: SlotId;
  /** ESPN's literal slot name (`""` for the unnamed slot 22). */
  readonly name: string;
  readonly class: SlotClass;
  /** Position names the slot accepts (descriptive; per-player `eligible_slot_ids` decides). */
  readonly eligible_positions: readonly string[];
}

/**
 * Position id → display name (research 03 §B.2; 15 = TQB is the observed inference). The domain's
 * copy of the provider's `ESPN_POSITIONS` names (a parity test holds them equal — the domain may not
 * import the provider).
 */
export const POSITION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  7: "P",
  9: "DT",
  10: "DE",
  11: "LB",
  12: "CB",
  13: "S",
  14: "HC",
  15: "TQB",
  16: "D/ST",
});

const ALL = Object.freeze([
  "QB",
  "RB",
  "WR",
  "TE",
  "K",
  "P",
  "DT",
  "DE",
  "LB",
  "CB",
  "S",
  "HC",
  "TQB",
  "D/ST",
]);

const def = (
  id: number,
  name: string,
  cls: SlotClass,
  eligible: readonly string[],
): SlotDefinition =>
  Object.freeze({
    id: asSlotId(id),
    name,
    class: cls,
    eligible_positions: Object.freeze([...eligible]),
  });

/**
 * ESPN's lineup-slot table (research 03 §B.2, four community maps agree; ids 0–7, 16, 17, 20, 21,
 * 23 observed on the recorded leagues). The flex variants are RB/WR (3), WR/TE (5), OP (7, the
 * superflex), FLEX (23) and the IDP flexes DL/DB/DP; TQB (1) is the team-quarterback unit's slot.
 */
// prettier-ignore
export const SLOT_TABLE: Readonly<Record<number, SlotDefinition>> = Object.freeze({
  0: def(0, "QB", "starter", ["QB"]),
  1: def(1, "TQB", "starter", ["TQB"]),
  2: def(2, "RB", "starter", ["RB"]),
  3: def(3, "RB/WR", "flex", ["RB", "WR"]),
  4: def(4, "WR", "starter", ["WR"]),
  5: def(5, "WR/TE", "flex", ["WR", "TE"]),
  6: def(6, "TE", "starter", ["TE"]),
  7: def(7, "OP", "flex", ["QB", "RB", "WR", "TE"]),
  8: def(8, "DT", "starter", ["DT"]),
  9: def(9, "DE", "starter", ["DE"]),
  10: def(10, "LB", "starter", ["LB"]),
  11: def(11, "DL", "flex", ["DT", "DE"]),
  12: def(12, "CB", "starter", ["CB"]),
  13: def(13, "S", "starter", ["S"]),
  14: def(14, "DB", "flex", ["CB", "S"]),
  15: def(15, "DP", "flex", ["DT", "DE", "LB", "CB", "S"]),
  16: def(16, "D/ST", "starter", ["D/ST"]),
  17: def(17, "K", "starter", ["K"]),
  18: def(18, "P", "starter", ["P"]),
  19: def(19, "HC", "starter", ["HC"]),
  20: def(20, "BE", "bench", ALL),
  21: def(21, "IR", "ir", ALL),
  22: def(22, "", "other", []),
  23: def(23, "FLEX", "flex", ["RB", "WR", "TE"]),
  24: def(24, "ER", "other", []),
  25: def(25, "Rookie", "other", []),
});

/** The bench and IR slot ids (research 03 §B.2: 20 bench, 21 IR). */
export const BENCH_SLOT_ID = asSlotId(20);
export const IR_SLOT_ID = asSlotId(21);

/**
 * ESPN's lineup display order (QB, TQB, RB, RB/WR, WR, WR/TE, TE, FLEX, OP, IDP, D/ST, K, P, HC,
 * BE, IR, then the rest): `RosterSlots.slots` and `empty_starting_slots` follow it.
 */
export const SLOT_DISPLAY_ORDER: readonly number[] = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 23, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25,
]);

/** A slot count above this is refused (a settings body cannot declare 10⁶ bench seats). */
export const MAX_SLOT_COUNT = 50;
/** At most this many keys of one settings record are read; the rest are labelled, not parsed. */
export const MAX_SETTINGS_KEYS = 128;

/** A canonical id key: `"0"`…`"99"`, no sign, no leading zero, no whitespace. */
const ID_KEY_RE = /^(?:0|[1-9][0-9]?)$/;

/** The display rank of a slot id (unknown ids after every known one, ascending by id). */
function displayRank(id: number): number {
  const i = SLOT_DISPLAY_ORDER.indexOf(id);
  return i === -1 ? SLOT_DISPLAY_ORDER.length + id : i;
}

/** Sorts slot ids into display order (a new array). */
export function sortSlotIds<T extends number>(ids: readonly T[]): T[] {
  return [...ids].sort((a, b) => displayRank(a) - displayRank(b));
}

/** ESPN's table entry of an id, or undefined (any number, never throws). */
function tableEntry(id: number): SlotDefinition | undefined {
  return Number.isInteger(id) ? SLOT_TABLE[id] : undefined;
}

/**
 * The definition of a slot id: ESPN's entry, or — for an id 0–99 outside the table — class `other`
 * named `SLOT_<id>` with no positions (an unknown slot is never a starting slot). Throws RangeError
 * for a non-integer or out-of-range id (it cannot be branded); the helpers below never throw.
 */
export function slotDefinition(id: number): SlotDefinition {
  return tableEntry(id) ?? def(id, `SLOT_${String(id)}`, "other", []);
}

/** The slot's class (`other` for any id outside the table). */
export function slotClassOf(id: number): SlotClass {
  return tableEntry(id)?.class ?? "other";
}

/** The slot's display name: ESPN's literal, or `SLOT_<id>` when ESPN has none. */
export function slotNameOf(id: number): string {
  const name = tableEntry(id)?.name ?? "";
  return name === "" ? `SLOT_${String(id)}` : name;
}

/** Whether the slot is a flex variant (RB/WR, WR/TE, OP, FLEX, DL, DB, DP). */
export function isFlexSlot(id: number): boolean {
  return slotClassOf(id) === "flex";
}

/** Whether the slot scores (starter or flex). */
export function isStartingSlot(id: number): boolean {
  const c = slotClassOf(id);
  return c === "starter" || c === "flex";
}

/** A position id's display name, or null for an id outside the table. */
export function positionNameOf(positionId: number): string | null {
  return Number.isInteger(positionId) ? (POSITION_NAMES[positionId] ?? null) : null;
}

/** Own, canonical-id keys of a settings record (at most MAX_SETTINGS_KEYS), with a truncation flag. */
function idEntries(rec: unknown): { entries: [number, unknown][]; bad: boolean } {
  if (typeof rec !== "object" || rec === null || Array.isArray(rec))
    return { entries: [], bad: true };
  const keys = Object.keys(rec);
  let bad = keys.length > MAX_SETTINGS_KEYS;
  const entries: [number, unknown][] = [];
  for (const k of keys.slice(0, MAX_SETTINGS_KEYS)) {
    if (!ID_KEY_RE.test(k)) {
      bad = true;
      continue;
    }
    entries.push([Number(k), (rec as Record<string, unknown>)[k]]);
  }
  entries.sort((a, b) => a[0] - b[0]);
  return { entries, bad };
}

/** An enum-like ESPN token (uppercase snake, bounded) or null — never free text. */
export function enumToken(v: unknown): string | null {
  return typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : null;
}

/** The lock type every recorded league sends: each player locks at his own game's kickoff. */
export const LINEUP_LOCK_PER_GAME = "INDIVIDUAL_GAME";

/** The roster digest and the fixed-vocabulary paths it could not read. */
export interface RosterSlotsResult {
  readonly roster: RosterSlots;
  readonly unverified: readonly string[];
}

/**
 * Builds A1's `roster` from `rosterSettings`: one `RosterSlot` per slot with a positive count, in
 * display order; `starters` = starter + flex seats, `bench`, `ir`, `total` = every seat (incl. an
 * `other` slot). Position limits are keyed by position NAME (−1 or any negative → null =
 * unlimited); the zero-padded non-position ids ESPN sends (0, 6, 8, 17) are skipped silently.
 * Anything unreadable — a bad key, a non-integer or out-of-range count, an unknown slot or position
 * id with a value, an unknown lock type — is left out and named in `unverified`.
 */
export function buildRosterSlots(input: RosterSettingsInput): RosterSlotsResult {
  const unverified = new Set<string>();
  const slots: RosterSlot[] = [];
  const counts = idEntries(input.slot_counts);
  if (counts.bad) unverified.add("roster.slot_counts");
  for (const [id, raw] of counts.entries) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_SLOT_COUNT) {
      unverified.add(`roster.slot_counts.${String(id)}`);
      continue;
    }
    if (raw === 0) continue;
    const d = slotDefinition(id);
    if (d.class === "other") unverified.add(`roster.slot_counts.${String(id)}`);
    slots.push(
      Object.freeze({
        slot_id: d.id,
        name: slotNameOf(id),
        class: d.class,
        count: raw,
        eligible_positions: d.eligible_positions,
      }),
    );
  }
  slots.sort((a, b) => displayRank(a.slot_id) - displayRank(b.slot_id));
  const sum = (pred: (s: RosterSlot) => boolean): number =>
    slots.filter(pred).reduce((n, s) => n + s.count, 0);

  const limits: [string, number | null][] = [];
  const pl = idEntries(input.position_limits);
  if (pl.bad) unverified.add("roster.position_limits");
  for (const [id, raw] of pl.entries) {
    const name = positionNameOf(id);
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      unverified.add(`roster.position_limits.${String(id)}`);
      continue;
    }
    if (name === null) {
      if (raw !== 0) unverified.add(`roster.position_limits.${String(id)}`);
      continue;
    }
    limits.push([name, raw < 0 ? null : raw]);
  }

  const lockType = enumToken(input.lineup_lock_type);
  if (input.lineup_lock_type !== null && lockType === null)
    unverified.add("roster.lineup_lock_type");
  if (lockType !== null && lockType !== LINEUP_LOCK_PER_GAME)
    unverified.add("roster.lineup_lock_type");
  const moveLimit = input.move_limit;
  const roster: RosterSlots = Object.freeze({
    slots: Object.freeze(slots),
    starters: sum((s) => s.class === "starter" || s.class === "flex"),
    bench: sum((s) => s.class === "bench"),
    ir: sum((s) => s.class === "ir"),
    total: sum(() => true),
    lineup_lock_type: lockType,
    undroppable_list: typeof input.undroppable_list === "boolean" ? input.undroppable_list : null,
    position_limits: Object.freeze(Object.fromEntries(limits)),
    move_limit:
      typeof moveLimit === "number" && Number.isInteger(moveLimit) && moveLimit >= 0
        ? moveLimit
        : null,
  });
  return Object.freeze({ roster, unverified: Object.freeze([...unverified].sort()) });
}

/** The league's slot of an id (count > 0), or null when the league does not use it. */
export function leagueSlot(roster: RosterSlots, id: number): RosterSlot | null {
  return roster.slots.find((s) => s.slot_id === id) ?? null;
}

/** A player as the eligibility rules see him (PlatformPlayer's fields). */
export interface SlotSubject {
  /** ESPN `eligibleSlots` — authoritative per player. */
  readonly eligible_slot_ids: readonly number[];
  readonly injury_status: InjuryStatus | null;
}

/** Why a player may not be put in a slot (fixed vocabulary). */
export type SlotRefusal = "not_in_league" | "not_eligible" | "ir_status";

/**
 * Null when `player` may be MOVED INTO `slotId`, else why not: the bench takes anyone; IR takes a
 * player whose `eligible_slot_ids` lists it AND whose status is OUT or INJURY_RESERVE (research 05
 * §4.3 — Questionable/Doubtful cannot move in; SSPD never); every other slot needs the id in the
 * player's `eligible_slot_ids`. With `roster`, a slot the league does not use is `not_in_league`.
 */
export function slotRefusal(
  slotId: number,
  player: SlotSubject,
  roster?: RosterSlots,
): SlotRefusal | null {
  if (roster !== undefined && leagueSlot(roster, slotId) === null) return "not_in_league";
  const cls = slotClassOf(slotId);
  if (cls === "bench") return null;
  if (!player.eligible_slot_ids.includes(slotId)) return "not_eligible";
  if (cls === "ir" && !isIrEligible(player.injury_status)) return "ir_status";
  return null;
}

/** Whether `player` may be moved into `slotId`. */
export function canOccupySlot(slotId: number, player: SlotSubject, roster?: RosterSlots): boolean {
  return slotRefusal(slotId, player, roster) === null;
}

/** The league's starting slots (starter or flex, count > 0) the player can fill, in display order. */
export function startingSlotsFor(player: SlotSubject, roster: RosterSlots): SlotId[] {
  return roster.slots
    .filter(
      (s) =>
        (s.class === "starter" || s.class === "flex") &&
        player.eligible_slot_ids.includes(s.slot_id),
    )
    .map((s) => s.slot_id);
}

/** One starting seat (a slot with count 3 is three seats). */
export interface StartingSeat {
  readonly slot_id: SlotId;
  readonly name: string;
  readonly class: "starter" | "flex";
  /** 0-based index among this slot's seats. */
  readonly index: number;
  /** How many positions the slot accepts (1 for a dedicated slot). */
  readonly breadth: number;
}

/**
 * Every starting seat in fill order for a greedy assignment: dedicated slots first, then the flex
 * variants from the narrowest to the widest (RB/WR and WR/TE, then FLEX, then OP), ties by display
 * order — a flex is filled only after the players a dedicated slot needs are placed.
 */
export function startingSeats(roster: RosterSlots): StartingSeat[] {
  const out: StartingSeat[] = [];
  for (const s of roster.slots) {
    if (s.class !== "starter" && s.class !== "flex") continue;
    for (let i = 0; i < s.count; i++)
      out.push(
        Object.freeze({
          slot_id: s.slot_id,
          name: s.name,
          class: s.class,
          index: i,
          breadth: Math.max(1, s.eligible_positions.length),
        }),
      );
  }
  return out.sort(
    (a, b) =>
      (a.class === "flex" ? 1 : 0) - (b.class === "flex" ? 1 : 0) ||
      a.breadth - b.breadth ||
      displayRank(a.slot_id) - displayRank(b.slot_id) ||
      a.index - b.index,
  );
}

/** The roster limit of a position name: a number, null (unlimited) or undefined (not stated). */
export function positionLimitOf(roster: RosterSlots, position: string): number | null | undefined {
  return Object.hasOwn(roster.position_limits, position)
    ? roster.position_limits[position]
    : undefined;
}
