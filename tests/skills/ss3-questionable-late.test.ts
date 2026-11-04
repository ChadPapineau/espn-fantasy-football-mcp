// SS-3 follows the lineup tool's reading on questionable-late (the round-3b verifiers' V-6; the
// round-3b product account): every replacement for the QUESTIONABLE Monday-night starter locks on
// Sunday, so espn_analyze_lineup returns no conditionals and no option value on its default swaps,
// and a swap that benches him reads option_value { kind: monday, value: 0 }. The case grades a reply
// that says the choice is made before Sunday's first lock, never one that claims value in waiting.
// The tool facts are checked on the eval server with single tool calls (the suite build's proof).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";

interface Case {
  name: string;
  expected_output: string;
  expectations: string[];
  files: string[];
}
const cases = (
  JSON.parse(readFileSync(path.join(ROOT, "skills/start-sit/evals/evals.json"), "utf8")) as {
    evals: Case[];
  }
).evals;
const ss3 = cases.find((c) => c.name === "SS-3");

describe("SS-3 on questionable-late follows the tool (V-6)", () => {
  it("runs on questionable-late", () => {
    expect(ss3?.files).toEqual(["evals/fixtures/fx-10h/questionable-late"]);
  });

  it("its expected outcome is the tool's: no conditional, no option value, a Monday option worth 0", () => {
    const eo = ss3?.expected_output ?? "";
    expect(eo).toContain("returns no conditionals and no option value on its default swaps");
    expect(eo).toContain("option_value { kind: monday, value: 0 }");
    expect(eo).toContain("has to be made before Sunday's first lock");
    expect(eo).toContain("nothing can be changed once his status is known on Monday");
    expect(eo).toContain("The reply claims no value in waiting");
    // the reading round 3b's product agent withdrew: an option value the tool does not give
    expect(eo).not.toMatch(/option value of (?:waiting|the later game) is positive/i);
  });

  it("its judge grades the decision before Sunday's first lock and no value in waiting", () => {
    const llm = (ss3?.expectations ?? []).filter((x) => x.endsWith("(llm)"));
    expect(llm).toHaveLength(1);
    expect(llm[0]).toContain("has to be made before Sunday's first lock");
    expect(llm[0]).toContain("it claims no option value from waiting");
    // round 3b's rubric graded "a conditional lineup", which the tool no longer offers here
    expect(llm[0]).not.toContain("gives a conditional lineup");
  });

  it("keeps its tool-order and p_active graders", () => {
    const x = ss3?.expectations ?? [];
    expect(x).toContain(
      "The skill called espn_get_injuries before espn_analyze_lineup (tool_order)",
    );
    expect(x.some((e) => e.includes("(regex: `p_active|7[01] ?%"))).toBe(true);
  });
});
