// @ts-check
// check-no-scripts.mjs — no runtime dependency, at any depth, may carry an install-time hook or a
// native build (plan 04 §4.1 `supply-chain`; plan 02 §7). Ported from sibling @d72e03b, adapted.
// Node built-ins only.
//
// Fails on: scripts.preinstall/install/postinstall; `prepare` anywhere EXCEPT an exact name@version
// in PREPARE_ALLOWED that is resolved from the npm registry (npm never runs `prepare` for a
// registry tarball — plan 04 §2, A-5); `gypfile: true`; a binding.gyp file; a dependency on a
// native build/prebuilt-download helper; `hasInstallScript` on any runtime lockfile entry; any npm
// ls problem. The @napi-rs/keyring platform packages are prebuilt `.node` binaries: they are
// allowed EXPLICITLY (PLATFORM_PACKAGE) and each installed one must declare no scripts at all, ship
// its `main` as a `.node` file that exists, and list nothing else in `files` (plan 04 §4.1: "the
// @napi-rs/keyring platform package must be present as a prebuilt .node with no scripts").
//
// Usage: node scripts/ci/check-no-scripts.mjs [--root <dir>]
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  REGISTRY,
  REPO_ROOT,
  isMain,
  isRecord,
  manifestDir,
  parseArgs,
  readJson,
  reporter,
  runtimeTree,
} from "./_lib.mjs";

export const INSTALL_HOOKS = Object.freeze(["preinstall", "install", "postinstall"]);
export const NATIVE_HELPERS = Object.freeze([
  "prebuild-install",
  "node-gyp",
  "node-gyp-build",
  "node-pre-gyp",
  "@mapbox/node-pre-gyp",
  "prebuildify",
  "cmake-js",
  "napi-postinstall",
]);

/**
 * Registry packages whose published manifest declares `prepare` (never run for a registry tarball):
 * exact name@version, with the reason. Any other `prepare` fails.
 * @type {Readonly<Record<string, string>>}
 */
export const PREPARE_ALLOWED = Object.freeze({
  "hyparquet@1.31.2":
    "`prepare` builds types from a git checkout only; npm never runs it for a registry tarball (plan 04 §2, A-5)",
});

/** The keyring's prebuilt platform packages (plan 04 §2: 12 optional, one installed per platform). */
export const PLATFORM_PACKAGE = /^@napi-rs\/keyring-(?:darwin|freebsd|linux|win32)-[a-z0-9-]+$/;

/**
 * Inspect one installed package.
 * @param {{ id: string, dir: string, manifest: unknown, resolved?: string | undefined }} pkg
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function inspectPackage(pkg) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const m = pkg.manifest;
  if (!isRecord(m)) {
    errors.push(`${pkg.id}: package.json is not an object`);
    return { errors, warnings };
  }
  const fromRegistry = typeof pkg.resolved === "string" && pkg.resolved.startsWith(REGISTRY);
  const scripts = isRecord(m.scripts) ? m.scripts : {};
  for (const hook of INSTALL_HOOKS) {
    if (typeof scripts[hook] === "string") errors.push(`${pkg.id}: has a "${hook}" script`);
  }
  if (typeof scripts.prepare === "string") {
    const reason = PREPARE_ALLOWED[pkg.id];
    if (reason !== undefined && fromRegistry)
      warnings.push(`${pkg.id}: "prepare" allowed — ${reason}`);
    else if (reason !== undefined)
      errors.push(`${pkg.id}: has a "prepare" script and is not installed from the npm registry`);
    else errors.push(`${pkg.id}: has a "prepare" script (not on PREPARE_ALLOWED)`);
  }
  if (m.gypfile === true) errors.push(`${pkg.id}: gypfile: true (native build)`);
  if (existsSync(path.join(pkg.dir, "binding.gyp")))
    errors.push(`${pkg.id}: ships binding.gyp (native build)`);
  for (const field of ["dependencies", "optionalDependencies"]) {
    const deps = m[field];
    if (!isRecord(deps)) continue;
    for (const helper of NATIVE_HELPERS) {
      if (helper in deps) errors.push(`${pkg.id}: depends on ${helper} (native/prebuilt download)`);
    }
  }
  const name = typeof m.name === "string" ? m.name : "";
  if (PLATFORM_PACKAGE.test(name))
    errors.push(...inspectPlatformPackage(pkg.id, pkg.dir, m, fromRegistry));
  return { errors, warnings };
}

/**
 * A keyring platform package: a prebuilt `.node`, nothing to run.
 * @param {string} id
 * @param {string} dir
 * @param {Record<string, unknown>} m
 * @param {boolean} fromRegistry
 * @returns {string[]}
 */
export function inspectPlatformPackage(id, dir, m, fromRegistry) {
  /** @type {string[]} */
  const errors = [];
  if (!fromRegistry) errors.push(`${id}: platform package not resolved from the npm registry`);
  if (isRecord(m.scripts) && Object.keys(m.scripts).length)
    errors.push(`${id}: platform package declares scripts`);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (isRecord(m[field]) && Object.keys(m[field]).length)
      errors.push(`${id}: platform package declares ${field}`);
  }
  const main = typeof m.main === "string" ? m.main : "";
  if (!/^[\w.-]+\.node$/.test(main))
    errors.push(`${id}: platform package main is not a top-level .node file`);
  else if (!existsSync(path.join(dir, main))) errors.push(`${id}: prebuilt ${main} is missing`);
  if (!Array.isArray(m.files) || m.files.length !== 1 || m.files[0] !== main) {
    errors.push(`${id}: platform package \`files\` must list exactly its .node binary`);
  }
  /** @type {string[]} */
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    errors.push(`${id}: cannot list the package directory`);
  }
  const unexpected = entries.filter(
    (f) => !["package.json", "README.md", "LICENSE", main].includes(f),
  );
  if (unexpected.length)
    errors.push(`${id}: platform package ships unexpected files: ${unexpected.join(", ")}`);
  return errors;
}

/**
 * Runtime entries the lockfile marks `hasInstallScript` (npm records it at install time).
 * @param {unknown} lock
 * @returns {string[]}
 */
export function lockfileInstallScripts(lock) {
  if (!isRecord(lock) || !isRecord(lock.packages)) return [];
  /** @type {string[]} */
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || !isRecord(entry)) continue;
    if (entry.dev === true || entry.devOptional === true) continue;
    if (entry.hasInstallScript === true) out.push(key);
  }
  return out;
}

/**
 * @param {string} root
 * @returns {number} exit code
 */
export function main(root) {
  const r = reporter("check-no-scripts");
  const tree = runtimeTree(root);
  for (const p of tree.problems) r.error(`npm ls: ${p}`);
  for (const name of tree.unmetOptional) {
    if (!PLATFORM_PACKAGE.test(name))
      r.error(`npm ls: unmet optional dependency ${name} is not a keyring platform package`);
  }
  let platform = 0;
  for (const node of tree.nodes.values()) {
    const id = `${node.name}@${node.version}`;
    const dir = manifestDir(node, root);
    if (PLATFORM_PACKAGE.test(node.name)) platform++;
    let manifest;
    try {
      manifest = readJson(path.join(dir, "package.json"));
    } catch (e) {
      r.error(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const found = inspectPackage({ id, dir, manifest, resolved: node.resolved });
    found.errors.forEach(r.error);
    found.warnings.forEach(r.warn);
  }
  const lockPath = path.join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    for (const k of lockfileInstallScripts(readJson(lockPath)))
      r.error(`package-lock.json: ${k} hasInstallScript`);
  }
  return r.finish(
    `${String(tree.nodes.size)} runtime package(s) (${String(platform)} prebuilt platform package(s)), no install hooks or native builds`,
  );
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? path.resolve(args.root) : REPO_ROOT;
  try {
    process.exitCode = main(root);
  } catch (e) {
    process.stderr.write(`check-no-scripts: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
