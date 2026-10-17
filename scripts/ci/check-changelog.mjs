// @ts-check
// check-changelog.mjs — a release tag's gate before `npm pack` (plan 04 §4.4, R8; Stage C finding
// ci-release-workflow-missing): the tag is `vX.Y.Z` (semver, an optional pre-release), package.json's
// `version` is that X.Y.Z, and CHANGELOG.md (Keep a Changelog) has a `## [X.Y.Z] - YYYY-MM-DD`
// section with content — which becomes the GitHub Release's body (`--notes <file>`). The
// `[Unreleased]` section is never a release. Plan 04 names `scripts/check-changelog.ts`; the CI
// checks live in scripts/ci/ as dependency-free .mjs (the job runs before any tsx is needed).
// Node built-ins only.
//
// Usage: node scripts/ci/check-changelog.mjs --tag vX.Y.Z [--notes <file>] [--root <dir>]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, isMain, isRecord, parseArgs, readJson, reporter } from "./_lib.mjs";

/** `vX.Y.Z` or `vX.Y.Z-pre.1` (semver 2.0.0 core and pre-release; no build metadata). */
export const TAG_RE =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

/** A release section heading: `## [X.Y.Z] - YYYY-MM-DD` (Keep a Changelog 1.1.0). */
const HEADING_RE = /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

/**
 * The section of `version` in a Keep a Changelog text: its date (null when the heading has none)
 * and its body (the lines up to the next `## ` heading, trimmed), or null when absent.
 * @param {string} text
 * @param {string} version
 * @returns {{ date: string | null, body: string } | null}
 */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i] ?? "");
    if (m === null || m[1] !== version) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (/^## /.test(l)) break;
      body.push(l);
    }
    return { date: m[2] ?? null, body: body.join("\n").trim() };
  }
  return null;
}

/**
 * Every problem with releasing `tag` (empty = releasable) and the notes.
 * @param {{ tag: string, pkgVersion: unknown, changelog: string }} input
 * @returns {{ problems: string[], version: string | null, notes: string | null }}
 */
export function checkRelease({ tag, pkgVersion, changelog }) {
  /** @type {string[]} */
  const problems = [];
  const m = TAG_RE.exec(tag);
  if (m === null) {
    problems.push(`the tag ${JSON.stringify(tag)} is not vX.Y.Z (semver)`);
    return { problems, version: null, notes: null };
  }
  const version = m[1] ?? "";
  if (pkgVersion !== version)
    problems.push(
      `package.json version ${JSON.stringify(pkgVersion)} is not the tag's ${version} (bump it in the release commit)`,
    );
  const section = changelogSection(changelog, version);
  if (section === null) {
    problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`);
    return { problems, version, notes: null };
  }
  if (section.date === null)
    problems.push(`CHANGELOG.md's [${version}] heading has no release date (" - YYYY-MM-DD")`);
  else if (!Number.isFinite(Date.parse(`${section.date}T00:00:00Z`)))
    problems.push(`CHANGELOG.md's [${version}] date ${section.date} is not a calendar date`);
  if (section.body.length === 0) problems.push(`CHANGELOG.md's [${version}] section is empty`);
  return { problems, version, notes: section.body.length === 0 ? null : section.body };
}

/**
 * @param {string} root
 * @param {string} tag
 * @param {string | null} notesFile
 * @returns {number} exit code
 */
export function main(root, tag, notesFile) {
  const r = reporter("check-changelog");
  const manifest = readJson(path.join(root, "package.json"));
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const out = checkRelease({
    tag,
    pkgVersion: isRecord(manifest) ? manifest.version : undefined,
    changelog,
  });
  for (const p of out.problems) r.error(p);
  if (out.problems.length === 0 && notesFile !== null && out.notes !== null)
    writeFileSync(notesFile, `${out.notes}\n`);
  return r.finish(`${tag}: package.json and CHANGELOG.md agree`);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? path.resolve(args.root) : REPO_ROOT;
  try {
    if (typeof args.tag !== "string") throw new Error("--tag vX.Y.Z is required");
    process.exitCode = main(root, args.tag, typeof args.notes === "string" ? args.notes : null);
  } catch (e) {
    process.stderr.write(`check-changelog: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
