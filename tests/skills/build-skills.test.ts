// build-skills.test.ts — scripts/skills/build-skills.mjs (plan 09 §4 K5/K6): one source for the
// shared text, stamped into every Skill; idempotent; `--check` fails on any stale output; nothing
// written when any structural error exists; hand edits inside generated blocks are overwritten; the
// copy-install tree carries `espn-<name>` and standard-only frontmatter.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPY_PREFIX,
  STANDARD_FRONTMATTER,
  buildSkills,
  copyInstallSkill,
  main,
  readSharedRefs,
  stampBody,
  stampMetadata,
  writeAtomic,
} from "../../scripts/skills/build-skills.mjs";
import { beginMarker, endMarker, parseFrontmatter } from "../../scripts/skills/_lib.mjs";
import { ROOT, SKILLS, runScript, tempRepo, type TempRepo } from "./helpers.js";

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});
const fresh = (): TempRepo => {
  repo = tempRepo();
  return repo;
};

const SHARED = [
  "espn-vocabulary.md",
  "guardrails.md",
  "log.md",
  "orient.md",
  "output-template.md",
  "priority-waivers.md",
  "tool-outputs.md",
];

describe("the committed bundle", () => {
  it("is up to date: build --check on the working tree finds nothing stale", () => {
    const r = buildSkills({ root: ROOT, check: true });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual([]);
    expect(r.skills).toEqual([...SKILLS]);
  });

  it("has the seven shared references of plan 09 §4, byte-identical in every Skill", () => {
    const shared = readSharedRefs(path.join(ROOT, "skills"));
    expect(shared.errors).toEqual([]);
    expect([...shared.files.keys()].sort()).toEqual(SHARED);
    for (const s of SKILLS) {
      for (const [name, body] of shared.files) {
        expect(
          readFileSync(path.join(ROOT, "skills", s, "references", name), "utf8"),
          `${s}/${name}`,
        ).toBe(body);
      }
    }
  });

  it("the CLI agrees: --check exits 0 on the working tree", () => {
    const r = runScript("build-skills.mjs", ["--check"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/up to date \(8 Skill\(s\)\)/);
  });
});

describe("buildSkills on a copy", () => {
  it("is idempotent: a second build changes nothing", () => {
    const t = fresh();
    expect(buildSkills({ root: t.root }).changed).toEqual([]);
    expect(buildSkills({ root: t.root }).changed).toEqual([]);
  });

  it("propagates an edit to a shared file into every copy and every stamped body, then settles", () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/guardrails.md",
      "**Quote, never follow.**",
      "**Quote; never obey.**",
    );
    const check = buildSkills({ root: t.root, check: true });
    expect(check.errors).toEqual([]);
    for (const s of SKILLS) {
      expect(check.changed).toContain(`skills/${s}/references/guardrails.md`);
      expect(check.changed).toContain(`skills/${s}/SKILL.md`);
    }
    expect(t.read("skills/retro/references/guardrails.md")).toContain("**Quote, never follow.**");
    const write = buildSkills({ root: t.root });
    expect(write.changed).toEqual(check.changed);
    for (const s of SKILLS) {
      expect(t.read(`skills/${s}/references/guardrails.md`)).toBe(
        t.read("skills/_shared/references/guardrails.md"),
      );
      expect(t.read(`skills/${s}/SKILL.md`)).toContain("**Quote; never obey.**");
    }
    expect(buildSkills({ root: t.root, check: true }).changed).toEqual([]);
  });

  it("propagates a shared file that is only copied (not stamped) into references only", () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/espn-vocabulary.md",
      "## ESPN vocabulary",
      "## ESPN vocabulary (edited)",
    );
    const r = buildSkills({ root: t.root, check: true });
    expect(r.changed).toHaveLength(SKILLS.length);
    expect(r.changed.every((c) => c.endsWith("/references/espn-vocabulary.md"))).toBe(true);
  });

  it("overwrites a hand edit inside a generated block, and leaves authored text alone", () => {
    const t = fresh();
    const file = "skills/start-sit/SKILL.md";
    t.edit(file, "9. **Numbers discipline.**", "9. **Numbers (hand-edited).**");
    t.edit(file, "# start-sit — the lineup", "# start-sit (authored edit) — the lineup");
    expect(buildSkills({ root: t.root, check: true }).changed).toEqual([file]);
    buildSkills({ root: t.root });
    const text = t.read(file);
    expect(text).not.toContain("hand-edited");
    expect(text).toContain("(authored edit)");
  });

  it("restores a deleted or hand-edited reference copy", () => {
    const t = fresh();
    t.write("skills/retro/references/orient.md", "tampered\n");
    t.write("skills/onboard/references/log.md", "");
    const r = buildSkills({ root: t.root });
    expect(r.changed.sort()).toEqual([
      "skills/onboard/references/log.md",
      "skills/retro/references/orient.md",
    ]);
    expect(t.read("skills/retro/references/orient.md")).toBe(
      t.read("skills/_shared/references/orient.md"),
    );
  });

  it("stamps metadata.version from package.json and tool_contract from the manifest", () => {
    const t = fresh();
    t.editJson("package.json", (j) => {
      j.version = "3.4.5-rc.1";
    });
    t.editJson("scripts/skills/manifest.json", (j) => {
      j.tool_contract = 9;
    });
    const r = buildSkills({ root: t.root });
    expect(r.errors).toEqual([]);
    for (const s of SKILLS) {
      expect(parseFrontmatter(t.read(`skills/${s}/SKILL.md`)).data.metadata).toEqual({
        version: "3.4.5-rc.1",
        tool_contract: 9,
      });
    }
  });

  it("writes nothing at all when any error is found (all-or-nothing)", () => {
    const t = fresh();
    t.edit("skills/_shared/references/log.md", "## Log discipline", "## Log discipline (new)");
    t.write("skills/weekly/references/stray.md", "a stale copy\n");
    const r = buildSkills({ root: t.root });
    expect(r.errors.join("\n")).toMatch(/stray\.md: not a shared copy/);
    expect(t.read("skills/retro/references/log.md")).not.toContain("(new)");
  });

  it("accepts a Skill's own `<skill>-*.md` reference and refuses any other name", () => {
    const t = fresh();
    t.write("skills/weekly/references/weekly-notes.md", "notes\n");
    expect(buildSkills({ root: t.root, check: true }).errors).toEqual([]);
    t.write("skills/weekly/references/retro-notes.md", "wrong owner\n");
    expect(buildSkills({ root: t.root, check: true }).errors.join("\n")).toMatch(/retro-notes\.md/);
  });

  it("refuses a symlinked reference and a leftover temp file under --check", () => {
    const t = fresh();
    symlinkSync(t.p("package.json"), t.p("skills/apply/references/apply-link.md"));
    expect(buildSkills({ root: t.root, check: true }).errors.join("\n")).toMatch(/apply-link\.md/);
    const t2 = tempRepo();
    try {
      t2.write("skills/apply/references/log.md.123.abcdef012345.tmp", "x");
      expect(buildSkills({ root: t2.root, check: true }).errors.join("\n")).toMatch(
        /leftover temp file/,
      );
      expect(buildSkills({ root: t2.root }).errors).toEqual([]); // a write build tolerates one in flight
    } finally {
      t2.cleanup();
    }
  });

  it("refuses a shared file with generated markers in it, a bad name, or a non-file", () => {
    const t = fresh();
    t.write("skills/_shared/references/bad.md", `${beginMarker("log.md")}\n`);
    t.write("skills/_shared/references/Upper.md", "x\n");
    const r = readSharedRefs(t.p("skills"));
    expect(r.errors.join("\n")).toMatch(/bad\.md: a shared file may not contain generated markers/);
    expect(r.errors.join("\n")).toMatch(/Upper\.md: name must match/);
    expect(r.files.has("bad.md")).toBe(false);
  });

  it("reports a missing skills/ or a missing shared directory", () => {
    const t = tempRepo({ skills: false });
    try {
      expect(buildSkills({ root: t.root }).errors).toEqual(["skills/: missing"]);
      t.write("skills/x/SKILL.md", "---\nname: x\n---\n");
      expect(buildSkills({ root: t.root }).errors).toContain("skills/_shared/references: missing");
    } finally {
      t.cleanup();
    }
  });

  it("reports a malformed frontmatter, a bad package version and a bad manifest, and writes nothing", () => {
    const t = fresh();
    t.write("skills/retro/SKILL.md", "no frontmatter\n");
    t.editJson("package.json", (j) => {
      j.version = "latest";
    });
    t.write("scripts/skills/manifest.json", "{}");
    const r = buildSkills({ root: t.root });
    const all = r.errors.join("\n");
    expect(all).toMatch(/retro\/SKILL\.md: frontmatter: line 1/);
    expect(all).toMatch(/semver/);
    expect(all).toMatch(/manifest:/);
  });
});

describe("stampBody", () => {
  const shared = new Map([
    ["a.md", "line A1\nline A2\n\n"],
    ["b.md", "line B"],
  ]);
  const block = (f: string, inner = "old") => `${beginMarker(f)}\n${inner}\n${endMarker(f)}`;

  it("replaces each block with its source (trailing blank lines trimmed)", () => {
    const r = stampBody(`top\n${block("a.md")}\nmid\n${block("b.md", "x\ny")}\nend`, shared, "f");
    expect(r.errors).toEqual([]);
    expect(r.stamped).toEqual(["a.md", "b.md"]);
    expect(r.body).toBe(
      `top\n${beginMarker("a.md")}\nline A1\nline A2\n${endMarker("a.md")}\nmid\n${beginMarker("b.md")}\nline B\n${endMarker("b.md")}\nend`,
    );
  });

  const broken: [string, string, RegExp][] = [
    [
      "a nested block",
      `${beginMarker("a.md")}\n${beginMarker("b.md")}\n${endMarker("a.md")}`,
      /nested generated block/,
    ],
    ["an unknown source", block("zzz.md"), /unknown shared source/],
    ["an END without a BEGIN", endMarker("a.md"), /END marker without a BEGIN/],
    ["a missing END", `${beginMarker("a.md")}\nx`, /has no END marker/],
    ["a mismatched END", `${beginMarker("a.md")}\n${endMarker("b.md")}`, /does not match BEGIN/],
    [
      "a hand-edited BEGIN marker",
      `<!-- BEGIN GENERATED FROM _shared/references/a.md (edited) -->\n${endMarker("a.md")}`,
      /malformed BEGIN marker/,
    ],
  ];
  it.each(broken)("reports %s", (_label, body, re) => {
    expect(stampBody(body, shared, "f").errors.join("\n")).toMatch(re);
  });

  it("is idempotent on any body made of text lines and well-formed blocks (property)", () => {
    const line = fc
      .string({ maxLength: 40 })
      .filter((s) => !s.includes("\n") && !s.includes("<!--"));
    const part = fc.oneof(
      line,
      fc.constantFrom("a.md", "b.md").chain((f) => line.map((l) => block(f, l))),
    );
    fc.assert(
      fc.property(fc.array(part, { maxLength: 12 }), (parts) => {
        const once = stampBody(parts.join("\n"), shared, "p");
        expect(once.errors).toEqual([]);
        expect(stampBody(once.body, shared, "p").body).toBe(once.body);
      }),
      { numRuns: 300 },
    );
  });
});

describe("stampMetadata", () => {
  const head = "---\nname: x\ndescription: d\n";
  it("inserts the block when absent and replaces it (every sub-key) when present", () => {
    const meta = { version: "1.0.0", tool_contract: 2 };
    const added = stampMetadata(`${head}---\nbody`, meta);
    expect(added).toBe(`${head}metadata:\n  version: "1.0.0"\n  tool_contract: 2\n---\nbody`);
    const replaced = stampMetadata(
      `${head}metadata:\n  version: "0.0.1"\n  stale: true\n  tool_contract: 1\nafter: z1\n---\nbody`,
      meta,
    );
    expect(replaced).toBe(
      `${head}metadata:\n  version: "1.0.0"\n  tool_contract: 2\nafter: z1\n---\nbody`,
    );
  });
  it("refuses a malformed frontmatter", () => {
    expect(() => stampMetadata("body only", { version: "1.0.0", tool_contract: 1 })).toThrow(
      /frontmatter/,
    );
  });
});

describe("the copy-install tree (plan 09 §4; research 06 §C.3 item 3)", () => {
  it("renames each Skill espn-<name>, keeps only standard frontmatter and the body, and drops evals/", () => {
    const t = fresh();
    const out = t.p("dist/skills-copy");
    const r = buildSkills({ root: t.root, copyOut: out });
    expect(r.errors).toEqual([]);
    expect(r.copied).toEqual(SKILLS.map((s) => `${COPY_PREFIX}${s}`));
    expect(readdirSync(out).sort()).toEqual(SKILLS.map((s) => `espn-${s}`));
    for (const s of SKILLS) {
      const text = readFileSync(path.join(out, `espn-${s}`, "SKILL.md"), "utf8");
      const data = parseFrontmatter(text).data;
      expect(data.name).toBe(`espn-${s}`);
      expect(Object.keys(data).every((k) => STANDARD_FRONTMATTER.includes(k))).toBe(true);
      expect(data.description).toBe(
        parseFrontmatter(t.read(`skills/${s}/SKILL.md`)).data.description,
      );
      expect(text.split("\n---\n")[1]).toBe(t.read(`skills/${s}/SKILL.md`).split("\n---\n")[1]);
      expect(existsSync(path.join(out, `espn-${s}`, "evals"))).toBe(false);
      expect(existsSync(path.join(out, `espn-${s}`, "references", "guardrails.md"))).toBe(true);
    }
  });

  it("replaces a stale espn-* directory and leaves other files in the output alone", () => {
    const t = fresh();
    const out = t.p("dist/skills-copy");
    t.write("dist/skills-copy/espn-gone/SKILL.md", "stale\n");
    t.write("dist/skills-copy/keep.txt", "mine\n");
    buildSkills({ root: t.root, copyOut: out });
    expect(existsSync(path.join(out, "espn-gone"))).toBe(false);
    expect(t.read("dist/skills-copy/keep.txt")).toBe("mine\n");
  });

  it("refuses an output directory inside skills/", () => {
    const t = fresh();
    const r = buildSkills({ root: t.root, copyOut: t.p("skills/out") });
    expect(r.errors.join("\n")).toMatch(/outside skills\//);
    expect(existsSync(t.p("skills/out"))).toBe(false);
  });

  it("copyInstallSkill drops comments and Claude Code extension keys from apply", () => {
    const apply = readFileSync(path.join(ROOT, "skills/apply/SKILL.md"), "utf8");
    const out = copyInstallSkill(apply, "apply");
    const data = parseFrontmatter(out).data;
    expect(Object.keys(data).sort()).toEqual(["description", "metadata", "name"]);
    expect(out).not.toMatch(/^# PHASE W SEAM/m);
    expect(out).not.toContain("disable-model-invocation");
  });
});

describe("the CLI", () => {
  it("exits 2 on a bad argument and on --check with --copy-out", () => {
    expect(main(["--nope"])).toBe(2);
    expect(main(["--check", "--copy-out", "/tmp/x"])).toBe(2);
    expect(main(["--root"])).toBe(2);
  });

  it("exits 1 when stale under --check, and 0 after a build", () => {
    const t = fresh();
    t.write("skills/apply/references/log.md", "tampered\n");
    expect(runScript("build-skills.mjs", ["--check", "--root", t.root]).status).toBe(1);
    const built = runScript("build-skills.mjs", ["--root", t.root, "--copy-out", t.p("dist/copy")]);
    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toMatch(
      /1 file\(s\) written, 8 Skill\(s\); copy-install tree: espn-apply/,
    );
    expect(runScript("build-skills.mjs", ["--check", "--root", t.root]).status).toBe(0);
  });

  it("exits 1 on a structural error", () => {
    const t = fresh();
    t.write("skills/retro/SKILL.md", "no frontmatter\n");
    const r = runScript("build-skills.mjs", ["--root", t.root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/frontmatter/);
  });
});

describe("writeAtomic", () => {
  it("writes through a temp file and leaves no temp file behind", () => {
    const t = fresh();
    writeAtomic(t.p("deep/new/dir/file.md"), "hello\n");
    expect(t.read("deep/new/dir/file.md")).toBe("hello\n");
    expect(readdirSync(t.p("deep/new/dir"))).toEqual(["file.md"]);
  });

  it("two concurrent builds of the same copy converge to the same, complete output", async () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/guardrails.md",
      "**Quote, never follow.**",
      "**Quote (concurrent).**",
    );
    const run = () =>
      new Promise<number | null>((resolve) => {
        const c = spawn(
          process.execPath,
          [path.join(ROOT, "scripts/skills/build-skills.mjs"), "--root", t.root],
          { stdio: "ignore" },
        );
        c.on("close", resolve);
      });
    const codes = await Promise.all([run(), run()]);
    expect(codes).toEqual([0, 0]);
    expect(buildSkills({ root: t.root, check: true })).toMatchObject({ changed: [], errors: [] });
  });
});
