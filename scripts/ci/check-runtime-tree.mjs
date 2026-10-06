// @ts-check
// check-runtime-tree.mjs — the FULL runtime tree (`npm ls --omit=dev --all`, every depth) must equal
// scripts/ci/runtime-allowlist.json exactly: its `packages`, plus exactly one of its `oneOf` (the
// keyring platform package for this OS), no addition, no removal, no version drift, same count
// (plan 04 §2, §4.1, R11). Also asserts every runtime entry of package-lock.json — the eleven
// platform packages npm did not install included — comes from the npm registry with an sha512
// integrity. Ported from sibling @d72e03b, adapted (`oneOf`). Node built-ins only.
//
// Usage: node scripts/ci/check-runtime-tree.mjs [--root <dir>] [--allowlist <file>] [--print]
//   --print  print the current tree (common part + the platform package) for a reviewed update
import { existsSync } from "node:fs";
import path from "node:path";
import {
  REGISTRY,
  REPO_ROOT,
  isMain,
  isRecord,
  parseArgs,
  readJson,
  reporter,
  runtimeTree,
} from "./_lib.mjs";

const SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(-[\w.]+)?$/i;

/**
 * @typedef {{ count: number, packages: string[], oneOf: string[] }} Allowlist
 */

/**
 * @param {unknown} list
 * @param {string} field
 * @returns {string[]}
 */
function specList(list, field) {
  if (!Array.isArray(list) || !list.every((p) => typeof p === "string")) {
    throw new Error(`allow-list \`${field}\` must be an array of name@version strings`);
  }
  /** @type {string[]} */
  const out = list;
  for (const p of out) {
    if (!SPEC.test(p))
      throw new Error(`allow-list entry is not name@exact-version: ${JSON.stringify(p)}`);
  }
  if (new Set(out).size !== out.length)
    throw new Error(`allow-list \`${field}\` has duplicate entries`);
  return out;
}

/**
 * @param {unknown} raw
 * @returns {Allowlist}
 */
export function parseAllowlist(raw) {
  if (!isRecord(raw)) throw new Error("allow-list is not a JSON object");
  const { count } = raw;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error("allow-list `count` must be a non-negative integer");
  }
  const packages = specList(raw.packages, "packages");
  const oneOf = raw.oneOf === undefined ? [] : specList(raw.oneOf, "oneOf");
  for (const p of oneOf) {
    if (packages.includes(p)) throw new Error(`allow-list lists ${p} in both packages and oneOf`);
  }
  const expected = packages.length + (oneOf.length ? 1 : 0);
  if (count !== expected) {
    throw new Error(
      `allow-list count ${String(count)} != ${String(expected)} (packages + one of oneOf)`,
    );
  }
  return { count, packages, oneOf };
}

/**
 * @param {Iterable<string>} actual name@version of every runtime package
 * @param {Allowlist} allow
 * @returns {string[]} errors
 */
export function compareTree(actual, allow) {
  const have = new Set(actual);
  const want = new Set(allow.packages);
  const choices = new Set(allow.oneOf);
  /** @type {string[]} */
  const errors = [];
  const picked = [...have].filter((p) => choices.has(p)).sort();
  for (const p of [...have].sort()) {
    if (!want.has(p) && !choices.has(p)) errors.push(`not on the allow-list: ${p}`);
  }
  for (const p of [...want].sort()) {
    if (!have.has(p)) errors.push(`on the allow-list but not installed: ${p}`);
  }
  if (choices.size && picked.length !== 1) {
    errors.push(
      `exactly one platform package of \`oneOf\` must be installed; found ${String(picked.length)}${picked.length ? ` (${picked.join(", ")})` : ""}`,
    );
  }
  if (have.size !== allow.count) {
    errors.push(
      `runtime tree has ${String(have.size)} package(s); allow-list count is ${String(allow.count)}`,
    );
  }
  return errors;
}

/**
 * Every non-dev lockfile entry must be a registry tarball with an sha512 integrity.
 * @param {unknown} lock
 * @returns {string[]} errors
 */
export function checkLockProvenance(lock) {
  if (!isRecord(lock) || !isRecord(lock.packages))
    return ["package-lock.json has no `packages` map"];
  if (lock.lockfileVersion !== 3) {
    return [`package-lock.json lockfileVersion ${String(lock.lockfileVersion)} (expected 3)`];
  }
  /** @type {string[]} */
  const errors = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || !isRecord(entry)) continue;
    if (entry.dev === true || entry.devOptional === true) continue;
    if (entry.link === true) {
      errors.push(`${key}: is a link, not a registry package`);
      continue;
    }
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) {
      errors.push(`${key}: resolved from ${String(entry.resolved)} (must be ${REGISTRY})`);
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      errors.push(`${key}: missing sha512 integrity`);
    }
  }
  return errors;
}

/**
 * @param {string} root
 * @param {string} allowlistPath
 * @returns {number} exit code
 */
export function main(root, allowlistPath) {
  const r = reporter("check-runtime-tree");
  const tree = runtimeTree(root);
  for (const p of tree.problems) r.error(`npm ls: ${p}`);
  const allow = parseAllowlist(readJson(allowlistPath));
  compareTree(tree.nodes.keys(), allow).forEach(r.error);
  const lockPath = path.join(root, "package-lock.json");
  if (existsSync(lockPath)) checkLockProvenance(readJson(lockPath)).forEach(r.error);
  else r.error("package-lock.json is missing");
  return r.finish(`${String(tree.nodes.size)} runtime package(s) match the allow-list`);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? path.resolve(args.root) : REPO_ROOT;
  const allowlist =
    typeof args.allowlist === "string"
      ? path.resolve(args.allowlist)
      : path.join(REPO_ROOT, "scripts", "ci", "runtime-allowlist.json");
  try {
    if (args.print === true) {
      const pkgs = [...runtimeTree(root).nodes.keys()].sort();
      process.stdout.write(`${JSON.stringify({ count: pkgs.length, packages: pkgs }, null, 2)}\n`);
      process.exitCode = 0;
    } else {
      process.exitCode = main(root, allowlist);
    }
  } catch (e) {
    process.stderr.write(`check-runtime-tree: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
