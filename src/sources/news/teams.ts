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
// team, and the one form no cue word can turn into his opponent — and the team of a roster move
// the item states (`movedTeams`: "Bengals sign CB Lamar Jackson", "Lamar Jackson: Waived by
// Bengals"). A cue word BETWEEN two teams names a game ("Bills vs. Ravens"): it says the subject
// plays in it, never which side he is on (`pair`; Stage C remediation news-match-universe-homonyms,
// attempt 4).
//
// Two readings of the cues (ruling R8-3, changelog §R8; plan 07 D6). `cue`, `opponent` and `pair`
// are the reading a name only one universe player holds is matched with, exactly as before R8-3:
// against, vs, vs., versus, facing, and "<team> matchup". `shared` is the reading the matcher
// decides between the holders of a shared name with (R8-3 clause 3: a team named as the other side
// of a game or a play is the opponent), over a closed, tested list: those words, the result wording
// of RESULT_CUES ("win over", "loss to", "lost to", "beat", "fell to", "past" …), the play wording of
// PLAY_CUES ("sacks the <team> QB", "picks off a <team> pass", "torches the <team>'s secondary" …),
// and, between two teams only, the game wording of GAME_CUES ("Vikings host Browns", "the Browns'
// loss to the Vikings"). A result word right before a team's possessive is no cue ("beats the
// Browns' sack record", "fell to the Browns' third string" are the team's own); a play word is
// ("sacks the Vikings' quarterback"). Words outside the lists stay no evidence either way (no verb
// parsing: R7-4's precedent). Each word is one news wording uses for the other side of the subject's
// game or play; words the subject's own team often follows are left out: "at", "tops", "visits",
// "faces" and "over" alone ("at the Browns' facility", "tops the Browns' depth chart", "visits Bears"
// for a free agent's workout, "faces Browns' fine", "took over the Browns' duties").
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
/** A cue phrase as a pattern: its words as written, any whitespace between them. */
const phrase = (w: string): string => w.split(" ").map(escape).join("\\s+");
/** An alternation of phrases, the longest first (so "picks off" wins over a shorter cue). */
const alternation = (words: readonly string[]): string =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map(phrase)
    .join("|");
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
  /**
   * Which cue made it the opponent: a cue word `before` it ("against the Ravens") — said of the
   * item's subject — or "matchup" `after` it ("Ravens matchup"), which as often names his own
   * team's game as his opponent ("Expected to start in Ravens matchup"); null without a cue.
   */
  readonly cue: "before" | "after" | null;
  /**
   * The other team of a GAME the item names — "Bills vs. Ravens", "Steelers facing the Ravens",
   * "the Bengals' game versus the Vikings": a cue word between two teams (a possessive and a word
   * like "game" may stand before the cue) relates the teams to each other, not the subject to one of
   * them, so it says only that the item's subject plays in that game. Set on both mentions; null
   * otherwise. (Stage C finding news-match-universe-homonyms, attempt 4: read as an opponent cue,
   * "Bengals vs. Vikings: Justin Jefferson questionable" ruled the Vikings WR out of his own game.)
   */
  readonly pair: { readonly team: NflTeam; readonly start: number } | null;
  /**
   * The shared-name reading of the same mention (ruling R8-3 clause 3; the header): `cue` over the
   * closed lists (the words above, RESULT_CUES, PLAY_CUES; "matchup" after it as above), `pair` over
   * GAME_CUES between two teams. A shared name's holders are told apart with it; a unique name is
   * matched with the reading above.
   */
  readonly shared: {
    readonly cue: "before" | "after" | null;
    readonly pair: { readonly team: NflTeam; readonly start: number } | null;
  };
}

/** The cue words before a team that a unique name's reading knows (unchanged by R8-3). */
export const LEGACY_CUES: readonly string[] = Object.freeze([
  "against",
  "vs",
  "vs.",
  "versus",
  "facing",
]);
/**
 * Result wording (R8-3 clause 3): the team right after it is the other side of the subject's game —
 * unless a possessive follows the team ("tops the Browns' depth chart": a thing of that team). The
 * subject's own side is never named by it ("Leads Vikings past Browns": the Vikings are no cue's).
 */
// prettier-ignore
export const RESULT_CUES: readonly string[] = Object.freeze([
  "win over", "wins over", "victory over", "victories over", "triumph over", "rout of",
  "loss to", "losses to", "lost to", "lose to", "loses to", "losing to",
  "fell to", "falls to", "fall to", "falling to",
  "beat", "beats", "beating", "defeat", "defeats", "defeated", "defeating",
  "past", "matchup with", "matchups with",
]);
/**
 * Play wording (R8-3 clause 3): the team right after it — its quarterback, pass, runner or
 * secondary, a possessive allowed — is the other side of the subject's play.
 */
// prettier-ignore
export const PLAY_CUES: readonly string[] = Object.freeze([
  "sack", "sacks", "sacked", "sacking", "strip-sack", "strip-sacks", "strip-sacked",
  "intercept", "intercepts", "intercepted", "intercepting",
  "pick off", "picks off", "picked off", "picking off",
  "tackle", "tackles", "tackled", "tackling",
  "bring down", "brings down", "brought down", "bringing down",
  "torch", "torches", "torched", "torching", "burn", "burns", "burned",
  "gash", "gashes", "gashed", "shred", "shreds", "shredded",
]);
/**
 * Game wording BETWEEN two teams (R8-3): every cue above, and the words that name a game only when
 * a team stands on each side ("Vikings host Browns", "the Ravens visit the Bengals", "the Vikings
 * face the Browns"). After a single team they name no opponent ("visits Bears" may be a workout).
 */
export const GAME_CUES: readonly string[] = Object.freeze([
  ...LEGACY_CUES,
  ...RESULT_CUES,
  ...PLAY_CUES,
  "host",
  "hosts",
  "hosted",
  "hosting",
  "visit",
  "visits",
  "visited",
  "visiting",
  "face",
  "faces",
  "faced",
]);

/** A cue word ending the text before a mention (with an optional "the"). */
const OPPONENT_BEFORE_RE = /(?<![\p{L}\p{N}])(?:against|vs\.?|versus|facing)\s+(?:the\s+)?$/iu;
/** "matchup" right after a mention (whitespace only between). */
const OPPONENT_AFTER_RE = /^\s+matchups?(?![\p{L}\p{N}])/iu;
/** The longest cue before a mention ("victories over the " plus slack): the look-behind window. */
const CUE_WINDOW = 24;
/**
 * The whole text between two teams that names a game between them: an optional possessive, an
 * optional game word, then the cue word and an optional "the" ("Bills vs. ", "Steelers facing the ",
 * "Bengals' game versus the "). Anything else between them — a name, a verb, a clause — is no pair.
 */
const PAIR_GAP_RE =
  /^(?:['’ʼ]s?)?(?:\s+(?:game|matchup|contest|meeting|clash|showdown|tilt))?\s+(?:against|vs\.?|versus|facing)\s+(?:the\s+)?$/iu;
/** The shared-name reading's cue before a mention: a legacy or play cue, an article allowed. */
const SHARED_BEFORE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${alternation([...LEGACY_CUES, ...PLAY_CUES])})\\s+(?:(?:the|a|an)\\s+)?$`,
  "iu",
);
/** The shared-name reading's result cue before a mention (refused before a possessive). */
const SHARED_RESULT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${alternation(RESULT_CUES)})\\s+(?:(?:the|a|an)\\s+)?$`,
  "iu",
);
/** A possessive right after a mention ("Browns'", "Browns's"). */
const POSSESSIVE_AFTER_RE = /^['’ʼ](?:s(?![\p{L}\p{N}]))?/u;
/**
 * The shared-name reading's game between two teams: as PAIR_GAP_RE, with GAME_CUES and an optional
 * score ("the Vikings' 24-20 win over the Browns", "Vikings host Browns", "Browns' loss to the ").
 */
const SHARED_PAIR_GAP_RE = new RegExp(
  `^(?:['’ʼ]s?)?(?:\\s+\\d{1,2}-\\d{1,2})?(?:\\s+(?:game|matchup|contest|meeting|clash|showdown|tilt))?\\s+(?:${alternation(GAME_CUES)})\\s+(?:(?:the|a|an)\\s+)?$`,
  "iu",
);

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
    const cue = OPPONENT_BEFORE_RE.test(before)
      ? "before"
      : OPPONENT_AFTER_RE.test(after)
        ? "after"
        : null;
    const sharedCue =
      SHARED_BEFORE_RE.test(before) ||
      (SHARED_RESULT_RE.test(before) && !POSSESSIVE_AFTER_RE.test(after))
        ? "before"
        : OPPONENT_AFTER_RE.test(after)
          ? "after"
          : null;
    const prev = out[out.length - 1];
    const gap = prev === undefined ? "" : text.slice(prev.end, start);
    const pairs =
      cue === "before" && prev !== undefined && prev.team !== team && PAIR_GAP_RE.test(gap);
    const game = prev !== undefined && prev.team !== team && SHARED_PAIR_GAP_RE.test(gap);
    if (prev !== undefined && (pairs || game))
      out[out.length - 1] = {
        ...prev,
        pair: pairs ? { team, start } : prev.pair,
        shared: { cue: prev.shared.cue, pair: game ? { team, start } : prev.shared.pair },
      };
    out.push({
      team,
      words,
      start,
      end,
      opponent: cue !== null,
      cue,
      pair: pairs ? { team: prev.team, start: prev.start } : null,
      shared: {
        cue: sharedCue,
        pair: game ? { team: prev.team, start: prev.start } : null,
      },
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

/**
 * A roster move a team makes, before the player it names: "Bengals sign CB Lamar Jackson", "Browns
 * waive LB Justin Jefferson" (role words may stand between the verb and the name).
 */
const TEAM_MOVES_RE = new RegExp(
  `^\\s+(?:re-?)?(?:sign|signs|signed|waive|waives|waived|release|releases|released|claim|claims|claimed|cut|cuts|promote|promotes|promoted|elevate|elevates|elevated|activate|activates|activated)(?:\\s+(?:${ATTACH_ALT}))*\\s+$`,
  "iu",
);
/**
 * The roster move a player's clause states, before the team it names: "Lamar Jackson: Signs with
 * Bengals", "…: Waived by Bengals", "…: Lands on Bengals practice squad", "…, signed to the Browns'
 * practice squad". Never a trade ("traded to", "dealt to"): a traded player's team in the universe
 * is the one he left, and his news must not be blocked by it.
 */
const PLAYER_MOVE_RE =
  /^\s*[:,]?\s*(?:(?:is|was|has\s+been|gets|got)\s+)?(?:re-?)?(?:signs?|signed|inks?|inked|joins?|joined|waived|released|cut|claimed(?:\s+off\s+waivers)?|promoted|elevated|lands?|landed)\s+(?:(?:with|by|to|on|onto)\s+)?(?:the\s+)?$/iu;

/**
 * The teams a roster move ties to the name at [start, end): a team that signs, waives, claims or
 * promotes him ("Bengals sign CB Lamar Jackson") or that his own clause says he signs with, is
 * waived by or lands on ("Lamar Jackson: Signs with Bengals"). Like an attached team it is his own
 * (new or last) team — the matcher reads both alike — and a team named any other way is not one.
 * Stage C finding news-match-universe-homonyms, attempt 4: such a namesake's move went to the star.
 */
export function movedTeams(
  text: string,
  mentions: readonly TeamMention[],
  start: number,
  end: number,
): ReadonlySet<NflTeam> {
  const out = new Set<NflTeam>();
  for (const m of mentions) {
    if (m.end <= start) {
      if (start - m.end <= ATTACH_WINDOW && TEAM_MOVES_RE.test(text.slice(m.end, start)))
        out.add(m.team);
    } else if (m.start >= end && m.start - end <= ATTACH_WINDOW) {
      if (PLAYER_MOVE_RE.test(text.slice(end, m.start))) out.add(m.team);
    }
  }
  return out;
}

/** The teams a (sanitised, case-preserved) text names, sorted (as the subject's or the opponent). */
export function teamsMentioned(text: string): readonly NflTeam[] {
  return [...new Set(teamMentions(text).map((m) => m.team))].sort();
}
