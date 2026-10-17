// regions.ts — generated regions inside hand-written Markdown (plan 04 §6: "Docs that are
// generated, not written"; Stage C finding docs-current-check-missing). A region is delimited by
//   <!-- BEGIN GENERATED: <name> (<generator>) -->
//   <!-- END GENERATED: <name> -->
// Its body belongs to the generator; everything around it is prose a human owns. A generator
// rebuilds every region of its targets; `--check` (CI's docs-current job, `npm run check:docs`)
// fails on any difference and on a target that lost its markers, `--write` (`npm run docs:gen`)
// rewrites the bodies. New here.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");

const begin = (name: string): RegExp =>
  new RegExp(
    `^<!-- BEGIN GENERATED: ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\([^)]*\\) -->$`,
    "m",
  );
const end = (name: string): string => `<!-- END GENERATED: ${name} -->`;

/** The text with region `name`'s body replaced by `body` (markers kept). Throws without markers. */
export function withRegion(text: string, name: string, body: string): string {
  const b = begin(name).exec(text);
  if (b === null) throw new Error(`no "<!-- BEGIN GENERATED: ${name} (...) -->" marker`);
  const from = b.index + b[0].length;
  const to = text.indexOf(end(name), from);
  if (to === -1) throw new Error(`no "${end(name)}" marker after its BEGIN`);
  return `${text.slice(0, from)}\n${body.trimEnd()}\n${text.slice(to)}`;
}

/** Region `name`'s current body (between the markers, trimmed), or null without markers. */
export function regionBody(text: string, name: string): string | null {
  const b = begin(name).exec(text);
  if (b === null) return null;
  const from = b.index + b[0].length;
  const to = text.indexOf(end(name), from);
  return to === -1 ? null : text.slice(from, to).trim();
}

/** A Markdown table cell: pipes escaped, line breaks flattened. */
export function cell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** One file a generator owns regions of, and how its new text is built from the current one. */
export interface DocTarget {
  /** Repository-relative path. */
  readonly file: string;
  /** The new text (regions rebuilt); may also return problems the generator found (fail the check). */
  build(current: string): { readonly text: string; readonly problems: readonly string[] };
}

/**
 * Runs a generator's targets: `check` reports every target whose text is not current and every
 * problem; `write` rewrites the stale ones (problems still fail). Exit code 0 / 1; `root` lets a
 * test point it at a copy.
 */
export function runTargets(
  tool: string,
  targets: readonly DocTarget[],
  mode: "check" | "write",
  root: string = ROOT,
  out: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): number {
  let failed = false;
  for (const t of targets) {
    const file = path.join(root, t.file);
    const current = readFileSync(file, "utf8");
    let built: { text: string; problems: readonly string[] };
    try {
      built = t.build(current);
    } catch (e) {
      out(`${tool}: ${t.file}: ${e instanceof Error ? e.message : String(e)}`);
      failed = true;
      continue;
    }
    for (const p of built.problems) {
      out(`${tool}: ${t.file}: ${p}`);
      failed = true;
    }
    if (built.text === current) continue;
    if (mode === "write") {
      writeFileSync(file, built.text);
      out(`${tool}: ${t.file}: regenerated`);
    } else {
      out(`${tool}: ${t.file}: not current — run \`npm run docs:gen\` and commit the result`);
      failed = true;
    }
  }
  if (!failed) out(`${tool}: ok — ${String(targets.length)} file(s) current`);
  return failed ? 1 : 0;
}

/** The CLI of a generator: `--check` (default) or `--write`, optional `--root <dir>`. */
export function cli(tool: string, targets: readonly DocTarget[], argv: readonly string[]): number {
  const mode = argv.includes("--write") ? "write" : "check";
  const i = argv.indexOf("--root");
  const root = i >= 0 && argv[i + 1] !== undefined ? path.resolve(argv[i + 1] ?? ".") : ROOT;
  for (const a of argv)
    if (!["--write", "--check", "--root"].includes(a) && argv[argv.indexOf(a) - 1] !== "--root") {
      process.stderr.write(
        `${tool}: unexpected argument ${a}\nusage: ${tool} [--check | --write] [--root <dir>]\n`,
      );
      return 2;
    }
  return runTargets(tool, targets, mode, root);
}
