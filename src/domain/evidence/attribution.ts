// attribution.ts — which claims of a third-party text are about the player E10 weighs (plan 07 E10;
// plan 10 C8: every logged claim calibrates its source's reliability; plan 02 §6.4: text is data).
// Stage C finding evidence-item-claims-misattributed, ruling R7-4 (fail safe instead of smarter
// parsing): the news matcher attaches one item to every player it names, so a text that names more
// than one player says things about each of them. In such a text a claim is the subject's only when it
// can be tied to him with certainty — its clause names him and no other player, OPENS with his name,
// and the claim's own words follow the name directly, with nothing between but an injury in
// parentheses, a colon and auxiliary verbs ("Quist (ankle) was ruled out", "Dorian Quist: Ruled out
// for Week 5", "Ostrander to start"). Every other claim of the text is `ambiguous_multi_player`:
// shown, wrapped, under that label, and never his — never logged, scored or weighed. Three rounds of
// smarter parsing (clause and phrase splits, joiner words, a pronoun check) each kept a wording that
// carried a teammate's claim onto the subject: "X ruled out, Y to start", "With him sidelined, Y
// figures to start", "Y steps in for the sidelined starter". This rule resolves no reference at all,
// so no wording of another player's news can satisfy it; what it costs is some of the subject's own
// claims, which fall to the label too. A clause is only the unit a claim is read in (the extractor
// reads one claim per clause); splitting there can lose a claim, never adopt one. Moved here from
// src/mcp/tools/market-p1.ts (the name keys, the clause split). Pure.
import { MAX_NAME_CHARS, mergeName, NAME_SUFFIXES } from "../crosswalk/normalize.js";
import { claimFold, claimHit } from "./claims.js";

/** The folded keys a player is named by in news text: his surname and his whole name run together. */
export interface NameKeys {
  /** The last token of his folded name (`mergeName`: suffixes and punctuation gone). */
  readonly surname: string;
  /** Every token run together (`Smith Njigba` and `Smith-Njigba` both read `smithnjigba`). */
  readonly whole: string;
  /**
   * His first name when it can stand for him in text ("in place of Dorian, who is out"): two or more
   * tokens, three or more letters, not an English word as well (Will, Mark, Chase …); null otherwise.
   * Read only to see ANOTHER player named — never to name the subject.
   */
  readonly given: string | null;
  /** Every folded token of his name. */
  readonly tokens: readonly string[];
}

/** First names that are English words too: as a key they would see a player in ordinary prose. */
const COMMON_WORD_NAMES: ReadonlySet<string> = new Set([
  "will",
  "mark",
  "chase",
  "miles",
  "hunter",
  "grant",
  "frank",
  "rich",
  "bill",
  "art",
  "jack",
  "ray",
  "rob",
  "sterling",
  "august",
  "earl",
  "dale",
  "guy",
  "major",
  "king",
  "young",
  "hope",
  "faith",
  "pat",
  "sky",
  "jet",
  "cash",
  "case",
  "lane",
  "dean",
  "van",
  "del",
  "von",
  "don",
  "bo",
  "jay",
  "kenny",
  "joe",
  "max",
  "rush",
  "price",
  "gage",
  "page",
  "sam",
  "drew",
  "wade",
  "dee",
]);

/** A player's NameKeys, or null when his name does not fold (non-Latin, empty) or its surname is one letter. */
export function nameKeysOf(name: string): NameKeys | null {
  const m = mergeName(name);
  const tokens = m === null ? [] : m.split(" ").filter((t) => t.length > 0);
  const surname = tokens[tokens.length - 1];
  if (surname === undefined || surname.length < 2) return null;
  const first = tokens[0];
  const given =
    tokens.length >= 2 && first !== undefined && first.length >= 3 && !COMMON_WORD_NAMES.has(first)
      ? first
      : null;
  return { surname, whole: tokens.join(""), given, tokens };
}

/**
 * The folded words of a piece of text, read as a name is folded: each word with its punctuation
 * dropped (`Ostrander's` → `ostranders`, `Smith-Njigba` → `smithnjigba`), each part between its
 * punctuation (`Quist/Ostrander`), and every run of two or three adjacent words joined (a spaced
 * compound surname). A word that does not fold (symbols, non-Latin) contributes nothing; with
 * `capitalised`, neither does a word (or a part) that does not start with a capital letter — the
 * form a name takes in prose ("before Thursday's lock" names no Drew Lock).
 */
function foldedWords(text: string, capitalised = false): ReadonlySet<string> {
  const out = new Set<string>();
  const words: string[] = [];
  const capital = (w: string): boolean =>
    !capitalised || /^\p{Lu}/u.test(w.replace(/^\P{L}+/u, ""));
  for (const w of text.split(/\s+/u)) {
    if (w.length === 0 || w.length > MAX_NAME_CHARS) continue;
    const f = capital(w) ? (mergeName(w)?.replaceAll(" ", "") ?? "") : "";
    words.push(f);
    if (f.length > 0) out.add(f);
    for (const part of w.split(/\p{P}+/u)) {
      const g = part.length === 0 || !capital(part) ? null : mergeName(part);
      if (g !== null) out.add(g.replaceAll(" ", ""));
    }
  }
  for (let i = 0; i < words.length; i++) {
    let run = words[i] ?? "";
    for (let j = i + 1; j < Math.min(words.length, i + 3); j++) {
      const next = words[j] ?? "";
      if (next.length === 0) break;
      run += next;
      if (run.length > 0) out.add(run);
    }
  }
  return out;
}

/** Whether folded words name a player: his surname or whole name, possessive (`…s`) included. */
function namesPlayer(words: ReadonlySet<string>, k: NameKeys): boolean {
  return (
    words.has(k.surname) ||
    words.has(`${k.surname}s`) ||
    words.has(k.whole) ||
    words.has(`${k.whole}s`)
  );
}

/**
 * The keys among `keys` whose player a text names as a name is written — a capitalised surname or
 * whole name, possessive included (the players around the subject, whom no matcher confirmed).
 */
export function namedIn(text: string, keys: readonly NameKeys[]): readonly NameKeys[] {
  if (keys.length === 0) return [];
  const words = foldedWords(text, true);
  return keys.filter((k) => namesPlayer(words, k));
}

/**
 * Whether a piece of text names any of `others`, in any case: his surname or whole name, or his first
 * name unless the subject shares it ("Josh Allen" names no "Josh Jacobs").
 */
function namesAnother(text: string, subject: NameKeys, others: readonly NameKeys[]): boolean {
  const words = foldedWords(text);
  return others.some(
    (o) =>
      namesPlayer(words, o) ||
      (o.given !== null && !subject.tokens.includes(o.given) && words.has(o.given)),
  );
}

/**
 * Where a text splits into clauses: sentence ends, semicolons, dashes and line breaks. A period after
 * an initial or a name suffix ("D.J. Moore", "Kyle Pitts Sr. (ankle) ruled out") ends no sentence:
 * split there, the claim would lose the name it follows.
 */
export const CLAUSE_SPLIT =
  /(?<=[;!?])\s+|(?<=\.)(?<!(?:^|[\s.(])(?:[a-z]|jr|sr|ii|iii|iv|st|vs|no|dr|mr|mt|ft)\.)\s+|\s+[—–-]\s+|\n+/iu;

/**
 * The words that may stand between the subject's name and his claim's words: auxiliary verbs and
 * the few adverbs that only qualify them ("Quist has been ruled out", "Quist was officially placed on
 * IR"). A closed list — a word outside it (a verb of his own, a noun, a comma) means the claim's words
 * may be about someone else ("Ostrander replaces the sidelined veteran").
 */
const AUXILIARIES: ReadonlySet<string> = new Set([
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "remains",
  "remain",
  "remained",
  "officially",
  "also",
  "again",
  "now",
  "still",
  "reportedly",
]);

/** The most words an injury in parentheses may hold ("(ankle)", "(high ankle sprain)"). */
const PARENTHETICAL_MAX_WORDS = 6;

/**
 * How many leading words of `words` (a folded clause's words before its claim) are the subject's
 * name — his whole name (a generational suffix after it included) or his surname alone — or 0. A
 * possessive (`ostrander's`) is no match: what follows it is someone or something else of his.
 */
function nameWords(words: readonly string[], subject: NameKeys): number {
  for (let n = Math.min(words.length, subject.tokens.length + 1); n >= 1; n--) {
    const m = mergeName(words.slice(0, n).join(" "));
    if (m === null) continue;
    const joined = m.replaceAll(" ", "");
    if (joined === subject.whole) {
      // a suffix the name carries in the text ("Kyle Pitts Sr.") is part of it
      const next = mergeName(words[n] ?? "");
      return next !== null && NAME_SUFFIXES.includes(next) ? n + 1 : n;
    }
    if (n === 1 && joined === subject.surname) {
      const next = mergeName(words[1] ?? "");
      return next !== null && NAME_SUFFIXES.includes(next) ? 2 : 1;
    }
  }
  return 0;
}

/**
 * Whether `gap` (the folded words between the subject's name and his claim's words) holds nothing
 * that could be the claim's own subject: at most one closed injury in parentheses, a colon, and
 * AUXILIARIES — or only the opening parenthesis of his injury, the claim its first words ("Quist
 * (high ankle sprain) is questionable" reads the sprain).
 */
function onlyAuxiliaries(gap: readonly string[]): boolean {
  if (gap.length === 1 && gap[0] === "(") return true;
  let parenthetical = false;
  for (let i = 0; i < gap.length; i++) {
    const w = gap[i] ?? "";
    if (w === ":" || AUXILIARIES.has(w)) continue;
    if (w.startsWith("(") && !parenthetical) {
      // the parenthetical closes before the claim starts, within its word cap
      let j = i;
      while (j < gap.length && !(gap[j] ?? "").endsWith(")")) j++;
      if (j >= gap.length || j - i + 1 > PARENTHETICAL_MAX_WORDS) return false;
      const inner = gap.slice(i, j + 1).join(" ");
      if (inner.slice(1, -1).includes("(") || inner.slice(1, -1).includes(")")) return false;
      parenthetical = true;
      i = j;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Whether one clause states its claim of the subject with certainty (the module header): it names no
 * other player, opens with his name, and the claim's words (`at`: their start in `claimFold(clause)`)
 * follow it with only a parenthetical injury, a colon and auxiliaries between.
 */
export function statesOfSubject(
  clause: string,
  at: number,
  subject: NameKeys,
  others: readonly NameKeys[],
): boolean {
  if (namesAnother(clause, subject, others)) return false;
  const pre = claimFold(clause).slice(0, at);
  // a colon written against the name or the injury reads as its own word
  const words = pre
    .replaceAll(":", " : ")
    .split(/\s+/u)
    .filter((w) => w.length > 0);
  const n = nameWords(words, subject);
  return n > 0 && onlyAuxiliaries(words.slice(n));
}

/** One claim-bearing clause of a text that names more than one player, and whom its claim is about. */
export interface ClauseClaim {
  /** The clause as written (trimmed): what E10 shows, wrapped with the text's own source tag. */
  readonly clause: string;
  /** `subject`: tied to him with certainty (statesOfSubject); anything else is never his. */
  readonly attribution: "subject" | "ambiguous_multi_player";
}

/**
 * The claim-bearing clauses of a text that names more than one player (CLAUSE_SPLIT; a clause with
 * no claim is left out), each tied to the subject or labelled `ambiguous_multi_player`. `subject`
 * null (his own name does not fold) or `others` null (another player the text names cannot be named):
 * nothing can be tied to him, so every claim is ambiguous.
 */
export function clauseClaims(
  text: string,
  subject: NameKeys | null,
  others: readonly NameKeys[] | null,
): readonly ClauseClaim[] {
  const out: ClauseClaim[] = [];
  for (const raw of text.split(CLAUSE_SPLIT)) {
    const clause = raw.trim();
    if (clause.length === 0) continue;
    const hit = claimHit(clause);
    if (hit === null) continue;
    const his =
      subject !== null && others !== null && statesOfSubject(clause, hit.at, subject, others);
    out.push({ clause, attribution: his ? "subject" : "ambiguous_multi_player" });
  }
  return out;
}
