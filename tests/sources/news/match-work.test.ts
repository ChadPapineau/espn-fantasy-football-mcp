// match-work.test.ts — the news matcher's growth check, by count (changelog §R10, R10-16; ruling R8-8
// (2): "linear time on hostile input"). match.perf.test.ts holds R8-8's timing ratios, unchanged, and
// cannot see a quadratic that is cheap per mention (1.6–1.7 times linear over the widest span inside
// the caps would flake a timing bound tight enough to see it). Here the matcher's own work count
// (src/sources/news/work.ts: one step per iteration of its loops over the item and per form lookup)
// is read with no clock: for every attack construction of the perf file and the R8-6/R8-7/R8-8
// rounds, and for each kind of mention (a shared surname, a shared full name, a unique name, a
// labelled surname, a team-word surname), the work added by the last doubling of the item is at most
// GROWTH_MAX times that of the doubling before (a linear reading adds the same; a binary search's log
// factor one step a search; a quadratic doubles), and at a fixed length the work added per mention
// does not grow with the mention count. The count found two quadratics in the frozen matcher, each
// cheap per mention: every name scanned at each team mention, and every team mention scanned at each
// name (a run of "Justin Jefferson, Vikings: " grew 1.31 times per doubling; now 1.01). Positive
// controls: a matcher that scans every token at each shared-surname mention fails, and so does one
// whose extra scan costs only half the linear work at the caps (the timing ratios' blind spot). The
// count changes nothing: every item's match is the same with a count open. No clock, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { playersRows } from "../../../src/sources/espn_season/index.js";
import {
  buildPlayerMatcher,
  universeFromEspnPlayers,
  type PlayerMatcher,
} from "../../../src/sources/news/index.js";
import { countMatchWork, matchWork } from "../../../src/sources/news/work.js";

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
const m = buildPlayerMatcher(recorded);

/** The most the work added by one doubling may grow over the doubling before (a literal). */
const GROWTH_MAX = 1.05;
/** The most the work added over the last doubling may grow over the first one (a literal). */
const SPAN_GROWTH_MAX = 1.1;
/** The item's title; every blurb below fits the blurb's storage cap (4 000) at its largest. */
const TITLE = "Lamar Jackson: Notes | ";
/** The shortest blurb a family is read at (its unit repeated), then 2, 4 and 8 times as long. */
const BASE_CHARS = 500;

/** The steps one item's match takes. */
const workOf = (matcher: Pick<PlayerMatcher, "matchItem">, text: string): number =>
  countMatchWork(() => matcher.matchItem(text)).steps;

/** The work of `make(k)` at k, 2k, 4k and 8k, and the work each doubling adds per unit added. */
function doublings(
  make: (k: number) => string,
  k: number,
  matcher: Pick<PlayerMatcher, "matchItem"> = m,
): { readonly work: number[]; readonly added: number[] } {
  const work = [1, 2, 4, 8].map((x) => workOf(matcher, make(k * x)));
  // the work added per unit by each doubling: (W(2x) - W(x)) / x
  const added = [1, 2, 4].map((x, i) => ((work[i + 1] ?? 0) - (work[i] ?? 0)) / (k * x));
  return { work, added };
}

/** Whether the work added per unit never grows past the bounds, with the numbers for a message. */
function linear(d: { readonly work: number[]; readonly added: number[] }): {
  readonly ok: boolean;
  readonly evidence: string;
} {
  const [a, b, c] = d.added;
  if (a === undefined || b === undefined || c === undefined) throw new Error("three doublings");
  const steps = [b / a, c / b];
  const span = c / a;
  return {
    ok: steps.every((r) => r <= GROWTH_MAX) && span <= SPAN_GROWTH_MAX,
    evidence: `work ${d.work.join(" ")}; added per unit ${d.added.map((x) => x.toFixed(1)).join(" ")}; growth ${steps.map((r) => r.toFixed(3)).join(" ")}, span ${span.toFixed(3)}`,
  };
}

/** A unit repeated `k` times after the title. */
const repeated =
  (unit: string) =>
  (k: number): string =>
    `${TITLE}${unit.repeat(k)}`;
const unitsIn = (unit: string): number => Math.max(1, Math.floor(BASE_CHARS / unit.length));

/** The perf file's and the R8 rounds' attack constructions, and a benign item, as repeated units. */
// prettier-ignore
const FAMILIES: Readonly<Record<string, string>> = {
  benign: "Notes on the week ahead. ",
  // R8-8 (1): bare shared surnames before a word that opens a form; team-word surnames; possessives
  newForms: "Jones New Smith New Brown New Green New Wilson New Allen New Young New ",
  brown: "Brown ", houston: "Houston ", henderson: "Henderson's ", washington: "Washington ",
  surnames: "Jones Allen Park Smith Brown Green Washington ",
  // R8-6's second build: each new reading, at the caps
  compounds: "#QwertyUiop AsdfGhjkl ", domains: "www.abcdefghij.com per qrs.tuvwx.net ",
  tags: "<p>abc</p><br>def\n", openTags: `<a${"x".repeat(480)}`, entities: "&amp;amp;amp;lt;b&amp;gt; ",
  quotes: "'abc def' ghi's ", hyphens: "a-b-c-d-e-f-g-h ", camelPairs: "aB ", heads: "St St Bank of ",
  labels: "Ravens QB Lamar Jackson, LB Justin Jefferson (CLE - LB), ",
  // a shared name and a team beside it, again and again (the two quadratics the count found)
  sharedTagged: "Justin Jefferson, Vikings: ", sharedAbbreviated: "Lamar Jackson NE ",
  // a unique name and its team, again and again (teams.ts' attached and moved teams)
  uniqueTagged: "Patrick Mahomes KC ", uniqueSurname: "Mahomes KC ",
  // R8-3's attack: abbreviations and team names after a shared name
  abbreviations: "NE ", teamNames: "Jets ",
};

describe("news matcher — R10-16: the work per item grows linearly with the item, by count", () => {
  it.each(Object.entries(FAMILIES))("%s: each doubling adds the same work", (_name, unit) => {
    const d = doublings(repeated(unit), unitsIn(unit));
    expect(TITLE.length + unit.length * unitsIn(unit) * 8).toBeLessThanOrEqual(
      TITLE.length + 4_000,
    );
    const v = linear(d);
    expect(v.ok, v.evidence).toBe(true);
  });

  it("one long word (hyphenated, dotted): each doubling of the word adds the same work", () => {
    for (const unit of ["st-", "ab."]) {
      const v = linear(doublings(repeated(unit), 160));
      expect(v.ok, `${unit} ${v.evidence}`).toBe(true);
    }
  });

  it.each([
    ["a shared surname", "Brown "],
    ["a shared full name", "Justin Jefferson "],
    ["a unique full name", "Patrick Mahomes "],
    ["a labelled shared surname", "Vikings WR Jefferson "],
    ["a team-word surname", "Washington "],
    ["a shared name with a tag", "Lamar Jackson (BAL): "],
  ])(
    "at a fixed length, the work per mention does not grow with the mention count: %s",
    (_n, mention) => {
      // 64 blocks of the same length: `n` open with the mention, the rest with filler of its length,
      // each followed by the same words (every mention stands in the same words, whatever the count)
      const filler = "x".repeat(mention.length - 1);
      const tail = "notes on the week ahead and more notes. ";
      const item = (n: number): string =>
        `${TITLE}${Array.from({ length: 64 }, (_, i) => `${i % (64 / n) === 0 ? mention : `${filler} `}${tail}`).join("")}`;
      const work = [8, 16, 32, 64].map((n) => workOf(m, item(n)));
      expect(new Set([8, 16, 32, 64].map((n) => item(n).length)).size).toBe(1);
      const added = [8, 16, 32].map((n, i) => ((work[i + 1] ?? 0) - (work[i] ?? 0)) / n);
      const v = linear({ work, added });
      expect(v.ok, v.evidence).toBe(true);
    },
  );
});

/** The bare shared surnames the controls re-read at. */
const SHARED = /\b(?:Brown|Houston|Henderson|Washington|Jones|Smith)\b/gu;

/**
 * The matcher with one more scan, counted as its own steps are: at every `every`-th shared-surname
 * mention, a pass over every token of the item — quadratic in the mentions, so in a repeated item's
 * length, and cheap per mention.
 */
function quadratic(every: number): Pick<PlayerMatcher, "matchItem"> {
  return {
    matchItem: (text) => {
      const out = m.matchItem(text);
      const tokens = text.split(" ");
      let n = 0;
      for (const _hit of text.matchAll(SHARED))
        if (n++ % every === 0)
          for (const _t of tokens) if (matchWork !== null) matchWork.steps += 1;
      return out;
    },
  };
}

describe("news matcher — R10-16's positive controls: the check fails a quadratic that is cheap per mention", () => {
  it("a scan of every token at each bare shared-surname mention fails", () => {
    const unit = "Brown ";
    const v = linear(doublings(repeated(unit), unitsIn(unit), quadratic(1)));
    expect(v.ok, v.evidence).toBe(false);
  });

  it("one whose extra scan is only half the linear work at the caps fails too (the timing ratios' blind spot)", () => {
    for (const unit of [
      "Brown ",
      "Jones New Smith New Brown New Green New Wilson New Allen New Young New ",
    ]) {
      const k = unitsIn(unit);
      const plain = doublings(repeated(unit), k).work[3] ?? 0;
      // the sparsest scan whose extra work at the largest item is still half the linear reading's
      let every = 1;
      while (workOf(quadratic(every * 2), repeated(unit)(8 * k)) - plain >= plain / 2) every *= 2;
      const extra = workOf(quadratic(every), repeated(unit)(8 * k)) - plain;
      expect(extra / plain, unit).toBeGreaterThanOrEqual(0.5);
      expect(extra / plain, unit).toBeLessThan(1.1);
      const v = linear(doublings(repeated(unit), k, quadratic(every)));
      expect(v.ok, `${unit} every ${String(every)}: ${v.evidence}`).toBe(false);
    }
  });
});

describe("news matcher — R10-16: the count is a seam that changes nothing", () => {
  it("every item matches the same with a count open, and none is left open after", () => {
    const items = [
      ...Object.values(FAMILIES).map((u) => repeated(u)(unitsIn(u) * 8)),
      "Justin Jefferson: Questionable | Vikings WR Jefferson (hamstring) was limited.",
      "Chiefs DT Harris: Placed on IR | Harris is no relation to Titans CB Marcus Harris.",
      "Bengals sign CB Lamar Jackson | Lamar Jackson, Bengals: joins the practice squad.",
      "Terry McLaurin: Scores twice | Washington (ankle) did not return.",
    ];
    for (const text of items) {
      const plain = JSON.stringify(m.matchItem(text));
      const counted = countMatchWork(() => m.matchItem(text));
      expect(JSON.stringify(counted.value)).toBe(plain);
      expect(counted.steps).toBeGreaterThan(0);
      expect(matchWork).toBeNull();
    }
  });

  it("a count is closed when the counted work throws, and an inner count is its own", () => {
    expect(() =>
      countMatchWork(() => {
        throw new Error("x");
      }),
    ).toThrow("x");
    expect(matchWork).toBeNull();
    const own = "Patrick Mahomes KC: Notes";
    const other = "Justin Jefferson: Questionable | Vikings WR Jefferson (hamstring) was limited.";
    const outer = countMatchWork(() => {
      m.matchItem(own);
      return countMatchWork(() => m.matchItem(other)).steps;
    });
    // each count holds its own item's steps: the outer one not the inner one's
    expect(outer.value).toBe(workOf(m, other));
    expect(outer.steps).toBe(workOf(m, own));
    expect(matchWork).toBeNull();
  });
});
