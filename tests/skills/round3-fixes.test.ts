// round3-fixes.test.ts — round 3's Skill-text fixes are held by check-skills (docs/evals/
// stage-c-plugin-eval.md, "Run of 2026-11-14, round 3 (after §R10)", #### skill_text_defect and
// Next steps item 2): every fixed sentence fails the check when it is cut, the withdrawn wording
// fails it when it comes back, the frontmatter words fail it when dropped, and orient's sentences
// fail in every copy the build writes. Each runs on a temporary copy of the bundle; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ORIENT_SENTENCES,
  ROUND3_ABSENT,
  ROUND3_FIXED,
  ROUND3_FRONTMATTER,
  SEEDING_RULE_SENTENCE,
  checkSkills,
  orientRoutingProblems,
} from "../../scripts/skills/check-skills.mjs";
import { buildSkills } from "../../scripts/skills/build-skills.mjs";
import { ROOT, SKILLS, emptyDenylist, tempRepo, type TempRepo } from "./helpers.js";

let deny: ReturnType<typeof emptyDenylist>;
beforeAll(() => {
  deny = emptyDenylist();
});
afterAll(() => {
  deny.cleanup();
});
let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});
const fresh = (): TempRepo => {
  repo = tempRepo();
  return repo;
};
const errorsOf = (t: TempRepo): string =>
  checkSkills({ root: t.root, scan: false, scanEnv: deny.env }).errors.join("\n");

type Fixed = Record<string, Record<string, Record<string, string>>>;
type Absent = Record<string, Record<string, string[]>>;
const fixed = ROUND3_FIXED as Fixed;
const absent = ROUND3_ABSENT as Absent;
const fixedRows = Object.entries(fixed).flatMap(([skill, files]) =>
  Object.entries(files).flatMap(([file, sentences]) =>
    Object.entries(sentences).map(([k, s]) => [skill, file, k, s] as const),
  ),
);
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("round 3's fixed sentences", () => {
  it("the committed bundle carries every one, and none of the withdrawn wording", () => {
    for (const [skill, file, , s] of fixedRows)
      expect(read(`skills/${skill}/${file}`)).toContain(s);
    for (const [skill, files] of Object.entries(absent))
      for (const [file, gone] of Object.entries(files))
        for (const t of gone) expect(read(`skills/${skill}/${file}`)).not.toContain(t);
    const t = fresh();
    expect(errorsOf(t)).toBe("");
  });

  it.each(fixedRows)("%s/%s: cutting %s fails the check", (skill, file, k, s) => {
    const t = fresh();
    t.edit(`skills/${skill}/${file}`, s, "");
    expect(errorsOf(t)).toContain(
      `skills/${skill}/${file}: round 3's fixed sentence "${k}" is missing: "${s}"`,
    );
  });

  it.each(
    Object.entries(absent).flatMap(([skill, files]) =>
      Object.entries(files).flatMap(([file, gone]) => gone.map((g) => [skill, file, g] as const)),
    ),
  )("%s/%s: the withdrawn wording fails when it comes back: %s", (skill, file, g) => {
    const t = fresh();
    t.write(`skills/${skill}/${file}`, `${t.read(`skills/${skill}/${file}`)}\n${g}\n`);
    expect(errorsOf(t)).toContain(
      `skills/${skill}/${file}: text round 3's triage withdrew is still there: "${g}"`,
    );
  });
});

describe("round 3's frontmatter words", () => {
  const rows = Object.entries(
    ROUND3_FRONTMATTER as Record<string, Record<string, string[]>>,
  ).flatMap(([skill, keys]) =>
    Object.entries(keys).flatMap(([key, words]) => words.map((w) => [skill, key, w] as const)),
  );
  it.each(rows)("%s's %s loses %s: the check fails", (skill, key, w) => {
    const t = fresh();
    t.edit(`skills/${skill}/SKILL.md`, w, "x");
    expect(errorsOf(t)).toContain(
      `skills/${skill}/SKILL.md: frontmatter ${key} must carry "${w}" (round 3's triage; the trigger suite relies on it)`,
    );
  });
});

describe("orient's round-3 sentences, in every copy", () => {
  const shared = read("skills/_shared/references/orient.md");
  it("the hand-off line, the partial answer and the Seeding row's gloss are in the shared orient", () => {
    expect(shared).toContain(ORIENT_SENTENCES.handOff);
    expect(shared).toContain(ORIENT_SENTENCES.partialKeeps);
    expect(ORIENT_SENTENCES.seedingRule).toBe(SEEDING_RULE_SENTENCE);
    // the gloss sits in the Seeding row, right after the line it explains
    expect(shared).toMatch(
      /^\| `seeding\.confirmed: false` \|[^\n]*to record it" — and continue\. ESPN's rule — record first, total points as the tiebreak;[^\n]*\|$/m,
    );
    // the hand-off line is the one fixed line the answer ends with
    expect(ORIENT_SENTENCES.handOff).toContain(
      '"Hand-off: the `espn-fantasy-football:session-check` Skill takes it from here — `eff setup` in a terminal."',
    );
    expect(orientRoutingProblems(shared)).toEqual([]);
  });

  it("the command is given once, in the hand-off line, which follows the apply line (the round-4 refix's VS-5)", () => {
    expect(ORIENT_SENTENCES.partialKeeps).toMatch(
      /gives the command once, in that line: a section that names a session-refusal line points to the hand-off line and never repeats the command\.$/,
    );
    expect(shared).toContain(ORIENT_SENTENCES.handOffAfterApply);
    // the two sentences sit in the hand-off paragraph, after the fixed line itself
    const para = shared.split("\n").find((l) => l.startsWith("**The hand-off line.**")) ?? "";
    expect(para).toContain(ORIENT_SENTENCES.handOff);
    expect(para).toContain(ORIENT_SENTENCES.partialKeeps);
    expect(para).toContain(ORIENT_SENTENCES.handOffAfterApply);
    // weekly's League activity section leaves the command to that line
    const weekly = read("skills/weekly/SKILL.md");
    expect(weekly).toContain(
      "give the one command — in a terminal, `eff setup` — only in the hand-off line that ends the briefing",
    );
  });

  it.each(["handOff", "partialKeeps", "seedingRule", "handOffAfterApply"] as const)(
    "cutting %s from the shared orient fails every rebuilt copy",
    (k) => {
      const t = fresh();
      t.edit("skills/_shared/references/orient.md", ORIENT_SENTENCES[k], "");
      buildSkills({ root: t.root });
      const e = errorsOf(t);
      for (const skill of SKILLS)
        expect(e).toContain(
          `skills/${skill}/references/orient.md: the fixed sentence "${k}" is missing`,
        );
    },
  );
});
