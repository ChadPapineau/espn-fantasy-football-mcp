// workflows.test.ts — CI hygiene that must hold for every workflow (plan 04 §4: actions pinned by
// commit SHA, contents: read, no pull_request_target, persist-credentials: false, no secrets) and the
// job sets of plan 04 §4.1–§4.3 as built in this stage. Ported from sibling @d72e03b, adapted: no
// YAML parser is a dependency of this repo (plan 04 §2), so the workflows are read structurally —
// a job is a two-space-indented key under `jobs:`. The commit-identity step (CLAUDE.md "Security";
// Stage C finding ci-commit-identity-unchecked) and the commit-message step (plan 04 §3 R4; Stage C
// findings ci-commit-message-not-scanned, ci-message-check-skips-merges-first-push) are also RUN:
// each `run:` block, cut out of ci.yml exactly as YAML reads it, is executed against throwaway
// repositories and this clone's history. release.yml is held to wait for every workflow a push
// runs (Stage C finding ci-release-skips-gitleaks-gate).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** The events a workflow runs on: the two-space keys of its `on:` block. */
function onKeys(text: string): string[] {
  const block = /^on:\n((?: {2,}.*\n|\n)*)/m.exec(text)?.[1] ?? "";
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1] ?? "");
}

/** A job's `needs:` — one job name or a flow sequence of them. */
function needsOf(job: string): string[] {
  const m = /^ {4}needs: (?:\[([^\]\n]*)\]|(\S+))$/m.exec(job);
  return (m?.[1] ?? m?.[2] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const CANCEL_EXPR = "${{ github.event_name == 'pull_request' || github.ref != 'refs/heads/main' }}";

/**
 * release.yml's tarball steps, which ci.yml's pack job rehearses on every push (plan 04 §4.4; Stage C
 * finding ci-release-workflow-missing): the committed lockfile as the tarball's npm-shrinkwrap.json,
 * the --release scan, npm pack, and the README's locked install run on the packed tarball.
 */
const REHEARSED = [
  "cp package-lock.json npm-shrinkwrap.json",
  "npm run pack:scan -- --release",
  'npm pack --ignore-scripts --pack-destination "$RUNNER_TEMP"',
  "node scripts/ci/check-release-install.mjs --tarball",
];

describe.each(files)("%s", (file) => {
  const text = load(file);
  const jobs = jobsOf(text);

  it("has read-only default permissions and nothing wider anywhere (the release job's contents: write alone)", () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(text).not.toMatch(/permissions:\s*write-all/);
    // plan 04 §4.4: the one write anywhere is release.yml's `release` job creating the GitHub
    // Release with its own token — contents: write and nothing else
    for (const [name, block] of jobs) {
      const writes = [...block.matchAll(/^\s*([a-z-]+):\s*write\b/gm)].map((m) => m[1]);
      if (file === "release.yml" && name === "release") expect(writes, name).toEqual(["contents"]);
      else expect(writes, `${file} ${name}`).toEqual([]);
    }
    const outside = text.split(/^jobs:$/m)[0] ?? "";
    expect(outside).not.toMatch(/:\s*write\b/);
  });

  it("never uses pull_request_target, and never reads a repository secret", () => {
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("pins every action to a full commit SHA with its version comment (a called workflow of this repo is the same commit)", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      const local = /^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/.exec(u[1] ?? "");
      if (local !== null) {
        expect(files, u[0]).toContain(local[1]);
        continue;
      }
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
      // a job that calls a workflow of this repo runs that workflow's jobs, bounded there
      if (/^ {4}uses: \.\/\.github\/workflows\/[\w.-]+\.ya?ml$/m.test(block)) continue;
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

  it("can be called by release.yml, in a concurrency group of its own (a tag's direct run never cancels the called one)", () => {
    expect(text).toMatch(/^on:\n {2}push:\n {2}pull_request:\n(?: {4}.*\n)* {2}workflow_call:\n/m);
    expect(text).toContain(
      "group: ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}",
    );
  });

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

  // the commit-message step needs no npm ci and runs whatever an earlier step decided (its own
  // describe below holds that): a lint or format failure never skips it
  it.each([
    ["lint", ["npm run lint", "npm run format:check"]],
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

  it("pack rehearses release.yml's tarball on every push: the plain scan first, then the lock, the --release scan, npm pack and the README's install", () => {
    const p = job("pack");
    const rehearsal = step(p, "Rehearse release.yml's tarball");
    expect(rehearsal).not.toBe("");
    // every push still packs without the lock first (the default scan)
    const plain = p.indexOf("run: npm run pack:scan\n");
    expect(plain).toBeGreaterThan(p.indexOf("npm run build"));
    expect(plain).toBeLessThan(p.indexOf(rehearsal));
    let at = -1;
    for (const needle of REHEARSED) {
      const i = rehearsal.indexOf(needle);
      expect(i, needle).toBeGreaterThan(at);
      at = i;
    }
    expect(rehearsal).toContain("set -euo pipefail");
    expect(rehearsal).toContain('--tarball "$RUNNER_TEMP/espn-fantasy-football-mcp-$version.tgz"');
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

/** True when this clone holds the whole history back to `baseline` (CI's unit job checks out one commit). */
const fullHistoryFrom = (baseline: string): boolean =>
  /^[0-9a-f]{40}$/.test(baseline) &&
  spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim() === "false" &&
  spawnSync("git", ["cat-file", "-e", `${baseline}^{commit}`], { cwd: ROOT }).status === 0;

describe("ci.yml commit identity — authors and committers after the baseline, and taggers, are GitHub no-reply addresses", () => {
  const identity = rawStep("ci.yml", "Commit identity");
  const script = runBlock(identity);
  const baseline = stepEnv(identity, "IDENTITY_BASELINE") ?? "";

  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => {
    tmp?.cleanup();
    tmp = undefined;
  });

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
  const full = fullHistoryFrom(baseline);

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

// --- every published message, checked and scanned in CI (the local hooks are bypassable) ---------

// Values are assembled at run time so no literal identifier sits in this file (the identifiers scan).
/** A league id as ESPN's URLs carry it. */
const LEAGUE_ID = String(2 ** 22 + 1_618_033);
const LEAGUE_ID_TEXT = ["leagueId", LEAGUE_ID].join("=");
/** An espn_s2 cookie with its name: "AE", then base64 — digits, both cases, high entropy. */
const COOKIE_VALUE = `AE${createHash("sha512").update("eff-probe-cookie").digest("base64")}`;
const COOKIE_TEXT = [["espn", "s2"].join("_"), COOKIE_VALUE].join("=");
/** The attribution trailer an assistant appends (CLAUDE.md: never in a commit message). */
const AI_TRAILER = `Co-Authored-By: Claude <${["noreply", "anthropic.com"].join("@")}>`;
/** GitHub's support mailbox, which Dependabot signs off every commit with. */
const SUPPORT = ["support", "github.com"].join("@");
const DEPENDABOT_SIGNOFF = `Signed-off-by: dependabot[bot] <${SUPPORT}>`;
/** Dependabot's author address: its GitHub App's no-reply form. */
const DEPENDABOT = ["49699333+dependabot[bot]", "users.noreply.github.com"].join("@");
const AS_DEPENDABOT = {
  GIT_AUTHOR_NAME: "dependabot[bot]",
  GIT_AUTHOR_EMAIL: DEPENDABOT,
  GIT_COMMITTER_NAME: "GitHub",
  GIT_COMMITTER_EMAIL: WEB_FLOW,
};

describe("ci.yml commit messages — every published message (merges, the root and tags included) is scanned for secrets and identifiers; after the baseline it is Conventional with no AI attribution trailer; a pull request's title too", () => {
  const messages = rawStep("ci.yml", "Commit messages");
  const script = runBlock(messages);
  const baseline = stepEnv(messages, "MESSAGE_BASELINE") ?? "";

  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => {
    tmp?.cleanup();
    tmp = undefined;
  });

  interface StepEnv {
    MESSAGE_BASELINE: string;
    HEAD_SHA: string;
    EVENT?: string;
    PR_TITLE?: string;
    PR_NUMBER?: string;
  }

  /** Run the step's script as the runner would: bash, cwd = the checkout, the step's env. */
  const runStep = (cwd: string, env: StepEnv) => {
    const r = spawnSync("bash", ["-c", script], {
      cwd,
      encoding: "utf8",
      env: gitEnv({ EVENT: "push", PR_TITLE: "", PR_NUMBER: "", ...env, GITHUB_WORKSPACE: ROOT }),
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  /**
   * A throwaway repository: two commits before the baseline whose messages carry an AI attribution
   * trailer (the residual every pre-rule commit of this repository carries), `residual` added to
   * the first one's body. Every message is committed byte for byte (`--cleanup=verbatim`).
   */
  const makeRepo = (residual = "") => {
    const t = tempDir("eff-messages-");
    tmp = t;
    const repoDir = path.join(t.dir, "repo");
    mkdirSync(repoDir);
    const git = (args: string[], extra: Record<string, string> = {}): string => {
      const r = spawnSync("git", args, {
        cwd: repoDir,
        encoding: "utf8",
        env: gitEnv({
          GIT_AUTHOR_NAME: "probe",
          GIT_AUTHOR_EMAIL: NOREPLY,
          GIT_COMMITTER_NAME: "probe",
          GIT_COMMITTER_EMAIL: NOREPLY,
          ...extra,
        }),
        timeout: 30_000,
      });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git(["init", "-q", "-b", "main", "."]);
    const msgFile = path.join(t.dir, "message.txt");
    const commit = (msg: string, extra: Record<string, string> = {}): string => {
      writeFileSync(msgFile, msg);
      git(
        ["commit", "-q", "--allow-empty", "--no-verify", "--cleanup=verbatim", "-F", msgFile],
        extra,
      );
      return git(["rev-parse", "HEAD"]);
    };
    const merge = (branch: string, msg: string): string => {
      writeFileSync(msgFile, msg);
      git(["merge", "-q", "--no-ff", "--no-verify", "--cleanup=verbatim", "-F", msgFile, branch]);
      return git(["rev-parse", "HEAD"]);
    };
    const first = commit(`chore: before the rules\n\n${residual}${AI_TRAILER}\n`);
    const base = commit(`docs: the last commit before the rules\n\n${AI_TRAILER}\n`);
    const head = () => git(["rev-parse", "HEAD"]);
    return { dir: repoDir, git, commit, merge, first, base, head };
  };

  /** Every value a test puts in a message — none of which the step may print. */
  const leaks = (out: string) =>
    [LEAGUE_ID, COOKIE_VALUE, MACHINE, SUPPORT, "a body that names no one"].filter((v) =>
      out.includes(v),
    );
  /** The commits (or objects) the step refused, once each. */
  const refused = (out: string) => [
    ...new Set(
      [...out.matchAll(/^::error::(commit [0-9a-f]{40}|tag \S+|the pull request title):/gm)].map(
        (m) => m[1],
      ),
    ),
  ];

  it("is lint's last step on the full history, run whatever an earlier step decided (no identity, lint or format failure skips it; its refusal skips no other check), on every event from a fixed baseline, the local rules imported, no context value spliced into the script", () => {
    expect(messages.length, "ci.yml has no `Commit messages` step").toBeGreaterThan(0);
    const lint = load("ci.yml").split(/\n {2}typecheck:\n/)[0] ?? "";
    const at = lint.indexOf("- name: Commit messages");
    expect(lint).toContain("fetch-depth: 0");
    // the last of lint's steps, after the identity check, ESLint and Prettier
    for (const earlier of [
      "- name: Commit identity",
      "run: npm run lint",
      "run: npm run format:check",
    ])
      expect(at, earlier).toBeGreaterThan(lint.indexOf(earlier));
    expect(lint.slice(at + 1)).not.toMatch(/^ {6}- /m);
    // a failed step before it never skips it (only a cancelled run does), and it needs no npm ci
    expect(messages[1]).toBe("        if: ${{ !cancelled() }}");
    expect(script).not.toMatch(/\bnpm\b|node_modules/);
    expect(baseline).toMatch(/^[0-9a-f]{40}$/);
    expect(stepEnv(messages, "EVENT")).toBe("${{ github.event_name }}");
    expect(stepEnv(messages, "HEAD_SHA")).toBe(
      "${{ github.event.pull_request.head.sha || github.sha }}",
    );
    expect(stepEnv(messages, "PR_TITLE")).toBe("${{ github.event.pull_request.title }}");
    expect(stepEnv(messages, "PR_NUMBER")).toBe("${{ github.event.pull_request.number }}");
    const text = messages.join("\n");
    // no pushed-range shortcut (a first push, a tag or a manual run has no usable `before`) and no
    // merge skipped
    expect(text).not.toContain("github.event.before");
    expect(text).not.toContain("--no-merges");
    // a title reaches the script through the environment only, never as script text
    expect(script).not.toContain("${{");
    expect(script).toContain('"scripts/dev/check-commit-msg.mjs"');
    expect(script).toContain('"scripts/dev/scan-secrets.mjs"');
    expect(script).toContain("checkMessage(");
    expect(script).toContain("scanBlob(");
    // the raw messages as published: no .mailmap rewrite of the author the allowance reads, no
    // signature output mixed into the records
    expect(script).toContain('"--no-use-mailmap"');
    expect(script).toContain('"--no-show-signature"');
    expect(text).not.toMatch(/continue-on-error|\|\| true|set \+e/);
  });

  it("re-runs on a pull request's title edit (the subject a squash merge publishes) as well as on GitHub's default activity types", () => {
    expect(load("ci.yml")).toMatch(
      /^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened, edited\]\n/m,
    );
  });

  it("passes a clean history — Conventional commits, a merge, a revert, Dependabot's signed-off commit, annotated and lightweight tags — and leaves the residual before the baseline to the scan alone", () => {
    const r = makeRepo();
    r.commit("feat: a\n\nA body that names no one.\n");
    r.git(["checkout", "-q", "-b", "side"]);
    r.commit("fix: on the side\n");
    r.git(["checkout", "-q", "main"]);
    r.commit("docs: on main\n");
    r.merge("side", "Merge branch 'side'\n");
    const reverted = r.commit("feat: to be reverted\n");
    r.commit(`Revert "feat: to be reverted"\n\nThis reverts commit ${reverted}.\n`);
    r.commit(
      `build(deps): bump the npm-minor-and-patch group with 2 updates\n\nBumps the group with 2 updates.\n\n---\nupdated-dependencies:\n- dependency-name: vitest\n  dependency-version: 4.1.2\n  dependency-type: direct:development\n...\n\n${DEPENDABOT_SIGNOFF}\n`,
      AS_DEPENDABOT,
    );
    r.git(["tag", "-a", "v0.0.1", "-m", "v0.0.1\n\nThe first release."]);
    r.git(["tag", "light"]);
    const res = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: r.head() });
    expect(res.status, res.out).toBe(0);
    // the 2 residual commits + feat, fix, docs, the merge, feat, the revert, Dependabot's
    expect(res.out).toContain("checked the message of 9 commit(s)");
    expect(res.out).toContain("the format of the 7 after the baseline");
    expect(res.out).toContain("1 annotated tag(s)");
    expect(res.out).not.toContain("::error::");
    expect(leaks(res.out)).toEqual([]);
  });

  it.each<[string, string, string]>([
    [
      "a league id",
      `see https://fantasy.espn.com/football/league?${LEAGUE_ID_TEXT}`,
      "espn-league-id",
    ],
    ["a mailbox", `reported by ${MACHINE}`, "email-address"],
    ["an espn_s2 cookie", COOKIE_TEXT, "espn-s2-cookie"],
  ])(
    "refuses %s in a commit message — naming the commit, the line and the rule, never the value",
    (_label, line, rule) => {
      const r = makeRepo();
      r.commit("feat: fine\n");
      const bad = r.commit(`fix: read the league\n\nThe probe failed:\n${line}\n`);
      r.commit("fix: fine again\n");
      const res = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: r.head() });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`::error::commit ${bad}: COMMIT_MESSAGE:4  [${rule}]`);
      expect(refused(res.out)).toEqual([`commit ${bad}`]);
      expect(leaks(res.out)).toEqual([]);
    },
  );

  it("refuses a message whose bytes are not UTF-8: what the scanner cannot read is never passed", () => {
    const r = makeRepo();
    // `git commit` re-encodes such a message (it reads the bytes as latin1), but a commit object
    // written directly — any client can push one — keeps them: "café" in latin1, a lone 0xE9
    const ident = `probe <${NOREPLY}> 1700000000 +0000`;
    const object = Buffer.concat([
      Buffer.from(
        `tree ${r.git(["rev-parse", "HEAD^{tree}"])}\nparent ${r.head()}\nauthor ${ident}\ncommitter ${ident}\n\nfix: a latin-1 body\n\ncaf`,
      ),
      Buffer.from([0xe9]),
      Buffer.from("\n"),
    ]);
    const written = spawnSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: r.dir,
      input: object,
      env: gitEnv(),
      timeout: 30_000,
    });
    const bad = written.stdout.toString("utf8").trim();
    expect(bad, written.stderr.toString("utf8")).toMatch(/^[0-9a-f]{40}$/);
    r.git(["update-ref", "refs/heads/main", bad]);
    const shown = spawnSync("git", ["log", "-1", "--format=%B", bad], {
      cwd: r.dir,
      env: gitEnv(),
    });
    expect(shown.stdout.includes(0xe9), "git log no longer shows the raw byte").toBe(true);
    const res = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: r.head() });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(
      `::error::commit ${bad}: COMMIT_MESSAGE  [unscannable-archive-or-database]`,
    );
    expect(refused(res.out)).toEqual([`commit ${bad}`]);
  });

  it("scans a merge commit's message (a merge is published like any other commit)", () => {
    const r = makeRepo();
    r.git(["checkout", "-q", "-b", "side"]);
    r.commit("feat: on the side\n");
    r.git(["checkout", "-q", "main"]);
    r.commit("feat: on main\n");
    const merge = r.merge("side", `Merge branch 'side'\n\nTried on ${LEAGUE_ID_TEXT}\n`);
    const res = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: merge });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(`::error::commit ${merge}: COMMIT_MESSAGE:3  [espn-league-id]`);
    expect(refused(res.out)).toEqual([`commit ${merge}`]);
    expect(leaks(res.out)).toEqual([]);
  });

  it("scans the whole history, the root included: the baseline exempts the residual from the format check only", () => {
    const r = makeRepo(`${LEAGUE_ID_TEXT}\n\n`);
    r.commit("feat: fine\n");
    const res = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: r.head() });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(`::error::commit ${r.first}: COMMIT_MESSAGE:3  [espn-league-id]`);
    // the residual's AI attribution trailers are not refused: only the identifier is
    expect(refused(res.out)).toEqual([`commit ${r.first}`]);
    expect(res.out).not.toContain("message refused");
    expect(leaks(res.out)).toEqual([]);
  });

  it("scans every annotated tag's message (a release tag publishes it); a lightweight tag has none", () => {
    const r = makeRepo();
    r.commit("feat: a\n");
    r.git(["tag", "-a", "v0.0.2", "-m", `v0.0.2\n\nTried on ${LEAGUE_ID_TEXT}`]);
    r.git(["tag", "light"]);
    const res = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: r.head() });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain("::error::tag refs/tags/v0.0.2: TAG_MESSAGE:3  [espn-league-id]");
    expect(refused(res.out)).toEqual(["tag refs/tags/v0.0.2"]);
    expect(leaks(res.out)).toEqual([]);
  });

  it("allows Dependabot's own sign-off trailer and nothing more: the mailbox anywhere else, the trailer changed or in another author's commit is refused", () => {
    const r = makeRepo();
    r.commit(`build(deps): bump a\n\n${DEPENDABOT_SIGNOFF}\n`, AS_DEPENDABOT);
    r.commit(`build(deps): bump b\n\n${DEPENDABOT_SIGNOFF}\r\n`, AS_DEPENDABOT);
    const elsewhere = r.commit(`build(deps): bump c\n\nAsk ${SUPPORT} for help.\n`, AS_DEPENDABOT);
    const changed = r.commit(
      `build(deps): bump d\n\n${DEPENDABOT_SIGNOFF.replace("dependabot[bot]", "someone")}\n`,
      AS_DEPENDABOT,
    );
    const longer = r.commit(
      `build(deps): bump e\n\n${DEPENDABOT_SIGNOFF} ${MACHINE}\n`,
      AS_DEPENDABOT,
    );
    const human = r.commit(`build(deps): bump f\n\n${DEPENDABOT_SIGNOFF}\n`);
    const res = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: r.head() });
    expect(res.status, res.out).toBe(1);
    expect(refused(res.out).sort()).toEqual(
      [elsewhere, changed, longer, human].map((c) => `commit ${c}`).sort(),
    );
    for (const c of [elsewhere, changed, human])
      expect(res.out).toContain(`::error::commit ${c}: COMMIT_MESSAGE:3  [email-address]`);
    expect(leaks(res.out)).toEqual([]);
  });

  it("refuses a merge commit that carries an AI attribution trailer (merges are no longer skipped)", () => {
    const r = makeRepo();
    r.git(["checkout", "-q", "-b", "side"]);
    r.commit("feat: on the side\n");
    r.git(["checkout", "-q", "main"]);
    const merge = r.merge("side", `Merge branch 'side'\n\n${AI_TRAILER}\n`);
    const res = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: merge });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain(
      `::error::commit ${merge}: message refused — the message carries an AI attribution trailer`,
    );
    expect(refused(res.out)).toEqual([`commit ${merge}`]);
  });

  it.each(["push", "workflow_dispatch", "schedule", "pull_request"])(
    "checks the whole history after the baseline on a %s run, not a pushed range: a bad commit deep in a new branch is refused",
    (event) => {
      const r = makeRepo();
      const deep = r.commit("not a conventional subject\n");
      for (let i = 0; i < 3; i++) r.commit(`feat: later ${String(i)}\n`);
      const res = runStep(r.dir, {
        MESSAGE_BASELINE: r.base,
        HEAD_SHA: r.head(),
        EVENT: event,
        ...(event === "pull_request" ? { PR_TITLE: "feat: a title", PR_NUMBER: "7" } : {}),
      });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(
        `::error::commit ${deep}: message refused — the subject is not a Conventional Commit`,
      );
      expect(refused(res.out)).toEqual([`commit ${deep}`]);
      expect(res.out).not.toContain("not checked");
    },
  );

  it.each<[string, string, string]>([
    ["not a Conventional Commit", "Update the README", "the subject is not a Conventional Commit"],
    [
      "a skip-CI instruction",
      "fix: a typo [skip ci]",
      "the message carries a GitHub skip-CI instruction",
    ],
    [
      "over the subject limit once a squash merge appends its number",
      `feat: ${"x".repeat(114)}`,
      "the subject is longer than 120 characters",
    ],
  ])(
    "on a pull request, refuses a title that is %s (a squash merge publishes it as the subject on main)",
    (_label, title, why) => {
      const r = makeRepo();
      r.commit("feat: fine\n");
      const res = runStep(r.dir, {
        MESSAGE_BASELINE: r.base,
        HEAD_SHA: r.head(),
        EVENT: "pull_request",
        PR_TITLE: title,
        PR_NUMBER: "12",
      });
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain(`::error::the pull request title: refused — ${why}`);
      expect(refused(res.out)).toEqual(["the pull request title"]);
      expect(res.out).not.toContain(title);
    },
  );

  it("on a pull request, scans the title for secrets and identifiers, never printing it", () => {
    const r = makeRepo();
    r.commit("feat: fine\n");
    const res = runStep(r.dir, {
      MESSAGE_BASELINE: r.base,
      HEAD_SHA: r.head(),
      EVENT: "pull_request",
      PR_TITLE: `fix: read ${LEAGUE_ID_TEXT}`,
      PR_NUMBER: "12",
    });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain("::error::the pull request title: PR_TITLE:1  [espn-league-id]");
    expect(refused(res.out)).toEqual(["the pull request title"]);
    expect(leaks(res.out)).toEqual([]);
  });

  it("on a pull request, passes a Conventional title and says it checked it; fails closed when the title or the number cannot be read", () => {
    const r = makeRepo();
    r.commit("feat: fine\n");
    const pr = (PR_TITLE: string, PR_NUMBER: string) =>
      runStep(r.dir, {
        MESSAGE_BASELINE: r.base,
        HEAD_SHA: r.head(),
        EVENT: "pull_request",
        PR_TITLE,
        PR_NUMBER,
      });
    const ok = pr("feat(ci): scan every published message", "12");
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain("and the pull request title");
    for (const [title, n] of [
      ["", "12"],
      ["  ", "12"],
      ["feat: a title", ""],
    ] as const) {
      const res = pr(title, n);
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain("::error::the pull request title: it could not be read");
    }
    // outside a pull request no title exists, and none is required
    const push = runStep(r.dir, { MESSAGE_BASELINE: r.base, HEAD_SHA: r.head() });
    expect(push.status, push.out).toBe(0);
    expect(push.out).not.toContain("the pull request title");
  });

  it("fails closed when the baseline commit is not in the checkout", () => {
    const r = makeRepo();
    r.commit("feat: a\n");
    const res = runStep(r.dir, { MESSAGE_BASELINE: "f".repeat(40), HEAD_SHA: r.head() });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toContain("::error::");
    expect(res.out).not.toContain("checked the message");
  });

  // This clone's own history (a full clone — CI's unit job checks out one commit, so it skips here;
  // the lint job runs the step itself on every push with the full history).
  it.skipIf(!fullHistoryFrom(baseline))(
    "this clone's history passes, and the baseline is the newest commit whose message the format check would refuse",
    () => {
      const ok = runStep(ROOT, { MESSAGE_BASELINE: baseline, HEAD_SHA: "HEAD" });
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).not.toContain("::error::");
      // moved one commit back, the baseline itself is refused (its AI attribution trailer): it is tight
      const back = runStep(ROOT, { MESSAGE_BASELINE: `${baseline}^`, HEAD_SHA: "HEAD" });
      expect(back.status, back.out).toBe(1);
      expect(refused(back.out)).toEqual([`commit ${baseline}`]);
      expect(back.out).toContain(`::error::commit ${baseline}: message refused — `);
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

  it("has the mermaid, links, identifiers, skills and docs-current jobs", () => {
    expect([...jobs.keys()]).toEqual(
      expect.arrayContaining(["mermaid", "links", "identifiers", "skills", "docs-current"]),
    );
  });

  it("docs-current: the locked tree, a self-test on a doctored copy, then npm run check:docs (Stage C docs-current-check-missing)", () => {
    const d = job("docs-current");
    const ci = d.indexOf("run: npm ci");
    const self = d.indexOf("Self-test");
    const check = d.indexOf("run: npm run check:docs");
    expect(ci).toBeGreaterThan(0);
    expect(self).toBeGreaterThan(ci);
    expect(check).toBeGreaterThan(self);
    const st = step(d, "Self-test");
    // both generators run against the doctored copy, and both must exit 1 with their message
    expect(st).toContain('scripts/gen-config-docs.ts --check --root "$tmp"');
    expect(st).toContain('scripts/gen-tool-docs.ts --check --root "$tmp"');
    expect(st).toContain('[ "$rc_config" -ne 1 ]');
    expect(st).toContain('[ "$rc_tools" -ne 1 ]');
    expect(st).toContain("README.md: not current");
    expect(st).toContain("registered, but the cheat-sheet has no row for it");
    expect(st).toMatch(/exit 1\n/);
    expect(d).not.toContain("--ignore-scripts=false");
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

describe("release.yml (plan 04 §4.4, R8; Stage C finding ci-release-workflow-missing)", () => {
  const text = load("release.yml");
  const jobs = jobsOf(text);
  const release = jobs.get("release") ?? "";

  it("runs on a v* tag only", () => {
    expect(text).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- "v\*"\n\n/m);
  });

  it("releases only after the full ci.yml gate, called on the same commit", () => {
    expect(jobs.get("ci")).toMatch(/^ {4}uses: \.\/\.github\/workflows\/ci\.yml$/m);
    expect(needsOf(release)).toContain("ci");
  });

  it("waits for every gate a push runs — ci, secrets (gitleaks over the history and the tree) and docs (plugin validation): each push-triggered workflow is called on the same commit and needed by the release job (plan 04 §4.1, §4.4)", () => {
    const gates = files.filter((f) => f !== "release.yml" && onKeys(load(f)).includes("push"));
    expect(gates.sort()).toEqual(["ci.yml", "docs.yml", "secret-scan.yml"]);
    const needs = needsOf(release);
    for (const gate of gates) {
      const caller = [...jobs].find(([, block]) =>
        new RegExp(`^ {4}uses: \\./\\.github/workflows/${gate.replace(".", "\\.")}$`, "m").test(
          block,
        ),
      );
      expect(caller, `release.yml does not call ${gate}`).toBeDefined();
      expect(needs, `the release job does not wait for ${gate}`).toContain(caller?.[0]);
    }
  });

  it("every workflow it calls is callable and runs in a concurrency group of its own: a tag's direct run and the called one never share — so never cancel — a group", () => {
    const called = [...jobs.values()]
      .map((block) => /^ {4}uses: \.\/\.github\/workflows\/([\w.-]+)$/m.exec(block)?.[1])
      .filter((f): f is string => f !== undefined);
    expect(called.sort()).toEqual(["ci.yml", "docs.yml", "secret-scan.yml"]);
    const groupOf = (f: string) => /^concurrency:\n {2}group: (.+)$/m.exec(load(f))?.[1] ?? "";
    /** A concurrency group with these context values; an unknown expression fails the test. */
    const evaluate = (group: string, ctx: Record<string, string>) =>
      group.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
        const v = ctx[key];
        if (v === undefined) throw new Error(`unknown context ${key} in ${group}`);
        return v;
      });
    const tag = { "github.event_name": "push", "github.ref": "refs/tags/v1.2.3" };
    const groups = new Map([
      ["release.yml", evaluate(groupOf("release.yml"), { ...tag, "github.workflow": "release" })],
    ]);
    for (const f of called) {
      expect(onKeys(load(f)), f).toContain("workflow_call");
      const name = /^name: (.+)$/m.exec(load(f))?.[1] ?? f;
      // github.workflow is the CALLER's name in a called run
      groups.set(`${f}, called`, evaluate(groupOf(f), { ...tag, "github.workflow": "release" }));
      groups.set(
        `${f}, its own run on the tag`,
        evaluate(groupOf(f), { ...tag, "github.workflow": name }),
      );
    }
    expect(new Set(groups.values()).size, JSON.stringify([...groups], null, 1)).toBe(groups.size);
  });

  it("checks the changelog, writes the lock, scans, packs, checksums, installs that tarball the README's way, then creates the GitHub Release — in that order", () => {
    const order = [
      "npm ci",
      "npm run build",
      'node scripts/ci/check-changelog.mjs --tag "$GITHUB_REF_NAME" --notes "$RUNNER_TEMP/notes.md"',
      ...REHEARSED.slice(0, 3),
      "sha256sum",
      // the README's locked install, run on the very tarball the release uploads
      `${REHEARSED[3] ?? ""} "$RUNNER_TEMP/espn-fantasy-football-mcp-\${GITHUB_REF_NAME#v}.tgz"`,
      'gh release create "$GITHUB_REF_NAME" "$tgz" "$tgz.sha256"',
    ];
    let at = -1;
    for (const needle of order) {
      const i = release.indexOf(needle);
      expect(i, needle).toBeGreaterThan(at);
      at = i;
    }
    expect(release).toContain('--notes-file "$RUNNER_TEMP/notes.md"');
    expect(release).toContain("--verify-tag");
    expect(release).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("the lock is the committed lockfile copied (npm shrinkwrap would delete it and leave nothing to compare)", () => {
    expect(step(release, "npm-shrinkwrap.json")).toMatch(
      /run: cp package-lock\.json npm-shrinkwrap\.json$/m,
    );
    expect(release).not.toContain("npm shrinkwrap");
  });

  it("never publishes to npm (R8: the owner publishes by hand, if ever)", () => {
    expect(text).not.toMatch(/npm publish/);
  });
});
