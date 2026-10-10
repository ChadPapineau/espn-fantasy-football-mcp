// doc.ts — keeps docs/evals/phase3-waivers-seeding.md equal to what the Phase 3 waiver and seeding
// runs compute (plan 10 §3.3 C4, C5: the numbers live in docs/evals/): a section sits between
// `<!-- <name>:start -->` and `<!-- <name>:end -->`; UPDATE_EVALS=1 rewrites it, otherwise the test
// asserts equality, so a changed result can never leave a stale number behind. Also renders the C4
// seeding section from the reproductions (ids, codes and numbers only — team names never appear).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { SeasonReproduction } from "../../../../src/domain/analytics/seeding-reproduce/index.js";
import { ROOT } from "../../../lint/helpers.js";

/** The Phase 3 waiver-and-seeding evaluation report. */
export const EVAL_DOC = join(ROOT, "docs/evals/phase3-waivers-seeding.md");

const markers = (name: string): [string, string] => [
  `<!-- ${name}:start -->`,
  `<!-- ${name}:end -->`,
];

/** The current text of a section, or null when the markers are missing. */
export function docSection(name: string, file: string = EVAL_DOC): string | null {
  const text = readFileSync(file, "utf8");
  const [start, end] = markers(name);
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < i) return null;
  return text
    .slice(i + start.length, j)
    .replace(/^\n/, "")
    .replace(/\n$/, "");
}

/** UPDATE_EVALS=1 rewrites the section; otherwise the committed section must equal `body`. */
export function writeOrCompare(name: string, body: string, file: string = EVAL_DOC): void {
  const [start, end] = markers(name);
  if (process.env.UPDATE_EVALS === "1") {
    const text = readFileSync(file, "utf8");
    const i = text.indexOf(start);
    const j = text.indexOf(end);
    if (i < 0 || j < i) throw new Error(`${file}: the ${name} markers are missing`);
    writeFileSync(file, `${text.slice(0, i + start.length)}\n${body}\n${text.slice(j)}`);
    return;
  }
  expect(docSection(name, file), `${name} section of ${file} (UPDATE_EVALS=1 regenerates)`).toBe(
    body,
  );
}

const chainWords = (chain: readonly string[]): string =>
  chain
    .filter((c) => c !== "coin_flip")
    .map((c) => c.replaceAll("_", " "))
    .join(" → ");

/** The C4 table: one row per recorded league-season. */
export function docSectionOf(results: ReadonlyMap<string, SeasonReproduction>): string {
  const rows = [...results.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    "| league / season | teams | playoff field | divisions | rule (`By`) | regular games | records agree | (a) exact | (b) exact | deepest tiebreak used | findings |",
    "|---|---:|---:|---:|---|---:|---|---|---|---|---|",
  ];
  for (const [k, s] of rows)
    lines.push(
      `| ${k} | ${String(s.teams)} | ${String(s.playoff_team_count)} | ${String(s.divisions)} | ${s.rule} (${String(s.rule_by)}) | ${String(s.regular_games)} | ${s.records_agree ? "yes" : "no"} | ${s.espn_rule.exact ? "**yes**" : "no"} | ${s.points_only.exact ? "yes" : "no"} | ${s.espn_rule.deciding_level === null ? "none" : s.espn_rule.deciding_level.replaceAll("_", " ")} | ${s.findings.length === 0 ? "none" : s.findings.map((f) => f.code).join(", ")} |`,
    );
  const exact = rows.filter(([, s]) => s.espn_rule.exact).length;
  const chains = [...new Set(rows.map(([, s]) => chainWords(s.espn_rule.chain)))];
  lines.push(
    "",
    `Reading (a) reproduces **${String(exact)} of ${String(rows.length)}** league-seasons exactly (every team's \`playoffSeed\`, not only the playoff field). Chains applied: ${chains.map((c) => `\`${c}\``).join("; ")}. Reading (b) (points for alone) reproduces ${String(rows.filter(([, s]) => s.points_only.exact).length)}.`,
  );
  return lines.join("\n");
}
