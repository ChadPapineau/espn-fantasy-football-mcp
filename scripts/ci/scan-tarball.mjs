// @ts-check
// scan-tarball.mjs — what `npm pack` would ship must be exactly the package.json `files` (plus what
// npm always adds) and nothing sensitive (plan 04 §2, §4.1 `pack`, §4.4, R8): no fixtures/, tests/,
// .env*, .npmrc, databases, key/token/cookie/session files, no YAML outside skills/; the plugin root
// files (plan 09 §4, K8) must be present; then every packed text file goes through
// scripts/dev/scan-secrets.mjs (secrets, ESPN cookies, GUIDs, league ids, IPs, home paths, emails,
// and the local deny-list when present). Ported from sibling @d72e03b, adapted. Node built-ins only.
//
// --release (release.yml, and ci.yml's rehearsal of it; Stage C finding ci-release-workflow-missing):
// the tarball must also carry its lock — npm-shrinkwrap.json packed, byte for byte the committed
// package-lock.json, its root this package at this version — because the README's release install
// (`npm ci --omit=dev --ignore-scripts` in the unpacked package) installs from that file alone.
//
// Usage: node scripts/ci/scan-tarball.mjs [--root <dir>] [--release]   (run `npm run build` first)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, isMain, isRecord, parseArgs, readJson, reporter, runNpm } from "./_lib.mjs";

/**
 * Files npm always adds regardless of `files`. npm-shrinkwrap.json is not one of them: with a
 * `files` allow-list npm 11 packs it only when `files` names it (package.json does), exactly as it
 * never packs package-lock.json at all — so a release tarball carries its lock only through `files`.
 */
const ALWAYS = new Set(["package.json", "README.md", "LICENSE", "LICENCE"]);

/** The lock a release tarball carries (npm reads it as the package's lockfile). */
export const SHRINKWRAP = "npm-shrinkwrap.json";
/** The committed lockfile the release tarball's lock must be, byte for byte. */
export const LOCKFILE = "package-lock.json";

/** @type {readonly { re: RegExp, why: string }[]} */
export const FORBIDDEN = Object.freeze([
  { re: /(^|\/)fixtures\//, why: "fixtures never ship" },
  { re: /(^|\/)tests?\//, why: "tests never ship" },
  { re: /(^|\/)\.env(\.|$)/, why: "env file" },
  { re: /(^|\/)\.npmrc$/, why: ".npmrc" },
  { re: /\.(sqlite|sqlite3|db)(-journal|-wal|-shm)?$/i, why: "database file" },
  {
    re: /\.(pem|key|p12|pfx|jks|keystore|token|secret|secrets|har)$/i,
    why: "key/token/capture file",
  },
  { re: /(^|\/)(credentials|secrets)\.[^/]*$/i, why: "credentials file" },
  { re: /(token|oauth|session)[^/]*\.json$/i, why: "token/session json" },
  { re: /cookie/i, why: "cookie file" },
  { re: /(^|\/)(espn_s2|swid)[^/]*$/i, why: "ESPN credential file" },
  { re: /\.tgz$/i, why: "nested tarball" },
  { re: /(^|\/)\.git(\/|$)/, why: "git metadata" },
]);

/**
 * The plugin root files a tarball install needs to also be a plugin root (plan 04 §2 T-01; plan 09
 * §4, K8): their absence is an error.
 * @type {readonly string[]}
 */
export const REQUIRED = Object.freeze([
  "scripts/eff-launch.sh",
  ".mcp.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
]);

/**
 * @param {string} file packed path, POSIX, relative to the package root
 * @param {readonly string[]} filesGlobs package.json `files`
 * @returns {string | null} why it is not allowed, or null
 */
export function classify(file, filesGlobs) {
  if (file.startsWith("/") || file.split("/").includes("..")) return "path escapes the package";
  for (const f of FORBIDDEN) if (f.re.test(file)) return f.why;
  if (/\.ya?ml$/i.test(file) && !file.startsWith("skills/")) return "*.yaml outside skills/";
  if (ALWAYS.has(file)) return null;
  const covers = (/** @type {string} */ g) => {
    const clean = g.replace(/^\.\//, "").replace(/\/+$/, "");
    return file === clean || file.startsWith(`${clean}/`);
  };
  // a negated entry ("!dist/plugin-evals") excludes what it names: generated local outputs under
  // dist/ (the plugin-eval suite, the Skills copy tree) must never ship even when present
  if (filesGlobs.some((g) => g.startsWith("!") && covers(g.slice(1))))
    return "excluded by a package.json `files` negation";
  const inFiles = filesGlobs.some((g) => !g.startsWith("!") && covers(g));
  return inFiles ? null : "not covered by package.json `files`";
}

/**
 * @param {unknown} packJson output of `npm pack --dry-run --json`
 * @returns {string[]} the packed paths
 */
export function packedPaths(packJson) {
  if (!Array.isArray(packJson) || packJson.length !== 1 || !isRecord(packJson[0])) {
    throw new Error("npm pack --json did not describe exactly one package");
  }
  const files = packJson[0].files;
  if (!Array.isArray(files)) throw new Error("npm pack --json has no `files` list");
  return files.map((f) => {
    if (!isRecord(f) || typeof f.path !== "string") throw new Error("malformed file entry");
    return f.path;
  });
}

/**
 * What is wrong with a release tarball's lock (plan 04 §4.4; plan 02 §7.1 "Lockfile": the integrity
 * hashes are the provenance): npm-shrinkwrap.json must be packed, be the committed package-lock.json
 * byte for byte (release.yml copies it, so the release installs exactly the tree CI installed and
 * tested), and name this package at this version at its root.
 * @param {string} root the package root
 * @param {readonly string[]} packed what `npm pack` would ship
 * @param {Record<string, unknown>} manifest the root's package.json
 * @returns {string[]} problems (empty = the tarball carries its lock)
 */
export function releaseLockProblems(root, packed, manifest) {
  /** @type {string[]} */
  const problems = [];
  if (!packed.includes(SHRINKWRAP))
    problems.push(
      `${SHRINKWRAP} is not packed — a release tarball carries the committed lockfile as ${SHRINKWRAP} (package.json \`files\` must name it, and it must exist when npm packs)`,
    );
  const sw = path.join(root, SHRINKWRAP);
  const lock = path.join(root, LOCKFILE);
  if (!existsSync(sw)) {
    problems.push(`${SHRINKWRAP} does not exist — copy ${LOCKFILE} to it before packing`);
    return problems;
  }
  if (!existsSync(lock)) {
    problems.push(`${LOCKFILE} does not exist — ${SHRINKWRAP} cannot be checked against it`);
    return problems;
  }
  if (!readFileSync(sw).equals(readFileSync(lock)))
    problems.push(`${SHRINKWRAP} is not the committed ${LOCKFILE}, byte for byte`);
  const parsed = readJson(sw);
  const rootEntry = isRecord(parsed) && isRecord(parsed.packages) ? parsed.packages[""] : undefined;
  /** @param {unknown} entry */
  const names = (entry) =>
    isRecord(entry) && entry.name === manifest.name && entry.version === manifest.version;
  if (!names(parsed) || !names(rootEntry))
    problems.push(
      `${SHRINKWRAP} does not name ${String(manifest.name)}@${String(manifest.version)} at its top level and in packages[""] (regenerate the lockfile after the version bump)`,
    );
  return problems;
}

/**
 * @param {string} root
 * @param {{ required?: readonly string[], release?: boolean }} [opts]
 * @returns {number} exit code
 */
export function main(root, opts = {}) {
  const r = reporter("scan-tarball");
  const manifest = readJson(path.join(root, "package.json"));
  if (!isRecord(manifest) || !Array.isArray(manifest.files)) {
    throw new Error("package.json must declare a `files` allow-list");
  }
  const globs = manifest.files.filter((x) => typeof x === "string");
  const pack = runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], root);
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr.slice(0, 500)}`);
  const files = packedPaths(JSON.parse(pack.stdout));
  for (const f of files) {
    const why = classify(f, globs);
    if (why) r.error(`${f}: ${why}`);
  }
  if (!files.some((f) => f.startsWith("dist/")))
    r.error("no dist/ files packed — run `npm run build` first");
  for (const req of opts.required ?? REQUIRED) {
    if (!files.includes(req))
      r.error(`${req} is not packed (a tarball install must also be a plugin root)`);
  }
  if (opts.release === true) for (const p of releaseLockProblems(root, files, manifest)) r.error(p);
  const bin = isRecord(manifest.bin) ? Object.values(manifest.bin) : [];
  for (const b of bin) {
    if (typeof b !== "string") continue;
    const target = b.replace(/^\.\//, "");
    if (files.includes(target)) continue;
    // the entry point lands in a later stage; once its source exists, a missing bin is an error
    if (existsSync(path.join(root, "src", "cli.ts"))) r.error(`bin target ${target} is not packed`);
    else r.warn(`bin target ${target} is not packed yet (src/cli.ts does not exist)`);
  }
  // the scanner is this repository's, whatever --root points at
  const scanner = path.join(REPO_ROOT, "scripts", "dev", "scan-secrets.mjs");
  if (!existsSync(scanner)) {
    r.error("scripts/dev/scan-secrets.mjs is missing — cannot scan the packed files");
  } else if (files.length) {
    const s = spawnSync(process.execPath, [scanner, "--", ...files], {
      cwd: root,
      encoding: "utf8",
    });
    if (s.status !== 0) r.error(`scan-secrets found problems in packed files:\n${s.stderr.trim()}`);
  }
  return r.finish(
    `${String(files.length)} packed file(s), all within \`files\` and clean${opts.release === true ? `; ${SHRINKWRAP} is the committed ${LOCKFILE}` : ""}`,
  );
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? path.resolve(args.root) : REPO_ROOT;
  try {
    process.exitCode = main(root, { release: args.release === true });
  } catch (e) {
    process.stderr.write(`scan-tarball: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
