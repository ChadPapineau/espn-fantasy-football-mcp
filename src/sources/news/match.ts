// match.ts — the deterministic player matcher of the news sources: which ESPN players an RSS item
// names (tables.ts ds_news_players: `match_method` ∈ NEWS_MATCH_METHODS, `match_confidence` by
// method, `gsis_id` from the crosswalk at load; plan 07 D6 `players_matched`; plan 02 §6.4 — rules,
// never a model; research 04 §C — the ESPN id is the entry point, gsis via the crosswalk).
//
// Names are compared with the crosswalk's own normaliser (`mergeName`: ASCII fold, punctuation and
// apostrophes dropped, so "C.J. Stroud" = "CJ Stroud" and "Smith-Njigba" = "Smith Njigba"'s key),
// as whole-token n-grams that never cross punctuation. Three methods, in confidence order:
//   full_name_team (0.95) — the full name (capitalised) AND its holder's team: for a unique name, his
//                            team named in the item; for a shared name, his team in the label
//                            written next to it (below);
//   full_name      (0.80) — the full name, unique in the universe, or the one holder of a shared
//                            name the rules below pick;
//   last_name_team (0.60) — a capitalised surname: the only player of a unique surname on a team the
//                            item names, or the one sharer of a shared surname its label fits (below),
//                            never part of someone else's full name.
// "A team the item names" is its subject's team: never a word of a full name the item holds, nor
// that name's surname standing alone ("Dallas Goedert", "Malik Washington … Washington was ruled
// out" name no Cowboys or Commanders — Stage C remediation news-match-player-name-team-word), and
// never a team named only as the opponent ("against the Eagles", "Browns matchup"; teams.ts).
//
// A name only one universe player holds — a full name or a surname — is matched exactly as at
// `f41e810` (ruling R8-6): teams.ts' reading (`cue`, `pair`, `attachedTeams`, `movedTeams`), no
// position read.
//
// A shared name fails closed (ruling R8-6, changelog §R8; it supersedes R8-3 clause 3, clause 4's
// "describing the subject" reading and choice 3 for such a name; ruling R8-7 bounds what its label and
// its scan read). The universe is every players_wl person, so 0 %-owned free agents and defensive
// players hold the names of stars (16 full-name keys and 302 surnames have more than one holder in the
// recorded universe), and a namesake's item put on a star gives E10 a false injury or transaction
// claim. A name written several times in one item is decided once, over every mention of it: each
// occurrence of the full name, and each surname written alone that the full name ends with (R8-7 (4);
// labels.ts reads the item: `sharedReading`):
//   spelling (R8-7 (5)) — a generational suffix written after a mention ("Michael Carter II", "Byron
//     Murphy Jr.") excludes every holder ESPN spells otherwise (one no holder carries excludes them
//     all). It narrows the holders a label can fit and never makes the spelled holder the residual's
//     taker: the residual goes only to the name's prominent holder, and only when no spelling excludes
//     him ("Michael Carter II: Questionable" gets no ref: no Michael Carter is prominent);
//   (a) a LABEL written next to a mention — a team or a position directly before it, in parentheses
//     directly after it, or in the headline's name tag before the colon, in every form the scan reads
//     (R8-7 (3); labels.ts: its forms, adjacency and the rules that take a label away) — picks the one
//     holder it fits: a team fits a holder the universe lists on it (a free agent fits none), a
//     position a holder whose ESPN `position_id` it allows (ESPN's own position only its own id: "DT" is
//     no ESPN DE's). The labels of every mention count, the surname's too ("Justin Jefferson:
//     Questionable | Vikings WR Jefferson (hamstring) …" is the WR's), and they must fit him — one part
//     fitting, none ruling him out — and rule every other holder out (a holder of unknown position is
//     never ruled out by a position): labels that fit different holders, or one holder and one they
//     cannot rule out, pick none ("Chiefs DT Harris: Placed on IR | Harris is no relation to Titans CB
//     Marcus Harris." picks no one). A segment (the title, the blurb, a part a "|" or a line break
//     separates) that writes the full name both with a label and without one, or a surname alone before
//     a labelled mention, may speak of two holders, so no label picks ("Lamar Jackson: Throws pick to CB
//     Lamar Jackson"; "Justin Jefferson: Catches TD | Jefferson beat Browns LB Jefferson …"); a surname
//     alone after a labelled mention refers back to him. A surname that two full names of the item end
//     with, labelled, may be either's: neither name's label picks. Choice 6 stands: a holder far more
//     widely owned than the one picked (the prominent one, below) blocks a label that no position of it
//     rules him out by — after a trade of the star to his namesake's team, "Cleveland's Justin
//     Jefferson" would be the star. A team in the label gives full_name_team, a position alone full_name;
//   (b) with no label, the PROMINENT holder — owned in at least PROMINENT_OWNED % of ESPN leagues and
//     PROMINENCE_RATIO times as many as each other holder (`prominentOf`) — takes the item at
//     full_name, only when the broad scan (labels.ts) finds no team and no position anywhere in the
//     title or blurb, the persons' full names left out (R8-3 clause 6's accepted residual: "Justin
//     Jefferson: Placed on IR | Jefferson (knee) will miss at least four games.");
//   (c) nothing else picks or raises a holder: not a cue word, a game, a describing sentence, a
//     headline topic's clause, a roster move or a spelling ("Ravens sign Lamar Jackson to practice
//     squad" gets no ref: the item names a team, and no label is next to the name);
//   (d) otherwise no one takes the name, and the item is counted (`matchItem().unresolved`, the news
//     build's warning; R8-3 clause 5, plan 07 D6) — never dropped in silence.
// A bare surname. One standing alone that a full name in the item ends with is that person: a name one
// universe player holds is matched as at f41e810 and his surname never refs anyone else; a shared
// name's surname is its mention (above). A surname one universe player holds is matched as at f41e810:
// on a team written next to it, or named in the item as its subject's. A surname several players share,
// with no full name in the item ending with it, reads its labels as (a) does, in every form (a
// possessive: "MIN's Jefferson", "Cincy's Taylor"; a position of two words in title case: "Chiefs
// Defensive Tackle Jones"; a capitalised word after it: "Rams DE Young Records Two Sacks"; a surname
// that is also a team word: "Jaguars WR Washington"); the labels of its mentions must fit one sharer,
// and choice 6 blocks him on its two prominent holders, the surname's and his own full name's
// ("Cleveland's Jefferson" and "Eagles' Young" get no ref, as "Eagles' Byron Young" does). It never
// takes the residual, and left to no one it is counted, beside other refs too (R8-7 (4): "Jordan
// Addison: Two TDs | Addison and Jefferson combined …"). It is no mention where it is a word of
// another person's name or of a form: a first name before it (a capitalised word that is no lead word
// and no label word: "Van Jefferson", "Bill Johnson", "Charlotte Jones"; labels.ts `formBefore`), a
// universe surname or a full name right after it ("Eagles' Lane Johnson"; "Burns Denzel Ward"), or a
// form of several words it stands in ("Allen Park", "Gang Green", "Ralph Wilson"; labels.ts `inForm`).
// A surname that is a team word with no label next to it is the team ("Washington thin at RB"), and a
// team it names right after it is its own name ("Washington Commanders:"), no label.
// The matcher reads the SANITISED text (plan 02 §6.2), only to decide which ids an item is about; the
// text is never interpreted beyond that, and nothing of it is copied into a ref. Where the raw item
// broke a line or held a tag (sanitizeText makes both a space) is read from a second sanitised copy
// with the breaks marked (labels.ts `markBreaks`), for the labels alone; a name one universe player
// holds never sees it. Matching time is linear in the item's length: the fold, the breaks and the
// quotes are one pass each, a label reads a bounded window around each name, the scan each word once.
import { GSIS_ID_RE, type NflTeam } from "../../config/schema.js";
import { mergeName, NAME_SUFFIXES } from "../../domain/crosswalk/normalize.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import { sanitizeText } from "../../domain/league/types.js";
import type { NewsMatchMethod } from "../../store/datasets/derive.js";
import { markBreaks, sharedReading, type LabelPart, type SharedReading } from "./labels.js";
import { KNOWN_POSITION_IDS } from "./positions.js";
import {
  attachedTeams,
  movedTeams,
  TEAM_HOMES,
  TEAM_NICKNAMES,
  TEAM_WORDS,
  teamMentions,
} from "./teams.js";

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

/** What a raw item holds where it may break a line or a paragraph: a line break, a tag, an entity. */
const BREAKS_RE = /[\r\n\v\f\u0085\u2028\u2029<&]/u;

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

/** The teams a team word names as a word of its home or nickname ("washington" WAS, "green" GB). */
const OWN_TEAMS: ReadonlyMap<string, ReadonlySet<NflTeam>> = (() => {
  const out = new Map<string, Set<NflTeam>>();
  for (const [k, team] of [...Object.entries(TEAM_NICKNAMES), ...Object.entries(TEAM_HOMES)])
    for (const w of k.toLowerCase().split(" ")) out.set(w, new Set([...(out.get(w) ?? []), team]));
  return out;
})();

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
  /** His ESPN position id when a position form can name it (positions.ts), else null (unknown). */
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

/** What one part of a label says of a holder: he fits it, it rules him out, or it cannot tell. */
type Fit = "fits" | "out" | "open";

/**
 * A label part against a holder: a team fits a holder the universe lists on it (a free agent fits
 * none); a position fits a holder whose ESPN position it allows, and leaves one of unknown position
 * open (R8-6 (a): "team from the universe; position from ESPN position_id").
 */
function fitOf(p: Held, part: LabelPart): Fit {
  if (part.kind === "team") return p.team !== null && part.teams.includes(p.team) ? "fits" : "out";
  if (p.position_id === null) return "open";
  return part.ids.has(p.position_id) ? "fits" : "out";
}

/** Whether a position in the label rules `p` out (a team never does: choice 6, the lagging universe). */
const positionRulesOut = (parts: readonly LabelPart[], p: Held): boolean =>
  parts.some((x) => x.kind === "position" && p.position_id !== null && !x.ids.has(p.position_id));

/**
 * A whole label against a holder: it rules him out when one part does; it fits him when no part rules
 * him out and one fits him; else it cannot tell (only positions, his unknown).
 */
function labelFit(p: Held, parts: readonly LabelPart[]): Fit {
  let fit: Fit = "open";
  for (const part of parts) {
    const f = fitOf(p, part);
    if (f === "out") return "out";
    if (f === "fits") fit = "fits";
  }
  return fit;
}

/**
 * R8-6 (a): the one holder the label fits, every other holder ruled out by some part of it — or
 * null: labels that fit different holders, or a holder and one they cannot rule out, pick none. A
 * blocker (a prominent holder, choice 6) who is not the one picked and whom no position of the label
 * rules out blocks the pick.
 */
function labelledHolder(
  holders: readonly Held[],
  parts: readonly LabelPart[],
  blockers: readonly (Held | null)[],
): Held | null {
  let him: Held | null = null;
  for (const p of holders) {
    const fit = labelFit(p, parts);
    if (fit === "out") continue;
    if (fit === "open" || him !== null) return null;
    him = p;
  }
  if (him === null) return null;
  const picked = him;
  return blockers.some((b) => b !== null && b !== picked && !positionRulesOut(parts, b))
    ? null
    : picked;
}

/** The method a label gives a shared full name's holder: a team in it gives full_name_team. */
const labelMethod = (parts: readonly LabelPart[]): NewsMatchMethod =>
  parts.some((x) => x.kind === "team") ? "full_name_team" : "full_name";

/** What one item's match found (R8-6 (d): a shared name left to no one is counted). */
export interface NewsItemMatch {
  /** The refs, best first, at most MAX_REFS_PER_ITEM. */
  readonly refs: NewsPlayerRef[];
  /**
   * How many names several universe players share the item holds that no single holder took (a
   * full name; a shared surname in an item that names a team or a position): no ref for them.
   */
  readonly unresolved: number;
}

/** A matcher over one universe (built once per refresh). */
export interface PlayerMatcher {
  /** The refs of a text (sanitised here first), best first, at most MAX_REFS_PER_ITEM. */
  match(text: string): NewsPlayerRef[];
  /** The refs of a text and how many of its shared names were left to no one (R8-6 (d)). */
  matchItem(text: string): NewsItemMatch;
  /** How many universe players are matchable (a valid id and a ≥ 2-token name). */
  readonly size: number;
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

    // 2. the teams the item names as its subject's (the unique names' reading, as at f41e810): a
    // word of a name it holds, or that name's surname alone, is the person; a team named only as
    // the opponent is not the subject's
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
    const mentions = teamMentions(text).filter(
      (m) =>
        !names.some((s) => m.start < s.end && s.start < m.end) &&
        !surnames.has(normOf(text.slice(m.start, m.end)) ?? ""),
    );
    const subject = new Set(mentions.filter((m) => !m.opponent).map((m) => m.team));
    const onTeam = (p: NewsUniversePlayer): boolean => p.team !== null && subject.has(p.team);
    const named = new Set(mentions.map((m) => m.team));

    // R8-6 (a), (b): the shared names' reading (labels.ts), built once, when a shared name first
    // asks, over the persons' full names: no label word is a word of one, and the scan leaves them out
    // ("Dallas Goedert" names no team). A surname standing alone may be a team ("Washington"), so the
    // scan reads it (fail closed: it only takes the residual away)
    const spans = names.map((n): readonly [number, number] => [n.start, n.end]);
    let reading: SharedReading | null = null;
    const read = (): SharedReading => {
      if (reading !== null) return reading;
      // where the raw item broke a line or held a tag (none without a line break, "<" or "&")
      const marked = BREAKS_RE.test(raw)
        ? sanitizeText(markBreaks(raw), MATCH_TEXT_CAP).value
        : null;
      reading = sharedReading(text, marked, spans, spans);
      return reading;
    };
    /**
     * Whether one segment (the title, the blurb) writes the name both with a label and without one:
     * it may speak of two holders ("Lamar Jackson, not the Ravens QB Lamar Jackson, signs …"), so no
     * label picks (fail closed). A label in the blurb of a name the title writes alone picks as any.
     */
    const contrasted = (
      labels: readonly { at: number; parts: readonly LabelPart[] }[],
    ): boolean => {
      const bare = new Set(
        labels.filter((l) => l.parts.length === 0).map((l) => read().segment(l.at)),
      );
      return labels.some((l) => l.parts.length > 0 && bare.has(read().segment(l.at)));
    };

    // 3. the capitalised words no full name took: a surname of a full name the item holds, or a
    // bare surname. A surname right after a coaching-staff word is that staff member, not a player
    // (whatever the staff word's case — "Bengals coach Corbin" as much as "Coach Corbin")
    const endingWith = new Map<string, Set<Entry>>();
    for (const n of names) {
      const last = n.entry.key[n.entry.key.length - 1] ?? "";
      endingWith.set(last, new Set([...(endingWith.get(last) ?? []), n.entry]));
    }
    /**
     * Whether the capitalised word right before token `i` is a first name — another person's name,
     * not a lead word nor a label form ("Van Jefferson"; but "MIN's Jefferson", "Chiefs Defensive
     * Tackle Jones", "Ravens QB Jackson" are labels).
     */
    const firstNameBefore = (i: number, t: Token): boolean => {
      const prev = i > 0 ? tokens[i - 1] : null;
      if (t.breakBefore || prev?.capital !== true) return false;
      if (LEAD_WORDS.has(prev.norm) || TEAM_WORDS.has(prev.norm)) return false;
      return !read().formBefore(t.start);
    };
    /**
     * Whether a shared surname at token `i` is no mention: another person's first name before it, a
     * form it is a word of ("Allen Park", "Gang Green"), a full name right after it (a headline's verb:
     * "Burns Denzel Ward"), or a universe surname right after it (it is that person's first name:
     * "Eagles' Lane Johnson"). Any other capitalised word after it leaves it a surname ("Rams DE Young
     * Records Two Sacks").
     */
    const noMention = (i: number, t: Token): boolean => {
      const next = tokens[i + 1];
      if (
        next !== null &&
        next !== undefined &&
        !next.breakBefore &&
        (consumed[i + 1] === true || (next.capital && bySurname.has(next.norm)))
      )
        return true;
      return firstNameBefore(i, t) || read().inForm(t.start, t.end);
    };
    /**
     * The label of a shared surname's mention (R8-7 (4)): every form, before it and after it; a
     * surname that is also a team word reads the team it names written after it as that team's own
     * name ("Washington Commanders: …"), and labels nothing without a label (it is the team).
     */
    const surnameLabel = (t: Token): readonly LabelPart[] | null => {
      const { before, after } = read().labelSides(t.start, t.end);
      if (!TEAM_WORDS.has(t.norm)) return [...before, ...after];
      const own = OWN_TEAMS.get(t.norm) ?? new Set<NflTeam>();
      const parts = [
        ...before,
        ...after.filter((x) => x.kind !== "team" || !x.teams.some((tm) => own.has(tm))),
      ];
      return parts.length > 0 ? parts : null;
    };
    /** Mentions of a shared full name by its surname alone ("Justin Jefferson … Vikings WR Jefferson"). */
    const surnameMentions = new Map<Entry, { at: number; parts: readonly LabelPart[] }[]>();
    /** The shared names a labelled surname may be another full name's mention of: no label picks. */
    const crossed = new Set<Entry>();
    const bare: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === null || t === undefined || consumed[i] === true || !t.capital) continue;
      const prev = i > 0 ? tokens[i - 1] : null;
      if (!t.breakBefore && prev !== null && prev !== undefined && STAFF_WORDS.has(prev.norm))
        continue;
      const ending = endingWith.get(t.norm);
      if (ending === undefined) {
        bare.push(i);
        continue;
      }
      // the surname of a full name the item holds is that person, whoever he turns out to be — never
      // another player of the surname ("Justin Jefferson: … | Jefferson caught …"; f41e810 for a name
      // one universe player holds). R8-7 (4): for a shared name it is a mention of that name, and a
      // label next to it is the name's label
      const shared = [...ending].filter((e) => e.players.length > 1);
      if (shared.length === 0 || noMention(i, t)) continue;
      const parts = surnameLabel(t) ?? [];
      if (ending.size > 1) {
        if (parts.length > 0) for (const e of shared) crossed.add(e);
        continue;
      }
      for (const e of shared)
        surnameMentions.set(e, [...(surnameMentions.get(e) ?? []), { at: t.start, parts }]);
    }
    /**
     * Whether a surname written alone, before a labelled mention in its segment, may be the other
     * holder ("Justin Jefferson: Catches TD | Jefferson beat Browns LB Jefferson …"): no label picks.
     * One written after a labelled mention refers back to him ("Vikings WR Justin Jefferson … Jefferson
     * is expected to play").
     */
    const introduced = (
      mentions: readonly { at: number; parts: readonly LabelPart[] }[],
      labels: readonly { at: number; parts: readonly LabelPart[] }[],
    ): boolean =>
      mentions.some(
        (b) =>
          b.parts.length === 0 &&
          labels.some(
            (l) =>
              l.parts.length > 0 && l.at > b.at && read().segment(l.at) === read().segment(b.at),
          ),
      );

    // 4. who each full name is
    const decided = new Set<string>();
    for (const occ of names) {
      const { at, entry } = occ;
      if (entry.players.length === 1) {
        // a name one universe player holds: as at f41e810 — his team named in the item, or
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
      // a shared name (R8-6): decided once per item, over every occurrence of it and every labelled
      // mention of its surname (R8-7 (4))
      const key = entry.key.join(" ");
      if (decided.has(key)) continue;
      decided.add(key);
      const all = names.filter((n) => n.entry === entry);
      // R8-7 (5): a written suffix excludes every holder ESPN spells otherwise; it narrows the holders
      // a label can fit, and the residual goes only to the prominent holder it does not exclude
      const written = new Set(all.flatMap((n) => (n.suffix === null ? [] : [n.suffix])));
      const excluded = (p: Held): boolean => [...written].some((x) => p.suffix !== x);
      const holders = entry.players.filter((p) => !excluded(p));
      const top = prominentOf(entry.players);
      const prominent = top !== null && !excluded(top) ? top : null;
      // (a) the labels of every mention: one holder must fit them all
      const alone = surnameMentions.get(entry) ?? [];
      const labels = [
        ...all.map((n) => ({ at: n.start, parts: read().label(n.start, n.end) })),
        ...alone.filter((x) => x.parts.length > 0),
      ];
      const parts = labels.flatMap((l) => l.parts);
      let p: Held | null = null;
      if (crossed.has(entry)) p = null;
      else if (parts.length > 0)
        p =
          contrasted(labels) || introduced(alone, labels)
            ? null
            : labelledHolder(holders, parts, [prominent]);
      // (b) the residual, only when the scan finds no team and no position: the prominent holder
      else if (prominent !== null && !read().namesTeamOrPosition()) p = prominent;
      if (p === null) {
        unresolved++;
        continue;
      }
      add(p, labelMethod(parts), at);
    }

    // 5. bare surnames: a unique one on a team the item names (f41e810); a shared one by its label
    const sharedSurnames = new Map<
      string,
      { i: number; at: number; parts: readonly LabelPart[] }[]
    >();
    for (const i of bare) {
      const t = tokens[i];
      if (t === null || t === undefined) continue;
      const sharers = bySurname.get(t.norm);
      if ((sharers?.length ?? 0) <= 1) {
        // a surname one player holds (or none): exactly as at f41e810 — his team written next to it
        // ("Commanders RB Croskey-Merritt"), or named in the item ("Croskey-Merritt to start;
        // Washington thin at RB"); a capitalised word before it is a first name unless it is a lead
        // word, and one after it a second name
        if (TEAM_WORDS.has(t.norm)) continue;
        const prev = i > 0 ? tokens[i - 1] : null;
        if (!t.breakBefore && prev?.capital === true) {
          if (!LEAD_WORDS.has(prev.norm) && !TEAM_WORDS.has(prev.norm)) continue;
        }
        const next = tokens[i + 1];
        if (next !== null && next !== undefined && !next.breakBefore && next.capital) {
          if (!TEAM_WORDS.has(next.norm) && !LEAD_WORDS.has(next.norm)) continue;
        }
        const only = sharers?.[0];
        const team = only?.team ?? null;
        if (team === null || only === undefined || named.size === 0) continue;
        if (attachedTeams(text, mentions, t.start, t.end).has(team) || onTeam(only))
          add(only, "last_name_team", i);
        continue;
      }
      // R8-7 (4): a surname several players share, no full name in the item ending with it, reads
      // its labels as (a) does, in every form (a possessive, a two-word position in title case, a
      // capitalised word after it, a surname that is also a team word); `noMention` makes it none
      if (noMention(i, t)) continue;
      const parts = surnameLabel(t);
      if (parts === null) continue;
      sharedSurnames.set(t.norm, [
        ...(sharedSurnames.get(t.norm) ?? []),
        { i, at: t.start, parts },
      ]);
    }
    for (const [norm, labels] of sharedSurnames) {
      const sharers = bySurname.get(norm) ?? [];
      const parts = labels.flatMap((l) => l.parts);
      // R8-6 (a) and choice 6: the one sharer the labels of its mentions fit, past the surname's
      // prominent holder and his own full name's ("Eagles' Young" is no more the Eagles DT's than
      // "Eagles' Byron Young" is); never the residual
      let p: Held | null = null;
      if (parts.length > 0 && !contrasted(labels)) {
        p = labelledHolder(sharers, parts, [prominentOf(sharers)]);
        const him = p;
        const own = him === null ? null : prominentOf(sharers.filter((x) => x.key === him.key));
        if (own !== null && own !== him && !positionRulesOut(parts, own)) p = null;
      }
      // R8-7 (4): left to no one, it is counted — beside other refs too
      if (p !== null) add(p, "last_name_team", labels[0]?.i ?? 0);
      else unresolved++;
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
