// labels.ts — the reading of a name several universe players hold (a shared name), for the news
// player matcher (ruling R8-6, changelog §R8: the matcher fails closed for a shared name; plan 07 D6;
// plan 02 §6.4 — rules over closed, tested lists, never a model). It reads two things, and nothing else
// about a shared name's holders is read anywhere (R8-6 (c)):
//
//   the LABEL written next to the name (R8-6 (a), `labelPartsNextTo`) — a team or a position directly
//     before it, whitespace only between ("Browns LB Justin Jefferson", "Browns' Justin Jefferson", "LB
//     Justin Jefferson", "Kansas City's Chris Jones"); in parentheses directly after it ("(CLE)", "(CLE -
//     LB)", "(LB, Browns)", "(Browns LB)"); or in the headline's name tag before the colon ("Justin
//     Jefferson, CLE:", "Justin Jefferson LB:", "Justin Jefferson, WR, Minnesota:"). Punctuation other
//     than the possessive breaks adjacency ("…the Vikings, Justin Jefferson…" is no label), and so does
//     any word that is no team and no position ("Vikings star Justin Jefferson" labels no team: "star"
//     stands next to the name). A tag that holds anything else is no label ("(knee)", "(Browns star)");
//   the broad SCAN (R8-6 (b), `namesTeamOrPosition`) — whether the title or the blurb names any team or
//     any position anywhere, the names of persons left out ("Dallas Goedert" names no team): a team in
//     every form and any case (a handle or a hashtag, "@Browns", "#Vikings", "@dallascowboys"; a
//     whole-word abbreviation; a city; a short name; a singular, "a former Raven"), and a position in
//     every written form (positions.ts: hyphenated, abbreviated, singular and plural, the ambiguous
//     tokens "OT", "corner", "safety", "edge" too). The text is read normalised: NFKC, accents stripped,
//     zero-width characters removed, curly apostrophes and dashes folded, the Cyrillic and Greek
//     letters that look like Latin ones and the Latin letters NFKD leaves alone folded (CONFUSABLES),
//     words in any case. An abbreviation whose lower-case
//     form is an ordinary word or a name ("NO", "MIN", "LA", "Mia") counts only in capitals, so an
//     all-caps headline's "NO" counts and "No timetable" does not. The scan only ever takes the
//     residual away, so it errs toward finding: an ambiguous token costs recall, never precision.
//
// The team forms, each list closed and held entry by entry by the tests: teams.ts' nicknames and homes
// (exactly the unique names' own), SHARED_HOMES (the two homes that hold two teams), TEAM_SHORT_NAMES,
// TEAM_ABBREVIATIONS (CAPS_ONLY_ABBREVIATIONS among them counted only in capitals), each in any case; and
// for the scan only, TEAM_SINGULARS, TEAM_CITIES and handles. The label's own marks
// are closed too (POSSESSIVE_MARKS, LABEL_SEPARATORS). A label's team is the universe's: it
// fits only a holder on one of the teams it names (match.ts). Both readings are linear in the item:
// the label reads a bounded window around each name, and the scan reads each word once.
import type { NflTeam } from "../../config/schema.js";
import { positionLabelIds, SCAN_POSITION_ABBREVIATIONS, SCAN_POSITION_KEYS } from "./positions.js";
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
 * The team abbreviations feeds write: nflverse's, ESPN's LAR and WSH, the JAC some feeds use, PFF's
 * ARZ, BLT, CLV and HST, and NY (either New York team).
 */
// prettier-ignore
export const TEAM_ABBREVIATIONS: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  ARI: ["ARI"], ARZ: ["ARI"], ATL: ["ATL"], BAL: ["BAL"], BLT: ["BAL"], BUF: ["BUF"], CAR: ["CAR"],
  CHI: ["CHI"], CIN: ["CIN"], CLE: ["CLE"], CLV: ["CLE"], DAL: ["DAL"], DEN: ["DEN"], DET: ["DET"],
  GB: ["GB"], HOU: ["HOU"], HST: ["HOU"], IND: ["IND"], JAX: ["JAX"], JAC: ["JAX"], KC: ["KC"],
  LA: ["LA"], LAR: ["LA"], LAC: ["LAC"], LV: ["LV"], MIA: ["MIA"], MIN: ["MIN"], NE: ["NE"],
  NO: ["NO"], NYG: ["NYG"], NYJ: ["NYJ"], NY: ["NYG", "NYJ"], PHI: ["PHI"], PIT: ["PIT"],
  SEA: ["SEA"], SF: ["SF"], TB: ["TB"], TEN: ["TEN"], WAS: ["WAS"], WSH: ["WAS"],
});

/** The abbreviations whose lower-case form is an ordinary word or a name: counted only in capitals. */
// prettier-ignore
export const CAPS_ONLY_ABBREVIATIONS: readonly string[] = Object.freeze([
  "ARI", "CAR", "CHI", "DAL", "DEN", "JAC", "LA", "LAC", "MIA", "MIN", "NE", "NO", "PHI", "PIT",
  "SEA", "TEN", "WAS",
]);

/**
 * Singular nicknames ("a former Raven", "ex-Viking"), found by the scan only, never a label. Left out:
 * those that are ordinary words or names (Brown, Bill, Chief, Giant, Jet, Saint, Ram, Colt, Lion,
 * Bear, Pat).
 */
// prettier-ignore
export const TEAM_SINGULARS: Readonly<Record<string, NflTeam>> = Object.freeze({
  Cardinal: "ARI", Falcon: "ATL", Raven: "BAL", Panther: "CAR", Bengal: "CIN", Cowboy: "DAL",
  Bronco: "DEN", Packer: "GB", Texan: "HOU", Jaguar: "JAX", Charger: "LAC", Raider: "LV",
  Dolphin: "MIA", Viking: "MIN", Patriot: "NE", Eagle: "PHI", Steeler: "PIT", Seahawk: "SEA",
  "49er": "SF", Niner: "SF", Buccaneer: "TB", Titan: "TEN", Commander: "WAS",
});

/**
 * The cities a team plays in where its home names a state or a region ("in Nashville"), found by the
 * scan only, never a label.
 */
// prettier-ignore
export const TEAM_CITIES: Readonly<Record<string, readonly NflTeam[]>> = Object.freeze({
  Glendale: ["ARI"], Charlotte: ["CAR"], Foxborough: ["NE"], Foxboro: ["NE"],
  "Orchard Park": ["BUF"], "East Rutherford": ["NYG", "NYJ"], Inglewood: ["LA", "LAC"],
  Nashville: ["TEN"], "Santa Clara": ["SF"], Landover: ["WAS"],
});

/**
 * The letters folded to Latin ones before the scan: the Cyrillic and Greek letters that look like them,
 * and the Latin letters NFKD does not decompose (accents are stripped as combining marks).
 */
// prettier-ignore
export const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  "а": "a", "А": "A", "В": "B", "с": "c", "С": "C", "е": "e", "Е": "E", "Н": "H", "і": "i",
  "І": "I", "ј": "j", "Ј": "J", "К": "K", "к": "k", "М": "M", "о": "o", "О": "O", "р": "p",
  "Р": "P", "ѕ": "s", "Ѕ": "S", "Т": "T", "у": "y", "Х": "X", "х": "x",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "ο": "o", "ι": "i", "κ": "k", "ν": "v",
  "ρ": "p", "υ": "u", "χ": "x",
  "ø": "o", "Ø": "O", "ß": "ss", "đ": "d", "Đ": "D", "ð": "d", "ł": "l", "Ł": "L", "ı": "i",
  "ħ": "h", "þ": "th",
});

/** How a word is keyed: lower case, apostrophes dropped, dashes folded, one space between words. */
function formKey(written: string): string {
  return written
    .toLowerCase()
    .replace(/['\u2019\u02BC`\u00B4]/gu, "")
    .replace(/[\u2010-\u2012\u2013\u2014\u2212]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

const freezeTeams = (teams: readonly NflTeam[]): readonly NflTeam[] => Object.freeze([...teams]);

/** The word forms of a team (any case): nicknames, homes, the two shared homes, short names. */
const TEAM_WORD_FORMS: ReadonlyMap<string, readonly NflTeam[]> = new Map([
  ...Object.entries(TEAM_NICKNAMES).map(([k, t]) => [formKey(k), freezeTeams([t])] as const),
  ...Object.entries(TEAM_HOMES).map(([k, t]) => [formKey(k), freezeTeams([t])] as const),
  ...Object.entries(SHARED_HOMES).map(([k, ts]) => [formKey(k), freezeTeams(ts)] as const),
  ...Object.entries(TEAM_SHORT_NAMES).map(([k, t]) => [formKey(k), freezeTeams([t])] as const),
]);
const ABBREVIATION_TEAMS: ReadonlyMap<string, readonly NflTeam[]> = new Map(
  Object.entries(TEAM_ABBREVIATIONS),
);
const CAPS_ONLY: ReadonlySet<string> = new Set(CAPS_ONLY_ABBREVIATIONS);
/** The scan-only team forms: the singular nicknames and the cities. */
const SCAN_ONLY_TEAM_FORMS: ReadonlySet<string> = new Set(
  [...Object.keys(TEAM_SINGULARS), ...Object.keys(TEAM_CITIES)].map(formKey),
);
/**
 * Every team word form without spaces or hyphens, as a handle writes it ("@dallascowboys"); each has
 * four letters or more, so a handle is searched for no shorter form ("@Jaxon…" names no team).
 */
const HANDLE_FORMS: readonly string[] = [
  ...new Set([...TEAM_WORD_FORMS.keys()].map((k) => k.replace(/[\s-]/gu, ""))),
];

/**
 * The teams a written word or two name as a LABEL or in the scan: a nickname, home or short name in
 * any case, or an abbreviation (in capitals; in any case unless CAPS_ONLY_ABBREVIATIONS lists it);
 * null when it names none. A singular nickname is no label (only the scan reads it).
 */
export function labelTeams(written: string): readonly NflTeam[] | null {
  const word = TEAM_WORD_FORMS.get(formKey(written));
  if (word !== undefined) return word;
  const upper = written.toUpperCase();
  const abbreviation = ABBREVIATION_TEAMS.get(upper);
  if (abbreviation === undefined) return null;
  return written === upper || !CAPS_ONLY.has(upper) ? abbreviation : null;
}

/** One part of a label written next to a name: the teams it may name, or the position ids it names. */
export type LabelPart =
  | { readonly kind: "team"; readonly teams: readonly NflTeam[] }
  | { readonly kind: "position"; readonly ids: ReadonlySet<number> };

/** A word or two as a label part: a team (a possessive allowed), else a position; null for neither. */
function labelPart(written: string, possessive: boolean): LabelPart | null {
  const teams = labelTeams(written);
  if (teams !== null) return { kind: "team", teams };
  if (possessive) return null;
  const ids = positionLabelIds(written);
  return ids === null ? null : { kind: "position", ids };
}

/** At most this many words of a label are read on either side of a name (bounded work). */
const MAX_LABEL_WORDS = 6;
/** The marks of a possessive on a label's team ("Browns'", "Cleveland’s"). */
export const POSSESSIVE_MARKS: readonly string[] = Object.freeze(["'", "’", "ʼ"]);
/** What may stand between the items of a tag (a space too): "(CLE - LB)", "(LB, Browns)", "(QB/RB)". */
export const LABEL_SEPARATORS: readonly string[] = Object.freeze([",", "-", "–", "—", "/"]);
const APOSTROPHES = POSSESSIVE_MARKS.join("");
const SEPARATORS = LABEL_SEPARATORS.join("");
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/u.test(c);
/** Characters that join the parts of one word ("G-Men", "Smith-Njigba", "O'Connell", "L.A"). */
const isJoiner = (c: string | undefined): boolean => c !== undefined && "'’ʼ.-‐‑".includes(c);

/** The start of the word that ends at `end` (exclusive), or -1 when none does. */
function wordStartBefore(text: string, end: number): number {
  let i = end;
  while (i > 0) {
    if (isWordChar(text[i - 1])) i--;
    else if (isJoiner(text[i - 1]) && i < end && isWordChar(text[i]) && isWordChar(text[i - 2]))
      i--;
    else break;
  }
  return i < end ? i : -1;
}

/** The end of the word that starts at `start`, or -1 when none does. */
function wordEndAfter(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (isWordChar(text[i])) i++;
    else if (isJoiner(text[i]) && i > start && isWordChar(text[i - 1]) && isWordChar(text[i + 1]))
      i++;
    else break;
  }
  return i > start ? i : -1;
}

/** Where a possessive ("'s", "'") ends right after offset `end`; `end` itself when none follows. */
function possessiveEnd(text: string, end: number): number {
  if (!APOSTROPHES.includes(text[end] ?? "_")) return end;
  return (text[end + 1] === "s" || text[end + 1] === "S") && !isWordChar(text[end + 2])
    ? end + 2
    : end + 1;
}

/** Sorted, non-overlapping [start, end) spans: the persons' names of an item. */
type Spans = readonly (readonly [number, number])[];

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

/**
 * The label parts written directly before offset `start`: words that are each a team or a position,
 * whitespace only between them and the name, a team's possessive allowed ("Browns' LB", "Kansas City's").
 */
function partsBefore(text: string, start: number, names: Spans): LabelPart[] {
  const out: LabelPart[] = [];
  let at = start;
  for (let n = 0; n < MAX_LABEL_WORDS; n++) {
    let end = at;
    while (end > 0 && isSpace(text[end - 1])) end--;
    if (end === at || end === 0) break;
    // a possessive on the label's last word: "Browns'", "Cleveland's"
    let possessive = false;
    if (APOSTROPHES.includes(text[end - 1] ?? "_")) {
      possessive = true;
      end--;
    } else if (
      (text[end - 1] === "s" || text[end - 1] === "S") &&
      APOSTROPHES.includes(text[end - 2] ?? "_")
    ) {
      possessive = true;
      end -= 2;
    }
    const first = wordStartBefore(text, end);
    // a word of another person's name is no label ("Tyrie Cleveland Justin Jefferson")
    if (first < 0 || overlaps(names, first, end)) break;
    const written = text.slice(first, end);
    // a two-word form ending here ("Green Bay", "running back"): the word before, whitespace between
    let gap = first;
    while (gap > 0 && isSpace(text[gap - 1])) gap--;
    const before = gap < first && gap > 0 ? wordStartBefore(text, gap) : -1;
    const prev = before >= 0 && !overlaps(names, before, gap) ? before : -1;
    const two = prev < 0 ? null : labelPart(`${text.slice(prev, gap)} ${written}`, possessive);
    if (two !== null) {
      out.push(two);
      at = prev;
      continue;
    }
    const one = labelPart(written, possessive);
    if (one === null) break;
    out.push(one);
    at = first;
  }
  return out;
}

/**
 * The items of a tag that opens at `from`, up to `close` (")" or ":"): words that are each a team or
 * a position, a separator (",", a dash, "/") or a space between them. Null when anything else stands
 * in it, or no item does.
 */
function tagItems(text: string, from: number, close: string, names: Spans): LabelPart[] | null {
  const out: LabelPart[] = [];
  let i = from;
  for (let n = 0; n < MAX_LABEL_WORDS; n++) {
    while (isSpace(text[i])) i++;
    const end = wordEndAfter(text, i);
    if (end < 0 || overlaps(names, i, end)) return null;
    // a two-word form ("Green Bay", "running back"): whitespace only between the words
    let next = end;
    while (isSpace(text[next])) next++;
    const after = next > end ? wordEndAfter(text, next) : -1;
    const end2 = after >= 0 && !overlaps(names, next, after) ? after : -1;
    const pe2 = end2 < 0 ? end2 : possessiveEnd(text, end2);
    const two =
      end2 < 0 ? null : labelPart(`${text.slice(i, end)} ${text.slice(next, end2)}`, pe2 > end2);
    if (two !== null) {
      out.push(two);
      i = pe2;
    } else {
      const pe = possessiveEnd(text, end);
      const written = text.slice(i, end);
      const one = labelPart(written, pe > end);
      // items a hyphen joins with no space ("(CLE-LB)"): each a team or a position
      const pieces = one === null && written.includes("-") ? written.split("-") : [];
      const split = pieces.map((w) => labelPart(w, false));
      if (one !== null) out.push(one);
      else if (split.length > 0 && split.every((x) => x !== null)) out.push(...split);
      else return null;
      i = pe;
    }
    let j = i;
    while (isSpace(text[j])) j++;
    if (text[j] === close) return out;
    if (SEPARATORS.includes(text[j] ?? "_")) {
      i = j + 1;
      continue;
    }
    if (j > i && isWordChar(text[j])) {
      i = j;
      continue;
    }
    return null;
  }
  return null;
}

/** The label parts in parentheses directly after offset `end` ("(CLE - LB)", "(LB, Browns)"). */
function partsInParentheses(text: string, end: number, names: Spans): LabelPart[] {
  let i = end;
  while (i < text.length && i - end < 2 && isSpace(text[i])) i++;
  if (text[i] !== "(") return [];
  return tagItems(text, i + 1, ")", names) ?? [];
}

/**
 * The label parts of the headline's name tag after offset `end`, before its colon ("Justin Jefferson,
 * CLE:", "Justin Jefferson LB:", "Justin Jefferson - LB, Cleveland:").
 */
function partsInNameTag(text: string, end: number, names: Spans): LabelPart[] {
  let i = end;
  while (isSpace(text[i])) i++;
  if (SEPARATORS.includes(text[i] ?? "_")) i++;
  else if (i === end) return [];
  return tagItems(text, i, ":", names) ?? [];
}

/**
 * The label written next to the name at [start, end) of the (sanitised) text: every part of it,
 * directly before the name, in parentheses directly after it, or in its name tag before the colon;
 * empty when none is written (R8-6 (a)). `names` are the item's persons' names (sorted spans): a word
 * of one is never a label word.
 */
export function labelPartsNextTo(
  text: string,
  start: number,
  end: number,
  names: Spans = [],
): readonly LabelPart[] {
  return [
    ...partsBefore(text, start, names),
    ...partsInParentheses(text, end, names),
    ...partsInNameTag(text, end, names),
  ];
}

const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");
const CONFUSABLE_MAP: ReadonlyMap<string, string> = new Map(Object.entries(CONFUSABLES));

/**
 * The text as the scan reads it: NFKC, accents stripped, no zero-width marks, lookalike letters,
 * apostrophes and dashes folded.
 */
function scanText(text: string): string {
  return text
    .normalize("NFKC")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/gu, "")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLE_MAP.get(c) ?? c)
    .replace(/[\u2019\u2018\u02BC\u02BB`\u00B4]/gu, "'")
    .replace(/[\u2010-\u2012\u2013\u2014\u2212]/gu, "-");
}

/** One word as the scan reads it: letters and digits, joined inside by an apostrophe, a period or a hyphen. */
const SCAN_WORD_RE = /[\p{L}\p{N}]+(?:['.-][\p{L}\p{N}]+)*/gu;
/** Letters joined by periods: an initialism ("L.A", "P.J"), read as one word. */
const INITIALISM_RE = /^(?:\p{L}\.)+\p{L}$/u;
/** The longest handle read (bounded work). */
const MAX_HANDLE = 40;

/** Every team word form the scan finds, keyed as `formKey` keys it (one or two words; singulars too). */
const SCAN_TEAM_KEYS: ReadonlySet<string> = new Set([
  ...TEAM_WORD_FORMS.keys(),
  ...SCAN_ONLY_TEAM_FORMS,
]);
const CAPS_TEAM_ABBREVIATIONS: ReadonlySet<string> = new Set(Object.keys(TEAM_ABBREVIATIONS));
const ANY_CASE_TEAM_ABBREVIATIONS: ReadonlySet<string> = new Set(
  Object.keys(TEAM_ABBREVIATIONS).filter((a) => !CAPS_ONLY.has(a)),
);

/**
 * Whether the scan finds a team or a position in one word (or two, joined by a space) of the scan's
 * text: every team form (`labelTeams`' and the singulars) and every position form (positions.ts'
 * scan sets) over sets built once, so a word costs a few lookups (the scan's text has its apostrophes
 * and dashes folded already).
 */
function found(w: string): boolean {
  const lower = w.toLowerCase();
  const key = lower.includes("'") ? lower.replaceAll("'", "") : lower;
  if (SCAN_TEAM_KEYS.has(key) || SCAN_POSITION_KEYS.has(key)) return true;
  if (w.includes(" ")) return false;
  const upper = w.toUpperCase();
  if (w === upper) return CAPS_TEAM_ABBREVIATIONS.has(w) || SCAN_POSITION_ABBREVIATIONS.has(w);
  if (ANY_CASE_TEAM_ABBREVIATIONS.has(upper)) return true;
  // a plural abbreviation: capitals, then a lower-case "s" ("QBs", "LBs")
  const stem = w.slice(0, -1);
  return w.endsWith("s") && stem === upper.slice(0, -1) && SCAN_POSITION_ABBREVIATIONS.has(stem);
}

/** Whether the scan finds a team or a position in a written word or two, read as the scan reads it. */
export function scanFinds(written: string): boolean {
  return found(scanText(written).replace(/\s+/gu, " ").trim());
}

/**
 * R8-6 (b): whether the (sanitised) text names any team or any position anywhere, outside `spared`
 * (the persons' names: sorted, non-overlapping [start, end) offsets).
 */
export function namesTeamOrPosition(
  text: string,
  spared: readonly (readonly [number, number])[],
): boolean {
  let blanked = "";
  let at = 0;
  for (const [a, b] of spared) {
    if (a < at || b <= a) continue;
    blanked += `${text.slice(at, a)} `;
    at = b;
  }
  const s = scanText(blanked + text.slice(at));
  let prevEnd = 0;
  let prevLast: string | null = null;
  for (const m of s.matchAll(SCAN_WORD_RE)) {
    const w = m[0];
    const i = m.index;
    // a handle or a hashtag: a team form anywhere in it ("@Browns", "@dallascowboys", "#RavensFlock")
    if (i > 0 && (s[i - 1] === "@" || s[i - 1] === "#")) {
      const h = w
        .slice(0, MAX_HANDLE)
        .toLowerCase()
        .replace(/[^a-z0-9]/gu, "");
      if (HANDLE_FORMS.some((f) => h.includes(f))) return true;
    }
    // a possessive ("Jefferson's", "RAVEN'S") is the word without it
    const base = w.length > 2 && /'[sS]$/u.test(w) ? w.slice(0, -2) : w;
    const joined = base.includes(".") || base.includes("-");
    const initialism = joined && INITIALISM_RE.test(base);
    const whole = initialism ? base.replace(/\./gu, "") : base;
    if (found(whole)) return true;
    // the parts a hyphen or a period joins ("Browns-Bengals", "non-QB", "tight-end", "game.The"),
    // each alone and each two in a row, as written ("d-line-led") and as two words
    const parts = joined && !initialism ? base.split(/[.-]/u).filter((p) => p.length > 0) : [whole];
    for (let k = 0; parts.length > 1 && k < parts.length; k++) {
      const p = parts[k] ?? "";
      if (found(p)) return true;
      const q = parts[k - 1];
      if (q !== undefined && (found(`${q}-${p}`) || found(`${q} ${p}`))) return true;
    }
    // a two-word form across whitespace ("Green Bay", "running back", "tight ends")
    if (prevLast !== null && prevEnd < i && s.slice(prevEnd, i).trim() === "") {
      if (found(`${prevLast} ${parts[0] ?? ""}`)) return true;
    }
    prevEnd = i + w.length;
    prevLast = parts[parts.length - 1] ?? null;
  }
  return false;
}
