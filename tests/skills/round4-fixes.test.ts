// round4-fixes.test.ts — round 4's Skill-text fixes are held by check-skills (docs/evals/
// stage-c-plugin-eval.md, "Run of 2026-11-18, round 4 (after §R11)", #### skill_text_defect,
// #### model_variance and Next steps item 2; changelog §R12, R12-1 to R12-3): every fixed line fails
// the check when it is cut, every frontmatter word fails it when dropped, orient's new sentences fail
// in every copy the build writes, the listing stays under its ceiling, and the trigger heuristic
// routes round 4's missed prompts to their own Skill. Each mutation runs on a temporary copy of the
// bundle; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ORIENT_SENTENCES,
  ROUND4_FIXED,
  ROUND4_FRONTMATTER,
  SKILLS_LISTING_MAX,
  TEMPLATE_PARTIAL_SESSION_LINE,
  checkSkills,
  phrases,
  routeScore,
} from "../../scripts/skills/check-skills.mjs";
import { buildSkills } from "../../scripts/skills/build-skills.mjs";
import { parseFrontmatter } from "../../scripts/skills/_lib.mjs";
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
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Every occurrence of `s`, literally (a fixed line may be repeated in its file). */
const every = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "g");

type Fixed = Record<string, Record<string, Record<string, string>>>;
const fixedRows = Object.entries(ROUND4_FIXED as Fixed).flatMap(([skill, files]) =>
  Object.entries(files).flatMap(([file, lines]) =>
    Object.entries(lines).map(([k, s]) => [skill, file, k, s] as const),
  ),
);
const frontmatterRows = Object.entries(
  ROUND4_FRONTMATTER as Record<string, Record<string, string[]>>,
).flatMap(([skill, keys]) =>
  Object.entries(keys).flatMap(([key, words]) => words.map((w) => [skill, key, w] as const)),
);
const ORIENT_ROUND4 = [
  "stopHolds",
  "stopSessionRejected",
  "stopSessionNone",
  "stopNotRead",
  "stopSteps",
  "stopNothingElse",
  "partialFirstLine",
] as const;

describe("round 4's fixed lines (changelog §R12, R12-1)", () => {
  it("the committed bundle carries every one, and the check is clean", () => {
    expect(fixedRows.length).toBeGreaterThanOrEqual(40);
    for (const [skill, file, , s] of fixedRows)
      expect(read(`skills/${skill}/${file}`)).toContain(s);
    const t = fresh();
    expect(errorsOf(t)).toBe("");
  });

  it.each(fixedRows)("%s/%s: cutting %s fails the check", (skill, file, k, s) => {
    const t = fresh();
    t.edit(`skills/${skill}/${file}`, every(s), "");
    expect(errorsOf(t)).toContain(
      `skills/${skill}/${file}: round 4's fixed line "${k}" is missing: "${s}"`,
    );
  });

  it("each case's fixed line is the wording the triage asked for", () => {
    const f = ROUND4_FIXED as Fixed;
    const line = (skill: string, k: string) => f[skill]?.["SKILL.md"]?.[k] ?? "";
    // the exact lines round 4's triage names (its #### skill_text_defect entries)
    expect(line("start-sit", "crossCheckHeader")).toBe("`| Starter | ESPN | Ours | pct |`");
    expect(line("roster-audit", "phaseLine")).toBe('"Phase: <phase> (<competing>)"');
    expect(line("waivers", "premiumLabel")).toBe('"Premium Π(k, W): N, band [low–high]"');
    expect(line("waivers", "failedClaim")).toBe(
      '"A failed claim costs nothing: you keep your place in the order."',
    );
    expect(line("waivers", "scrambleLabel")).toContain('"Scramble list"');
    expect(line("apply", "noAgreement")).toBe(
      '"Which change did you agree to? Name it, or ask the Skill that recommends it first."',
    );
    // the variance class's stated words (R12-1), each inside its fixed line
    expect(line("news-check", "priorsLine")).toContain("priors are hand-set");
    expect(line("onboard", "matchWords")).toContain("never a paraphrase");
    expect(line("onboard", "selfCheckLine")).toContain("mismatch");
    expect(line("injury-cascade", "roleHoldsColumn")).toContain("role holds");
    expect(line("stream-kdef", "impliedColumn")).toContain("Implied total");
    expect(line("stream-kdef", "afterRun")).toContain("free-agent add after the run");
    expect(line("retro", "followedColumn")).toContain("**Followed**");
    expect(line("start-sit", "unconfirmed")).toContain("unconfirmed");
    expect(line("weekly", "deadlineColumn")).toContain("**Deadline** column");
    expect(line("trade", "deltaHeader")).toMatch(/\| p10 \| p90 \|/);
  });

  it("the waivers usage read runs before the decision with a stated selector (WV-2, WV-8)", () => {
    const body = read("skills/waivers/SKILL.md");
    const usage = body.indexOf("the usage branch always runs");
    const decision = body.indexOf("### 5. The decision");
    expect(usage).toBeGreaterThan(-1);
    expect(usage).toBeLessThan(decision);
    // the selector is the pool selector the server accepts (src/mcp/bounds.ts poolSelectorSchema)
    expect(line4(body)).toMatch(
      /\{ "pool": \{ "status": [^}]+, "position": [^}]+, "top": 10 \} \}/,
    );
  });

  it("schedule-plan's sentences agree with scheduleStress.ts: the cost is what the streams leave", () => {
    const src = read("src/domain/analytics/scheduleStress.ts");
    // drop = full − have, where `have` is solved with the week's streams: the loss after the fixes
    expect(src).toMatch(/const have = solveWeek\(req\.roster, vals, stream\);/);
    expect(src).toMatch(/const drop = Math\.max\(0, full\.mean - have\.mean\);/);
    expect(src).toMatch(/bye_cluster_cost: out >= SCHEDULE\.clusterMin \? round\(drop, 2\) : 0/);
    // worst_weeks is the drop weighted by p_alive, largest first — never the count of starters out
    expect(src).toMatch(
      /\.sort\(\(a, b\) => b\.drop \* b\.weight\.importance - a\.drop \* a\.weight\.importance/,
    );
    // without the season simulation every week is weighted 1
    expect(src).toContain("every week weighted 1: no season simulation (P(alive) unknown)");
  });
});

/** waivers' step 4.4 (the line that holds the usage branch). */
function line4(body: string): string {
  return (
    body.split("\n").find((l) => l.startsWith("4. **P1:** under `full`, the usage branch")) ?? ""
  );
}

describe("round 4's frontmatter words", () => {
  it.each(frontmatterRows)("%s's %s loses %s: the check fails", (skill, key, w) => {
    const t = fresh();
    t.edit(`skills/${skill}/SKILL.md`, w, "x");
    expect(errorsOf(t)).toContain(
      `skills/${skill}/SKILL.md: frontmatter ${key} must carry "${w}" (round 4's triage; the trigger suite relies on it)`,
    );
  });

  it("the listing fits its ceiling with the new words (plan 07 §5.1 [A-4], never raised)", () => {
    expect(SKILLS_LISTING_MAX).toBe(4600);
    const r = checkSkills({ root: ROOT, scan: false, scanEnv: deny.env });
    const note = r.notes.find((n) => n.includes("the Skills listing")) ?? "";
    const chars = Number(/sends every turn is (\d+) chars/.exec(note)?.[1] ?? "NaN");
    expect(chars).toBeLessThanOrEqual(SKILLS_LISTING_MAX);
  });

  // the prompts round 4 missed, and the Lane 2 prompts news-check did not load on (NC-2, NC-6, NC-7 —
  // NC-INJ and NC-INJ-2 share NC-6's and NC-7's), routed by the collision heuristic (plan 09 §5.1
  // item 5): each matches its own Skill's when_to_use phrases, and no other Skill's more
  const whenToUse = new Map<string, string[][]>(
    SKILLS.map((s) => {
      const v = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.when_to_use;
      return [s, typeof v === "string" ? phrases(v) : []] as const;
    }),
  );
  it.each([
    [
      "news-check",
      "RotoWire says my tight end was limited in practice, but I think the official report said he didn't practise. Which is it?",
    ],
    ["news-check", "What is ESPN's outlook saying about James Cook III, and should I do anything?"],
    [
      "news-check",
      "Last week you logged something about my RB1. What did it say, and should I act on it now?",
    ],
    ["onboard", "Is seeding in this league by record or by total points?"],
    ["onboard", "Which team am I in this league?"],
    ["session-check", "The assistant stopped working"],
    ["trade", "Should I buy low on a struggling receiver?"],
  ])("%s owns %s", (skill, prompt) => {
    const own = routeScore(whenToUse.get(skill) ?? [], prompt);
    expect(own).toBeGreaterThan(0);
    for (const [other, ph] of whenToUse)
      if (other !== skill) expect(routeScore(ph, prompt), other).toBeLessThanOrEqual(own);
  });
});

describe("orient's round-4 sentences, in every copy", () => {
  const shared = read("skills/_shared/references/orient.md");
  it("the stop at Step 0 and the partial answer's first line are in the shared orient", () => {
    for (const k of ORIENT_ROUND4) expect(shared).toContain(ORIENT_SENTENCES[k]);
    const stop = shared.split("\n").find((l) => l.startsWith("**A stop at Step 0.**")) ?? "";
    for (const k of ORIENT_ROUND4.filter((x) => x.startsWith("stop")))
      expect(stop).toContain(ORIENT_SENTENCES[k]);
    // the stop's Session lines never read as the public-league line ON-6, WK-9 and SS-13 forbid
    for (const k of ["stopSessionRejected", "stopSessionNone"] as const) {
      expect(ORIENT_SENTENCES[k]).not.toMatch(/\b(?:this|the) league(?: is|['’]s) public\b/);
      expect(ORIENT_SENTENCES[k]).not.toMatch(/\breads are keyless\b/);
    }
    // the stopped answer names the command once: only the hand-off line carries `eff setup`
    expect(stop.match(/eff setup/g)).toHaveLength(1);
    expect(ORIENT_SENTENCES.stopNothingElse).toMatch(
      /`eff setup` appears once, in the hand-off line\.$/,
    );
    // the partial answer's first Confidence & freshness line names the rejection before any command
    expect(ORIENT_SENTENCES.partialFirstLine).toMatch(/"Partial: ESPN rejected the stored session/);
    expect(ORIENT_SENTENCES.partialFirstLine).not.toMatch(/eff setup|session-check/);
  });

  it.each(ORIENT_ROUND4)("cutting %s from the shared orient fails every rebuilt copy", (k) => {
    const t = fresh();
    t.edit("skills/_shared/references/orient.md", ORIENT_SENTENCES[k], "");
    buildSkills({ root: t.root });
    const e = errorsOf(t);
    for (const skill of SKILLS)
      expect(e).toContain(
        `skills/${skill}/references/orient.md: the fixed sentence "${k}" is missing`,
      );
  });
});

describe("the session line beside the hand-off (changelog §R12, R12-3)", () => {
  it("the output contract says the tool's line goes without its command when the hand-off line ends the answer", () => {
    expect(TEMPLATE_PARTIAL_SESSION_LINE).toContain(
      "when the answer ends with orient's hand-off line, said without its own command: `eff setup` appears once, in the hand-off line",
    );
    expect(read("skills/_shared/references/output-template.md")).toContain(
      TEMPLATE_PARTIAL_SESSION_LINE,
    );
  });

  it("the old line, without R12-3's clause, fails every Skill that carries the contract", () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/output-template.md",
      " — and, when the answer ends with orient's hand-off line, said without its own command: `eff setup` appears once, in the hand-off line (changelog §R10, R10-11, R10-12; §R12, R12-3).",
      " (changelog §R10, R10-11, R10-12).",
    );
    buildSkills({ root: t.root });
    const e = errorsOf(t);
    expect(e).toMatch(
      /skills\/weekly\/SKILL\.md: the output contract's session-refusal partial line is missing/,
    );
    expect(e).toMatch(
      /skills\/start-sit\/SKILL\.md: the output contract's session-refusal partial line is missing/,
    );
  });

  it("session-check's steps in a stop name the command once, by the hand-off line", () => {
    const body = read("skills/session-check/SKILL.md");
    const para =
      body
        .split("\n")
        .find((l) => l.startsWith("**Taking over from another Skill's stop at Step 0**")) ?? "";
    expect(para).toContain("run the command in the last line");
    expect(para).toContain("`eff setup` appears once, in the hand-off line.");
    // the paragraph's quoted steps never spell the command out
    const quoted = [...para.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(quoted.length).toBeGreaterThanOrEqual(2);
    for (const q of quoted) expect(q).not.toContain("eff setup");
  });
});
