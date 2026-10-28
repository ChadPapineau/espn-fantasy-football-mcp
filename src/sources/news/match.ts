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
//
// Namesakes (Stage C remediation news-match-universe-homonyms). The universe is every players_wl
// person, so 0 %-owned free agents and defensive players hold the names of stars. A team named
// anywhere in an item may be its subject's team OR his opponent — "win over the Browns", "loss to
// the Eagles", "at Cleveland", "the Vikings host the Browns": no cue list can tell them apart — so a
// team named loosely is never evidence FOR a namesake; it only shows the item may be his. The
// evidence that picks one holder of a shared full name, per occurrence of the name:
//   1. its spelling — a generational suffix written after it ("Michael Carter II", "Byron Murphy
//      Jr.") keeps only the holders ESPN spells with that suffix (when one does);
//   2. ruled out — in the item's subject (its first full name): a GAME the item names ("Bills vs.
//      Ravens", "the Bengals' game versus the Vikings" — teams.ts `pair`) is his, so a holder whose
//      team does not play in it is not him, nor is a free agent; a team a cue word names as the
//      opponent ("against the Ravens", "vs. Browns") is not his team, nor is he a free agent (no
//      games, no opponent); "<team> matchup" names his own team's game as often as his opponent's,
//      so it rules out only while it leaves a holder. A cue is about the subject, so it rules no
//      one out for the other names an item holds. Ruling out only removes: a holder left without
//      evidence of his own never takes the name from a ruled-out holder who outshines him;
//   3. attached — a team written next to the name (teams.ts `attachedTeams`: "Vikings WR Justin
//      Jefferson", "Sam Twin, Dolphins:"), or the team of a roster move the item states (`movedTeams`:
//      "Bengals sign CB Lamar Jackson", "…: Signs with Bengals"), is his own, so a holder on another
//      team is not him;
//   4. prominence — a holder owned in at least PROMINENT_OWNED % of ESPN leagues and
//      PROMINENCE_RATIO times as many as each other holder.
// Evidence that contradicts every holder gives the name to no one (fail safe: the item is about a
// holder the universe places elsewhere, or about no holder — "Lamar Jackson: Intercepts a pass
// against the Ravens", "Lamar Jackson, Bengals: Signed to practice squad" went to the Ravens QB).
// One holder left after 1–3 takes the name (2's guard permitting). Else an attached holder takes it —
// past a prominent one only when it is the prominent one himself (a namesake's team attached beside a
// star's name blocks it: no ref, never the wrong one). Else the prominent holder takes it unless
// another holder's team is named anywhere in the item (his own news, or the star facing his team:
// no ref). Else no one.
// A surname standing alone that a full name in the item ends with is that person ("Justin Jefferson:
// … | Jefferson caught …"): never a last_name_team ref to someone else. And a bare surname is not the
// one player of it on a team named loosely when another player of that surname, ESPN-owned
// PROMINENCE_RATIO times as widely (and at least PROMINENT_OWNED %), may be the subject facing that
// team ("Jefferson torches Browns"); an attached team still decides ("Browns LB Jefferson").
// The matcher reads the SANITISED text (plan 02 §6.2), only to decide which ids an item is about; the
// text is never interpreted beyond that, and nothing of it is copied into a ref.
import { GSIS_ID_RE, type NflTeam } from "../../config/schema.js";
import { mergeName, NAME_SUFFIXES } from "../../domain/crosswalk/normalize.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import { sanitizeText } from "../../domain/league/types.js";
import type { NewsMatchMethod } from "../../store/datasets/derive.js";
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

/** A universe player as the matcher holds him: the generational suffix ESPN spells him with. */
interface Held extends NewsUniversePlayer {
  /** "jr", "ii" … when his ESPN name ends with one (mergeName folds it away), else null. */
  readonly suffix: string | null;
}

interface Entry {
  readonly key: readonly string[];
  readonly players: readonly Held[];
}

/** One occurrence of a full name in an item, and the evidence about who it is (see the header). */
interface Occurrence {
  readonly at: number;
  readonly entry: Entry;
  /** Offsets of the name in the text, its written suffix included: [start, end). */
  readonly start: number;
  readonly end: number;
  /** The generational suffix written right after the name, or null. */
  readonly suffix: string | null;
}

/** The evidence one occurrence of a shared name carries. */
interface Evidence {
  readonly suffix: string | null;
  /** Teams written next to the name (its own). */
  readonly attached: ReadonlySet<NflTeam>;
  /** Whether the name is the item's subject (its first full name): an opponent cue is about him. */
  readonly subject: boolean;
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

/**
 * What the item says of its subject's team (the subject's occurrence only — a cue is about him):
 * `games`, the teams of the games it names ("Bills vs. Ravens": he plays in one of them); `strong`,
 * the teams a cue word before them names as his opponent ("against the Ravens"); `weak`, those
 * "<team> matchup" names, as often his own team's game as his opponent's.
 */
interface SubjectCues {
  readonly games: ReadonlySet<NflTeam>;
  readonly strong: ReadonlySet<NflTeam>;
  readonly weak: ReadonlySet<NflTeam>;
}

/**
 * Which holder of a full name several universe players share this occurrence is, or null (the
 * header's rules): spelling, then ruled out, then attached, then prominence. A team named loosely
 * (`named`: anywhere in the item, cue or not) never picks a namesake; it only blocks a prominent one.
 *
 * Ruling out (the item's subject only): a game the item names leaves out every holder whose team
 * does not play in it, a free agent included (he plays no games); an opponent a cue word names
 * leaves out the holder on that team, and a free agent. Ruling out only REMOVES: a holder left
 * without evidence of his own (a team attached to the name, or a game the item names that his team
 * plays in) never takes a name from a ruled-out holder who outshines him — "Bills vs. Ravens: Lamar
 * Jackson limited" once handed the Ravens QB's news to the 0.11 %-owned free-agent CB by
 * elimination (attempt 3). A game names both teams of it, so "Bengals vs. Vikings: Justin Jefferson
 * questionable" is the Vikings WR's — the Browns LB plays in no such game (attempt 4: read as an
 * opponent cue, it ruled the WR out of his own game and gave no ref).
 *
 * When the evidence contradicts EVERY holder, no one takes the name (fail safe: the item is about a
 * holder the universe places elsewhere — a namesake since signed, a stale team — or no holder at all;
 * never the wrong one): "Lamar Jackson: Intercepts a pass against the Ravens" contradicts the Ravens
 * QB (his own team as the opponent) and the free-agent CB alike, and went to the QB by prominence
 * (attempt 4). The one exception is "<team> matchup" alone: it names the subject's own team's game
 * as often as his opponent's ("Expected to start in Ravens matchup"), so a weak cue that would leave
 * no holder is no evidence, and prominence decides as without it.
 *
 * A team attached to the name is his own: a holder on another team is not him, so a star whose team
 * it is not never takes the name ("Lamar Jackson, Bengals: Signed to practice squad", "Bengals CB
 * Lamar Jackson" went to the Ravens QB at 0.80 — attempt 4), and a namesake on it takes the name past
 * a prominent holder only when that holder is ruled out too (a namesake's team attached beside a
 * star's name blocks the star: no ref, never the wrong one).
 */
function sharedHolder(
  holders: readonly Held[],
  ev: Evidence,
  cues: SubjectCues,
  named: ReadonlySet<NflTeam>,
): Held | null {
  let cands = holders;
  if (ev.suffix !== null) {
    const spelled = cands.filter((p) => p.suffix === ev.suffix);
    if (spelled.length > 0) cands = spelled;
  }
  const attached = (p: Held): boolean => p.team !== null && ev.attached.has(p.team);
  const inGame = (p: Held): boolean => ev.subject && p.team !== null && cues.games.has(p.team);
  /** Evidence of his own: his team written next to the name, or playing in a game the item names. */
  const own = (p: Held): boolean => attached(p) || inGame(p);
  let ruledOut: Held[] = [];
  if (ev.subject) {
    const hit = (teams: ReadonlySet<NflTeam>) => (p: Held) =>
      teams.size > 0 && !own(p) && (p.team === null || teams.has(p.team));
    const outOfGame = (p: Held): boolean => cues.games.size > 0 && !own(p);
    const strongOut = hit(cues.strong);
    const out = (p: Held): boolean => outOfGame(p) || strongOut(p);
    ruledOut = cands.filter(out);
    cands = cands.filter((p) => !out(p));
    // a weak cue rules out only while it leaves someone
    const weakOut = hit(cues.weak);
    const kept = cands.filter((p) => !weakOut(p));
    if (kept.length > 0) {
      ruledOut = [...ruledOut, ...cands.filter(weakOut)];
      cands = kept;
    }
  }
  if (ev.attached.size > 0 && !cands.some(attached)) {
    // a team written next to the name that is no candidate's: he is none of the candidates on
    // another team — at most a free agent since signed (who takes it only past no one he is outshone by)
    ruledOut = [...ruledOut, ...cands.filter((p) => p.team !== null)];
    cands = cands.filter((p) => p.team === null);
  }
  if (cands.length === 0) return null;
  /** A pick with no evidence of its own, outshone by a holder the evidence ruled out: no one. */
  const unsupported = (p: Held): boolean => !own(p) && ruledOut.some((x) => outshines(x, p));
  if (cands.length === 1) {
    const only = cands[0];
    return only === undefined || unsupported(only) ? null : only;
  }
  const top = prominentOf(cands);
  const att = cands.filter(attached);
  if (att.length > 0) {
    const only = att.length === 1 ? att[0] : undefined;
    return only !== undefined && (top === null || only === top) ? only : null;
  }
  if (top === null || unsupported(top)) return null;
  return cands.some((p) => p !== top && p.team !== null && named.has(p.team)) ? null : top;
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
  const byKey = new Map<string, Held[]>();
  const bySurname = new Map<string, Held[]>();
  let size = 0;
  for (const p of universe) {
    if (!Number.isSafeInteger(p.espn_id) || p.espn_id <= 0) continue;
    const merged = mergeName(p.full_name);
    if (merged === null) continue;
    const tokens = merged.split(" ");
    if (tokens.length < 2) continue;
    const player: Held = {
      espn_id: p.espn_id,
      full_name: p.full_name,
      team: p.team,
      gsis_id: p.gsis_id !== null && GSIS_ID_RE.test(p.gsis_id) ? p.gsis_id : null,
      percent_owned: percentOwnedOf(p.percent_owned),
      suffix: suffixOf(p.full_name),
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
    const mentions = teamMentions(text).filter(
      (m) =>
        !names.some((s) => m.start < s.end && s.start < m.end) &&
        !surnames.has(mergeName(m.words) ?? ""),
    );
    const subject = new Set(mentions.filter((m) => !m.opponent).map((m) => m.team));
    // a game the item names: both its teams kept (a mention read as a name's word is no team)
    const kept = new Set(mentions.map((m) => m.start));
    const inPair = (m: (typeof mentions)[number]): boolean =>
      m.pair !== null && kept.has(m.pair.start);
    const opponentOnly = (cue: "before" | "after") =>
      new Set(
        mentions
          .filter((m) => m.cue === cue && !inPair(m) && !subject.has(m.team))
          .map((m) => m.team),
      );
    const cues: SubjectCues = {
      games: new Set(mentions.filter(inPair).map((m) => m.team)),
      strong: opponentOnly("before"),
      weak: opponentOnly("after"),
    };
    // every team the item names, the subject's or an opponent (a loose mention may be either)
    const named = new Set(mentions.map((m) => m.team));
    const onTeam = (p: NewsUniversePlayer): boolean => p.team !== null && subject.has(p.team);

    // 3. who each name is (the item's subject is its first full name)
    const subjectKey = names[0]?.entry.key.join(" ");
    for (const occ of names) {
      const { at, entry } = occ;
      // his own team as the item ties it to the name: written next to it, or the team of a roster
      // move it states ("Bengals sign CB Lamar Jackson", "…: Signs with Bengals")
      const attached = new Set([
        ...attachedTeams(text, mentions, occ.start, occ.end),
        ...movedTeams(text, mentions, occ.start, occ.end),
      ]);
      const p =
        entry.players.length === 1
          ? entry.players[0]
          : sharedHolder(
              entry.players,
              { suffix: occ.suffix, attached, subject: entry.key.join(" ") === subjectKey },
              cues,
              named,
            );
      if (p === undefined || p === null) continue;
      const own = onTeam(p) || (p.team !== null && attached.has(p.team));
      add(p, own ? "full_name_team" : "full_name", at);
    }

    // 4. bare surnames on a team the item names
    for (let i = 0; i < tokens.length && named.size > 0; i++) {
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
        if (!LEAD_WORDS.has(prev.norm) && !TEAM_WORDS.has(prev.norm)) continue;
      }
      const next = tokens[i + 1];
      if (next !== null && next !== undefined && !next.breakBefore && next.capital) {
        if (!TEAM_WORDS.has(next.norm) && !LEAD_WORDS.has(next.norm)) continue;
      }
      const sharers = bySurname.get(t.norm);
      if (sharers === undefined) continue;
      // a team attached to the surname decides ("Browns LB Jefferson", "Vikings WR Jefferson
      // torches Browns"): the one player of it on that team
      const att = attachedTeams(text, mentions, t.start, t.end);
      const onAttached = sharers.filter((p) => p.team !== null && att.has(p.team));
      if (onAttached.length > 0) {
        if (onAttached.length === 1 && onAttached[0] !== undefined)
          add(onAttached[0], "last_name_team", i);
        continue;
      }
      const here = sharers.filter(onTeam);
      const only = here.length === 1 ? here[0] : undefined;
      if (only === undefined) continue;
      // a far more widely rostered player of the surname, on a team the item does not name, may be
      // its subject facing this one ("Jefferson torches Browns")
      if (sharers.some((x) => x !== only && outshines(x, only))) continue;
      add(only, "last_name_team", i);
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
