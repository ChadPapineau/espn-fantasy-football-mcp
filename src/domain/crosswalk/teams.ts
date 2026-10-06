// teams.ts — the ONE team table the crosswalk maps every spelling through (research 04 §C: ESPN
// `WSH`/`LAR` → nflverse `WAS`/`LA`; plan 05 §2 `domain/crosswalk` "an unknown abbreviation fails
// loudly"). Ported from sibling @8db206f, adapted (ESPN pro-team ids; the domain may not import the
// provider, so tests/domain/crosswalk/teams.test.ts holds this table equal to ESPN_PRO_TEAMS).
import { NFL_TEAMS, isNflTeam, type NflTeam } from "../../config/schema.js";
import { ESPN_TO_NFLVERSE_TEAM } from "./types.js";

/**
 * Non-nflverse spellings → nflverse abbreviation, case-insensitive: ESPN's two (`WSH`, `LAR` — the
 * ESPN_TO_NFLVERSE_TEAM contract), DynastyProcess/MFL (`JAC`, `LVR`, `NOS`, `GBP`, `KCC`, `NEP`,
 * `SFO`, `TBB`), PFR-style (`GNB`, `KAN`, `NOR`, `NWE`, `SDG`, `TAM`), PFF (`ARZ`, `BLT`, `CLV`,
 * `HST`) and relocated franchises (`OAK`, `SD`, `STL`, `WFT`) — so an older season or another
 * source's spelling never turns into a silent non-match.
 */
export const TEAM_ALIASES: Readonly<Record<string, NflTeam>> = Object.freeze({
  ...ESPN_TO_NFLVERSE_TEAM,
  ARZ: "ARI",
  BLT: "BAL",
  CLV: "CLE",
  GBP: "GB",
  GNB: "GB",
  HST: "HOU",
  JAC: "JAX",
  KAN: "KC",
  KCC: "KC",
  LVR: "LV",
  NEP: "NE",
  NOR: "NO",
  NOS: "NO",
  NWE: "NE",
  OAK: "LV",
  SD: "LAC",
  SDG: "LAC",
  SFO: "SF",
  STL: "LA",
  TAM: "TB",
  TBB: "TB",
  WFT: "WAS",
});

/** ESPN's free-agent pseudo team: `proTeamId` 0, abbreviation `FA` (research 03 §B.2). */
export const ESPN_FREE_AGENT_PRO_TEAM_ID = 0;
export const ESPN_FREE_AGENT_ABBREV = "FA";

/**
 * ESPN `proTeamId` → nflverse abbreviation (research 03 §B.2's observed list; ids 31 and 32 are
 * unused). The provider's ESPN_PRO_TEAMS is the source; this copy exists because the domain layer
 * may not import the provider (plan 01 §1.1), and a test holds the two equal.
 */
// prettier-ignore
export const ESPN_PRO_TEAM_ID_TO_NFLVERSE: Readonly<Record<number, NflTeam>> = Object.freeze({
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB",
  10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LA", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO",
  19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB",
  28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
});

const TEAM_TABLE: ReadonlyMap<string, NflTeam> = new Map<string, NflTeam>([
  ...NFL_TEAMS.map((t): [string, NflTeam] => [t, t]),
  ...Object.entries(TEAM_ALIASES),
]);

const PRO_TEAM_TABLE: ReadonlyMap<number, NflTeam> = new Map(
  Object.entries(ESPN_PRO_TEAM_ID_TO_NFLVERSE).map(([id, t]): [number, NflTeam] => [Number(id), t]),
);

const ABBR_RE = /^[A-Za-z]{2,4}$/;

/** Maps any known spelling to the nflverse abbreviation; null for unknown or malformed input. */
export function normalizeTeam(abbr: unknown): NflTeam | null {
  if (typeof abbr !== "string") return null;
  const a = abbr.trim();
  if (!ABBR_RE.test(a)) return null;
  const team = TEAM_TABLE.get(a.toUpperCase()) ?? null;
  return team !== null && isNflTeam(team) ? team : null;
}

/** Like `normalizeTeam` but throws RangeError on an unknown abbreviation (the loud failure). */
export function requireNflTeam(abbr: unknown): NflTeam {
  const team = normalizeTeam(abbr);
  if (team === null) {
    const shown = typeof abbr === "string" && ABBR_RE.test(abbr.trim()) ? ` '${abbr.trim()}'` : "";
    throw new RangeError(`crosswalk: unknown team abbreviation${shown}`);
  }
  return team;
}

/** The nflverse team of an ESPN `proTeamId`; null for 0 (free agent), unknown or malformed ids. */
export function teamOfProTeamId(proTeamId: unknown): NflTeam | null {
  return typeof proTeamId === "number" && Number.isInteger(proTeamId)
    ? (PRO_TEAM_TABLE.get(proTeamId) ?? null)
    : null;
}

/** Every spelling the table accepts (upper case), for tests and diagnostics. */
export function knownTeamSpellings(): readonly string[] {
  return [...TEAM_TABLE.keys()].sort();
}

/**
 * How an ESPN player's pro team reads for the matcher: an nflverse team, `none` (a free agent —
 * `proTeamId` 0 / `FA` / no team given), `unknown` (an abbreviation or id no table knows: the loud
 * failure, never a silent non-match) or `conflict` (the abbreviation and the id name different teams).
 */
export type TeamReading =
  | { readonly kind: "team"; readonly team: NflTeam }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" }
  | { readonly kind: "conflict" };

type Side = NflTeam | "fa" | "absent" | "unknown";

function idSide(proTeamId: unknown): Side {
  if (proTeamId === null || proTeamId === undefined) return "absent";
  if (proTeamId === ESPN_FREE_AGENT_PRO_TEAM_ID) return "fa";
  return teamOfProTeamId(proTeamId) ?? "unknown";
}

function abbrevSide(abbrev: unknown): Side {
  if (abbrev === null || abbrev === undefined) return "absent";
  if (typeof abbrev !== "string") return "unknown";
  const a = abbrev.trim();
  if (a.length === 0) return "absent";
  if (a.toUpperCase() === ESPN_FREE_AGENT_ABBREV) return "fa";
  return normalizeTeam(a) ?? "unknown";
}

function reading(side: Exclude<Side, "unknown">): TeamReading {
  return side === "fa" || side === "absent" ? { kind: "none" } : { kind: "team", team: side };
}

/**
 * Reads an ESPN `(proTeamId, abbreviation)` pair. Either side unknown → `unknown`; one side absent →
 * the other; both present and different (incl. a team against `FA`) → `conflict`.
 */
export function readEspnTeam(proTeamId: unknown, abbrev: unknown): TeamReading {
  const byId = idSide(proTeamId);
  const byAbbrev = abbrevSide(abbrev);
  if (byId === "unknown" || byAbbrev === "unknown") return { kind: "unknown" };
  if (byId === "absent") return reading(byAbbrev);
  if (byAbbrev === "absent") return reading(byId);
  return byId === byAbbrev ? reading(byId) : { kind: "conflict" };
}
