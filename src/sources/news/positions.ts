// positions.ts — the position words of a news item, for the player matcher's shared-name evidence
// (ruling R8-3 clause 4, changelog §R8: "a position word or abbreviation written next to the name,
// or describing the subject, is evidence like an attached team. It comes from ESPN's position_id
// joined into the matcher's universe and rules out every holder of another position"; plan 07 D6;
// plan 02 §6.4 — rules over a closed, tested vocabulary, never a model).
//
// ESPN position ids (ds_players `position_id`; research 03 §B.2; src/domain/league/slots.ts
// POSITION_NAMES): 1 QB, 2 RB, 3 WR, 4 TE, 5 K, 7 P, 9 DT, 10 DE, 11 LB, 12 CB, 13 S. A writer's word
// and ESPN's label part where a role is shared — an edge rusher is ESPN's DE or LB, a 3-4 end its DT
// or DE, a nickel back its CB or S — so each word stands for every id a player it describes may carry
// (POSITION_WORDS), and ruling out takes only ids no reading of the word allows. Abbreviations count
// only as written in capitals ("LB", "S", never "lb" or "s"); words in any case. Offensive-line words
// name a position no universe player holds (ESPN's index lists none): they rule every holder out.
//
// Where a position word is read (nowhere else — a word elsewhere may be anyone's: "sacks the
// Vikings' QB", "beat the cornerback"):
//   next to the name — right before it, whitespace only between ("LB Justin Jefferson", "Browns
//     linebacker Justin Jefferson", "Free-agent cornerback Lamar Jackson"); after it as an appositive
//     that closes ("Justin Jefferson, LB, Cleveland:", "Lamar Jackson, a free-agent cornerback,",
//     "Sam Twin, Dolphins S:"); or in parentheses ("Justin Jefferson (Browns LB)");
//   describing the subject — a sentence that opens "The [<team>['s]] [<modifier>…] <position>", or a
//     headline clause that opens so after a colon, "The" optional, and goes on in lower case ("| The
//     Browns linebacker led the team.", "The defender has started every game.", "Lamar Jackson
//     injury update: Ravens QB dealing with ankle sprain"). Whose it is, is the matcher's to decide
//     (match.ts: the subject, when he is the last person named before it and its sentence names no
//     one after it). Words that are also common nouns there ("safety concerns", "the edge goes to",
//     "the kicker:") describe no one.
// Several position words joined by "/" are one player's ("LB/DE"): any of their ids.
import { TEAM_NICKNAMES, TEAM_HOMES } from "./teams.js";

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
  edge: EDGE, "edge rusher": EDGE, "pass rusher": EDGE, "outside linebacker": EDGE,
  linebacker: EDGE, "inside linebacker": EDGE, "middle linebacker": EDGE,
  cornerback: DB, nickelback: DB, "nickel back": DB, safety: DB, "free safety": DB,
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
const POSITION_ALT = Object.keys(POSITION_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.split(" ").map(escape).join("\\s+"))
  .join("|");
/** One position, or several joined by "/". */
const POSITION_LIST = `(?:${POSITION_ALT})(?:\\s*\\/\\s*(?:${POSITION_ALT}))*`;
/** A word boundary that a hyphen, an apostrophe or a period also closes ("non-QB" is no QB). */
const OPEN = "(?<![\\p{L}\\p{N}'’ʼ.-])";
const CLOSE = "(?![\\p{L}\\p{N}'’ʼ-])";

/** Modifiers that may stand between a team (or an article) and the position: closed. */
// prettier-ignore
const MODIFIERS: readonly string[] = [
  "star", "rookie", "veteran", "backup", "starting", "reserve", "former", "free-agent",
  "free agent", "undrafted", "young", "standout",
  "second-year", "third-year", "fourth-year", "fifth-year", "sixth-year", "seventh-year",
  "eighth-year", "ninth-year", "tenth-year",
];
const MODIFIER_ALT = [...MODIFIERS]
  .sort((a, b) => b.length - a.length)
  .map((w) => w.split(" ").map(escape).join("\\s+"))
  .join("|");
/** A team as the team matcher reads it (capitalised, case-sensitive) — kept apart from the rest. */
const TEAM_ALT = [...Object.keys(TEAM_NICKNAMES), ...Object.keys(TEAM_HOMES)]
  .sort((a, b) => b.length - a.length)
  .map(escape)
  .join("|");

/** The position phrase right before a name: whitespace only between them. */
const BEFORE_NAME_RE = new RegExp(`${OPEN}(${POSITION_LIST})\\s+$`, "iu");
/** The team slot of an appositive or a parenthesis (case-sensitive, as teams.ts reads teams). */
const TEAM_SLOT_RE = new RegExp(`(?:${TEAM_ALT})(?:['’ʼ]s?)?\\s+`, "uy");
/** An article, then modifiers (any case). */
const ARTICLE_RE = /(?:a|an|the)\s+/iuy;
const MODIFIERS_RE = new RegExp(`(?:(?:${MODIFIER_ALT})\\s+)*`, "iuy");
/** The position phrase at a point (any case; abbreviations checked after). */
const POSITION_AT_RE = new RegExp(`(${POSITION_LIST})${CLOSE}`, "iuy");
/** What closes an appositive: a comma, a colon, a semicolon, a bar, a parenthesis, a dash, the end. */
const APPOSITIVE_END_RE = /\s*(?:[,:;|)]|[-–—](?=\s|$)|$)/uy;
/** What closes a parenthesis: ")" or a comma inside it ("(LB, Browns)"). */
const PAREN_END_RE = /\s*[),]/uy;
/** After a describing phrase: its sentence goes on in lower case, or a comma follows. */
const DESCRIBING_GOES_ON_RE = /(?:\s+\p{Ll}|\s*,)/uy;
/**
 * Where a describing phrase opens: "The " at the start of the text or after a sentence's end or a
 * bar; or right after a colon, "The " optional (a headline's clause about the name before it).
 */
const DESCRIBING_OPEN_RE = /(?<=^|[.!?|;]\s+)The\s+|:\s+(?:The\s+)?/gu;
/** Position words that are also common nouns where a describing phrase opens: never one there. */
export const NOT_DESCRIBING: ReadonlySet<string> = new Set(["safety", "edge", "kicker"]);
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

/** Runs a sticky regex at `at`; the end of its match, or -1. */
function stickyEnd(re: RegExp, text: string, at: number): number {
  re.lastIndex = at;
  const m = re.exec(text);
  return m === null ? -1 : at + m[0].length;
}

/** The position phrase at `at` (after an optional team and modifiers), as written, or null. */
function positionAt(
  text: string,
  at: number,
  article: boolean,
): { readonly ids: ReadonlySet<number>; readonly end: number; readonly written: string } | null {
  let i = at;
  if (article) {
    const a = stickyEnd(ARTICLE_RE, text, i);
    if (a >= 0) i = a;
  }
  const t = stickyEnd(TEAM_SLOT_RE, text, i);
  if (t >= 0) i = t;
  const m = stickyEnd(MODIFIERS_RE, text, i);
  if (m >= 0) i = m;
  POSITION_AT_RE.lastIndex = i;
  const p = POSITION_AT_RE.exec(text);
  if (p === null) return null;
  const written = p[1] ?? "";
  const ids = idsOf(written);
  return ids === null ? null : { ids, end: i + p[0].length, written };
}

/**
 * The ESPN position ids of the position words written next to the name at [start, end) of the
 * (sanitised) text — right before it, as a closing appositive after it, or in parentheses after it —
 * one set per phrase; empty when none is written.
 */
export function positionsNextTo(
  text: string,
  start: number,
  end: number,
): readonly ReadonlySet<number>[] {
  const out: ReadonlySet<number>[] = [];
  const before = BEFORE_NAME_RE.exec(text.slice(Math.max(0, start - WINDOW), start));
  const b = before === null ? null : idsOf(before[1] ?? "");
  if (b !== null) out.push(b);
  const tail = text.slice(end, end + WINDOW);
  const comma = /^\s*,\s*/u.exec(tail);
  if (comma !== null) {
    const p = positionAt(tail, comma[0].length, true);
    if (p !== null && stickyEnd(APPOSITIVE_END_RE, tail, p.end) >= 0) out.push(p.ids);
  }
  const paren = /^\s*\(\s*/u.exec(tail);
  if (paren !== null) {
    const p = positionAt(tail, paren[0].length, false);
    if (p !== null && stickyEnd(PAREN_END_RE, tail, p.end) >= 0) out.push(p.ids);
  }
  return out;
}

/** A sentence-opening phrase that describes someone by his position ("The Browns linebacker"). */
export interface DescribingPhrase {
  /** Offsets of the phrase ("The" to the position word's end): [start, end). */
  readonly start: number;
  readonly end: number;
  /** Where its sentence ends (the next ".", "!", "?", "|" or ";", or the text's end). */
  readonly sentenceEnd: number;
  readonly ids: ReadonlySet<number>;
}

/**
 * The describing phrases of a (sanitised) text, in text order: a sentence that opens "The
 * [<team>['s]] [<modifier>…] <position>" (or a clause after a colon that opens so, "The" optional)
 * and goes on in lower case (or after a comma). Who each one describes is the matcher's to decide.
 */
export function describingPhrases(text: string): readonly DescribingPhrase[] {
  const out: DescribingPhrase[] = [];
  for (const m of text.matchAll(DESCRIBING_OPEN_RE)) {
    const p = positionAt(text, m.index + m[0].length, false);
    if (p === null || NOT_DESCRIBING.has(p.written.toLowerCase())) continue;
    if (stickyEnd(DESCRIBING_GOES_ON_RE, text, p.end) < 0) continue;
    const stop = /[.!?|;]/u.exec(text.slice(p.end));
    out.push({
      start: m.index,
      end: p.end,
      sentenceEnd: stop === null ? text.length : p.end + stop.index,
      ids: p.ids,
    });
  }
  return out;
}
