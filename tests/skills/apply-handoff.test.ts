// apply-handoff.test.ts — every Skill's hand-off to `apply` names what actually starts it, in each
// way the Skills are installed (Stage C finding skills-apply-handoff-phrase). `apply` is user-invoked
// (`disable-model-invocation: true`, plan 09 K4), and Claude Code's Skill tool (2.1.238) refuses the
// model's call for such a Skill unless the user typed its command that turn
// (docs/evals/stage-c-plugin-eval.md H2) — so "say *apply* for the exact clicks", the line every
// recommendation ended with, cost the plugin's user a refused turn and told the model not to give the
// clicks. Guardrail 10 now gives one line per install form, and each line is held here to that form's
// facts: the plugin's slash command for a user-invoked Skill (the command the eval build gives apply's
// cases), the copy install's model-invocable `apply` (the copy keeps no `disable-model-invocation`),
// and the server's `espn.apply` prompt. WK-2's graders accept the plugin line and refuse the old one.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  gradersFor,
  isUserInvoked,
  slashCommand,
} from "../../scripts/skills/build-plugin-evals.mjs";
import { copyInstallSkill } from "../../scripts/skills/build-skills.mjs";
import { parseFrontmatter, readManifest } from "../../scripts/skills/_lib.mjs";
import { ALL_PROMPTS } from "../../src/mcp/prompts/index.js";
import { ROOT, SKILLS } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const manifest = readManifest(ROOT);
const PLUGIN = manifest.plugin;

/** The Skills only the user can start (frontmatter `disable-model-invocation: true`). */
const USER_INVOKED = SKILLS.filter((s) => isUserInvoked(path.join(ROOT, "skills", s)));
/** The plugin's command for apply — the one apply's own Lane 2 prompts start with. */
const APPLY_COMMAND = slashCommand(PLUGIN, "apply");

const guardrails = read("skills/_shared/references/guardrails.md");
/** Guardrail 10, the closing line's rule. */
const G10 = /^10\. (.+)$/m.exec(guardrails)?.[1] ?? "";
/** The quoted closing line for one install form: the text after `<scope> (…), "` up to the closing quote. */
function lineFor(scope: string): { context: string; line: string } {
  const at = G10.indexOf(scope);
  if (at === -1) throw new Error(`guardrail 10 names no "${scope}" form`);
  const m = /^[^"]*\(([^)]*)\),\s*"([^"]+)"/.exec(G10.slice(at + scope.length));
  if (m === null) throw new Error(`guardrail 10's "${scope}" form has no quoted line`);
  return { context: m[1] ?? "", line: m[2] ?? "" };
}

/** Every Markdown file the Skills ship (bodies, references, the bundle README), repository-relative. */
function bundleMarkdown(): string[] {
  const out = ["skills/README.md"];
  for (const s of [...SKILLS, "_shared"]) {
    const dir = s === "_shared" ? "skills/_shared/references" : `skills/${s}`;
    if (s !== "_shared") out.push(`${dir}/SKILL.md`);
    const refs = s === "_shared" ? dir : `${dir}/references`;
    for (const f of readdirSync(path.join(ROOT, refs)).sort())
      if (f.endsWith(".md")) out.push(`${refs}/${f}`);
  }
  return out;
}

describe("the hand-off to apply names what starts it (Stage C finding skills-apply-handoff-phrase)", () => {
  it("apply is the one user-invoked Skill, and its command is the plugin's slash command", () => {
    expect(USER_INVOKED).toEqual(["apply"]);
    expect(APPLY_COMMAND).toBe("/espn-fantasy-football:apply");
    // apply's Lane 2 prompts are that command typed by the user (check-skills and the eval build)
    const ap = (
      JSON.parse(read("skills/apply/evals/evals.json")) as { evals: { prompt: string }[] }
    ).evals;
    for (const c of ap) expect(c.prompt.startsWith(`${APPLY_COMMAND} `)).toBe(true);
  });

  it("with the plugin, the closing line is the command the user types — never a phrase for the model", () => {
    const { context, line } = lineFor("as the plugin");
    // the plugin lists its Skills as <plugin>:<name> (check-skills skillsListing)
    expect(context).toContain(`\`${PLUGIN}:<name>\``);
    expect(line).toContain(`\`${APPLY_COMMAND}\``);
    expect(line).toMatch(/^type /);
    expect(line).not.toMatch(/\bsay\b/i);
    // the reason is stated: only the user can start it; the model's call is refused — and the Skill
    // is named as the plugin installs it, never by a bare name another bundle may share (Stage C
    // finding skills-cross-references-bare-names)
    expect(G10).toContain(
      `the exact clicks from the \`${PLUGIN}:apply\` Skill. Only the user can start that Skill`,
    );
    expect(G10).toMatch(/a Skill call from you is refused/);
  });

  it("installed one by one, apply carries no disable-model-invocation, so saying apply starts it", () => {
    const { context, line } = lineFor("one by one");
    expect(context).toContain("`espn-<name>`");
    expect(line).toBe("say *apply* for the exact clicks");
    // the copy install (build-skills --copy-out) drops the flag and names the Skill espn-apply
    const copy = parseFrontmatter(
      copyInstallSkill(read("skills/apply/SKILL.md"), "apply", { plugin: PLUGIN, skills: SKILLS }),
    );
    expect(copy.data["disable-model-invocation"]).toBeUndefined();
    expect(copy.data.name).toBe("espn-apply");
  });

  it("apply's own body agrees: the user starts it, the model never does so on its own", () => {
    // a copy install's apply is started by the model when the user says apply (the line above), so
    // the body must not tell that model it never invokes the Skill — only that it never starts it
    // unasked
    const body = read("skills/apply/SKILL.md");
    expect(body).toMatch(/Only the user starts this Skill/);
    expect(body).toMatch(/the model never starts it on its own/);
    expect(body).not.toMatch(/the model never does\./);
  });

  it("with no Skill installed, the line names the server's espn.apply prompt, which exists", () => {
    const { context, line } = lineFor("not at all");
    expect(context).toContain("`espn.*` prompts");
    expect(line).toContain("`espn.apply`");
    const p = ALL_PROMPTS.find((x) => x.name === "espn.apply");
    expect(p?.skill).toBe("apply");
  });

  it("every 'say apply' left in the bundle is the one-by-one form, and every closing-line rule points at guardrail 10", () => {
    for (const rel of bundleMarkdown()) {
      const text = read(rel);
      for (const m of text.matchAll(/\bsay \*?apply\b/gi)) {
        const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index));
        expect(line, `${rel}: "${m[0]}" outside the one-by-one form`).toMatch(/one by one/);
      }
    }
    // the output contract and weekly's list close with guardrail 10's line, the plugin's named
    const template = read("skills/_shared/references/output-template.md");
    expect(template).toMatch(/guardrail 10/);
    expect(template).toContain(lineFor("as the plugin").line);
    const weekly = read("skills/weekly/SKILL.md");
    expect(weekly).toMatch(
      /\*\*Not actionable here\*\* list ending with the apply line of guardrail 10/,
    );
  });

  it("WK-2's graders accept the plugin's closing line and refuse the line the CLI cannot act on", () => {
    const wk2 = (
      JSON.parse(read("skills/weekly/evals/evals.json")) as {
        evals: { name: string; prompt: string; expected_output: string; expectations: string[] }[];
      }
    ).evals.find((c) => c.name === "WK-2");
    if (wk2 === undefined) throw new Error("weekly has no WK-2 case");
    const ctx = {
      plugin: PLUGIN,
      inputs: manifest.inputs,
      prompt: wk2.prompt,
      expected: wk2.expected_output,
      reference: null,
    };
    const free = wk2.expectations.flatMap((s) =>
      gradersFor(s, ctx)
        // the regex graders on the final message (a `target: trace` regex is the write-tool guard)
        .graders.filter((g) => g.frontmatter.type === "regex" && g.frontmatter.target === undefined)
        .map((g) => ({
          re: new RegExp(String(g.frontmatter.pattern), String(g.frontmatter.flags)),
          absent: g.frontmatter.match === "not_contains",
        })),
    );
    expect(free.length).toBeGreaterThan(0);
    const passes = (reply: string): boolean =>
      free.every((g) => (g.absent ? !g.re.test(reply) : g.re.test(reply)));
    const head = "**Not actionable here:** start Player A (`4428331`) at FLEX before the lock. ";
    expect(passes(`${head}${lineFor("as the plugin").line}.`)).toBe(true);
    expect(
      passes(`${head}For the exact clicks, type \`${APPLY_COMMAND} start Player A at FLEX\`.`),
    ).toBe(true);
    expect(passes(`${head}say *apply* for the exact clicks.`)).toBe(false);
    expect(passes(`${head}Say apply for the exact clicks.`)).toBe(false);
    expect(wk2.expected_output).not.toMatch(/say apply/i);
  });
});
