// json-lines.ts — maps a line number of a formatted JSON text to the JSON path of the first key or
// value on that line, so a scanner finding ("deny-list match in <file>:<line>") can be reported as a
// path, never as the matched value (plan 05 §3.1 step 2: "abort with the path").
import { formatPath } from "./canonical.js";

export type Seg = string | number;
interface Frame {
  kind: "obj" | "arr";
  key: string | null;
  index: number;
  /** In an object: the next string token is a key. */
  wantKey: boolean;
}

/** For each requested 1-based line, the path of the first token that starts on it ("$" if none). */
export function pathsAtLines(text: string, lines: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const [l, segs] of segmentsAtLines(text, lines)) out.set(l, formatPath(segs));
  return out;
}

/** As pathsAtLines, as segment lists (`[]` for the root or a line with no token). */
export function segmentsAtLines(text: string, lines: readonly number[]): Map<number, Seg[]> {
  const want = new Set(lines);
  const out = new Map<number, Seg[]>();
  const stack: Frame[] = [];
  let line = 1;
  let lineSeen = false;
  const here = (extra: Seg | null, frames: readonly Frame[] = stack): Seg[] => {
    const segs: Seg[] = [];
    for (const f of frames) {
      if (f.kind === "obj" && f.key !== null) segs.push(f.key);
      if (f.kind === "arr") segs.push(f.index);
    }
    if (extra !== null) segs.push(extra);
    return segs;
  };
  const mark = (p: Seg[]) => {
    if (!lineSeen && want.has(line) && !out.has(line)) out.set(line, p);
    lineSeen = true;
  };
  const valueDone = () => {
    const top = stack[stack.length - 1];
    if (top?.kind === "obj") top.wantKey = true;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      line++;
      lineSeen = false;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "," || c === ":") {
      if (c === ",") {
        const top = stack[stack.length - 1];
        if (top?.kind === "arr") top.index++;
      }
      i++;
      continue;
    }
    if (c === "{" || c === "[") {
      mark(here(null));
      stack.push({ kind: c === "{" ? "obj" : "arr", key: null, index: 0, wantKey: c === "{" });
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      // a closing bracket belongs to its container, not to the container's last child
      mark(here(null, stack.slice(0, -1)));
      stack.pop();
      valueDone();
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i, j + 1);
      const top = stack[stack.length - 1];
      if (top?.kind === "obj" && top.wantKey) {
        const key = JSON.parse(raw) as string;
        top.key = key;
        top.wantKey = false;
        mark(here(null));
      } else {
        mark(here(null));
        valueDone();
      }
      i = j + 1;
      continue;
    }
    // number, true, false, null
    let j = i;
    while (j < text.length && !/[\s,\]}]/.test(text[j] ?? "")) j++;
    mark(here(null));
    valueDone();
    i = j;
  }
  for (const l of lines) if (!out.has(l)) out.set(l, []);
  return out;
}
