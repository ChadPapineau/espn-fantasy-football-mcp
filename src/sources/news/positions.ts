// positions.ts — the position forms of a news item, for the player matcher's shared-name reading
// (ruling R8-6, changelog §R8: (a) a position "directly before" a shared name, "in parentheses
// directly after it" or "in the headline's name tag before the colon" labels him, and "a label must
// fit exactly one holder (… position from ESPN position_id)"; (b) the scan finds "a position in every
// written form (hyphenated, abbreviated, singular/plural)", an ambiguous token counting as found; plan
// 07 D6; plan 02 §6.4 — closed, tested lists, never a model). labels.ts reads the label and the scan
// with them, over the item's folded text (its apostrophes and dashes already "'" and "-").
//
// ESPN position ids (ds_players `position_id`; research 03 §B.2; src/domain/league/slots.ts
// POSITION_NAMES): 1 QB, 2 RB, 3 WR, 4 TE, 5 K, 7 P, 9 DT, 10 DE, 11 LB, 12 CB, 13 S. ESPN's own
// position, abbreviated or spelled out, fits only its own id ("DT" and "defensive tackle" fit an ESPN
// DT, never an ESPN DE): a label that fits a holder of another ESPN position would pick a wrong holder
// (fail closed). A writer's form that is no ESPN position stands for every id a player it describes
// may carry: the defensive line (DL, "lineman") ESPN's DT or DE, an edge rusher or an outside
// linebacker its DE or LB (ESPN lists the Rams' 3-4 outside linebacker Byron Young as a DE), a pass
// rusher any of the front, a nickel or defensive back its CB or S. A subtype always held at one ESPN
// position fits only it (NT a DT, ILB and MLB an LB, FS and SS an S, RCB a CB). Offensive-line forms
// name a position no universe player holds (ESPN's index lists none): as a label they fit no one.
//
// The closed lists, each held entry by entry by the tests:
//   POSITION_ABBREVIATIONS — labels and the scan; a label only as written in capitals ("LB Justin
//     Jefferson", never "lb"); a depth chart's rank (1–99) may follow any of them ("LB1", "WR10");
//   POSITION_WORDS — labels and the scan, in any case, one or two words ("linebacker", "free safety",
//     "d-lineman"); a two-word form is listed where a label needs it ("Vikings wide receiver Justin
//     Jefferson": "wide" is no form, so "receiver" alone would end the label before the team);
//   AMBIGUOUS_LABEL_WORDS — the label words that are also ordinary words ("safety", "corner"): right
//     after a preposition or an article they label no one ("After safety Lamar Jackson leads …";
//     labels.ts);
//   SCAN_ONLY_ABBREVIATIONS and SCAN_ONLY_WORDS — found by the scan, never a label: verbs and common
//     nouns right before a name ("tackle", "nose"; "edge", which the scan reads as the EDGE abbreviation
//     in any case), roles, alignments, units and depth-chart names ("returner", "slot", "secondary",
//     "WILL");
//   CAPS_ONLY_POSITION_ABBREVIATIONS — the abbreviations whose lower case is an ordinary word, a name
//     or a unit ("s", "k", "de", "lb" for pounds): the scan counts them only in capitals; every other
//     abbreviation it counts in any case ("cb", "olb", "idl").
// By rule, not by list: each word's plural ("linebackers", "safeties", "linemen", "QBs", "LBS"); a
// form's hyphenated and glued spellings ("wide-out", "full-back", "tightend"); a rank after an
// abbreviation ("CB2"); a technique ("1-tech", "5-technique", "4i", "three-technique").

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
/** A pass rusher: an edge or an interior lineman (ESPN's DT, DE or LB). */
const RUSHER = [9, 10, 11];
/** Defensive backs: ESPN lists a nickel or hybrid back as CB or S. */
const DB = [12, 13];
/** Any defender. */
const DEFENSE = [9, 10, 11, 12, 13];
/** The offensive line: no universe player (ESPN's index lists none). */
const OL: number[] = [];

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

/** Abbreviations (labels in capitals, and the scan): ESPN's own, then writers' and depth charts'. */
// prettier-ignore
export const POSITION_ABBREVIATIONS: Readonly<Record<string, readonly number[]>> = freeze({
  QB, RB, HB: RB, FB: RB, WR, TE, K, PK: K, P,
  DT, NT: DT, LDT: DT, RDT: DT, DE, LDE: DE, RDE: DE, DL, IDL: DL,
  EDGE, OLB: EDGE, LOLB: EDGE, ROLB: EDGE,
  LB, ILB: LB, MLB: LB, WLB: LB, SLB: LB, LILB: LB, RILB: LB,
  CB, RCB: CB, LCB: CB, NCB: CB, S, FS: S, SS: S, NB: DB, DB,
  OL, OT: OL, OG: OL,
});

/** Words (labels and the scan), in any case; a space stands for any whitespace, "-" for a dash. */
// prettier-ignore
export const POSITION_WORDS: Readonly<Record<string, readonly number[]>> = freeze({
  quarterback: QB, "signal caller": QB,
  "running back": RB, halfback: RB, tailback: RB, fullback: RB,
  receiver: WR, wideout: WR, "wide receiver": WR, "slot receiver": WR,
  "tight end": TE,
  kicker: K, placekicker: K, punter: P,
  "defensive tackle": DT, "nose tackle": DT, "d-tackle": DT,
  "defensive end": DE, "d-end": DE,
  lineman: DL, "d-lineman": DL, "defensive lineman": DL, "3-technique": DL,
  "edge rusher": EDGE, "outside linebacker": EDGE,
  linebacker: LB, "inside linebacker": LB, "middle linebacker": LB,
  "pass rusher": RUSHER,
  cornerback: CB, corner: CB, "slot corner": CB,
  safety: S, "free safety": S, "strong safety": S,
  "nickel back": DB, "defensive back": DB,
  defender: DEFENSE, "defensive player": DEFENSE,
  "offensive lineman": OL,
});

/**
 * The label words that are also ordinary words: right after a preposition or an article (labels.ts
 * LABEL_BLOCKERS) they are the ordinary word and label no name ("After safety Lamar Jackson leads …",
 * "in the corner Justin Jefferson …"); "Veteran safety …" and "Eagles safety …" label him.
 */
export const AMBIGUOUS_LABEL_WORDS: readonly string[] = Object.freeze(["corner", "safety"]);

/** Abbreviations the scan finds that never label a name: the offensive line's, roles, depth names. */
// prettier-ignore
export const SCAN_ONLY_ABBREVIATIONS: readonly string[] = Object.freeze([
  "LT", "RT", "LG", "RG", "C", "LS", "KR", "PR", "ST", "DI", "ATH", "MIKE", "WILL", "SAM",
]);

/**
 * Words the scan finds (in any case) that never label a name: verbs and common nouns right before a
 * name, roles, alignments, packages and units. An ambiguous token counts as found (R8-6 (b)).
 */
// prettier-ignore
export const SCAN_ONLY_WORDS: readonly string[] = Object.freeze([
  "tackle", "guard", "center", "centre", "nose", "rusher", "backer", "off-ball", "rover",
  "returner", "return man", "snapper", "gunner", "holder", "specialist", "special teams",
  "special teamer", "tackler", "pass catcher", "flanker", "split end", "slot", "h-back",
  "wingback", "slotback", "scatback", "nickel", "dime", "dimeback",
  "secondary", "defensive line", "offensive line", "o-line", "d-line", "defensive front",
  "defensive interior", "front seven", "pass rush", "linebacking", "receiving corps", "backfield",
]);

/** The abbreviations whose lower case is an ordinary word, a name or a unit: counted only in capitals. */
// prettier-ignore
export const CAPS_ONLY_POSITION_ABBREVIATIONS: readonly string[] = Object.freeze([
  "C", "DE", "DI", "K", "LB", "LT", "MIKE", "OL", "P", "S", "SAM", "ST", "WILL",
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

/** A word's plural as the scan reads it ("linebackers", "safeties", "linemen", "running backs"). */
export function pluralOf(word: string): string {
  if (word.endsWith("man")) return `${word.slice(0, -3)}men`;
  if (/[^aeiou]y$/u.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Whether a written token is all capitals (at least one letter, no lower-case letter). */
export const isCaps = (written: string): boolean =>
  /\p{Lu}/u.test(written) && !/\p{Ll}/u.test(written);

/** A rank written after an abbreviation: a depth chart's 1–99. */
const RANK_RE = /^(\p{L}+)([1-9][0-9]?)$/u;

/** A form's spellings as written: as listed, with a hyphen for each space, glued (no space or hyphen). */
function spellings(form: string): string[] {
  const k = positionKey(form);
  return [...new Set([k, k.replaceAll(" ", "-"), k.replace(/[\s-]/gu, "")])];
}

const ABBREVIATION_IDS: ReadonlyMap<string, readonly number[]> = new Map(
  Object.entries(POSITION_ABBREVIATIONS),
);
/** Each word form's spellings ("edge rusher", "edge-rusher", "edgerusher") and its ids. */
const WORD_IDS: ReadonlyMap<string, readonly number[]> = new Map(
  Object.entries(POSITION_WORDS).flatMap(([k, v]) => spellings(k).map((s) => [s, v] as const)),
);

/**
 * The ESPN ids a position LABEL written as `written` names (one form: an abbreviation in capitals,
 * its rank allowed, or a word or two in any case, hyphenated or glued: "edge-rusher", "wide-out"),
 * or null when it is no label form. A scan-only form is none.
 */
export function positionLabelIds(written: string): ReadonlySet<number> | null {
  if (isCaps(written)) {
    const ranked = RANK_RE.exec(written);
    const abbreviation = ABBREVIATION_IDS.get(ranked?.[1] ?? written);
    if (abbreviation !== undefined) return new Set(abbreviation);
  }
  const key = positionKey(written);
  const fromWord = WORD_IDS.get(key) ?? WORD_IDS.get(key.replaceAll("-", ""));
  return fromWord === undefined ? null : new Set(fromWord);
}

/** Whether a written label word is one of AMBIGUOUS_LABEL_WORDS (an ordinary word too). */
export const isAmbiguousLabelWord = (written: string): boolean =>
  AMBIGUOUS_LABEL_WORDS.includes(positionKey(written));

/** Every word form the scan finds, keyed by `positionKey`: each spelling, and its plural. */
const SCAN_WORD_KEYS: ReadonlySet<string> = new Set(
  [...Object.keys(POSITION_WORDS), ...SCAN_ONLY_WORDS]
    .flatMap(spellings)
    .flatMap((w) => [w, pluralOf(w)]),
);
const ANY_CASE_ABBREVIATIONS: ReadonlySet<string> = new Set(
  [...Object.keys(POSITION_ABBREVIATIONS), ...SCAN_ONLY_ABBREVIATIONS].filter(
    (a) => !CAPS_ONLY_POSITION_ABBREVIATIONS.includes(a),
  ),
);
const ALL_ABBREVIATIONS: ReadonlySet<string> = new Set([
  ...Object.keys(POSITION_ABBREVIATIONS),
  ...SCAN_ONLY_ABBREVIATIONS,
]);
/**
 * A technique, keyed by `positionKey`: an alignment number (a digit or its word, an "i" allowed),
 * then "tech" or "technique" ("5-tech", "9 technique", "three-technique"); or a shade alone ("4i").
 */
const TECHNIQUE_RE =
  /^(?:(?:[0-9]i?|zero|one|two|three|four|five|six|seven|eight|nine)[- ]?tech(?:nique)?s?|[0-9]i)$/u;

/** Whether an abbreviation (no rank) is one the scan counts as written: capitals, or its case allowed. */
function abbreviationFound(written: string): boolean {
  const upper = written.toUpperCase();
  if (!ALL_ABBREVIATIONS.has(upper)) return false;
  return isCaps(written) || ANY_CASE_ABBREVIATIONS.has(upper);
}

/**
 * Whether the scan finds a position in one written word or two (a space between, the item's text
 * folded: apostrophes "'" and dashes "-"): a word form or its plural, an abbreviation by its case, a
 * plural or a rank of one ("QBs", "LBS", "CB2"), or a technique ("1-tech", "4i").
 */
export function positionFound(written: string): boolean {
  const key = positionKey(written);
  if (SCAN_WORD_KEYS.has(key) || TECHNIQUE_RE.test(key)) return true;
  if (written.includes(" ")) return false;
  if (abbreviationFound(written)) return true;
  // a plural abbreviation: "QBs", "LBS" (an all-caps headline's), "cbs"
  const last = written.at(-1);
  const stem = written.slice(0, -1);
  if ((last === "s" || last === "S") && stem.length > 0 && abbreviationFound(stem)) return true;
  // a rank: "CB2", "WR10"; a plural rank: "WR1s"
  const unranked = last === "s" || last === "S" ? stem : written;
  const ranked = RANK_RE.exec(unranked);
  return ranked !== null && abbreviationFound(ranked[1] ?? "");
}
