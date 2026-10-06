// gitignore.test.ts — .gitignore never drops a source file (S6; plan 04 §1 layout; CLAUDE.md
// "Workflow": commit-paths would leave an ignored file out silently, so a local run stays green
// while the file never reaches the repo). Build output is anchored to the root, secret-name
// patterns are scoped to data files, and archives/databases are ignored (S5).
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ROOT } from "../lint/helpers.js";

const ignored = (p: string): boolean =>
  spawnSync("git", ["check-ignore", "-q", "--no-index", "--", p], { cwd: ROOT }).status === 0;

describe(".gitignore (S6)", () => {
  it.each([
    "src/lib/util.ts",
    "src/build/x.ts",
    "tests/build/a.test.ts",
    "src/out/a.ts",
    "src/cli/logs/a.ts",
    "tests/private/a.ts",
    "src/auth/cookie.ts",
    "src/auth/cookie-header.ts",
    "tests/auth/cookie-header.test.ts",
    "src/auth/credentials.ts",
    "src/auth/secrets.ts",
    "src/auth/espn_s2.ts",
    "src/providers/espn/swid.ts",
    "src/providers/espn/SWID.ts",
    "tests/auth/swid.test.ts",
    "src/auth/session.ts",
    "src/auth/token.ts",
    "scripts/lib/cookies.mjs",
    "skills/onboard/SKILL.md",
    "src/coverage/x.ts",
    "tests/fixtures/espn/cookie-free.json.example",
  ])("does NOT ignore the source path %s", (p) => {
    expect(ignored(p)).toBe(false);
  });

  it.each([
    "dist/cli.js",
    "coverage/index.html",
    "lib/x.js",
    "build/x",
    "logs/server.log",
    ".env",
    ".env.local",
    "cookies.txt",
    "espn_s2.txt",
    "espn_s2",
    "swid.txt",
    "secrets.json",
    "credentials.yaml",
    "session.json",
    "x.har",
    "store.sqlite",
    "store.sqlite3",
    "cache.db",
    "pbp.parquet",
    "raw-capture.json.gz",
    "dump.zip",
    "x.tar.zst",
    "fixtures/raw/a.json",
    "tests/fixtures/raw/a.json",
    "fixtures/espn/x.raw.json",
  ])("ignores the data/secret/output path %s", (p) => {
    expect(ignored(p)).toBe(true);
  });

  it("no source-tree file of this checkout is git-ignored (OS junk aside)", () => {
    const r = spawnSync(
      "git",
      [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        "src",
        "tests",
        "scripts",
        "skills",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    const junk = /(?:^|\/)(?:\.DS_Store|Thumbs\.db|\._[^/]*|[^/]*\.sw[op]|[^/]*~)$/;
    const files = r.stdout.split("\0").filter((f) => f !== "" && !junk.test(f));
    expect(files).toEqual([]);
  });

  it("no tracked file matches an ignore pattern", () => {
    const r = spawnSync("git", ["ls-files", "-ci", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.stdout.trim()).toBe("");
  });
});
