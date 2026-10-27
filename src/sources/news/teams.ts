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
// The cue list is NOT exhaustive and never can be ("win over", "loss to", "at", "host", "matchup
// with" … all name an opponent): a mention without a cue may be the subject's team or his opponent,
// so the matcher never reads one as evidence FOR a namesake (match.ts). Only a team written next to
// the name is (`attachedTeams`: "Vikings WR Justin Jefferson", "Vikings' Justin Jefferson", "Justin
// Jefferson, Vikings:", "Justin Jefferson (Vikings)") — the form a writer uses for the player's own
// team, and the one form no cue word can turn into his opponent.
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

/**
 * The position and role words that may stand between a team and the player it is attached to
 * ("Vikings WR", "Ravens star QB", "Bears tight end", "(Browns LB)"). Nouns only: never a preposition,
 * a conjunction, a cue word or a word that is also a verb ("end", "back", "guard", "tackle", "pass"
 * stand only inside a two-word position), so "Browns tackle Justin Jefferson" attaches no team.
 */
// prettier-ignore
export const ATTACH_WORDS: readonly string[] = Object.freeze([
  "qb", "rb", "wr", "te", "k", "p", "fb", "lb", "ilb", "olb", "mlb", "cb", "s", "fs", "ss", "db",
  "de", "dt", "nt", "dl", "edge", "ol", "ot", "og", "c", "ls", "kr", "pr",
  "qb1", "qb2", "rb1", "rb2", "rb3", "wr1", "wr2", "wr3", "te1", "te2",
  "quarterback", "halfback", "fullback", "receiver", "wideout", "kicker", "punter", "linebacker",
  "cornerback", "safety", "lineman", "returner", "star", "rookie", "veteran", "backup", "starter",
  "starting", "running back", "wide receiver", "tight end", "defensive end", "defensive tackle",
  "defensive back", "nose tackle", "offensive tackle", "left tackle", "right tackle", "pass rusher",
  "free safety", "strong safety", "kick returner", "punt returner", "long snapper",
]);

const ATTACH_ALT = [...ATTACH_WORDS]
  .sort((a, b) => b.length - a.length)
  .map((w) => w.split(" ").map(escape).join("\\s+"))
  .join("|");
/** Between a team and a name after it: a possessive, then role words only ("Vikings' star WR "). */
const BEFORE_NAME_RE = new RegExp(`^(?:['’ʼ]s?)?(?:\\s+(?:${ATTACH_ALT}))*\\s+$`, "iu");
/** Between a name and a team after it: a comma, or an opening parenthesis. */
const COMMA_GAP_RE = /^\s*,\s*$/u;
const PAREN_GAP_RE = /^\s*\(\s*$/u;
/** After "<name>, <team>": role words, then the clause ends (":", ",", ";", "|", ")", a dash, the end). */
const AFTER_COMMA_RE = new RegExp(
  `^(?:\\s+(?:${ATTACH_ALT}))*\\s*(?:[:;,|)]|[-–—](?=\\s|$)|$)`,
  "iu",
);
/** After "<name> (<team>": role words, then ")". */
const AFTER_PAREN_RE = new RegExp(`^(?:\\s+(?:${ATTACH_ALT}))*\\s*\\)`, "iu");
/** How far from a name an attached team may sit (the gaps above are short; bounded work). */
const ATTACH_WINDOW = 64;

/**
 * The teams written next to the name at [start, end) of the text — its own team as the writer
 * attaches it: "<team>['s] [role words] <name>", "<name>, <team> [role words]" closing the clause,
 * or "<name> (<team> [role words])". `mentions` are the text's (`teamMentions`, minus any the matcher
 * reads as part of a name). A cue word never makes an attached team the opponent: "against the
 * Vikings' Justin Jefferson" attaches the Vikings to him.
 */
export function attachedTeams(
  text: string,
  mentions: readonly TeamMention[],
  start: number,
  end: number,
): ReadonlySet<NflTeam> {
  const out = new Set<NflTeam>();
  for (const m of mentions) {
    if (m.end <= start) {
      if (start - m.end <= ATTACH_WINDOW && BEFORE_NAME_RE.test(text.slice(m.end, start)))
        out.add(m.team);
    } else if (m.start >= end && m.start - end <= ATTACH_WINDOW) {
      const gap = text.slice(end, m.start);
      const after = text.slice(m.end, m.end + ATTACH_WINDOW);
      if (
        (COMMA_GAP_RE.test(gap) && AFTER_COMMA_RE.test(after)) ||
        (PAREN_GAP_RE.test(gap) && AFTER_PAREN_RE.test(after))
      )
        out.add(m.team);
    }
  }
  return out;
}

/** The teams a (sanitised, case-preserved) text names, sorted (as the subject's or the opponent). */
export function teamsMentioned(text: string): readonly NflTeam[] {
  return [...new Set(teamMentions(text).map((m) => m.team))].sort();
}
