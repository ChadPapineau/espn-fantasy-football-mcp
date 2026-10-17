// format.ts — the model-driven evaluation file and its record (plan 05 §6; plan 10 A10b; the record:
// docs/evals/model-driven-evals.md). It reads tests/evals/read-only.xml as the runner's ElementTree
// reads it, but strictly, and renders and reads the record's generated answer-key section. Light by
// design: no server import, so the unit-project format test stays cheap. The answers are re-derived
// from the built server by tests/e2e/model-evals.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
/** The evaluation file plan 05 §6 names (the runner's positional argument). */
export const EVAL_XML = path.join(ROOT, "tests", "evals", "read-only.xml");
/** The record of the set (a docs/evals/ page) and its generated section's name. */
export const RECORD_PAGE = "model-driven-evals.md";
export const KEY_SECTION = "answer-key";
/** The fixture league the run serves (plan 05 §6: the frozen fixture league, id 0). */
export const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
/** Plan 05 §6: ten questions; pass bar ≥ 8/10 [A-1]. */
export const QUESTIONS = 10;

/** The fixture's own manifest: its clock, the user's team, the final weeks. */
export const MANIFEST = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
  current_week: number;
  final_weeks: number[];
};

export interface QaPair {
  readonly question: string;
  readonly answer: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** One element's text as ElementTree's `.text` reads it: the five entities decoded, no markup. */
function textOf(raw: string, where: string): string {
  if (raw.includes("<") || raw.includes("]]>")) throw new Error(`${where}: markup inside the text`);
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(raw))
    throw new Error(`${where}: a bare '&' or an entity ElementTree does not define`);
  return raw.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ENTITIES[e] ?? "");
}

/**
 * The evaluation file read the way evaluation.py reads it (`ET.parse`, `findall(".//qa_pair")`, each
 * pair's `question` / `answer` `.text.strip()`), but strict. The grammar is evaluation.md's alone: an
 * optional XML declaration, comments only outside the pairs, and `<evaluation>` holding `<qa_pair>`s
 * of exactly `<question>` then `<answer>`, each a single text node. A comment or child element inside
 * a question would make `.text` stop short, so nothing the runner would read differently can pass.
 */
export function parseEvaluation(xml: string): QaPair[] {
  let s = xml.startsWith("﻿") ? xml.slice(1) : xml;
  const decl = /^<\?xml[^?]*\?>/.exec(s);
  if (decl !== null) s = s.slice(decl[0].length);
  /** Skips whitespace and comments (outside the pairs only). */
  const skip = (): void => {
    for (;;) {
      s = s.trimStart();
      if (!s.startsWith("<!--")) return;
      const end = s.indexOf("-->");
      if (end === -1) throw new Error("an unterminated comment");
      if (s.slice(4, end).includes("--")) throw new Error("'--' inside a comment");
      s = s.slice(end + 3);
    }
  };
  const tag = (t: string): void => {
    if (!s.startsWith(t)) throw new Error(`expected ${t} at: ${JSON.stringify(s.slice(0, 40))}`);
    s = s.slice(t.length);
  };
  const element = (name: string, where: string): string => {
    s = s.trimStart();
    tag(`<${name}>`);
    const end = s.indexOf(`</${name}>`);
    if (end === -1) throw new Error(`${where}: no </${name}>`);
    const text = textOf(s.slice(0, end), `${where} <${name}>`).trim();
    s = s.slice(end + name.length + 3);
    return text;
  };
  skip();
  tag("<evaluation>");
  const pairs: QaPair[] = [];
  for (;;) {
    skip();
    if (s.startsWith("</evaluation>")) break;
    const where = `qa_pair ${String(pairs.length + 1)}`;
    tag("<qa_pair>");
    const question = element("question", where);
    const answer = element("answer", where);
    s = s.trimStart();
    tag("</qa_pair>");
    pairs.push({ question, answer });
  }
  tag("</evaluation>");
  skip();
  if (s !== "") throw new Error(`content after </evaluation>: ${JSON.stringify(s.slice(0, 40))}`);
  return pairs;
}

let cached: QaPair[] | null = null;
/** The committed set (read lazily: a missing file fails the tests that need it, by name). */
export function committed(): QaPair[] {
  cached ??= parseEvaluation(readFileSync(EVAL_XML, "utf8"));
  return cached;
}

/** The committed question `n` (1-based). */
export function pair(n: number): QaPair {
  const p = committed()[n - 1];
  if (p === undefined) throw new Error(`no qa_pair ${String(n)}`);
  return p;
}

/** One derived answer: the question number, the answer, the tools its solver read (sorted). */
export interface KeyRow {
  readonly n: number;
  readonly answer: string;
  readonly tools: readonly string[];
}

/** The record's answer-key section for derived rows. */
export function keySection(rows: readonly KeyRow[]): string {
  const lines = ["| # | answer | tools the solver read |", "|---|---|---|"];
  for (const r of rows)
    lines.push(
      `| ${String(r.n)} | \`${r.answer}\` | ${r.tools.map((t) => `\`${t}\``).join(", ")} |`,
    );
  return lines.join("\n");
}

/** The answers of a rendered answer-key section, in row order. */
export function keyAnswers(section: string): string[] {
  return section
    .split("\n")
    .slice(2)
    .map((line) => {
      const m = /^\| (\d+) \| `([^`]*)` \|/.exec(line);
      if (m === null) throw new Error(`not an answer-key row: ${line}`);
      return m[2] ?? "";
    });
}
