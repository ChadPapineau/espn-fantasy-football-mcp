// @ts-check
// _lib.mjs — shared helpers for the zero-dependency supply-chain checks in scripts/ci/ (plan 04
// §4.1 `supply-chain`, R11; plan 02 §7). Ported from sibling @d72e03b, adapted: unmet OPTIONAL
// dependencies (the eleven @napi-rs/keyring platform packages for other platforms) are recorded,
// not treated as missing, and a package path npm masked as `***` is unmasked (manifestDir). Node
// built-ins only.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repository root (scripts/ci/ is two levels down). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The only registry any runtime package may come from. */
export const REGISTRY = "https://registry.npmjs.org/";

/**
 * True when the module at `metaUrl` is the process entry point.
 * @param {string} metaUrl
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

/**
 * Parse `--flag value` pairs and bare `--switch`es.
 * @param {string[]} argv
 * @returns {Record<string, string | true>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/**
 * Read and parse a JSON file; the error names the file.
 * @param {string} file
 * @returns {unknown}
 */
export function readJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The log level every npm these checks run reports at, whatever the caller's environment says. A
 * check launched from `npm run -s …` (or `--silent`, or `--loglevel silent`) inherits
 * `npm_config_loglevel=silent`, and a nested npm then exits 1 with nothing on stderr: the release
 * check's "npm ci … failed" carried no reason (no EINTEGRITY), and its test failed when the full
 * suite ran under a silent npm script while it passed alone (the round-4b Skills account's
 * "EINTEGRITY under load"). `warn` prints every error and warning npm has, without its notices.
 */
export const NPM_LOGLEVEL = "warn";

/**
 * Run npm with an argument array (never a shell string) and return its output. npm ls exits 1 when
 * the tree has problems but still prints JSON; the caller inspects `problems`. The log level is
 * pinned (NPM_LOGLEVEL), so a failure always says why.
 * @param {readonly string[]} args
 * @param {string} cwd
 * @param {Readonly<Record<string, string>>} [env] extra environment (e.g. a throwaway npm_config_prefix)
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runNpm(args, cwd, env = {}) {
  const r = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      ...env,
      npm_config_loglevel: NPM_LOGLEVEL,
    },
  });
  if (r.error) throw new Error(`npm ${args.join(" ")} failed to start: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * @typedef {{ name: string, version: string, path?: string, resolved?: string, optional?: boolean }} TreeNode
 * @typedef {{ nodes: Map<string, TreeNode>, problems: string[], unmetOptional: string[] }} RuntimeTree
 */

/**
 * Flatten `npm ls --omit=dev --all --json --long` output into unique name@version nodes. Deduped
 * references carry no `path`; another occurrence of the same name@version does. An entry with no
 * version is an unmet OPTIONAL dependency (npm prints `{}` for a platform package of another OS)
 * only when its parent declares it in `optionalDependencies`; otherwise it is a problem.
 * @param {unknown} ls
 * @returns {RuntimeTree}
 */
export function flattenTree(ls) {
  if (!isRecord(ls)) throw new Error("npm ls output is not a JSON object");
  /** @type {Map<string, TreeNode>} */
  const nodes = new Map();
  /** @type {string[]} */
  const problems = [];
  /** @type {Set<string>} */
  const unmet = new Set();
  if (Array.isArray(ls.problems)) for (const p of ls.problems) problems.push(String(p));

  /**
   * @param {unknown} deps
   * @param {Record<string, unknown>} parent
   * @param {number} depth
   */
  const walk = (deps, parent, depth) => {
    if (!isRecord(deps)) return;
    if (depth > 200) throw new Error("npm ls tree deeper than 200 levels — refusing");
    const optional = isRecord(parent.optionalDependencies) ? parent.optionalDependencies : {};
    for (const [name, raw] of Object.entries(deps)) {
      if (!isRecord(raw)) continue;
      if (raw.missing === true) problems.push(`missing: ${name}`);
      if (raw.invalid === true) problems.push(`invalid: ${name}`);
      if (raw.extraneous === true) problems.push(`extraneous: ${name}`);
      const version = typeof raw.version === "string" ? raw.version : "";
      if (!version) {
        if (raw.missing !== true && Object.hasOwn(optional, name)) unmet.add(name);
        else if (raw.missing !== true) problems.push(`no version for ${name}`);
        continue;
      }
      const key = `${name}@${version}`;
      const prev = nodes.get(key);
      /** @type {TreeNode} */
      const node = prev ?? { name, version };
      if (typeof raw.path === "string" && node.path === undefined) node.path = raw.path;
      if (typeof raw.resolved === "string" && node.resolved === undefined)
        node.resolved = raw.resolved;
      if (raw.optional === true) node.optional = true;
      nodes.set(key, node);
      walk(raw.dependencies, raw, depth + 1);
    }
  };
  walk(ls.dependencies, ls, 0);
  return { nodes, problems, unmetOptional: [...unmet].sort() };
}

/**
 * The runtime (production) dependency tree of the project at `root`.
 * @param {string} root
 * @returns {RuntimeTree}
 */
export function runtimeTree(root) {
  const r = runNpm(["ls", "--omit=dev", "--all", "--json", "--long"], root);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `npm ls did not print JSON (exit ${String(r.status)}): ${r.stderr.slice(0, 500)}`,
    );
  }
  return flattenTree(parsed);
}

/** What npm's output redaction (`@npmcli/redact`) prints in place of a UUID-shaped run of text. */
export const NPM_MASK = "***";

/** @param {string} s */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param {string} p */
const segments = (p) => p.split(/[\\/]/).filter((s) => s !== "");

/**
 * The real path behind a package path `npm ls` printed masked, or null when it cannot be matched
 * to `root`. `npm ls --long`, run in `root`, reports each installed package's absolute path, but
 * npm masks any UUID-shaped run in its output as `***` — a checkout under a session directory
 * reports a path that does not exist (2026-11-04 dependency-review finding RG-4). A UUID holds no
 * separator, so the masked path keeps the real path's segments: each of `root`'s segments must
 * match (a `***` stands for one or more characters inside its segment), and the rest —
 * `node_modules/…/<name>`, with no mask and no `..` — is joined under `root`.
 * @param {string} reported
 * @param {string} root
 * @returns {string | null}
 */
export function unmaskPath(reported, root) {
  let real = path.resolve(root);
  try {
    real = realpathSync(real);
  } catch {
    // a root that does not exist keeps its resolved spelling; the readers then report ENOENT
  }
  const want = segments(real);
  const got = segments(reported);
  if (got.length <= want.length) return null;
  for (const [i, w] of want.entries()) {
    const g = got[i] ?? "";
    if (g === w) continue;
    if (!g.includes(NPM_MASK)) return null;
    const pattern = new RegExp(`^${g.split(NPM_MASK).map(escapeRegExp).join(".+")}$`, "s");
    if (!pattern.test(w)) return null;
  }
  const rest = got.slice(want.length);
  if (rest[0] !== "node_modules" || rest.some((s) => s.includes(NPM_MASK) || s === ".."))
    return null;
  return path.join(root, ...rest);
}

/**
 * Where a node's installed package.json lives: the path `npm ls` reported, unmasked when npm
 * masked it (`unmaskPath`); the hoisted `root/node_modules/<name>` only when it reported none.
 * A masked path that does not rebuild under `root` throws, so the check reports that package:
 * the hoisted copy of the same name may be another version (a nested package's own copy) and
 * reading it would check the wrong manifest (the follow-up verifier's F2).
 * @param {TreeNode} node
 * @param {string} root
 */
export function manifestDir(node, root) {
  if (node.path === undefined) return path.join(root, "node_modules", node.name);
  if (!node.path.includes(NPM_MASK)) return node.path;
  const real = unmaskPath(node.path, root);
  if (real === null)
    throw new Error(
      `npm masked the path it reported (${node.path}) and it does not rebuild under the root`,
    );
  return real;
}

/**
 * Fail/warn reporter shared by every check.
 * @param {string} tool
 */
export function reporter(tool) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  return {
    errors,
    warnings,
    /** @param {string} m */
    error: (m) => errors.push(m),
    /** @param {string} m */
    warn: (m) => warnings.push(m),
    /** @param {string} okMessage @returns {number} */
    finish(okMessage) {
      for (const w of warnings) process.stderr.write(`${tool}: warning: ${w}\n`);
      if (errors.length) {
        process.stderr.write(`${tool}: FAILED (${String(errors.length)})\n`);
        for (const e of errors) process.stderr.write(`  - ${e}\n`);
        return 1;
      }
      process.stdout.write(`${tool}: ok — ${okMessage}\n`);
      return 0;
    },
  };
}
