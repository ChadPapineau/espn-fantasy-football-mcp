// @ts-check
// check-skills-structure.mjs — the zero-token structural gate for the plugin root and the Skills
// bundle (plan 04 §4.2 `skills`, plan 09 §4 / §5.1 items 1–6 subset, K8; plan 10 §3.0 Z6). It passes
// on zero Skills. The full Lane 1 (build-skills drift, guardrail sentences, tool names against
// tools/list, disallowed-tools strings) is scripts/build-skills.ts + scripts/check-skills.ts, owned
// by the Skills stage; `claude plugin validate --strict` runs beside this in docs.yml.
// Node built-ins only.
//
// Plugin root: .claude-plugin/plugin.json (name "espn-fantasy-football" = the client config key,
// version = package.json), marketplace.json (the repo is its own marketplace, source "./"), .mcp.json
// (one server, command "/bin/sh", args [${CLAUDE_PLUGIN_ROOT}/scripts/eff-launch.sh, serve], env
// values ONLY ${user_config.<declared key>} references — no literal, no secret, no absolute user
// path, never EFF_CONFIG_DIR/EFF_CACHE_DIR), scripts/eff-launch.sh present, no bin/ directory.
// Skills: every skills/<dir>/SKILL.md has frontmatter `name` = <dir> ([a-z0-9-]+) and a
// `description` of 1–350 characters; no file under skills/ over 200 KB; no espn_prepare_* /
// espn_commit_* reference outside skills/apply/.
//
// Usage: node scripts/ci/check-skills-structure.mjs [--root <dir>]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, isMain, isRecord, parseArgs, readJson, reporter } from "./_lib.mjs";

export const PLUGIN_NAME = "espn-fantasy-football";
export const MARKETPLACE_NAME = "espn-fantasy-football-mcp";
export const LAUNCH_ARGS = Object.freeze(["${CLAUDE_PLUGIN_ROOT}/scripts/eff-launch.sh", "serve"]);
/** Env keys the plugin's .mcp.json may set (non-secret server settings only — plan 03 §3). */
export const ALLOWED_ENV = Object.freeze([
  "ESPN_LEAGUE_ID",
  "ESPN_SEASON",
  "EFF_LOG_LEVEL",
  "EFF_TOOLSET",
]);
export const MAX_DESCRIPTION = 350;
export const MAX_SKILL_FILE_BYTES = 200 * 1024;

/**
 * Every string inside a JSON value, depth-first.
 * @param {unknown} v
 * @returns {string[]}
 */
function strings(v) {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (isRecord(v)) return [...Object.keys(v), ...Object.values(v).flatMap(strings)];
  return [];
}

/**
 * @param {string} root
 * @returns {string[]} errors
 */
export function checkPlugin(root) {
  /** @type {string[]} */
  const errors = [];
  /** @param {string} rel */
  const load = (rel) => {
    try {
      return readJson(path.join(root, rel));
    } catch (e) {
      errors.push(e instanceof Error ? e.message.replace(root + path.sep, "") : String(e));
      return undefined;
    }
  };
  const pkg = load("package.json");
  const version = isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : null;
  const plugin = load(".claude-plugin/plugin.json");
  /** @type {string[]} */
  let userKeys = [];
  if (plugin !== undefined) {
    if (!isRecord(plugin)) errors.push(".claude-plugin/plugin.json is not an object");
    else {
      if (plugin.name !== PLUGIN_NAME)
        errors.push(`plugin.json name must be "${PLUGIN_NAME}" (the client config key)`);
      if (plugin.version !== version)
        errors.push("plugin.json version must equal package.json version (plan 09 K6)");
      if (typeof plugin.description !== "string" || !plugin.description.trim())
        errors.push("plugin.json needs a description");
      if (plugin.userConfig !== undefined) {
        if (!isRecord(plugin.userConfig)) errors.push("plugin.json userConfig must be an object");
        else {
          userKeys = Object.keys(plugin.userConfig);
          for (const [k, spec] of Object.entries(plugin.userConfig)) {
            if (!/^[a-z][a-z0-9_]*$/.test(k))
              errors.push(`userConfig key ${JSON.stringify(k)} is not snake_case`);
            if (isRecord(spec) && spec.sensitive === true)
              errors.push(
                `userConfig.${k}: sensitive values do not belong in this plugin (cookies are entered with \`eff setup\` only)`,
              );
          }
        }
      }
    }
  }
  const market = load(".claude-plugin/marketplace.json");
  if (market !== undefined) {
    if (!isRecord(market)) errors.push(".claude-plugin/marketplace.json is not an object");
    else {
      if (market.name !== MARKETPLACE_NAME)
        errors.push(`marketplace.json name must be "${MARKETPLACE_NAME}"`);
      const plugins = Array.isArray(market.plugins) ? market.plugins : [];
      if (plugins.length !== 1) errors.push("marketplace.json must list exactly one plugin");
      const entry = plugins[0];
      if (
        plugins.length === 1 &&
        (!isRecord(entry) || entry.name !== PLUGIN_NAME || entry.source !== "./")
      ) {
        errors.push(
          `marketplace.json's plugin must be { name: "${PLUGIN_NAME}", source: "./" } (the repo is its own marketplace)`,
        );
      }
      if (isRecord(entry) && entry.version !== undefined && entry.version !== version) {
        errors.push("marketplace.json plugin version must equal package.json version");
      }
    }
  }
  const mcp = load(".mcp.json");
  if (mcp !== undefined) {
    const servers = isRecord(mcp) && isRecord(mcp.mcpServers) ? mcp.mcpServers : null;
    if (servers === null) errors.push(".mcp.json must have an mcpServers object");
    else {
      const names = Object.keys(servers);
      if (names.length !== 1 || names[0] !== PLUGIN_NAME)
        errors.push(`.mcp.json must declare exactly the "${PLUGIN_NAME}" server`);
      const s = servers[PLUGIN_NAME];
      if (isRecord(s)) {
        if (s.command !== "/bin/sh")
          errors.push(
            '.mcp.json command must be "/bin/sh" (absolute on every macOS, needs no PATH)',
          );
        if (JSON.stringify(s.args) !== JSON.stringify(LAUNCH_ARGS))
          errors.push(`.mcp.json args must be ${JSON.stringify(LAUNCH_ARGS)}`);
        const env = s.env === undefined ? {} : s.env;
        if (!isRecord(env)) errors.push(".mcp.json env must be an object");
        else {
          for (const [k, v] of Object.entries(env)) {
            if (k === "EFF_CONFIG_DIR" || k === "EFF_CACHE_DIR") {
              errors.push(
                `.mcp.json must not set ${k}: a plugin install uses the one shared default location (plan 09 §4)`,
              );
            } else if (!ALLOWED_ENV.includes(k)) {
              errors.push(
                `.mcp.json env key ${k} is not an allowed server setting (${ALLOWED_ENV.join(", ")})`,
              );
            }
            const ref =
              typeof v === "string" ? /^\$\{user_config\.([a-z][a-z0-9_]*)\}$/.exec(v) : null;
            if (!ref)
              errors.push(
                `.mcp.json env ${k} must be a \${user_config.<key>} reference, never a literal value`,
              );
            else if (!userKeys.includes(ref[1] ?? ""))
              errors.push(
                `.mcp.json env ${k} references undeclared userConfig key ${ref[1] ?? ""}`,
              );
          }
        }
        for (const extra of Object.keys(s)) {
          if (!["command", "args", "env"].includes(extra))
            errors.push(`.mcp.json server has an unexpected field ${extra}`);
        }
      }
      for (const str of strings(mcp)) {
        if (str.startsWith("/") && str !== "/bin/sh")
          errors.push(`.mcp.json carries an absolute path (${str.slice(0, 40)}) — variables only`);
      }
    }
  }
  const shim = path.join(root, "scripts", "eff-launch.sh");
  if (!existsSync(shim)) errors.push("scripts/eff-launch.sh is missing");
  else if (!readFileSync(shim, "utf8").startsWith("#!/bin/sh\n"))
    errors.push("scripts/eff-launch.sh must start with #!/bin/sh");
  if (existsSync(path.join(root, "bin")))
    errors.push("no bin/ directory may exist at the plugin root (ADV OBJ-23)");
  return errors;
}

/**
 * Minimal frontmatter reader: top-level `key: value` lines between the opening and closing `---`;
 * quoted values are unquoted; `>`/`|` block scalars are folded from their indented lines.
 * @param {string} text
 * @returns {Record<string, string> | null} null when there is no frontmatter
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const key = m[1] ?? "";
    let value = (m[2] ?? "").trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < end && /^\s+\S|^\s*$/.test(lines[i + 1] ?? ""))
        block.push((lines[++i] ?? "").trim());
      value = block.filter(Boolean).join(value.startsWith(">") ? " " : "\n");
    } else if (/^"(?:[^"\\]|\\.)*"$/.test(value) || /^'(?:[^']|'')*'$/.test(value)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {string[]} every file under dir (relative, POSIX)
 */
function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d @param {string} rel */
  const go = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) go(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  go(dir, "");
  return out.sort();
}

/**
 * @param {string} root
 * @returns {{ count: number, errors: string[] }}
 */
export function checkSkills(root) {
  /** @type {string[]} */
  const errors = [];
  const skillsDir = path.join(root, "skills");
  if (!existsSync(skillsDir)) return { count: 0, errors };
  let count = 0;
  for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === "_shared" || e.name.startsWith(".")) continue;
    const file = path.join(skillsDir, e.name, "SKILL.md");
    if (!existsSync(file)) {
      errors.push(`skills/${e.name}/ has no SKILL.md`);
      continue;
    }
    count++;
    const fm = parseFrontmatter(readFileSync(file, "utf8"));
    if (fm === null) {
      errors.push(`skills/${e.name}/SKILL.md has no frontmatter`);
      continue;
    }
    if (!/^[a-z0-9-]+$/.test(e.name))
      errors.push(`skills/${e.name}: directory name must match [a-z0-9-]+`);
    if (fm.name !== e.name)
      errors.push(`skills/${e.name}/SKILL.md: frontmatter name must equal the directory name`);
    const d = fm.description ?? "";
    if (!d.trim()) errors.push(`skills/${e.name}/SKILL.md: description is missing`);
    else if ([...d].length > MAX_DESCRIPTION)
      errors.push(
        `skills/${e.name}/SKILL.md: description is over ${String(MAX_DESCRIPTION)} characters`,
      );
  }
  for (const rel of walkFiles(skillsDir)) {
    const full = path.join(skillsDir, rel);
    if (statSync(full).size > MAX_SKILL_FILE_BYTES) errors.push(`skills/${rel} is over 200 KB`);
    if (!rel.startsWith("apply/") && /\.(md|json|txt|ya?ml)$/i.test(rel)) {
      if (/\bespn_(?:prepare|commit)_/.test(readFileSync(full, "utf8"))) {
        errors.push(
          `skills/${rel} references espn_prepare_*/espn_commit_* — only skills/apply/ may (plan 09 K4)`,
        );
      }
    }
  }
  return { count, errors };
}

/**
 * @param {string} root
 * @returns {number} exit code
 */
export function main(root) {
  const r = reporter("check-skills-structure");
  checkPlugin(root).forEach(r.error);
  const skills = checkSkills(root);
  skills.errors.forEach(r.error);
  if (skills.count === 0)
    r.warn("0 Skills present — the Skills checks are vacuous until the Skills stage lands");
  return r.finish(`plugin root valid; ${String(skills.count)} Skill(s) structurally valid`);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? path.resolve(args.root) : REPO_ROOT;
  try {
    process.exitCode = main(root);
  } catch (e) {
    process.stderr.write(`check-skills-structure: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
