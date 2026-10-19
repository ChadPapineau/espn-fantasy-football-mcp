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
    "feat: x\n\n#123 is a body line, published and harmless",
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
    // published verbatim by `git commit -m`/`-F` and `git commit-tree -F` (Stage C finding)
    ["a comment line before the subject", "# a git comment line\nfeat: real subject"],
    ["a #-prefixed non-conventional first line", "#wip: not conventional\nfeat: x"],
  ])("refuses %s", (_why, m) => {
    expect(checkMessage(m)).not.toBeNull();
  });

  it.each([
    `feat: x\n\nCo-Authored-By: Claude Opus 5.5 <${NOREPLY_ANTHROPIC}>`,
    "feat: x\n\nco-authored-by: claude <x@y.z>",
    `feat: x\n\nCo-authored-by: GitHub Copilot <${["copilot", "github.com"].join("@")}>`,
    "feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    `feat: x\n\nsigned ${NOREPLY_ANTHROPIC}`,
    // behind a comment character, a quote marker or a bullet: still published by -m/-F/commit-tree
    `feat: x\n\n# Co-Authored-By: Claude <${["claude", "example.invalid"].join("@")}>`,
    "feat: x\n\n> co-authored-by: Copilot",
    "feat: x\n\n- Co-authored-by: Gemini",
    `#wip: not conventional\nfeat: x\n\n# Co-Authored-By: Claude <${NOREPLY_ANTHROPIC}>`,
  ])("refuses an AI attribution: %j", (m) => {
    expect(checkMessage(m)).toMatch(/AI attribution/);
  });

  // GitHub starts no push/pull_request workflow for these, so no CI gate would check the push
  // (Stage C finding ci-skip-markers-accepted: all four repro messages were accepted)
  it.each([
    "fix: tidy the waiver notes [skip ci]",
    "docs: README [ci skip]",
    "chore: bump [skip actions]",
    "fix: x\n\n\nskip-checks: true",
    "fix: x\n\n\nskip-checks:true",
    "feat: x [no ci]",
    "feat: x [actions skip]",
    "feat: x\n\nbody line [Skip CI] in the body",
    "feat: x [ skip  ci ]",
    "feat: x\n\nSKIP-CHECKS : TRUE",
    "Merge branch 'build/phase-1' [skip ci]",
    'Revert "feat: x" [ci skip]',
  ])("refuses a GitHub skip-CI instruction: %j", (m) => {
    expect(checkMessage(m)).toMatch(/skip-CI instruction/);
  });

  it.each([
    "fix(ci): run every gate on every push",
    "docs: why a skip marker is refused",
    "fix: the skip list [skipped] stays",
    "feat: x\n\nskip-checks: false",
    "chore: [ci] tidy",
  ])("a message that only mentions skipping is fine: %j", (m) => {
    expect(checkMessage(m)).toBeNull();
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

  it("the Stage C repro: each skip-CI instruction is refused by the CLI the hooks run (exit 1)", () => {
    tmp = tempDir();
    const msg = path.join(tmp.dir, "msg");
    for (const m of [
      "fix: tidy the waiver notes [skip ci]",
      "docs: README [ci skip]",
      "chore: bump [skip actions]",
      "fix: x\n\n\nskip-checks: true",
    ]) {
      writeFileSync(msg, `${m}\n`);
      const r = run([msg]);
      expect(r.status, m).toBe(1);
      expect(r.stderr).toMatch(/skip-CI instruction/);
    }
  });

  it("the Stage C repro: a #-prefixed first line and a # Co-Authored-By trailer are refused (exit 1)", () => {
    tmp = tempDir();
    const msg = path.join(tmp.dir, "msg");
    writeFileSync(
      msg,
      `#wip: not conventional\nfeat: x\n\n# Co-Authored-By: Claude <${NOREPLY_ANTHROPIC}>\n`,
    );
    const r = run([msg]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AI attribution/);
    writeFileSync(msg, "#wip: not conventional\nfeat: x\n");
    const s = run([msg]);
    expect(s.status).toBe(1);
    expect(s.stderr).toMatch(/starts with "#"/);
  });
});
