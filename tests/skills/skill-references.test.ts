// skill-references.test.ts — the Skills name one another so that only this bundle's Skill can answer
// (Stage C finding skills-cross-references-bare-names; plan 09 [A-3]). The bodies routed to other
// Skills by bare name — "route to `onboard`", "the full review is the `retro` Skill", the
// `session-check` hand-over — while the plugin names its Skills `espn-fantasy-football:<name>`, the
// copy install names them `espn-<name>`, and the owner's sibling installs `onboard`, `retro`,
// `start-sit` and `stream-kdef` bare into ~/.claude/skills/: with both installed, a scoring mismatch
// or an unconfirmed seeding reading started the sibling's onboarding interview. The source now names
// every other Skill as the plugin installs it, build-skills --copy-out renames each reference with
// the Skill it names, orient's table gives the prompt-only client the prompt instead, and Lane 1
// (check-skills `skillRefProblems`) refuses a bare reference or a qualified name that names nothing.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkills, copyInstallText, skillRefRe } from "../../scripts/skills/build-skills.mjs";
import { checkSkills, skillRefProblems } from "../../scripts/skills/check-skills.mjs";
import { readManifest } from "../../scripts/skills/_lib.mjs";
import { ALL_PROMPTS, PROMPTS } from "../../src/mcp/prompts/index.js";
import { ROOT, SKILLS, tempRepo, type TempRepo } from "./helpers.js";

const PLUGIN = readManifest(ROOT).plugin;
const REFS = { plugin: PLUGIN, skills: SKILLS };
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Every Markdown file of every Skill (bodies without frontmatter, references whole), repo-relative. */
function skillTexts(root = ROOT): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const s of SKILLS) {
    const skill = readFileSync(path.join(root, "skills", s, "SKILL.md"), "utf8");
    out.push({ file: `skills/${s}/SKILL.md`, text: skill.slice(skill.indexOf("\n---\n", 4) + 5) });
    for (const f of readdirSync(path.join(root, "skills", s, "references")).sort())
      if (f.endsWith(".md"))
        out.push({
          file: `skills/${s}/references/${f}`,
          text: readFileSync(path.join(root, "skills", s, "references", f), "utf8"),
        });
  }
  return out;
}

describe("cross-Skill references (Stage C finding skills-cross-references-bare-names)", () => {
  it("no Skill text names another Skill by a bare name, and every qualified name is a Skill of the bundle", () => {
    for (const { file, text } of skillTexts())
      expect(skillRefProblems(text, REFS), file).toEqual([]);
  });

  it("nor outside backticks: a distinctive Skill name never stands bare in another Skill's prose", () => {
    // `onboard` and the hyphenated names are no ordinary word, so a bare one is a reference another
    // bundle's Skill can answer even without backticks (news-check's consequence example once read
    // "start-sit unchanged"); `weekly`, `apply`, `trade`, `waivers` and `retro` are ordinary words,
    // held by the backtick rule above. Removed first: the qualified references and the plugin's
    // slash command, link targets (file names such as injury-cascade-roles.md), prompt names.
    const distinctive = SKILLS.filter((s) => s.includes("-") || s === "onboard");
    expect(distinctive.length).toBeGreaterThanOrEqual(8);
    const qualified = new RegExp(`\`/?${PLUGIN}:[a-z<>-]+\``, "g");
    let scanned = 0;
    for (const { file, text } of skillTexts()) {
      const own = file.split("/")[1] ?? "";
      const prose = text
        .replace(qualified, "")
        .replace(/\]\([^)]*\)/g, "]")
        .replace(/`espn\.[a-z_]+`/g, "");
      for (const s of distinctive) {
        if (s === own) continue;
        const at = new RegExp(`(?<![\\w-])${s}(?![\\w-])`).exec(prose);
        expect(
          at === null ? "" : prose.slice(Math.max(0, at.index - 60), at.index + 60),
          `${file}: ${s}`,
        ).toBe("");
      }
      scanned++;
    }
    expect(scanned).toBeGreaterThan(SKILLS.length * 5);
  });

  it("the routes the finding named are qualified: onboard, retro, stream-kdef, session-check, news-check", () => {
    const orient = read("skills/_shared/references/orient.md");
    expect(orient).toContain(`route to the \`${PLUGIN}:onboard\` Skill for the diagnosis`);
    expect(orient).toContain(`run \`${PLUGIN}:onboard\` to record it`);
    expect(orient).toContain(`Hand over to the \`${PLUGIN}:session-check\` Skill and stop.`);
    const weekly = read("skills/weekly/SKILL.md");
    expect(weekly).toContain(`the full review is the \`${PLUGIN}:retro\` Skill`);
    expect(weekly).toContain(`The full treatment is the \`${PLUGIN}:stream-kdef\` Skill.`);
    expect(read("skills/injury-cascade/SKILL.md")).toContain(
      `run the \`${PLUGIN}:news-check\` Skill first`,
    );
    for (const s of ["trade", "schedule-plan"])
      expect(read(`skills/${s}/SKILL.md`), s).toContain(`offer the \`${PLUGIN}:onboard\` Skill`);
    const guardrails = read("skills/_shared/references/guardrails.md");
    expect(guardrails).toContain(`the \`${PLUGIN}:session-check\` Skill says what to do`);
    expect(guardrails).toContain(
      `which the \`${PLUGIN}:apply\` Skill writes once the user starts it`,
    );
  });

  it("orient says how to read the names, and maps every Skill to its prompt for a prompt-only client", () => {
    const orient = read("skills/_shared/references/orient.md");
    expect(orient).toMatch(
      /This text names another Skill of this bundle by its installed name — `espn-fantasy-football:<name>` with the plugin, `espn-<name>` when the Skills were copied one by one/,
    );
    expect(orient).toMatch(/never another bundle's Skill that shares the bare name/);
    expect(orient).toContain(
      "With only the server's prompts (this text came in an `espn.*` prompt) there is no Skill to start: name the prompt the user chooses instead.",
    );
    const rows = new Map(
      [
        ...orient.matchAll(
          /^\| `espn-fantasy-football:([a-z-]+)` \| `(espn\.[a-z_]+)`( \(under `EFF_TOOLSET=full`\))? \|$/gm,
        ),
      ].map((m) => [m[1] ?? "", { prompt: m[2] ?? "", full: m[3] !== undefined }]),
    );
    expect([...rows.keys()].sort()).toEqual([...SKILLS].sort());
    for (const p of ALL_PROMPTS) {
      const row = rows.get(p.skill);
      expect(row?.prompt, p.skill).toBe(p.name);
      // the P1 prompts register under EFF_TOOLSET=full only
      expect(row?.full, p.name).toBe(!PROMPTS.includes(p));
    }
  });
});

describe("Lane 1 refuses a reference another bundle could answer", () => {
  let repo: TempRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });
  /** Put sentences into weekly's own procedure text (outside the generated blocks), one per line. */
  const plant = (
    sentences: readonly string[],
  ): { errors: string[]; lineOf: (s: string) => number } => {
    repo = tempRepo();
    repo.edit(
      "skills/weekly/SKILL.md",
      "### 6. League activity\n",
      `### 6. League activity\n${sentences.join("\n")}\n\n`,
    );
    const text = repo.read("skills/weekly/SKILL.md");
    const body = text.slice(text.indexOf("\n---\n", 4) + 5);
    const lines = body.split("\n");
    return {
      errors: checkSkills({ root: repo.root, scan: false }).errors,
      lineOf: (s) => lines.indexOf(s) + 1,
    };
  };

  it("a bare name in backticks — each of the bundle's Skills — is refused with its line", () => {
    const sentences = SKILLS.map((s) => `For more, use the \`${s}\` Skill.`);
    const { errors, lineOf } = plant(sentences);
    for (const [i, s] of SKILLS.entries())
      expect(errors, s).toContain(
        `skills/weekly/SKILL.md: line ${String(lineOf(sentences[i] ?? ""))}: \`${s}\` is a bare Skill name another bundle's Skill may share — write \`${PLUGIN}:${s}\``,
      );
  });

  it("a qualified name that names no Skill, or one outside backticks, is refused", () => {
    const { errors } = plant([
      `See the \`${PLUGIN}:onbaord\` Skill.`,
      `See the ${PLUGIN}:retro Skill.`,
    ]);
    expect(errors.join("\n")).toMatch(
      /`espn-fantasy-football:onbaord` names no Skill of this bundle/,
    );
    expect(errors.join("\n")).toMatch(/espn-fantasy-football:retro must be in backticks/);
  });

  it("the qualified name, the plugin's slash command and the <name> placeholder pass", () => {
    const { errors } = plant([
      `See the \`${PLUGIN}:retro\` Skill; type \`/${PLUGIN}:apply\`; Skills are \`${PLUGIN}:<name>\`.`,
    ]);
    expect(errors.join("\n")).not.toMatch(/bare Skill name|names no Skill|must be in backticks/);
  });

  it("fenced code is not prose", () => {
    expect(skillRefProblems("```\nrun `onboard`\n```\n", REFS)).toEqual([]);
    expect(skillRefProblems("run `onboard`\n", REFS)).toHaveLength(1);
    expect(skillRefProblems("a\n\nrun `onboard`\n", REFS)[0]).toMatch(/^line 3: /);
  });
});

describe("the copy install renames every reference with the Skill it names", () => {
  let out = "";
  let copy: TempRepo | undefined;
  afterEach(() => {
    if (out !== "") rmSync(out, { recursive: true, force: true });
    out = "";
    copy?.cleanup();
    copy = undefined;
  });

  it("copyInstallText renames `espn-fantasy-football:<skill>` and nothing else", () => {
    expect(copyInstallText(`the \`${PLUGIN}:onboard\` Skill`, REFS)).toBe(
      "the `espn-onboard` Skill",
    );
    expect(copyInstallText(`\`${PLUGIN}:start-sit\`'s branch`, REFS)).toBe(
      "`espn-start-sit`'s branch",
    );
    // the slash command, the placeholder, a name that is no Skill and an unquoted name stay
    for (const keep of [
      `type \`/${PLUGIN}:apply\``,
      `named \`${PLUGIN}:<name>\``,
      `\`${PLUGIN}:onbaord\``,
      `${PLUGIN}:retro`,
      "`onboard`",
    ])
      expect(copyInstallText(keep, REFS)).toBe(keep);
    expect(() => copyInstallText("x", undefined as never)).toThrow(/required/);
  });

  it("the built copy tree names only copied Skills, as espn-<name>, and keeps the plugin's command", () => {
    out = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-skills-copy-")));
    copy = tempRepo();
    const r = buildSkills({ root: copy.root, copyOut: out });
    expect(r.errors).toEqual([]);
    expect(r.changed, "the source tree is current").toEqual([]);
    let renamed = 0;
    for (const s of SKILLS) {
      const dir = path.join(out, `espn-${s}`);
      const files = [
        "SKILL.md",
        ...readdirSync(path.join(dir, "references")).map((f) => `references/${f}`),
      ];
      for (const f of files) {
        const text = readFileSync(path.join(dir, f), "utf8");
        // no plugin-qualified Skill reference is left
        expect(text.match(skillRefRe(REFS)), `espn-${s}/${f}`).toBeNull();
        // every espn-<name> reference names a Skill the copy tree holds
        for (const m of text.matchAll(/`espn-([a-z][a-z-]*)`/g)) {
          expect(
            existsSync(path.join(out, `espn-${m[1] ?? ""}`)),
            `espn-${s}/${f}: espn-${m[1] ?? ""}`,
          ).toBe(true);
          renamed++;
        }
      }
      // guardrail 10 still tells the plugin's user the command to type
      expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain(`\`/${PLUGIN}:apply\``);
    }
    expect(renamed).toBeGreaterThan(SKILLS.length * 10);
    // the weekly copy routes to the copied Skills
    const orient = readFileSync(path.join(out, "espn-weekly", "references", "orient.md"), "utf8");
    expect(orient).toContain("Hand over to the `espn-session-check` Skill and stop.");
    expect(orient).toContain("route to the `espn-onboard` Skill for the diagnosis");
    expect(readFileSync(path.join(out, "espn-weekly", "SKILL.md"), "utf8")).toContain(
      "the full review is the `espn-retro` Skill",
    );
  });
});
