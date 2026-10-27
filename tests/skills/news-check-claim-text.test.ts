// news-check-claim-text.test.ts — news-check passes a pasted claim in the one form
// espn_analyze_evidence accepts (Stage C finding skills-news-check-multiline-claim-refused; plan 09
// §3.13). Step 4 said `claim.text` is "the user's own words, verbatim", but `claim.text` is bounded
// printable text (src/mcp/envelope.ts PRINTABLE_RE: no control, format, surrogate, private-use or
// default-ignorable character; src/mcp/bounds.ts `claimTextChars`), so the Skill's main input — a
// pasted post or a headline with its source, over several lines — failed VALIDATION on the first
// call, and the rewrite that would pass is one "verbatim" forbade. The step now names the only three
// changes allowed: a line break or tab (with the blanks around it) becomes one space, invisible
// characters are left out, a paste still over the cap is cut to the passage that makes the claim.
// Held against the REAL input schema the server parses (the registry's zod object): the raw pastes
// are refused, the paste after the stated rule is accepted, and the rule keeps every visible
// character in order. No network, no cookie.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BOUNDS } from "../../src/mcp/bounds.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { ROOT } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const body = read("skills/news-check/SKILL.md");
/** A `### N. …` step of the procedure, up to the next heading. */
function step(heading: string): string {
  const at = body.indexOf(`\n${heading}\n`);
  if (at === -1) throw new Error(`news-check no longer has "${heading}"`);
  const rest = body.slice(at + heading.length + 2);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? rest : rest.slice(0, next);
}
const CHECK_STEP = step("### 4. The check");

const evidence = REGISTRY.find((e) => e.name === "espn_analyze_evidence")?.tool;
if (evidence === undefined || evidence === null)
  throw new Error("espn_analyze_evidence is not built");
const input = evidence.input;
/** Whether the tool's own input schema accepts this `claim.text` (all else valid). */
const accepted = (text: string): boolean =>
  input.safeParse({ player: { player_ids: [4428331] }, claim: { text, source: "beat writer" } })
    .success;

/**
 * The rule step 4 states, as code: every line break or tab with the blanks around it becomes one
 * space; invisible characters (zero-width spaces and joiners, soft hyphens, emoji variation
 * selectors — Unicode format and default-ignorable characters) are left out. Nothing else changes.
 */
const BREAKS = /[ ]*(?:(?:\r\n|[\r\n\t\v\f\u0085\u2028\u2029])[ ]*)+/g;
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const asStated = (paste: string): string => paste.replace(INVISIBLE, "").replace(BREAKS, " ");
/** The visible characters of a text, in order (what the rule must never change). */
const visible = (s: string): string => s.replace(INVISIBLE, "").replace(/[\s\u0085]+/gu, "");

describe("news-check passes a pasted claim as one printable line (Stage C skills-news-check-multiline-claim-refused)", () => {
  it("step 4 states the tool's form — one printable line within the cap — and the three changes, nothing else", () => {
    expect(CHECK_STEP).toContain(
      `The tool takes it as one line of printable text, at most ${String(BOUNDS.claimTextChars)} characters, and refuses anything else`,
    );
    expect(CHECK_STEP).toMatch(
      /every line break or tab, with the blanks around it, becomes one space/,
    );
    expect(CHECK_STEP).toMatch(
      /invisible characters \(zero-width spaces and joiners, soft hyphens, the variation selector some emoji carry\) are left out/,
    );
    expect(CHECK_STEP).toMatch(
      new RegExp(
        `a paste still longer than ${String(BOUNDS.claimTextChars)} characters is cut to the passage that states the claim about this player, word for word — say in one line that only that passage was checked`,
      ),
    );
    expect(CHECK_STEP).toMatch(/Nothing else changes: never reword, correct or summarise it/);
    // still the user's own words, never a tool result's text
    expect(CHECK_STEP).toMatch(/`claim\.text` is the user's own words, verbatim: never an outlook/);
  });

  it("the finding's pastes: refused as pasted, accepted after the stated rule", () => {
    const pastes = [
      "Rice is expected to play Sunday.\nSource: beat writer",
      "Rice is expected to play Sunday.\tSource: beat writer",
      "Beat writer:\r\nthe backup will get more work  \n\n  this week",
      "⚠\uFE0F Breaking: the backup starts — per the team",
      "The backup\u200B gets more work (team\u00ADsource)",
    ];
    for (const p of pastes) {
      expect(accepted(p), JSON.stringify(p)).toBe(false);
      expect(accepted(asStated(p)), JSON.stringify(asStated(p))).toBe(true);
      expect(visible(asStated(p))).toBe(visible(p));
    }
    expect(asStated("Rice is expected to play Sunday.\nSource: beat writer")).toBe(
      "Rice is expected to play Sunday. Source: beat writer",
    );
  });

  it("any multi-line paste within the cap passes after the rule, every visible character kept in order", () => {
    const word = fc.constantFrom(
      "Beat",
      "writer:",
      "the",
      "backup",
      "will",
      "get",
      "more",
      "work",
      "Sunday.",
      "(limited)",
      "OUT",
      "—",
      "per",
      "source",
      "🚨",
      "⚠\uFE0F",
      "👨\u200D👩\u200D👧",
      "co\u00ADordinator",
      "snaps\u200B",
      "\uFEFFRT",
    );
    const sep = fc.constantFrom(" ", "  ", "\n", "\r\n", "\t", " \n ", "\n\n", "\u0085", "\u2028");
    const paste = fc
      .array(fc.tuple(word, sep), { minLength: 1, maxLength: 30 })
      .map((xs) => xs.map(([w, s]) => w + s).join(""));
    fc.assert(
      fc.property(paste, (p) => {
        const out = asStated(p);
        if (out.length > BOUNDS.claimTextChars) return; // the cut is the Skill's choice of passage
        expect(accepted(out), JSON.stringify(out)).toBe(true);
        expect(out).not.toMatch(/[\r\n\t\u0085]/);
        expect(visible(out)).toBe(visible(p));
      }),
      { numRuns: 500 },
    );
  });

  it("a paste over the cap is refused whole — the passage step 4 keeps must fit", () => {
    const long = "the backup will get more work this week ".repeat(12);
    expect(long.length).toBeGreaterThan(BOUNDS.claimTextChars);
    expect(accepted(long)).toBe(false);
    expect(accepted(long.slice(0, BOUNDS.claimTextChars))).toBe(true);
  });

  it("the Lane 1 sequence that checks a paste passes one printable line", () => {
    const seq = JSON.parse(read("skills/news-check/evals/tool_sequence.json")) as {
      sequences: { id: string; steps: { tool: string; args: Record<string, unknown> }[] }[];
    };
    const ev = seq.sequences
      .find((s) => s.id === "pasted")
      ?.steps.find((s) => s.tool === "espn_analyze_evidence");
    const text = (ev?.args.claim as { text?: unknown } | undefined)?.text;
    expect(typeof text).toBe("string");
    expect(accepted(String(text))).toBe(true);
    expect(asStated(String(text))).toBe(text);
  });
});
