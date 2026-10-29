// labels.ts — the reading of a name several universe players hold (a shared name), for the news
// player matcher (ruling R8-6, changelog §R8: the matcher fails closed for a shared name; plan 07 D6;
// plan 02 §6.4 — rules over closed, tested lists, never a model). It reads two things, and nothing else
// about a shared name's holders is read anywhere (R8-6 (c)):
//
//   the LABEL written next to the name (R8-6 (a), `SharedReading.label`) — a team or a position
//     directly before it, whitespace only between ("Browns LB Justin Jefferson", "Browns' Justin
//     Jefferson", "LB Justin Jefferson", "Kansas City's Chris Jones"); in parentheses directly after it
//     ("(CLE)", "(CLE - LB)", "(LB, Browns)", "(Vikings wide receiver)"); or in the headline's name tag
//     before the colon ("Justin Jefferson, CLE:", "Justin Jefferson LB:"). Adjacency is broken by any
//     punctuation but the possessive ("…the Vikings, Justin Jefferson…" is no label), by a closing
//     quotation mark ("'Beat the Vikings' Justin Jefferson tells …": an apostrophe that closes a quote
//     opened in its segment is no possessive), by a line or a paragraph break the raw item writes (a
//     newline, or any HTML tag: sanitizeText turns both into a space, `markBreaks` keeps where they
//     were), and by any word that is no team and no position ("Vikings star Justin Jefferson" labels no
//     team). Three more rules only take labels away: a label of teams alone (no possessive, no position)
//     must open its clause, so a word right before it makes it that word's object or modifier
//     ("Against the Vikings Justin Jefferson recorded 12 tackles", "Week 9 at Vikings Justin Jefferson
//     …", "Browns beat Vikings Justin Jefferson …"); an AMBIGUOUS_LABEL_WORDS word ("safety", "corner")
//     right after a LABEL_BLOCKERS word is the ordinary word ("After safety Lamar Jackson leads …";
//     "Veteran safety …" and "the Eagles safety …" label him); and in a segment written all in
//     capitals, the forms that are also ordinary words (CAPS_ONLY_ABBREVIATIONS, "EDGE") label no name
//     before it ("BROWNS EDGE JUSTIN JEFFERSON, VIKINGS"). A tag that holds anything else is no label
//     ("(knee)", "(vs. CLE)");
//   the broad SCAN (R8-6 (b), `SharedReading.namesTeamOrPosition`) — whether the title or the blurb
//     names any team or any position anywhere, the persons' full names left out ("Dallas Goedert"; a
//     surname standing alone may be a team, "Washington", and is read): a team in every form and any
//     case — a nickname, a
//     singular ("Ex-Brown"), a home, a city (TEAM_CITIES: where a team plays or trains), a short name, a
//     legacy name ("Oilers", "Oakland"), a whole-word abbreviation (TEAM_ABBREVIATIONS, PFR's and MFL's
//     among them, and the legacy ones), and a compound that holds one: a handle, a hashtag, a domain or
//     a camel-cased word ("@Browns", "#RaiderNation", "#CLEvsMIN", "ClevelandBrowns.com",
//     "kcchiefs.com"); and a position in every written form (positions.ts). The scan only ever takes the
//     residual away, so it errs toward finding: an ambiguous token costs recall, never precision.
//
// The item is read FOLDED (`foldText`), one code point at a time, with a map back to the sanitised text's
// offsets: NFKD with the combining marks stripped (accents, fullwidth and compatibility forms), the
// lookalike letters folded to Latin ones (CONFUSABLES), the apostrophe-like marks to "'" (APOSTROPHES)
// and the dash punctuation to "-" (Unicode's Pd, and DASHES). sanitizeText (plan 02 §6.2) has already
// removed controls and zero-width characters and collapsed whitespace. Words are read in any case; an
// abbreviation whose lower-case form is an ordinary word or a name (CAPS_ONLY_ABBREVIATIONS, and
// positions.ts' CAPS_ONLY_POSITION_ABBREVIATIONS) counts only in capitals, so an all-caps headline's "NO"
// counts and "No timetable" does not.
//
// The team forms, each list closed and held entry by entry by the tests: teams.ts' nicknames and homes
// (exactly the unique names' own), SHARED_HOMES, TEAM_SHORT_NAMES and TEAM_ABBREVIATIONS (labels and the
// scan, each with its hyphenated and glued spellings: "G-Men", "Gmen"); for the scan only,
// TEAM_SINGULARS, TEAM_CITIES, SCAN_ONLY_TEAM_NAMES and SCAN_ONLY_TEAM_ABBREVIATIONS. A label's team is
// the universe's: it fits only a holder on one of the teams it names (match.ts). Both readings are
// linear in the item: the fold, the breaks and the quotes are one pass each, a label reads a bounded
// window around each name, and the scan reads each word once (a compound up to MAX_COMPOUND letters).
import type { NflTeam } from "../../config/schema.js";
import { isAmbiguousLabelWord, positionFound, positionLabelIds } from "./positions.js";
import { TEAM_HOMES, TEAM_NICKNAMES } from "./teams.js";

/** The homes that hold two teams: a team of either ("the Los Angeles Rams", "New York's"). */
export const SHARED_HOMES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  "Los Angeles": Object.freeze(["LA", "LAC"] as const),
  "New York": Object.freeze(["NYG", "NYJ"] as const),
});

/** The short names feeds write for a team, beside teams.ts' nicknames and homes. */
// prettier-ignore
export const TEAM_SHORT_NAMES: Readonly<Record<string, NflTeam>> = Object.freeze({
  Vikes: "MIN", Fins: "MIA", Phins: "MIA", Bolts: "LAC", Pack: "GB", Hawks: "SEA", Cards: "ARI",
  "G-Men": "NYG", Cincy: "CIN", Vegas: "LV", "Big Blue": "NYG", "Gang Green": "NYJ",
});

/**
 * The team abbreviations feeds write: nflverse's; ESPN's LAR and WSH; the JAC some feeds use; PFF's
 * ARZ, BLT, CLV and HST; Pro Football Reference's GNB, KAN, LVR, NOR, NWE, SFO and TAM; MyFantasyLeague's
 * GBP, KCC, NEP, NOS and TBB; and NY (either New York team).
 */
// prettier-ignore
export const TEAM_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  ARI: ["ARI"], ARZ: ["ARI"], ATL: ["ATL"], BAL: ["BAL"], BLT: ["BAL"], BUF: ["BUF"], CAR: ["CAR"],
  CHI: ["CHI"], CIN: ["CIN"], CLE: ["CLE"], CLV: ["CLE"], DAL: ["DAL"], DEN: ["DEN"], DET: ["DET"],
  GB: ["GB"], GNB: ["GB"], GBP: ["GB"], HOU: ["HOU"], HST: ["HOU"], IND: ["IND"], JAX: ["JAX"],
  JAC: ["JAX"], KC: ["KC"], KAN: ["KC"], KCC: ["KC"], LA: ["LA"], LAR: ["LA"], LAC: ["LAC"],
  LV: ["LV"], LVR: ["LV"], MIA: ["MIA"], MIN: ["MIN"], NE: ["NE"], NWE: ["NE"], NEP: ["NE"],
  NO: ["NO"], NOR: ["NO"], NOS: ["NO"], NYG: ["NYG"], NYJ: ["NYJ"], NY: ["NYG", "NYJ"],
  PHI: ["PHI"], PIT: ["PIT"], SEA: ["SEA"], SF: ["SF"], SFO: ["SF"], TB: ["TB"], TAM: ["TB"],
  TBB: ["TB"], TEN: ["TEN"], WAS: ["WAS"], WSH: ["WAS"],
});

/**
 * The legacy abbreviations of moved and renamed teams (OAK, SD, SDG, STL, PHX, WFT), and the D.C. of
 * Washington's (an initialism reads as "DC"): found by the scan only, never a label.
 */
// prettier-ignore
export const SCAN_ONLY_TEAM_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  OAK: ["LV"], SD: ["LAC"], SDG: ["LAC"], STL: ["LA"], PHX: ["ARI"], WFT: ["WAS"], DC: ["WAS"],
});

/** The abbreviations whose lower-case form is an ordinary word or a name: counted only in capitals. */
// prettier-ignore
export const CAPS_ONLY_ABBREVIATIONS: readonly string[] = Object.freeze([
  "ARI", "CAR", "CHI", "DAL", "DEN", "JAC", "LA", "LAC", "MIA", "MIN", "NE", "NO", "NOR", "NOS",
  "OAK", "PHI", "PIT", "SEA", "TAM", "TEN", "WAS",
]);

/**
 * Singular nicknames ("a former Raven", "Ex-Brown", "ex-Bolt"), found by the scan only, never a label.
 * Those that are ordinary words or names (Brown, Bill, Chief, Giant, Jet, Saint, Ram, Colt, Lion,
 * Bear, Pat) are found too: an ambiguous token counts as found (R8-6 (b)).
 */
// prettier-ignore
export const TEAM_SINGULARS: Readonly<Record<string, NflTeam>> = Object.freeze({
  Cardinal: "ARI", Falcon: "ATL", Raven: "BAL", Bill: "BUF", Panther: "CAR", Bear: "CHI",
  Bengal: "CIN", Brown: "CLE", Cowboy: "DAL", Bronco: "DEN", Lion: "DET", Packer: "GB",
  Texan: "HOU", Colt: "IND", Jaguar: "JAX", Jag: "JAX", Chief: "KC", Ram: "LA", Charger: "LAC",
  Bolt: "LAC", Raider: "LV", Dolphin: "MIA", Fin: "MIA", Phin: "MIA", Viking: "MIN", Vike: "MIN",
  Patriot: "NE", Pat: "NE", Saint: "NO", Giant: "NYG", Jet: "NYJ", Eagle: "PHI", Steeler: "PIT",
  Seahawk: "SEA", "49er": "SF", Niner: "SF", Buccaneer: "TB", Buc: "TB", Titan: "TEN",
  Commander: "WAS",
});

/**
 * The places of a team where its home is not the place's name: the city it plays or trains in ("in
 * Nashville", "per a Minneapolis Star Tribune writer", "at practice in Berea"), its city's nicknames
 * ("Titletown", "Steel City", "NOLA") and its stadium ("Lambeau", "Arrowhead"): found by the scan
 * only, never a label.
 */
// prettier-ignore
export const TEAM_CITIES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  Glendale: ["ARI"], Phoenix: ["ARI"], Tempe: ["ARI"], "Flowery Branch": ["ATL"],
  "Owings Mills": ["BAL"], "Charm City": ["BAL"], "Orchard Park": ["BUF"], Highmark: ["BUF"],
  Charlotte: ["CAR"], "Queen City": ["CAR", "CIN"], "Lake Forest": ["CHI"], "Windy City": ["CHI"],
  "Soldier Field": ["CHI"], Berea: ["CLE"], Arlington: ["DAL"], Frisco: ["DAL"], "Big D": ["DAL"],
  "Mile High": ["DEN"], "Allen Park": ["DET"], "Motor City": ["DET"], Motown: ["DET"],
  Titletown: ["GB"], Lambeau: ["GB"], "H-Town": ["HOU"], "Space City": ["HOU"], Duval: ["JAX"],
  Arrowhead: ["KC"], Inglewood: ["LA", "LAC"], SoFi: ["LA", "LAC"], "Thousand Oaks": ["LA"],
  "El Segundo": ["LAC"], "Costa Mesa": ["LAC"], Paradise: ["LV"], "Sin City": ["LV"],
  Allegiant: ["LV"], Davie: ["MIA"], "Magic City": ["MIA"], Minneapolis: ["MIN"], Eagan: ["MIN"],
  "Twin Cities": ["MIN"], Foxborough: ["NE"], Foxboro: ["NE"], Gillette: ["NE"], Metairie: ["NO"],
  "Big Easy": ["NO"], NOLA: ["NO"], Superdome: ["NO"], "East Rutherford": ["NYG", "NYJ"],
  MetLife: ["NYG", "NYJ"], "Big Apple": ["NYG", "NYJ"], "Florham Park": ["NYJ"], Latrobe: ["PIT"],
  "Steel City": ["PIT"], Acrisure: ["PIT"], Renton: ["SEA"], "Emerald City": ["SEA"], Lumen: ["SEA"],
  "Santa Clara": ["SF"], "Bay Area": ["SF"], Tampa: ["TB"], Nashville: ["TEN"],
  "Music City": ["TEN"], Landover: ["WAS"], Ashburn: ["WAS"],
});

/**
 * The names the scan finds that never label a name: short names more than one team or ordinary words
 * share ("Birds", "'Boys"), fans' names for a team ("Skol", "Who Dey", "Dawg Pound", "12s"), and the
 * legacy names of moved and renamed teams ("Oilers", "Football Team", "St. Louis").
 */
// prettier-ignore
export const SCAN_ONLY_TEAM_NAMES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  Birds: ["ARI", "ATL", "BAL", "PHI", "SEA"], Boys: ["DAL"], "Big Red": ["ARI"],
  "Dawg Pound": ["CLE"], "Who Dey": ["CIN"], Skol: ["MIN"], "Who Dat": ["NO"], Iggles: ["PHI"],
  "Steel Curtain": ["PIT"], "12s": ["SEA"], "12th Man": ["SEA"],
  Skins: ["WAS"], Redskins: ["WAS"], "Football Team": ["WAS"], Oilers: ["TEN"], Oakland: ["LV"],
  "San Diego": ["LAC"], "St Louis": ["LA"], "Saint Louis": ["LA"],
});

/**
 * The teams' own hashtags that hold no team form ("#HereWeGo", "#DUUUVAL"): found by the scan only
 * after "#", in any case.
 */
// prettier-ignore
export const TEAM_HASHTAGS: Readonly<Record<string, NflTeam>> = Object.freeze({
  RiseUp: "ATL", KeepPounding: "CAR", RuleTheJungle: "CIN", OnePride: "DET", ForTheShoe: "IND",
  DUUUVAL: "JAX", TogetherBlue: "NYG", TakeFlight: "NYJ", BirdGang: "PHI", HereWeGo: "PIT",
  FTTB: "SF", HTTC: "WAS", HTTR: "WAS",
});

/** What may stand between the items of a tag (a space too): "(CLE - LB)", "(LB, Browns)", "(QB/RB)". */
export const LABEL_SEPARATORS: readonly string[] = Object.freeze([",", "-", "/"]);

/**
 * The articles and prepositions an ordinary-word position (AMBIGUOUS_LABEL_WORDS) is the object of
 * right after them: "After safety Lamar Jackson leads …", "in the corner Justin Jefferson …" — no
 * label ("Veteran safety …" is one). A label of teams alone needs no list: it must open its clause.
 */
// prettier-ignore
export const LABEL_BLOCKERS: readonly string[] = Object.freeze([
  "a", "about", "above", "across", "after", "against", "along", "amid", "among", "an", "around",
  "as", "at", "before", "behind", "beside", "between", "beyond", "by", "despite", "during",
  "facing", "for", "from", "in", "inside", "into", "like", "near", "of", "off", "on", "onto",
  "outside", "over", "past", "per", "since", "than", "the", "through", "to", "toward", "towards",
  "under", "until", "upon", "v", "versus", "via", "vs", "with", "within", "without",
]);

/**
 * The words whose period does not end the clause: a team right after "vs." or "v." is that word's
 * object ("Week 9 vs. Vikings Justin Jefferson …").
 */
export const CLAUSE_ABBREVIATIONS: readonly string[] = Object.freeze(["v", "vs"]);

/**
 * The position abbreviations that, written in a segment all in capitals, may be the ordinary word
 * ("BROWNS EDGE JUSTIN JEFFERSON, VIKINGS"): no label before the name there (nor is any of
 * CAPS_ONLY_ABBREVIATIONS).
 */
export const HEADLINE_ORDINARY_WORDS: readonly string[] = Object.freeze(["EDGE"]);

/**
 * The letters folded to Latin ones: the Cyrillic, Greek and Armenian letters that look like them, and
 * the Latin letters NFKD does not decompose (accents are stripped as combining marks).
 */
// prettier-ignore
export const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  "а": "a", "А": "A", "В": "B", "с": "c", "С": "C", "е": "e", "Е": "E", "Н": "H", "і": "i",
  "І": "I", "ј": "j", "Ј": "J", "К": "K", "к": "k", "М": "M", "о": "o", "О": "O", "р": "p",
  "Р": "P", "ѕ": "s", "Ѕ": "S", "Т": "T", "у": "y", "Х": "X", "х": "x", "ԁ": "d", "ԝ": "w",
  "ӏ": "l",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "ο": "o", "ι": "i", "κ": "k", "ν": "v",
  "ρ": "p", "υ": "u", "χ": "x", "ϲ": "c",
  "օ": "o",
  "ø": "o", "Ø": "O", "ß": "ss", "đ": "d", "Đ": "D", "ð": "d", "ł": "l", "Ł": "L", "ı": "i",
  "ħ": "h", "þ": "th", "ɡ": "g", "ɑ": "a",
});

/** The marks folded to an apostrophe ("'"): curly and reversed quotes, the modifier letters, accents, primes. */
// prettier-ignore
export const APOSTROPHES: readonly string[] = Object.freeze([
  "\u2019", "\u2018", "\u201B", "\u02BC", "\u02BB", "`", "\u00B4", "\u2032",
]);

/** Beside Unicode's dash punctuation (Pd), the marks folded to a hyphen ("-"): the minus sign. */
export const DASHES: readonly string[] = Object.freeze(["\u2212"]);

// ---------------------------------------------------------------------------------------------------
// The forms, keyed once.

/** A word or two of the folded text as the lists key it: lower case, no apostrophe, one space. */
function formKey(written: string): string {
  return written.toLowerCase().replaceAll("'", "").replace(/\s+/gu, " ").trim();
}

/** A form's spellings: as listed, with a hyphen for each space, and glued ("g-men", "gmen"). */
function spellings(form: string): string[] {
  const k = formKey(form);
  return [...new Set([k, k.replaceAll(" ", "-"), k.replace(/[\s-]/gu, "")])];
}

const freezeTeams = (teams: readonly NflTeam[]): readonly NflTeam[] => Object.freeze([...teams]);
const entriesOf = (
  o: Readonly<Record<string, NflTeam | readonly NflTeam[]>>,
): (readonly [string, readonly NflTeam[]])[] =>
  Object.entries(o).map(([k, t]) => [k, freezeTeams(typeof t === "string" ? [t] : t)] as const);

/** The word forms of a team that label a name (any case, each spelling): nicknames, homes, short names. */
const LABEL_WORD_TEAMS: ReadonlyMap<string, readonly NflTeam[]> = new Map(
  [
    ...entriesOf(TEAM_NICKNAMES),
    ...entriesOf(TEAM_HOMES),
    ...entriesOf(SHARED_HOMES),
    ...entriesOf(TEAM_SHORT_NAMES),
  ].flatMap(([k, ts]) => spellings(k).map((s) => [s, ts] as const)),
);
const LABEL_ABBREVIATIONS: ReadonlyMap<string, readonly NflTeam[]> = new Map(
  entriesOf(TEAM_ABBREVIATIONS),
);
const CAPS_ONLY: ReadonlySet<string> = new Set(CAPS_ONLY_ABBREVIATIONS);
const HEADLINE_AMBIGUOUS: ReadonlySet<string> = new Set([
  ...CAPS_ONLY_ABBREVIATIONS,
  ...HEADLINE_ORDINARY_WORDS,
]);
/** Every word form of a team the scan finds, each spelling ("st louis", "st-louis", "stlouis"). */
const SCAN_TEAM_KEYS: ReadonlySet<string> = new Set([
  ...LABEL_WORD_TEAMS.keys(),
  ...[TEAM_SINGULARS, TEAM_CITIES, SCAN_ONLY_TEAM_NAMES].flatMap((o) =>
    Object.keys(o).flatMap(spellings),
  ),
]);
const SCAN_ABBREVIATIONS: ReadonlySet<string> = new Set([
  ...Object.keys(TEAM_ABBREVIATIONS),
  ...Object.keys(SCAN_ONLY_TEAM_ABBREVIATIONS),
]);
/** The longest compound read (bounded work): "www.philadelphiaeagles.com" fits. */
const MAX_COMPOUND = 64;
/** The team word forms searched for inside a compound: glued, four letters or more. */
const COMPOUND_FORMS: readonly string[] = [...SCAN_TEAM_KEYS].filter(
  (k) => !/[\s-]/u.test(k) && k.length >= 4,
);
/**
 * Inside a hashtag only, the team's own hashtags, and the shorter forms too: three-letter
 * abbreviations and words ("#clevsmin", "#jetup").
 */
const HASHTAG_FORMS: readonly string[] = [
  ...new Set([
    ...Object.keys(TEAM_HASHTAGS).map((h) => h.toLowerCase()),
    ...[...SCAN_ABBREVIATIONS].filter((a) => a.length === 3).map((a) => a.toLowerCase()),
    ...[...SCAN_TEAM_KEYS].filter((k) => !/[\s-]/u.test(k) && k.length === 3),
  ]),
];

/**
 * The teams a written word or two (folded) name as a LABEL: a nickname, home or short name in any
 * case and spelling, or an abbreviation (in capitals; in any case unless CAPS_ONLY_ABBREVIATIONS lists
 * it); null when it names none. A scan-only form is none.
 */
export function labelTeams(written: string): readonly NflTeam[] | null {
  const key = formKey(written);
  const word = LABEL_WORD_TEAMS.get(key) ?? LABEL_WORD_TEAMS.get(key.replaceAll("-", ""));
  if (word !== undefined) return word;
  const upper = written.toUpperCase();
  const abbreviation = LABEL_ABBREVIATIONS.get(upper);
  if (abbreviation === undefined) return null;
  return written === upper || !CAPS_ONLY.has(upper) ? abbreviation : null;
}

/** Whether the scan finds a team in one written word or two (folded). */
function teamFound(written: string): boolean {
  if (SCAN_TEAM_KEYS.has(formKey(written))) return true;
  if (written.includes(" ")) return false;
  const upper = written.toUpperCase();
  if (!SCAN_ABBREVIATIONS.has(upper)) return false;
  return written === upper || !CAPS_ONLY.has(upper);
}

/** Whether the scan finds a team or a position in a written word or two (folded). */
const found = (written: string): boolean => teamFound(written) || positionFound(written);

// ---------------------------------------------------------------------------------------------------
// The fold.

const APOSTROPHE_SET: ReadonlySet<string> = new Set(APOSTROPHES);
const DASH_SET: ReadonlySet<string> = new Set(DASHES);
const CONFUSABLE_MAP: ReadonlyMap<string, string> = new Map(Object.entries(CONFUSABLES));
const DASH_PUNCTUATION_RE = /^\p{Pd}$/u;
const MARK_RE = /\p{M}/gu;
const FOLD_CACHE = new Map<string, string>();
const FOLD_CACHE_MAX = 65_536;

/**
 * One code point folded: an apostrophe or a lookalike first (NFKD would decompose some lookalikes to
 * other letters: the lunate sigma to a final sigma), else NFKD with the marks stripped, then each
 * piece's apostrophe, dash or lookalike.
 */
function foldChar(c: string): string {
  const hit = FOLD_CACHE.get(c);
  if (hit !== undefined) return hit;
  let v = "";
  const look = CONFUSABLE_MAP.get(c);
  if (APOSTROPHE_SET.has(c)) v = "'";
  else if (look !== undefined) v = look;
  else
    for (const d of c.normalize("NFKD").replace(MARK_RE, ""))
      v += APOSTROPHE_SET.has(d)
        ? "'"
        : DASH_PUNCTUATION_RE.test(d) || DASH_SET.has(d)
          ? "-"
          : (CONFUSABLE_MAP.get(d) ?? d);
  if (FOLD_CACHE.size < FOLD_CACHE_MAX) FOLD_CACHE.set(c, v);
  return v;
}

/** A text folded, and where each offset of the original text lands in it. */
export interface Folded {
  readonly text: string;
  /** `at[i]`: the folded offset of the original offset i (0 ≤ i ≤ the original's length). */
  readonly at: Int32Array;
}

/** The (sanitised) text folded one code point at a time, with its offset map. */
export function foldText(text: string): Folded {
  const at = new Int32Array(text.length + 1);
  const out: string[] = [];
  let len = 0;
  for (let i = 0; i < text.length;) {
    const n = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    const f = foldChar(text.slice(i, i + n));
    at[i] = len;
    if (n === 2) at[i + 1] = len;
    out.push(f);
    len += f.length;
    i += n;
  }
  at[text.length] = len;
  return { text: out.join(""), at };
}

// ---------------------------------------------------------------------------------------------------
// Line and paragraph breaks: where the raw item had them before sanitizeText made them spaces.

/** The mark standing for a break in the marked copy of the raw text. */
const BREAK_MARK = "\u00B6";
const AMP_RE = /&amp;/giu;
const LT_RE = /&(?:lt|#0*60|#x0*3c);/giu;
const GT_RE = /&(?:gt|#0*62|#x0*3e);/giu;
/** A tag, as sanitizeText removes it (bounded: an attribute run of at most 512 characters). */
const TAG_RE = /<\/?[A-Za-z][^<>]{0,512}>/gu;
const LINE_RE = /\r\n?|[\n\v\f\u0085\u2028\u2029]/gu;
/** Levels of `&amp;` decoded before the tags are marked (sanitizeText's own bound). */
const MAX_DECODE = 8;

/**
 * The raw item with each line break and each HTML tag (as written, or entity-encoded) replaced by a
 * break mark, for sanitizeText; `breakOffsets` aligns its output with the sanitised text's.
 */
export function markBreaks(raw: string): string {
  let s = raw;
  for (let k = 0; k < MAX_DECODE && /&amp;/iu.test(s); k++) s = s.replace(AMP_RE, "&");
  s = s.replace(LT_RE, "<").replace(GT_RE, ">");
  return s.replace(TAG_RE, ` ${BREAK_MARK} `).replace(LINE_RE, ` ${BREAK_MARK} `);
}

/**
 * Where a break sits in the sanitised `text`: `out[i]` is 1 when one stands right before offset i.
 * `marked` is sanitizeText's output over `markBreaks(raw)`; the two are walked together, and the walk
 * stops where they part (past that, no break is known: as if none were written).
 */
export function breakOffsets(text: string, marked: string): Uint8Array {
  const out = new Uint8Array(text.length + 1);
  let i = 0;
  let j = 0;
  while (j < marked.length) {
    const m = marked[j];
    if (m === BREAK_MARK && text[i] !== BREAK_MARK) {
      out[i] = 1;
      j++;
    } else if (i < text.length && text[i] === m) {
      i++;
      j++;
    } else if (m === " ") j++;
    else if (text[i] === " ") i++;
    else break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The reading of one item.

/** One part of a label written next to a name: the teams it may name, or the position ids it names. */
export type LabelPart =
  | { readonly kind: "team"; readonly teams: readonly NflTeam[] }
  | { readonly kind: "position"; readonly ids: ReadonlySet<number> };

/** Sorted, non-overlapping [start, end) spans of the sanitised text: persons' names. */
export type Spans = readonly (readonly [number, number])[];

/** At most this many words of a label are read on either side of a name (bounded work). */
const MAX_LABEL_WORDS = 6;
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
/** The characters that join the parts of one word in the folded text ("G-Men", "O'Connell", "L.A"). */
const isJoiner = (c: string | undefined): boolean => c === "'" || c === "." || c === "-";
const isLower = (c: string): boolean => c !== c.toUpperCase();
const isUpper = (c: string): boolean => c !== c.toLowerCase();

/** The start of the word that ends at `end` (exclusive), or -1 when none does. */
function wordStartBefore(s: string, end: number): number {
  let i = end;
  while (i > 0) {
    if (isWordChar(s[i - 1])) i--;
    else if (isJoiner(s[i - 1]) && i < end && isWordChar(s[i]) && isWordChar(s[i - 2])) i--;
    else break;
  }
  return i < end ? i : -1;
}

/** The end of the word that starts at `start`, or -1 when none does. */
function wordEndAfter(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    if (isWordChar(s[i])) i++;
    else if (isJoiner(s[i]) && i > start && isWordChar(s[i - 1]) && isWordChar(s[i + 1])) i++;
    else break;
  }
  return i > start ? i : -1;
}

/** Whether [a, b) overlaps one of the sorted spans (a binary search). */
function overlaps(spans: Spans, a: number, b: number): boolean {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((spans[mid]?.[1] ?? 0) <= a) lo = mid + 1;
    else hi = mid;
  }
  const s = spans[lo];
  return s !== undefined && s[0] < b;
}

/** A word or two as a label part: a team (a possessive allowed), else a position; null for neither. */
function labelPart(written: string, possessive: boolean, capsSegment: boolean): LabelPart | null {
  if (capsSegment && HEADLINE_AMBIGUOUS.has(written)) return null;
  const teams = labelTeams(written);
  if (teams !== null) return { kind: "team", teams };
  if (possessive) return null;
  const ids = positionLabelIds(written);
  return ids === null ? null : { kind: "position", ids };
}

/** A label word read before a name, and where it starts. */
interface ReadPart {
  readonly part: LabelPart;
  readonly from: number;
  readonly possessive: boolean;
  readonly ambiguous: boolean;
}

/** How one item is read for its shared names (R8-6 (a), (b)). */
export interface SharedReading {
  /** The label parts written next to the name at [start, end) of the sanitised text (R8-6 (a)). */
  label(start: number, end: number): readonly LabelPart[];
  /**
   * The segment the sanitised offset `at` lies in: the title and the blurb (joined by " | ") and the
   * parts a "|" or a line or paragraph break separates are numbered in order.
   */
  segment(at: number): number;
  /** Whether the item names any team or any position outside the spared spans (R8-6 (b)). */
  namesTeamOrPosition(): boolean;
}

/**
 * The reading of one item: `text` is its sanitised text; `marked` sanitizeText's output over
 * `markBreaks(raw)` (null when the raw text is not at hand: no break is known); `names` the persons'
 * full names in it (a word of one is never a label word); `spared` the spans the scan leaves out (the
 * matcher's: those names). All spans are sorted offsets of `text`.
 */
export function sharedReading(
  text: string,
  marked: string | null,
  names: Spans,
  spared: Spans,
): SharedReading {
  const { text: s, at } = foldText(text);
  const span = ([a, b]: readonly [number, number]): readonly [number, number] => [
    at[a] ?? 0,
    at[b] ?? 0,
  ];
  const nameSpans = names.map(span);
  // the breaks, in folded offsets
  const brk = new Uint8Array(s.length + 1);
  if (marked !== null) {
    const raw = breakOffsets(text, marked);
    for (let i = 0; i < raw.length; i++) if (raw[i] === 1) brk[at[i] ?? 0] = 1;
  }
  const boundary = (k: number): boolean => brk[k] === 1 || s[k] === "|";
  // one pass: which apostrophes close a quotation opened in their segment, and which segments are
  // written all in capitals
  const closes = new Uint8Array(s.length);
  const caps = new Uint8Array(s.length + 1);
  const segments = new Int32Array(s.length + 1);
  let seg = 0;
  let open = 0;
  let segStart = 0;
  let lower = false;
  let upper = false;
  const flush = (end: number): void => {
    if (upper && !lower) caps.fill(1, segStart, end);
  };
  for (let k = 0; k < s.length; k++) {
    if (boundary(k)) {
      open = 0;
      flush(k);
      segStart = k;
      lower = false;
      upper = false;
      seg++;
    }
    segments[k] = seg;
    const c = s[k] ?? "";
    if (isLower(c)) lower = true;
    else if (isUpper(c)) upper = true;
    if (c !== "'") continue;
    const prevW = isWordChar(s[k - 1]);
    const nextW = isWordChar(s[k + 1]);
    if (!prevW && nextW) open++;
    else if (prevW && !nextW && open > 0) {
      closes[k] = 1;
      open--;
    }
  }
  flush(s.length);
  segments[s.length] = seg;
  /** Whether a break sits in the gap (a, b]. */
  const breakIn = (a: number, b: number): boolean => {
    for (let k = a + 1; k <= b; k++) if (brk[k] === 1) return true;
    return false;
  };
  const inName = (a: number, b: number): boolean => overlaps(nameSpans, a, b);
  /**
   * The word right before offset `from`, lower case, or null when the clause opens there: at the
   * start, after a break or punctuation, after a period (one after CLAUSE_ABBREVIATIONS' "vs" and "v"
   * continues it).
   */
  const wordBefore = (from: number): string | null => {
    let e = from;
    while (e > 0 && s[e - 1] === " ") e--;
    if (e === from || breakIn(e, from)) return null;
    const period = s[e - 1] === ".";
    if (period) e--;
    const b = wordStartBefore(s, e);
    if (b < 0) return null;
    const w = s.slice(b, e).toLowerCase();
    return period && !CLAUSE_ABBREVIATIONS.includes(w) ? null : w;
  };

  const partsBefore = (start: number): LabelPart[] => {
    const read: ReadPart[] = [];
    let pos = start;
    for (let n = 0; n < MAX_LABEL_WORDS; n++) {
      let end = pos;
      while (end > 0 && s[end - 1] === " ") end--;
      if (end === pos || end === 0 || breakIn(end, pos)) break;
      // a possessive on the label's last word ("Browns'", "Cleveland's"); a quotation's closing
      // mark is punctuation
      let possessive = false;
      if (s[end - 1] === "'") {
        if (closes[end - 1] === 1) break;
        possessive = true;
        end--;
      } else if ((s[end - 1] === "s" || s[end - 1] === "S") && s[end - 2] === "'") {
        possessive = true;
        end -= 2;
      }
      const first = wordStartBefore(s, end);
      // a word of another person's name is no label ("Tyrie Cleveland Justin Jefferson")
      if (first < 0 || inName(first, end)) break;
      const capsSegment = caps[first] === 1;
      // a two-word form ending here ("Green Bay", "wide receiver"): the word before, a space between
      let gap = first;
      while (gap > 0 && s[gap - 1] === " ") gap--;
      const before = gap < first && gap > 0 && !breakIn(gap, first) ? wordStartBefore(s, gap) : -1;
      const prev = before >= 0 && !inName(before, gap) ? before : -1;
      const two =
        prev < 0
          ? null
          : labelPart(`${s.slice(prev, gap)} ${s.slice(first, end)}`, possessive, capsSegment);
      if (two !== null) {
        read.push({ part: two, from: prev, possessive, ambiguous: false });
        pos = prev;
        continue;
      }
      const written = s.slice(first, end);
      const one = labelPart(written, possessive, capsSegment);
      if (one === null) break;
      const ambiguous = one.kind === "position" && isAmbiguousLabelWord(written);
      read.push({ part: one, from: first, possessive, ambiguous });
      pos = first;
    }
    // teams alone (no possessive, no position) must open their clause: a word right before them makes
    // them its object or its modifier ("Against the Vikings Justin Jefferson …", "Browns beat Vikings
    // Justin Jefferson …", "Week 9 Vikings Justin Jefferson …")
    const left = read[read.length - 1];
    if (
      left !== undefined &&
      !left.possessive &&
      read.every((x) => x.part.kind === "team") &&
      wordBefore(left.from) !== null
    )
      return [];
    // an ambiguous word right after a blocker word is the ordinary word ("After safety …", "in the
    // corner …"): no label
    if (left?.ambiguous === true && LABEL_BLOCKERS.includes(wordBefore(left.from) ?? "")) return [];
    return read.map((x) => x.part);
  };

  /** Where a possessive ("'s", "'") ends right after offset `end`; `end` itself when none follows. */
  const possessiveEnd = (end: number): number => {
    if (s[end] !== "'") return end;
    return (s[end + 1] === "s" || s[end + 1] === "S") && !isWordChar(s[end + 2])
      ? end + 2
      : end + 1;
  };

  /**
   * The items of a tag that opens at `from`, up to `close` (")" or ":"): words that are each a team
   * or a position, a separator or a space between them. Null when anything else stands in it (a break
   * too), or no item does.
   */
  const tagItems = (from: number, close: string): LabelPart[] | null => {
    const out: LabelPart[] = [];
    let i = from;
    for (let n = 0; n < MAX_LABEL_WORDS; n++) {
      const startGap = i;
      while (s[i] === " ") i++;
      if (breakIn(startGap, i)) return null;
      const end = wordEndAfter(s, i);
      if (end < 0 || inName(i, end)) return null;
      // a two-word form ("Green Bay", "wide receiver"): a space only between the words
      let next = end;
      while (s[next] === " ") next++;
      const after = next > end && !breakIn(end, next) ? wordEndAfter(s, next) : -1;
      const end2 = after >= 0 && !inName(next, after) ? after : -1;
      const pe2 = end2 < 0 ? end2 : possessiveEnd(end2);
      const two =
        end2 < 0 ? null : labelPart(`${s.slice(i, end)} ${s.slice(next, end2)}`, pe2 > end2, false);
      if (two !== null) {
        out.push(two);
        i = pe2;
      } else {
        const pe = possessiveEnd(end);
        const written = s.slice(i, end);
        const one = labelPart(written, pe > end, false);
        // items a hyphen joins with no space ("(CLE-LB)"): each a team or a position
        const pieces = one === null && written.includes("-") ? written.split("-") : [];
        const split = pieces.map((w) => labelPart(w, false, false));
        if (one !== null) out.push(one);
        else if (split.length > 0 && split.every((x) => x !== null)) out.push(...split);
        else return null;
        i = pe;
      }
      let j = i;
      while (s[j] === " ") j++;
      if (breakIn(i, j)) return null;
      if (s[j] === close) return out;
      if (LABEL_SEPARATORS.includes(s[j] ?? "_")) {
        i = j + 1;
        continue;
      }
      if (j > i && isWordChar(s[j])) {
        i = j;
        continue;
      }
      return null;
    }
    return null;
  };

  /** The label parts in parentheses directly after offset `end` ("(CLE - LB)", "(LB, Browns)"). */
  const partsInParentheses = (end: number): LabelPart[] => {
    let i = end;
    while (i < s.length && i - end < 2 && s[i] === " ") i++;
    if (s[i] !== "(" || breakIn(end, i)) return [];
    return tagItems(i + 1, ")") ?? [];
  };

  /** The label parts of the headline's name tag after offset `end`, before its colon. */
  const partsInNameTag = (end: number): LabelPart[] => {
    let i = end;
    while (s[i] === " ") i++;
    if (breakIn(end, i)) return [];
    if (LABEL_SEPARATORS.includes(s[i] ?? "_")) i++;
    else if (i === end) return [];
    return tagItems(i, ":") ?? [];
  };

  let scanned: boolean | null = null;
  const scan = (): boolean => {
    // the folded text with the spared spans (persons' names) blanked
    let blanked = "";
    let from = 0;
    for (const [a, b] of spared.map(span)) {
      if (a < from || b <= a) continue;
      blanked += `${s.slice(from, a)} `;
      from = b;
    }
    return scanText(blanked + s.slice(from));
  };

  return {
    label: (start, end) => {
      const [a, b] = span([start, end]);
      return [...partsBefore(a), ...partsInParentheses(b), ...partsInNameTag(b)];
    },
    segment: (pos) => segments[at[pos] ?? 0] ?? 0,
    namesTeamOrPosition: () => (scanned ??= scan()),
  };
}

// ---------------------------------------------------------------------------------------------------
// The scan.

/** One word as the scan reads it: letters and digits, joined inside by an apostrophe, a period or a hyphen. */
const SCAN_WORD_RE = /[\p{L}\p{N}]+(?:['.-][\p{L}\p{N}]+)*/gu;
/** Letters joined by periods: an initialism ("L.A", "K.C"), read as one word. */
const INITIALISM_RE = /^(?:\p{L}\.)+\p{L}$/u;
/** What may stand between the two words of a form: whitespace, a period before it ("St. Louis"). */
const PAIR_GAP_RE = /^\.?\s+$/u;
/** A lower-case letter followed by a capital: a camel-cased word ("ClevelandBrowns", "CLEvsMIN"). */
const CAMEL_RE = /\p{Ll}\p{Lu}/u;

/**
 * The pieces of a compound read as words: each run of two capitals or more ("CLE", "MIN"), that run
 * less its last capital when a lower-case letter follows it ("KC" of "KCChiefs"), each capital with
 * the lower-case letters after it ("Chiefs", "Bear" of "BearDown"), and each number with them ("12s").
 */
function segmentsOf(piece: string): string[] {
  const out: string[] = [];
  const runs = [...piece.matchAll(/\p{Lu}+|\p{Ll}+|\p{N}+/gu)].map((m) => m[0]);
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k] ?? "";
    const next = runs[k + 1] ?? "";
    const lowerNext = next !== "" && isLower(next.slice(0, 1));
    if (/^\p{N}/u.test(r)) {
      if (lowerNext) out.push(`${r}${next}`);
      continue;
    }
    if (!isUpper(r.slice(0, 1))) continue;
    if (r.length >= 2) out.push(r);
    if (r.length >= 3 && lowerNext) out.push(r.slice(0, -1));
    if (lowerNext) out.push(`${r.slice(-1)}${next}`);
  }
  return out;
}

/**
 * Whether a compound (a handle, a hashtag, a domain, a camel-cased word) holds a team: a segment of it
 * read as a word, or a team word form of four letters or more anywhere in it ("kcchiefs.com"); inside
 * a hashtag, a three-letter abbreviation or word too ("#clevsmin").
 */
function compoundFinds(word: string, hashtag: boolean): boolean {
  const w = word.slice(0, MAX_COMPOUND);
  for (const piece of w.split(/[.-]/u))
    for (const seg of segmentsOf(piece)) if (found(seg)) return true;
  const lower = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (COMPOUND_FORMS.some((f) => lower.includes(f))) return true;
  return hashtag && HASHTAG_FORMS.some((f) => lower.includes(f));
}

/**
 * Whether the scan finds a team or a position in a folded text: each word whole, a compound's segments
 * and the team forms inside it, the parts a hyphen or a period joins (each alone, each two in a row,
 * and glued: "wide-out", "full-back"), and each two words in a row.
 */
function scanText(t: string): boolean {
  let prevEnd = 0;
  let prevLast: string | null = null;
  for (const m of t.matchAll(SCAN_WORD_RE)) {
    const w = m[0];
    const i = m.index;
    const lead = i > 0 ? t[i - 1] : "";
    // a possessive ("Jefferson's", "RAVEN'S") is the word without it
    const base = w.length > 2 && /'[sS]$/u.test(w) ? w.slice(0, -2) : w;
    const initialism = INITIALISM_RE.test(base);
    const whole = initialism ? base.replaceAll(".", "") : base;
    if (found(whole)) return true;
    const hashtag = lead === "#";
    const compound =
      hashtag || lead === "@" || (!initialism && base.includes(".")) || CAMEL_RE.test(base);
    if (compound && compoundFinds(base, hashtag)) return true;
    const parts =
      !initialism && /[.-]/u.test(base) ? base.split(/[.-]/u).filter((p) => p.length > 0) : [whole];
    for (let k = 0; parts.length > 1 && k < parts.length; k++) {
      const p = parts[k] ?? "";
      if (found(p)) return true;
      const q = parts[k - 1];
      if (q !== undefined && (found(`${q}-${p}`) || found(`${q} ${p}`) || found(`${q}${p}`)))
        return true;
    }
    if (parts.length > 2 && found(parts.join(""))) return true;
    // a two-word form across a gap ("Green Bay", "running back", "St. Louis")
    const gap = t.slice(prevEnd, i);
    if (prevLast !== null && PAIR_GAP_RE.test(gap) && found(`${prevLast} ${parts[0] ?? ""}`))
      return true;
    prevEnd = i + w.length;
    prevLast = parts[parts.length - 1] ?? null;
  }
  return false;
}

/** Whether the scan finds a team or a position in a written word or two (read folded). */
export function scanFinds(written: string): boolean {
  return scanText(foldText(written).text);
}

/**
 * The label written next to the name at [start, end) of a sanitised text with no raw text at hand (no
 * break known): every part of it (R8-6 (a)). `names` are the persons' names (sorted spans).
 */
export function labelPartsNextTo(
  text: string,
  start: number,
  end: number,
  names: Spans = [],
): readonly LabelPart[] {
  return sharedReading(text, null, names, names).label(start, end);
}

/** R8-6 (b): whether a sanitised text names any team or any position outside `spared` (sorted spans). */
export function namesTeamOrPosition(text: string, spared: Spans): boolean {
  return sharedReading(text, null, spared, spared).namesTeamOrPosition();
}

/** Whether a written word (sanitised, not yet folded) is a team or a position label form. */
export function isLabelForm(written: string): boolean {
  const w = foldText(written).text;
  return labelTeams(w) !== null || positionLabelIds(w) !== null;
}
