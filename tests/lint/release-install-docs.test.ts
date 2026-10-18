// release-install-docs.test.ts — the README's release install is the one release.yml runs on the
// tarball it publishes (plan 04 §4.4; plan 02 §7.1 "Lockfile": the integrity hashes are the
// provenance; plan 03 §4.3; Stage C finding ci-release-workflow-missing). The README told readers to
// `npm install -g` the release tarball and said the install "resolves the same locked tree with its
// integrity hashes", but the tarball carried no npm-shrinkwrap.json — and npm never reads the
// shrinkwrap of a .tgz it installs by path anyway. The documented commands are now exactly those
// scripts/ci/check-release-install.mjs runs, and the only global npm install any install document
// mentions is the one it warns against.
import { describe, expect, it } from "vitest";
import { LINK, LOCKED_INSTALL } from "../../scripts/ci/check-release-install.mjs";
import { SHRINKWRAP } from "../../scripts/ci/scan-tarball.mjs";
import { commands, fences, readDoc, runnable, section, words } from "./docs-helpers.js";

const README = readDoc("README.md");
const RELEASE_YML = readDoc(".github/workflows/release.yml");
const pkg = JSON.parse(readDoc("package.json")) as { name: string; files: string[] };
const npmLocked = `npm ${LOCKED_INSTALL.join(" ")}`;
const npmLink = `npm ${LINK.join(" ")}`;

describe("README, Install from a release", () => {
  const sec = section(README, "### Install from a release");
  const block = fences(sec).find((f) => f.lang === "sh");
  const cmds = block === undefined ? [] : runnable(block);
  const at = (c: string): number => cmds.indexOf(c);
  const asset = `${pkg.name}-<version>.tgz`;
  const tar = cmds.find((c) => c.startsWith("tar ")) ?? "";
  const tw = words(tar);
  const dir = tw[tw.indexOf("-C") + 1] ?? "";

  it("checks the asset's sha256, unpacks it into a new folder, installs the lock there, then links", () => {
    expect(cmds[0]).toBe(`shasum -a 256 -c ${asset}.sha256`);
    expect(tw.slice(0, 3)).toEqual(["tar", "-xzf", asset]);
    expect(tw.slice(tw.indexOf("--strip-components"))).toEqual(["--strip-components", "1"]);
    expect(dir).toMatch(/^~\/\S+$/);
    expect(at(`mkdir -p ${dir}`)).toBeGreaterThan(at(cmds[0] ?? ""));
    expect(at(tar)).toBeGreaterThan(at(`mkdir -p ${dir}`));
    expect(at(`cd ${dir}`)).toBeGreaterThan(at(tar));
    expect(at(npmLocked)).toBeGreaterThan(at(`cd ${dir}`));
    expect(at(npmLink)).toBeGreaterThan(at(npmLocked));
    // nothing else installs anything
    expect(cmds.filter((c) => c.startsWith("npm "))).toEqual([npmLocked, npmLink]);
  });

  it("the folder is not one eff uninstall clears, nor a synced one", () => {
    expect(dir).not.toMatch(/^~\/(?:\.config|\.cache|Documents|Desktop|Library)(?:\/|$)/);
  });

  it("the assets are the ones release.yml uploads", () => {
    expect(RELEASE_YML).toContain(`tgz="${pkg.name}-\${GITHUB_REF_NAME#v}.tgz"`);
    expect(RELEASE_YML).toContain('sha256sum "$tgz" > "$tgz.sha256"');
    expect(RELEASE_YML).toContain('gh release create "$GITHUB_REF_NAME" "$tgz" "$tgz.sha256"');
  });

  it("says the tarball carries the committed lockfile, which package.json `files` ships", () => {
    expect(sec).toContain(
      `carries \`${SHRINKWRAP}\`, which is the committed \`package-lock.json\` byte for byte`,
    );
    expect(pkg.files).toContain(SHRINKWRAP);
  });

  it("warns against installing the .tgz itself, and names the check that runs these commands", () => {
    expect(sec).toContain("**Do not `npm install -g` the `.tgz` itself:**");
    expect(sec).toContain("`scripts/ci/check-release-install.mjs`");
    expect(RELEASE_YML).toContain("node scripts/ci/check-release-install.mjs --tarball");
  });
});

describe("no install document tells the reader to npm install -g (it would bypass the lockfile)", () => {
  const GLOBAL = /^npm (?:install|i)\b.*(?:\s-g\b|\s--global\b)/;
  it.each(["README.md", "skills/README.md", "SECURITY.md", "docs/README.md"])("%s", (doc) => {
    const md = readDoc(doc);
    const globals = [...commands(md, "npm install"), ...commands(md, "npm i ")].filter((c) =>
      GLOBAL.test(c.cmd),
    );
    for (const g of globals) {
      expect(g.inFence, `${doc}: ${g.cmd}`).toBe(false);
      expect(g.context, `${doc}: ${g.cmd}`).toMatch(/\bDo not\b/);
    }
  });
});
