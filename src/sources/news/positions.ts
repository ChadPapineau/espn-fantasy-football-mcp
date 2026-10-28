// positions.ts — the position forms of a news item, for the player matcher's shared-name reading
// (ruling R8-6, changelog §R8: (a) a position "directly before" a shared name, "in parentheses
// directly after it" or "in the headline's name tag before the colon" labels him; (b) the scan finds "a
// position in every written form (hyphenated, abbreviated, singular/plural)", an ambiguous token
// counting as found; ESPN's `position_id` joined into the universe, R8-3 clause 4; plan 07 D6; plan 02
// §6.4 — closed, tested lists, never a model). labels.ts reads the label and the scan with them.
//
// ESPN position ids (ds_players `position_id`; research 03 §B.2; src/domain/league/slots.ts
// POSITION_NAMES): 1 QB, 2 RB, 3 WR, 4 TE, 5 K, 7 P, 9 DT, 10 DE, 11 LB, 12 CB, 13 S. A writer's word and
// ESPN's label part where a role is shared — an edge rusher is ESPN's DE or LB, a 3-4 end its DT or DE,
// a nickel back its CB or S, and a pass rusher may be any of the front (ESPN lists the interior rusher
// Chris Jones as a DT) — so each form stands for every id a player it describes may carry, and a label
// fits only a holder whose id one reading of it allows. Offensive-line forms name a position no
// universe player holds (ESPN's index lists none): as a label they fit no one.
//
// The closed lists, each held entry by entry by the tests:
//   POSITION_ABBREVIATIONS — counted only as written in capitals ("LB", "S"; never "lb" or "s"), with a
//     depth chart's rank on the four that carry one ("WR1", "QB2") and, in the scan, a plural "s";
//   POSITION_WORDS — in any case, one or two words ("linebacker", "running back", "d-lineman"). A
//     two-word form is listed only where its last word alone reads otherwise ("wide receiver" is
//     "receiver"'s; "offensive lineman" is not "lineman"'s DL, and "left tackle" needs no entry:
//     "tackle" is no label word, and the scan finds it);
//   SCAN_ONLY_ABBREVIATIONS and SCAN_ONLY_WORDS — found by the scan, never a label: tokens that are
//     also verbs or common nouns right before a name ("edge", "tackle", "guard", "center": "Browns edge
//     Justin Jefferson, Vikings" names the Browns as his opponent), or that name a role more than a
//     position ("rusher", "returner", "tackler", "nickel", "'backer").
// The scan also reads each word's plural ("linebackers", "safeties", "linemen", "QBs").

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

/** Abbreviations (labels and the scan): counted only as written in capitals. */
// prettier-ignore
export const POSITION_ABBREVIATIONS: Readonly<Record<string, readonly number[]>> = freeze({
  QB, RB, HB: RB, FB: RB, WR, TE, K, PK: K, P,
  DT: DL, DE: DL, DL, NT: DL, IDL: DL,
  OLB: EDGE, LB: EDGE, ILB: EDGE, MLB: EDGE, WLB: EDGE, SLB: EDGE,
  CB: DB, RCB: DB, LCB: DB, NCB: DB, NB: DB, S: DB, FS: DB, SS: DB, DB,
  OL, OT: OL, OG: OL,
});

/** The abbreviations a depth chart's rank may follow ("WR1", "QB2", "RB3"). */
export const RANKED_ABBREVIATIONS: readonly string[] = Object.freeze(["QB", "RB", "WR", "TE"]);

/** Words (labels and the scan), in any case; a space stands for any whitespace, a hyphen for a dash. */
// prettier-ignore
export const POSITION_WORDS: Readonly<Record<string, readonly number[]>> = freeze({
  quarterback: QB, "signal-caller": QB, "signal caller": QB,
  "running back": RB, halfback: RB, tailback: RB, fullback: RB,
  receiver: WR, wideout: WR,
  "tight end": TE,
  kicker: K, placekicker: K, "place-kicker": K, punter: P,
  "defensive tackle": DL, "nose tackle": DL, "defensive end": DL, lineman: DL, "d-lineman": DL,
  "d-tackle": DL, "d-end": DL, "3-technique": DL,
  "edge rusher": EDGE, "edge-rusher": EDGE, linebacker: EDGE,
  "pass rusher": RUSHER, "pass-rusher": RUSHER,
  cornerback: DB, corner: DB, nickelback: DB, "nickel back": DB, safety: DB, "defensive back": DB,
  defender: DEFENSE, "defensive player": DEFENSE,
  "offensive lineman": OL,
});

/** Abbreviations the scan finds (in capitals) that never label a name: the offensive line's, a role. */
// prettier-ignore
export const SCAN_ONLY_ABBREVIATIONS: readonly string[] = Object.freeze([
  "LT", "RT", "LG", "RG", "C", "LS", "KR", "PR",
]);

/**
 * Words the scan finds (in any case) that never label a name: verbs and common nouns right before a
 * name, and roles more than positions. An ambiguous token counts as found (R8-6 (b)).
 */
// prettier-ignore
export const SCAN_ONLY_WORDS: readonly string[] = Object.freeze([
  "edge", "tackle", "guard", "center", "centre", "rusher", "returner", "snapper", "gunner",
  "tackler", "nickel", "dimeback", "dime back", "backer", "off-ball", "pass catcher",
  "special teamer", "o-line", "d-line", "3-tech", "1-technique", "5-technique",
]);

/** The ESPN position ids some position form names; any other id is unknown to this reading. */
export const KNOWN_POSITION_IDS: ReadonlySet<number> = new Set([
  ...Object.values(POSITION_ABBREVIATIONS).flat(),
  ...Object.values(POSITION_WORDS).flat(),
]);

/** A word as the lists key it: lower case, one space between words, a dash folded to a hyphen. */
export function positionKey(written: string): string {
  return written
    .toLowerCase()
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A word's plural as the scan reads it ("linebackers", "safeties", "linemen", "running backs"). */
export function pluralOf(word: string): string {
  if (word.endsWith("man")) return `${word.slice(0, -3)}men`;
  if (/[^aeiou]y$/u.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Whether a written token is all capitals (at least one letter, no lower-case letter). */
const isCaps = (written: string): boolean => /\p{Lu}/u.test(written) && !/\p{Ll}/u.test(written);

/** The abbreviation a written token is (a rank stripped), when it is written in capitals; else null. */
function abbreviationOf(written: string): string | null {
  if (!isCaps(written)) return null;
  const ranked = /^(\p{Lu}+)[1-3]$/u.exec(written);
  if (ranked !== null) {
    const base = ranked[1] ?? "";
    return RANKED_ABBREVIATIONS.includes(base) ? base : null;
  }
  return written;
}

const ABBREVIATION_IDS: ReadonlyMap<string, readonly number[]> = new Map(
  Object.entries(POSITION_ABBREVIATIONS),
);
const WORD_IDS: ReadonlyMap<string, readonly number[]> = new Map(Object.entries(POSITION_WORDS));

/**
 * The ESPN ids a position LABEL written as `written` names (one form: an abbreviation in capitals, its
 * rank allowed, or a word or two in any case), or null when it is no label form.
 */
export function positionLabelIds(written: string): ReadonlySet<number> | null {
  const abbreviation = abbreviationOf(written);
  const fromAbbreviation = abbreviation === null ? undefined : ABBREVIATION_IDS.get(abbreviation);
  if (fromAbbreviation !== undefined) return new Set(fromAbbreviation);
  const fromWord = WORD_IDS.get(positionKey(written));
  return fromWord === undefined ? null : new Set(fromWord);
}

/** Every word form the scan finds, keyed by `positionKey` (one or two words, each plural too). */
export const SCAN_POSITION_KEYS: ReadonlySet<string> = new Set(
  [...Object.keys(POSITION_WORDS), ...SCAN_ONLY_WORDS].flatMap((w) => [w, pluralOf(w)]),
);
/** Every abbreviation the scan finds in capitals, the ranked ones with their rank too ("WR2"). */
export const SCAN_POSITION_ABBREVIATIONS: ReadonlySet<string> = new Set([
  ...Object.keys(POSITION_ABBREVIATIONS),
  ...SCAN_ONLY_ABBREVIATIONS,
  ...RANKED_ABBREVIATIONS.flatMap((a) => [`${a}1`, `${a}2`, `${a}3`]),
]);
