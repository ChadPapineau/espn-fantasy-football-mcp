// workflows.test.ts — CI hygiene that must hold for every workflow (plan 04 §4: actions pinned by
// commit SHA, contents: read, no pull_request_target, persist-credentials: false, no secrets) and the
// job sets of plan 04 §4.1–§4.3 as built in this stage. Ported from sibling @d72e03b, adapted: no
// YAML parser is a dependency of this repo (plan 04 §2), so the workflows are read structurally —
// a job is a two-space-indented key under `jobs:`.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";

const dir = path.join(ROOT, ".github", "workflows");
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
/** The workflow without its comment lines (the headers explain the rules in prose). */
const load = (f: string) =>
  readFileSync(path.join(dir, f), "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** job name -> its block of text (from its key line to the next job key). */
function jobsOf(text: string): Map<string, string> {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  const jobs = new Map<string, string>();
  if (start === -1) return jobs;
  let name: string | null = null;
  let block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (m || /^\S/.test(line)) {
      if (name !== null) jobs.set(name, block.join("\n"));
      name = m ? (m[1] ?? null) : null;
      block = [];
      if (!m) break;
      continue;
    }
    block.push(line);
  }
  if (name !== null) jobs.set(name, block.join("\n"));
  return jobs;
}

/** The text of the step whose `name:` contains `needle` (to the next step). */
function step(job: string, needle: string): string {
  const parts = job.split(/\n(?= {6}- )/);
  return parts.find((p) => p.includes(needle)) ?? "";
}

const CANCEL_EXPR = "${{ github.event_name == 'pull_request' || github.ref != 'refs/heads/main' }}";

describe.each(files)("%s", (file) => {
  const text = load(file);
  const jobs = jobsOf(text);

  it("has read-only default permissions and nothing wider anywhere", () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(text).not.toMatch(/:\s*write\b/);
    expect(text).not.toMatch(/permissions:\s*write-all/);
  });

  it("never uses pull_request_target, and never reads a repository secret", () => {
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("pins every action to a full commit SHA with its version comment", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u[1], u[0]).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(u[2], u[0]).toMatch(/# v\d+\.\d+\.\d+/);
    }
  });

  it("checks out without persisting the job token", () => {
    const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0;
    const off = text.match(/persist-credentials: false/g)?.length ?? 0;
    expect(checkouts).toBeGreaterThan(0);
    expect(off).toBe(checkouts);
  });

  it("bounds every job with a timeout and runs on a pinned ubuntu image", () => {
    expect(jobs.size).toBeGreaterThan(0);
    for (const [name, block] of jobs) {
      expect(block, name).toMatch(/^ {4}timeout-minutes: \d+$/m);
      expect(block, name).toMatch(/^ {4}runs-on: ubuntu-24\.04$/m);
    }
  });

  it("installs with npm ci only (never npm install) and Node from .nvmrc", () => {
    expect(text).not.toMatch(/npm (?:install|i)\b(?! --)/);
    for (const [name, block] of jobs) {
      if (block.includes("actions/setup-node@"))
        expect(block, name).toContain("node-version-file: .nvmrc");
    }
  });

  it("cancels a superseded PR or non-main push run, never a run on main", () => {
    expect(text).toContain(`cancel-in-progress: ${CANCEL_EXPR}`);
  });
});

describe("ci.yml (plan 04 §4.1)", () => {
  const text = load("ci.yml");
  const jobs = jobsOf(text);
  const job = (n: string) => jobs.get(n) ?? "";

  it("runs on every push (no branch/path filter) and every pull request", () => {
    expect(text).toMatch(/^on:\n {2}push:\n {2}pull_request:\n/m);
  });

  it("has the plan 04 §4.1 jobs built in this stage", () => {
    expect([...jobs.keys()]).toEqual(
      expect.arrayContaining(["lint", "typecheck", "test", "supply-chain", "pack", "process"]),
    );
  });

  it.each([
    ["lint", ["npm run lint", "npm run format:check", "scripts/dev/check-commit-msg.mjs"]],
    ["typecheck", ["npm run typecheck"]],
    ["test", ["npm run test:coverage", "npm run check:coverage"]],
    [
      "supply-chain",
      [
        "npm audit --omit=dev --audit-level=high",
        "npm run check:no-scripts",
        "npm run check:licenses",
        "npm run check:runtime-tree",
      ],
    ],
    ["pack", ["npm run build", "npm run pack:scan"]],
    ["process", ["npm run build", "npm run test:process"]],
  ])("%s runs its gate commands, after npm ci", (name, commands) => {
    const block = job(name);
    expect(block).toMatch(/run: npm ci$/m);
    for (const c of commands) {
      expect(block, c).toContain(c);
      expect(block.indexOf("npm ci"), c).toBeLessThan(block.indexOf(c));
    }
  });

  it("the gating audit is not swallowed (only the report-only audit may be)", () => {
    const gate = step(job("supply-chain"), "high/critical fails");
    expect(gate).toContain("npm audit --omit=dev --audit-level=high");
    expect(gate).not.toMatch(/\|\||continue-on-error/);
  });
});

describe("docs.yml (plan 04 §4.2)", () => {
  const text = load("docs.yml");
  const jobs = jobsOf(text);
  const job = (n: string) => jobs.get(n) ?? "";

  it("runs on every push and PR, unfiltered (identifiers must see every change)", () => {
    expect(text).toMatch(/^on:\n {2}push:\n {2}pull_request:\n/m);
  });

  it("has the mermaid, links, identifiers and skills jobs", () => {
    expect([...jobs.keys()]).toEqual(
      expect.arrayContaining(["mermaid", "links", "identifiers", "skills"]),
    );
  });

  it("pins the renderer, puppeteer and the Claude Code CLI exactly", () => {
    expect(text).toMatch(/MERMAID_CLI: "@mermaid-js\/mermaid-cli@\d+\.\d+\.\d+"/);
    expect(text).toMatch(/PUPPETEER_PIN: "puppeteer@\d+\.\d+\.\d+"/);
    expect(text).toMatch(
      /CLAUDE_CODE_PLATFORM_PKG: "@anthropic-ai\/claude-code-linux-x64@\d+\.\d+\.\d+"/,
    );
  });

  it("mermaid: installs chrome-headless-shell explicitly before rendering, never through a postinstall (T-15(d))", () => {
    const m = job("mermaid");
    const install = m.indexOf("puppeteer browsers install chrome-headless-shell");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(m.indexOf("Render every mermaid block"));
    expect(m).not.toContain("--ignore-scripts=false");
    expect(m).toContain("rendered 1/2, failed 1"); // the self-test runs first
  });

  it("links: self-test, then the tree", () => {
    const l = job("links");
    expect(l.indexOf(", 3 broken")).toBeLessThan(l.indexOf("Check every internal link"));
  });

  it("identifiers: the scanner self-test, then every tracked file", () => {
    const i = job("identifiers");
    expect(i).toContain("node scripts/ci/secret-fixtures.mjs assert-scan");
    expect(i).toContain("node scripts/dev/scan-secrets.mjs --all");
    expect(i.indexOf("assert-scan")).toBeLessThan(i.indexOf("--all"));
  });

  it("skills: the structure check and claude plugin validate --strict on the root and the packed plugin", () => {
    const s = job("skills");
    expect(s).toContain("node scripts/ci/check-skills-structure.mjs");
    expect(s).toContain("node scripts/skills/check-skills.mjs");
    expect(s.indexOf("check-skills-structure.mjs")).toBeLessThan(
      s.indexOf("scripts/skills/check-skills.mjs"),
    );
    expect(s).toContain('plugin validate "$GITHUB_WORKSPACE" --strict');
    expect(s).toContain('/package/.claude-plugin/plugin.json" --strict');
    expect(s).toContain("--ignore-scripts");
  });
});

describe("secret-scan.yml — workflow `secrets` (plan 04 §4.1, §4.3)", () => {
  const text = load("secret-scan.yml");
  const jobs = jobsOf(text);
  const job = (n: string) => jobs.get(n) ?? "";

  it("scans the full history with full-depth checkout, the tree, and every tracked file", () => {
    const s = job("secrets");
    expect(s).toContain("fetch-depth: 0");
    expect(s).toContain(
      'gitleaks git --no-banner --redact --config .gitleaks.toml --log-opts="--all"',
    );
    expect(s).toContain("gitleaks dir --no-banner --redact --config .gitleaks.toml");
    expect(s).toContain("node scripts/dev/scan-secrets.mjs --all");
    // value-free reports: both scans end in an --expect-none assertion and their own exit code
    expect(
      s.match(/assert-gitleaks "\$RUNNER_TEMP\/(?:history|tree)\.json" --expect-none/g),
    ).toHaveLength(2);
    expect(s.match(/\[ "\$rc" -eq 0 \]/g)).toHaveLength(2);
  });

  it("self-test: generated fixtures, every rule must fire, placeholders must not, scan-secrets agrees", () => {
    const t = job("secrets-selftest");
    expect(t).toContain('secret-fixtures.mjs write "$RUNNER_TEMP/selftest"');
    expect(t).toContain("--expect-all");
    expect(t).toContain("--expect-none");
    expect(t).toContain("secret-fixtures.mjs assert-scan");
  });

  it("every gitleaks run redacts", () => {
    for (const m of text.matchAll(/gitleaks (?:git|dir) [^\n]*/g))
      expect(m[0]).toContain("--redact");
  });
});

describe("no tooling file is git-ignored (the repo .gitignore ignores e.g. `secrets.*`)", () => {
  it("every workflow, script, manifest and config file of the scaffold is committable", () => {
    const candidates = [
      ...readdirSync(dir).map((f) => `.github/workflows/${f}`),
      ...readdirSync(path.join(ROOT, "scripts/ci")).map((f) => `scripts/ci/${f}`),
      ...readdirSync(path.join(ROOT, "scripts/dev")).map((f) => `scripts/dev/${f}`),
      ...readdirSync(path.join(ROOT, ".claude-plugin")).map((f) => `.claude-plugin/${f}`),
      ...readdirSync(path.join(ROOT, ".githooks")).map((f) => `.githooks/${f}`),
      ".github/dependabot.yml",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".gitleaks.toml",
      ".mcp.json",
      ".npmrc",
      ".nvmrc",
      "scripts/eff-launch.sh",
      "package-lock.json",
      "CHANGELOG.md",
    ];
    const r = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: ROOT,
      input: candidates.join("\n"),
      encoding: "utf8",
    });
    expect(r.stdout.trim()).toBe("");
  });
});

describe("pins outside Dependabot", () => {
  it("install-gitleaks.sh pins an exact version and a sha256", () => {
    const s = readFileSync(path.join(ROOT, "scripts/ci/install-gitleaks.sh"), "utf8");
    expect(s).toMatch(/^GITLEAKS_VERSION="\d+\.\d+\.\d+"$/m);
    expect(s).toMatch(/^GITLEAKS_SHA256_LINUX_X64="[0-9a-f]{64}"$/m);
    expect(s).toContain("sha256sum -c -");
  });

  it("dependabot updates npm and github-actions monthly, grouped", () => {
    const d = readFileSync(path.join(ROOT, ".github/dependabot.yml"), "utf8");
    expect(d).toContain('package-ecosystem: "github-actions"');
    expect(d).toContain('package-ecosystem: "npm"');
    expect(d.match(/interval: "monthly"/g)).toHaveLength(2);
    expect(d.match(/groups:/g)).toHaveLength(2);
  });
});
