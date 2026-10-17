// ci-check-changelog.test.ts — scripts/ci/check-changelog.mjs, release.yml's gate before npm pack
// (plan 04 §4.4, R8; Stage C finding ci-release-workflow-missing): a tag releases only when it is
// vX.Y.Z, package.json carries that version and CHANGELOG.md has a dated, non-empty section for it
// — whose body becomes the GitHub Release's notes. [Unreleased] is never a release.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TAG_RE, changelogSection, checkRelease } from "../../scripts/ci/check-changelog.mjs";
import { runCheck, tempDir, writeTree } from "../lint/helpers.js";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- something not yet released

## [0.2.0] - 2026-12-01

### Fixed

- the waiver timing

## [0.1.0] - 2026-11-20

### Added

- the first release

## [0.0.9]
`;

describe("the tag", () => {
  it.each(["v0.1.0", "v1.2.3", "v10.0.0", "v0.1.0-rc.1", "v2.0.0-beta"])("accepts %s", (t) => {
    expect(TAG_RE.test(t)).toBe(true);
  });
  it.each(["0.1.0", "v0.1", "v01.0.0", "v0.1.0+build", "v0.1.0-", "vX.Y.Z", "release-0.1.0"])(
    "refuses %s",
    (t) => {
      expect(TAG_RE.test(t)).toBe(false);
    },
  );
});

describe("changelogSection", () => {
  it("reads a dated section up to the next heading; null when absent", () => {
    expect(changelogSection(CHANGELOG, "0.2.0")).toEqual({
      date: "2026-12-01",
      body: "### Fixed\n\n- the waiver timing",
    });
    expect(changelogSection(CHANGELOG, "0.1.0")?.body).toBe("### Added\n\n- the first release");
    expect(changelogSection(CHANGELOG, "0.0.9")).toEqual({ date: null, body: "" });
    expect(changelogSection(CHANGELOG, "0.3.0")).toBeNull();
    // [Unreleased] is a heading, never a version
    expect(changelogSection(CHANGELOG, "Unreleased")?.date).toBeNull();
  });
});

describe("checkRelease", () => {
  it("a tag, package.json and a dated non-empty section that agree: releasable, with the notes", () => {
    expect(checkRelease({ tag: "v0.2.0", pkgVersion: "0.2.0", changelog: CHANGELOG })).toEqual({
      problems: [],
      version: "0.2.0",
      notes: "### Fixed\n\n- the waiver timing",
    });
  });
  it("refuses a mismatched package.json version, a missing section, an undated or empty one, a bad tag", () => {
    expect(
      checkRelease({ tag: "v0.2.0", pkgVersion: "0.1.0", changelog: CHANGELOG }).problems,
    ).toEqual([
      'package.json version "0.1.0" is not the tag\'s 0.2.0 (bump it in the release commit)',
    ]);
    expect(
      checkRelease({ tag: "v0.3.0", pkgVersion: "0.3.0", changelog: CHANGELOG }).problems,
    ).toEqual(['CHANGELOG.md has no "## [0.3.0] - YYYY-MM-DD" section']);
    expect(
      checkRelease({ tag: "v0.0.9", pkgVersion: "0.0.9", changelog: CHANGELOG }).problems,
    ).toEqual([
      'CHANGELOG.md\'s [0.0.9] heading has no release date (" - YYYY-MM-DD")',
      "CHANGELOG.md's [0.0.9] section is empty",
    ]);
    expect(
      checkRelease({ tag: "0.2.0", pkgVersion: "0.2.0", changelog: CHANGELOG }).problems,
    ).toEqual(['the tag "0.2.0" is not vX.Y.Z (semver)']);
    expect(
      checkRelease({
        tag: "v0.2.0",
        pkgVersion: "0.2.0",
        changelog: CHANGELOG.replace("2026-12-01", "2026-13-45"),
      }).problems,
    ).toEqual(["CHANGELOG.md's [0.2.0] date 2026-13-45 is not a calendar date"]);
  });
  it("this repository is not releasable yet: version 0.0.0 has no CHANGELOG section (only [Unreleased])", () => {
    const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
      version: string;
    };
    const changelog = readFileSync(path.resolve("CHANGELOG.md"), "utf8");
    expect(changelogSection(changelog, "Unreleased")).not.toBeNull();
    expect(
      checkRelease({ tag: `v${pkg.version}`, pkgVersion: pkg.version, changelog }).problems,
    ).not.toEqual([]);
  });
});

describe("the CLI (release.yml's step)", () => {
  let t: ReturnType<typeof tempDir> | undefined;
  afterEach(() => {
    t?.cleanup();
    t = undefined;
  });
  it("exit 0 and the notes file on a releasable tag; exit 1 and nothing written otherwise; exit 2 without --tag", () => {
    t = tempDir("eff-changelog-");
    writeTree(t.dir, {
      "package.json": { name: "x", version: "0.2.0" },
      "CHANGELOG.md": CHANGELOG,
    });
    const notes = path.join(t.dir, "notes.md");
    const ok = runCheck("check-changelog.mjs", [
      "--root",
      t.dir,
      "--tag",
      "v0.2.0",
      "--notes",
      notes,
    ]);
    expect(ok.status).toBe(0);
    expect(readFileSync(notes, "utf8")).toBe("### Fixed\n\n- the waiver timing\n");
    const bad = path.join(t.dir, "bad.md");
    const refused = runCheck("check-changelog.mjs", [
      "--root",
      t.dir,
      "--tag",
      "v0.3.0",
      "--notes",
      bad,
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('no "## [0.3.0] - YYYY-MM-DD" section');
    expect(() => readFileSync(bad, "utf8")).toThrow();
    expect(runCheck("check-changelog.mjs", ["--root", t.dir]).status).toBe(2);
  });
});
