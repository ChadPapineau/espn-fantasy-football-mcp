// check-commit-msg.test.ts — Conventional Commits (plan 04 §3 R4) and no AI attribution trailer
// (CLAUDE.md "Workflow") for scripts/dev/check-commit-msg.mjs.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SUBJECT, TYPES, checkMessage } from "../../scripts/dev/check-commit-msg.mjs";
import { ROOT, tempDir } from "../lint/helpers.js";

const NOREPLY_ANTHROPIC = ["noreply", "anthropic.com"].join("@");

describe("checkMessage", () => {
  it.each([
    "feat: add a tool",
    "fix(scan): handle a NUL byte",
    "build(deps)!: bump the SDK",
    "docs(plan): record the pins",
    ...TYPES.map((t) => `${t}: x`),
    "Merge branch 'build/phase-1'",
    'Revert "feat: x"',
    "fixup! feat: x",
    "# a git comment line\nfeat: real subject",
    "\n\nfeat: after blank lines",
  ])("accepts %j", (m) => {
    expect(checkMessage(m)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["only comments", "# nothing\n# here"],
    ["no type", "add a tool"],
    ["unknown type", "feature: add"],
    ["missing space", "feat:add"],
    ["capitalised type", "Feat: add"],
    ["empty subject", "feat: "],
    ["bad scope", "feat(a b): x"],
    ["too long", `feat: ${"x".repeat(MAX_SUBJECT)}`],
  ])("refuses %s", (_why, m) => {
    expect(checkMessage(m)).not.toBeNull();
  });

  it.each([
    `feat: x\n\nCo-Authored-By: Claude Opus 5.5 <${NOREPLY_ANTHROPIC}>`,
    "feat: x\n\nco-authored-by: claude <x@y.z>",
    `feat: x\n\nCo-authored-by: GitHub Copilot <${["copilot", "github.com"].join("@")}>`,
    "feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    `feat: x\n\nsigned ${NOREPLY_ANTHROPIC}`,
  ])("refuses an AI attribution: %j", (m) => {
    expect(checkMessage(m)).toMatch(/AI attribution/);
  });

  it("a human co-author trailer is fine", () => {
    expect(
      checkMessage(
        `feat: x\n\nCo-Authored-By: Someone <${["1+someone", "users.noreply.github.com"].join("@")}>`,
      ),
    ).toBeNull();
  });
});

describe("CLI", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());
  const run = (args: string[]) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/dev/check-commit-msg.mjs"), ...args], {
      encoding: "utf8",
    });

  it("exit 0 / 1 / 2", () => {
    tmp = tempDir();
    writeFileSync(path.join(tmp.dir, "ok"), "feat: x\n");
    writeFileSync(path.join(tmp.dir, "bad"), "nope\n");
    expect(run([path.join(tmp.dir, "ok")]).status).toBe(0);
    expect(run([path.join(tmp.dir, "bad")]).status).toBe(1);
    expect(run([]).status).toBe(2);
    expect(run([path.join(tmp.dir, "missing")]).status).toBe(2);
  });
});
