// gen-config-docs.ts — the README's configuration keys, generated from src/config/schema.ts (plan
// 04 §6: "README Configuration table (the server and launcher keys) and the README Testing
// section's test keys ← src/config/schema.ts, by each key's scope"; plan 03 §3; changelog V2;
// Stage C finding docs-current-check-missing). Two regions of README.md: `config-keys` (the server
// and launcher keys, in schema order) and `test-keys` (the test-scope keys). The hand-written
// `.env.example` line-by-line table around them must still name every server and launcher key — a
// key added to the schema and forgotten there fails the check. `.env.example` itself is held by
// tests/config/schema.test.ts.
//
// Usage:  npx tsx scripts/gen-config-docs.ts [--check | --write] [--root <dir>]
// Exit: 0 current · 1 not current (or a problem) · 2 usage.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_KEY_SPECS, type ConfigKeySpec } from "../src/config/schema.js";
import { cell, cli, withRegion, type DocTarget } from "./docs/regions.js";

/** A default as the table shows it: code when it is a literal, prose otherwise, — when unset. */
function defaultCell(d: string | null): string {
  if (d === null) return "—";
  return /^[\w.<>/~:@-]+$/.test(d) ? `\`${d}\`` : cell(d);
}

const statusNote = (s: ConfigKeySpec): string =>
  s.status === "writes"
    ? " **Inert in this build.**"
    : s.status === "reserved"
      ? " **Reserved.**"
      : "";

/** The server and launcher keys, in schema order. */
export function configKeysTable(specs: readonly ConfigKeySpec[] = CONFIG_KEY_SPECS): string {
  const rows = specs
    .filter((s) => s.scope !== "test")
    .map(
      (s) =>
        `| \`${s.key}\` | ${s.scope} | ${defaultCell(s.default)} | ${s.fileSettable ? "yes" : "no"} | ${s.secret ? "yes" : "no"} | ${cell(s.description)}${statusNote(s)} |`,
    );
  return [
    "| Key | Scope | Default | In `config.json` | Secret | Meaning |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** The test-scope keys (absent from `.env.example`). */
export function testKeysTable(specs: readonly ConfigKeySpec[] = CONFIG_KEY_SPECS): string {
  const rows = specs
    .filter((s) => s.scope === "test")
    .map((s) => `| \`${s.key}\` | ${defaultCell(s.default)} | ${cell(s.description)} |`);
  return ["| Key | Default | Meaning |", "|---|---|---|", ...rows].join("\n");
}

/**
 * The server and launcher keys the hand-written `.env.example, line by line` table does not name
 * (a row starting `| \`KEY=` or `| \`# KEY=`).
 */
export function unexplainedKeys(
  readme: string,
  specs: readonly ConfigKeySpec[] = CONFIG_KEY_SPECS,
): string[] {
  const start = readme.indexOf("### `.env.example`, line by line");
  const section = start === -1 ? "" : readme.slice(start, readme.indexOf("\n## ", start));
  return specs
    .filter((s) => s.scope !== "test")
    .map((s) => s.key)
    .filter((k) => !new RegExp(`^\\| \`(?:# )?${k}=`, "m").test(section));
}

export const TARGETS: readonly DocTarget[] = [
  {
    file: "README.md",
    build: (current) => {
      const text = withRegion(
        withRegion(current, "config-keys", configKeysTable()),
        "test-keys",
        testKeysTable(),
      );
      const problems = unexplainedKeys(text).map(
        (k) =>
          `${k} is in src/config/schema.ts but the ".env.example, line by line" table does not explain it`,
      );
      return { text, problems };
    },
  },
];

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = cli("gen-config-docs", TARGETS, process.argv.slice(2));
