// ids.ts — ESPN player-id grammar as the crosswalk reads it (plan 01 §9 PlayerRef: persons are
// positive, team units negative `base − proTeamId`; research 04 §C: the ESPN id is a lookup key).
// The provider owns ESPN_TEAM_UNIT_ID_RANGES; the domain may not import it (plan 01 §1.1), so
// tests/domain/crosswalk/ids.test.ts holds these copies equal to the provider's.
import { TEAM_UNIT_POSITION_IDS } from "./types.js";

/** The largest positive (person) ESPN player id accepted (plan 02 §5, A-2). */
export const ESPN_PERSON_ID_MAX = 99_999_999;

/** Team-unit id bases by position id: D/ST −16000, TQB −15000, HC −14000 (unit id = base − proTeamId). */
export const TEAM_UNIT_ID_BASES: Readonly<Record<number, number>> = Object.freeze({
  16: -16000,
  15: -15000,
  14: -14000,
});

/** Whether `id` is an ESPN person id: an integer 1..ESPN_PERSON_ID_MAX. */
export function isPersonId(id: unknown): id is number {
  return typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= ESPN_PERSON_ID_MAX;
}

/** The team-unit position id an ESPN id falls in (−16999..−16001 → 16, …), else null. */
export function teamUnitPositionOf(id: unknown): number | null {
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  for (const pos of TEAM_UNIT_POSITION_IDS) {
    const base = TEAM_UNIT_ID_BASES[pos];
    if (base !== undefined && id >= base - 999 && id <= base - 1) return pos;
  }
  return null;
}

/** The pro-team id a team-unit player id stands for (`base − id`), else null. */
export function teamUnitProTeamId(id: unknown): number | null {
  const pos = teamUnitPositionOf(id);
  const base = pos === null ? undefined : TEAM_UNIT_ID_BASES[pos];
  return base === undefined || typeof id !== "number" ? null : base - id;
}

/** A positive integer ESPN id from nflverse's `espn_id` (number or decimal text), else null. */
export function cleanEspnId(raw: unknown): number | null {
  if (isPersonId(raw)) return raw;
  if (typeof raw !== "string" || raw.length > 12) return null;
  const s = raw.trim();
  // 1..99 999 999 by construction: at most eight digits, no leading zero.
  return /^[1-9][0-9]{0,7}$/.test(s) ? Number(s) : null;
}
