// work.ts — the news matcher's work count (changelog §R10, R10-16; ruling R8-8 (2): "linear time on
// hostile input"). A timing bound tight enough to see a quadratic that is cheap per mention would flake,
// so the growth check counts: the matcher (match.ts, labels.ts, teams.ts) adds one step for each
// iteration of its loops over the item — its characters, words, tokens, names, team mentions, labels
// and holders — and for each form it looks up. The count changes nothing the matcher reads or
// returns: the tally is written, never read, by the matcher. Test seam: production never opens a
// count. New here.
//
// The cost of the seam (the round-3 review's R3B-M2): each counted site first tested an imported
// `let` binding (the open count) against null — a live binding, read through its module cell at
// every access: 11–27 % more CPU on R8-8's bare-surname attack families than the matcher before the
// count (the same with the test written inline at each site, so not the call). Each module now
// copies this file's one tally object into a const of its own when it loads, and a counted site is
// one add to that object's field, always (no binding read, no branch); a count is the tally's growth
// while it is open. Re-measured in thread CPU against e0a52b5's matcher (interleaved pairs, items at
// the caps): 1.00–1.03 on those families, the matches byte-identical.

/** The steps a count holds. */
export interface MatchWork {
  steps: number;
}

/**
 * The matcher's running tally of steps (only ever added to; a count reads its growth). Each counting
 * module keeps a const reference to it, taken once at load.
 */
export const matchTally: MatchWork = { steps: 0 };

/** The open counts, innermost last: each one's start and the steps its inner counts took. */
const open: { readonly start: number; inner: number }[] = [];

/** Whether a count is open (tests: none is left open). */
export function countOpen(): boolean {
  return open.length > 0;
}

/**
 * Runs `f` with a count open and returns its value and the steps the matcher took inside it. A count
 * opened inside another is its own: the outer one's steps do not include the inner's.
 */
export function countMatchWork<T>(f: () => T): { readonly value: T; readonly steps: number } {
  const me = { start: matchTally.steps, inner: 0 };
  open.push(me);
  try {
    const value = f();
    return { value, steps: matchTally.steps - me.start - me.inner };
  } finally {
    open.pop();
    const outer = open[open.length - 1];
    if (outer !== undefined) outer.inner += matchTally.steps - me.start;
  }
}
