// teams.ts — which NFL teams a headline names, for the news player matcher's team evidence (tables.ts
// ds_news_players `full_name_team` / `last_name_team`; plan 07 D6 `players_matched`; plan 02 §6.4 —
// rules, never a model). A headline names a team by its nickname ("Ravens", "Bucs") or by an
// unambiguous home (Baltimore, "Green Bay"); "Los Angeles" and "New York" each hold two teams and are
// not evidence. Matched on the sanitised, case-preserved text with a capital initial required, so
// the English words "saints", "giants" or "jets" in lower case are not a team. A team named as the
// item's opponent ("against the Eagles", "vs. Bears", "versus", "facing", "Browns matchup") is marked
// so (Stage C remediation news-match-universe-homonyms): the matcher never reads it as the subject's
// own team. Where a mention sits is kept too, so the matcher can tell a team from a player's own name
// (Stage C remediation news-match-player-name-team-word: "Dallas Goedert", "Parker Washington").
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

/** One team a text names: the team, the words naming it and where they are. */
export interface TeamMention {
  readonly team: NflTeam;
  /** The words as written ("Washington", "Green Bay", "Bucs"). */
  readonly words: string;
  /** Offsets in the text: [start, end). */
  readonly start: number;
  readonly end: number;
  /**
   * Named as the opponent: right after "against", "vs", "vs.", "versus" or "facing" (a "the" may
   * stand between), or right before "matchup" ("Questionable for Browns matchup"; a possessive —
   * "Browns' matchup" — is the team's own).
   */
  readonly opponent: boolean;
}

/** A cue word ending the text before a mention (with an optional "the"). */
const OPPONENT_BEFORE_RE = /(?<![\p{L}\p{N}])(?:against|vs\.?|versus|facing)\s+(?:the\s+)?$/iu;
/** "matchup" right after a mention (whitespace only between). */
const OPPONENT_AFTER_RE = /^\s+matchups?(?![\p{L}\p{N}])/iu;
/** The longest cue before a mention ("against the " plus slack): the look-behind window. */
const CUE_WINDOW = 24;

/** Every team mention of a (sanitised, case-preserved) text, in text order. */
export function teamMentions(text: string): readonly TeamMention[] {
  const out: TeamMention[] = [];
  for (const m of text.matchAll(TEAM_RE)) {
    const words = m[1] ?? "";
    const team = LOOKUP.get(words);
    if (team === undefined) continue;
    const start = m.index;
    const end = start + words.length;
    const before = text.slice(Math.max(0, start - CUE_WINDOW), start);
    const after = text.slice(end, end + CUE_WINDOW);
    out.push({
      team,
      words,
      start,
      end,
      opponent: OPPONENT_BEFORE_RE.test(before) || OPPONENT_AFTER_RE.test(after),
    });
  }
  return out;
}

/** The teams a (sanitised, case-preserved) text names, sorted (as the subject's or the opponent). */
export function teamsMentioned(text: string): readonly NflTeam[] {
  return [...new Set(teamMentions(text).map((m) => m.team))].sort();
}
