// plugin-install-docs.test.ts — the documented plugin install gives a working server, registered once
// per client (Stage C finding plugin-marketplace-install-no-dist; plan 09 §4, §6; plan 03 §4; plan 10
// A15b). The plugin's one server is `/bin/sh ${CLAUDE_PLUGIN_ROOT}/scripts/eff-launch.sh serve`, and
// the shim execs `<root>/dist/cli.js` — a build output git never carries. A plugin installed from a
// git source (the GitHub `<owner>/<repo>` shorthand, a git URL) is that tree: Claude Code 2.1.238
// runs `npm ci --ignore-scripts` in its cache copy but builds nothing, so the server exits in every
// session. A marketplace added from the BUILT clone (a local directory) is copied into the cache with
// its dist/, and the server starts (checked by hand against the real CLI: README Quickstart step 5).
// And the plugin registers the server itself: a `claude mcp add` entry beside it (what `eff
// print-config --client code` prints) starts a second server and lists every tool twice, so every
// other Claude Code route the docs offer is offered instead of the plugin, never beside it.
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  commands,
  fences,
  readDoc,
  runnable,
  section,
  words,
  type DocCommand,
} from "./docs-helpers.js";
import { ROOT } from "./helpers.js";

interface McpJson {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}
const mcp = JSON.parse(readDoc(".mcp.json")) as McpJson;
const plugin = JSON.parse(readDoc(".claude-plugin/plugin.json")) as {
  name: string;
  userConfig?: Record<string, unknown>;
};
const market = JSON.parse(readDoc(".claude-plugin/marketplace.json")) as {
  name: string;
  plugins: { name: string; source: string }[];
};
/** `<plugin>@<marketplace>`, the id every documented `claude plugin` command names. */
const ID = `${plugin.name}@${market.name}`;
const README = readDoc("README.md");
/** The documents that tell a reader how to install the plugin. */
const INSTALL_DOCS = ["README.md", "skills/README.md"] as const;

/** A `claude plugin marketplace add` source that is a git repository, not a directory on disk. */
function isGitSource(src: string): boolean {
  return (
    /^(?:https?|git|ssh|file):\/\//i.test(src) ||
    /^git@/i.test(src) ||
    /\.git\/?$/i.test(src) ||
    // the GitHub shorthand `owner/repo` (a placeholder owner such as `<owner>` included)
    /^[^\s/~.][^\s/]*\/[^\s/]+$/.test(src)
  );
}
/** A source that names a local directory (the built clone): absolute, home-relative or relative. */
const isLocalPath = (src: string): boolean =>
  !isGitSource(src) && /^(?:~\/|\/|\.\.?(?:\/|$))/.test(src);

const marketplaceSources = (md: string): DocCommand[] =>
  commands(md, "claude plugin marketplace add ");
const sourceOf = (c: DocCommand): string => words(c.cmd)[4] ?? "";

describe("the plugin's server needs the build output (the premise)", () => {
  it("its one server runs the shim, the shim runs dist/cli.js, and git never carries dist/", () => {
    expect(Object.keys(mcp.mcpServers)).toEqual([plugin.name]);
    const s = mcp.mcpServers[plugin.name];
    expect(s?.command).toBe("/bin/sh");
    expect(s?.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/scripts/eff-launch.sh", "serve"]);
    const shim = readDoc("scripts/eff-launch.sh");
    expect(shim).toContain("root=${CLAUDE_PLUGIN_ROOT:-}");
    expect(shim).toContain('cli="$root/dist/cli.js"');
    expect(shim).toMatch(/exec "\$node" "\$cli" "\$@"/);
    // dist/ is ignored and nothing under it is tracked: a git-sourced plugin cannot contain it
    expect(
      spawnSync("git", ["check-ignore", "-q", "--no-index", "dist/cli.js"], { cwd: ROOT }).status,
    ).toBe(0);
    expect(execFileSync("git", ["ls-files", "--", "dist"], { cwd: ROOT, encoding: "utf8" })).toBe(
      "",
    );
  });

  it("the marketplace's one plugin is its own root, so a marketplace added from the clone installs the clone", () => {
    expect(market.plugins.map((p) => [p.name, p.source])).toEqual([[plugin.name, "./"]]);
  });
});

describe("every documented install adds the marketplace from the built clone (a local path)", () => {
  it("the source classifier refuses git sources and accepts local directories", () => {
    for (const g of [
      "<owner>/espn-fantasy-football-mcp",
      "someone/espn-fantasy-football-mcp",
      "https://github.com/someone/espn-fantasy-football-mcp",
      "https://github.com/someone/espn-fantasy-football-mcp.git",
      "git@github.com:someone/espn-fantasy-football-mcp.git",
      "file:///tmp/espn-fantasy-football-mcp.git",
      "ssh://git@example.test/repo",
    ]) {
      expect(isGitSource(g), g).toBe(true);
      expect(isLocalPath(g), g).toBe(false);
    }
    for (const l of [
      "~/src/espn-fantasy-football-mcp",
      "/absolute/path/to/espn-fantasy-football-mcp",
      ".",
      "./",
      "../espn-fantasy-football-mcp",
    ]) {
      expect(isGitSource(l), l).toBe(false);
      expect(isLocalPath(l), l).toBe(true);
    }
  });

  it.each(INSTALL_DOCS)("%s: every `claude plugin marketplace add` names a local path", (doc) => {
    const found = marketplaceSources(readDoc(doc));
    expect(found.length, `${doc} documents the plugin install`).toBeGreaterThan(0);
    for (const c of found) expect(isLocalPath(sourceOf(c)), `${doc}: ${c.cmd}`).toBe(true);
  });

  it.each(INSTALL_DOCS)(
    "%s: every `claude plugin install` names this plugin and marketplace",
    (doc) => {
      const found = commands(readDoc(doc), "claude plugin install ");
      expect(found.length).toBeGreaterThan(0);
      for (const c of found) expect(words(c.cmd)[3], c.cmd).toBe(ID);
    },
  );
});

describe("the README Quickstart registers the server once per client", () => {
  const qs = section(README, "## Quickstart and installation");
  const block = fences(qs).find((f) => f.lang === "sh");
  const cmds = block === undefined ? [] : runnable(block);
  const at = (re: RegExp): number => cmds.findIndex((c) => re.test(c));

  it("Claude Code: the plugin, added from the very clone the block built", () => {
    const clone = cmds.find((c) => c.startsWith("git clone "));
    const dir = clone === undefined ? "" : (words(clone).at(-1) ?? "");
    expect(dir).not.toBe("");
    const built = at(/^npm run build$/);
    const cd = cmds.indexOf(`cd ${dir}`);
    expect(cd).toBeGreaterThanOrEqual(0);
    expect(cd).toBeLessThan(built);
    const add = cmds.filter((c) => c.startsWith("claude plugin marketplace add "));
    expect(add).toEqual([`claude plugin marketplace add ${dir}`]);
    expect(at(/^claude plugin marketplace add /)).toBeGreaterThan(built);
    const installs = cmds.filter((c) => c.startsWith("claude plugin install "));
    expect(installs).toHaveLength(1);
    expect(at(/^claude plugin install /)).toBeGreaterThan(at(/^claude plugin marketplace add /));
    const install = words(installs[0] ?? "");
    expect(install[3]).toBe(ID);
    // every --config key is an option the plugin declares
    const keys = install.flatMap((w, i) =>
      install[i - 1] === "--config" ? [/^([a-z][a-z0-9_]*)=/.exec(w)?.[1] ?? w] : [],
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(Object.keys(plugin.userConfig ?? {}), k).toContain(k);
  });

  it("no second Claude Code registration beside the plugin; Desktop chat gets its own config", () => {
    expect(
      cmds.filter((c) => /^eff print-config --client code\b|^claude mcp add\b/.test(c)),
    ).toEqual([]);
    expect(cmds.filter((c) => /^eff print-config --client desktop$/.test(c))).toHaveLength(1);
  });

  it("the upgrade note refreshes the plugin's copy, and the uninstall note removes the plugin", () => {
    const bullet = (name: string): string =>
      qs.split("\n").find((l) => l.startsWith(`- **${name}:**`)) ?? "";
    const upgrade = bullet("Upgrade");
    expect(upgrade).toContain(`claude plugin marketplace update ${market.name}`);
    expect(upgrade).toContain(`claude plugin update ${ID}`);
    // at an unchanged version an update keeps the cached copy: the note says how to replace it
    expect(upgrade).toContain(`claude plugin uninstall ${ID}`);
    const uninstall = bullet("Uninstall");
    expect(uninstall).toContain(`claude plugin uninstall ${ID}`);
    expect(uninstall).toContain(`claude plugin marketplace remove ${market.name}`);
  });
});

describe("every other Claude Code registration is offered instead of the plugin, never beside it", () => {
  const ALTERNATIVE = /instead of the plugin|without the plugin/i;
  it.each(INSTALL_DOCS)(
    "%s: each `eff print-config --client code` / `claude mcp add` says so",
    (doc) => {
      const md = readDoc(doc);
      // a command takes arguments; a bare "`claude mcp add` entry" in prose names the route only
      const routes = [
        ...commands(md, "eff print-config --client code"),
        ...commands(md, "claude mcp add "),
      ];
      expect(routes.length, `${doc} documents the no-plugin route`).toBeGreaterThan(0);
      for (const r of routes) expect(r.context, `${doc}: ${r.cmd}`).toMatch(ALTERNATIVE);
    },
  );
});

describe("the README's plugin configuration is the shipped .mcp.json", () => {
  it("the snippet under **Claude Code plugin** parses to the file, byte for byte in meaning", () => {
    const snippet = fences(README).find(
      (f) => f.lang === "json" && f.label.startsWith("**Claude Code plugin**"),
    );
    expect(snippet).toBeDefined();
    expect(JSON.parse((snippet?.lines ?? []).join("\n"))).toEqual(mcp);
  });
});
