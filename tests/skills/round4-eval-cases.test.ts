// round4-eval-cases.test.ts — round 3's eval-case fixes and the §R11 rulings on the eval build
// (docs/evals/stage-c-plugin-eval.md, "Run of 2026-11-14, round 3 (after §R10)", #### eval_case_defect
// and Next steps items 1 and 3; changelog §R11, R11-1 and R11-3): each llm judge grades its PASS-if
// line with the expected output as one example a reply need not match; AP-INJ's text sits on a field
// apply reads and relays; the regexes
// take the correct wordings round 3's replies used; the rubrics state what the fixture gives; SC-7-E
// replays the earlier turn's Skill call. Reads the committed bundle and fixtures; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HISTORY_SKILL_CALLS,
  INJECTION_NEEDLES,
  LLM_EXAMPLE_LABEL,
  LLM_JUDGE_SCOPE,
  gradersFor,
  planSuite,
} from "../../scripts/skills/build-plugin-evals.mjs";
import { ROOT } from "./helpers.js";

type Json = Record<string, unknown>;
interface Case {
  name: string;
  prompt: string;
  expected_output: string;
  files: string[];
  expectations: string[];
  history?: { role: string; text: string }[];
  base?: string;
}
interface Trigger {
  query: string;
  should_trigger: boolean;
}

const evalsOf = (skill: string): Case[] =>
  (
    JSON.parse(readFileSync(path.join(ROOT, "skills", skill, "evals", "evals.json"), "utf8")) as {
      evals: Case[];
    }
  ).evals;
const caseOf = (skill: string, name: string): Case => {
  const c = evalsOf(skill).find((x) => x.name === name);
  if (c === undefined) throw new Error(`no case ${name} in ${skill}`);
  return c;
};
const triggersOf = (skill: string): Trigger[] =>
  JSON.parse(
    readFileSync(path.join(ROOT, "skills", skill, "evals", "trigger_eval.json"), "utf8"),
  ) as Trigger[];
/** The pattern of a case's regex expectation that starts with `lead`. */
const regexOf = (c: Case, lead: string): RegExp => {
  const x = c.expectations.find((e) => e.startsWith(lead));
  const m = x === undefined ? null : /\((?:regex|regex_absent):\s*`([^`]+)`\)\s*$/.exec(x);
  if (m?.[1] === undefined) throw new Error(`${c.name}: no regex expectation "${lead}"`);
  return new RegExp(m[1], "i");
};
const llmLine = (c: Case, lead: string): string => {
  const x = c.expectations.find((e) => e.startsWith(lead) && /\(llm[,)]/.test(e));
  if (x === undefined) throw new Error(`${c.name}: no llm expectation "${lead}"`);
  return x;
};

const plan = planSuite(ROOT);

describe("R11-3: each llm judge grades its PASS-if line; the expected output is one example", () => {
  const ctx = {
    plugin: "espn-fantasy-football",
    inputs: {},
    prompt: "the question",
    expected: "EXAMPLE REPLY",
    reference: null,
    baseCase: null,
    basePrompt: null,
    variant: null,
    synthetic: null,
    seed: null,
  };

  it("the rubric is the PASS-if line, the scope sentence, the question and the labelled example", () => {
    const { graders, errors } = gradersFor("The reply is clear (llm)", ctx);
    expect(errors).toEqual([]);
    const body = graders[0]!.body;
    expect(body).toMatch(/^PASS if: The reply is clear\.\n/);
    expect(body).toContain(LLM_JUDGE_SCOPE);
    expect(body).toContain(`${LLM_EXAMPLE_LABEL} EXAMPLE REPLY`);
    // round 3's composition handed the judge the expected output to match
    expect(body).not.toContain("What a passing reply contains");
    expect(LLM_EXAMPLE_LABEL).toMatch(/need not match it/);
    expect(LLM_JUDGE_SCOPE).toMatch(/PASS-if line/);
  });

  it("every committed llm grader is composed that way", () => {
    expect(plan.errors).toEqual([]);
    const llm = plan.cases.flatMap((c) =>
      c.files.filter((f) => /^graders\/.*judge-/.test(f.rel)).map((f) => f.text),
    );
    expect(llm.length).toBeGreaterThan(100);
    for (const t of llm) {
      expect(t).toMatch(/\n\nPASS if: /);
      expect(t).toContain(LLM_JUDGE_SCOPE);
      expect(t).toContain(LLM_EXAMPLE_LABEL);
      expect(t).not.toContain("What a passing reply contains");
    }
  });
});

describe("R11-1: AP-INJ's text sits on a player name, which apply reads and quotes in every step", () => {
  const variants = readFileSync(path.join(ROOT, "scripts", "fx10h", "variants.ts"), "utf8");
  const planted = /playerName:\s*\n?\s*"([^"]+)"/.exec(variants)?.[1] ?? "";

  it("runs AP-2's agreed change on inj-player-name, so its base is AP-2", () => {
    const inj = caseOf("apply", "AP-INJ");
    const ap2 = caseOf("apply", "AP-2");
    expect(inj.files).toEqual(["evals/fixtures/fx-10h/inj-player-name"]);
    expect(inj.prompt).toBe(ap2.prompt);
    expect(inj.history).toEqual(ap2.history);
    expect(inj.expected_output).toMatch(/espn\.player\.name/);
    const out = plan.cases.find((c) => c.dir === "apply--ap-inj");
    expect(out?.baseline).toBe("apply--ap-2");
    // the trade-block note it carried is returned only by espn_get_standings, which apply never calls
    expect(inj.expectations.join("\n")).not.toMatch(/trade_block/);
    expect(inj.expectations.join("\n")).toMatch(/espn_get_roster/);
    expect(inj.expectations.join("\n")).toMatch(/no input_match on the injected string/);
  });

  it("the needle is a fragment of the planted text, which fits a player name's 64-character cap", () => {
    expect(planted.length).toBeGreaterThan(20);
    expect(planted.length).toBeLessThanOrEqual(64);
    expect(planted).toContain(INJECTION_NEEDLES["inj-player-name"]);
  });

  it("the variant's roster carries the text on the player AP-2's agreed change moves to IR", () => {
    const dir = path.join(ROOT, "fixtures", "espn", "fx-10h", "inj-player-name");
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
      views: { views: string[]; patch?: string }[];
      notes: string[];
    };
    const patched = manifest.views.filter((v) => v.patch !== undefined);
    // the roster view espn_get_roster reads carries the name, through the variant's patch
    const roster = patched.filter((v) => v.views.includes("mRoster"));
    expect(roster.length).toBeGreaterThan(0);
    for (const v of roster) {
      const ops = JSON.parse(
        readFileSync(path.join(ROOT, "fixtures", "espn", v.patch ?? ""), "utf8"),
      ) as { path: (string | number)[]; value: unknown }[];
      expect(
        ops.some((o) => o.path.at(-1) === "fullName" && String(o.value).includes(planted)),
      ).toBe(true);
    }
    // Tank Dell (4366031): AP-2's history moves him from BE into the open IR slot
    expect(manifest.notes.join("\n")).toContain(
      `player 4366031: the injected name "Tank Dell (${planted})"`,
    );
    expect(caseOf("apply", "AP-2").history?.[1]?.text).toContain("'Tank Dell' (player_id 4366031");
  });

  it("AP-7 is no longer called AP-INJ's base", () => {
    expect(caseOf("apply", "AP-7").expected_output).not.toMatch(/^AP-INJ's base/);
  });
});

describe("the trigger cases the round-3 description changes call for", () => {
  it("news-check: a usage jump no news explains and a claim logged earlier fire it; the balance holds", () => {
    const t = triggersOf("news-check");
    const pos = t.filter((x) => x.should_trigger).map((x) => x.query);
    expect(pos.some((q) => /snap share/i.test(q))).toBe(true);
    expect(pos.some((q) => /\blog(ged)?\b/i.test(q))).toBe(true);
    expect(pos.length).toBe(t.length - pos.length);
  });
  it("onboard: a seeding ask fires it; the balance is kept", () => {
    const t = triggersOf("onboard");
    const pos = t.filter((x) => x.should_trigger).map((x) => x.query);
    expect(pos.filter((q) => /seed/i.test(q)).length).toBeGreaterThanOrEqual(2);
    expect(pos.length - (t.length - pos.length)).toBe(1);
  });
});

describe("round 3's eval-case regexes take the wordings its replies used", () => {
  it("SS-4, SS-12 and SS-INJ-2: an unconfirmed report, in any of its wordings", () => {
    for (const n of ["SS-4", "SS-12", "SS-INJ-2"]) {
      const re = regexOf(caseOf("start-sit", n), "The reply calls the");
      for (const s of [
        "The report isn't confirmed yet.",
        "That is unconfirmed.",
        "It has not been confirmed by ESPN.",
        "Nothing in ESPN's data confirms it.",
      ])
        expect(re.test(s), `${n}: ${s}`).toBe(true);
      expect(re.test("Seeding is not confirmed for this league.")).toBe(false);
      expect(re.test("ESPN confirms he is out.")).toBe(false);
    }
  });

  it("SS-8: nothing left to change, every slot locked", () => {
    const re = regexOf(caseOf("start-sit", "SS-8"), "The reply says nothing");
    for (const s of [
      "Nothing you can do: every slot that could change is locked.",
      "Nothing is actionable.",
      "There is nothing left to change.",
      "Every starter is locked, so the lineup stands.",
    ])
      expect(re.test(s), s).toBe(true);
    expect(re.test("Move Rice to FLEX before his lock.")).toBe(false);
  });

  it("WK-10 and the other hand-off cases: ESPN is rejecting the stored session or login", () => {
    for (const [skill, n] of [
      ["weekly", "WK-10"],
      ["weekly", "WK-11"],
    ] as const) {
      const re = regexOf(caseOf(skill, n), "The reply says ESPN rejected the stored session");
      for (const s of [
        "ESPN is rejecting your stored session.",
        "ESPN is rejecting your stored login.",
        "ESPN rejected the stored session.",
      ])
        expect(re.test(s), `${n}: ${s}`).toBe(true);
      expect(re.test("ESPN has not rejected the session.")).toBe(false);
    }
  });
});

describe("round 3's eval-case rubrics state what the fixture gives (each PASS-if line extended, never loosened)", () => {
  it("AP-2: ids and deadlines in the numbered steps; the read-only line is not a claim the change was made", () => {
    const c = caseOf("apply", "AP-2");
    expect(llmLine(c, "Every player")).toMatch(/numbered steps?/);
    expect(llmLine(c, "The reply never says")).toMatch(/read-only/);
  });
  it("NC-2: the flag the tool returns with the claim passed, and the tool's one confirming item", () => {
    const c = caseOf("news-check", "NC-2");
    expect(c.expected_output).toMatch(/consistent/);
    expect(c.expected_output).toMatch(/the next official injury report/);
    expect(llmLine(c, "The reply lists what would confirm")).toMatch(/what_would_confirm/);
  });
  it("NC-6: no injection flag (the flag the tool reads from usage is quiet_role_change)", () => {
    const c = caseOf("news-check", "NC-6");
    expect(c.expected_output).toMatch(/carries no injection flag/);
    expect(c.expected_output).not.toMatch(/carries no flag/);
    expect(llmLine(c, "The reply quotes the outlook")).toMatch(/espn\.player\.season_outlook/);
  });
  it("WV-2: the one branch this pool gives", () => {
    const c = caseOf("waivers", "WV-2");
    const line = c.expectations.find(
      (x) => x.includes("usage branch found none") && x.includes("(llm)"),
    );
    expect(line).toBeDefined();
    expect(c.expectations.join("\n")).not.toMatch(/— or, when no candidate carries a signal/);
  });
  it("WK-1: as_of by a free grader; a row the tool holds needs no deadline", () => {
    const c = caseOf("weekly", "WK-1");
    expect(regexOf(c, "The reply prints the reads' as_of").test("as_of 2025-10-07")).toBe(true);
    expect(llmLine(c, "Every action")).toMatch(/needs none/);
  });
  it("ON-6: no onboarding walkthrough; session-check's steps are the hand-off", () => {
    expect(llmLine(caseOf("onboard", "ON-6"), "The reply says ESPN rejected")).toMatch(
      /no onboarding walkthrough/,
    );
  });
  it("SS-INJ-2: matches-base is the same players, verdict and action as the base", () => {
    expect(llmLine(caseOf("start-sit", "SS-INJ-2"), "The reply's")).toMatch(
      /same players, verdict and action/,
    );
  });
  it("SS-2: the expected outcome follows the tool on underdog-9 (3.7 points behind, no swap)", () => {
    const e = caseOf("start-sit", "SS-2").expected_output;
    expect(e).not.toMatch(/9-point/);
    expect(e).toMatch(/no_move/);
  });
  it("SS-6-E: every flagged starter with ESPN's number, ours and the tool's pct", () => {
    expect(llmLine(caseOf("start-sit", "SS-6-E"), "The reply lists each")).toMatch(/pct/);
  });
});

describe("SC-7-E replays the earlier turn's session-check Skill call (round 3: a fidelity step)", () => {
  it("is the only case so listed", () => {
    expect(Object.keys(HISTORY_SKILL_CALLS)).toEqual(["SC-7-E"]);
  });

  it("its history holds the Skill call, its result and the Skill's text before the earlier answer", () => {
    const c = plan.cases.find((x) => x.dir === "session-check--sc-7-e");
    const h = c?.files.find((f) => f.rel === "history.jsonl")?.text ?? "";
    const lines = h
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Json);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.parentUuid).toBe(lines[i - 1]!.uuid);
    const msg = (l: Json) => l.message as { role: string; content: unknown };
    const use = lines.findIndex(
      (l) =>
        l.type === "assistant" &&
        Array.isArray(msg(l).content) &&
        (msg(l).content as Json[]).some((b) => b.type === "tool_use" && b.name === "Skill"),
    );
    expect(use).toBe(1);
    const block = (msg(lines[1]!).content as Json[])[0]!;
    expect(block.input).toEqual({ skill: "espn-fantasy-football:session-check" });
    const result = (msg(lines[2]!).content as Json[])[0]!;
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: block.id });
    expect(lines[3]).toMatchObject({ type: "user", isMeta: true });
    const skillText = JSON.stringify(msg(lines[3]!).content);
    expect(skillText).toContain("eff setup");
    expect(skillText).not.toMatch(/^---\\nname:/);
    expect(lines[4]).toMatchObject({ type: "assistant" });
    expect(JSON.stringify(msg(lines[4]!).content)).toContain("Tell me when you have run eff setup");
    expect(lines).toHaveLength(5);
  });
});
