// ci-scan-tarball.test.ts — scripts/ci/scan-tarball.mjs must FAIL when the package would ship a
// fixture, a test, an env file, a database, a cookie/session/credential file, a YAML outside skills/,
// a secret or an ESPN identifier, or would miss a plugin-root file (plan 04 §2, §4.1 `pack`, R8;
// plan 09 §4); with --release, also when the tarball would not carry the committed lockfile as
// npm-shrinkwrap.json (plan 04 §4.4; Stage C finding ci-release-workflow-missing). Ported from
// sibling @d72e03b, adapted.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNpm } from "../../scripts/ci/_lib.mjs";
import {
  LOCKFILE,
  REQUIRED,
  SHRINKWRAP,
  classify,
  main,
  packedPaths,
} from "../../scripts/ci/scan-tarball.mjs";
import { ROOT, runCheck, tempDir, writeTree } from "../lint/helpers.js";

const FILES = [
  "dist",
  "!dist/plugin-evals",
  "!dist/skills-copy",
  "scripts/eff-launch.sh",
  "skills",
  ".claude-plugin",
  ".mcp.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "npm-shrinkwrap.json",
];

describe("classify", () => {
  it.each([
    "dist/cli.js",
    "dist/mcp/server.js.map",
    "skills/start-sit/SKILL.md",
    "skills/start-sit/references/table.yaml",
    "scripts/eff-launch.sh",
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "package.json",
    // a release tarball's lock: release.yml copies the committed lockfile to it (plan 04 §4.4)
    "npm-shrinkwrap.json",
  ])("allows %s", (f) => {
    expect(classify(f, FILES)).toBeNull();
  });
  it("admits npm-shrinkwrap.json only through `files` (npm never adds it on its own)", () => {
    const without = FILES.filter((f) => f !== SHRINKWRAP);
    expect(classify(SHRINKWRAP, without)).toBe("not covered by package.json `files`");
    expect(classify(LOCKFILE, FILES)).toBe("not covered by package.json `files`");
  });
  it.each([
    ["dist/fixtures/espn/league.json", "fixtures"],
    ["fixtures/espn/recorded/mSettings.json", "fixtures"],
    ["dist/tests/x.test.js", "tests"],
    ["dist/.env", "env"],
    ["dist/.env.local", "env"],
    [".npmrc", ".npmrc"],
    ["dist/store.sqlite", "database"],
    ["dist/store.sqlite-wal", "database"],
    ["dist/cache.db", "database"],
    ["dist/league.yaml", "yaml"],
    ["dist/id.pem", "key"],
    ["dist/capture.har", "capture"],
    ["dist/credentials.json", "credentials"],
    ["dist/session.json", "session"],
    ["dist/espn-token.json", "token"],
    ["dist/cookies.txt", "cookie"],
    ["dist/espn_s2.txt", "ESPN credential"],
    ["dist/SWID", "ESPN credential"],
    ["scripts/dev/scan-secrets.mjs", "files"],
    ["src/cli.ts", "files"],
    ["docs/HANDOFF.md", "files"],
    ["distx/a.js", "files"],
    ["../etc/passwd", "escapes"],
    ["/etc/passwd", "escapes"],
    ["dist/inner.tgz", "tarball"],
    // generated local outputs under dist/ never ship (package.json `files` negations)
    ["dist/plugin-evals/plugins/base--core/.mcp.json", "negation"],
    ["dist/skills-copy/start-sit/SKILL.md", "negation"],
  ])("rejects %s (%s)", (f, why) => {
    expect(classify(f, FILES) ?? "").toContain(why);
  });
});

describe("packedPaths", () => {
  it.each([[null], [[]], [[{}, {}]], [[{ files: "x" }]], [[{ files: [{ size: 1 }] }]]])(
    "rejects %j",
    (j) => {
      expect(() => packedPaths(j)).toThrow();
    },
  );
  it("lists paths", () => {
    expect(packedPaths([{ files: [{ path: "a" }, { path: "b" }] }])).toEqual(["a", "b"]);
  });
});

describe("scan-tarball CLI on a fake package", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());
  const pkg = { name: "fake-pack", version: "1.0.0", files: ["dist"] };

  it("exits 1 when dist/ carries an env file and a fixture, and the plugin files are missing", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": pkg,
      "dist/index.js": "export {};\n",
      "dist/.env.local": "X=1\n",
      "dist/fixtures/a.json": "{}\n",
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dist/.env.local: env file");
    expect(r.stderr).toContain("dist/fixtures/a.json: fixtures never ship");
    for (const f of REQUIRED) expect(r.stderr).toContain(`${f} is not packed`);
  });

  it("exits 1 when a packed file holds an ESPN league id or a brace-GUID outside the fake range", () => {
    tmp = tempDir();
    const leagueUrl = `https://fantasy.espn.com/football/league?${["leagueId", "4815162"].join("=")}`; // built at runtime
    writeTree(tmp.dir, {
      "package.json": pkg,
      "dist/index.js": `export const u = "${leagueUrl}";\n`,
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("espn-league-id");
  });

  // Stage C finding scan-paths-identifier-rules-skipped: the packed PATHS are published too, and
  // the tarball scan inherits scan-secrets' path rules (its FORBIDDEN list has no identifier rule)
  it("exits 1 when a packed PATH carries an ESPN league id; the id is never printed", () => {
    tmp = tempDir();
    const id = ["4", "8", "1", "5", "1", "6", "2"].join("");
    writeTree(tmp.dir, { "package.json": pkg, [`dist/leagues/${id}/index.js`]: "export {};\n" });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /the path of scanned entry #\d+ \(path not printed\) {2}\[espn-league-id\]/,
    );
    expect(r.stderr).not.toContain(id);
  });

  // npm's pack listing masks a GUID-shaped name (`dist/{***}.js`): the scanner was handed a name
  // that is not on disk and skipped it, so that file shipped with neither its path nor its bytes
  // scanned. A named path that does not exist now fails the scan (fail closed).
  it("exits 1 when a packed name is masked by npm's listing (or flags it when listed as is); the GUID is never printed", () => {
    tmp = tempDir();
    const guid = ["7C1E2A9B", "3D4F", "4A6B", "8C7D", "9E0F1A2B3C4D"].join("-");
    writeTree(tmp.dir, {
      "package.json": pkg,
      "dist/index.js": "export {};\n",
      [`dist/{${guid}}.js`]: `export const t = "${["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_")}";\n`,
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /scanned entry #\d+ does not exist \(path not printed\)|\(path not printed\) {2}\[brace-guid\]/,
    );
    expect(r.stderr).not.toContain(guid);
  });

  it("exits 1 when nothing was built", () => {
    tmp = tempDir();
    writeTree(tmp.dir, { "package.json": pkg, "README.md": "# x\n" });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no dist/ files packed");
  });

  it("exits 1 when src/cli.ts exists but the bin target is not packed", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": { ...pkg, bin: { eff: "dist/cli.js" } },
      "dist/index.js": "export {};\n",
      "src/cli.ts": "export {};\n",
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("bin target dist/cli.js is not packed");
  });

  it("passes a clean plugin-root package (the four plugin files packed)", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": { ...pkg, files: FILES },
      "dist/index.js": 'export const k = "leagueId=0";\n',
      "scripts/eff-launch.sh": "#!/bin/sh\n",
      ".mcp.json": "{}\n",
      ".claude-plugin/plugin.json": "{}\n",
      ".claude-plugin/marketplace.json": "{}\n",
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("main() honours an injected required list", () => {
    tmp = tempDir();
    writeTree(tmp.dir, { "package.json": pkg, "dist/index.js": "export {};\n" });
    expect(main(tmp.dir, { required: [] })).toBe(0);
  });
});

// The release tarball carries its lock (plan 04 §4.4; plan 02 §7.1 "Lockfile"; Stage C finding
// ci-release-workflow-missing, attempt 2: release.yml shrinkwrapped the lockfile, but npm packed the
// tarball without it, because a `files` allow-list ships npm-shrinkwrap.json only when it names it).
describe("the release tarball carries the committed lockfile as npm-shrinkwrap.json", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  /** The repository's own package.json `files` — what release.yml's npm pack obeys. */
  const realFiles = (
    JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      files: string[];
    }
  ).files;
  const lock = (version = "1.0.0") => ({
    name: "fake-pack",
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "fake-pack", version } },
  });
  /**
   * A clean plugin-root package with the lock written as release.yml writes it (a copy of the
   * lockfile); `over` replaces files, `omit` leaves files out.
   */
  function releaseRoot(
    over: Record<string, string | object> = {},
    { files = FILES, omit = [] }: { files?: string[]; omit?: string[] } = {},
  ): string {
    tmp = tempDir();
    const tree: Record<string, string | object> = {
      "package.json": { name: "fake-pack", version: "1.0.0", files },
      "dist/index.js": "export {};\n",
      "scripts/eff-launch.sh": "#!/bin/sh\n",
      ".mcp.json": "{}\n",
      ".claude-plugin/plugin.json": "{}\n",
      ".claude-plugin/marketplace.json": "{}\n",
      [LOCKFILE]: lock(),
      [SHRINKWRAP]: lock(),
      ...over,
    };
    writeTree(tmp.dir, Object.fromEntries(Object.entries(tree).filter(([f]) => !omit.includes(f))));
    return tmp.dir;
  }

  it("the repository's package.json `files` packs npm-shrinkwrap.json once it exists", () => {
    const dir = releaseRoot({}, { files: realFiles });
    const pack = runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], dir);
    expect(pack.status, pack.stderr).toBe(0);
    expect(packedPaths(JSON.parse(pack.stdout))).toContain(SHRINKWRAP);
    expect(main(dir, { release: true })).toBe(0);
  });

  it("--release passes the lock packed, byte for byte the committed lockfile", () => {
    const r = runCheck("scan-tarball.mjs", ["--root", releaseRoot(), "--release"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("npm-shrinkwrap.json is the committed package-lock.json");
  });

  it("--release fails when `files` does not name it, though it exists (npm then leaves it out)", () => {
    const dir = releaseRoot({}, { files: FILES.filter((f) => f !== SHRINKWRAP) });
    const r = runCheck("scan-tarball.mjs", ["--root", dir, "--release"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm-shrinkwrap.json is not packed");
  });

  it("--release fails when no lock was written before packing", () => {
    const r = runCheck("scan-tarball.mjs", [
      "--root",
      releaseRoot({}, { omit: [SHRINKWRAP] }),
      "--release",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm-shrinkwrap.json is not packed");
    expect(r.stderr).toContain("npm-shrinkwrap.json does not exist");
  });

  it("--release fails when the lock is not the committed lockfile byte for byte (same JSON, other bytes)", () => {
    const dir = releaseRoot({ [SHRINKWRAP]: JSON.stringify(lock()) });
    const r = runCheck("scan-tarball.mjs", ["--root", dir, "--release"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm-shrinkwrap.json is not the committed package-lock.json");
  });

  it("--release fails when the lock describes another version (a bump without the lockfile)", () => {
    const dir = releaseRoot({ [LOCKFILE]: lock("0.9.0"), [SHRINKWRAP]: lock("0.9.0") });
    const r = runCheck("scan-tarball.mjs", ["--root", dir, "--release"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm-shrinkwrap.json does not name fake-pack@1.0.0");
  });

  it("--release fails when there is no committed lockfile to compare it with", () => {
    const r = runCheck("scan-tarball.mjs", [
      "--root",
      releaseRoot({}, { omit: [LOCKFILE] }),
      "--release",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("package-lock.json does not exist");
  });

  it("without --release a missing lock is fine: every push packs without one", () => {
    expect(main(releaseRoot({}, { omit: [SHRINKWRAP] }))).toBe(0);
  });
});
