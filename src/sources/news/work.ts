// work.ts — the news matcher's work count (changelog §R10, R10-16; ruling R8-8 (2): "linear time on
// hostile input"). A timing bound tight enough to see a quadratic that is cheap per mention would flake,
// so the growth check counts: while a count is open, the matcher (match.ts, labels.ts, teams.ts) adds
// one step for each iteration of its loops over the item — its characters, words, tokens, names, team
// mentions, labels and holders — and for each form it looks up. The count changes nothing the matcher
// reads or returns: it is written, never read, by the matcher. Unused (the default), each counted site
// costs one test of this binding against null. Test seam: production never opens a count. New here.

/** An open count: the steps counted so far. */
export interface MatchWork {
  steps: number;
}

/** The open count, or null (no count open: the matcher only tests this binding). */
export let matchWork: MatchWork | null = null;

/**
 * Runs `f` with a count open and returns its value and the steps the matcher took inside it. A count
 * opened inside another is its own; the outer one resumes after it, its steps not including the
 * inner's.
 */
export function countMatchWork<T>(f: () => T): { readonly value: T; readonly steps: number } {
  const outer = matchWork;
  const open: MatchWork = { steps: 0 };
  matchWork = open;
  try {
    const value = f();
    return { value, steps: open.steps };
  } finally {
    matchWork = outer;
  }
}
