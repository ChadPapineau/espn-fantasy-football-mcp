// positions.ts — the position words of a news item, for the player matcher's shared-name evidence
// (ruling R8-3 clause 4, changelog §R8: "a position word or abbreviation written next to the name,
// or describing the subject, is evidence like an attached team. It comes from ESPN's position_id
// joined into the matcher's universe and rules out every holder of another position"; plan 07 D6;
// plan 02 §6.4 — rules over a closed, tested vocabulary, never a model).
//
// ESPN position ids (ds_players `position_id`; research 03 §B.2; src/domain/league/slots.ts
// POSITION_NAMES): 1 QB, 2 RB, 3 WR, 4 TE, 5 K, 7 P, 9 DT, 10 DE, 11 LB, 12 CB, 13 S. A writer's word
// and ESPN's label part where a role is shared — an edge rusher is ESPN's DE or LB, a 3-4 end its DT
// or DE, a nickel back its CB or S, and a pass rusher may be any of the front (ESPN lists the
// interior rusher Chris Jones as a DT) — so each word stands for every id a player it describes may
// carry (POSITION_WORDS), and ruling out takes only ids no reading of the word allows. Abbreviations
// count only as written in capitals ("LB", "S", never "lb" or "s"); words in any case.
// Offensive-line words name a position no universe player holds (ESPN's index lists none): they
// rule every holder out.
//
// Where a position word is read, and what it can do (the matcher, match.ts, decides with it):
//   next to the name — the writer's own label for the player, read at every mention of him (his
//     full name, or his surname standing alone in an item that names him in full): right before it,
//     whitespace only between ("LB Justin Jefferson", "Browns linebacker Justin Jefferson",
//     "Free-agent corner Lamar Jackson"); right after it, before the clause ends ("Justin Jefferson
//     LB: Records sack"); a closing appositive ("Justin Jefferson, LB, Cleveland:", "Jefferson, a
//     second-year linebacker, will miss", "Lamar Jackson, the Ravens' newest cornerback,"); a tag in
//     parentheses ("(Browns LB)", "(CLE - LB)", "(WR, Vikings)"); and the clause a headline's topic
//     colon opens right after the name ("Lamar Jackson injury update: Ravens QB dealing with …").
//     This is evidence like an attached team: it rules out every holder of another position and is
//     the holder's own evidence (`positionPhrasesNextTo`);
//   describing someone — a sentence that opens "The [<modifier>…] [<team>['s]] [<modifier>…]
//     <position>" and goes on in lower case, or a clause that opens so after any other colon
//     (`describingPhrases`). Such a sentence may describe the subject ("| The linebacker did not
//     practice Wednesday.") or the player he faced ("| The cornerback jumped the route.", "| The
//     receiver was carted off."), and no rule short of parsing tells them apart (R7-4's precedent),
//     so it is never the evidence that picks a holder: the matcher reads it only to keep a pick it
//     contradicts from being made, and to support a holder the other evidence left. A sentence whose
//     position is plainly someone else's is no evidence at all: a "him" within three words of the
//     position, or a "he" right after it ("The linebacker covering him", "The quarterback he
//     sacked": the subject is the "him", so the position is another player's — binding, not verb
//     parsing). A position word that only modifies a noun ("Cornerback injuries leave …",
//     "Linebacker coverage") describes no one, nor do the words that are also common nouns there
//     ("safety concerns", "the edge goes to", "the kicker:", "turned the corner");
//   anywhere — `positionWordSpans`: every position word an item writes, the matcher's test of
//     R8-3 clause 6 (an item naming a position for its subject is no residual).
// Several position words joined by "/" are one player's ("LB/DE"): any of their ids.
import type { NflTeam } from "../../config/schema.js";
import { TEAM_ABBREVIATIONS, TEAM_HOMES, TEAM_NICKNAMES } from "./teams.js";

const QB = [1];
const RB = [2];
const WR = [3];
const TE = [4];
const K = [5];
const P = [7];
/** Defensive line: ESPN lists an interior end as DT or DE. */
const DL = [9, 10];
/** Edge and linebacker: ESPN lists a 3-4 outside linebacker as LB or DE. */
const EDGE = [10, 11];
/** A pass rusher: an edge or an interior lineman (ESPN's DT, DE or LB). */
const RUSHER = [9, 10, 11];
/** Defensive backs: ESPN lists a nickel or hybrid back as CB or S. */
const DB = [12, 13];
/** Any defender. */
const DEFENSE = [9, 10, 11, 12, 13];
/** The offensive line: no universe player (ESPN's index lists none). */
const OL: number[] = [];

/** Abbreviations: counted only as written in capitals. */
// prettier-ignore
const ABBREVIATIONS: Readonly<Record<string, readonly number[]>> = {
  QB, QB1: QB, QB2: QB,
  RB, RB1: RB, RB2: RB, RB3: RB, HB: RB, FB: RB,
  WR, WR1: WR, WR2: WR, WR3: WR,
  TE, TE1: TE, TE2: TE,
  K, PK: K, P,
  DT: DL, DE: DL, DL, NT: DL,
  OLB: EDGE, LB: EDGE, ILB: EDGE, MLB: EDGE,
  CB: DB, S: DB, FS: DB, SS: DB, DB,
  OL, OT: OL, OG: OL,
};

/** Words, in any case (spaces stand for any whitespace; "edge" and "EDGE" alike). */
// prettier-ignore
const WORDS: Readonly<Record<string, readonly number[]>> = {
  quarterback: QB, "signal-caller": QB, "signal caller": QB,
  "running back": RB, halfback: RB, tailback: RB, fullback: RB,
  "wide receiver": WR, receiver: WR, wideout: WR, "slot receiver": WR,
  "tight end": TE,
  kicker: K, placekicker: K, "place kicker": K, punter: P,
  "defensive tackle": DL, "nose tackle": DL, "defensive end": DL, "defensive lineman": DL,
  "interior lineman": DL,
  edge: EDGE, "edge rusher": EDGE, "outside linebacker": EDGE,
  linebacker: EDGE, "inside linebacker": EDGE, "middle linebacker": EDGE,
  "pass rusher": RUSHER, "pass-rusher": RUSHER,
  cornerback: DB, corner: DB, nickelback: DB, "nickel back": DB, safety: DB, "free safety": DB,
  "strong safety": DB, "defensive back": DB,
  defender: DEFENSE, "defensive player": DEFENSE,
  "offensive lineman": OL, "offensive tackle": OL, "offensive guard": OL, "left tackle": OL,
  "right tackle": OL, "left guard": OL, "right guard": OL,
};

/**
 * The closed position vocabulary (R8-3 clause 4): each written form and the ESPN position ids a
 * player it describes may carry. Keys are lower case; an abbreviation counts only in capitals.
 */
export const POSITION_WORDS: Readonly<Record<string, readonly number[]>> = Object.freeze(
  Object.fromEntries([
    ...Object.entries(ABBREVIATIONS).map(([k, v]): [string, readonly number[]] => [
      k.toLowerCase(),
      Object.freeze([...v]),
    ]),
    ...Object.entries(WORDS).map(([k, v]): [string, readonly number[]] => [
      k,
      Object.freeze([...v]),
    ]),
  ]),
);

/** The ESPN position ids some position word names; any other id is unknown to this evidence. */
export const KNOWN_POSITION_IDS: ReadonlySet<number> = new Set(
  Object.values(POSITION_WORDS).flat(),
);

const ABBREVIATION_KEYS: ReadonlySet<string> = new Set(
  Object.keys(ABBREVIATIONS).map((k) => k.toLowerCase()),
);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alt = (words: readonly string[]): string =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.split(" ").map(escape).join("\\s+"))
    .join("|");
const POSITION_ALT = alt(Object.keys(POSITION_WORDS));
/** One position, or several joined by "/". */
const POSITION_LIST = `(?:${POSITION_ALT})(?:\\s*\\/\\s*(?:${POSITION_ALT}))*`;
/** A word boundary that a hyphen, an apostrophe or a period also closes ("non-QB" is no QB). */
const OPEN = "(?<![\\p{L}\\p{N}'’ʼ.-])";
const CLOSE = "(?![\\p{L}\\p{N}'’ʼ-])";

/**
 * Modifiers that may stand around a team (or after an article) before the position: closed — and an
 * age ("24-year-old"), RotoWire's commonest form.
 */
// prettier-ignore
export const POSITION_MODIFIERS: readonly string[] = Object.freeze([
  "star", "rookie", "veteran", "backup", "starting", "reserve", "former", "free-agent",
  "free agent", "undrafted", "young", "standout", "All-Pro", "Pro Bowl", "top", "new", "newest",
  "longtime", "talented", "versatile", "reigning", "injured", "promising", "primary", "lead",
  "first-year", "second-year", "third-year", "fourth-year", "fifth-year", "sixth-year",
  "seventh-year", "eighth-year", "ninth-year", "tenth-year", "two-time", "three-time",
  "four-time", "five-time", "six-time",
]);
const MODIFIER_ALT = `(?:${alt(POSITION_MODIFIERS)}|\\d{1,2}-year-old)`;
/** A team as a writer names it in a label: its nickname or home as written, or its abbreviation. */
const TEAM_ENTRIES: readonly (readonly [string, NflTeam])[] = [
  ...Object.entries(TEAM_NICKNAMES),
  ...Object.entries(TEAM_HOMES),
  ...Object.entries(TEAM_ABBREVIATIONS),
];
const TEAM_LOOKUP: ReadonlyMap<string, NflTeam> = new Map(
  TEAM_ENTRIES.map(([k, t]): [string, NflTeam] => [k.replace(/\s+/gu, " "), t]),
);
const TEAM_ALT = alt(TEAM_ENTRIES.map(([k]) => k));

/** The position phrase right before a name: whitespace only between them. */
const BEFORE_NAME_RE = new RegExp(`${OPEN}(${POSITION_LIST})\\s+$`, "iu");
/** The position right after a name, before its clause ends ("Justin Jefferson LB: Records sack"). */
const AFTER_NAME_RE = new RegExp(
  `^\\s+(${POSITION_LIST})${CLOSE}(?=\\s*(?:[:;,|)]|[-–—](?=\\s|$)|$))`,
  "iu",
);
/** The team slot of a label (case-sensitive, as teams.ts reads teams), a possessive allowed. */
const TEAM_SLOT_RE = new RegExp(`(${TEAM_ALT})(?![\\p{L}\\p{N}])(?:['’ʼ]s?)?\\s+`, "uy");
/** An article, then modifiers (any case). */
const ARTICLE_RE = /(?:a|an|the)\s+/iuy;
const MODIFIERS_RE = new RegExp(`(?:${MODIFIER_ALT}\\s+)*`, "iuy");
/** The position phrase at a point (any case; abbreviations checked after). */
const POSITION_AT_RE = new RegExp(`(${POSITION_LIST})${CLOSE}`, "iuy");
/** What closes an appositive: a comma, a colon, a semicolon, a bar, a parenthesis, a dash, the end. */
const APPOSITIVE_END_RE = /\s*(?:[,:;|)]|[-–—](?=\s|$)|$)/uy;
/** One item of a tag in parentheses: a team, a position or a modifier. */
const TAG_ITEM_RE = new RegExp(
  `(?:(${TEAM_ALT})(?![\\p{L}\\p{N}])(?:['’ʼ]s?)?|(${POSITION_LIST})${CLOSE}|${MODIFIER_ALT}(?![\\p{L}\\p{N}]))`,
  "iuy",
);
/** Between two items of a tag: a separator or a space. */
const TAG_SEPARATOR_RE = /(?:\s*[-–,/]\s*|\s+)/uy;
/** After a describing phrase: its sentence goes on in lower case, or a comma follows. */
const DESCRIBING_GOES_ON_RE = /(?:\s+\p{Ll}|\s*,)/uy;
/**
 * Where a describing phrase opens: "The " at the start of the text or after a sentence's end or a
 * bar; or right after a colon, "The " optional.
 */
const DESCRIBING_OPEN_RE = /(?<=^|[.!?|;]\s+)The\s+|:\s+(?:The\s+)?/gu;
/** Position words that are also common nouns where a describing phrase opens: never one there. */
export const NOT_DESCRIBING: ReadonlySet<string> = new Set(["safety", "edge", "kicker", "corner"]);
/**
 * The nouns a position word may modify instead of naming a player ("Cornerback injuries leave the
 * Bengals thin", "Linebacker coverage", "the receiver room"): closed; after one of them the phrase
 * describes no one.
 */
// prettier-ignore
export const POSITION_COMPOUND_HEADS: readonly string[] = Object.freeze([
  "injury", "injuries", "coverage", "depth", "corps", "room", "group", "groups", "unit", "units",
  "play", "position", "positions", "spot", "spots", "battle", "battles", "competition",
  "rotation", "rotations", "duties", "coach", "coaches", "market", "class", "classes",
  "prospect", "prospects", "ranking", "rankings", "stats", "matchup", "matchups", "help",
  "need", "needs", "upgrade", "upgrades", "situation", "carousel", "controversy", "chart",
  "charts", "pool", "pools", "trade", "trades", "options", "landscape",
]);
const COMPOUND_HEAD_RE = new RegExp(
  `\\s+(?:${alt(POSITION_COMPOUND_HEADS)})(?![\\p{L}\\p{N}])`,
  "iuy",
);
/**
 * A pronoun that makes a describing phrase another player's: "him" within three words of the
 * position, inside its clause ("The linebacker covering him", "The quarterback found him twice"),
 * or "he" right after it ("The quarterback he sacked", "The receiver that he covered").
 */
const OTHER_PLAYER_RE =
  /(?:(?:\s+[\p{L}\p{N}'’ʼ-]+){0,3}\s+him(?![\p{L}\p{N}])|\s+(?:(?:that|who|whom)\s+)?he(?![\p{L}\p{N}]))/iuy;
/**
 * The topic words a headline may write between a name and its colon, the clause after which is
 * about him ("Lamar Jackson injury update: Ravens QB dealing with ankle sprain"): closed.
 */
// prettier-ignore
export const HEADLINE_TOPICS: readonly string[] = Object.freeze([
  "injury update", "injury news", "injury status", "injury report", "update", "status",
  "status update", "outlook", "news", "latest", "health update", "contract update",
  "practice update", "practice report",
]);
const TOPIC_COLON_RE = new RegExp(`\\s+(?:${alt(HEADLINE_TOPICS)})\\s*:\\s+(?:The\\s+)?`, "iuy");
/** How far from a name a position word may sit (bounded work). */
const WINDOW = 64;

/** The ids of a matched position phrase, or null when an abbreviation is not written in capitals. */
function idsOf(written: string): ReadonlySet<number> | null {
  const out = new Set<number>();
  for (const part of written.split("/")) {
    const raw = part.trim();
    const key = raw.toLowerCase().replace(/\s+/gu, " ");
    const ids = POSITION_WORDS[key];
    if (ids === undefined) return null;
    if (ABBREVIATION_KEYS.has(key) && raw !== raw.toUpperCase()) return null;
    for (const id of ids) out.add(id);
  }
  return out;
}

/** The team a label's team words name (an abbreviation only in capitals), or null. */
function teamOf(words: string): NflTeam | null {
  const key = words.replace(/\s+/gu, " ");
  const team = TEAM_LOOKUP.get(key);
  if (team === undefined) return null;
  return key in TEAM_ABBREVIATIONS && key !== key.toUpperCase() ? null : team;
}

/** Runs a sticky regex at `at`; the match, or null. */
function sticky(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/** Runs a sticky regex at `at`; the end of its match, or -1. */
function stickyEnd(re: RegExp, text: string, at: number): number {
  const m = sticky(re, text, at);
  return m === null ? -1 : at + m[0].length;
}

/** One position phrase: its ids, where its position words are, and the team its label names. */
export interface PositionPhrase {
  readonly ids: ReadonlySet<number>;
  /** Offsets of the position words (not the label's team or modifiers): [start, end). */
  readonly start: number;
  readonly end: number;
  /** The team the same label names ("The Browns linebacker" → CLE), or null. */
  readonly team: NflTeam | null;
}

/**
 * The position phrase at `at` — an optional article, modifiers, an optional team (a possessive
 * allowed), modifiers, then the position — or null. Offsets are the text's.
 */
function positionAt(
  text: string,
  at: number,
  article: boolean,
): (PositionPhrase & { readonly written: string }) | null {
  let i = at;
  if (article) {
    const a = stickyEnd(ARTICLE_RE, text, i);
    if (a >= 0) i = a;
  }
  // the team first ("The New England linebacker": "New" is no modifier there), else modifiers and
  // then the team ("The former Ravens cornerback"); modifiers may follow it ("the Vikings' top")
  let team = teamSlotAt(text, i);
  if (team === null) {
    const m1 = stickyEnd(MODIFIERS_RE, text, i);
    if (m1 >= 0) i = m1;
    team = teamSlotAt(text, i);
  }
  if (team !== null) {
    i = team.end;
    const m2 = stickyEnd(MODIFIERS_RE, text, i);
    if (m2 >= 0) i = m2;
  }
  const p = sticky(POSITION_AT_RE, text, i);
  if (p === null) return null;
  const written = p[1] ?? "";
  const ids = idsOf(written);
  return ids === null
    ? null
    : { ids, start: i, end: i + written.length, team: team?.team ?? null, written };
}

/** The team slot of a label at `at` (its team and where the slot ends), or null. */
function teamSlotAt(
  text: string,
  at: number,
): { readonly team: NflTeam; readonly end: number } | null {
  const t = sticky(TEAM_SLOT_RE, text, at);
  if (t === null) return null;
  const team = teamOf(t[1] ?? "");
  return team === null ? null : { team, end: at + t[0].length };
}

/** The position items of a tag in parentheses opening at `at` ("(Browns LB)", "(CLE - LB)"). */
function tagPositions(text: string, at: number): PositionPhrase[] | null {
  const out: PositionPhrase[] = [];
  let i = at;
  for (let n = 0; n < 6; n++) {
    const item = sticky(TAG_ITEM_RE, text, i);
    if (item === null || item[0].length === 0) return null;
    const position = item[2];
    if (position !== undefined) {
      const ids = idsOf(position);
      if (ids === null) return null;
      out.push({ ids, start: i, end: i + position.length, team: null });
    } else if (item[1] !== undefined && teamOf(item[1]) === null) return null;
    i += item[0].length;
    if (/^\s*\)/u.test(text.slice(i, i + 8))) return out;
    const sep = stickyEnd(TAG_SEPARATOR_RE, text, i);
    if (sep < 0) return null;
    i = sep;
  }
  return null;
}

/**
 * The position phrases written next to the name at [start, end) of the (sanitised) text — right
 * before it, right after it before its clause ends, as a closing appositive, in a tag in
 * parentheses, or as the clause a headline's topic colon opens right after it — in text order;
 * empty when none is written.
 */
export function positionPhrasesNextTo(
  text: string,
  start: number,
  end: number,
): readonly PositionPhrase[] {
  const out: PositionPhrase[] = [];
  const from = Math.max(0, start - WINDOW);
  const before = BEFORE_NAME_RE.exec(text.slice(from, start));
  const b = before === null ? null : idsOf(before[1] ?? "");
  if (before !== null && b !== null) {
    const s = from + before.index;
    out.push({ ids: b, start: s, end: s + (before[1] ?? "").length, team: null });
  }
  const tail = text.slice(end, end + WINDOW);
  const right = AFTER_NAME_RE.exec(tail);
  const r = right === null ? null : idsOf(right[1] ?? "");
  if (right !== null && r !== null) {
    const s = end + right[0].length - (right[1] ?? "").length;
    out.push({ ids: r, start: s, end: s + (right[1] ?? "").length, team: null });
  }
  const comma = /^\s*,\s*/u.exec(tail);
  if (comma !== null) {
    const p = positionAt(text, end + comma[0].length, true);
    if (p !== null && stickyEnd(APPOSITIVE_END_RE, text, p.end) >= 0) out.push(p);
  }
  const paren = /^\s*\(\s*/u.exec(tail);
  if (paren !== null) out.push(...(tagPositions(text, end + paren[0].length) ?? []));
  const topic = stickyEnd(TOPIC_COLON_RE, text, end);
  if (topic >= 0) {
    const p = describingAt(text, topic);
    if (p !== null && !p.other) out.push(p);
  }
  return out;
}

/**
 * The ESPN position ids of the position words written next to the name at [start, end): one set
 * per phrase (`positionPhrasesNextTo`); empty when none is written.
 */
export function positionsNextTo(
  text: string,
  start: number,
  end: number,
): readonly ReadonlySet<number>[] {
  return positionPhrasesNextTo(text, start, end).map((p) => p.ids);
}

/** A sentence-opening phrase that describes someone by his position ("The Browns linebacker"). */
export interface DescribingPhrase extends PositionPhrase {
  /** Where the phrase opens ("The", or the colon's clause). */
  readonly at: number;
  /** Where its sentence ends (`sentenceBounds`). */
  readonly sentenceEnd: number;
  /** Whether a pronoun makes it plainly another player's ("The linebacker covering him"). */
  readonly other: boolean;
}

/** The describing phrase whose position phrase opens at `at`, or null (no sentence fields yet). */
function describingAt(
  text: string,
  at: number,
): (PositionPhrase & { readonly other: boolean }) | null {
  const p = positionAt(text, at, false);
  if (p === null || NOT_DESCRIBING.has(p.written.toLowerCase().replace(/\s+/gu, " "))) return null;
  if (stickyEnd(COMPOUND_HEAD_RE, text, p.end) >= 0) return null;
  if (stickyEnd(DESCRIBING_GOES_ON_RE, text, p.end) < 0) return null;
  const clause = /^[^,.;:!?|()]*/u.exec(text.slice(p.end, p.end + WINDOW))?.[0] ?? "";
  const other = sticky(OTHER_PLAYER_RE, clause, 0) !== null;
  return { ids: p.ids, start: p.start, end: p.end, team: p.team, other };
}

/**
 * The describing phrases of a (sanitised) text, in text order: a sentence that opens "The
 * [<modifier>…] [<team>['s]] [<modifier>…] <position>" (or a clause after a colon that opens so,
 * "The" optional) and goes on in lower case (or after a comma). Who each one describes is the
 * matcher's to decide; `other` marks the ones a pronoun gives to another player.
 */
export function describingPhrases(text: string): readonly DescribingPhrase[] {
  const out: DescribingPhrase[] = [];
  const bounds = sentenceBounds(text);
  for (const m of text.matchAll(DESCRIBING_OPEN_RE)) {
    const p = describingAt(text, m.index + m[0].length);
    if (p === null) continue;
    out.push({ ...p, at: m.index, sentenceEnd: sentenceOf(bounds, p.end, text.length)[1] });
  }
  return out;
}

/**
 * A position word anywhere, its plural and its possessive too ("Linebackers coach Jim Leonhard
 * said …", "The linebacker's knee gave out"): a group of the subject's position, or his.
 */
const POSITION_WORD_RE = new RegExp(
  `${OPEN}(${POSITION_LIST})(?:e?s)?(?:(?=['’ʼ]s?(?![\\p{L}\\p{N}]))|${CLOSE})`,
  "giu",
);

/**
 * Every position word the text writes, a plural or a possessive one included (abbreviations in
 * capitals; the words NOT_DESCRIBING names as common nouns are left out): R8-3 clause 6's test of
 * an item that names a position.
 */
export function positionWordSpans(text: string): readonly PositionPhrase[] {
  const out: PositionPhrase[] = [];
  for (const m of text.matchAll(POSITION_WORD_RE)) {
    const written = m[1] ?? "";
    if (NOT_DESCRIBING.has(written.toLowerCase().replace(/\s+/gu, " "))) continue;
    const ids = idsOf(written);
    if (ids !== null) out.push({ ids, start: m.index, end: m.index + written.length, team: null });
  }
  return out;
}

/** Words a period follows without ending a sentence ("vs.", "Jr.", "St. Brown", "No. 1"). */
// prettier-ignore
const NO_BREAK_BEFORE_DOT: ReadonlySet<string> = new Set([
  "vs", "jr", "sr", "st", "no", "nos", "mr", "mrs", "ms", "dr", "gen", "lt", "sgt", "ft", "mt",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "approx",
  "est", "inc", "co",
]);

/**
 * The offsets of a text's sentence breaks, in order: every "|" and ";", a "!" or "?" before a space
 * or the end, and a "." before a space or the end unless it closes an initial or an abbreviation
 * ("C.J. Stroud", "vs. Browns", "Amon-Ra St. Brown").
 */
export function sentenceBounds(text: string): readonly number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/[|;]|[!?](?=\s|$)|\.(?=\s|$)/gu)) {
    if (m[0] === ".") {
      const word = /([\p{L}]+)$/u.exec(text.slice(Math.max(0, m.index - 12), m.index))?.[1] ?? "";
      if (word.length === 1 || NO_BREAK_BEFORE_DOT.has(word.toLowerCase())) continue;
    }
    out.push(m.index);
  }
  return out;
}

/** The sentence holding offset `at`: [start, end) between the breaks around it. */
export function sentenceOf(
  bounds: readonly number[],
  at: number,
  length: number,
): readonly [number, number] {
  let start = 0;
  let end = length;
  for (const b of bounds) {
    if (b < at) start = b + 1;
    else {
      end = b;
      break;
    }
  }
  return [start, end];
}
