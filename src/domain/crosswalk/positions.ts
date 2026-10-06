// positions.ts — position families for the matcher's "position agrees" test (research 04 §C step 2:
// ESPN position ids 1–4 → QB/RB/WR/TE, plus K — ESPN_POSITION_TO_NFLVERSE; plan 05 §2). Ported from
// sibling @8db206f, adapted. Plan silent on equivalences: FB/HB → RB (ESPN lists fullbacks as RB),
// PK → K; anything absent never matches, not even itself. ESPN ids outside 1–5 have no family here,
// so they resolve by id only (never by name + team alone).
import { ESPN_POSITION_TO_NFLVERSE } from "./types.js";

/** Position (upper case) → family. */
export const POSITION_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  QB: "QB",
  RB: "RB",
  HB: "RB",
  FB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  PK: "K",
});

const FAMILY_TABLE: ReadonlyMap<string, string> = new Map(Object.entries(POSITION_FAMILIES));

/** The family of a position, or null when the position is unknown or malformed. */
export function positionFamily(position: unknown): string | null {
  if (typeof position !== "string" || position.length > 8) return null;
  return FAMILY_TABLE.get(position.trim().toUpperCase()) ?? null;
}

/** Whether two positions are in the same (known) family. */
export function samePositionFamily(a: unknown, b: unknown): boolean {
  const fa = positionFamily(a);
  return fa !== null && fa === positionFamily(b);
}

const ESPN_FAMILY: ReadonlyMap<number, string> = new Map(
  Object.entries(ESPN_POSITION_TO_NFLVERSE).map(([id, p]): [number, string] => [Number(id), p]),
);

/** The family of an ESPN position id (1–5 only); null for every other or malformed id. */
export function espnPositionFamily(positionId: unknown): string | null {
  return typeof positionId === "number" && Number.isInteger(positionId)
    ? (ESPN_FAMILY.get(positionId) ?? null)
    : null;
}
