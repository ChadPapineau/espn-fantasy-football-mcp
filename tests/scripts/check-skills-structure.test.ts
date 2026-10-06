// check-skills-structure.test.ts — the plugin-root and Skills structure gate (plan 04 §4.2; plan 09
// §4, §5.1, K4, K8; plan 10 §3.0 Z6): it passes on this repo with zero Skills and fails on every
// manifest or Skill defect it names, hostile values included.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LAUNCH_ARGS,
  PLUGIN_NAME,
  checkPlugin,
  checkSkills,
  parseFrontmatter,
} from "../../scripts/ci/check-skills-structure.mjs";
import { ROOT, runCheck, tempDir, writeTree } from "../lint/helpers.js";

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

/** A copy of this repo's real plugin root in a temp dir, to mutate. */
function pluginRoot(): string {
  tmp = tempDir("eff-plugin-");
  for (const f of ["package.json", ".mcp.json", ".claude-plugin", "scripts/eff-launch.sh"]) {
    cpSync(path.join(ROOT, f), path.join(tmp.dir, f), { recursive: true });
  }
  return tmp.dir;
}
const edit = (root: string, rel: string, fn: (j: Record<string, unknown>) => void) => {
  const file = path.join(root, rel);
  const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  fn(j);
  writeFileSync(file, JSON.stringify(j));
};
type Server = { command: string; args: string[]; env: Record<string, string> } & Record<
  string,
  unknown
>;
const server = (j: Record<string, unknown>) =>
  (j.mcpServers as Record<string, Server>)[PLUGIN_NAME]!;

describe("this repository", () => {
  it("passes: a valid plugin root and zero Skills (the CLI exits 0 with a vacuity warning)", () => {
    expect(checkPlugin(ROOT)).toEqual([]);
    const r = runCheck("check-skills-structure.mjs", []);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("0 Skills present");
  });

  it(".mcp.json launches /bin/sh with the shim and sets no EFF_CONFIG_DIR/EFF_CACHE_DIR", () => {
    const mcp = JSON.parse(readFileSync(path.join(ROOT, ".mcp.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const s = server(mcp);
    expect(s.command).toBe("/bin/sh");
    expect(s.args).toEqual([...LAUNCH_ARGS]);
    expect(Object.keys(s.env)).not.toContain("EFF_CONFIG_DIR");
    expect(Object.keys(s.env)).not.toContain("EFF_CACHE_DIR");
  });
});

describe("plugin root defects", () => {
  it.each<[string, (root: string) => void, string]>([
    [
      "a wrong plugin name",
      (r) => {
        edit(r, ".claude-plugin/plugin.json", (j) => {
          j.name = "fantasy-football";
        });
      },
      "client config key",
    ],
    [
      "a version that drifted from package.json",
      (r) => {
        edit(r, ".claude-plugin/plugin.json", (j) => {
          j.version = "9.9.9";
        });
      },
      "version",
    ],
    [
      "a sensitive userConfig value",
      (r) => {
        edit(r, ".claude-plugin/plugin.json", (j) => {
          (j.userConfig as Record<string, Record<string, unknown>>).league_id = {
            type: "string",
            sensitive: true,
          };
        });
      },
      "sensitive",
    ],
    [
      "a marketplace with a remote source",
      (r) => {
        edit(r, ".claude-plugin/marketplace.json", (j) => {
          (j.plugins as Record<string, unknown>[])[0] = {
            name: PLUGIN_NAME,
            source: "https://evil.example/x",
          };
        });
      },
      "own marketplace",
    ],
    [
      "EFF_CONFIG_DIR in .mcp.json",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          server(j).env.EFF_CONFIG_DIR = "${user_config.season}";
        });
      },
      "EFF_CONFIG_DIR",
    ],
    [
      "EFF_CACHE_DIR in .mcp.json",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          server(j).env.EFF_CACHE_DIR = "${user_config.season}";
        });
      },
      "EFF_CACHE_DIR",
    ],
    [
      "a literal env value (a league id)",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          server(j).env.ESPN_LEAGUE_ID = "0000000";
        });
      },
      "never a literal",
    ],
    [
      "a cookie-ish env key",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          server(j).env.ESPN_S2 = "${user_config.season}";
        });
      },
      "not an allowed server setting",
    ],
    [
      "an undeclared userConfig reference",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          server(j).env.ESPN_SEASON = "${user_config.cookie}";
        });
      },
      "undeclared",
    ],
    [
      "a command other than /bin/sh",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          server(j).command = "node";
        });
      },
      "/bin/sh",
    ],
    [
      "an absolute user path in args",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          server(j).args = [["", "Users", "someone", "x.js"].join("/"), "serve"];
        });
      },
      "absolute path",
    ],
    [
      "an extra server",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          (j.mcpServers as Record<string, unknown>).other = { command: "/bin/sh" };
        });
      },
      "exactly",
    ],
    [
      "an unexpected server field",
      (r) => {
        edit(r, ".mcp.json", (j) => {
          server(j).cwd = "/tmp";
        });
      },
      "unexpected field",
    ],
    [
      "a missing launch shim",
      (r) => {
        writeFileSync(path.join(r, "scripts", "eff-launch.sh"), "#!/bin/bash\n");
      },
      "#!/bin/sh",
    ],
    [
      "a bin/ directory at the root",
      (r) => {
        mkdirSync(path.join(r, "bin"));
      },
      "bin/",
    ],
    [
      "malformed JSON",
      (r) => {
        writeFileSync(path.join(r, ".mcp.json"), "{ nope");
      },
      "invalid JSON",
    ],
  ])("fails on %s", (_why, mutate, needle) => {
    const root = pluginRoot();
    mutate(root);
    expect(checkPlugin(root).join("\n")).toContain(needle);
  });
});

describe("Skills", () => {
  const skill = (name: string, fm: string, body = "Body.\n") => ({
    [`skills/${name}/SKILL.md`]: `---\n${fm}\n---\n${body}`,
  });

  it("zero Skills (no skills/ dir, or only _shared/) is valid and counted as 0", () => {
    tmp = tempDir();
    expect(checkSkills(tmp.dir)).toEqual({ count: 0, errors: [] });
    writeTree(tmp.dir, {
      "skills/_shared/references/orient.md": "# x\n",
      "skills/README.md": "# index\n",
    });
    expect(checkSkills(tmp.dir)).toEqual({ count: 0, errors: [] });
  });

  it("a valid Skill passes; folded and quoted descriptions are read", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      ...skill("weekly", 'name: weekly\ndescription: "Builds the weekly game plan."'),
      ...skill(
        "start-sit",
        "name: start-sit\ndescription: >\n  Decides start/sit\n  under the league objective.",
      ),
    });
    expect(checkSkills(tmp.dir)).toEqual({ count: 2, errors: [] });
  });

  it.each([
    [
      "a name that differs from the directory",
      skill("weekly", "name: other\ndescription: d"),
      "directory name",
    ],
    ["a missing description", skill("weekly", "name: weekly"), "description is missing"],
    [
      "a description over 350 characters",
      skill("weekly", `name: weekly\ndescription: ${"x".repeat(351)}`),
      "over 350",
    ],
    ["no frontmatter", { "skills/weekly/SKILL.md": "# no frontmatter\n" }, "no frontmatter"],
    ["a missing SKILL.md", { "skills/weekly/references/x.md": "x\n" }, "no SKILL.md"],
    ["an upper-case directory", skill("Weekly", "name: Weekly\ndescription: d"), "[a-z0-9-]+"],
    [
      "a commit tool outside apply/",
      skill("weekly", "name: weekly\ndescription: d", "call espn_commit_lineup\n"),
      "only skills/apply/",
    ],
  ])("fails on %s", (_why, files, needle) => {
    tmp = tempDir();
    writeTree(tmp.dir, files);
    expect(checkSkills(tmp.dir).errors.join("\n")).toContain(needle);
  });

  it("apply/ may reference the prepare/commit tools", () => {
    tmp = tempDir();
    writeTree(
      tmp.dir,
      skill(
        "apply",
        "name: apply\ndescription: d",
        "espn_prepare_lineup then espn_commit_lineup\n",
      ),
    );
    expect(checkSkills(tmp.dir).errors).toEqual([]);
  });

  it("a file over 200 KB fails", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      ...skill("weekly", "name: weekly\ndescription: d"),
      "skills/weekly/references/big.md": "x".repeat(200 * 1024 + 1),
    });
    expect(checkSkills(tmp.dir).errors.join()).toContain("over 200 KB");
  });
});

describe("parseFrontmatter", () => {
  it.each([
    ["---\nname: a\n---\n", { name: "a" }],
    ["﻿---\nname: a\n---\n", { name: "a" }],
    ["---\nname: 'it''s'\n---\n", { name: "it''s" }],
    [
      "---\ndescription: |\n  line one\n  line two\nname: b\n---\n",
      { description: "line one\nline two", name: "b" },
    ],
    ["---\nname: a\n", null],
    ["no frontmatter", null],
  ])("%j", (text, want) => {
    const got = parseFrontmatter(text);
    if (want === null) expect(got).toBeNull();
    else expect(got).toMatchObject(want);
  });
});
