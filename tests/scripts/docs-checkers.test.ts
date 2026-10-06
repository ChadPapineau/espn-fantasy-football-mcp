// docs-checkers.test.ts — the docs.yml checkers (plan 04 §4.2: Mermaid, links) must be able to FAIL
// (their self-test fixtures) and pass on the tree; the Mermaid extractor is unit-tested without the
// renderer (the renderer runs in CI only). Adapted from the sibling's docs.yml self-tests (@d72e03b).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractMermaidBlocks } from "../../scripts/ci/check-mermaid.mjs";
import { ROOT, tempDir } from "../lint/helpers.js";

const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, [path.join(ROOT, "scripts", "ci", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" },
  });

describe("check-links", () => {
  it("fails on the self-test fixture with exactly 3 broken links", () => {
    const r = run("check-links.mjs", ["--no-annotate", "--root", "scripts/ci/docs-check-selftest"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(", 3 broken");
  });

  it("passes on the whole tree (the self-test directory is skipped by its marker)", () => {
    const r = run("check-links.mjs", []);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/, 0 broken$/m);
  });

  it("exits 2 on a usage error", () => {
    expect(run("check-links.mjs", ["--bogus"]).status).toBe(2);
  });
});

describe("check-mermaid (extract mode — the renderer is CI-only)", () => {
  it("finds the two self-test blocks", () => {
    const out = tempDir();
    try {
      const r = run("check-mermaid.mjs", [
        "--no-annotate",
        "--root",
        "scripts/ci/docs-check-selftest",
        "--out",
        out.dir,
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("2 mermaid block(s)");
    } finally {
      out.cleanup();
    }
  });

  it("finds every block in the tree (plan 10 Z2: docs/plan included) and none in the skipped fixture", () => {
    const out = tempDir();
    try {
      const r = run("check-mermaid.mjs", ["--no-annotate", "--out", out.dir]);
      expect(r.status).toBe(0);
      const n = Number(/check-mermaid: (\d+) mermaid block/.exec(r.stdout)?.[1] ?? "0");
      expect(n).toBeGreaterThan(0);
      expect(r.stdout).not.toContain("docs-check-selftest");
    } finally {
      out.cleanup();
    }
  });

  it("extractMermaidBlocks: fences, indentation, tildes, info strings, unterminated fences", () => {
    const md = [
      "```mermaid",
      "flowchart LR",
      "  A-->B",
      "```",
      "  ~~~~mermaid title",
      "  sequenceDiagram",
      "  ~~~~",
      "```js",
      "```mermaid inside js is not a block",
      "```",
      "```mermaidx",
      "not mermaid",
      "```",
      "```mermaid",
      "never closed",
    ].join("\n");
    const blocks = extractMermaidBlocks(md) as { line: number; text: string }[];
    expect(blocks.map((b) => b.line)).toEqual([1, 5]);
    expect(blocks[0]?.text).toBe("flowchart LR\n  A-->B\n");
    expect(blocks[1]?.text).toBe("sequenceDiagram\n");
  });
});
