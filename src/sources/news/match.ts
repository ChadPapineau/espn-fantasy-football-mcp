// match.ts — the deterministic player matcher of the news sources: which ESPN players an RSS item
// names (tables.ts ds_news_players: `match_method` ∈ NEWS_MATCH_METHODS, `match_confidence` by
// method, `gsis_id` from the crosswalk at load; plan 07 D6 `players_matched`; plan 02 §6.4 — rules,
// never a model; research 04 §C — the ESPN id is the entry point, gsis via the crosswalk).
//
// Names are compared with the crosswalk's own normaliser (`mergeName`: ASCII fold, punctuation and
// apostrophes dropped, so "C.J. Stroud" = "CJ Stroud" and "Smith-Njigba" = "Smith Njigba"'s key),
// as whole-token n-grams that never cross punctuation. Three methods, in confidence order:
//   full_name_team (0.95) — the full name (capitalised) AND its holder's team: for a unique name, his
//                            team named in the item; for a shared name, his team written next to
//                            the name or tied to it by a roster move (R8-3 clause 2);
//   full_name      (0.80) — the full name, unique in the universe, or the one holder of a shared
//                            name the rules below pick;
//   last_name_team (0.60) — a capitalised surname, the only player of that surname on a team the
//                            item names (a unique surname), or the one sharer of a shared surname
//                            that a team or a position written next to it, or a roster move, leaves
//                            (below), not part of someone else's full name.
// "A team the item names" is its subject's team: never a word of a full name the item holds, nor
// that name's surname standing alone ("Dallas Goedert", "Malik Washington … Washington was ruled
// out" name no Cowboys or Commanders — Stage C remediation news-match-player-name-team-word), and
// never a team named only as the opponent ("against the Eagles", "Browns matchup"; teams.ts).
//
// A name only one universe player holds is matched exactly as before ruling R8-3: its team evidence
// is teams.ts' reading (`cue`, `pair`, `attachedTeams`, `movedTeams`), and no position word is read.
//
// Shared names (Stage C remediation news-match-universe-homonyms; ruling R8-3, changelog §R8 and
// §B9). The universe is every players_wl person, so 0 %-owned free agents and defensive players hold
// the names of stars: 16 full-name keys and 302 surnames have more than one holder in the recorded
// universe. Precision comes before recall — a namesake's item put on a star gives E10 a false
// injury or transaction claim, a star's lost item still has ESPN's own status behind it — so the
// holders of a shared name are told apart by evidence only, read with cues.ts (the teams and cue
// words, closed lists) and positions.ts (the position words). A name written several times in one
// item is one person: its evidence is pooled over every mention — each occurrence of the full name,
// and its surname standing alone when no other full name in the item ends with it — and it is
// decided once. The evidence, and what each kind can do:
//   spelling — a generational suffix written after the name ("Michael Carter II", "Byron Murphy
//     Jr.") keeps only the holders ESPN spells with that suffix (when one does);
//   written next to the name — his own label (R8-3 clauses 2 and 4): a team ("Vikings WR Justin
//     Jefferson", "Vikings' No. 1 receiver …", "Justin Jefferson of the Vikings", "Justin Jefferson,
//     CLE:", "(WR, Vikings)", cues.ts `sharedAttachedTeams`; and every name of a list a plural label
//     heads, "Vikings WRs Jordan Addison and Justin Jefferson", `sharedListTeams`) is his team; a
//     position ("LB Justin Jefferson", "Jefferson, a second-year linebacker,", positions.ts
//     `positionPhrasesNextTo`, and the clause a headline topic's colon opens when it names no other
//     player: "Lamar Jackson injury update: Ravens QB dealing …" is his, "…: Steelers cornerback fined
//     for hit on Ravens QB" is not) rules out every holder ESPN lists at another position
//     (ds_players `position_id`; an unknown one is never ruled out; several must all fit). Either is
//     the holder's own evidence;
//   a roster move — the team that signs, waives, claims, promotes, activates or reinstates him or
//     places him on a reserve list, or that his clause says he signs with, is activated, placed on IR
//     or reinstated by, or lands on (cues.ts `sharedMovedTeams`), is his own too (choice 3), never a
//     trade;
//   the cues about him (R8-3 clause 3) — the cue words of a sentence written about him. A result or
//     an against word, a game or "<team> matchup" is about the sentence's subject: the first person
//     it names before the cue (a possessive one with another person after him is that person's), and
//     the names of a list he heads ("Jackson and Derrick Henry", "Jackson, Henry and Flowers"; a bare
//     comma is no list), never a person named later ("Bijan Robinson ran past Justin Jefferson in the
//     win over the Browns"). Another person named between him and a result or an against word
//     anchors the game: it is that person's team's against the cued team, which he plays in on
//     either side ("Jackson found Zay Flowers twice in the win over the Bengals" rules out the free
//     agent; "Unlike Justin Jefferson, Bijan Robinson starred in the win over the Browns" rules out
//     the Vikings WR), unless that person is the cued team's own ("Jackson outdueled Joe Burrow in
//     the win over the Bengals"); a person of no known team leaves the cue no evidence. A play word is
//     his only right after his name ("Jefferson brought down the Vikings' quarterback", "Justin
//     Jefferson: Sacks Vikings QB twice"). A cue or a game before anyone in its sentence is about
//     the first person named after it there ("Bills vs. Ravens: Lamar Jackson limited"), and in a
//     sentence that names no one, about the item's subject, the first person it names (choice 2:
//     "Jackson (ankle) was limited; the Ravens visit the Bengals Sunday."). A team named between him
//     (or the sentence's start) and the cue is the cue's subject, not his ("as Minnesota's offense
//     torched …"). A GAME is his ("Vikings host Browns", "Vikings at Bears"): a holder whose team
//     does not play in it is not he, nor is a free agent; a team named as the other side of his game
//     or play ("in Sunday's win over the Vikings", "Sacks Vikings QB") is not his team, nor is he a
//     free agent (no games, no opponent) — whatever else names that team in the item; "<team>
//     matchup" names his own team's game as often as his opponent's, so it rules out the holder on
//     that team only while it leaves another holder with a team, and a free agent always (choice 4).
//     A team written next to the name or moved to is never ruled out by a cue;
//   describing sentences — "| The linebacker did not practice Wednesday." (positions.ts
//     `describingPhrases`) may describe him or the player he faced ("| The cornerback jumped the
//     route."), and no rule short of parsing tells them apart: one written about him (he is the last
//     person named before it, its sentence names no one after it, and no pronoun gives it to another
//     player) is read only when nothing is written next to his name, and never picks a holder — it
//     keeps a pick it contradicts from being made, and it supports a holder the other evidence left;
//   prominence — a holder owned in at least PROMINENT_OWNED % of ESPN leagues and PROMINENCE_RATIO
//     times as many as each other holder (`prominentOf`), judged before any evidence over every holder
//     the spelling leaves: evidence only removes a prominent holder (it rules him out), never makes
//     one, so writing a holder's own position never costs him a ref (R8-3 clause 4).
// A team named loosely — any other way, a game's teams and teams named in sentences about others
// included — is never evidence FOR a holder (R8-3 clause 2): it only ever rules one out, by the
// cues above. Ruling out only REMOVES: a holder left without evidence of his own takes the name
// only when no holder ruled out outshines him, or a describing sentence about him supports him
// ("Justin Jefferson: Sacks Vikings QB twice" is not the Browns LB's by elimination: no ref).
// Evidence that contradicts every holder gives the name to no one (fail safe: the item is about a
// holder the universe places elsewhere, or about no holder). Then: one holder left takes the name.
// Else the one holder on a team written next to it or moved to takes it — unless the prominent
// holder is another who is not ruled out (choice 6: after a trade of the star to his namesake's
// team, "Cleveland's Justin Jefferson" would be the star). Else a position written next to it that
// fits several holders picks none. Else the prominent holder takes the name at full_name, but only in
// R8-3 clause 6's accepted residual: an item that names no team, no position and no cue ("Justin
// Jefferson: Placed on IR | Jefferson (knee) will miss at least four games."; a letter in an initial
// or a time, "1 P.M.", "P.J. Walker", is no position). An item that names one, and leaves several
// holders, gives the name to no one (clause 5). Whenever no single holder is left, the name takes no
// ref and the item is counted (`matchItem().unresolved`, the news build's warning; plan 07 D6).
//
// A bare surname. One standing alone that a full name in the item ends with is that person
// ("Justin Jefferson: … | Jefferson caught …"): never a last_name_team ref to someone else. A surname
// one universe player holds is matched as before: on a team written next to it, or named in the item
// as its subject's. A surname several players share follows the same rules on its sharers (R8-3
// clauses 2 and 4: "the full-name and bare-surname paths follow the same rule"), pooled over its
// mentions, with the same function: it needs a team or a position written next to it, or a team
// moved to ("Jefferson torches Browns", "Jefferson: Questionable for Vikings" get none, and are
// counted). The one sharer on that team takes it, or, with a position alone, the one sharer the
// position leaves ("LB Jefferson", "Linebacker Jefferson", "QB Jackson"; never a free agent; "DT
// Harris", which six sharers fit, gets none and is counted). A prominent sharer who is not he and is
// not ruled out — by a position, or by the cues about the surname — blocks him, and so does his own
// full name's prominent holder, so the surname never gives what the full name refuses (choice 6:
// "Browns LB Jefferson" and "Cleveland's Jefferson: Sacks Vikings QB twice" are the Browns LB's;
// "Cleveland's Jefferson: Placed on IR", "Eagles' Young" and the post-trade "Browns WR Jefferson" get
// no ref). A position word may stand before a shared surname ("Linebacker Jefferson"), where a
// capitalised word before a unique one is still read as a first name.
// The matcher reads the SANITISED text (plan 02 §6.2), only to decide which ids an item is about; the
// text is never interpreted beyond that, and nothing of it is copied into a ref.
import { GSIS_ID_RE, type NflTeam } from "../../config/schema.js";
import { mergeName, NAME_SUFFIXES } from "../../domain/crosswalk/normalize.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import { sanitizeText } from "../../domain/league/types.js";
import type { NewsMatchMethod } from "../../store/datasets/derive.js";
import {
  sharedAttachedTeams,
  sharedListTeams,
  sharedMentions,
  sharedMovedTeams,
  type SharedMention,
} from "./cues.js";
import {
  describingPhrases,
  KNOWN_POSITION_IDS,
  POSITION_WORDS,
  positionPhrasesNextTo,
  positionWordSpans,
  sentenceBounds,
  sentenceOf,
  type DescribingPhrase,
  type PositionPhrase,
} from "./positions.js";
import { attachedTeams, movedTeams, TEAM_WORDS, teamMentions } from "./teams.js";

/** One player of the ESPN universe the matcher reads (ds_players + the crosswalk's gsis id). */
export interface NewsUniversePlayer {
  readonly espn_id: number;
  readonly full_name: string;
  /** nflverse spelling; null for a free agent. */
  readonly team: NflTeam | null;
  readonly gsis_id: string | null;
  /** ESPN's percent owned (0–100; ds_players `percent_owned`); absent (or null) when unknown. */
  readonly percent_owned?: number | null;
  /** ESPN's position id (ds_players `position_id`, R8-3 clause 4); absent (or null) when unknown. */
  readonly position_id?: number | null;
}

/** A percent owned as the matcher reads it: a finite 0–100, else null (unknown). */
export function percentOwnedOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/** A position id as the universe carries it: ESPN's integer 0–99, else null (unknown). */
export function positionIdOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99 ? v : null;
}

/** One `ds_news_players` ref (item_id is added by the source). */
export interface NewsPlayerRef {
  readonly espn_id: number;
  readonly gsis_id: string | null;
  readonly match_confidence: number;
  readonly match_method: NewsMatchMethod;
}

/** The confidence of each method. */
export const MATCH_CONFIDENCE: Readonly<Record<NewsMatchMethod, number>> = Object.freeze({
  full_name_team: 0.95,
  full_name: 0.8,
  last_name_team: 0.6,
});

/**
 * The universe from the ESPN player dataset (`ds_players`: `espn_id`, `full_name`, `pro_team_id`;
 * 0 = free agent; `percent_owned`; `position_id`) and the crosswalk's `espn_id → gsis_id` lookup —
 * the refresh wiring's one call. Team units (negative ids) and malformed rows are skipped; a later
 * row for the same id wins.
 */
export function universeFromEspnPlayers(
  rows: readonly unknown[],
  gsisOf: (espnId: number) => string | null,
): NewsUniversePlayer[] {
  const out = new Map<number, NewsUniversePlayer>();
  for (const r of rows) {
    if (r === null || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const field = (k: string): unknown =>
      Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
    const id = field("espn_id");
    const name = field("full_name");
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    if (typeof name !== "string" || name.length === 0 || name.length > 128) continue;
    let gsis: string | null = null;
    try {
      const g = gsisOf(id);
      gsis = typeof g === "string" && GSIS_ID_RE.test(g) ? g : null;
    } catch {
      gsis = null;
    }
    const share = percentOwnedOf(field("percent_owned"));
    const position = positionIdOf(field("position_id"));
    out.set(id, {
      espn_id: id,
      full_name: name,
      team: teamOfProTeamId(field("pro_team_id")),
      gsis_id: gsis,
      ...(share === null ? {} : { percent_owned: share }),
      ...(position === null ? {} : { position_id: position }),
    });
  }
  return [...out.values()];
}

/** The `ds_players` statement the wiring reads the universe with (one season, persons only). */
export const UNIVERSE_SQL =
  "SELECT espn_id, full_name, pro_team_id, percent_owned, position_id FROM ds_players WHERE season = :season AND espn_id > 0 ORDER BY espn_id";

/** At most this many refs per item (a roundup naming 30 players is not "about" each of them). */
export const MAX_REFS_PER_ITEM = 10;
/**
 * The least share of ESPN leagues (percent) rostering the prominent holder of a shared full name.
 * The recorded 2026 universe's stars clear it by far (the Ravens QB Lamar Jackson 99.87, the Vikings
 * WR Justin Jefferson 99.86); their homonyms do not (a free-agent CB 0.11, a Browns LB 0.35).
 */
export const PROMINENT_OWNED = 1;
/** How many times as many leagues roster the prominent holder as each other holder. */
export const PROMINENCE_RATIO = 10;
/** The text one match reads (title + blurb at their storage caps fit). */
export const MATCH_TEXT_CAP = 6_000;

/** Capitalised words that may stand before a bare surname ("Ravens QB Jackson", "Sources: …"). */
const LEAD_WORDS: ReadonlySet<string> = new Set([
  "qb",
  "rb",
  "wr",
  "te",
  "k",
  "p",
  "fb",
  "lb",
  "ilb",
  "olb",
  "cb",
  "s",
  "de",
  "dt",
  "edge",
  "ol",
  "ot",
  "og",
  "ls",
  "star",
  "rookie",
  "veteran",
  "receiver",
  "quarterback",
  "kicker",
  "sources",
  "source",
  "report",
  "reports",
  "nfl",
  "afc",
  "nfc",
  "the",
  "and",
  "with",
  "as",
  "at",
  "for",
  "from",
  "of",
  "on",
  "to",
  "in",
  "after",
  "before",
  "but",
  "while",
  "when",
  "why",
  "how",
  "rb1",
  "wr1",
  "qb1",
  "te1",
  "rb2",
  "wr2",
  "backup",
  "starter",
]);

/** The words of the position vocabulary (positions.ts), each word of a two-word one too. */
const POSITION_LEAD_WORDS: ReadonlySet<string> = new Set(
  Object.keys(POSITION_WORDS).flatMap((w) => w.split(" ")),
);

/**
 * Coaching-staff words: a capitalised surname directly after one ("Bengals coach Corbin", "Coach
 * Corbin", "OC Corbin") names a staff member, not a player, so it is not a `last_name_team` mention —
 * head coaches and coordinators are not in the player universe (negative team-unit ids are skipped),
 * and E10 would otherwise read the coach's statement as a claim about the universe player who shares
 * the surname (Stage C remediation news-match-coach-surname). "coach" used to sit in LEAD_WORDS,
 * which licensed exactly this false match; the capitalised abbreviations already failed the lead
 * check, but the lower-case "coach" of "Bengals coach Corbin" slipped past the capitalised-prev
 * guard. These never overlap a player-position lead word (qb, rb, s, p…).
 */
const STAFF_WORDS: ReadonlySet<string> = new Set([
  "coach",
  "coaches",
  "hc",
  "oc",
  "dc",
  "stc",
  "coordinator",
  "coordinators",
]);

interface Token {
  readonly norm: string;
  readonly capital: boolean;
  /** Whether punctuation (anything but whitespace) separates this token from the previous one. */
  readonly breakBefore: boolean;
  /** The chunk's offsets in the text: [start, end). */
  readonly start: number;
  readonly end: number;
}

const CHUNK_RE = /[\p{L}\p{N}'’ʼ.-]+/gu;

/** The sanitised text's word tokens, each normalised with the crosswalk's `mergeName`. */
/** Distinct words a matcher remembers the normalised form of (the cache is cleared beyond it). */
const NORM_CACHE_MAX = 100_000;

function tokenize(text: string, cache: Map<string, string | null>): (Token | null)[] {
  const out: (Token | null)[] = [];
  let lastEnd = 0;
  for (const m of text.matchAll(CHUNK_RE)) {
    const gap = text.slice(lastEnd, m.index);
    lastEnd = m.index + m[0].length;
    const chunk = m[0]
      .replace(/^[.'’ʼ-]+/u, "")
      .replace(/(?:['’ʼ]s|['’ʼ])$/u, "")
      .replace(/[.-]+$/u, "");
    let norm = cache.get(chunk);
    if (norm === undefined) {
      norm = chunk === "" ? null : mergeName(chunk);
      if (cache.size >= NORM_CACHE_MAX) cache.clear();
      cache.set(chunk, norm);
    }
    out.push(
      norm === null || norm.includes(" ")
        ? null
        : {
            norm,
            capital: /^\p{Lu}/u.test(chunk),
            breakBefore: /\S/u.test(gap) || out.length === 0,
            start: m.index,
            end: lastEnd,
          },
    );
  }
  return out;
}

/** A universe player as the matcher holds him: the generational suffix ESPN spells him with. */
interface Held extends NewsUniversePlayer {
  /** His full name's key (`mergeName`): the holders of one key share his full name. */
  readonly key: string;
  /** "jr", "ii" … when his ESPN name ends with one (mergeName folds it away), else null. */
  readonly suffix: string | null;
  /** His ESPN position id when a position word can name it (positions.ts), else null (unknown). */
  readonly position_id: number | null;
}

interface Entry {
  readonly key: readonly string[];
  readonly players: readonly Held[];
}

/** One occurrence of a full name in an item. */
interface Occurrence {
  readonly at: number;
  readonly entry: Entry;
  /** Offsets of the name in the text, its written suffix included: [start, end). */
  readonly start: number;
  readonly end: number;
  /** The generational suffix written right after the name, or null. */
  readonly suffix: string | null;
}

const owned = (p: NewsUniversePlayer): number => p.percent_owned ?? 0;

/** Whether `a` is rostered so much more widely than `b` that an item may be about `a` instead. */
const outshines = (a: NewsUniversePlayer, b: NewsUniversePlayer): boolean =>
  owned(a) >= PROMINENT_OWNED && owned(a) >= PROMINENCE_RATIO * owned(b);

/** The generational suffix a name is spelled with ("Michael Carter II" → "ii"), or null. */
function suffixOf(fullName: string): string | null {
  const words = fullName.trim().split(/\s+/u);
  if (words.length <= 2) return null;
  const last = mergeName(words[words.length - 1]);
  return last !== null && NAME_SUFFIXES.includes(last) ? last : null;
}

/**
 * The holder of a shared name ESPN leagues roster far more than every other one (at least
 * PROMINENT_OWNED %, and PROMINENCE_RATIO times each other holder's share; an unknown share is 0),
 * or null when none does.
 */
function prominentOf<P extends NewsUniversePlayer>(holders: readonly P[]): P | null {
  const ranked = [...holders].sort((a, b) => owned(b) - owned(a));
  const top = ranked[0];
  if (top === undefined || owned(top) < PROMINENT_OWNED) return null;
  return ranked.slice(1).every((p) => outshines(top, p)) ? top : null;
}

/** The intersection of position-id sets (each written phrase's), or null when none was written. */
function allowedPositions(sets: readonly ReadonlySet<number>[]): ReadonlySet<number> | null {
  const [first, ...rest] = sets;
  if (first === undefined) return null;
  return new Set([...first].filter((id) => rest.every((s) => s.has(id))));
}

/** Whether a holder's position fits the written ones (an unknown position always does). */
const fitsPosition = (positions: ReadonlySet<number> | null, p: Held): boolean =>
  positions === null || p.position_id === null || positions.has(p.position_id);

/** Whether a holder's position is one the written ones name: evidence of his own. */
const placedBy = (positions: ReadonlySet<number> | null, p: Held): boolean =>
  positions !== null && p.position_id !== null && positions.has(p.position_id);

/** What the cues of the sentences written about one shared name say of his team (the header). */
interface NameCues {
  /** The teams of the games he plays in ("Bills vs. Ravens", "Vikings host Browns"). */
  readonly games: ReadonlySet<NflTeam>;
  /** The teams named as the other side of his game or play ("in a win over the Vikings"). */
  readonly strong: ReadonlySet<NflTeam>;
  /** "<team> matchup": his own team's game as often as his opponent's. */
  readonly weak: ReadonlySet<NflTeam>;
}

/** A describing sentence written about a shared name: its positions and the team it names. */
interface Described {
  readonly ids: ReadonlySet<number>;
  readonly team: NflTeam | null;
}

/** The evidence about one shared name (full name or surname), pooled over its mentions. */
interface SharedEvidence {
  /** The generational suffixes written after it. */
  readonly suffixes: ReadonlySet<string>;
  /** Teams written next to it (his own). */
  readonly written: ReadonlySet<NflTeam>;
  /** Teams a roster move ties to it. */
  readonly moved: ReadonlySet<NflTeam>;
  /** The ESPN position ids every position written next to it allows; null: none written. */
  readonly positions: ReadonlySet<number> | null;
  /** The describing sentences written about it (only when nothing is written next to it). */
  readonly described: readonly Described[];
  readonly cues: NameCues;
  /** R8-3 clause 6: the item names no team, no position and no cue for it. */
  readonly residual: boolean;
}

/**
 * Which holder of a name several universe players share the item means, or null (the header's
 * rules): spelling, a position written next to it, the cues about it, a team written next to it or
 * moved to, then prominence — in the residual only. `surname`: a shared surname's sharers, who take
 * it only on a team written next to it or moved to, or by a position written next to it alone.
 */
function sharedHolder(holders: readonly Held[], ev: SharedEvidence, surname: boolean): Held | null {
  let cands: Held[] = [...holders];
  if (!surname && ev.suffixes.size > 0) {
    const spelled = cands.filter((p) => p.suffix !== null && ev.suffixes.has(p.suffix));
    if (spelled.length > 0) cands = spelled;
  }
  // who is prominent is judged before any evidence, over every holder the spelling leaves, so the
  // evidence only removes a blocker (it rules him out), never makes one: writing a holder's own
  // position never costs him a ref the item gives without it (R8-3 clause 4)
  const spelled = [...cands];
  const top = prominentOf(spelled);
  /** Whether a holder not ruled out outshines `p` as the prominent one of `among` (choice 6). */
  const outshone = (among: readonly Held[], p: Held): boolean => {
    const x = among === spelled ? top : prominentOf(among);
    return x !== null && x !== p && cands.includes(x);
  };
  const ruledOut: Held[] = [];
  const keep = (pred: (p: Held) => boolean): void => {
    for (const p of cands) if (!pred(p)) ruledOut.push(p);
    cands = cands.filter(pred);
  };
  const tied = (p: Held): boolean =>
    p.team !== null && (ev.written.has(p.team) || ev.moved.has(p.team));
  /** Evidence of his own that no describing sentence outweighs: his team written, his position. */
  const labelled = (p: Held): boolean =>
    (p.team !== null && ev.written.has(p.team)) || placedBy(ev.positions, p);
  const contradicts = (d: Described, p: Held): boolean =>
    (p.position_id !== null && !d.ids.has(p.position_id)) ||
    (d.team !== null && p.team !== null && d.team !== p.team);
  const fits = (d: Described, p: Held): boolean =>
    p.position_id !== null && d.ids.has(p.position_id) && (d.team === null || d.team === p.team);
  const blocked = (p: Held): boolean => ev.described.some((d) => contradicts(d, p));
  const supported = (p: Held): boolean =>
    ev.described.length > 0 && ev.described.every((d) => fits(d, p));
  // a position written next to the name
  keep((p) => fitsPosition(ev.positions, p));
  // the cues about it: a game is his (a free agent plays none); a team named as the other side of
  // his game or play is not his (nor is he a free agent); "<team> matchup" is weak
  const { games, strong, weak } = ev.cues;
  if (games.size > 0) keep((p) => tied(p) || (p.team !== null && games.has(p.team)));
  if (strong.size > 0) keep((p) => tied(p) || (p.team !== null && !strong.has(p.team)));
  if (weak.size > 0) {
    keep((p) => tied(p) || p.team !== null);
    const kept = cands.filter((p) => tied(p) || p.team === null || !weak.has(p.team));
    if (kept.length > 0) keep((p) => kept.includes(p));
  }
  if (surname) {
    // the one sharer on a team written next to it or moved to; with neither, the one sharer a
    // position written next to it leaves and places (never a free agent) — unless a prominent sharer
    // who is not ruled out is another, or his own full name's prominent holder is (the full-name
    // path's rule, so the surname never gives what the full name refuses: "Eagles' Young")
    let only: Held | undefined;
    if (ev.written.size > 0 || ev.moved.size > 0) {
      const on = cands.filter(tied);
      only = on.length === 1 ? on[0] : undefined;
    } else {
      const [one, ...more] = cands;
      only =
        one !== undefined && more.length === 0 && one.team !== null && placedBy(ev.positions, one)
          ? one
          : undefined;
    }
    if (only === undefined) return null;
    const him = only;
    if (
      outshone(spelled, him) ||
      outshone(
        spelled.filter((p) => p.key === him.key),
        him,
      )
    )
      return null;
    return !labelled(him) && blocked(him) ? null : him;
  }
  if ((ev.written.size > 0 || ev.moved.size > 0) && !cands.some(tied)) {
    // a team written next to the name or moved to that is no candidate's: he is none of the
    // candidates on another team — at most a free agent since signed
    keep((p) => p.team === null);
  }
  const only = cands.length === 1 ? cands[0] : undefined;
  if (cands.length === 0) return null;
  if (only !== undefined) {
    if (labelled(only)) return only;
    if (blocked(only)) return null;
    if (tied(only)) return only;
    // left by elimination: past no ruled-out holder who outshines him, unless a describing
    // sentence about him supports him
    return !ruledOut.some((x) => outshines(x, only)) || supported(only) ? only : null;
  }
  const att = cands.filter(tied);
  if (att.length > 0) {
    const one = att.length === 1 ? att[0] : undefined;
    if (one === undefined || outshone(spelled, one)) return null;
    return !labelled(one) && blocked(one) ? null : one;
  }
  // a written position several holders fit tells none of them apart (R8-3 clause 5)
  if (ev.positions !== null) return null;
  // prominence decides only in R8-3 clause 6's residual
  return ev.residual && top !== null && cands.includes(top) ? top : null;
}

/** What one item's match found (ruling R8-3 clause 5: a shared name left to no one is counted). */
export interface NewsItemMatch {
  /** The refs, best first, at most MAX_REFS_PER_ITEM. */
  readonly refs: NewsPlayerRef[];
  /**
   * How many names several universe players share the item holds that the evidence left to no
   * single holder (a full name; a shared surname in an item that names a team): no ref for them.
   */
  readonly unresolved: number;
}

/** A matcher over one universe (built once per refresh). */
export interface PlayerMatcher {
  /** The refs of a text (sanitised here first), best first, at most MAX_REFS_PER_ITEM. */
  match(text: string): NewsPlayerRef[];
  /** The refs of a text and how many of its shared names were left to no one (R8-3 clause 5). */
  matchItem(text: string): NewsItemMatch;
  /** How many universe players are matchable (a valid id and a ≥ 2-token name). */
  readonly size: number;
}

/** A person named in an item: a full name, or a capitalised universe surname standing alone. */
interface PersonSpan {
  readonly start: number;
  readonly end: number;
  /** The full name's key, or null for a surname standing alone. */
  readonly key: string | null;
  /** The surname (a full name's last word). */
  readonly norm: string;
  /** Written in the possessive ("Jefferson's"). */
  readonly possessive: boolean;
}

/** A name written in the possessive ("Jefferson's", "Jones'"). */
const POSSESSIVE_END_RE = /['’ʼ]s?$/u;
/** The words that may stand between a name and the play word written about him (closed). */
// prettier-ignore
export const PLAY_GAP_WORDS: readonly string[] = Object.freeze([
  "has", "had", "have", "was", "were", "is", "also", "again", "then", "later", "nearly", "almost",
  "just", "once", "twice", "both",
]);
/** Between a name and the play word written about him: nothing, the headline's colon, a little. */
const PLAY_GAP_RE = new RegExp(
  `^(?:\\s*\\([^()]{0,40}\\))?(?:\\s*:\\s*|\\s+)(?:(?:${PLAY_GAP_WORDS.join("|")})\\s+){0,2}$`,
  "iu",
);
/**
 * Between two names of a list or a compound subject: "," or "and" alone ("Jackson and Derrick
 * Henry", "Jordan Addison, Jalen Nailor and Justin Jefferson").
 */
const JOIN_RE = /^(?:\s*,\s*(?:(?:and|&)\s+)?|\s+(?:and|&)\s+)$/iu;

/** What the shared-name reading of one item needs, built once, when a shared name asks for it. */
interface SharedItem {
  readonly mentions: readonly SharedMention[];
  /** Whether a pair's other mention is kept (a mention read as a name's word is no team). */
  readonly kept: ReadonlySet<number>;
  readonly persons: readonly PersonSpan[];
  /** The persons' starts, in order (a binary search finds a sentence's persons). */
  readonly personStarts: readonly number[];
  /** The starts of the mentions that may be what follows them's subject: no cue, no game. */
  readonly actorStarts: readonly number[];
  /** The sentence breaks, the describing sentences and the position words (each read once). */
  bounds(): readonly number[];
  phrases(): readonly DescribingPhrase[];
  words(): readonly PositionPhrase[];
}

/** The index of the first value of the sorted `xs` at or above `v`. */
function lowerBound(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A value computed once, on first use. */
function once<T>(f: () => T): () => T {
  let v: { readonly value: T } | null = null;
  return () => (v ??= { value: f() }).value;
}

/** Builds the matcher (invalid universe rows — no positive id, no two-token name — are skipped). */
export function buildPlayerMatcher(universe: readonly NewsUniversePlayer[]): PlayerMatcher {
  const byKey = new Map<string, Held[]>();
  const bySurname = new Map<string, Held[]>();
  let size = 0;
  for (const p of universe) {
    if (!Number.isSafeInteger(p.espn_id) || p.espn_id <= 0) continue;
    const merged = mergeName(p.full_name);
    if (merged === null) continue;
    const tokens = merged.split(" ");
    if (tokens.length < 2) continue;
    const position = positionIdOf(p.position_id);
    const player: Held = {
      espn_id: p.espn_id,
      full_name: p.full_name,
      team: p.team,
      gsis_id: p.gsis_id !== null && GSIS_ID_RE.test(p.gsis_id) ? p.gsis_id : null,
      percent_owned: percentOwnedOf(p.percent_owned),
      key: merged,
      suffix: suffixOf(p.full_name),
      position_id: position !== null && KNOWN_POSITION_IDS.has(position) ? position : null,
    };
    size++;
    const list = byKey.get(merged) ?? [];
    if (!list.some((x) => x.espn_id === player.espn_id)) list.push(player);
    byKey.set(merged, list);
    const last = tokens[tokens.length - 1] ?? "";
    const sl = bySurname.get(last) ?? [];
    if (!sl.some((x) => x.espn_id === player.espn_id)) sl.push(player);
    bySurname.set(last, sl);
  }
  const byFirst = new Map<string, Entry[]>();
  for (const [key, players] of byKey) {
    const tokens = key.split(" ");
    const first = tokens[0] ?? "";
    const list = byFirst.get(first) ?? [];
    list.push({ key: tokens, players });
    byFirst.set(first, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.key.length - a.key.length);

  const normCache = new Map<string, string | null>();
  const matchItem = (raw: string): NewsItemMatch => {
    const text = sanitizeText(raw, MATCH_TEXT_CAP).value;
    const tokens = tokenize(text, normCache);
    const consumed = new Array<boolean>(tokens.length).fill(false);
    const found = new Map<number, NewsPlayerRef & { at: number }>();
    let unresolved = 0;
    const add = (p: NewsUniversePlayer, method: NewsMatchMethod, at: number): void => {
      const conf = MATCH_CONFIDENCE[method];
      const prev = found.get(p.espn_id);
      if (prev !== undefined && prev.match_confidence >= conf) return;
      found.set(p.espn_id, {
        espn_id: p.espn_id,
        gsis_id: p.gsis_id,
        match_confidence: conf,
        match_method: method,
        at: prev?.at ?? at,
      });
    };
    // 1. the full names the text holds (each a person's name, whoever it turns out to be), with
    // the generational suffix written right after one ("Michael Carter II")
    const names: Occurrence[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      // a name in running text is capitalised: "jordan love" in lower case is not a mention
      if (t?.capital !== true) continue;
      const entries = byFirst.get(t.norm);
      if (entries === undefined) continue;
      for (const e of entries) {
        let ok = i + e.key.length <= tokens.length;
        for (let k = 0; ok && k < e.key.length; k++) {
          const tk = tokens[i + k];
          ok =
            tk !== null && tk !== undefined && tk.norm === e.key[k] && (k === 0 || !tk.breakBefore);
        }
        if (!ok) continue;
        const last = i + e.key.length - 1;
        const after = tokens[last + 1];
        const suffix =
          after !== null && after !== undefined && !after.breakBefore
            ? (NAME_SUFFIXES.find((s) => s === after.norm) ?? null)
            : null;
        const endTok = suffix === null ? tokens[last] : after;
        for (let k = 0; k < e.key.length; k++) consumed[i + k] = true;
        if (suffix !== null) consumed[last + 1] = true;
        names.push({ at: i, entry: e, start: t.start, end: endTok?.end ?? t.end, suffix });
        i = suffix === null ? last : last + 1;
        break;
      }
    }

    // 2. the teams the item names as its subject's: a word of a name it holds, or that name's
    // surname alone, is the person; a team named only as the opponent is not the subject's
    const surnames = new Set(names.map(({ entry }) => entry.key[entry.key.length - 1] ?? ""));
    /** `mergeName` of a team's words, remembered (an item repeats its teams; bounded work). */
    const normOf = (w: string): string | null => {
      let v = normCache.get(w);
      if (v === undefined) {
        v = w === "" ? null : mergeName(w);
        if (normCache.size >= NORM_CACHE_MAX) normCache.clear();
        normCache.set(w, v);
      }
      return v;
    };
    const notAName = (m: { readonly start: number; readonly end: number }): boolean =>
      !names.some((s) => m.start < s.end && s.start < m.end) &&
      !surnames.has(normOf(text.slice(m.start, m.end)) ?? "");
    // the unique-name reading (as before R8-3)
    const mentions = teamMentions(text).filter(notAName);
    const subject = new Set(mentions.filter((m) => !m.opponent).map((m) => m.team));
    const onTeam = (p: NewsUniversePlayer): boolean => p.team !== null && subject.has(p.team);
    const named = new Set(mentions.map((m) => m.team));

    // the shared-name reading (cues.ts, positions.ts), built once when a shared name needs it
    let item: SharedItem | null = null;
    const sharedItem = (): SharedItem => {
      if (item !== null) return item;
      const kept = sharedMentions(text).filter(notAName);
      const persons: PersonSpan[] = names.map((n) => ({
        start: n.start,
        end: n.end,
        key: n.entry.key.join(" "),
        norm: n.entry.key[n.entry.key.length - 1] ?? "",
        possessive: POSSESSIVE_END_RE.test(text.slice(n.start, n.end)),
      }));
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === null || t === undefined || !t.capital || consumed[i] === true) continue;
        if (TEAM_WORDS.has(t.norm) || !bySurname.has(t.norm)) continue;
        persons.push({
          start: t.start,
          end: t.end,
          key: null,
          norm: t.norm,
          possessive: POSSESSIVE_END_RE.test(text.slice(t.start, t.end)),
        });
      }
      persons.sort((a, b) => a.start - b.start);
      item = {
        mentions: kept,
        kept: new Set(kept.map((m) => m.start)),
        persons,
        personStarts: persons.map((p) => p.start),
        actorStarts: kept
          .filter((m) => m.cue === null && !m.weak && m.pair === null)
          .map((m) => m.start),
        bounds: once(() => sentenceBounds(text)),
        phrases: once(() => describingPhrases(text)),
        words: once(() => positionWordSpans(text)),
      };
      return item;
    };
    /**
     * Whether a team is named in [a, b) that is the subject of what follows it ("as Minnesota's
     * offense …"): not his own label ("Justin Jefferson, Browns: Records sack vs. Vikings"), not named
     * by a cue or a game itself ("Out vs. Bills, vs. Dolphins").
     */
    const actorBetween = (
      s: SharedItem,
      a: number,
      b: number,
      labels: ReadonlySet<number>,
    ): boolean => {
      for (let i = lowerBound(s.actorStarts, a); i < s.actorStarts.length; i++) {
        const at = s.actorStarts[i] ?? b;
        if (at >= b) return false;
        if (!labels.has(at)) return true;
      }
      return false;
    };
    /**
     * The list the person at index `i` of the item's persons is a name of, [lo, hi): names joined by
     * "," or "and" alone — a list only when one join is an "and" ("A, B and C"; "Unlike A, B starred"
     * is no list) — up to the last name an "and" joins; [i, i + 1) when he is in none.
     */
    const listAround = (s: SharedItem, i: number): readonly [number, number] => {
      const ps = s.persons;
      /** The join between the persons k - 1 and k: "and", "," alone, or none. */
      const join = (k: number): "and" | "comma" | null => {
        const a = ps[k - 1];
        const b = ps[k];
        if (a === undefined || b === undefined) return null;
        const gap = text.slice(a.end, b.start);
        if (!JOIN_RE.test(gap)) return null;
        return /(?:and|&)/iu.test(gap) ? "and" : "comma";
      };
      let lo = i;
      while (lo > 0 && join(lo) !== null) lo--;
      let hi = i + 1;
      while (hi < ps.length && join(hi) !== null) hi++;
      let last = -1;
      for (let k = lo + 1; k < hi; k++) if (join(k) === "and") last = k;
      return last < 0 || i > last ? [i, i + 1] : [lo, last + 1];
    };
    /**
     * Whether a cue or a game at `anchor` (its word at `cueStart`) is written about `isHim`: null when
     * it is not, else the other persons its sentence names between his subject group and the cue.
     */
    const about = (
      s: SharedItem,
      anchor: number,
      cueStart: number,
      play: boolean,
      isHim: (p: PersonSpan) => boolean,
      labels: ReadonlySet<number>,
    ): readonly PersonSpan[] | null => {
      const [from, to] = sentenceOf(s.bounds(), anchor, text.length);
      const ps = s.persons;
      // ps[first .. upto) are the persons named before it in its sentence
      const first = lowerBound(s.personStarts, from);
      let upto = first;
      while (upto < ps.length && (ps[upto]?.end ?? Infinity) <= anchor) upto++;
      if (play) {
        // a play word is his only right after his name ("Jefferson brought down …")
        const last = upto > first ? ps[upto - 1] : undefined;
        if (last === undefined || !isHim(last) || actorBetween(s, last.end, anchor, labels))
          return null;
        return !last.possessive && PLAY_GAP_RE.test(text.slice(last.end, cueStart)) ? [] : null;
      }
      let him: PersonSpan | undefined;
      let gapFrom = from;
      let others: readonly PersonSpan[] = [];
      if (upto > first) {
        // the sentence's subject: its first person, and those joined to him by "," or "and" alone
        // ("Jackson and Derrick Henry ran wild in the win over the Bengals"); never a person named
        // later in it ("Robinson ran past Justin Jefferson in the win over the Browns"). A possessive
        // one with another person after him is that person's ("Jefferson's former teammate Kirk
        // Cousins threw two TDs in the win …")
        let lead = first;
        while (lead + 1 < upto && ps[lead]?.possessive === true) lead++;
        const [, hi] = listAround(s, lead);
        const end = Math.min(hi, upto);
        for (let k = lead; k < end; k++) {
          const p = ps[k];
          if (p !== undefined && isHim(p)) {
            him = p;
            gapFrom = p.end;
            break;
          }
        }
        others = ps.slice(end, upto);
      } else {
        // before anyone in its sentence: the first person named after it there ("Bills vs. Ravens:
        // Lamar Jackson limited"); in a sentence that names no one, the item's subject, the first
        // person it names (choice 2: "Jackson (ankle) was limited; the Ravens visit the Bengals")
        const next = ps[upto];
        const subject = next !== undefined && next.start < to ? next : ps[0];
        if (subject !== undefined && isHim(subject)) him = subject;
      }
      // a team named between him (or the sentence's start) and the cue is the cue's subject
      return him === undefined || actorBetween(s, gapFrom, anchor, labels) ? null : others;
    };
    /** The team of a person a name only one universe player holds (on a team); else undefined. */
    const teamOfPerson = (p: PersonSpan): NflTeam | undefined => {
      const holders = p.key === null ? bySurname.get(p.norm) : byKey.get(p.key);
      const only = holders?.length === 1 ? holders[0] : undefined;
      return only?.team ?? undefined;
    };
    const cuesAbout = (
      s: SharedItem,
      isHim: (p: PersonSpan) => boolean,
      labels: ReadonlySet<number>,
    ): NameCues => {
      const games = new Set<NflTeam>();
      const strong = new Set<NflTeam>();
      const weak = new Set<NflTeam>();
      for (const m of s.mentions) {
        if (m.pair !== null && s.kept.has(m.pair.start)) {
          const anchor = Math.min(m.start, m.pair.start);
          if (about(s, anchor, anchor, false, isHim, labels) !== null) games.add(m.team);
        } else if (m.cue !== null) {
          const play = m.cue.kind === "play" || m.cue.kind === "passive";
          const others = about(s, m.cue.start, m.cue.start, play, isHim, labels);
          if (others === null) continue;
          // another person named between him and the cue anchors the game: it is that person's
          // team's against the cued team, and he plays in it on either side ("Jackson found Zay
          // Flowers twice in the win over the Bengals"; "Unlike Justin Jefferson, Bijan Robinson
          // starred in the win over the Browns" may be the Browns LB's) — unless every such person is
          // the cued team's own; a person of no known team leaves the cue no evidence about him
          const sides = new Set<NflTeam>();
          let unknown = false;
          for (const o of others) {
            const t = teamOfPerson(o);
            if (t === undefined) unknown = true;
            else if (t !== m.team) sides.add(t);
          }
          if (unknown || sides.size > 1) continue;
          if (sides.size === 0) strong.add(m.team);
          else for (const t of [m.team, ...sides]) games.add(t);
        } else if (m.weak && about(s, m.start, m.start, false, isHim, labels) !== null)
          weak.add(m.team);
      }
      return { games, strong, weak };
    };
    /** A describing sentence plainly about another player: a pronoun, or a person named after it. */
    const others = (s: SharedItem, d: DescribingPhrase): boolean =>
      d.other || s.persons.some((p) => p.start >= d.end && p.start < d.sentenceEnd);
    const describedAbout = (
      s: SharedItem,
      isHim: (p: PersonSpan) => boolean,
    ): readonly Described[] =>
      s
        .phrases()
        .filter((d) => {
          if (others(s, d)) return false;
          let last: PersonSpan | undefined;
          for (const p of s.persons) if (p.end <= d.at) last = p;
          return last !== undefined && isHim(last);
        })
        .map((d) => ({ ids: d.ids, team: d.team }));
    /**
     * R8-3 clause 6: the item names no team, and no position word that may be about him — a
     * position labelling another person, a describing sentence plainly another player's, or a letter
     * inside a name ("P.J. Walker"), is not.
     */
    const residualFor = (s: SharedItem, isHim: (p: PersonSpan) => boolean): boolean => {
      if (s.mentions.length > 0 || named.size > 0) return false;
      const spared: (readonly [number, number])[] = [];
      for (const p of s.persons) {
        spared.push([p.start, p.end]);
        if (!isHim(p))
          for (const ph of positionPhrasesNextTo(text, p.start, p.end))
            spared.push([ph.start, ph.end]);
      }
      for (const d of s.phrases()) if (others(s, d)) spared.push([d.start, d.end]);
      return !s.words().some((w) => !spared.some(([a, b]) => w.start >= a && w.end <= b));
    };
    /**
     * The start of the list a name at `a` ends, when it is a list's later name ("Jordan Addison and
     * Justin Jefferson": the names joined by "," or "and" alone), else null.
     */
    const listHead = (s: SharedItem, a: number): number | null => {
      const i = lowerBound(s.personStarts, a);
      if (s.persons[i]?.start !== a) return null;
      const [lo] = listAround(s, i);
      return lo < i ? (s.persons[lo]?.start ?? null) : null;
    };
    const pool = (
      s: SharedItem,
      spans: readonly (readonly [number, number])[],
    ): {
      written: Set<NflTeam>;
      moved: Set<NflTeam>;
      positions: ReadonlySet<number> | null;
      labels: Set<number>;
    } => {
      const written = new Set<NflTeam>();
      const moved = new Set<NflTeam>();
      const labels = new Set<number>();
      const sets: ReadonlySet<number>[] = [];
      for (const [a, b] of spans) {
        // his team written next to him, or before the list he is a later name of ("Vikings WRs
        // Jordan Addison and Justin Jefferson")
        const head = listHead(s, a);
        for (const m of s.mentions)
          if (
            sharedAttachedTeams(text, [m], a, b).size > 0 ||
            (head !== null && sharedListTeams(text, [m], head).size > 0)
          ) {
            written.add(m.team);
            labels.add(m.start);
          }
        for (const t of sharedMovedTeams(text, s.mentions, a, b)) moved.add(t);
        // a topic's clause labels him only when it names no other person
        for (const ph of positionPhrasesNextTo(text, a, b))
          if (
            ph.clauseEnd === undefined ||
            !s.persons.some((p) => p.start >= ph.end && p.start < (ph.clauseEnd ?? 0))
          )
            sets.push(ph.ids);
      }
      return { written, moved, positions: allowedPositions(sets), labels };
    };

    // 3. who each name is
    // a surname standing alone is the full name's it ends, when only one full name ends with it
    const owner = new Map<string, string | null>();
    for (const n of names) {
      const k = n.entry.key.join(" ");
      const sn = n.entry.key[n.entry.key.length - 1] ?? "";
      const o = owner.get(sn);
      owner.set(sn, o === undefined || o === k ? k : null);
    }
    const decided = new Set<string>();
    for (const occ of names) {
      const { at, entry } = occ;
      if (entry.players.length === 1) {
        // a name one universe player holds: as before R8-3 — his team named in the item, or
        // written next to the name or tied to it by a roster move ("Bengals sign CB Lamar Jackson")
        const p = entry.players[0];
        if (p === undefined) continue;
        const attached = new Set([
          ...attachedTeams(text, mentions, occ.start, occ.end),
          ...movedTeams(text, mentions, occ.start, occ.end),
        ]);
        const own = onTeam(p) || (p.team !== null && attached.has(p.team));
        add(p, own ? "full_name_team" : "full_name", at);
        continue;
      }
      // a shared name: decided once per item, over the evidence of every mention of it
      const key = entry.key.join(" ");
      if (decided.has(key)) continue;
      decided.add(key);
      const s = sharedItem();
      const sn = entry.key[entry.key.length - 1] ?? "";
      const isHim = (p: PersonSpan): boolean =>
        p.key === key || (p.key === null && p.norm === sn && owner.get(sn) === key);
      const all = names.filter((n) => n.entry === entry);
      const spans = s.persons.filter(isHim).map((p): readonly [number, number] => [p.start, p.end]);
      const { written, moved, positions, labels } = pool(s, spans);
      const suffixes = new Set(all.flatMap((n) => (n.suffix === null ? [] : [n.suffix])));
      const p = sharedHolder(
        entry.players,
        {
          suffixes,
          written,
          moved,
          positions,
          described: written.size === 0 && positions === null ? describedAbout(s, isHim) : [],
          cues: cuesAbout(s, isHim, labels),
          residual: residualFor(s, isHim),
        },
        false,
      );
      if (p === null) {
        unresolved++;
        continue;
      }
      const own = p.team !== null && (written.has(p.team) || moved.has(p.team));
      add(p, own ? "full_name_team" : "full_name", at);
    }

    // 4. bare surnames: a unique one on a team the item names; a shared one pooled per surname
    const sharedSurnames = new Map<string, number[]>();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === null || t === undefined || consumed[i] === true || !t.capital) continue;
      if (TEAM_WORDS.has(t.norm)) continue;
      // the surname of a full name the item holds is that person, whoever he turned out to be —
      // never another player of the surname ("Justin Jefferson: … | Jefferson caught …")
      if (surnames.has(t.norm)) continue;
      const prev = i > 0 ? tokens[i - 1] : null;
      // a surname right after a coaching-staff word is that staff member, not a player (whatever the
      // staff word's case — "Bengals coach Corbin" as much as "Coach Corbin")
      if (!t.breakBefore && prev !== null && prev !== undefined && STAFF_WORDS.has(prev.norm))
        continue;
      if (!t.breakBefore && prev?.capital === true) {
        // a capitalised word before a surname is a first name unless it is a lead word — or, before
        // a surname several players share, a position word ("Linebacker Jefferson": R8-3 clause 4)
        const lead = LEAD_WORDS.has(prev.norm) || TEAM_WORDS.has(prev.norm);
        const shared = (bySurname.get(t.norm)?.length ?? 0) > 1;
        if (!lead && !(shared && POSITION_LEAD_WORDS.has(prev.norm))) continue;
      }
      const next = tokens[i + 1];
      if (next !== null && next !== undefined && !next.breakBefore && next.capital) {
        if (!TEAM_WORDS.has(next.norm) && !LEAD_WORDS.has(next.norm)) continue;
      }
      const sharers = bySurname.get(t.norm);
      if (sharers === undefined) continue;
      if (sharers.length > 1) {
        sharedSurnames.set(t.norm, [...(sharedSurnames.get(t.norm) ?? []), i]);
        continue;
      }
      // a surname one player holds: as before R8-3 — his team written next to it ("Commanders RB
      // Croskey-Merritt"), or named in the item ("Croskey-Merritt to start; Washington thin at RB")
      const only = sharers[0];
      const team = only?.team ?? null;
      if (team === null || only === undefined || named.size === 0) continue;
      if (attachedTeams(text, mentions, t.start, t.end).has(team) || onTeam(only))
        add(only, "last_name_team", i);
    }
    for (const [norm, at] of sharedSurnames) {
      const sharers = bySurname.get(norm) ?? [];
      const s = sharedItem();
      const isHim = (p: PersonSpan): boolean => p.key === null && p.norm === norm;
      const spans = at.flatMap((i): (readonly [number, number])[] => {
        const t = tokens[i];
        return t === null || t === undefined ? [] : [[t.start, t.end]];
      });
      const { written, moved, positions, labels } = pool(s, spans);
      // a shared surname needs a team written next to it or moved to (R8-3 clause 2), or a position
      // written next to it (clause 4: "LB Jefferson"); one such evidence leaves to no one is counted,
      // and so is one in an item that names a team (clause 5)
      if (written.size === 0 && moved.size === 0 && positions === null) {
        if (s.mentions.length > 0 || named.size > 0) unresolved++;
        continue;
      }
      const p = sharedHolder(
        sharers,
        {
          suffixes: new Set(),
          written,
          moved,
          positions,
          described: written.size === 0 && positions === null ? describedAbout(s, isHim) : [],
          cues: cuesAbout(s, isHim, labels),
          residual: false,
        },
        true,
      );
      if (p === null) unresolved++;
      else add(p, "last_name_team", at[0] ?? 0);
    }

    const refs = [...found.values()]
      .sort(
        (a, b) => b.match_confidence - a.match_confidence || a.at - b.at || a.espn_id - b.espn_id,
      )
      .slice(0, MAX_REFS_PER_ITEM)
      .map(({ espn_id, gsis_id, match_confidence, match_method }) => ({
        espn_id,
        gsis_id,
        match_confidence,
        match_method,
      }));
    return { refs, unresolved };
  };

  return { match: (text) => matchItem(text).refs, matchItem, size };
}
