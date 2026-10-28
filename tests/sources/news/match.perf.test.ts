// match.perf.test.ts — the shared-name reading's worst case stays bounded (ruling R8-3 fix round 3:
// the attack found its first-side pass over an item's abbreviations quadratic, 13 times f41e810's
// cost; plan 05 §4.2: budgets live in the process project, never under coverage). An item of a
// shared name and many teams and abbreviations, at its storage caps (title 1 000, blurb 4 000
// characters), costs a small multiple of a benign near-cap item — a ratio, so a slower machine
// moves both — and a file of them builds well inside a refresh run (build.perf.test.ts' 15 s).
import { describe, expect, it } from "vitest";
import { NFL_TEAMS } from "../../../src/config/schema.js";
import {
  buildNewsRows,
  buildPlayerMatcher,
  NEWS_FILE_FORMAT,
  type NewsUniversePlayer,
} from "../../../src/sources/news/index.js";

const FIRST = ["James", "John", "Michael", "Chris", "Josh", "Jordan", "Tyler", "Ryan", "Kevin"];
const LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson"];
/** ESPN's active universe size (research 04 §C), and one shared name: a star and a namesake. */
const universe: NewsUniversePlayer[] = [
  ...Array.from({ length: 2_700 }, (_, i) => ({
    espn_id: i + 1,
    full_name: `${FIRST[i % 9] ?? "A"} ${LAST[Math.floor(i / 9) % 8] ?? "B"}x${String(i)}`,
    team: NFL_TEAMS[i % 32] ?? null,
    gsis_id: null,
  })),
  { espn_id: 9_000_001, full_name: "Sam Twin", team: "MIN", gsis_id: null, percent_owned: 90 },
  { espn_id: 9_000_002, full_name: "Sam Twin", team: "CLE", gsis_id: null, percent_owned: 0.5 },
];
const cap = (s: string, n: number): string => s.slice(0, n);
/** The attack's item: the shared name, 400 abbreviations, then 800 team names, at the caps. */
const TITLE = cap(`Sam Twin ${"NE ".repeat(400)}`, 1_000);
const BLURB = cap("Jets ".repeat(900), 4_000);
const BENIGN = `Sam Twin: Questionable | ${"Notes on the week ahead. ".repeat(160)}`;

/** The median of `n` timed calls, after a warm-up. */
function median(f: () => unknown, n = 21): number {
  for (let i = 0; i < 5; i++) f();
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    f();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(n / 2)] ?? 0;
}

describe("news matcher — the shared-name reading's worst case", () => {
  it("the attack's capped item costs at most 12 times a benign near-cap item", () => {
    const m = buildPlayerMatcher(universe);
    const item = `${TITLE} | ${BLURB}`;
    // what it reads: no ref for the shared name (a team named loosely), counted
    expect(m.matchItem(item)).toEqual({ refs: [], unresolved: 1 });
    const adversarial = median(() => m.matchItem(item));
    const benign = median(() => m.matchItem(BENIGN));
    // measured 2026-10-28: 3.4 times (f41e810 4.8; 7b9572c 56)
    expect(adversarial).toBeLessThan(12 * Math.max(benign, 0.05));
  });

  it("1 000 such items build in < 15 s", () => {
    const now = Date.parse("2026-10-06T20:00:00Z");
    const previous = Array.from({ length: 1_000 }, (_, i) => ({
      item_id: i.toString(16).padStart(32, "0"),
      source: "cbs",
      published_ms: now - 86_400_000,
      first_seen_ms: now - 86_400_000,
      title: TITLE,
      blurb: BLURB,
      link: null,
    }));
    const t0 = performance.now();
    const b = buildNewsRows({
      format: NEWS_FILE_FORMAT,
      source: "cbs",
      fetched_ms: now,
      xml: "<rss><channel></channel></rss>",
      universe,
      previous,
      warnings: [],
    });
    expect(b.news).toHaveLength(1_000);
    expect(b.counts).toMatchObject({ unmatched: 1_000, unresolved: 1_000 });
    // measured 2026-10-28: about 2.5 s (7b9572c about 34 s)
    expect(performance.now() - t0).toBeLessThan(15_000);
  });
});
