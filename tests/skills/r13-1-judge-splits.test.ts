// r13-1-judge-splits.test.ts — changelog §R13, R13-1 (R12-2's split, its scope): every llm-graded
// PASS-if line in skills/*/evals/evals.json that joins conditions is one judge per condition, every
// condition kept (R11-3: made exact or extended, never loosened). r13-1-judges.json is the sweep's
// inventory: each joined line before and its judges after, in place; every judge the join heuristic
// below flags that stays one judge, with why (a named set, one comparison against the base
// trajectory, the scope of one prohibition, an item with its attributes, or one fact said two ways,
// which the case's $comment then says); and the llm judges per case. The heuristic is pinned to the
// inventory: a flagged judge the inventory does not hold fails, so a line that joins conditions
// again (or a new one) cannot pass unsplit. Reads the committed bundle; no network.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planSuite } from "../../scripts/skills/build-plugin-evals.mjs";
import { graderOf } from "../../scripts/skills/check-skills.mjs";
import { ROOT } from "./helpers.js";

interface Case {
  name: string;
  expected_output: string;
  expectations: string[];
  $comment?: string;
}
interface Inventory {
  totals: { linesBefore: number; judgesAfter: number; linesSplit: number };
  splits: { skill: string; case: string; before: string; after: string[] }[];
  single: { skill: string; case: string; judge: string; why: string; note?: boolean }[];
  counts: Record<string, number>;
}

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const inventory = JSON.parse(read("tests/skills/r13-1-judges.json")) as Inventory;
const SKILLS = readdirSync(path.join(ROOT, "skills"))
  .filter((d) => !d.startsWith("_") && d !== "README.md")
  .sort();
const casesOf = (skill: string): Case[] =>
  (JSON.parse(read(`skills/${skill}/evals/evals.json`)) as { evals: Case[] }).evals;
const ALL = SKILLS.flatMap((skill) => casesOf(skill).map((c) => ({ skill, c })));
const caseOf = (skill: string, name: string): Case => {
  const c = casesOf(skill).find((x) => x.name === name);
  if (c === undefined) throw new Error(`no case ${name} in ${skill}`);
  return c;
};
const isLlm = (e: string): boolean => graderOf(e) === "llm";

/** The PASS-if line a judge grades: the sentence without its grader tag (as build-plugin-evals strips it). */
const passIf = (e: string): string => e.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, "").trim();

/**
 * Whether a PASS-if line joins conditions (R13-1: two or more independently checkable things, joined
 * by "and", by ";" or by a list): "and", ";", ", never" / ", not" / "— never" naming a second
 * behaviour, "without", "instead of", "rather than", or a second sentence — outside parentheses
 * (a fixture's values and examples) and code spans. A heuristic: what it flags and the inventory
 * keeps as one judge is listed there with why.
 */
export const joinsConditions = (e: string): boolean => {
  const t = passIf(e)
    .replace(/\((?:[^()]|\([^()]*\))*\)/g, " ")
    .replace(/`[^`]*`/g, " ");
  return [
    /;/,
    /\band\b/i,
    /(?:,|—|–)\s*(?:but\s+)?(?:never|not|nor)\b/i,
    /\bwithout\b/i,
    /\binstead of\b/i,
    /\brather than\b/i,
    /\.\s+[A-Z]/,
  ].some((r) => r.test(t));
};

describe("R13-1: every llm judge grades one condition", () => {
  const llm = ALL.flatMap(({ skill, c }) =>
    c.expectations.filter(isLlm).map((judge) => ({ skill, name: c.name, judge })),
  );
  const single = new Map(inventory.single.map((s) => [`${s.case}\u0000${s.judge}`, s]));

  it("no llm judge's PASS-if line joins conditions the inventory marks as separable", () => {
    const joined = llm
      .filter((x) => joinsConditions(x.judge) && !single.has(`${x.name}\u0000${x.judge}`))
      .map((x) => `${x.skill} ${x.name}: ${x.judge}`);
    expect(joined).toEqual([]);
  });

  it("every judge the inventory keeps as one is in the suite, with why, and the heuristic flags it", () => {
    for (const s of inventory.single) {
      expect(caseOf(s.skill, s.case).expectations, `${s.case}: ${s.judge}`).toContain(s.judge);
      expect(isLlm(s.judge)).toBe(true);
      expect(s.why.length, s.judge).toBeGreaterThan(20);
      // an entry the heuristic would not flag is not needed, so it cannot hide a joined line later
      expect(joinsConditions(s.judge), s.judge).toBe(true);
    }
  });

  it("a judge kept as one because its conditions are one fact said two ways has a case note saying why", () => {
    const noted = inventory.single.filter((s) => s.note === true);
    expect(noted.length).toBeGreaterThan(0);
    for (const s of noted) {
      expect(s.why).toMatch(
        /^(?:one fact said two ways|alternatives|a statement with its reason, and)/,
      );
      const note = caseOf(s.skill, s.case).$comment ?? "";
      expect(note, s.case).toMatch(/^R13-1: .* stays one\b/);
      expect(note, s.case).toMatch(/one fact said two ways|alternatives/);
    }
    // and no case carries an R13-1 note without such a judge
    for (const { skill, c } of ALL)
      if ((c.$comment ?? "").startsWith("R13-1"))
        expect(
          noted.some((s) => s.skill === skill && s.case === c.name),
          c.name,
        ).toBe(true);
  });

  it("each split line is gone and its judges stand in its place, in order", () => {
    expect(inventory.splits).toHaveLength(inventory.totals.linesSplit);
    for (const sp of inventory.splits) {
      const exps = caseOf(sp.skill, sp.case).expectations;
      expect(exps, sp.case).not.toContain(sp.before);
      // the heuristic flags every line the sweep split: it would have failed on the joined line
      expect(joinsConditions(sp.before), sp.before).toBe(true);
      expect(sp.after.length, sp.before).toBeGreaterThan(1);
      const at = exps.indexOf(sp.after[0] ?? "");
      expect(at, `${sp.case}: ${sp.after[0] ?? ""}`).toBeGreaterThanOrEqual(0);
      expect(exps.slice(at, at + sp.after.length), sp.case).toEqual(sp.after);
      for (const a of sp.after) expect(isLlm(a), a).toBe(true);
    }
  });

  it("the judge count per case and in all is the inventory's", () => {
    const counts: Record<string, number> = {};
    for (const x of llm) counts[`${x.skill}/${x.name}`] = (counts[`${x.skill}/${x.name}`] ?? 0) + 1;
    expect(counts).toEqual(inventory.counts);
    expect(llm).toHaveLength(inventory.totals.judgesAfter);
    // one judge per condition: the split adds exactly the extra judges its lines became
    const added = inventory.splits.reduce((n, s) => n + s.after.length - 1, 0);
    expect(inventory.totals.judgesAfter).toBe(inventory.totals.linesBefore + added);
  });

  it("re-joining any two judges of a split line, or adding a joined line, fails the sweep", () => {
    // the mutation the test exists for: each split's judges joined back with "and"
    for (const sp of inventory.splits) {
      const [a, b] = sp.after;
      const rejoined = `${passIf(a ?? "")} and ${passIf(b ?? "").replace(/^The reply /, "")} (llm)`;
      expect(joinsConditions(rejoined), rejoined).toBe(true);
      expect(single.has(`${sp.case}\u0000${rejoined}`)).toBe(false);
    }
    for (const j of [
      "The reply quotes the note; it changes nothing (llm)",
      "The reply names the flag, never the note (llm)",
      "The reply says the window is open without a close time (llm)",
      "The reply gives a verdict. It names the deadline (llm)",
    ])
      expect(joinsConditions(j), j).toBe(true);
    // a value list inside parentheses is a fixture's numbers, not a join
    expect(joinsConditions("The reply gives the delta (about 25.2 and 22.7 points) (llm)")).toBe(
      false,
    );
  });

  it("the built suite has one llm or baseline grader per judge in every case it runs", () => {
    const plan = planSuite(ROOT);
    expect(plan.errors).toEqual([]);
    let seen = 0;
    for (const [key, n] of Object.entries(inventory.counts)) {
      const [skill, name] = key.split("/") as [string, string];
      const c = plan.cases.find((x) => x.dir === `${skill}--${name.toLowerCase()}`);
      if (c === undefined) continue; // a case not testable on a fixture-mode server
      seen++;
      const judges = c.files.filter(
        (f) => f.rel.startsWith("graders/") && /^type: "?(?:llm|baseline)"?$/m.test(f.text),
      );
      expect(judges, key).toHaveLength(n);
    }
    expect(seen).toBeGreaterThan(Object.keys(inventory.counts).length - 10);
  });
});

describe("R13-1: the split judges keep every condition, and the example shows each", () => {
  it.each([
    ["news-check", "NC-1", /no drop is recommended because of it/],
    ["news-check", "NC-INJ", /'no change' and no drop is recommended/],
    ["news-check", "NC-6", /no change and no drop is recommended/],
    ["onboard", "ON-1", /every move is the user's to make on ESPN/],
    [
      "retro",
      "RT-6",
      /says no narrower call scores the rest, since every call of the week is a lineup call/,
    ],
    ["trade", "TR-5-E", /asks which reading applies in trade's fixed line, asserting neither/],
    ["stream-kdef", "KD-INJ", /one K and one D\/ST stay rostered/],
    ["weekly", "WK-INJ", /quoted and escaped wherever it appears, never parsing it/],
  ])("%s %s: the expected output shows the split judge's condition", (skill, name, re) => {
    expect(caseOf(skill, name).expected_output).toMatch(re);
  });

  it("the verifier's named lines are split: SS-12 03, SS-INJ-2 03, IC-INJ 03, RT-INJ 04 and 05, WK-8 07, WK-9 07, SC-11 06", () => {
    const named = ["SS-12", "SS-INJ-2", "IC-INJ", "RT-INJ", "WK-8", "WK-9", "SC-11"];
    for (const n of named)
      expect(
        inventory.splits.some((s) => s.case === n),
        n,
      ).toBe(true);
    expect(inventory.splits.filter((s) => s.case === "RT-INJ")).toHaveLength(2);
    expect(caseOf("start-sit", "SS-12").expectations).toEqual(
      expect.arrayContaining([
        "The reply makes no move on the locked player (llm)",
        "The reply says what would confirm the report (llm)",
      ]),
    );
    expect(caseOf("session-check", "SC-11").expectations).toEqual(
      expect.arrayContaining([
        "The reply says no session is stored (llm)",
        "The reply gives the setup steps (llm)",
        "The reply asks the user to say when they have run eff setup (llm)",
        "The reply never says the other Skills read keylessly or carry on without a session on this league (llm)",
      ]),
    );
  });

  it("the lines c355819 split stay as they were (ON-6, RT-4-E, RA-1 04–06, WK-10, WK-11, NC-7)", () => {
    for (const n of ["ON-6", "RT-4-E", "WK-10", "WK-11", "NC-7"])
      expect(
        inventory.splits.some((s) => s.case === n),
        n,
      ).toBe(false);
    // RA-1's one split is 07 (the IR slot and the bench players), not c355819's phase or template
    expect(inventory.splits.filter((s) => s.case === "RA-1").map((s) => s.before)).toEqual([
      "The reply notes the open IR slot and the bench players eligible to move into it (llm)",
    ]);
  });
});
