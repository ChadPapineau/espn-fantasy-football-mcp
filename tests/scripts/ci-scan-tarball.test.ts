// ci-scan-tarball.test.ts — scripts/ci/scan-tarball.mjs must FAIL when the package would ship a
// fixture, a test, an env file, a database, a cookie/session/credential file, a YAML outside skills/,
// a secret or an ESPN identifier, or would miss a plugin-root file (plan 04 §2, §4.1 `pack`, R8;
// plan 09 §4). Ported from sibling @d72e03b, adapted.
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED, classify, main, packedPaths } from "../../scripts/ci/scan-tarball.mjs";
import { runCheck, tempDir, writeTree } from "../lint/helpers.js";

const FILES = [
  "dist",
  "scripts/eff-launch.sh",
  "skills",
  ".claude-plugin",
  ".mcp.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
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
  ])("allows %s", (f) => {
    expect(classify(f, FILES)).toBeNull();
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
