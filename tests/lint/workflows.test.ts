// workflows.test.ts — CI hygiene that must hold for every workflow (plan 04 §4: actions pinned by
// commit SHA, contents: read, no pull_request_target, persist-credentials: false, no secrets) and the
// job sets of plan 04 §4.1–§4.3 as built in this stage. Ported from sibling @d72e03b, adapted: no
// YAML parser is a dependency of this repo (plan 04 §2), so the workflows are read structurally —
// a job is a two-space-indented key under `jobs:`. The commit-identity step (CLAUDE.md "Security";
// Stage C finding ci-commit-identity-unchecked) is also RUN: its `run:` block, cut out of ci.yml
// exactly as YAML reads it, is executed against throwaway repositories and this clone's history.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT, tempDir } from "./helpers.js";

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

  it("bounds every job with a timeout and runs on a pinned image (ubuntu; the -macos jobs macOS)", () => {
    expect(jobs.size).toBeGreaterThan(0);
    for (const [name, block] of jobs) {
      expect(block, name).toMatch(/^ {4}timeout-minutes: \d+$/m);
      if (name.endsWith("-macos")) expect(block, name).toMatch(/^ {4}runs-on: macos-15$/m);
      else expect(block, name).toMatch(/^ {4}runs-on: ubuntu-24\.04$/m);
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

  it("has the plan 04 §4.1 jobs, process-macos and smoke included", () => {
    expect([...jobs.keys()]).toEqual(
      expect.arrayContaining([
        "lint",
        "typecheck",
        "test",
        "supply-chain",
        "pack",
        "process",
        "process-macos",
        "smoke",
      ]),
    );
  });

  it("process runs against the built dist; macOS only weekly or on demand, with the keychain round trip (A15a)", () => {
    const p = job("process");
    expect(p.indexOf("npm run build")).toBeLessThan(p.indexOf("npm run test:process"));
    expect(step(p, "suites against dist")).toContain('EFF_PROCESS_TEST_DIST: "1"');
    const mac = job("process-macos");
    expect(mac).toContain(
      "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    );
    expect(mac.indexOf("npm run build")).toBeLessThan(mac.indexOf("npm run test:process"));
    expect(mac).toContain('EFF_KEYCHAIN_PROCESS_TEST: "1"');
    expect(text).toMatch(/^ {2}schedule:\n {4}- cron: "[0-9* ]+"/m);
  });

  it("smoke builds, runs the SDK smoke and the Inspector pinned to an exact version (A3a)", () => {
    const sm = job("smoke");
    expect(sm).toMatch(/INSPECTOR: "@modelcontextprotocol\/inspector@\d+\.\d+\.\d+"/);
    expect(sm.indexOf("npm run build")).toBeLessThan(sm.indexOf("npm run smoke"));
    expect(sm).toContain('npx --yes "$INSPECTOR" --cli');
    expect(sm).toContain('--method "$method" --format json');
    expect(sm).toContain("tests/smoke/fixture-serve.mjs");
    expect(sm).toContain("tests/smoke/assert-inspector.mjs");
    expect(step(sm, "MCP Inspector CLI")).toContain('npm_config_ignore_scripts: "true"');
    // plan 10 B10: the Inspector lists both toolsets (18 / 34 tools, 8 / 13 prompts)
    expect(sm).toContain("for toolset in core full; do");
    expect(sm).toContain('fixture-serve.mjs" "$toolset"');
    expect(sm).toContain('assert-inspector.mjs" --toolset "$toolset"');
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

// --- the commit identity, enforced in CI (the local hooks are bypassable) -------------------------

/** The raw lines (comments kept) of ci.yml's step whose `- name:` contains `needle`. */
function rawStep(file: string, needle: string): string[] {
  const lines = readFileSync(path.join(dir, file), "utf8").split("\n");
  const start = lines.findIndex((l) => /^ {6}- name: /.test(l) && l.includes(needle));
  if (start === -1) return [];
  let end = start + 1;
  while (end < lines.length && !/^ {6}- |^ {0,2}\S/.test(lines[end] ?? "")) end++;
  return lines.slice(start, end);
}

/** A step's `run: |` literal block, dedented exactly as YAML reads it (clip chomping). */
function runBlock(lines: string[]): string {
  const at = lines.findIndex((l) => /^ {8}run: \|\s*$/.test(l));
  if (at === -1) return "";
  const body = lines.slice(at + 1);
  const first = body.find((l) => l.trim() !== "") ?? "";
  const indent = first.length - first.trimStart().length;
  const out: string[] = [];
  for (const l of body) {
    if (l.trim() !== "" && l.length - l.trimStart().length < indent) break;
    out.push(l.slice(indent));
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** A step's `env:` value for `key` (one line, unquoted). */
function stepEnv(lines: string[], key: string): string | undefined {
  const re = new RegExp(`^ {10}${key}: (.+?)\\s*$`);
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1]?.replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}

// Addresses are joined at run time so no literal address sits in this file (the identifiers scan).
const NOREPLY = ["1234567+probe", "users.noreply.github.com"].join("@");
/** The older id-less no-reply form, still GitHub's and accepted by isGithubNoreply. */
const NOREPLY_OLD = ["probe", "users.noreply.github.com"].join("@");
/** A GitHub App's no-reply address — Dependabot's PR commits are authored by one. */
const BOT = ["1234567+example-app[bot]", "users.noreply.github.com"].join("@");
/** GitHub's own committer on a web merge and on Dependabot's signed commits. */
const WEB_FLOW = ["noreply", "github.com"].join("@");
/** What git invents from the machine's user and host names when user.email is unset. */
const MACHINE = ["dev", "build-host.lan"].join("@");
/** A reserved-domain placeholder: fine in a document, never a commit identity. */
const RESERVED = ["probe", "example.invalid"].join("@");
const LOOKALIKE = ["1234567+probe", "users.noreply.github.com.example.invalid"].join("@");

describe("ci.yml commit identity — authors and committers after the baseline, and taggers, are GitHub no-reply addresses", () => {
  const identity = rawStep("ci.yml", "Commit identity");
  const script = runBlock(identity);
  const baseline = stepEnv(identity, "IDENTITY_BASELINE") ?? "";

  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => {
    tmp?.cleanup();
    tmp = undefined;
  });

  /** git's environment: no inherited GIT_* state, no global/system config, no hooks. */
  const gitEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
    return {
      ...env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      ...extra,
    };
  };

  /** Run the step's script as the runner would: bash, cwd = the checkout, the step's env. */
  const runStep = (cwd: string, env: { IDENTITY_BASELINE: string; HEAD_SHA: string }) => {
    const r = spawnSync("bash", ["-c", script], {
      cwd,
      encoding: "utf8",
      env: gitEnv({ ...env, GITHUB_WORKSPACE: ROOT }),
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  /** A throwaway repository; every commit names its author and committer explicitly. */
  const makeRepo = () => {
    tmp = tempDir("eff-identity-");
    const repoDir = path.join(tmp.dir, "repo");
    mkdirSync(repoDir);
    const git = (args: string[], extra: Record<string, string> = {}): string => {
      const r = spawnSync("git", args, {
        cwd: repoDir,
        encoding: "utf8",
        env: gitEnv(extra),
        timeout: 30_000,
      });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git(["init", "-q", "-b", "main", "."]);
    const as = (author: string, committer: string) => ({
      GIT_AUTHOR_NAME: "probe",
      GIT_AUTHOR_EMAIL: author,
      GIT_COMMITTER_NAME: "probe",
      GIT_COMMITTER_EMAIL: committer,
    });
    const commit = (msg: string, author: string, committer = author): string => {
      git(["commit", "-q", "--allow-empty", "--no-verify", "-m", msg], as(author, committer));
      return git(["rev-parse", "HEAD"]);
    };
    // the history residual: commits before the baseline carry a machine-derived address
    commit("chore: before the rule", MACHINE);
    const base = commit("docs: the last commit before the rule", MACHINE);
    return { dir: repoDir, git, as, commit, base };
  };

  /** Every address the script was given, none of which it may print. */
  const leaks = (out: string) =>
    [NOREPLY, BOT, WEB_FLOW, MACHINE, RESERVED, LOOKALIKE].filter((a) => out.includes(a));

  it("is a lint step on the full history, before npm ci, from a fixed baseline on every event, reusing isGithubNoreply", () => {
    expect(identity.length, "ci.yml has no `Commit identity` step").toBeGreaterThan(0);
    const lint = load("ci.yml").split(/\n {2}typecheck:\n/)[0] ?? "";
    expect(lint).toContain("fetch-depth: 0");
    const at = lint.indexOf("- name: Commit identity");
    expect(at).toBeGreaterThan(lint.indexOf("fetch-depth: 0"));
    expect(at).toBeLessThan(lint.indexOf("run: npm ci"));
    expect(baseline).toMatch(/^[0-9a-f]{40}$/);
    expect(stepEnv(identity, "HEAD_SHA")).toBe(
      "${{ github.event.pull_request.head.sha || github.sha }}",
    );
    const text = identity.join("\n");
    // no pushed-range shortcut: a new branch, a force-push or a manual run has no usable range
    expect(text).not.toContain("github.event.before");
    expect(script).toContain('"scripts/dev/scan-secrets.mjs"');
    expect(script).toContain("isGithubNoreply");
    // the raw addresses as published, NUL-separated, never rewritten through a .mailmap
    expect(script).toContain('"--format=%H%x00%ae%x00%ce"');
    expect(script).toContain('"--no-use-mailmap"');
    expect(script).not.toMatch(/%[ac]E/);
    // a refusal fails the job: nothing swallows it
    expect(text).not.toMatch(/continue-on-error|\|\| true|set \+e/);
  });

  it("passes no-reply authors and committers (both forms), a GitHub App bot author and GitHub's web-flow committer, and ignores the residual before the baseline", () => {
    const r = makeRepo();
    r.commit("feat: a", NOREPLY);
    r.commit("fix: b", NOREPLY_OLD, NOREPLY);
    r.commit("build(deps): c", BOT, WEB_FLOW);
    r.commit("feat: a web merge", NOREPLY, WEB_FLOW);
    // an annotated tag by a no-reply tagger; a lightweight tag names no one
    r.git(["tag", "-a", "v0.0.1", "-m", "release"], r.as(NOREPLY, NOREPLY));
    r.git(["tag", "light"]);
    const res = runStep(r.dir, {
      IDENTITY_BASELINE: r.base,
      HEAD_SHA: r.git(["rev-parse", "HEAD"]),
    });
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("checked the author and committer of 4 commit(s)");
    expect(res.out).toContain("and the tagger of 1 annotated tag(s)");
    expect(leaks(res.out)).toEqual([]);
  });

  it("refuses an annotated tag whose tagger is not a GitHub no-reply address (a release tag publishes it)", () => {
    const r = makeRepo();
    r.commit("feat: a", NOREPLY);
    r.git(["tag", "-a", "v0.0.2", "-m", "release"], r.as(NOREPLY, MACHINE));
    const res = runStep(r.dir, {
      IDENTITY_BASELINE: r.base,
      HEAD_SHA: r.git(["rev-parse", "HEAD"]),
    });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(
      "::error::tag refs/tags/v0.0.2: the tagger address is not a GitHub no-reply address",
    );
    expect(res.out.match(/::error::/g)).toHaveLength(1);
    expect(res.out).not.toContain("@");
  });

  it.each<[string, string, string, string[]]>([
    ["a machine-derived author (a clone without core.hooksPath)", MACHINE, NOREPLY, ["author"]],
    [
      "a machine-derived committer (a cherry-pick or rebase by another identity)",
      NOREPLY,
      MACHINE,
      ["committer"],
    ],
    ["both, as git invents them", MACHINE, MACHINE, ["author", "committer"]],
    ["a reserved-domain placeholder", RESERVED, NOREPLY, ["author"]],
    ["a look-alike no-reply domain", LOOKALIKE, LOOKALIKE, ["author", "committer"]],
    [
      "GitHub's web-flow address as the AUTHOR (it is accepted as a committer only)",
      WEB_FLOW,
      WEB_FLOW,
      ["author"],
    ],
  ])(
    "refuses %s — naming the commit and the role, never the address",
    (_label, author, committer, roles) => {
      const r = makeRepo();
      r.commit("feat: fine", NOREPLY);
      const bad = r.commit("feat: published identity", author, committer);
      r.commit("fix: fine again", NOREPLY);
      const res = runStep(r.dir, {
        IDENTITY_BASELINE: r.base,
        HEAD_SHA: r.git(["rev-parse", "HEAD"]),
      });
      expect(res.status, res.out).toBe(1);
      for (const role of ["author", "committer"]) {
        const line = `::error::commit ${bad}: the ${role} address is not a GitHub no-reply address`;
        if (roles.includes(role)) expect(res.out).toContain(line);
        else expect(res.out).not.toContain(line);
      }
      expect(res.out.match(/::error::commit /g)).toHaveLength(roles.length);
      expect(leaks(res.out)).toEqual([]);
      expect(res.out).not.toContain("@");
    },
  );

  it("a committed .mailmap cannot launder an address: the raw author and committer are what is checked", () => {
    const r = makeRepo();
    r.git(["config", "log.mailmap", "true"]);
    writeFileSync(path.join(r.dir, ".mailmap"), `Probe <${NOREPLY}> <${MACHINE}>\n`);
    r.git(["add", ".mailmap"]);
    const bad = r.commit("chore: map the machine address to a no-reply one", MACHINE);
    const res = runStep(r.dir, {
      IDENTITY_BASELINE: r.base,
      HEAD_SHA: r.git(["rev-parse", "HEAD"]),
    });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(`::error::commit ${bad}: the author address`);
    expect(res.out).toContain(`::error::commit ${bad}: the committer address`);
    expect(res.out).not.toContain("@");
  });

  it("refuses a merge commit made with a machine-derived identity (`git merge` runs no pre-commit hook)", () => {
    const r = makeRepo();
    r.git(["checkout", "-q", "-b", "side"]);
    r.commit("feat: on the side", NOREPLY);
    r.git(["checkout", "-q", "main"]);
    r.commit("feat: on main", NOREPLY);
    r.git(
      ["merge", "-q", "--no-ff", "--no-verify", "-m", "Merge branch side", "side"],
      r.as(MACHINE, MACHINE),
    );
    const merge = r.git(["rev-parse", "HEAD"]);
    const res = runStep(r.dir, { IDENTITY_BASELINE: r.base, HEAD_SHA: merge });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(`::error::commit ${merge}: the author address`);
    expect(res.out).toContain("checked the author and committer of 3 commit(s)");
  });

  it("checks the whole history after the baseline, not the pushed range: a bad commit deep in a new branch is refused", () => {
    const r = makeRepo();
    const deep = r.commit("feat: deep", MACHINE);
    for (let i = 0; i < 5; i++) r.commit(`feat: later ${String(i)}`, NOREPLY);
    const res = runStep(r.dir, {
      IDENTITY_BASELINE: r.base,
      HEAD_SHA: r.git(["rev-parse", "HEAD"]),
    });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(`::error::commit ${deep}: the author address`);
  });

  it("fails closed when the baseline commit is not in the checkout", () => {
    const r = makeRepo();
    r.commit("feat: a", NOREPLY);
    const res = runStep(r.dir, {
      IDENTITY_BASELINE: "f".repeat(40),
      HEAD_SHA: r.git(["rev-parse", "HEAD"]),
    });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain("::error::");
    expect(res.out).not.toContain("checked the author and committer");
  });

  // This clone's own history (a full clone — CI's unit job checks out one commit, so it skips here;
  // the lint job runs the step itself on every push with the full history).
  const full =
    /^[0-9a-f]{40}$/.test(baseline) &&
    spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout.trim() === "false" &&
    spawnSync("git", ["cat-file", "-e", `${baseline}^{commit}`], { cwd: ROOT }).status === 0;

  it.skipIf(!full)(
    "this clone's history passes from the baseline, and the baseline is the newest commit that would not",
    () => {
      const ok = runStep(ROOT, { IDENTITY_BASELINE: baseline, HEAD_SHA: "HEAD" });
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).not.toContain("@");
      // moved one commit back, the baseline itself is refused (its author and committer): it is tight
      const back = runStep(ROOT, { IDENTITY_BASELINE: `${baseline}^`, HEAD_SHA: "HEAD" });
      expect(back.status, back.out).toBe(1);
      expect([...new Set(back.out.match(/(?<=::error::commit )[0-9a-f]{40}/g))]).toEqual([
        baseline,
      ]);
      expect(back.out).not.toContain("@");
    },
  );
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
