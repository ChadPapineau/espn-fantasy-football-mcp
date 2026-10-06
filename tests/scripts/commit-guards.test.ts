// commit-guards.test.ts — the two local commit paths (.githooks/pre-commit + commit-msg for a plain
// `git commit`, scripts/dev/commit-paths.sh for agents) must scan EVERY staged blob whatever its name
// or previous type, scan the message, refuse an author/committer that is not a GitHub no-reply
// address, refuse main, and refuse an AI attribution trailer (CLAUDE.md "Security", "Workflow").
// Each test builds a throwaway repository (and a bare `origin` for commit-paths.sh) in a temp dir,
// with git's global/system config isolated, so nothing here touches the real clone or its config.
// Ported from sibling @d72e03b, adapted.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT, tempDir } from "../lint/helpers.js";

/** A well-formed (fake) GitHub token, split so no literal in this file matches. */
const TOKEN = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
const NOREPLY = ["1234567+probe", "users.noreply.github.com"].join("@");
/** A reserved-domain placeholder: fine in a document, NOT a valid commit identity here. */
const RESERVED = ["probe", "example.invalid"].join("@");
/** A machine-derived style address: what git invents with no user.email. */
const MACHINE = ["dev", "build-host.lan"].join("@");
const DENY_TERM = ["Gridiron", "Gremlins"].join(" ");
const HAS_ZSH = existsSync("/bin/zsh") || spawnSync("zsh", ["-c", "true"]).status === 0;

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

/** The environment every git/hook call runs in: no inherited GIT_* state, no global/system config. */
function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    EFF_SCAN_DENYLIST: path.join(home, "deny.txt"),
    // the hooks run `scripts/dev/with-node.sh node …`; the stub below execs `node` from PATH
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extra,
  };
}

interface Repo {
  dir: string;
  home: string;
  git: (args: string[], extra?: Record<string, string>) => { status: number | null; out: string };
  write: (rel: string, body: string) => void;
}

function makeRepo(): Repo {
  tmp = tempDir("eff-guard-");
  const home = path.join(tmp.dir, "home");
  const dir = path.join(tmp.dir, "repo");
  mkdirSync(home);
  mkdirSync(dir);
  writeFileSync(path.join(home, "deny.txt"), `# local deny-list\n${DENY_TERM}\n`);
  const git: Repo["git"] = (args, extra = {}) => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: isolatedEnv(home, extra),
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const write: Repo["write"] = (rel, body) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  for (const rel of [
    ".githooks/pre-commit",
    ".githooks/commit-msg",
    "scripts/dev/scan-secrets.mjs",
    "scripts/dev/check-commit-msg.mjs",
    "scripts/dev/commit-paths.sh",
  ]) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  write("scripts/dev/with-node.sh", '#!/bin/sh\nexec "$@"\n');
  chmodSync(path.join(dir, "scripts/dev/with-node.sh"), 0o755);
  write(".nvmrc", "24.21.0\n");
  expect(git(["init", "-q", "-b", "build/probe"]).status).toBe(0);
  git(["config", "user.name", "probe"]);
  git(["config", "user.email", NOREPLY]);
  git(["config", "core.hooksPath", ".githooks"]);
  git(["add", "-A"]);
  const init = git(["commit", "-qm", "chore: init"]);
  expect(init.status, init.out).toBe(0);
  return { dir, home, git, write };
}

const head = (repo: Repo) => repo.git(["rev-parse", "HEAD"]).out.trim();

describe(".githooks/pre-commit scans every staged blob", () => {
  it("blocks a plain file holding a token (baseline)", () => {
    const repo = makeRepo();
    repo.write("plain.txt", `token = ${TOKEN}\n`);
    repo.git(["add", "plain.txt"]);
    const r = repo.git(["commit", "-qm", "feat: plain"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("plain.txt:1  [github-token]");
  });

  it("blocks an ESPN identifier (a league id in a URL)", () => {
    const repo = makeRepo();
    repo.write(
      "notes.md",
      `see https://fantasy.espn.com/football/league?${["leagueId", "4815162"].join("=")}\n`,
    );
    repo.git(["add", "notes.md"]);
    const r = repo.git(["commit", "-qm", "docs: notes"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("notes.md:1  [espn-league-id]");
  });

  it("blocks a deny-list term and never prints it", () => {
    const repo = makeRepo();
    repo.write("team.md", `our team: ${DENY_TERM}\n`);
    repo.git(["add", "team.md"]);
    const r = repo.git(["commit", "-qm", "docs: team"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("deny-list match in team.md:1");
    expect(r.out.toLowerCase()).not.toContain("gremlins");
  });

  it.each([
    ["notes-é.txt"],
    ["tab\there.txt"],
    ['quote"d.txt'],
    ["back\\slash.txt"],
    ["日本語/メモ.txt"],
  ])("blocks a token in a file git would C-quote: %j", (name) => {
    const repo = makeRepo();
    const before = head(repo);
    repo.write(name, `token = ${TOKEN}\n`);
    repo.git(["add", "--", name]);
    const r = repo.git(["commit", "-qm", "feat: quoted"]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("[github-token]");
    expect(head(repo)).toBe(before);
  });

  it("blocks a token in a tracked symlink replaced by a regular file (type change)", () => {
    const repo = makeRepo();
    symlinkSync(".nvmrc", path.join(repo.dir, "link.txt"));
    repo.git(["add", "link.txt"]);
    expect(repo.git(["commit", "-qm", "chore: link"]).status).toBe(0);
    const before = head(repo);
    unlinkSync(path.join(repo.dir, "link.txt"));
    repo.write("link.txt", `token = ${TOKEN}\n`);
    repo.git(["add", "link.txt"]);
    const r = repo.git(["commit", "-qm", "chore: typechange"]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("link.txt:1  [github-token]");
    expect(head(repo)).toBe(before);
  });

  it("still lets a clean non-ASCII-named file through (no blanket refusal)", () => {
    const repo = makeRepo();
    repo.write("notes-é.txt", "nothing secret here\n");
    repo.git(["add", "notes-é.txt"]);
    expect(repo.git(["commit", "-qm", "docs: clean"]).status).toBe(0);
  });
});

describe(".githooks/commit-msg checks and scans the message", () => {
  it.each([
    ["a non-conventional subject", "update stuff"],
    [
      "an AI attribution trailer",
      `fix: x\n\nCo-Authored-By: Claude <${["noreply", "anthropic.com"].join("@")}>`,
    ],
    ["a secret in the body", `fix: x\n\ntoken = ${TOKEN}`],
    ["a deny-list term", `fix: x\n\nfor ${DENY_TERM}`],
    ["an email address", `fix: x\n\nreport to ${["jane", "acme-corp.io"].join("@")}`],
  ])("refuses %s", (_why, msg) => {
    const repo = makeRepo();
    const before = head(repo);
    repo.write("a.txt", "hello\n");
    repo.git(["add", "a.txt"]);
    const r = repo.git(["commit", "-qm", msg]);
    expect(r.status, r.out).not.toBe(0);
    expect(head(repo)).toBe(before);
    expect(r.out.toLowerCase()).not.toContain("gremlins");
  });

  it("accepts a conventional message", () => {
    const repo = makeRepo();
    repo.write("a.txt", "hello\n");
    repo.git(["add", "a.txt"]);
    expect(repo.git(["commit", "-qm", "feat(scope): add a\n\nbody line"]).status).toBe(0);
  });
});

describe("commit identity guard: GitHub no-reply only", () => {
  it.each([
    ["a machine-derived address", MACHINE],
    ["a reserved-domain placeholder", RESERVED],
  ])("pre-commit refuses %s and never prints it", (_why, addr) => {
    const repo = makeRepo();
    repo.git(["config", "user.email", addr]);
    const before = head(repo);
    repo.write("a.txt", "hello\n");
    repo.git(["add", "a.txt"]);
    const r = repo.git(["commit", "-qm", "feat: a"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/identity/i);
    expect(r.out).not.toContain(addr);
    expect(head(repo)).toBe(before);
  });

  it("pre-commit refuses when only the author (env) is not a no-reply address", () => {
    const repo = makeRepo();
    repo.write("a.txt", "hello\n");
    repo.git(["add", "a.txt"]);
    const r = repo.git(["commit", "-qm", "feat: a"], { GIT_AUTHOR_EMAIL: MACHINE });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/identity/i);
  });

  it("pre-commit refuses when only the committer (env) is not a no-reply address", () => {
    const repo = makeRepo();
    repo.write("a.txt", "hello\n");
    repo.git(["add", "a.txt"]);
    const r = repo.git(["commit", "-qm", "feat: a"], { GIT_COMMITTER_EMAIL: MACHINE });
    expect(r.status).not.toBe(0);
  });
});

describe.skipIf(!HAS_ZSH)("scripts/dev/commit-paths.sh (macOS dev tool; zsh)", () => {
  function withOrigin(repo: Repo) {
    const bare = path.join(path.dirname(repo.dir), "origin.git");
    expect(spawnSync("git", ["init", "-q", "--bare", bare]).status).toBe(0);
    repo.git(["remote", "add", "origin", bare]);
    expect(repo.git(["push", "-q", "origin", "build/probe"]).status).toBe(0);
    return bare;
  }
  const commitPaths = (repo: Repo, args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync("zsh", [path.join(repo.dir, "scripts/dev/commit-paths.sh"), ...args], {
      cwd: repo.dir,
      encoding: "utf8",
      env: isolatedEnv(repo.home, { TMPDIR: path.dirname(repo.dir), ...extra }),
      timeout: 120_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const originLog = (bare: string) =>
    spawnSync("git", ["--git-dir", bare, "log", "-1", "--format=%B", "build/probe"], {
      encoding: "utf8",
    }).stdout;

  it("commits and pushes a clean file; a literal \\n in the message becomes a newline; no trailer is added", () => {
    const repo = makeRepo();
    const bare = withOrigin(repo);
    repo.write("docs/notes-é.txt", "nothing secret\n");
    const r = commitPaths(repo, ["docs: notes\\n\\nbody line", "docs"]);
    expect(r.status, r.out).toBe(0);
    const files = spawnSync(
      "git",
      ["--git-dir", bare, "ls-tree", "-r", "-z", "--name-only", "build/probe"],
      {
        encoding: "utf8",
      },
    ).stdout.split("\0");
    expect(files).toContain("docs/notes-é.txt");
    expect(originLog(bare)).toBe("docs: notes\n\nbody line\n\n");
  });

  it("refuses main", () => {
    const repo = makeRepo();
    repo.git(["checkout", "-q", "-b", "main"]);
    repo.write("a.txt", "x\n");
    expect(commitPaths(repo, ["fix: a", "a.txt"]).status).toBe(7);
  });

  it("refuses a detached HEAD", () => {
    const repo = makeRepo();
    repo.git(["checkout", "-q", "--detach"]);
    repo.write("a.txt", "x\n");
    expect(commitPaths(repo, ["fix: a", "a.txt"]).status).toBe(7);
  });

  it("refuses a machine-derived identity and commits nothing (exit 10)", () => {
    const repo = makeRepo();
    withOrigin(repo);
    repo.git(["config", "user.email", MACHINE]);
    const before = head(repo);
    repo.write("a.txt", "hello\n");
    const r = commitPaths(repo, ["fix: a", "a.txt"]);
    expect(r.status).toBe(10);
    expect(r.out).not.toContain(MACHINE);
    expect(head(repo)).toBe(before);
  });

  it.each([
    ["non-conventional", "update stuff"],
    ["AI trailer", "fix: a\\n\\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"],
  ])("refuses a %s message (exit 11)", (_why, msg) => {
    const repo = makeRepo();
    withOrigin(repo);
    const before = head(repo);
    repo.write("a.txt", "hello\n");
    expect(commitPaths(repo, [msg, "a.txt"]).status).toBe(11);
    expect(head(repo)).toBe(before);
  });

  it("refuses a token in a non-ASCII-named file, and a deny-list term in the message (exit 9)", () => {
    const repo = makeRepo();
    withOrigin(repo);
    const before = head(repo);
    repo.write("docs/notes-é.txt", `token = ${TOKEN}\n`);
    const r = commitPaths(repo, ["docs: notes", "docs"]);
    expect(r.status).toBe(9);
    expect(r.out).toContain("[github-token]");
    repo.write("docs/notes-é.txt", "clean\n");
    const m = commitPaths(repo, [`docs: notes for ${DENY_TERM}`, "docs"]);
    expect(m.status).toBe(9);
    expect(m.out).toContain("deny-list match in COMMIT_MESSAGE:1");
    expect(m.out.toLowerCase()).not.toContain("gremlins");
    expect(head(repo)).toBe(before);
  });

  it("refuses a path outside the repo (1), an empty change (3) and a conflict-copy name (8)", () => {
    const repo = makeRepo();
    withOrigin(repo);
    expect(commitPaths(repo, ["fix: a", "/etc"]).status).toBe(1);
    expect(commitPaths(repo, ["fix: a", ".nvmrc"]).status).toBe(3);
    repo.write("types 2.ts", "export {};\n");
    expect(commitPaths(repo, ["fix: a", "types 2.ts"]).status).toBe(8);
  });

  it("never touches the shared index of other staged work", () => {
    const repo = makeRepo();
    withOrigin(repo);
    repo.write("other.txt", "someone else's staged work\n");
    repo.git(["add", "other.txt"]);
    repo.write("mine.txt", "mine\n");
    expect(commitPaths(repo, ["feat: mine", "mine.txt"]).status).toBe(0);
    expect(repo.git(["diff", "--cached", "--name-only"]).out.trim()).toBe("other.txt");
    expect(repo.git(["show", "--name-only", "--format=", "HEAD"]).out.trim()).toBe("mine.txt");
  });
});
