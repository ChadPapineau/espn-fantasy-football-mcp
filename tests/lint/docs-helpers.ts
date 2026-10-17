// docs-helpers.ts — small Markdown readers for the suites that hold the root documents to what ships
// (tests/lint/plugin-install-docs, plugin-eval-docs, data-hosts-docs; Stage C round 1, area
// repo-root): a section by its heading, the fenced blocks with the paragraph that introduces each,
// the commands a document tells the reader to run, and table rows. Fence-aware throughout: a `#`
// comment inside a shell block is never read as a heading.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.js";

/** A repository file as text. */
export const readDoc = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const FENCE = /^```(\S*)\s*$/;

/** Each line with whether it sits inside a fenced block (the fence lines themselves count as inside). */
function fenceMap(lines: readonly string[]): boolean[] {
  const inside: boolean[] = [];
  let open = false;
  for (const l of lines) {
    if (FENCE.test(l)) {
      inside.push(true);
      open = !open;
    } else inside.push(open);
  }
  return inside;
}

/**
 * The text from the first heading line that starts with `heading` (so "## Quickstart and
 * installation" also finds a "(planned)" suffix) up to the next heading of the same or a higher level
 * outside a fenced block. Throws when the heading is missing, so a renamed section fails loudly.
 */
export function section(md: string, heading: string): string {
  const lines = md.split("\n");
  const inside = fenceMap(lines);
  const start = lines.findIndex((l, i) => !inside[i] && l.trim().startsWith(heading));
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i] ?? "");
    if (!inside[i] && m !== null && (m[1]?.length ?? 0) <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** One fenced block: its language, its lines, and the paragraph right above it (its label). */
export interface Fence {
  readonly lang: string;
  readonly lines: readonly string[];
  readonly label: string;
}

/** Every fenced block of `md`, in order. */
export function fences(md: string): Fence[] {
  const lines = md.split("\n");
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i] ?? "");
    if (open === null) continue;
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j] ?? "")) j++;
    // the label: the contiguous non-blank lines right above the opening fence
    let k = i - 1;
    while (k >= 0 && (lines[k] ?? "").trim() === "") k--;
    const label: string[] = [];
    while (k >= 0 && (lines[k] ?? "").trim() !== "" && !FENCE.test(lines[k] ?? "")) {
      label.unshift((lines[k] ?? "").trim());
      k--;
    }
    out.push({ lang: open[1] ?? "", lines: lines.slice(i + 1, j), label: label.join(" ") });
    i = j;
  }
  return out;
}

/** A shell line without its trailing ` # comment` (the docs' commands carry no `#` in an argument). */
export const stripComment = (line: string): string => line.replace(/\s+#\s.*$/, "").trim();

/** The runnable lines of a shell block: comments and blank lines dropped, trailing comments cut. */
export const runnable = (f: Fence): string[] =>
  f.lines
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map(stripComment);

/** One command a document tells the reader to run, with the text that frames it. */
export interface DocCommand {
  readonly cmd: string;
  /** The fence's label for a block line; the prose line itself (one bullet or paragraph) otherwise. */
  readonly context: string;
  readonly inFence: boolean;
}

/**
 * Every command starting with `prefix`: a runnable line of a fenced block, or an inline code span in
 * prose (`` `claude plugin install …` ``).
 */
export function commands(md: string, prefix: string): DocCommand[] {
  const out: DocCommand[] = [];
  for (const f of fences(md))
    for (const l of runnable(f))
      if (l.startsWith(prefix)) out.push({ cmd: l, context: f.label, inFence: true });
  const lines = md.split("\n");
  const inside = fenceMap(lines);
  lines.forEach((l, i) => {
    if (inside[i]) return;
    for (const m of l.matchAll(/`([^`]+)`/g)) {
      const code = (m[1] ?? "").trim();
      if (code.startsWith(prefix)) out.push({ cmd: code, context: l.trim(), inFence: false });
    }
  });
  return out;
}

/** Splits a command line into words, keeping a quoted word whole (quotes removed). */
export function words(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** The cells of every row of the Markdown tables in `md` (the header row included, separators not). */
export function tableRows(md: string): string[][] {
  return md
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|\s*-{3,}/.test(l))
    .map((l) =>
      l
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
}
