// ci-check-release-install.test.ts — scripts/ci/check-release-install.mjs, release.yml's proof (and
// ci.yml's rehearsal of it) that the release tarball installs the README's way into exactly the
// committed lockfile's runtime tree (plan 04 §4.4; plan 02 §7.1 "Lockfile"; plan 03 §4.3; Stage C
// finding ci-release-workflow-missing). The CLI runs on fake release tarballs whose dependencies are
// `file:` tarballs inside the package, so `npm ci --offline` needs no registry, and an empty temp npm
// cache keeps the user's own cache out of it — npm's integrity check runs on real bytes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINK,
  LOCKED_INSTALL,
  OFFLINE,
  VERSION_ARGS,
  binsOf,
  lockedTreeProblems,
  onDiskProblems,
} from "../../scripts/ci/check-release-install.mjs";
import { runCheck, tempDir, writeTree } from "../lint/helpers.js";

const entry = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`,
  integrity: `sha512-${version}`,
  ...extra,
});
const LOCK = {
  lockfileVersion: 3,
  packages: {
    "": { name: "p", version: "1.0.0" },
    "node_modules/a": entry("1.0.0"),
    "node_modules/a/node_modules/b": entry("2.0.0"),
    "node_modules/plat-x": entry("1.0.0", { optional: true }),
    "node_modules/plat-y": entry("1.0.0", { optional: true }),
    "node_modules/dev-only": entry("3.0.0", { dev: true }),
  },
};
const hidden = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages });
const RUNTIME = {
  "node_modules/a": entry("1.0.0"),
  "node_modules/a/node_modules/b": entry("2.0.0"),
  "node_modules/plat-x": entry("1.0.0", { optional: true }),
};

describe("the commands are the README's (README, Install from a release)", () => {
  it("installs with npm ci from the lock, links with npm link, and adds only the offline switches", () => {
    expect(LOCKED_INSTALL).toEqual(["ci", "--omit=dev", "--ignore-scripts"]);
    expect(LINK).toEqual(["link", "--ignore-scripts"]);
    expect(OFFLINE).toEqual(["--offline", "--no-audit", "--no-fund"]);
    expect(VERSION_ARGS).toEqual(["version", "--json"]);
  });
});

describe("lockedTreeProblems", () => {
  it("passes the lockfile's runtime tree: every required entry, any optional one, no dev one", () => {
    expect(lockedTreeProblems(LOCK, hidden(RUNTIME))).toEqual([]);
    expect(
      lockedTreeProblems(LOCK, hidden({ ...RUNTIME, "node_modules/plat-y": entry("1.0.0") })),
    ).toEqual([]);
  });

  it("refuses a dev dependency, a package the lockfile does not list, and a drifted field", () => {
    const p = lockedTreeProblems(
      LOCK,
      hidden({
        ...RUNTIME,
        "node_modules/dev-only": entry("3.0.0"),
        "node_modules/stray": entry("1.0.0"),
        "node_modules/a": { ...entry("1.0.0"), integrity: "sha512-other" },
        "node_modules/a/node_modules/b": { ...entry("2.0.0"), version: "2.0.1" },
        "node_modules/plat-x": { ...entry("1.0.0"), resolved: "https://example.invalid/x.tgz" },
      }),
    );
    expect(p).toEqual([
      'node_modules/a: integrity "sha512-other" is not the lockfile\'s "sha512-1.0.0"',
      'node_modules/a/node_modules/b: version "2.0.1" is not the lockfile\'s "2.0.0"',
      'node_modules/plat-x: resolved "https://example.invalid/x.tgz" is not the lockfile\'s "https://registry.npmjs.org/x/-/x-1.0.0.tgz"',
      "node_modules/dev-only: a dev dependency was installed",
      "node_modules/stray: installed, but not in the lockfile",
    ]);
  });

  it("refuses a missing required entry, and an install that left nothing", () => {
    const { "node_modules/a/node_modules/b": _gone, ...rest } = RUNTIME;
    expect(lockedTreeProblems(LOCK, hidden(rest))).toEqual([
      "node_modules/a/node_modules/b: in the lockfile's runtime tree, not installed",
    ]);
    expect(lockedTreeProblems(LOCK, null)).toEqual([
      "node_modules/a: in the lockfile's runtime tree, not installed",
      "node_modules/a/node_modules/b: in the lockfile's runtime tree, not installed",
    ]);
  });

  it("throws on a file with no packages map", () => {
    expect(() => lockedTreeProblems({}, null)).toThrow(/no `packages` map/);
    expect(() => lockedTreeProblems(LOCK, { packages: [] })).toThrow(/no `packages` map/);
  });
});

describe("onDiskProblems and binsOf", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  it("every package npm recorded is on disk at that version", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "node_modules/a/package.json": { name: "a", version: "1.0.0" },
      "node_modules/c/package.json": { name: "c", version: "9.0.0" },
    });
    expect(onDiskProblems(tmp.dir, null)).toEqual([]);
    expect(
      onDiskProblems(
        tmp.dir,
        hidden({
          "node_modules/a": entry("1.0.0"),
          "node_modules/b": entry("2.0.0"),
          "node_modules/c": entry("1.0.0"),
        }),
      ),
    ).toEqual([
      "node_modules/b: npm recorded 2.0.0, but it is not on disk",
      "node_modules/c: npm recorded 1.0.0, but its package.json says 9.0.0",
    ]);
  });

  it("reads package.json `bin` in both forms", () => {
    expect(binsOf({ name: "@s/tool", bin: "cli.js" })).toEqual({ tool: "cli.js" });
    expect(binsOf({ name: "x", bin: { eff: "dist/cli.js", bad: 1 } })).toEqual({
      eff: "dist/cli.js",
    });
    expect(binsOf({ name: "x" })).toEqual({});
  });
});

// --- the CLI on fake release tarballs ----------------------------------------------------------

const sri = (file: string): string =>
  `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;

/** A gzip tarball of `stage/package` (npm's layout); no AppleDouble entries on macOS. */
function tgz(out: string, stage: string): void {
  const r = spawnSync("tar", ["-czf", out, "-C", stage, "package"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
}

interface FakeOptions {
  /** the tarball's npm-shrinkwrap.json: the committed lockfile's bytes, absent, or other bytes */
  readonly shrinkwrap?: "same" | "absent" | "other";
  /** both the committed lockfile and the shrinkwrap carry a wrong hash for the runtime dependency */
  readonly tamper?: boolean;
  /** the version the fake bin reports */
  readonly reports?: string;
  /** the allow-list's packages */
  readonly allow?: readonly string[];
}

/**
 * A fake release: package `fake-release@1.0.0` with a runtime dependency `dep-a` and a dev
 * dependency `dep-dev`, each a `file:` tarball shipped inside the package; the committed lockfile
 * and an allow-list beside it. Returns the CLI's arguments.
 */
function fakeRelease(dir: string, opts: FakeOptions = {}): string[] {
  const stage = path.join(dir, "stage");
  const vendor = path.join(stage, "package", "vendor");
  mkdirSync(vendor, { recursive: true });
  for (const name of ["dep-a", "dep-dev"]) {
    const src = path.join(dir, "src", name);
    writeTree(src, {
      "package/package.json": { name, version: "1.0.0", main: "index.js" },
      "package/index.js": "module.exports = 1;\n",
    });
    tgz(path.join(vendor, `${name}-1.0.0.tgz`), src);
  }
  const hash = (name: string) =>
    opts.tamper === true && name === "dep-a"
      ? `sha512-${createHash("sha512").update("not these bytes").digest("base64")}`
      : sri(path.join(vendor, `${name}-1.0.0.tgz`));
  const deps = { "dep-a": "file:vendor/dep-a-1.0.0.tgz" };
  const devDeps = { "dep-dev": "file:vendor/dep-dev-1.0.0.tgz" };
  const bin = { "fake-eff": "dist/cli.js" };
  const lock = {
    name: "fake-release",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "fake-release",
        version: "1.0.0",
        dependencies: deps,
        devDependencies: devDeps,
        bin,
      },
      "node_modules/dep-a": {
        version: "1.0.0",
        resolved: "file:vendor/dep-a-1.0.0.tgz",
        integrity: hash("dep-a"),
      },
      "node_modules/dep-dev": {
        version: "1.0.0",
        resolved: "file:vendor/dep-dev-1.0.0.tgz",
        integrity: hash("dep-dev"),
        dev: true,
      },
    },
  };
  const shrinkwrap = opts.shrinkwrap ?? "same";
  writeTree(path.join(stage, "package"), {
    "package.json": {
      name: "fake-release",
      version: "1.0.0",
      private: true,
      bin,
      files: ["dist", "vendor", "npm-shrinkwrap.json"],
      dependencies: deps,
      devDependencies: devDeps,
    },
    // the runtime dependency must resolve from the locked install for the bin to start
    "dist/cli.js": [
      "#!/usr/bin/env node",
      'require("dep-a");',
      `if (process.argv[2] === "version") process.stdout.write(JSON.stringify({ version: ${JSON.stringify(opts.reports ?? "1.0.0")} }) + "\\n");`,
      "",
    ].join("\n"),
    ...(shrinkwrap === "absent"
      ? {}
      : { "npm-shrinkwrap.json": shrinkwrap === "other" ? JSON.stringify(lock) : lock }),
  });
  const allow = opts.allow ?? ["dep-a@1.0.0"];
  writeTree(dir, {
    "committed/package-lock.json": lock,
    "allowlist.json": { count: allow.length, packages: allow, oneOf: [] },
  });
  const tarball = path.join(dir, "fake-release-1.0.0.tgz");
  tgz(tarball, stage);
  return [
    "--tarball",
    tarball,
    "--lock",
    path.join(dir, "committed", "package-lock.json"),
    "--allowlist",
    path.join(dir, "allowlist.json"),
  ];
}

describe("check-release-install CLI on a fake release", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());
  /** Run the check with an empty npm cache of its own (never the user's). */
  const run = (opts: FakeOptions = {}) => {
    tmp = tempDir("eff-release-test-");
    const cache = path.join(tmp.dir, "npm-cache");
    mkdirSync(cache);
    return runCheck("check-release-install.mjs", fakeRelease(tmp.dir, opts), {
      npm_config_cache: cache,
    });
  };

  it("passes: the locked runtime tree, no dev dependency, the bin linked into the folder and running", () => {
    const r = run();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "`npm ci --omit=dev --ignore-scripts` installed the lockfile's runtime tree (1 package(s)) offline",
    );
  });

  it("refuses a tarball that carries no npm-shrinkwrap.json (its install would not be locked)", () => {
    const r = run({ shrinkwrap: "absent" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the tarball carries no npm-shrinkwrap.json");
  });

  it("refuses a tarball whose npm-shrinkwrap.json is not the committed lockfile, byte for byte", () => {
    const r = run({ shrinkwrap: "other" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("byte for byte");
  });

  it("refuses a package whose bytes miss the lockfile's integrity hash (npm ci refuses it)", () => {
    const r = run({ tamper: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm ci --omit=dev --ignore-scripts failed in the unpacked tarball");
    expect(r.stderr).toContain("EINTEGRITY");
  });

  it("refuses a runtime tree the allow-list does not name", () => {
    const r = run({ allow: ["dep-b@1.0.0"] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not on the allow-list: dep-a@1.0.0");
  });

  it("refuses a linked bin that does not report the package's version", () => {
    const r = run({ reports: "0.0.1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fake-eff version --json did not report 1.0.0");
  });

  it("exits 2 without --tarball, or for a tarball that does not exist", () => {
    expect(runCheck("check-release-install.mjs", []).status).toBe(2);
    tmp = tempDir();
    const r = runCheck("check-release-install.mjs", ["--tarball", path.join(tmp.dir, "x.tgz")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no tarball at");
  });
});
