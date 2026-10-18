// @ts-check
// check-release-install.mjs — a release tarball installs the way README "Install from a release"
// says, and what that installs is the committed lockfile's runtime tree (plan 04 §4.4, R8; plan 02
// §7.1 "Lockfile": the integrity hashes are the provenance; plan 03 §4.3; Stage C finding
// ci-release-workflow-missing). npm never reads the npm-shrinkwrap.json of a .tgz it installs by
// path — `npm install -g <tarball>` resolves the package's dependencies from the registry, outside
// the lockfile (npm 11) — so the README unpacks the tarball and runs LOCKED_INSTALL in it (`npm ci`
// installs exactly the shrinkwrap's tree and refuses a package whose bytes miss their integrity
// hash), then LINK, which makes `eff` a link into the folder and installs nothing. This check runs
// those two commands on a built tarball, offline — it never reaches the network: in CI the job's own
// `npm ci` has just cached every locked package — and requires
//   1. the tarball carries npm-shrinkwrap.json, byte for byte the committed package-lock.json;
//   2. LOCKED_INSTALL succeeds and installed the lockfile's runtime tree: each installed package is a
//      non-dev entry at the same path, version, resolved URL and integrity (and on disk at that
//      version), each non-dev, non-optional entry is installed, and `npm ls` there agrees with the
//      runtime allow-list (scripts/ci/runtime-allowlist.json, as check-runtime-tree.mjs reads it);
//   3. LINK, under a throwaway global prefix, leaves the folder's tree as it was, adds no other
//      package, and links every bin into the folder;
//   4. every linked bin starts: `<bin> version --json` names the package's version.
// Node built-ins and the system `tar`.
//
// Usage: node scripts/ci/check-release-install.mjs --tarball <file.tgz> [--lock <package-lock.json>]
//          [--allowlist <runtime-allowlist.json>]
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareTree, parseAllowlist } from "./check-runtime-tree.mjs";
import {
  REPO_ROOT,
  isMain,
  isRecord,
  parseArgs,
  readJson,
  reporter,
  runNpm,
  runtimeTree,
} from "./_lib.mjs";
import { SHRINKWRAP } from "./scan-tarball.mjs";

/** The README's locked install, run in the unpacked package (`npm ci` reads its npm-shrinkwrap.json). */
export const LOCKED_INSTALL = Object.freeze(["ci", "--omit=dev", "--ignore-scripts"]);
/** The README's PATH step: a global link to the folder; it installs no dependency. */
export const LINK = Object.freeze(["link", "--ignore-scripts"]);
/** What this check adds to both: no network, no audit or funding request. */
export const OFFLINE = Object.freeze(["--offline", "--no-audit", "--no-fund"]);
/** A bin's version report (src/cli/main.ts: `eff version --json`). */
export const VERSION_ARGS = Object.freeze(["version", "--json"]);
/** npm's own record of what it installed (the hidden lockfile). */
const HIDDEN_LOCK = path.join("node_modules", ".package-lock.json");

/** @typedef {Record<string, unknown>} Entry */

/**
 * A lockfile's `packages` map (path → entry).
 * @param {unknown} lock
 * @param {string} what names the file in the error
 * @returns {Record<string, Entry>}
 */
function packagesOf(lock, what) {
  if (!isRecord(lock) || !isRecord(lock.packages))
    throw new Error(`${what} has no \`packages\` map`);
  /** @type {Record<string, Entry>} */
  const out = {};
  for (const [k, v] of Object.entries(lock.packages)) if (isRecord(v)) out[k] = v;
  return out;
}

/**
 * Where the installed tree is not the lockfile's runtime tree.
 * @param {unknown} lock the committed lockfile
 * @param {unknown} installed npm's hidden lockfile after the install; null when nothing was installed
 * @returns {string[]} problems (empty = the same locked tree)
 */
export function lockedTreeProblems(lock, installed) {
  const want = packagesOf(lock, "the lockfile");
  const have = installed === null ? {} : packagesOf(installed, HIDDEN_LOCK);
  /** @type {string[]} */
  const problems = [];
  for (const [at, got] of Object.entries(have)) {
    const entry = want[at];
    if (entry === undefined) {
      problems.push(`${at}: installed, but not in the lockfile`);
      continue;
    }
    if (entry.dev === true) problems.push(`${at}: a dev dependency was installed`);
    for (const field of ["version", "resolved", "integrity"]) {
      if (got[field] !== entry[field])
        problems.push(
          `${at}: ${field} ${JSON.stringify(got[field])} is not the lockfile's ${JSON.stringify(entry[field])}`,
        );
    }
  }
  for (const [at, entry] of Object.entries(want)) {
    if (!at.startsWith("node_modules/")) continue;
    if (entry.dev === true || entry.optional === true || entry.devOptional === true) continue;
    if (!Object.hasOwn(have, at))
      problems.push(`${at}: in the lockfile's runtime tree, not installed`);
  }
  return problems;
}

/**
 * Every package npm says it installed is on disk at that version.
 * @param {string} dir the unpacked package
 * @param {unknown} installed npm's hidden lockfile; null when nothing was installed
 * @returns {string[]}
 */
export function onDiskProblems(dir, installed) {
  if (installed === null) return [];
  /** @type {string[]} */
  const problems = [];
  for (const [at, got] of Object.entries(packagesOf(installed, HIDDEN_LOCK))) {
    const file = path.join(dir, at, "package.json");
    let version;
    try {
      const m = readJson(file);
      version = isRecord(m) ? m.version : undefined;
    } catch {
      version = undefined;
    }
    if (version !== got.version)
      problems.push(
        `${at}: npm recorded ${String(got.version)}, but ${existsSync(file) ? `its package.json says ${String(version)}` : "it is not on disk"}`,
      );
  }
  return problems;
}

/**
 * The package's bins as name → path (package.json `bin`, string or object form).
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, string>}
 */
export function binsOf(manifest) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof manifest.bin === "string")
    out[String(manifest.name).split("/").at(-1) ?? ""] = manifest.bin;
  else if (isRecord(manifest.bin))
    for (const [k, v] of Object.entries(manifest.bin)) if (typeof v === "string") out[k] = v;
  return out;
}

/** @param {string} s */
const tail = (s) => s.trim().slice(-800);

/** @param {string} file @returns {Buffer | null} */
const bytesOrNull = (file) => (existsSync(file) ? readFileSync(file) : null);

/** Both absent, or the same bytes. @param {Buffer | null} a @param {Buffer | null} b */
const sameBytes = (a, b) => (a === null || b === null ? a === b : a.equals(b));

/** Both exist and resolve to the same real path. @param {string} a @param {string} b */
const sameTarget = (a, b) => existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);

/**
 * Unpack, install locked, link and run, inside `work`; every problem found (empty = all hold).
 * @param {string} work an empty scratch directory
 * @param {{ tarball: string, lock: string, allowlist: string }} opts
 * @returns {{ problems: string[], installedCount: number }}
 */
export function checkReleaseInstall(work, { tarball, lock, allowlist }) {
  const fail = (/** @type {string} */ p) => ({ problems: [p], installedCount: 0 });
  const t = spawnSync("tar", ["-xzf", tarball, "-C", work], { encoding: "utf8" });
  if (t.error !== undefined || t.status !== 0)
    return fail(`tar could not unpack ${tarball}: ${tail(t.error?.message ?? t.stderr)}`);
  const dir = path.join(work, "package");
  const manifest = readJson(path.join(dir, "package.json"));
  if (!isRecord(manifest)) return fail("the tarball's package.json is not an object");

  // 1. the lock it carries
  const sw = bytesOrNull(path.join(dir, SHRINKWRAP));
  if (sw === null)
    return fail(`the tarball carries no ${SHRINKWRAP}: its install would not be locked`);
  if (!sw.equals(readFileSync(lock)))
    return fail(`the tarball's ${SHRINKWRAP} is not ${lock}, byte for byte`);

  // 2. the README's locked install
  const ci = runNpm([...LOCKED_INSTALL, ...OFFLINE], dir);
  if (ci.status !== 0)
    return fail(
      `npm ${LOCKED_INSTALL.join(" ")} failed in the unpacked tarball (exit ${String(ci.status)}): ${tail(ci.stderr)}`,
    );
  const hiddenFile = path.join(dir, HIDDEN_LOCK);
  const hidden = bytesOrNull(hiddenFile);
  /** @type {unknown} */
  const installed = hidden === null ? null : JSON.parse(hidden.toString("utf8"));
  /** @type {string[]} */
  const problems = [
    ...lockedTreeProblems(readJson(lock), installed),
    ...onDiskProblems(dir, installed),
  ];
  const tree = runtimeTree(dir);
  for (const p of tree.problems) problems.push(`npm ls: ${p}`);
  problems.push(...compareTree(tree.nodes.keys(), parseAllowlist(readJson(allowlist))));
  const installedCount =
    installed === null ? 0 : Object.keys(packagesOf(installed, HIDDEN_LOCK)).length;

  // 3. the README's PATH step, under a throwaway global prefix
  const bins = binsOf(manifest);
  if (Object.keys(bins).length === 0) {
    problems.push("the package declares no bin: the link would put nothing on PATH");
    return { problems, installedCount };
  }
  const prefix = path.join(work, "global");
  mkdirSync(prefix);
  const link = runNpm([...LINK, ...OFFLINE], dir, { npm_config_prefix: prefix });
  if (link.status !== 0) {
    problems.push(
      `npm ${LINK.join(" ")} failed (exit ${String(link.status)}): ${tail(link.stderr)}`,
    );
    return { problems, installedCount };
  }
  if (!sameBytes(hidden, bytesOrNull(hiddenFile)))
    problems.push(`npm ${LINK.join(" ")} changed the installed tree (it must install nothing)`);
  const name = String(manifest.name);
  const globalModules = path.join(prefix, "lib", "node_modules");
  const added = existsSync(globalModules)
    ? readdirSync(globalModules).filter((e) => !e.startsWith("."))
    : [];
  if (added.join("\n") !== name.split("/")[0])
    problems.push(
      `npm ${LINK.join(" ")} added ${JSON.stringify(added)} globally, not just ${name}`,
    );
  if (!sameTarget(path.join(globalModules, name), dir))
    problems.push(`the global ${name} is not a link to the unpacked folder`);

  // 4. each linked bin starts and reports this version
  for (const [bin, rel] of Object.entries(bins)) {
    const linked = path.join(prefix, "bin", bin);
    if (!sameTarget(linked, path.join(dir, rel))) {
      problems.push(`bin ${bin} is not linked to ${rel} in the unpacked folder`);
      continue;
    }
    const home = path.join(work, "home");
    mkdirSync(home, { recursive: true });
    const run = spawnSync(process.execPath, [linked, ...VERSION_ARGS], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 60_000,
    });
    /** @type {unknown} */
    let reported;
    try {
      reported = JSON.parse(run.stdout);
    } catch {
      reported = undefined;
    }
    if (run.status !== 0 || !isRecord(reported) || reported.version !== manifest.version)
      problems.push(
        `${bin} ${VERSION_ARGS.join(" ")} did not report ${String(manifest.version)} (exit ${String(run.status)}): ${tail(run.stderr || run.stdout)}`,
      );
  }
  return { problems, installedCount };
}

/**
 * @param {{ tarball: string, lock: string, allowlist: string }} opts
 * @returns {number} exit code
 */
export function main(opts) {
  const r = reporter("check-release-install");
  if (!existsSync(opts.tarball)) throw new Error(`no tarball at ${opts.tarball}`);
  const work = realpathSync(
    mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "eff-release-")),
  );
  try {
    const { problems, installedCount } = checkReleaseInstall(work, opts);
    for (const p of problems) r.error(p);
    return r.finish(
      `${path.basename(opts.tarball)}: \`npm ${LOCKED_INSTALL.join(" ")}\` installed the lockfile's runtime tree (${String(installedCount)} package(s)) offline; \`npm ${LINK.join(" ")}\` linked the bin, which runs`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (typeof args.tarball !== "string") throw new Error("--tarball <file.tgz> is required");
    process.exitCode = main({
      tarball: path.resolve(args.tarball),
      lock:
        typeof args.lock === "string"
          ? path.resolve(args.lock)
          : path.join(REPO_ROOT, "package-lock.json"),
      allowlist:
        typeof args.allowlist === "string"
          ? path.resolve(args.allowlist)
          : path.join(REPO_ROOT, "scripts", "ci", "runtime-allowlist.json"),
    });
  } catch (e) {
    process.stderr.write(`check-release-install: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
