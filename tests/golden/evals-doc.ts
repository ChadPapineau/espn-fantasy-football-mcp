// evals-doc.ts — keeps a generated section of a docs/evals/ page equal to what a test computes (plan
// 10 §3.1a: reported numbers live in docs/evals/; the 1a-backtest pattern, any page): a section sits
// between `<!-- name:start -->` and `<!-- name:end -->`; UPDATE_EVALS=1 rewrites it, otherwise the
// test asserts the committed text equals the run's.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EVALS = path.resolve(import.meta.dirname, "../../docs/evals");
const marker = (name: string, edge: "start" | "end"): string => `<!-- ${name}:${edge} -->`;

function bounds(page: string, name: string): { text: string; a: number; b: number; file: string } {
  const file = path.join(EVALS, page);
  const text = readFileSync(file, "utf8");
  const a = text.indexOf(marker(name, "start"));
  const b = text.indexOf(marker(name, "end"));
  if (a < 0 || b < a) throw new Error(`docs/evals/${page} has no ${name} section`);
  return { text, a, b, file };
}

/** The committed text of a generated section of `docs/evals/<page>`. */
export function evalsSection(page: string, name: string): string {
  const { text, a, b } = bounds(page, name);
  return text.slice(a + marker(name, "start").length, b).trim();
}

/** Rewrites a generated section of `docs/evals/<page>` (UPDATE_EVALS=1 only). */
export function writeEvalsSection(page: string, name: string, body: string): void {
  const { text, a, b, file } = bounds(page, name);
  writeFileSync(
    file,
    `${text.slice(0, a + marker(name, "start").length)}\n${body}\n${text.slice(b)}`,
  );
}
