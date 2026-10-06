// labelled.test.ts — plan 10 B8 "the `rules_v1` claim extractor scores ≥ 0.8 precision on a
// hand-labelled set of 50 real items [A-4]". The sets are fixtures/news/labelled/*.json (real RSS
// items captured from the three feeds, labelled by title under fixtures/news/labelled/README.md):
// `items.json` (65 items, 2026-10-06 19:53Z; in-sample — the rules were drafted with it in view).
// Precision = emitted claims
// whose type AND direction equal the label ÷ emitted claims. The titles are also held to the
// committed captures, so a label can never drift from the item it describes.
import { describe, expect, it } from "vitest";
import { extractClaim } from "../../../src/domain/evidence/index.js";
import { parseRss } from "../../../src/sources/news/xml.js";
import { fixtureText, labelledItems, type LabelledItem } from "../../sources/news/helpers.js";

interface Score {
  readonly items: number;
  readonly labelled_claims: number;
  readonly emitted: number;
  readonly correct: number;
  readonly type_correct: number;
  readonly precision: number;
  readonly type_precision: number;
  readonly recall: number;
  readonly misses: readonly string[];
}

function score(items: readonly LabelledItem[]): Score {
  let emitted = 0;
  let correct = 0;
  let typeCorrect = 0;
  let recalled = 0;
  const misses: string[] = [];
  for (const it of items) {
    const x = extractClaim(it.title, "title");
    if (x !== null) {
      emitted++;
      const ok =
        it.claim !== null && it.claim.type === x.type && it.claim.direction === x.direction;
      if (ok) correct++;
      if (it.claim !== null && it.claim.type === x.type) typeCorrect++;
      if (!ok)
        misses.push(`#${String(it.n)} ${x.type}/${x.direction} vs ${JSON.stringify(it.claim)}`);
    } else if (it.claim !== null)
      misses.push(`#${String(it.n)} missed ${JSON.stringify(it.claim)}`);
    if (
      x !== null &&
      it.claim !== null &&
      it.claim.type === x.type &&
      it.claim.direction === x.direction
    )
      recalled++;
  }
  const labelled = items.filter((i) => i.claim !== null).length;
  return {
    items: items.length,
    labelled_claims: labelled,
    emitted,
    correct,
    type_correct: typeCorrect,
    precision: emitted === 0 ? 0 : correct / emitted,
    type_precision: emitted === 0 ? 0 : typeCorrect / emitted,
    recall: labelled === 0 ? 0 : recalled / labelled,
    misses,
  };
}

const TYPES = new Set(["availability", "role", "health", "coaching_intent", "transaction"]);
const DIRS = new Set(["up", "down", "neutral"]);

describe("B8 — the 2026-10-06 labelled set (items.json)", () => {
  const items = labelledItems();

  it("is ≥ 50 real items, every label well-formed, every title equal to its committed capture", () => {
    expect(items.length).toBeGreaterThanOrEqual(50);
    const titles = new Map<string, string>();
    for (const feed of ["rotowire", "espn", "cbs"] as const) {
      for (const it of parseRss(fixtureText(`fixtures/news/captured/${feed}.xml`)).items)
        titles.set(
          `${feed}|${(it.guid ?? "").trim()}`,
          (it.title ?? "").replace(/\s+/g, " ").trim(),
        );
    }
    expect(titles.size).toBe(items.length);
    const seen = new Set<string>();
    for (const it of items) {
      const key = `${it.feed}|${it.guid}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      expect(titles.get(key), key).toBe(it.title);
      expect(it.why.length).toBeGreaterThan(0);
      if (it.claim !== null) {
        expect(TYPES.has(it.claim.type), key).toBe(true);
        expect(DIRS.has(it.claim.direction), key).toBe(true);
      }
    }
  });

  it("rules_v1 precision ≥ 0.8 (type and direction)", () => {
    const s = score(items);
    expect(s.emitted).toBeGreaterThan(0);
    expect(s.precision, s.misses.join("; ")).toBeGreaterThanOrEqual(0.8);
    // recorded in fixtures/news/labelled/README.md
    expect({ emitted: s.emitted, correct: s.correct, labelled: s.labelled_claims }).toEqual({
      emitted: 14,
      correct: 14,
      labelled: 14,
    });
  });
});
