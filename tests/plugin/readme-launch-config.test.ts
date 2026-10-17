// readme-launch-config.test.ts — what README tells a user to configure for the server (plan 03 §4;
// plan 06 §2 "one configuration"; plan 09 §4; Stage C findings plugin-season-default-pinned and
// plugin-toolset-full-unreachable). The manual Claude Desktop and Claude Code examples pin no season
// — `eff print-config` writes ESPN_SEASON only when it was set (src/cli/print-config.ts launchEnv),
// so a copied example must not freeze the server on one season while the eff CLI and the launchd
// jobs move on — and the plugin's options are documented with the env key each one sets, the
// toolset among them: the P1 Skills' Step 0 asks for `EFF_TOOLSET=full`, which a plugin install
// sets through its option. (The plugin's .mcp.json snippet itself is held against the file by
// tests/lint/plugin-install-docs.test.ts.)
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readPlugin } from "./helpers.js";

const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const blocks = [...readme.matchAll(/```(\w*)\n([\s\S]*?)\n```/g)].map((m) => ({
  lang: m[1] ?? "",
  body: m[2] ?? "",
}));
/** The one fenced block `pred` picks (exactly one, or the README is ambiguous). */
function only(pred: (b: { lang: string; body: string }) => boolean, what: string): string {
  const found = blocks.filter(pred);
  expect(found, what).toHaveLength(1);
  return found[0]!.body;
}

describe("README's launch configuration", () => {
  it("the Claude Desktop and Claude Code examples set no ESPN_SEASON", () => {
    const desktop = only(
      (b) => b.lang === "json" && b.body.includes("dist/cli.js"),
      "the Claude Desktop example",
    );
    const code = only(
      (b) => b.lang === "sh" && b.body.includes("claude mcp add espn-fantasy-football"),
      "the Claude Code example",
    );
    for (const example of [desktop, code]) {
      expect(example).toContain("ESPN_LEAGUE_ID");
      expect(example).not.toContain("ESPN_SEASON");
    }
  });

  it("names every plugin option beside the env key it sets", () => {
    const lead = "**The plugin's options are its server's environment.**";
    const para = readme.split("\n").filter((l) => l.startsWith(lead));
    expect(para, lead).toHaveLength(1);
    const { manifest, server } = readPlugin();
    const mapped = Object.entries(server.env ?? {}).map(([envKey, ref]) => {
      const option = /^\$\{user_config\.([a-z0-9_]+)\}$/.exec(ref)?.[1];
      expect(option, envKey).toBeDefined();
      return [option!, envKey] as const;
    });
    expect(mapped.map(([o]) => o).sort()).toEqual(Object.keys(manifest.userConfig ?? {}).sort());
    for (const [option, envKey] of mapped)
      expect(para[0]).toContain(`\`${option}\` sets \`${envKey}\``);
    expect(para[0]).toContain("/plugin configure");
  });
});
