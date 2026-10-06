// teams.ts — which NFL teams a headline names, for the news player matcher's team evidence (tables.ts
// ds_news_players `full_name_team` / `last_name_team`; plan 07 D6 `players_matched`; plan 02 §6.4 —
// rules, never a model). A headline names a team by its nickname ("Ravens", "Bucs") or by an
// unambiguous home (Baltimore, "Green Bay"); "Los Angeles" and "New York" each hold two teams and are
// not evidence. Matched on the sanitised, case-preserved text with a capital initial required, so
// the English words "saints", "giants" or "jets" in lower case are not a team.
import type { NflTeam } from "../../config/schema.js";

/** Nicknames and their common short forms. */
// prettier-ignore
export const TEAM_NICKNAMES: Readonly<Record<string, NflTeam>> = Object.freeze({
  Cardinals: "ARI", Falcons: "ATL", Ravens: "BAL", Bills: "BUF", Panthers: "CAR", Bears: "CHI",
  Bengals: "CIN", Browns: "CLE", Cowboys: "DAL", Broncos: "DEN", Lions: "DET", Packers: "GB",
  Texans: "HOU", Colts: "IND", Jaguars: "JAX", Jags: "JAX", Chiefs: "KC", Rams: "LA",
  Chargers: "LAC", Raiders: "LV", Dolphins: "MIA", Vikings: "MIN", Patriots: "NE", Pats: "NE",
  Saints: "NO", Giants: "NYG", Jets: "NYJ", Eagles: "PHI", Steelers: "PIT", Seahawks: "SEA",
  "49ers": "SF", Niners: "SF", Buccaneers: "TB", Bucs: "TB", Titans: "TEN", Commanders: "WAS",
});

/** Unambiguous home names (one or two words). */
// prettier-ignore
export const TEAM_HOMES: Readonly<Record<string, NflTeam>> = Object.freeze({
  Arizona: "ARI", Atlanta: "ATL", Baltimore: "BAL", Buffalo: "BUF", Carolina: "CAR",
  Chicago: "CHI", Cincinnati: "CIN", Cleveland: "CLE", Dallas: "DAL", Denver: "DEN",
  Detroit: "DET", "Green Bay": "GB", Houston: "HOU", Indianapolis: "IND", Indy: "IND",
  Jacksonville: "JAX", "Kansas City": "KC", "Las Vegas": "LV", Miami: "MIA", Minnesota: "MIN",
  "New England": "NE", "New Orleans": "NO", Philadelphia: "PHI", Philly: "PHI",
  Pittsburgh: "PIT", Seattle: "SEA", "San Francisco": "SF", "Tampa Bay": "TB", Tennessee: "TEN",
  Washington: "WAS",
});

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALL: readonly (readonly [string, NflTeam])[] = [
  ...Object.entries(TEAM_NICKNAMES),
  ...Object.entries(TEAM_HOMES),
].sort((a, b) => b[0].length - a[0].length);
const TEAM_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${ALL.map(([k]) => escape(k)).join("|")})(?![\\p{L}\\p{N}])`,
  "gu",
);
const LOOKUP: ReadonlyMap<string, NflTeam> = new Map(ALL);

/** The words a team mention occupies (the matcher never reads them as a surname). */
export const TEAM_WORDS: ReadonlySet<string> = new Set(
  ALL.flatMap(([k]) => k.toLowerCase().split(" ")),
);

/** The teams a (sanitised, case-preserved) text names, sorted. */
export function teamsMentioned(text: string): readonly NflTeam[] {
  const out = new Set<NflTeam>();
  for (const m of text.matchAll(TEAM_RE)) {
    const t = LOOKUP.get(m[1] ?? "");
    if (t !== undefined) out.add(t);
  }
  return [...out].sort();
}
