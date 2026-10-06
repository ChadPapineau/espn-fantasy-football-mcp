// ids.ts — the TWO ESPN id maps kept apart (research 03 §B.2 trap: `defaultPositionId` and
// `lineupSlotId` are different numberings; S-JS decodes positions with the slot map and labels every
// QB a TQB): slot ids → slot name/class/flex, position ids → position name/class, and the pro-team
// table. Unknown ids produce a typed `unknown` entry (`slot_<id>` / `pos_<id>`), never a crash and
// never a borrowed name from the other map. Branded SlotId / PositionId only leave through here.
import { asSlotId, type SlotClass, type SlotId } from "../../domain/league/types.js";
import { asPositionId, type PositionClass, type PositionId } from "../../domain/scoring/types.js";
import { ESPN_POSITIONS, ESPN_PRO_TEAMS, ESPN_SLOTS, teamUnitRangeOf } from "./types.js";

/** A decoded lineup slot. `known: false` for an id outside the table (name `slot_<id>`, class other). */
export interface SlotDecoded {
  readonly id: SlotId;
  readonly name: string;
  readonly class: SlotClass;
  readonly is_flex: boolean;
  readonly known: boolean;
}

/** A decoded position. `known: false` for an id outside the table (name `pos_<id>`, class null). */
export interface PositionDecoded {
  readonly id: PositionId;
  readonly name: string;
  readonly class: PositionClass | null;
  readonly known: boolean;
}

/** Decodes a lineup-slot id with the SLOT map; throws only when `n` is not a slot-id integer. */
export function decodeSlot(n: number): SlotDecoded {
  const id = asSlotId(n);
  const info = ESPN_SLOTS[n];
  if (info === undefined)
    return { id, name: `slot_${String(n)}`, class: "other", is_flex: false, known: false };
  return { id, name: info.name, class: info.class, is_flex: info.class === "flex", known: true };
}

/** Decodes a position id with the POSITION map (never the slot map). */
export function decodePosition(n: number): PositionDecoded {
  const id = asPositionId(n);
  const info = ESPN_POSITIONS[n];
  if (info === undefined) return { id, name: `pos_${String(n)}`, class: null, known: false };
  return { id, name: info.name, class: info.class, known: true };
}

/** Whether `n` can be a slot / position id at all (the brand's integer range 0..99). */
export function isIdInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 99;
}

/** The slot ids of a set of slot names (`FLEX` → 23, `D/ST` → 16); null for a name not in the table. */
export function slotIdsForName(name: string): SlotId[] | null {
  const hits = Object.values(ESPN_SLOTS).filter((s) => s.name !== "" && s.name === name);
  return hits.length === 0 ? null : hits.map((s) => s.id);
}

/** ESPN's pro-team abbreviation (`WSH`, `LAR`; `FA` for 0), or null for an id outside the table. */
export function proTeamAbbrev(id: number): string | null {
  return ESPN_PRO_TEAMS[id] ?? null;
}

/** The position id a team-unit player id implies (D/ST 16, TQB 15, HC 14), or null for a person. */
export function teamUnitPosition(playerId: number): PositionId | null {
  return teamUnitRangeOf(playerId)?.position_id ?? null;
}
