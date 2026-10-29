// positions.ts — the position forms of a news item, for the player matcher's shared-name reading
// (ruling R8-6, changelog §R8: (a) a position "directly before" a shared name, "in parentheses
// directly after it" or "in the headline's name tag before the colon" labels him, and "a label must
// fit exactly one holder (… position from ESPN position_id)"; (b) the scan finds a position in every
// written form; ruling R8-7 bounds both: (1) the forms are "every ESPN position, its standard
// abbreviations and the alignment words ("weakside", "strongside", "Mike", "Will", "Sam"), each
// written glued, hyphenated or with a space, singular or plural", and (3) "any form the scan reads as
// a team or a position is a label form"; plan 07 D6; plan 02 §6.4 — closed, tested lists, never a
// model). This file is the vocabulary; labels.ts reads it (where a form stands, and in which case an
// abbreviation counts: R8-7 (2)) over the item's folded text, its apostrophes and dashes already "'"
// and "-".
//
// ESPN position ids (ds_players `position_id`; research 03 §B.2; src/domain/league/slots.ts
// POSITION_NAMES): 1 QB, 2 RB, 3 WR, 4 TE, 5 K, 7 P, 9 DT, 10 DE, 11 LB, 12 CB, 13 S, and the
// positions of its team units, 14 HC (the head coach), 15 TQB (the team quarterback) and 16 D/ST (the
// team defense), which no universe player holds: the scan finds their forms ("every ESPN position",
// R8-7 (1); ruling R8-8 (1)), and as a label they fit no one, like an offensive-line form. ESPN's
// own position, abbreviated or spelled out, fits only its own id ("DT" and "defensive tackle" fit an
// ESPN DT, never an ESPN DE): a label that fits a holder of another ESPN position would pick a wrong
// holder (fail closed). A writer's form that is no ESPN position stands for every id a player it describes
// may carry, wide rather than narrow: the defensive line (DL, "lineman", "tackle") ESPN's DT or DE, an
// edge rusher, an outside linebacker or a Will or Sam its DE or LB (ESPN lists the Rams' 3-4 outside
// linebacker Byron Young as a DE), a pass rusher or an alignment word any of the front, a nickel or
// defensive back its CB or S, a returner a back, a receiver or a defensive back, a slot receiver or
// corner, a role played at any position (an athlete, special teams) every id. A subtype always held at
// one ESPN position fits only it (NT a DT, ILB, MLB and the Mike an LB, FS and SS an S, RCB a CB).
// Offensive-line forms and the long snapper name a position no universe player holds (ESPN's index
// lists none): as a label they fit no one, and they rule out every holder of a known position.
//
// The closed lists, each held entry by entry by the tests:
//   POSITION_ABBREVIATIONS — every abbreviation (ESPN's, writers', depth charts'); a depth chart's
//     rank (1–99) may follow any of them ("LB1", "WR10"), and a plural ("QBs", "LBS");
//   POSITION_WORDS — every word form, one word or several, a compound written with a space between its
//     parts ("half back", "line backer", "d line"): each is read glued, hyphenated or with a space
//     ("halfback", "half-back", "half back"), singular or plural, in any case;
//   AMBIGUOUS_LABEL_WORDS — the label words that are also ordinary words ("safety", "corner",
//     "tackle", "slot"): right after a preposition, an article or a game or move word they label no
//     one ("After safety Lamar Jackson leads …"; labels.ts); so is every abbreviation of labels.ts'
//     ORDINARY_WORD_ABBREVIATIONS.
// By rule, not by list: each word's plural ("linebackers", "safeties", "linemen", "QBs", "LBS"); a
// form's spellings; a rank after an abbreviation ("CB2"); a technique ("1-tech", "5-technique", "4i",
// "three-technique": the defensive line).

const QB = [1];
const RB = [2];
const WR = [3];
const TE = [4];
const K = [5];
const P = [7];
/** ESPN's own defensive positions: each fits only itself. */
const DT = [9];
const DE = [10];
const LB = [11];
const CB = [12];
const S = [13];
/** The defensive line: ESPN lists an interior end as DT or DE. */
const DL = [9, 10];
/** Edge and outside linebacker: ESPN lists a 3-4 outside linebacker as LB or DE. */
const EDGE = [10, 11];
/** A pass rusher, the front, an alignment: an edge or an interior lineman (ESPN's DT, DE or LB). */
const FRONT = [9, 10, 11];
/** Defensive backs: ESPN lists a nickel or hybrid back as CB or S. */
const DB = [12, 13];
/** A rover: a linebacker or a defensive back. */
const ROVER = [11, 12, 13];
/** Any defender. */
const DEFENSE = [9, 10, 11, 12, 13];
/** A returner: a back, a receiver or a defensive back. */
const RETURNER = [2, 3, 12, 13];
/** A gunner: a receiver or a defensive back. */
const GUNNER = [3, 12, 13];
/** A pass catcher: a back, a receiver or a tight end. */
const CATCHER = [2, 3, 4];
/** A wingback, slotback or scatback: a back or a receiver. */
const BACK = [2, 3];
/** An H-back: a back or a tight end. */
const H_BACK = [2, 4];
/** The slot: a receiver or a corner. */
const SLOT = [3, 12];
/** The receiving corps: receivers and tight ends. */
const CORPS = [3, 4];
/** The backfield: a quarterback or a back, or a defensive back. */
const BACKFIELD = [1, 2, 12, 13];
/** A holder: a punter or a quarterback. */
const HOLDER = [1, 7];
/** A specialist: a kicker or a punter (a long snapper is no universe player). */
const SPECIALIST = [5, 7];
/** A role any player may fill: an athlete, special teams. */
const ANY = [1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13];
/** The offensive line and the long snapper: no universe player (ESPN's index lists none). */
const OL: number[] = [];
/**
 * ESPN's fantasy positions of its team units (14 HC, 15 TQB, 16 D/ST): no universe player holds one
 * (ESPN's players index lists team units under negative ids, which the universe skips).
 */
const TEAM_UNIT: number[] = [];

const freeze = (
  entries: Readonly<Record<string, readonly number[]>>,
): Readonly<Record<string, readonly number[]>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(entries).map(([k, v]): [string, readonly number[]] => [
        k,
        Object.freeze([...v]),
      ]),
    ),
  );

/** Abbreviations (labels and the scan): ESPN's own, then writers' and depth charts'. */
// prettier-ignore
export const POSITION_ABBREVIATIONS: Readonly<Record<string, readonly number[]>> = freeze({
  QB, RB, HB: RB, FB: RB, WR, SE: WR, TE, K, PK: K, P,
  DT, NT: DT, NG: DT, LDT: DT, RDT: DT, DE, LDE: DE, RDE: DE, DL, IDL: DL, DI: DL,
  EDGE, ED: EDGE, OLB: EDGE, LOLB: EDGE, ROLB: EDGE, WILL: EDGE, SAM: EDGE,
  LB, ILB: LB, MLB: LB, WLB: LB, SLB: LB, LILB: LB, RILB: LB, MIKE: LB,
  CB, RCB: CB, LCB: CB, NCB: CB, S, FS: S, SS: S, SAF: S, NB: DB, DB,
  KR: RETURNER, PR: RETURNER, ST: ANY, ATH: ANY,
  OL, OT: OL, OG: OL, G: OL, C: OL, LT: OL, RT: OL, LG: OL, RG: OL, IOL: OL, LS: OL,
  HC: TEAM_UNIT, TQB: TEAM_UNIT,
});

/**
 * Words (labels and the scan), in any case. A compound is listed with a space between its parts and
 * read glued, hyphenated or spaced; a space stands for any whitespace, "-" for a dash.
 */
// prettier-ignore
export const POSITION_WORDS: Readonly<Record<string, readonly number[]>> = freeze({
  "quarter back": QB, "signal caller": QB,
  "running back": RB, "half back": RB, "tail back": RB, "full back": RB,
  receiver: WR, "wide out": WR, "wide receiver": WR, "slot receiver": WR, flanker: WR,
  "split end": WR,
  "tight end": TE,
  kicker: K, "place kicker": K, punter: P,
  "defensive tackle": DT, "nose tackle": DT, "nose guard": DT, "d tackle": DT, nose: DT,
  "defensive end": DE, "d end": DE,
  "line man": DL, "d line man": DL, "defensive line man": DL, tackle: DL,
  "d line": DL, "defensive line": DL, "defensive interior": DL,
  "edge rusher": EDGE, "outside line backer": EDGE, backer: EDGE, "line backing": EDGE,
  "line backer": LB, "inside line backer": LB, "middle line backer": LB, "off ball": LB,
  "pass rusher": FRONT, rusher: FRONT, "pass rush": FRONT, "defensive front": FRONT,
  "front seven": FRONT, "weak side": FRONT, "strong side": FRONT,
  "corner back": CB, corner: CB, "slot corner": CB,
  safety: S, "free safety": S, "strong safety": S,
  "nickel back": DB, "defensive back": DB, nickel: DB, dime: DB, "dime back": DB, secondary: DB,
  rover: ROVER,
  defender: DEFENSE, "defensive player": DEFENSE, tackler: DEFENSE,
  returner: RETURNER, "return man": RETURNER, gunner: GUNNER,
  "pass catcher": CATCHER, "wing back": BACK, "slot back": BACK, "scat back": BACK,
  "h back": H_BACK, slot: SLOT, "receiving corps": CORPS, "back field": BACKFIELD,
  holder: HOLDER, specialist: SPECIALIST, "special teams": ANY, "special teamer": ANY,
  "offensive line man": OL, "offensive line": OL, "o line": OL, guard: OL, center: OL,
  centre: OL, snapper: OL, "long snapper": OL,
  "head coach": TEAM_UNIT, "d st": TEAM_UNIT,
});

/**
 * The label words that are also ordinary words: right after a preposition, an article or a game or
 * move word (labels.ts LABEL_BLOCKERS, GAME_MOVE_WORDS) they are the ordinary word and label no name
 * ("After safety Lamar Jackson leads …", "in the slot Justin Jefferson …"); "Veteran safety …" and
 * "Eagles safety …" label him.
 */
// prettier-ignore
export const AMBIGUOUS_LABEL_WORDS: readonly string[] = Object.freeze([
  "back field", "corner", "dime", "gunner", "holder", "nickel", "nose", "rover", "safety",
  "secondary", "slot", "specialist", "tackle",
]);

/** The ESPN position ids some position form names; any other id is unknown to this reading. */
export const KNOWN_POSITION_IDS: ReadonlySet<number> = new Set([
  ...Object.values(POSITION_ABBREVIATIONS).flat(),
  ...Object.values(POSITION_WORDS).flat(),
]);

/** A word as the lists key it: lower case, apostrophes dropped, one space between words. */
export function positionKey(written: string): string {
  return written.toLowerCase().replaceAll("'", "").replace(/\s+/gu, " ").trim();
}

/**
 * A word's plural as the scan reads it ("linebackers", "safeties", "linemen", "running backs", "head
 * coaches").
 */
export function pluralOf(word: string): string {
  if (word.endsWith("man")) return `${word.slice(0, -3)}men`;
  if (/[^aeiou]y$/u.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:ch|sh)$/u.test(word)) return `${word}es`;
  return `${word}s`;
}

/** The most parts whose joins a spelling chooses apart (a listed form has three at most). */
const MAX_SPELLING_PARTS = 4;

/**
 * A listed form's spellings: its parts (split at a space or a hyphen) joined by a space, a hyphen or
 * nothing, each join chosen apart ("d line man" is also "d-lineman", "d lineman" and "dlineman"). A
 * longer string (never a listed form) is joined one way throughout, so the work stays linear in it
 * (ruling R8-8 (1): 3^(n-1) spellings exhausted the heap at 17 words).
 */
export function spellingsOf(form: string): string[] {
  const parts = positionKey(form).split(/[\s-]+/u);
  if (parts.length > MAX_SPELLING_PARTS)
    return [...new Set([" ", "-", ""].map((j) => parts.join(j)))];
  let out = [parts[0] ?? ""];
  for (const p of parts.slice(1)) out = out.flatMap((s) => [`${s} ${p}`, `${s}-${p}`, `${s}${p}`]);
  return [...new Set(out)];
}

/** A rank written after an abbreviation: a depth chart's 1–99. */
const RANK_RE = /^(\p{L}+)([1-9][0-9]?)$/u;
/**
 * A technique, keyed by `positionKey`: an alignment number (a digit or its word, an "i" allowed),
 * then "tech" or "technique" ("5-tech", "9 technique", "three-technique"); or a shade alone ("4i").
 */
const TECHNIQUE_RE =
  /^(?:(?:[0-9]i?|zero|one|two|three|four|five|six|seven|eight|nine)[- ]?tech(?:nique)?s?|[0-9]i)$/u;

const ABBREVIATION_IDS: ReadonlyMap<string, readonly number[]> = new Map(
  Object.entries(POSITION_ABBREVIATIONS),
);
/** Each word form's spellings and plurals ("edge rusher", "edge-rusher", "edgerushers") and its ids. */
const WORD_IDS: ReadonlyMap<string, readonly number[]> = new Map(
  Object.entries(POSITION_WORDS).flatMap(([k, v]) =>
    spellingsOf(k).flatMap((s) => [[s, v] as const, [pluralOf(s), v] as const]),
  ),
);
/** The multi-word keys' word counts (a reader tries forms of up to this many words). */
export const MAX_POSITION_WORDS: number = Math.max(
  ...[...WORD_IDS.keys()].map((k) => k.split(" ").length),
);
/**
 * The first words of every position form of several words, a technique's numbers among them ("nine
 * technique"): a run of words opening with any other word is no position form.
 */
export const POSITION_PHRASE_HEADS: ReadonlySet<string> = new Set([
  ...[...WORD_IDS.keys()].filter((k) => k.includes(" ")).map((k) => k.split(" ")[0] ?? ""),
  ..."0123456789".split("").flatMap((d) => [d, `${d}i`]),
  ...["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
]);

/**
 * The first two words of every position form of several words, keyed as `positionKey` keys them
 * ("running back", "d line" of "d line man").
 */
const POSITION_PHRASE_PAIRS: ReadonlySet<string> = new Set(
  [...WORD_IDS.keys()]
    .filter((k) => k.includes(" "))
    .map((k) => k.split(" ").slice(0, 2).join(" ")),
);
/**
 * Whether two words, keyed as `positionKey` keys them (one space between), may open a position form of
 * several words: the first two words of one, or a technique of two words ("nine technique", "5 tech";
 * a technique has two at most). Where they do not, no position form of several words opens with them.
 */
export const opensPositionPhrase = (pair: string): boolean =>
  POSITION_PHRASE_PAIRS.has(pair) || TECHNIQUE_RE.test(pair);

/**
 * The ESPN ids a written WORD form names — one word or several, any case, any spelling, its plural, or
 * a technique ("edge-rusher", "line backers", "1-tech") — or null.
 */
export function positionWordIds(written: string): readonly number[] | null {
  const key = positionKey(written);
  const ids = WORD_IDS.get(key);
  if (ids !== undefined) return ids;
  return TECHNIQUE_RE.test(key) ? DL : null;
}

/** An abbreviation as written, read: its ids and the stem written (without its plural or rank). */
export interface AbbreviationRead {
  readonly ids: readonly number[];
  /** The abbreviation as written, its plural "s" and its rank cut ("Wills" → "Will", "CB2" → "CB"). */
  readonly stem: string;
}

/**
 * The ESPN ids a written word names as a position ABBREVIATION, in any case: the abbreviation, its
 * plural ("QBs", "LBS", "cbs"), its rank ("CB2", "WR10"), a plural rank ("WR1s"); null when none.
 * Which case counts is labels.ts' (R8-7 (2)).
 */
export function positionAbbreviation(written: string): AbbreviationRead | null {
  if (written.includes(" ") || written.length === 0) return null;
  const direct = ABBREVIATION_IDS.get(written.toUpperCase());
  if (direct !== undefined) return { ids: direct, stem: written };
  const last = written.at(-1);
  const plural = last === "s" || last === "S";
  const stem = plural ? written.slice(0, -1) : written;
  if (plural && stem.length > 0) {
    const ids = ABBREVIATION_IDS.get(stem.toUpperCase());
    if (ids !== undefined) return { ids, stem };
  }
  const ranked = RANK_RE.exec(stem);
  const base = ranked?.[1] ?? "";
  const ids = ranked === null ? undefined : ABBREVIATION_IDS.get(base.toUpperCase());
  return ids === undefined ? null : { ids, stem: base };
}

/**
 * Every spelling of every AMBIGUOUS_LABEL_WORDS word, keyed once (the label reader asks for each label
 * word it reads; ruling R8-8 (1): recomputing them on every call cost a crafted item 20 times a benign
 * one).
 */
const AMBIGUOUS_SPELLINGS: ReadonlySet<string> = new Set(
  AMBIGUOUS_LABEL_WORDS.flatMap(spellingsOf),
);

/** Whether a written label word is one of AMBIGUOUS_LABEL_WORDS (an ordinary word too). */
export const isAmbiguousLabelWord = (written: string): boolean =>
  AMBIGUOUS_SPELLINGS.has(positionKey(written));
