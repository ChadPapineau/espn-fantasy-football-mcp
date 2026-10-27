// match.ts — the deterministic player matcher of the news sources: which ESPN players an RSS item
// names (tables.ts ds_news_players: `match_method` ∈ NEWS_MATCH_METHODS, `match_confidence` by
// method, `gsis_id` from the crosswalk at load; plan 07 D6 `players_matched`; plan 02 §6.4 — rules,
// never a model; research 04 §C — the ESPN id is the entry point, gsis via the crosswalk).
//
// Names are compared with the crosswalk's own normaliser (`mergeName`: ASCII fold, punctuation and
// apostrophes dropped, so "C.J. Stroud" = "CJ Stroud" and "Smith-Njigba" = "Smith Njigba"'s key),
// as whole-token n-grams that never cross punctuation. Three methods, in confidence order:
//   full_name_team (0.95) — the full name (capitalised) AND the player's team named in the item;
//   full_name      (0.80) — the full name, unique in the universe, or the one holder of a shared
//                            name the rules below pick;
//   last_name_team (0.60) — a capitalised surname, the only player of that surname on a team the
//                            item names, not part of someone else's full name.
// "A team the item names" is its subject's team: never a word of a full name the item holds, nor
// that name's surname standing alone ("Dallas Goedert", "Malik Washington … Washington was ruled
// out" name no Cowboys or Commanders — Stage C remediation news-match-player-name-team-word), and
// never a team named only as the opponent ("against the Eagles", "Browns matchup"; teams.ts).
// A full name several universe players share (the universe is every players_wl person: 0 %-owned
// free agents and defensive players hold the names of stars — Stage C remediation
// news-match-universe-homonyms) goes to one holder only on evidence: a holder on a team the item
// names only as the opponent is not its subject; of the others, the prominent one — owned in at
// least PROMINENT_OWNED % of ESPN leagues and PROMINENCE_RATIO times as many as each other holder —
// takes it unless the item names only another holder's team (his own news, or the team the
// prominent one faces: no ref, never the wrong one); without a prominent holder, the one holder on
// a team the item names takes it, and otherwise no one does.
// The matcher reads the SANITISED text (plan 02 §6.2), only to decide which ids an item is about; the
// text is never interpreted beyond that, and nothing of it is copied into a ref.
import { GSIS_ID_RE, type NflTeam } from "../../config/schema.js";
import { mergeName } from "../../domain/crosswalk/normalize.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import { sanitizeText } from "../../domain/league/types.js";
import type { NewsMatchMethod } from "../../store/datasets/derive.js";
import { TEAM_WORDS, teamMentions } from "./teams.js";

/** One player of the ESPN universe the matcher reads (ds_players + the crosswalk's gsis id). */
export interface NewsUniversePlayer {
  readonly espn_id: number;
  readonly full_name: string;
  /** nflverse spelling; null for a free agent. */
  readonly team: NflTeam | null;
  readonly gsis_id: string | null;
  /** ESPN's percent owned (0–100; ds_players `percent_owned`); absent (or null) when unknown. */
  readonly percent_owned?: number | null;
}

/** A percent owned as the matcher reads it: a finite 0–100, else null (unknown). */
export function percentOwnedOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
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
 * 0 = free agent; `percent_owned`) and the crosswalk's `espn_id → gsis_id` lookup — the refresh
 * wiring's one call. Team units (negative ids) and malformed rows are skipped; a later row for the
 * same id wins.
 */
export function universeFromEspnPlayers(
  rows: readonly unknown[],
  gsisOf: (espnId: number) => string | null,
): NewsUniversePlayer[] {
  const out = new Map<number, NewsUniversePlayer>();
  for (const r of rows) {
    if (r === null || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = Object.prototype.hasOwnProperty.call(o, "espn_id") ? o.espn_id : undefined;
    const name = Object.prototype.hasOwnProperty.call(o, "full_name") ? o.full_name : undefined;
    const team = Object.prototype.hasOwnProperty.call(o, "pro_team_id") ? o.pro_team_id : undefined;
    const owned = Object.prototype.hasOwnProperty.call(o, "percent_owned")
      ? o.percent_owned
      : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    if (typeof name !== "string" || name.length === 0 || name.length > 128) continue;
    let gsis: string | null = null;
    try {
      const g = gsisOf(id);
      gsis = typeof g === "string" && GSIS_ID_RE.test(g) ? g : null;
    } catch {
      gsis = null;
    }
    const share = percentOwnedOf(owned);
    out.set(id, {
      espn_id: id,
      full_name: name,
      team: teamOfProTeamId(team),
      gsis_id: gsis,
      ...(share === null ? {} : { percent_owned: share }),
    });
  }
  return [...out.values()];
}

/** The `ds_players` statement the wiring reads the universe with (one season, persons only). */
export const UNIVERSE_SQL =
  "SELECT espn_id, full_name, pro_team_id, percent_owned FROM ds_players WHERE season = :season AND espn_id > 0 ORDER BY espn_id";

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

interface Entry {
  readonly key: readonly string[];
  readonly players: readonly NewsUniversePlayer[];
}

const owned = (p: NewsUniversePlayer): number => p.percent_owned ?? 0;

/**
 * The holder of a shared name ESPN leagues roster far more than every other one (at least
 * PROMINENT_OWNED %, and PROMINENCE_RATIO times each other holder's share; an unknown share is 0),
 * or null when none does.
 */
function prominentOf(holders: readonly NewsUniversePlayer[]): NewsUniversePlayer | null {
  const ranked = [...holders].sort((a, b) => owned(b) - owned(a));
  const top = ranked[0];
  if (top === undefined) return null;
  const next = ranked[1] === undefined ? 0 : owned(ranked[1]);
  return owned(top) >= PROMINENT_OWNED && owned(top) >= PROMINENCE_RATIO * next ? top : null;
}

/**
 * Which holder of a full name several universe players share an item is about, or null (see the
 * header): a holder on a team named only as the opponent is not its subject; then the prominent
 * holder unless only another holder's team is named; else the one holder on a named team.
 */
function sharedHolder(
  holders: readonly NewsUniversePlayer[],
  subject: ReadonlySet<NflTeam>,
  opponentOnly: ReadonlySet<NflTeam>,
): NewsUniversePlayer | null {
  const cands = holders.filter((p) => p.team === null || !opponentOnly.has(p.team));
  if (cands.length <= 1) return cands[0] ?? null;
  const named = cands.filter((p) => p.team !== null && subject.has(p.team));
  const top = prominentOf(cands);
  if (top !== null) return named.length === 0 || named.includes(top) ? top : null;
  return named.length === 1 ? (named[0] ?? null) : null;
}

/** A matcher over one universe (built once per refresh). */
export interface PlayerMatcher {
  /** The refs of a text (sanitised here first), best first, at most MAX_REFS_PER_ITEM. */
  match(text: string): NewsPlayerRef[];
  /** How many universe players are matchable (a valid id and a ≥ 2-token name). */
  readonly size: number;
}

/** Builds the matcher (invalid universe rows — no positive id, no two-token name — are skipped). */
export function buildPlayerMatcher(universe: readonly NewsUniversePlayer[]): PlayerMatcher {
  const byKey = new Map<string, NewsUniversePlayer[]>();
  const bySurname = new Map<string, NewsUniversePlayer[]>();
  let size = 0;
  for (const p of universe) {
    if (!Number.isSafeInteger(p.espn_id) || p.espn_id <= 0) continue;
    const merged = mergeName(p.full_name);
    if (merged === null) continue;
    const tokens = merged.split(" ");
    if (tokens.length < 2) continue;
    const player: NewsUniversePlayer = {
      espn_id: p.espn_id,
      full_name: p.full_name,
      team: p.team,
      gsis_id: p.gsis_id !== null && GSIS_ID_RE.test(p.gsis_id) ? p.gsis_id : null,
      percent_owned: percentOwnedOf(p.percent_owned),
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
  const match = (raw: string): NewsPlayerRef[] => {
    const text = sanitizeText(raw, MATCH_TEXT_CAP).value;
    const tokens = tokenize(text, normCache);
    const consumed = new Array<boolean>(tokens.length).fill(false);
    const found = new Map<number, NewsPlayerRef & { at: number }>();
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
    // 1. the full names the text holds (each a person's name, whoever it turns out to be)
    const names: { readonly at: number; readonly entry: Entry }[] = [];
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
        for (let k = 0; k < e.key.length; k++) consumed[i + k] = true;
        names.push({ at: i, entry: e });
        i += e.key.length - 1;
        break;
      }
    }

    // 2. the teams the item names as its subject's: a word of a name it holds, or that name's
    // surname alone, is the person; a team named only as the opponent is not the subject's
    const spans = names.map(({ at, entry }) => ({
      start: tokens[at]?.start ?? 0,
      end: tokens[at + entry.key.length - 1]?.end ?? 0,
    }));
    const surnames = new Set(names.map(({ entry }) => entry.key[entry.key.length - 1] ?? ""));
    const mentions = teamMentions(text).filter(
      (m) =>
        !spans.some((s) => m.start < s.end && s.start < m.end) &&
        !surnames.has(mergeName(m.words) ?? ""),
    );
    const subject = new Set(mentions.filter((m) => !m.opponent).map((m) => m.team));
    const opponentOnly = new Set(
      mentions.filter((m) => m.opponent && !subject.has(m.team)).map((m) => m.team),
    );
    const onTeam = (p: NewsUniversePlayer): boolean => p.team !== null && subject.has(p.team);

    // 3. who each name is
    for (const { at, entry } of names) {
      const p =
        entry.players.length === 1
          ? entry.players[0]
          : sharedHolder(entry.players, subject, opponentOnly);
      if (p !== undefined && p !== null) add(p, onTeam(p) ? "full_name_team" : "full_name", at);
    }

    // 4. bare surnames on a team the item names
    for (let i = 0; i < tokens.length && subject.size > 0; i++) {
      const t = tokens[i];
      if (t === null || t === undefined || consumed[i] === true || !t.capital) continue;
      if (TEAM_WORDS.has(t.norm)) continue;
      const prev = i > 0 ? tokens[i - 1] : null;
      // a surname right after a coaching-staff word is that staff member, not a player (whatever the
      // staff word's case — "Bengals coach Corbin" as much as "Coach Corbin")
      if (!t.breakBefore && prev !== null && prev !== undefined && STAFF_WORDS.has(prev.norm))
        continue;
      if (!t.breakBefore && prev?.capital === true) {
        if (!LEAD_WORDS.has(prev.norm) && !TEAM_WORDS.has(prev.norm)) continue;
      }
      const next = tokens[i + 1];
      if (next !== null && next !== undefined && !next.breakBefore && next.capital) {
        if (!TEAM_WORDS.has(next.norm) && !LEAD_WORDS.has(next.norm)) continue;
      }
      const here = (bySurname.get(t.norm) ?? []).filter(onTeam);
      const only = here.length === 1 ? here[0] : undefined;
      if (only !== undefined) add(only, "last_name_team", i);
    }

    return [...found.values()]
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
  };

  return { match, size };
}
