// cues.ts — the shared-name reading of a news item's teams and cue words, for the player matcher
// (ruling R8-3, changelog §R8: clause 2, "a team named loosely … is never evidence FOR a holder. It
// can only rule a holder out"; clause 3, "a team named as the other side of a game or a play is the
// opponent … as a closed, tested list"; plan 07 D6; plan 02 §6.4 — rules over closed lists, never a
// model). match.ts tells the holders of a shared name apart with it; a name only one universe player
// holds keeps teams.ts' reading, exactly as before R8-3.
//
// The teams (`sharedMentions`): each nickname and home as written, and in capitals ("VIKINGS", an
// all-caps headline), and the short names feeds write (teams.ts TEAM_SHORT_NAMES: "the Vikes"). A team's full name is one mention ("the Minnesota Vikings", "the Los Angeles
// Rams"): a cue is read before its first word, and its home is no second, loose mention. An
// abbreviation (teams.ts TEAM_ABBREVIATIONS, in capitals) is a team only where a context makes it
// one: right after a cue word ("vs. MIN", "@ MIN", "Sacks MIN QB"), in a tag ("Justin Jefferson,
// CLE:", "(PHI)", "(CLE - LB)"), or on a game's first side ("MIN vs. CLE").
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
//   PASSIVE_PLAY_CUES the same, done to him, before "by" ("Sacked five times by Steelers");
//   GAME_CUES         between two teams only: every word above, and "host", "visit", "face" ("Vikings
//                     host Browns" names a game the subject plays in, never his side: `pair`);
//   "<team> matchup"  after a team: his own team's game as often as his opponent's (`weak`).
// A cue holds only where the words after the team read as the game or the play (closed lists, no
// verb parsing, R7-4's precedent): after a play word, the team's player or unit (PLAY_OBJECTS: "QB",
// "pass", "secondary" …), a possessive allowed; otherwise also punctuation, a number, the end, or a
// word of CUE_CONTINUATIONS ("in", "on", "for", "twice", the days …). It does not hold where the
// team's own thing follows: a possessive after a result word ("beats the Browns' sack record"), a
// possessive with no player or unit after the others ("shreds the Browns' linebacker depth"), a
// hyphen ("Facing Browns-imposed suspension"), any other word ("Beats Browns teammate", "Facing
// Eagles discipline"); nor in the idioms that use a result word for a team's loss of its own player:
// "for" after a result ("lost to the Browns for the season"), a passive "lost to" ("is lost to the
// Chiefs"), a copula's "loss to" ("is a big loss to the Eagles"), the draft ("fell to the Browns in
// the fifth round"). Words outside the lists are no cue either way. Whose game or play a cue names —
// the person the sentence is written about — is match.ts's to decide.
import type { NflTeam } from "../../config/schema.js";
import { POSITION_MODIFIERS, POSITION_WORDS } from "./positions.js";
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
/** Play wording done to the subject, before "by" ("Sacked five times by Steelers"). */
// prettier-ignore
export const PASSIVE_PLAY_CUES: readonly string[] = Object.freeze([
  "sacked", "intercepted", "picked off", "tackled", "brought down", "stripped", "pressured",
  "beaten", "beat", "defeated", "upset", "routed", "edged", "blanked", "shut out",
]);
/**
 * Game wording BETWEEN two teams: every cue above, and the words that name a game only when a team
 * stands on each side ("Vikings host Browns", "the Ravens visit the Bengals", "the Vikings face the
 * Browns"). After a single team they name no opponent ("visits Bears" may be a workout).
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
]);
/** A team's player or unit a play is made on (lower case; any case written). */
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
const ARTICLE = "(?:(?:the|a|an)\\s+)?";
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
      `(?<![\\p{L}\\p{N}])(${alternation(PASSIVE_PLAY_CUES)})(?:\\s+(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+times|\\s+(?:twice|once|again|repeatedly))?\\s+by\\s+${ARTICLE}$`,
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
const OBJECT_RE = new RegExp(
  `^\\s+(?:${alternation(PLAY_OBJECTS)})(?![\\p{L}\\p{N}])(?!\\s+office)`,
  "iu",
);
const NAME_AFTER_RE = /^\s+\p{Lu}/u;
const CONTINUES_RE = new RegExp(
  `^(?:\\s*$|\\s*[^\\p{L}\\p{N}\\s'’ʼ-]|\\s+[-–—](?=\\s|$)|\\s+\\d|\\s+(?:${alternation(CUE_CONTINUATIONS)})(?![\\p{L}\\p{N}]))`,
  "iu",
);
const FOR_RE = /^\s+for(?![\p{L}\p{N}])/iu;
/** The draft, later in a result's clause ("fell to the Browns in the fifth round"). */
const DRAFT_RE =
  /(?<![\p{L}\p{N}])(?:round|draft|pick|overall|selection|No\.?\s*\d+)(?![\p{L}\p{N}])/iu;
/**
 * A copula or an appositive before "loss to" ("is a big loss to the Eagles", "…, a big loss to the
 * Browns": the team's loss of a player). A score keeps it a game ("…, a 24-20 loss to the Browns").
 */
const COPULA_LOSS_RE =
  /(?:(?<![\p{L}\p{N}])(?:is|was|are|were|be|been|being|remains|represents|['’]s)\s+(?:(?:a|an|another|the)\s+)?|[,—–]\s*(?:a|an|another)\s+)(?:[\p{Ll}-]+\s+){0,3}$/u;
/** A passive or a participle before "lost to" ("is lost to the Chiefs", "…, lost to the Browns"). */
const PASSIVE_LOST_RE =
  /(?:(?<![\p{L}\p{N}])(?:is|was|are|were|be|been|being|['’]s)\s+(?:\p{Ll}+\s+)?|,\s*)$/u;
/** A dispute before "against" ("grievance against the Browns"): the team is his own side's. */
const DISPUTE_RE =
  /(?<![\p{L}\p{N}])(?:grievance|grievances|lawsuit|lawsuits|suit|complaint|complaints|appeal|claim|claims|case|charge|charges|ruling|decision|fine|discipline|action|motion|protest|arbitration|hearing|testimony)\s+$/iu;
/** "for" and a number after a play's team ("Torches Browns for 150 yards"). */
const FOR_NUMBER_RE = /^\s+for\s+\d/iu;
const WEAK_AFTER_RE = /^\s+matchups?(?![\p{L}\p{N}])/iu;
/** Between the two teams of a game: a possessive, a score, a game word, the cue, an article. */
const PAIR_GAP_RE = new RegExp(
  `^(?:['’ʼ]s?)?(?:\\s+\\d{1,2}-\\d{1,2})?(?:\\s+(?:game|matchup|contest|meeting|clash|showdown|tilt))?(?:\\s+(?:${alternation(GAME_CUES.filter((w) => w !== "@"))})\\s+|\\s*@\\s*)${ARTICLE}$`,
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
  const lead = text.slice(Math.max(0, cue.start - 48), cue.start);
  if (cue.kind === "against" && DISPUTE_RE.test(lead)) return false;
  const possessive = POSSESSIVE_RE.exec(after);
  if (possessive !== null) {
    if (cue.kind === "result") return false;
    const rest = after.slice(possessive[0].length);
    return OBJECT_RE.test(rest) || NAME_AFTER_RE.test(rest);
  }
  if (cue.objectOnly) return OBJECT_RE.test(after) || FOR_NUMBER_RE.test(after);
  if (!OBJECT_RE.test(after) && !CONTINUES_RE.test(after)) return false;
  if (cue.kind !== "result") return true;
  if (FOR_RE.test(after)) return false;
  const clause = /^[^.;|!?]*/u.exec(text.slice(end, end + 160))?.[0] ?? "";
  if (DRAFT_RE.test(clause)) return false;
  const words = cue.words.replace(/\s+/gu, " ");
  if ((words === "loss to" || words === "losses to") && COPULA_LOSS_RE.test(lead)) return false;
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
  const free = (s: number, e: number): boolean => !bases.some((x) => s < x.end && x.start < e);
  const abbreviations = [...text.matchAll(ABBREVIATION_RE)].filter((m) =>
    free(m.index, m.index + m[0].length),
  );
  const accepted = new Set<number>();
  for (const m of abbreviations) {
    const s = m.index;
    const e = s + m[0].length;
    const tag =
      TAG_BEFORE_RE.test(text.slice(Math.max(0, s - 24), s)) &&
      TAG_AFTER_RE.test(text.slice(e, e + 24));
    if (tag || cueBefore(text, s) !== null) accepted.add(s);
  }
  // a game's first side ("MIN vs. CLE"): right before a game's gap and a team already read
  const starts = (): number[] => [...bases.map((x) => x.start), ...accepted];
  for (const m of abbreviations) {
    const e = m.index + m[0].length;
    if (accepted.has(m.index)) continue;
    if (starts().some((s) => s > e && PAIR_GAP_RE.test(text.slice(e, s)))) accepted.add(m.index);
  }
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

/**
 * The words of a label between a team and the player it is attached to (any case): role words,
 * positions and modifiers — before a name not "lead" or "top", which read there as verbs ("Vikings
 * top Browns"), but in a tag after it ("the Vikings' top receiver") too.
 */
const LABEL_WORDS = [...ATTACH_WORDS, ...Object.keys(POSITION_WORDS), ...POSITION_MODIFIERS];
const ROLE_ALT = `(?:${alternation(LABEL_WORDS.filter((w) => w !== "lead" && w !== "top"))}|\\d{1,2}-year-old)`;
const TAG_ROLE_ALT = `(?:${alternation(LABEL_WORDS)}|\\d{1,2}-year-old)`;
const SEPARATOR = "(?:\\s*[-–,/]\\s*|\\s+)";
/** Between a team and a name after it: a possessive, then label words only. */
const BEFORE_NAME_RE = new RegExp(`^(?:['’ʼ]s?)?(?:\\s+${ROLE_ALT}(?![\\p{L}\\p{N}]))*\\s+$`, "iu");
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
 * Jefferson", "Rams edge rusher Byron Young"), or a tag after it: "<name>, [label words,] <team>"
 * closing its clause ("Justin Jefferson, WR, Minnesota:", "Justin Jefferson, CLE:"), an appositive
 * holding a label word ("Justin Jefferson, the Vikings' star receiver, is"), or "<name> (<team>
 * [label words])" in either order ("(Browns LB)", "(CLE - LB)", "(WR, Vikings)"). `mentions` are
 * `sharedMentions`' (minus any read as part of a name).
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

/** What follows a team a player's clause says he moved to: a roster's name, then a clause end. */
const MOVE_TAIL_RE =
  /^(?:['’ʼ]s?)?(?:\s+(?:practice\s+squad|active\s+roster|53-man\s+roster|roster|taxi\s+squad))?(?:\s*(?:[.,;:!?|()—–]|$)|\s+(?:on|as|after|before|from|in|off|to|through|with|and|following|via|ahead|this|last|sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?![\p{L}\p{N}]))/iu;

/**
 * The teams a roster move ties to the name at [start, end) in the shared-name reading: a team that
 * signs, waives, claims or promotes him ("Bengals sign CB Lamar Jackson"), or one his own clause says
 * he signs with, is waived by or lands on — the move ending its clause there ("…: Signs with
 * Bengals", "…: Lands on Bengals practice squad"), never a workout or a mention ("Joins Ravens for
 * workout", "Lands on Vikings' radar"). Never a trade (teams.ts PLAYER_MOVE_RE).
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
      if (start - m.end <= ATTACH_WINDOW && TEAM_MOVES_RE.test(text.slice(m.end, start)))
        out.add(m.team);
    } else if (m.start >= end && m.start - end <= ATTACH_WINDOW) {
      if (
        PLAYER_MOVE_RE.test(text.slice(end, m.start)) &&
        MOVE_TAIL_RE.test(text.slice(m.end, m.end + ATTACH_WINDOW))
      )
        out.add(m.team);
    }
  }
  return out;
}
