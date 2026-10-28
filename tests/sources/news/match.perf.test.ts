// match.perf.test.ts — the shared-name reading's worst case stays bounded (plan 05 §4.2: budgets live
// in the process project, never under coverage). Ruling R8-6 (changelog §R8): "Matching time is linear
// in the item's length". Two items at their storage caps (title 1 000, blurb 4 000 characters): R8-3
// fix round 3's (a shared name, many teams and abbreviations; its first-side pass was quadratic, 13
// times f41e810's cost), and the item the last attack on R8-3 built over the recorded universe (the 16
// shared full names and 260 surnames in one list, then 400 handles; dbe9686 took about 200 ms for it,
// and a file of 100 such items 21 s). Each costs a small multiple of a benign near-cap item — a ratio,
// so a slower machine moves both — and a file of them builds well inside a refresh run
// (build.perf.test.ts' 15 s).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NFL_TEAMS } from "../../../src/config/schema.js";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import {
  buildNewsRows,
  buildPlayerMatcher,
  NEWS_FILE_FORMAT,
  TEAM_WORDS,
  universeFromEspnPlayers,
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
    // measured 2026-10-28: 3.4 times at dbe9686 (f41e810 4.8; 7b9572c 56); under R8-6 the scan
    // stops at the first team it finds, so this item costs less than the benign one
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

describe("news matcher — R8-6: the last attack's capped item, over the recorded universe", () => {
  const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
  const recorded = universeFromEspnPlayers(
    playersRows(
      JSON.parse(
        readFileSync(path.join(ROOT, "fixtures/espn/recorded/season/players_wl.json"), "utf8"),
      ) as unknown,
      2026,
    ).rows,
    () => null,
  );
  // the attack's construction (dbe9686's triage, timing-trim.mts): capitalised universe surnames
  const surnames = [
    ...new Set(
      recorded
        .map((p) => p.full_name.split(/\s+/u).at(-1) ?? "")
        .filter((w) => /^[A-Z][a-z]{2,}$/u.test(w) && !TEAM_WORDS.has(w.toLowerCase())),
    ),
  ];
  // prettier-ignore
  const FULL = ["Lamar Jackson", "Justin Jefferson", "Byron Young", "Marcus Harris", "Chris Jones", "Josh Johnson", "Jordan Phillips", "Tony Brown", "David Long", "Brandon Johnson", "DJ Turner", "Byron Murphy", "Jaylon Jones", "Michael Carter", "Brandon Smith", "Chris Smith"];
  const blurb =
    `${FULL.join(", ")}, ${surnames.slice(0, 260).join(", ")} and Smith ${"@MIN, ".repeat(400)}`.slice(
      0,
      4_000,
    );
  const benign = `Lamar Jackson: Questionable | ${"Notes on the week ahead. ".repeat(160)}`;

  it("costs at most 6 times a benign near-cap item", () => {
    const m = buildPlayerMatcher(recorded);
    const item = `Lamar Jackson: Notes | ${blurb}`;
    expect(blurb).toHaveLength(4_000);
    const adversarial = median(() => m.matchItem(item));
    const quiet = median(() => m.matchItem(benign));
    // measured 2026-10-28: 1.3 times, 1.8 ms (dbe9686 about 210 times, 203 ms)
    expect(adversarial).toBeLessThan(6 * Math.max(quiet, 0.05));
  });

  it("1 000 such items build in < 15 s", () => {
    const now = Date.parse("2026-10-06T20:00:00Z");
    const previous = Array.from({ length: 1_000 }, (_, i) => ({
      item_id: i.toString(16).padStart(32, "0"),
      source: "cbs",
      published_ms: now - 86_400_000,
      first_seen_ms: now - 86_400_000,
      title: "Lamar Jackson: Notes",
      blurb,
      link: null,
    }));
    const t0 = performance.now();
    const b = buildNewsRows({
      format: NEWS_FILE_FORMAT,
      source: "cbs",
      fetched_ms: now,
      xml: "<rss><channel></channel></rss>",
      universe: recorded,
      previous,
      warnings: [],
    });
    expect(b.news).toHaveLength(1_000);
    // measured 2026-10-28: about 0.9 s (dbe9686 about 200 s by the attack's measure)
    expect(performance.now() - t0).toBeLessThan(15_000);
  });
});
