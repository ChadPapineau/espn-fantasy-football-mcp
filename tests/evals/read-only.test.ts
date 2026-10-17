// read-only.test.ts — the model-driven evaluation file (plan 05 §6 and T7; plan 10 A10b; the record:
// docs/evals/model-driven-evals.md). tests/evals/read-only.xml holds the ten read-only questions in
// the mcp-builder evaluation.md format (`<evaluation><qa_pair><question/><answer/></qa_pair>`) over
// the derived league fixtures/espn/fx-10h (league id 0, weeks 1–4 final, week 5 not yet played). The
// model-driven RUN stays manual and pre-release because it spends model tokens. This test spends none.
// It holds the file the run reads:
//   - it parses exactly as the runner's ElementTree reads it (each element one text node, entities
//     only, ten pairs);
//   - every question names its weeks and its answer format and uses no "current state" wording
//     (evaluation.md's stability rule), and every answer is one short value for direct string
//     comparison;
//   - its answers are the record's answer key, row by row.
// The answers themselves are re-derived from the BUILT server, started with the documented run's
// environment, by tests/e2e/model-evals.test.ts (the process project). That test keeps the record's
// answer-key section equal to what the tools show, so this file, the record and the tools agree.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evalsSection } from "../golden/evals-doc.js";
import {
  KEY_SECTION,
  MANIFEST,
  QUESTIONS,
  RECORD_PAGE,
  ROOT,
  committed,
  keyAnswers,
  keySection,
  pair,
  parseEvaluation,
} from "./format.js";

describe("tests/evals/read-only.xml — the evaluation.md format (plan 05 §6)", () => {
  it("parses as the runner reads it: ten qa_pairs, each one question and one answer", () => {
    const pairs = committed();
    expect(pairs).toHaveLength(QUESTIONS);
    for (const p of pairs) {
      expect(p.question.length).toBeGreaterThan(40);
      expect(p.answer.length).toBeGreaterThan(0);
    }
    expect(new Set(pairs.map((p) => p.question)).size).toBe(QUESTIONS);
  });

  it("every answer is one short value for direct string comparison", () => {
    for (const p of committed()) {
      expect(p.answer, p.question).toMatch(/^[^\s"'`<>].{0,38}[^\s"'`<>.]$|^[^\s"'`<>.]$/);
      expect(p.answer).not.toMatch(/\n/);
    }
  });

  it("every question is stable and states its answer format (evaluation.md's stability rule)", () => {
    for (const p of committed()) {
      expect(p.question).not.toMatch(
        /\b(this week|current(ly)?|today|right now|so far|latest|this season)\b/i,
      );
      expect(p.question).toMatch(/\bAnswer (with|as)\b/);
    }
    // every question that is about results or rosters names its weeks; Q3 and Q9 read the settings
    for (const n of [1, 2, 4, 5, 6, 7, 8, 10]) expect(pair(n).question).toMatch(/\bweeks? \d/);
  });

  it("the strict reader refuses what ElementTree would read differently", () => {
    const one = "<qa_pair><question>Q?</question><answer>A</answer></qa_pair>";
    expect(parseEvaluation(`<evaluation>${one}</evaluation>`)).toEqual([
      { question: "Q?", answer: "A" },
    ]);
    expect(
      parseEvaluation(`<?xml version="1.0"?>\n<!-- c -->\n<evaluation>\n  ${one}\n</evaluation>\n`),
    ).toHaveLength(1);
    expect(
      parseEvaluation(
        "<evaluation><qa_pair><question>a &amp; b</question><answer>x &lt; y</answer></qa_pair></evaluation>",
      ),
    ).toEqual([{ question: "a & b", answer: "x < y" }]);
    for (const bad of [
      "<evaluation><qa_pair><question>a <!-- c --> b</question><answer>A</answer></qa_pair></evaluation>",
      "<evaluation><qa_pair><question>a & b</question><answer>A</answer></qa_pair></evaluation>",
      "<evaluation><qa_pair><question>Q<b>x</b></question><answer>A</answer></qa_pair></evaluation>",
      "<evaluation><qa_pair><answer>A</answer><question>Q</question></qa_pair></evaluation>",
      `<evaluation>${one}</evaluation><evaluation></evaluation>`,
      `<evaluation>${one}`,
      `<evaluation><qa_pair><question><![CDATA[Q]]></question><answer>A</answer></qa_pair></evaluation>`,
    ])
      expect(() => parseEvaluation(bad), bad).toThrow();
  });
});

describe("the file, the plan and the record agree", () => {
  it("the plan and the record name this file, the fixture league and the pass bar", () => {
    const plan = readFileSync(path.join(ROOT, "docs/plan/05-testing-strategy.md"), "utf8");
    expect(plan).toContain("`tests/evals/read-only.xml`");
    const record = readFileSync(path.join(ROOT, "docs/evals", RECORD_PAGE), "utf8");
    expect(record).toContain("tests/evals/read-only.xml");
    expect(record).toContain("tests/e2e/model-evals.test.ts");
    expect(record).toContain("fixtures/espn/fx-10h");
    expect(record).toMatch(/≥ 8\/10/);
    // the fixture state every question assumes: weeks 1–4 final, week 5 not yet played
    expect(MANIFEST.final_weeks).toEqual([1, 2, 3, 4]);
    expect(MANIFEST.current_week).toBe(5);
  });

  it("the committed answers are the record's answer key, row by row", () => {
    const section = evalsSection(RECORD_PAGE, KEY_SECTION);
    expect(keyAnswers(section)).toEqual(committed().map((p) => p.answer));
    // the section is the renderer's own output (the e2e test writes and checks it the same way)
    expect(section.split("\n").slice(0, 2).join("\n")).toBe(keySection([]));
  });
});
