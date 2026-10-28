// cues.ts — the shared-name reading of a news item's teams and cue words, for the player matcher
// (ruling R8-3, changelog §R8: clause 2, "a team named loosely … is never evidence FOR a holder. It
// can only rule a holder out"; clause 3, "a team named as the other side of a game or a play is the
// opponent … as a closed, tested list"; plan 07 D6; plan 02 §6.4 — rules over closed lists, never a
// model). match.ts tells the holders of a shared name apart with it; a name only one universe player
// holds keeps teams.ts' reading, exactly as before R8-3.
//
// The teams (`sharedMentions`): each nickname and home as written, and in capitals ("VIKINGS", an
// all-caps headline), and the short names feeds write (teams.ts TEAM_SHORT_NAMES: "the Vikes"). A
// team's full name is one mention ("the Minnesota Vikings", "the Los Angeles Rams"): a cue is read
// before its first word, and its home is no second, loose mention. An abbreviation (teams.ts
// TEAM_ABBREVIATIONS, in capitals) is a team only where a context makes it one: right after a cue
// word ("vs. MIN", "@ MIN", "Sacks MIN QB"), in a tag ("Justin Jefferson, CLE:", "(PHI)", "(CLE -
// LB)"), or on a game's first side, before the next team ("MIN vs. CLE"). The reading is linear in
// an item's teams and abbreviations (fix round 3: one pass over each, never every pair of them).
//
// The cue words, each list closed and held by the tests word for word and entry by entry:
//   AGAINST_CUES      against, vs, vs., versus, facing, @ — the other side of the subject's game;
//   RESULT_CUES       "win over", "loss to", "lost to", "beat", "fell to", "past", "win at", "loss
//                     at", "matchup with" … — the other side of his result;
//   PLAY_CUES         "sacks", "intercepts", "picks off", "tackles", "brings down", "torches" … — the
//                     other side of his play;
//   PLAY_OBJECT_CUES  "strips", "forces", "blocks", "drops", "gets to" … — the same, only before the
//                     team's player or ball ("Strips Vikings QB", "forced a Vikings fumble", "Blocks
//                     Ravens punt"): alone they are any verb;
//   PASSIVE_PLAY_CUES the same, done to him, before "by" ("Sacked five times by Steelers", "Burned by
//                     Chiefs receiver for touchdown");
//   GAME_CUES         between two teams only: every word above, and "host", "visit", "face", "at"
//                     ("Vikings host Browns", "Vikings at Bears" name a game the subject plays in,
//                     never his side: `pair`);
//   "<team> matchup"  after a team: his own team's game as often as his opponent's (`weak`).
// A cue holds only where the words after the team read as the game or the play (closed lists, no
// verb parsing, R7-4's precedent): after a play word, the team's player or unit (PLAY_OBJECTS: "QB",
// "pass", "secondary", "cornerback", "safety" …, never one that only modifies a noun after it:
// "the Browns' linebacker depth"), a possessive allowed, or "for" and a number (NUMBER_WORDS: "for
// three touchdowns"); otherwise also punctuation, a number, the end, or a word of CUE_CONTINUATIONS
// ("in", "on", "for", "twice", the days …). It does not hold where the team's own thing follows: a
// possessive after a result word ("beats the Browns' sack record"), a hyphen ("Facing Browns-imposed
// suspension"), any other word ("Beats Browns teammate", "Facing Eagles discipline"); nor before a
// dispute's "against" (DISPUTE_WORDS: "Files grievance against Browns", "Holds out against Browns",
// "Arbitrator rules against Browns"); nor in the idioms that use a result word for a team's loss of
// its own player, in any case: a duration after a result (DURATION_WORDS: "lost to the Browns for the
// season", "…until December"); "lost to" after a copula (COPULAS) or at a clause's opening ("is lost
// to the Chiefs", "Is Lost To Browns", "…: Lost to Browns until December"); "loss to" after a copula,
// a contraction, a clause's opening with an article or with words of LOSS_DEGREE_WORDS, or a word that
// is no preposition and an article ("is a big loss to the Eagles", "…: A big loss to Browns", "…: Big
// loss to Browns as LB lands on IR", "Injury a big loss to Eagles"; a preposition of
// GAME_PREPOSITIONS or a score keeps it a game: "in a big loss to the Browns", "…, a 24-20 loss");
// the draft (DRAFT_WORDS: "fell to the Browns in the fifth round"); and a passive play's demand
// (PASSIVE_PURPOSE_WORDS: "Pressured by Browns to take pay cut"). Words outside the lists are no cue
// either way. Whose game or play a cue names — the person the sentence is written about — is
// match.ts's to decide.
//
// The labels (`sharedAttachedTeams`, `sharedListTeams`) and the roster moves (`sharedMovedTeams`)
// read closed lists too: the label words (teams.ts ATTACH_WORDS, positions.ts POSITION_WORDS and
// POSITION_MODIFIERS, LABEL_ROLE_NOUNS, LABEL_PLURALS; VERB_LIKE_LABELS only where they cannot be a
// verb), and the moves (teams.ts' verbs, SHARED_TEAM_MOVE_WORDS, PLACE_WORDS with RESERVE_LISTS,
// SHARED_PLAYER_MOVE_WORDS).
import type { NflTeam } from "../../config/schema.js";
import { POSITION_COMPOUND_HEADS, POSITION_MODIFIERS, POSITION_WORDS } from "./positions.js";
import {
  ATTACH_WORDS,
  LEGACY_CUES,
  PLAYER_MOVE_RE,
  SHARED_HOMES,
  TEAM_ABBREVIATIONS,
  TEAM_HOMES,
  TEAM_MOVES_RE,
  TEAM_NICKNAMES,
  TEAM_SHORT_NAMES,
} from "./teams.js";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A phrase as a pattern: its words as written, any whitespace between them. */
const phrase = (w: string): string => w.split(" ").map(escape).join("\\s+");
/** An alternation of phrases, the longest first (so "picks off" wins over a shorter cue). */
const alternation = (words: readonly string[]): string =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map(phrase)
    .join("|");

/** The other side of the subject's game: the unique reading's words, and "@" ("@ MIN"). */
export const AGAINST_CUES: readonly string[] = Object.freeze([...LEGACY_CUES, "@"]);
/**
 * Result wording (R8-3 clause 3): the team right after it is the other side of the subject's game.
 * Never before the team's possessive ("tops the Browns' depth chart": a thing of that team).
 */
// prettier-ignore
export const RESULT_CUES: readonly string[] = Object.freeze([
  "win over", "wins over", "victory over", "victories over", "triumph over", "rout of",
  "shutout of", "blowout of", "win at", "wins at", "victory at",
  "loss to", "losses to", "lost to", "lose to", "loses to", "losing to", "loss at", "losses at",
  "beat", "beats", "beating", "defeat", "defeats", "defeated", "defeating",
  "past", "matchup with", "matchups with",
]);
/**
 * Result wording a team is the subject of ("the Vikings fell to the Lions"): a cue only between two
 * teams. After a player it is the draft ("Jefferson fell to the Browns in the fifth round").
 */
export const TEAM_RESULT_CUES: readonly string[] = Object.freeze([
  "fell to",
  "falls to",
  "fall to",
  "falling to",
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
 * More play wording ("Strips Vikings QB", "forced a Vikings fumble", "Blocks Ravens punt"). Every
 * play word, these and PLAY_CUES alike, is a cue only before the team's player, ball or unit, or
 * before "for" and a number ("Torches Browns for 150 yards"): "torched the Browns on social media"
 * is no play.
 */
// prettier-ignore
export const PLAY_OBJECT_CUES: readonly string[] = Object.freeze([
  "strip", "strips", "stripped", "stripping", "force", "forces", "forced", "forcing",
  "block", "blocks", "blocked", "blocking", "drop", "drops", "dropped", "dropping",
  "get to", "gets to", "got to", "getting to", "pressure", "pressures", "pressured", "pressuring",
  "stuff", "stuffs", "stuffed", "stuffing",
]);
/**
 * Play wording done to the subject, before "by" ("Sacked five times by Steelers", "Burned by Chiefs
 * receiver for touchdown"). Never before "to" or "into": "Pressured by Browns to take pay cut" is
 * his own team's demand (PASSIVE_PURPOSE_WORDS).
 */
// prettier-ignore
export const PASSIVE_PLAY_CUES: readonly string[] = Object.freeze([
  "sacked", "strip-sacked", "intercepted", "picked off", "tackled", "brought down", "stripped",
  "pressured", "stuffed", "burned", "torched", "gashed", "shredded",
  "beaten", "beat", "defeated", "upset", "routed", "edged", "blanked", "shut out",
]);
/** The words after a passive play's team that make it his own team's demand, not a play. */
export const PASSIVE_PURPOSE_WORDS: readonly string[] = Object.freeze(["to", "into"]);
/**
 * Game wording BETWEEN two teams: every cue above, and the words that name a game only when a team
 * stands on each side ("Vikings host Browns", "the Ravens visit the Bengals", "the Vikings face the
 * Browns", "Vikings at Bears"). After a single team they name no opponent ("visits Bears" may be a
 * workout, "at Bears" his own team's facility).
 */
export const GAME_CUES: readonly string[] = Object.freeze([
  ...AGAINST_CUES,
  ...RESULT_CUES,
  ...TEAM_RESULT_CUES,
  ...PLAY_CUES,
  ...PLAY_OBJECT_CUES,
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
  "at",
]);
/**
 * A team's player or unit a play is made on (lower case; any case written): the offense's for a
 * defender's play ("Sacks Vikings QB"), the defense's for an offensive one ("Burns Browns cornerback
 * for 60-yard TD", "Beats Browns safety for long touchdown"), each in the singular and the plural.
 */
// prettier-ignore
export const PLAY_OBJECTS: readonly string[] = Object.freeze([
  "qb", "qbs", "quarterback", "quarterbacks", "passer", "passers", "signal-caller", "pass",
  "passes", "throw", "throws", "rb", "running back", "running backs", "runner", "runners",
  "rusher", "rushers", "ball carrier", "ball carriers", "back", "backs", "wr", "receiver",
  "receivers", "wideout", "wideouts", "te", "tight end", "tight ends", "offense",
  "offensive line", "o-line", "line", "front", "front seven", "defense", "defensive line",
  "d-line", "secondary", "cornerbacks", "corners", "safeties", "linebackers", "defensive backs",
  "pass rush", "pass defense", "run defense", "coverage", "punt", "punts", "punter", "kick",
  "kicks", "kicker", "field goal", "field-goal", "extra point", "fumble", "snap", "snaps",
  "returner", "starter", "starters", "star",
  "cornerback", "corner", "cb", "cbs", "safety", "linebacker", "lb", "lbs", "db", "dbs",
  "defensive back", "defender", "defenders", "nickelback", "nickel back", "pass rusher",
  "pass rushers", "edge rusher", "edge rushers", "defensive end", "defensive ends",
  "defensive tackle", "defensive tackles", "defensive lineman", "defensive linemen",
  "left tackle", "right tackle", "rbs", "wrs", "tes", "returners", "punters", "kickers", "stars",
]);
/** Number words a play's "for" may count with ("Torches Bengals for three touchdowns"). */
// prettier-ignore
export const NUMBER_WORDS: readonly string[] = Object.freeze([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
]);
/** The words that may follow a cued team in a game's or a play's wording (any case). */
// prettier-ignore
export const CUE_CONTINUATIONS: readonly string[] = Object.freeze([
  "a", "an", "the", "on", "in", "at", "by", "with", "without", "to", "for", "from", "of", "into",
  "over", "under", "after", "before", "during", "despite", "behind", "since", "until", "through",
  "throughout", "amid", "via", "following", "as", "and", "or", "but", "nor", "while", "when",
  "where", "which", "who", "whose", "that", "this", "these", "if", "because", "although",
  "though", "so", "yet", "then", "again", "twice", "once", "thrice", "too", "also", "even",
  "only", "just", "now", "here", "there", "last", "next", "earlier", "later", "early", "late",
  "yesterday", "today", "tonight", "week", "weekend", "season", "night", "thanks", "en", "home",
  "away", "times", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
]);

/** How a cue names the team after it. */
export type SharedCueKind = "against" | "result" | "play" | "passive";

/** The cue word before a mention: its kind, its words and where it starts. */
export interface SharedCue {
  readonly kind: SharedCueKind;
  readonly words: string;
  readonly start: number;
}

/** One team a text names, in the shared-name reading. */
export interface SharedMention {
  readonly team: NflTeam;
  /** Offsets of its words (a team's full name whole): [start, end). */
  readonly start: number;
  readonly end: number;
  readonly form: "name" | "caps" | "abbreviation";
  /** The cue word that names it as the other side of a game or a play, or null. */
  readonly cue: SharedCue | null;
  /** "<team> matchup": his own team's game as often as his opponent's. */
  readonly weak: boolean;
  /** The other team of the game a cue word between two teams names, or null. */
  readonly pair: { readonly team: NflTeam; readonly start: number } | null;
}

interface NameForm {
  readonly team: NflTeam | null;
  /** The teams a home that holds two may begin the full name of. */
  readonly teams: readonly NflTeam[];
  readonly home: boolean;
  readonly caps: boolean;
}

const NAME_FORMS: ReadonlyMap<string, NameForm> = (() => {
  const out = new Map<string, NameForm>();
  const add = (k: string, f: Omit<NameForm, "caps">): void => {
    out.set(k, { ...f, caps: false });
    if (k.toUpperCase() !== k) out.set(k.toUpperCase(), { ...f, caps: true });
  };
  for (const [k, t] of Object.entries(TEAM_NICKNAMES)) add(k, { team: t, teams: [t], home: false });
  for (const [k, t] of Object.entries(TEAM_SHORT_NAMES))
    add(k, { team: t, teams: [t], home: false });
  for (const [k, t] of Object.entries(TEAM_HOMES)) add(k, { team: t, teams: [t], home: true });
  for (const [k, ts] of Object.entries(SHARED_HOMES)) add(k, { team: null, teams: ts, home: true });
  return out;
})();
const NAME_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${alternation([...NAME_FORMS.keys()])})(?![\\p{L}\\p{N}])`,
  "gu",
);
const ABBREVIATION_RE = new RegExp(
  `(?<![\\p{L}\\p{N}'’ʼ.-])(${Object.keys(TEAM_ABBREVIATIONS).join("|")})(?![\\p{L}\\p{N}'’ʼ-])`,
  "gu",
);
/**
 * The words after a result's team that make it a duration, the team's loss of its own player:
 * "lost to the Browns for the season", "…until December" (any case).
 */
export const DURATION_WORDS: readonly string[] = Object.freeze(["for", "until", "till"]);
/** The draft, later in a result's clause ("fell to the Browns in the fifth round"; and "No. 150"). */
// prettier-ignore
export const DRAFT_WORDS: readonly string[] = Object.freeze([
  "round", "draft", "pick", "overall", "selection",
]);
/**
 * A dispute before "against": the team after it is his own side's ("Files grievance against
 * Browns", "Holds out against Browns", "Arbitrator rules against Browns"), never his opponent.
 */
// prettier-ignore
export const DISPUTE_WORDS: readonly string[] = Object.freeze([
  "grievance", "grievances", "lawsuit", "lawsuits", "suit", "complaint", "complaints", "appeal",
  "claim", "claims", "case", "charge", "charges", "ruling", "decision", "fine", "discipline",
  "action", "motion", "protest", "arbitration", "hearing", "testimony", "holds out", "held out",
  "holding out", "hold out", "rules", "ruled", "decides", "decided", "sides", "sided",
  "testifies", "testified",
]);
/** The copulas before "loss to" or "lost to" that make it the team's loss of a player (any case). */
// prettier-ignore
export const COPULAS: readonly string[] = Object.freeze([
  "is", "was", "are", "were", "be", "been", "being", "remains", "remained", "represents",
  "represented", "becomes", "became",
]);
/**
 * The prepositions that make "a … loss to <team>" a game ("in a big loss to the Browns", "after a
 * loss to"): before one, the noun phrase is a result; any other word before "a <words> loss to" makes
 * it the team's loss of a player ("Injury a big loss to Eagles"). Also never a word of the phrase.
 */
// prettier-ignore
export const GAME_PREPOSITIONS: readonly string[] = Object.freeze([
  "in", "after", "during", "despite", "following", "since", "before", "from", "off", "with",
  "without", "amid", "through", "into", "on", "of", "by", "over", "under", "at", "to", "for",
  "upon", "behind", "until", "around", "against", "via", "within", "throughout", "toward",
  "towards",
]);
/** The game words that may stand between a team's possessive and a cue ("the Bengals' game versus"). */
// prettier-ignore
export const PAIR_GAME_WORDS: readonly string[] = Object.freeze([
  "game", "matchup", "contest", "meeting", "clash", "showdown", "tilt",
]);
const ARTICLE = "(?:(?:the|a|an)\\s+)?";
const NUMBER_ALT = alternation(NUMBER_WORDS);
/** The cue words before a mention, each kind's (the words captured). */
const CUE_RES: readonly (readonly [SharedCueKind, RegExp, boolean])[] = [
  [
    "against",
    new RegExp(
      `(?:(?<![\\p{L}\\p{N}])(${alternation(LEGACY_CUES)})\\s+|(?<![\\p{L}\\p{N}@])(@)\\s*)${ARTICLE}$`,
      "iu",
    ),
    false,
  ],
  [
    "passive",
    new RegExp(
      `(?<![\\p{L}\\p{N}])(${alternation(PASSIVE_PLAY_CUES)})(?:\\s+(?:\\d+|${NUMBER_ALT})\\s+times|\\s+(?:twice|once|again|repeatedly))?\\s+by\\s+${ARTICLE}$`,
      "iu",
    ),
    false,
  ],
  [
    "result",
    new RegExp(`(?<![\\p{L}\\p{N}])(${alternation(RESULT_CUES)})\\s+${ARTICLE}$`, "iu"),
    false,
  ],
  [
    "play",
    new RegExp(
      `(?<![\\p{L}\\p{N}])(${alternation([...PLAY_CUES, ...PLAY_OBJECT_CUES])})\\s+${ARTICLE}$`,
      "iu",
    ),
    true,
  ],
];
/** The longest cue before a mention ("brought down three times by the " plus slack). */
const CUE_WINDOW = 40;
/** What may follow a cued team, read from right after it. */
const POSSESSIVE_RE = /^['’ʼ](?:s(?![\p{L}\p{N}]))?/u;
/**
 * The team's player or unit, never a modifier of a noun after it ("the Browns' front office", "the
 * Browns' linebacker depth", "…cornerback room": positions.ts POSITION_COMPOUND_HEADS).
 */
const OBJECT_RE = new RegExp(
  `^\\s+(?:${alternation(PLAY_OBJECTS)})(?![\\p{L}\\p{N}])(?!\\s+(?:office|${alternation(POSITION_COMPOUND_HEADS)})(?![\\p{L}\\p{N}]))`,
  "iu",
);
const NAME_AFTER_RE = /^\s+\p{Lu}/u;
const CONTINUES_RE = new RegExp(
  `^(?:\\s*$|\\s*[^\\p{L}\\p{N}\\s'’ʼ-]|\\s+[-–—](?=\\s|$)|\\s+\\d|\\s+(?:${alternation(CUE_CONTINUATIONS)})(?![\\p{L}\\p{N}]))`,
  "iu",
);
const DURATION_RE = new RegExp(`^\\s+(?:${alternation(DURATION_WORDS)})(?![\\p{L}\\p{N}])`, "iu");
const DRAFT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${alternation(DRAFT_WORDS)}|No\\.?\\s*\\d+)(?![\\p{L}\\p{N}])`,
  "iu",
);
/**
 * The words that may stand between a clause's opening and "loss to" with no article before them
 * ("…: Big loss to Browns as LB lands on IR"; any case): the size of a team's loss of a player.
 */
// prettier-ignore
export const LOSS_DEGREE_WORDS: readonly string[] = Object.freeze([
  "big", "bigger", "biggest", "huge", "major", "massive", "significant", "serious", "tough",
  "crushing", "devastating", "brutal", "costly", "key", "notable", "sizable", "considerable",
  "substantial", "enormous", "real", "potential", "possible", "early", "season-long", "long-term",
  "short-term", "temporary",
]);
/** A word that may modify "loss" in its idiom: letters only (a score keeps it a game), no preposition. */
const LOSS_WORD = `(?!(?:${alternation(GAME_PREPOSITIONS)}|the)(?![\\p{L}\\p{N}]))[\\p{L}-]+`;
/**
 * Where a clause opens: the text's start (the lead read is marked when it is not the text's start),
 * a colon, a semicolon, a bar, a comma, a parenthesis, a dash, a sentence's end.
 */
const CLAUSE_OPENING = "(?:^|[:;|,(—–]|\\s[-–—]|[.!?])\\s*";
/**
 * "loss to" as the team's loss of a player, in any case: after a copula ("is a big loss to the
 * Eagles", "Injury Is A Big Loss To Browns"), a contraction ("Jefferson's a big loss to"), a clause's
 * opening ("…: A big loss to Browns", "…, a big loss to the Browns", "… - a big loss to Cleveland",
 * "…: Big loss to Browns as LB lands on IR"), or a word that is no preposition and an article
 * ("Season-ending injury a big loss to Browns"); up to three words before "loss". A preposition keeps
 * it a game ("in a big loss to the Browns"), and so does a score ("…, a 24-20 loss to the Browns").
 */
const LOSS_IDIOM_RE = new RegExp(
  `(?:(?:(?<![\\p{L}\\p{N}])(?:${alternation(COPULAS)})\\s+(?:(?:a|an|another|the)\\s+)?|['’]s\\s+(?:a|an|another)\\s+|${CLAUSE_OPENING}(?:a|an|another)\\s+|(?<![\\p{L}\\p{N}])${LOSS_WORD}\\s+(?:a|an|another)\\s+)(?:${LOSS_WORD}\\s+){0,3}|${CLAUSE_OPENING}(?:(?:${alternation(LOSS_DEGREE_WORDS)})\\s+){0,3})$`,
  "iu",
);
/**
 * "lost to" as a passive or a participle, in any case: after a copula and at most one word ("is lost
 * to the Chiefs", "Is Lost To Browns"), or at a clause's opening ("…, lost to the Browns in free
 * agency", "…: Lost to Browns until December").
 */
const PASSIVE_LOST_RE = new RegExp(
  `(?:(?<![\\p{L}\\p{N}])(?:${alternation(COPULAS)})\\s+(?:${LOSS_WORD}\\s+)?|${CLAUSE_OPENING})$`,
  "iu",
);
const DISPUTE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation(DISPUTE_WORDS)})\\s+$`, "iu");
/** "for" and a number after a play's team ("Torches Browns for 150 yards", "for three touchdowns"). */
const FOR_NUMBER_RE = new RegExp(`^\\s+for\\s+(?:\\d|(?:${NUMBER_ALT})(?![\\p{L}\\p{N}]))`, "iu");
/** "to" or "into" after a passive play's team: his own team's demand ("Pressured by Browns to take"). */
const PASSIVE_PURPOSE_RE = new RegExp(
  `^\\s+(?:${alternation(PASSIVE_PURPOSE_WORDS)})(?![\\p{L}\\p{N}])`,
  "iu",
);
const WEAK_AFTER_RE = /^\s+matchups?(?![\p{L}\p{N}])/iu;
/** Between the two teams of a game: a possessive, a score, a game word, the cue, an article. */
const PAIR_GAP_RE = new RegExp(
  `^(?:['’ʼ]s?)?(?:\\s+\\d{1,2}-\\d{1,2})?(?:\\s+(?:${alternation(PAIR_GAME_WORDS)}))?(?:\\s+(?:${alternation(GAME_CUES.filter((w) => w !== "@"))})\\s+|\\s*@\\s*)${ARTICLE}$`,
  "iu",
);
const POSITION_ALT = alternation(Object.keys(POSITION_WORDS));
/** A tag around an abbreviation: "(", "," or "(LB - " before it; ")", ":", " - LB)" after it. */
const TAG_BEFORE_RE = new RegExp(`[(,]\\s*(?:(?:${POSITION_ALT})\\s*[-–,/]?\\s*)?$`, "iu");
const TAG_AFTER_RE = new RegExp(
  `^\\s*(?:[-–,/]\\s*(?:${POSITION_ALT})\\s*)?(?:[):;,|]|[-–—](?=\\s|$)|$)`,
  "iu",
);

/** The cue word right before offset `start`, or null. */
function cueBefore(
  text: string,
  start: number,
): (SharedCue & { readonly objectOnly: boolean }) | null {
  const from = Math.max(0, start - CUE_WINDOW);
  const before = text.slice(from, start);
  for (const [kind, re, objectOnly] of CUE_RES) {
    const m = re.exec(before);
    if (m !== null)
      return { kind, words: (m[1] ?? m[2] ?? "").toLowerCase(), start: from + m.index, objectOnly };
  }
  return null;
}

/** Whether the cue before the team at [start, end) holds there (the header's rule). */
function cueHolds(
  text: string,
  cue: SharedCue & { readonly objectOnly: boolean },
  end: number,
): boolean {
  const after = text.slice(end, end + 48);
  // the lead before the cue; "\0" marks a cut, so a clause opening at its start is only the text's
  const from = Math.max(0, cue.start - 48);
  const lead = (from === 0 ? "" : "\u0000") + text.slice(from, cue.start);
  if (cue.kind === "against" && DISPUTE_RE.test(lead)) return false;
  const possessive = POSSESSIVE_RE.exec(after);
  if (possessive !== null) {
    if (cue.kind === "result") return false;
    const rest = after.slice(possessive[0].length);
    return OBJECT_RE.test(rest) || NAME_AFTER_RE.test(rest);
  }
  if (cue.objectOnly) return OBJECT_RE.test(after) || FOR_NUMBER_RE.test(after);
  if (cue.kind === "passive" && PASSIVE_PURPOSE_RE.test(after)) return false;
  if (!OBJECT_RE.test(after) && !CONTINUES_RE.test(after)) return false;
  if (cue.kind !== "result") return true;
  if (DURATION_RE.test(after)) return false;
  const clause = /^[^.;|!?]*/u.exec(text.slice(end, end + 160))?.[0] ?? "";
  if (DRAFT_RE.test(clause)) return false;
  const words = cue.words.replace(/\s+/gu, " ");
  if ((words === "loss to" || words === "losses to") && LOSS_IDIOM_RE.test(lead)) return false;
  return !(words === "lost to" && PASSIVE_LOST_RE.test(lead));
}

/**
 * Every team mention of a (sanitised, case-preserved) text in the shared-name reading, in text
 * order: the teams, the cue word that names one as the other side of a game or a play, "<team>
 * matchup", and the games a cue word between two teams names.
 */
export function sharedMentions(text: string): readonly SharedMention[] {
  type Base = Pick<SharedMention, "team" | "start" | "end" | "form">;
  const raw: (NameForm & { readonly start: number; readonly end: number })[] = [];
  for (const m of text.matchAll(NAME_RE)) {
    const f = NAME_FORMS.get((m[1] ?? "").replace(/\s+/gu, " "));
    if (f !== undefined) raw.push({ ...f, start: m.index, end: m.index + m[0].length });
  }
  const bases: Base[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === undefined) continue;
    const b = raw[i + 1];
    // a team's full name ("Minnesota Vikings", "Los Angeles Rams") is one mention
    if (
      a.home &&
      b !== undefined &&
      !b.home &&
      b.team !== null &&
      a.teams.includes(b.team) &&
      /^\s+$/u.test(text.slice(a.end, b.start))
    ) {
      bases.push({ team: b.team, start: a.start, end: b.end, form: b.caps ? "caps" : "name" });
      i++;
      continue;
    }
    if (a.team !== null)
      bases.push({ team: a.team, start: a.start, end: a.end, form: a.caps ? "caps" : "name" });
  }
  // an abbreviation inside a team's name is no mention (bases are in text order, never overlapping;
  // one pass over both, so the work stays linear in an item's teams and abbreviations)
  const abbreviations: RegExpExecArray[] = [];
  let j = 0;
  for (const m of text.matchAll(ABBREVIATION_RE)) {
    const s = m.index;
    const e = s + m[0].length;
    while (j < bases.length && (bases[j]?.end ?? 0) <= s) j++;
    const b = bases[j];
    if (b === undefined || !(s < b.end && b.start < e)) abbreviations.push(m);
  }
  const accepted = new Set<number>();
  for (const m of abbreviations) {
    const s = m.index;
    const e = s + m[0].length;
    const tag =
      TAG_BEFORE_RE.test(text.slice(Math.max(0, s - 24), s)) &&
      TAG_AFTER_RE.test(text.slice(e, e + 24));
    if (tag || cueBefore(text, s) !== null) accepted.add(s);
  }
  // a game's first side ("MIN vs. CLE"): right before a game's gap and the next team already read
  // (a team farther on never pairs: the gap would hold the nearer one, which no game word is)
  const starts = [...bases.map((x) => x.start), ...accepted].sort((x, y) => x - y);
  const first: number[] = [];
  let k = 0;
  for (const m of abbreviations) {
    const e = m.index + m[0].length;
    if (accepted.has(m.index)) continue;
    while (k < starts.length && (starts[k] ?? 0) <= e) k++;
    const next = starts[k];
    if (next !== undefined && PAIR_GAP_RE.test(text.slice(e, next))) first.push(m.index);
  }
  for (const s of first) accepted.add(s);
  for (const m of abbreviations) {
    const team = TEAM_ABBREVIATIONS[m[0]];
    if (accepted.has(m.index) && team !== undefined)
      bases.push({ team, start: m.index, end: m.index + m[0].length, form: "abbreviation" });
  }
  bases.sort((x, y) => x.start - y.start);
  const out: SharedMention[] = [];
  for (const b of bases) {
    const c = cueBefore(text, b.start);
    const cue = c !== null && cueHolds(text, c, b.end) ? c : null;
    const weak = cue === null && WEAK_AFTER_RE.test(text.slice(b.end, b.end + 16));
    const prev = out[out.length - 1];
    const game =
      prev !== undefined && prev.team !== b.team && PAIR_GAP_RE.test(text.slice(prev.end, b.start));
    if (prev !== undefined && game)
      out[out.length - 1] = { ...prev, pair: { team: b.team, start: b.start } };
    out.push({
      ...b,
      cue: cue === null ? null : { kind: cue.kind, words: cue.words, start: cue.start },
      weak,
      pair: prev !== undefined && game ? { team: prev.team, start: prev.start } : null,
    });
  }
  return out;
}

/** Role nouns a writer puts between a team and a player's name, beside the position words. */
// prettier-ignore
export const LABEL_ROLE_NOUNS: readonly string[] = Object.freeze([
  "superstar", "playmaker", "pass-catcher", "pass catcher", "mvp", "captain",
]);
/**
 * Plural labels: before one name, or before a list of names ("Vikings WRs Jordan Addison and
 * Justin Jefferson", `sharedListTeams`), whose every name the team is attached to.
 */
// prettier-ignore
export const LABEL_PLURALS: readonly string[] = Object.freeze([
  "qbs", "rbs", "wrs", "tes", "lbs", "olbs", "ilbs", "cbs", "dbs", "des", "dts", "dls",
  "quarterbacks", "running backs", "receivers", "wide receivers", "wideouts", "tight ends",
  "linebackers", "cornerbacks", "corners", "safeties", "defensive ends", "defensive tackles",
  "defensive backs", "defensive linemen", "pass rushers", "edge rushers", "kickers", "punters",
  "stars", "starters", "rookies", "veterans", "backups", "teammates", "playmakers",
  "pass-catchers", "captains",
]);
/**
 * Label words that read as verbs right before a name ("Vikings top Browns", "a hit by the Vikings
 * injured Justin Jefferson"): read there only after a possessive ("the Vikings' top receiver"), and
 * "injured" before another label word ("Vikings injured WR Justin Jefferson"); in a tag always.
 */
export const VERB_LIKE_LABELS: readonly string[] = Object.freeze(["lead", "top", "injured"]);
/**
 * The words of a label between a team and the player it is attached to (any case): role words,
 * positions, modifiers, an age ("24-year-old") and a rank ("No. 1").
 */
const LABEL_WORDS = [
  ...ATTACH_WORDS,
  ...Object.keys(POSITION_WORDS),
  ...POSITION_MODIFIERS,
  ...LABEL_ROLE_NOUNS,
  ...LABEL_PLURALS,
];
const LABEL_EXTRA = "\\d{1,2}-year-old|No\\.?\\s*\\d{1,2}";
const CORE_ALT = `(?:${alternation(LABEL_WORDS.filter((w) => !VERB_LIKE_LABELS.includes(w)))}|${LABEL_EXTRA})`;
const ROLE_ALT = `(?:${CORE_ALT}|injured(?=\\s+${CORE_ALT}(?![\\p{L}\\p{N}])))`;
const TAG_ROLE_ALT = `(?:${alternation(LABEL_WORDS)}|${LABEL_EXTRA})`;
const SEPARATOR = "(?:\\s*[-–,/]\\s*|\\s+)";
/**
 * Between a team and a name after it: a possessive and then any label words, or label words
 * without one (a verb-like one only as VERB_LIKE_LABELS says).
 */
const BEFORE_NAME_RE = new RegExp(
  `^(?:['’ʼ]s?(?:\\s+${TAG_ROLE_ALT}(?![\\p{L}\\p{N}]))*|(?:\\s+${ROLE_ALT}(?![\\p{L}\\p{N}]))*)\\s+$`,
  "iu",
);
/** Between a name and a team after it: "of" ("Justin Jefferson of the Vikings"). */
const OF_GAP_RE = /^\s+of\s+(?:the\s+)?$/iu;
/** Between a team and the first name of a list: a possessive, label words, a plural label. */
const BEFORE_LIST_RE = new RegExp(
  `^(?:['’ʼ]s?)?(?:\\s+${TAG_ROLE_ALT}(?![\\p{L}\\p{N}]))*\\s+(?:${alternation(LABEL_PLURALS)})(?![\\p{L}\\p{N}])\\s+$`,
  "iu",
);
/** Between a name and a team after it in a tag: "," or "(", an article, label words. */
const TAG_GAP_RE = new RegExp(
  `^\\s*([(,])\\s*(?:(?:the|a|an)\\s+)?(?:${TAG_ROLE_ALT}(?![\\p{L}\\p{N}])${SEPARATOR})*$`,
  "iu",
);
/** After the team of a tag: a possessive, label words, then the tag's end. */
const TAG_REST_RE = new RegExp(
  `^(?:['’ʼ]s?)?((?:${SEPARATOR}${TAG_ROLE_ALT}(?![\\p{L}\\p{N}]))*)\\s*([:;|)]|[-–—](?=\\s|$)|$|,)`,
  "iu",
);
/** How far from a name an attached team may sit (the gaps above are short; bounded work). */
const ATTACH_WINDOW = 64;

/**
 * The teams written next to the name at [start, end) in the shared-name reading — its own team as
 * the writer labels him: "<team>['s] [label words] <name>" ("Minnesota Vikings star Justin
 * Jefferson", "Rams edge rusher Byron Young", "Vikings' No. 1 receiver Justin Jefferson"), "<name>
 * of [the] <team>" ("Justin Jefferson of the Vikings"), or a tag after it: "<name>, [label words,]
 * <team>" closing its clause ("Justin Jefferson, WR, Minnesota:", "Justin Jefferson, CLE:"), an
 * appositive holding a label word ("Justin Jefferson, the Vikings' star receiver, is"), or "<name>
 * (<team> [label words])" in either order ("(Browns LB)", "(CLE - LB)", "(WR, Vikings)").
 * `mentions` are `sharedMentions`' (minus any read as part of a name).
 */
export function sharedAttachedTeams(
  text: string,
  mentions: readonly Pick<SharedMention, "team" | "start" | "end">[],
  start: number,
  end: number,
): ReadonlySet<NflTeam> {
  const out = new Set<NflTeam>();
  for (const m of mentions) {
    if (m.end <= start) {
      if (start - m.end <= ATTACH_WINDOW && BEFORE_NAME_RE.test(text.slice(m.end, start)))
        out.add(m.team);
    } else if (m.start >= end && m.start - end <= ATTACH_WINDOW) {
      if (OF_GAP_RE.test(text.slice(end, m.start))) {
        out.add(m.team);
        continue;
      }
      const gap = TAG_GAP_RE.exec(text.slice(end, m.start));
      const rest = TAG_REST_RE.exec(text.slice(m.end, m.end + ATTACH_WINDOW));
      if (gap === null || rest === null) continue;
      const open = gap[1];
      const close = rest[2] ?? "";
      const labelled =
        /\p{L}/u.test(gap[0].replace(/^\s*[(,]\s*(?:(?:the|a|an)\s+)?/iu, "")) ||
        /\p{L}/u.test(rest[1] ?? "");
      if (open === "(" ? close === ")" : close !== ")" && (close !== "," || labelled))
        out.add(m.team);
    }
  }
  return out;
}

/**
 * The teams a plural label attaches to the list of names whose first name starts at `start`
 * ("Vikings WRs Jordan Addison and Justin Jefferson": the Vikings, for every name of the list; the
 * matcher finds the list — names joined by "," and "and" only).
 */
export function sharedListTeams(
  text: string,
  mentions: readonly Pick<SharedMention, "team" | "start" | "end">[],
  start: number,
): ReadonlySet<NflTeam> {
  const out = new Set<NflTeam>();
  for (const m of mentions)
    if (
      m.end <= start &&
      start - m.end <= ATTACH_WINDOW &&
      BEFORE_LIST_RE.test(text.slice(m.end, start))
    )
      out.add(m.team);
  return out;
}

/**
 * The reserve lists a team places a player on or takes him off (any case): "Placed on IR by
 * Vikings", "Activated off injured reserve by Vikings", "Vikings place Justin Jefferson on IR".
 */
// prettier-ignore
export const RESERVE_LISTS: readonly string[] = Object.freeze([
  "IR", "injured reserve", "reserve/injured", "reserve/PUP", "reserve/NFI", "reserve/suspended",
  "PUP", "PUP list", "NFI", "NFI list", "non-football injury list",
  "physically unable to perform list", "exempt list", "commissioner's exempt list",
  "practice squad injured list", "waivers",
]);
/**
 * The roster moves of a player's own team, beyond teams.ts' (which a unique name keeps): a team
 * reinstates him ("Vikings reinstate Justin Jefferson"), places him on a reserve list ("Vikings place
 * Justin Jefferson on injured reserve": the list after the name), or his clause says he was
 * activated, reinstated or placed on a list by it ("Justin Jefferson: Activated by Vikings",
 * "…: Activated off IR by Vikings", "…: Placed on IR by Vikings", "…: Reinstated by Vikings").
 */
export const SHARED_TEAM_MOVE_WORDS: readonly string[] = Object.freeze([
  "reinstate",
  "reinstates",
  "reinstated",
]);
export const PLACE_WORDS: readonly string[] = Object.freeze([
  "place",
  "places",
  "placed",
  "put",
  "puts",
]);
export const SHARED_PLAYER_MOVE_WORDS: readonly string[] = Object.freeze([
  "activated",
  "reinstated",
]);
const ATTACH_ALT = alternation(ATTACH_WORDS);
const LIST_ALT = `(?:the\\s+)?(?:${alternation(RESERVE_LISTS)})(?![\\p{L}\\p{N}])`;
const SHARED_TEAM_MOVES_RE = new RegExp(
  `^\\s+(?:${alternation(SHARED_TEAM_MOVE_WORDS)})(?:\\s+(?:${ATTACH_ALT}))*\\s+$`,
  "iu",
);
const PLACE_RE = new RegExp(
  `^\\s+(?:${alternation(PLACE_WORDS)})(?:\\s+(?:${ATTACH_ALT}))*\\s+$`,
  "iu",
);
const PLACE_TAIL_RE = new RegExp(`^\\s+on\\s+${LIST_ALT}`, "iu");
const SHARED_PLAYER_MOVE_RE = new RegExp(
  `^\\s*[:,]?\\s*(?:(?:is|was|has\\s+been|gets|got)\\s+)?(?:(?:${alternation(SHARED_PLAYER_MOVE_WORDS)})(?:\\s+(?:off|from)\\s+${LIST_ALT})?|placed\\s+on\\s+${LIST_ALT})\\s+by\\s+(?:the\\s+)?$`,
  "iu",
);

/** What follows a team a player's clause says he moved to: a roster's name, then a clause end. */
const MOVE_TAIL_RE =
  /^(?:['’ʼ]s?)?(?:\s+(?:practice\s+squad|active\s+roster|53-man\s+roster|roster|taxi\s+squad))?(?:\s*(?:[.,;:!?|()—–]|$)|\s+(?:on|as|after|before|from|in|off|to|through|with|and|following|via|ahead|this|last|sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?![\p{L}\p{N}]))/iu;

/**
 * The teams a roster move ties to the name at [start, end) in the shared-name reading: a team that
 * signs, waives, claims, promotes, activates or reinstates him ("Bengals sign CB Lamar Jackson"),
 * or places him on a reserve list; or one his own clause says he signs with, is waived, activated,
 * reinstated or placed on a list by, or lands on — the move ending its clause there ("…: Signs with
 * Bengals", "…: Activated off IR by Vikings", "…: Lands on Bengals practice squad"), never a workout
 * or a mention ("Joins Ravens for workout", "Lands on Vikings' radar"). Never a trade (teams.ts
 * PLAYER_MOVE_RE).
 */
export function sharedMovedTeams(
  text: string,
  mentions: readonly Pick<SharedMention, "team" | "start" | "end">[],
  start: number,
  end: number,
): ReadonlySet<NflTeam> {
  const out = new Set<NflTeam>();
  for (const m of mentions) {
    if (m.end <= start) {
      if (start - m.end > ATTACH_WINDOW) continue;
      const gap = text.slice(m.end, start);
      if (
        TEAM_MOVES_RE.test(gap) ||
        SHARED_TEAM_MOVES_RE.test(gap) ||
        (PLACE_RE.test(gap) && PLACE_TAIL_RE.test(text.slice(end, end + ATTACH_WINDOW)))
      )
        out.add(m.team);
    } else if (m.start >= end && m.start - end <= ATTACH_WINDOW) {
      const gap = text.slice(end, m.start);
      if (
        (PLAYER_MOVE_RE.test(gap) || SHARED_PLAYER_MOVE_RE.test(gap)) &&
        MOVE_TAIL_RE.test(text.slice(m.end, m.end + ATTACH_WINDOW))
      )
        out.add(m.team);
    }
  }
  return out;
}
