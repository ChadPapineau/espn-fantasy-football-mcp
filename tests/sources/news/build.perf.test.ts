// build.perf.test.ts — the news publish step's worst case stays bounded (plan 05 §4.2: budgets live
// in the process project, never under coverage): a full file (MAX_NEWS_ITEMS carried items, every
// blurb near its storage cap) matched against a 2 700-player universe — ESPN's active universe size
// (research 04 §C) — finishes well inside a refresh run. Real files are ~1 000 short items.
import { describe, expect, it } from "vitest";
import { NFL_TEAMS } from "../../../src/config/schema.js";
import {
  buildNewsRows,
  MAX_NEWS_ITEMS,
  NEWS_FILE_FORMAT,
  type NewsUniversePlayer,
} from "../../../src/sources/news/index.js";

const FIRST = [
  "James",
  "John",
  "Michael",
  "Chris",
  "Josh",
  "Jordan",
  "Tyler",
  "Ryan",
  "Kevin",
  "Jalen",
];
const LAST = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Miller",
  "Davis",
  "Wilson",
  "Moore",
  "Taylor",
];

describe("news build — worst case", () => {
  it("5 000 near-cap items × a 2 700-player universe in < 15 s", () => {
    const universe: NewsUniversePlayer[] = Array.from({ length: 2_700 }, (_, i) => ({
      espn_id: i + 1,
      full_name: `${FIRST[i % 10] ?? "A"} ${LAST[Math.floor(i / 10) % 10] ?? "B"}${i >= 100 ? `x${String(i)}` : ""}`,
      team: NFL_TEAMS[i % 32] ?? null,
      gsis_id: null,
    }));
    const now = Date.parse("2026-10-06T20:00:00Z");
    const previous = Array.from({ length: MAX_NEWS_ITEMS }, (_, i) => ({
      item_id: i.toString(16).padStart(32, "0"),
      source: "cbs",
      published_ms: now - 86_400_000,
      first_seen_ms: now - 86_400_000,
      title: `${FIRST[i % 10] ?? ""} ${LAST[i % 10] ?? ""}: Ruled out vs Bills, Falcons and Ravens`,
      blurb: `${"Notes on the week ahead. ".repeat(150)} Ravens QB ${LAST[(i + 3) % 10] ?? ""}`,
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
    expect(b.news).toHaveLength(MAX_NEWS_ITEMS);
    expect(b.refs.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(15_000);
  });
});
