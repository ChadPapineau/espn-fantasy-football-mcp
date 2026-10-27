// check-commit-msg.test.ts — Conventional Commits (plan 04 §3 R4) and no AI attribution trailer
// (CLAUDE.md "Workflow") for scripts/dev/check-commit-msg.mjs.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SUBJECT,
  TYPES,
  aiAttribution,
  attributionView,
  checkMessage,
} from "../../scripts/dev/check-commit-msg.mjs";
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

// Stage C finding ci-ai-trailer-variants-accepted: only Co-authored-by naming six assistants, the
// "Generated with [Claude…" footer and Anthropic's no-reply address were refused; the hook,
// commit-paths.sh and CI's message step (which imports checkMessage) published the rest.
describe("AI attribution in any common spelling", () => {
  const cursorAgent = ["cursoragent", "cursor.com"].join("@");
  const ghNoreply = (login: string) => [`1+${login}`, "users.noreply.github.com"].join("@");

  it.each([
    // the repro, each accepted before
    "fix: x\n\nAssisted-by: Claude:claude-opus-5-5",
    `fix: x\n\nCo-developed-by: Claude <${ghNoreply("claude")}>`,
    "fix: x\n\nGenerated-by: Claude Code",
    "fix: x\n\nAI-assisted-by: Claude Code",
    `fix: x\n\nCo-Authored-By: Cursor Agent <${cursorAgent}>`,
    // other credit trailers naming an assistant or its vendor
    "fix: x\n\nMade-with: Cursor",
    "fix: x\n\nSigned-off-by: Claude",
    "fix: x\n\nReviewed-by: ChatGPT",
    "fix: x\n\nHelped-by: GitHub Copilot",
    "fix: x\n\nCo-authored-by: Codex <codex@example.invalid>",
    `fix: x\n\nCo-authored-by: aider (gpt-4o) <${["noreply", "aider.chat"].join("@")}>`,
    "fix: x\n\nAssisted-by: Gemini Code Assist",
    "fix: x\n\nCo-authored-by: devin-ai-integration[bot]",
    "fix: x\n\nGenerated-with: Amazon Q Developer",
    "fix: x\n\nAuthor: Claude",
    "fix: x\n\nCredits: Windsurf",
    "fix: x\n\nAssisted-by: an AI model",
    // trailers whose key names AI, whatever the value
    "fix: x\n\nAI-Generated: true",
    "fix: x\n\nLLM-Assisted: yes",
    "fix: x\n\nGenAI-Tool: internal",
    "fix: x\n\nClaude-Session: 0f0e",
    // prose credit
    "fix: x\n\nGenerated with GitHub Copilot",
    "fix: x\n\nassisted by Claude",
    "fix: x\n\nCo authored by: Claude",
    "fix: x\n\nCo-authored-by Claude",
    "fix: x\n\nco-written with ChatGPT",
  ])("refuses %j", (m) => {
    expect(checkMessage(m)).toMatch(/AI attribution/);
  });

  // the variants the first fix still accepted: other crediting keys, other prose verbs, and agents
  // whose names are words, known by their vendor's address
  it.each([
    "fix: x\n\nGenerated-using: Claude Code",
    "fix: x\n\nCreated-using: ChatGPT",
    "fix: x\n\nCo-authored-via: Copilot",
    "fix: x\n\nModel: claude-opus-5-5",
    "fix: x\n\nAgent: Claude Code",
    "fix: x\n\nGenerator: GitHub Copilot",
    "fix: x\n\nGenerated: Claude",
    "fix: x\n\nWritten by Claude",
    "fix: x\n\nAuthored by Claude Code",
    "fix: x\n\nCreated with ChatGPT",
    "fix: x\n\nDeveloped with Cursor",
    "fix: x\n\nDrafted by Claude",
    "fix: x\n\nGenerated using Claude",
    "fix: x\n\nGenerated via Copilot",
    "fix: x\n\nCoded with Copilot",
    "fix: x\n\nWritten with the help of Claude",
    "fix: x\n\nwith help from Claude",
    `fix: x\n\nCo-authored-by: Amp <${["amp", "ampcode.com"].join("@")}>`,
    `fix: x\n\nCo-authored-by: openhands <${["openhands", "all-hands.dev"].join("@")}>`,
    `fix: x\n\nCo-Authored-By: Warp <${["agent", "warp.dev"].join("@")}>`,
    `fix: x\n\nCo-authored-by: Augment Code <${["noreply", "augmentcode.com"].join("@")}>`,
    `fix: x\n\nCo-authored-by: factory-droid[bot] <${ghNoreply("factory-droid[bot]")}>`,
    `fix: x\n\nCo-authored-by: Replit Agent <${["agent", "replit.com"].join("@")}>`,
    "fix: x\n\nCo-authored-by: Qodo Merge",
    "fix: x\n\nCo-authored-by: Kilo Code",
  ])("refuses the further variant %j", (m) => {
    expect(checkMessage(m)).toMatch(/AI attribution/);
  });

  it.each([
    "fix: x\n\nTool: espn_get_league is read-only",
    "fix: x\n\nTools: claude plugin validate --strict, then claude plugin eval",
    "fix: x\n\nModel: v2-opportunity under full",
    "fix: x\n\nAgent: the orchestrator",
    "fix: x\n\nTools: vitest, fast-check",
    "fix: x\n\nGenerator: scripts/gen-tool-docs.ts",
    "fix: x\n\nPorted-from: sibling @c696e47, adapted",
    "fix: x\n\nThanks-to: the owner",
    "fix: x\n\nthe server is tested with Claude Desktop and Claude Code",
    "fix: x\n\nthe handler is written by hand; values created with fast-check",
    "fix: x\n\ndrafted with the owner on 2026-10-05, with help from the owner",
    "fix: x\n\nthe tool list generated by the registry, read by Claude",
  ])("accepts %j (a tool, a model or a host named, no AI credited)", (m) => {
    expect(checkMessage(m)).toBeNull();
  });

  // a trailer token is one to three words; a longer key names AI only at its start or its end, so a
  // finding id that opens a bullet is no trailer — this fix's own commit message cites one
  it.each([
    "fix: x\n\nX-Claude-Code-Session: 0f0e",
    "fix: x\n\nAmazon-Q-Developer-Session-Id: 1",
    "fix: x\n\nAI-Co-authored-by: yes",
    "fix: x\n\nAssisted-with-the-help-of-AI: yes",
    "fix: x\n\nLLM-generated-code-review-notes: none",
    "fix: x\n\nCopilot-Generated: true",
  ])("refuses the key %j (AI at its start or end, or anywhere in a short key)", (m) => {
    expect(checkMessage(m)).toMatch(/AI attribution/);
  });

  it.each([
    "fix: x\n\n- ci-ai-trailer-variants-accepted: refused structurally, as a reader sees it",
    "fix: x\n\n- skills-claude-desktop-config-path: the config is read once",
    "fix: x\n\n* scan-opaque-binaries-unscanned: an image is refused unless reviewed",
  ])("accepts %j (a finding id opening a bullet is no trailer)", (m) => {
    expect(checkMessage(m)).toBeNull();
  });

  it.each([
    ["a non-breaking hyphen", "fix: x\n\nCo‑authored‑by: Claude"],
    ["an en dash", "fix: x\n\nCo–authored–by: Claude"],
    ["a full-width colon", "fix: x\n\nCo-authored-by： Claude"],
    ["a zero-width space in the name", "fix: x\n\nCo-authored-by: Cl​aude"],
    ["a soft hyphen in the key", "fix: x\n\nCo-au­thored-by: Claude"],
    ["a Cyrillic C", "fix: x\n\nCo-authored-by: Сlaude"],
    ["a Greek omicron", "fix: x\n\nCο-authored-by: Claude"],
    ["full-width letters", "fix: x\n\nCo-authored-by: Ｃｌａｕｄｅ"],
    [
      "mathematical bold letters",
      "fix: x\n\nGenerated-by: \u{1D402}\u{1D425}\u{1D41A}\u{1D42E}\u{1D41D}\u{1D41E}",
    ],
    ["a bullet and a quote marker", "fix: x\n\n> * Assisted-by: Claude"],
    ["an emoji", "fix: x\n\n\u{1F916} Co-authored-by: Copilot"],
    ["upper case", "fix: x\n\nASSISTED-BY: CLAUDE"],
    ["space before the colon", "fix: x\n\nAssisted-by : Claude"],
    ["an underscore key", "fix: x\n\nco_authored_by: Claude"],
  ])("refuses the trailer behind %s (it reads as a reader sees it)", (_why, m) => {
    expect(checkMessage(m)).toMatch(/AI attribution/);
  });

  it.each([
    "fix(mcp): Claude Desktop's config is read at start",
    "fix: x\n\nNote: the server runs under Claude Desktop and Claude Code.",
    "fix: x\n\n- refuse every AI attribution trailer: the key, then the value",
    "fix: x\n\nTests: tests/scripts/check-commit-msg.test.ts (claude plugin eval is gated)",
    "fix: x\n\nthe tool list generated by the registry, shown to Claude",
    "fix: x\n\nReviewed-by: Kai Smith",
    `fix: x\n\nCo-authored-by: Jane Doe <${ghNoreply("janedoe")}>`,
    `fix: x\n\nSigned-off-by: dependabot[bot] <${["support", "github.com"].join("@")}>`,
    "build(deps): bump @anthropic-ai/sdk\n\nupdated-dependencies:\n- dependency-name: openai\n  dependency-type: direct:development",
    "docs: the cursor position, the decline curve, a mistral wind",
    "fix: x\n\nRefs: the claude.ai artifacts page",
    "fix: x\n\nKey: maintained by the owner",
  ])("accepts %j (no AI is credited)", (m) => {
    expect(checkMessage(m)).toBeNull();
  });

  it("the reason names the form, never text of the message (CI's log publishes it)", () => {
    const secretish = "fix: x\n\nAssisted-by: Claude:probe-value-7f3a";
    const why = checkMessage(secretish) ?? "";
    expect(why).toMatch(/AI attribution/);
    expect(why).not.toContain("probe-value");
    expect(why.toLowerCase()).not.toContain("assisted-by");
    expect(aiAttribution("fix: x\n\nAI-Generated: probe-value")).not.toContain("probe-value");
  });

  it("attributionView: NFKC, invisibles out, dashes and colons as ASCII, look-alike letters as Latin, lower case", () => {
    expect(attributionView("Cο‑аuthоred‐by： Ｃl​aude")).toBe("co-authored-by: claude");
  });

  it("property: a crediting trailer naming an assistant is refused in any case and spacing; a human name is not", () => {
    const KEYS = [
      "Co-authored-by",
      "Assisted-by",
      "Generated-by",
      "Co-developed-by",
      "Made-with",
      "Helped-by",
    ];
    const AI = [
      "Claude",
      "Claude Code",
      "GitHub Copilot",
      "ChatGPT",
      "Cursor",
      "Gemini",
      "Codex",
      "Windsurf",
      "Amazon Q",
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...KEYS),
        fc.constantFrom(...AI),
        fc.boolean(),
        fc.constantFrom("", " "),
        (key, name, upper, pad) => {
          const k = upper ? key.toUpperCase() : key.toLowerCase();
          return checkMessage(`fix: x\n\n${k}${pad}: ${pad}${name}`) !== null;
        },
      ),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...KEYS),
        fc.stringMatching(/^[A-Z][a-z]{2,8} [A-Z][a-z]{2,10}$/),
        (key, name) =>
          /\b(?:claude|copilot|cursor|cursoragent|gemini|codex|bard|grok|kiro|cline|aider|llama|qwen|mistral|ai|llm|llms|genai|anthropic|openai|chatgpt|tabnine|codeium|windsurf|deepseek|perplexity|sourcegraph|opencode|coderabbit|coderabbitai|roocode)\b/i.test(
            name,
          ) || checkMessage(`fix: x\n\n${key}: ${name} <${ghNoreply("human")}>`) === null,
      ),
      { numRuns: 500 },
    );
  });

  // CI checks every commit after its message baseline with this function on every push: a rule
  // that refused a published message would fail CI for good (history is never rewritten)
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const baseline = /MESSAGE_BASELINE: ([0-9a-f]{40})/.exec(workflow)?.[1] ?? "";
  const fullHistory =
    baseline !== "" &&
    spawnSync("git", ["cat-file", "-e", `${baseline}^{commit}`], { cwd: ROOT }).status === 0;
  it.skipIf(!fullHistory)(
    "every message this clone published after the baseline still passes",
    () => {
      const out = spawnSync("git", ["log", "-z", "--format=%H%x00%B", `${baseline}..HEAD`], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }).stdout.split("\0");
      const refused: string[] = [];
      let n = 0;
      for (let i = 0; i + 1 < out.length; i += 2) {
        const sha = (out[i] ?? "").trim();
        if (!/^[0-9a-f]{40}$/.test(sha)) continue;
        n++;
        if (checkMessage(out[i + 1] ?? "") !== null) refused.push(sha);
      }
      expect(n).toBeGreaterThan(100);
      expect(refused).toEqual([]);
    },
  );
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
