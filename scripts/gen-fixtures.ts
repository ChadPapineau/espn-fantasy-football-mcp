// gen-fixtures.ts — builds the derived Skills league fixtures/espn/fx-10h/** from the recorded,
// scrubbed bodies under fixtures/espn/recorded/ (plan 09 §4, [A-2]; plan 10 §3.1a *Fixtures* class
// 2; plan 05 §3 fixture law; ADV OBJ-21, R3 nit (b)). Refuses unless the recorded golden is green.
//
// Usage:  npx tsx scripts/gen-fixtures.ts           write the tree (removes stale files under it)
//         npx tsx scripts/gen-fixtures.ts --check   exit 1 when the committed tree is not current
// Exit: 0 ok · 1 not current (--check) or the golden gate refused · 2 usage.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "prettier";
import { FX_DIR, generate, type Json } from "./fx10h/generate.js";
import { jsonEqual } from "./fx10h/patch.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ESPN = path.join(ROOT, "fixtures", "espn");

/** Every file currently under fixtures/espn/fx-10h (relative to fixtures/espn). */
export function existingFiles(dir = path.join(ESPN, FX_DIR)): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const abs = path.join(d, n);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(path.relative(ESPN, abs).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** The tree's prettier options (as fixtures/espn/recorded/.prettierrc: wide, so files stay small). */
export const PRETTIER_OPTIONS = Object.freeze({
  parser: "json",
  printWidth: 1000,
  singleQuote: false,
  trailingComma: "all",
  semi: true,
  endOfLine: "lf",
} as const);

/** JSON as written: compact, then prettier-formatted (so `npm run format:check` agrees). */
export async function serialise(body: Json): Promise<string> {
  return format(JSON.stringify(body), PRETTIER_OPTIONS);
}

/** The files that differ from (or are missing in, or are extra to) the committed tree. */
export function staleFiles(files: Map<string, Json>): string[] {
  const stale: string[] = [];
  for (const [rel, body] of files) {
    let current: unknown;
    try {
      current = JSON.parse(readFileSync(path.join(ESPN, rel), "utf8"));
    } catch {
      stale.push(rel);
      continue;
    }
    if (!jsonEqual(current as Json, body)) stale.push(rel);
  }
  const wanted = new Set([...files.keys(), `${FX_DIR}/README.md`, `${FX_DIR}/.prettierrc`]);
  for (const rel of existingFiles()) if (!wanted.has(rel)) stale.push(rel);
  return stale.sort();
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes("--check");
  const unknown = argv.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`gen-fixtures: unexpected argument ${unknown[0] ?? ""}\n`);
    return 2;
  }
  const { files, goldenLines } = generate();
  if (check) {
    const stale = staleFiles(files);
    if (stale.length > 0) {
      process.stderr.write(
        `gen-fixtures: ${String(stale.length)} file(s) not current — run \`npx tsx scripts/gen-fixtures.ts\`:\n${stale
          .slice(0, 20)
          .map((s) => `  ${s}`)
          .join("\n")}\n`,
      );
      return 1;
    }
    process.stdout.write(
      `gen-fixtures: up to date (${String(files.size)} files; golden gate ${String(goldenLines)} lines green)\n`,
    );
    return 0;
  }
  const wanted = new Set(files.keys());
  for (const rel of existingFiles())
    if (!wanted.has(rel) && rel !== `${FX_DIR}/README.md` && rel !== `${FX_DIR}/.prettierrc`)
      rmSync(path.join(ESPN, rel));
  for (const [rel, body] of files) {
    const abs = path.join(ESPN, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, await serialise(body));
  }
  process.stdout.write(
    `gen-fixtures: wrote ${String(files.size)} files under fixtures/espn/${FX_DIR} (golden gate ${String(goldenLines)} lines green)\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`)
  process.exitCode = await main(process.argv.slice(2));
