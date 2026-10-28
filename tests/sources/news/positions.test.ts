// positions.test.ts — the closed position vocabulary of the news matcher (src/sources/news/positions.ts;
// ruling R8-6, docs/plan/changelog.md §R8: a position "directly before" a shared name, "in
// parentheses directly after it" or "in the headline's name tag" labels him, and the broad scan finds
// "a position in every written form"; the ids are ESPN's `position_id`, R8-3 clause 4). The ids are
// ESPN's position ids (src/domain/league/slots.ts POSITION_NAMES, held equal to the provider's table
// elsewhere). Where a position is read — next to the name, and anywhere for the scan — is
// labels.ts', held by match-r86.test.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { POSITION_NAMES } from "../../../src/domain/league/slots.js";
import {
  KNOWN_POSITION_IDS,
  pluralOf,
  POSITION_ABBREVIATIONS,
  POSITION_WORDS,
  positionKey,
  positionLabelIds,
  RANKED_ABBREVIATIONS,
  SCAN_ONLY_ABBREVIATIONS,
  SCAN_ONLY_WORDS,
  SCAN_POSITION_ABBREVIATIONS,
  SCAN_POSITION_KEYS,
  scanFinds,
} from "../../../src/sources/news/index.js";

const ids = (written: string): number[] | null => {
  const s = positionLabelIds(written);
  return s === null ? null : [...s].sort((a, b) => a - b);
};

describe("the vocabulary is closed and maps to ESPN's position ids", () => {
  it("every form, and the ids it names", () => {
    const families: Record<string, number[]> = {};
    for (const [w, v] of [
      ...Object.entries(POSITION_ABBREVIATIONS),
      ...Object.entries(POSITION_WORDS),
    ])
      families[w] = [...v];
    // prettier-ignore
    expect(families).toEqual({
      QB: [1], quarterback: [1], "signal-caller": [1], "signal caller": [1],
      RB: [2], HB: [2], FB: [2], "running back": [2], halfback: [2], tailback: [2], fullback: [2],
      WR: [3], receiver: [3], wideout: [3],
      TE: [4], "tight end": [4],
      K: [5], PK: [5], kicker: [5], placekicker: [5], "place-kicker": [5], P: [7], punter: [7],
      DT: [9, 10], DE: [9, 10], DL: [9, 10], NT: [9, 10], IDL: [9, 10], "defensive tackle": [9, 10],
      "nose tackle": [9, 10], "defensive end": [9, 10], lineman: [9, 10], "d-lineman": [9, 10],
      "d-tackle": [9, 10], "d-end": [9, 10], "3-technique": [9, 10],
      OLB: [10, 11], LB: [10, 11], ILB: [10, 11], MLB: [10, 11], WLB: [10, 11], SLB: [10, 11],
      "edge rusher": [10, 11], "edge-rusher": [10, 11], linebacker: [10, 11],
      // a pass rusher may be any of the front — ESPN lists the interior rusher Chris Jones as a DT
      "pass rusher": [9, 10, 11], "pass-rusher": [9, 10, 11],
      CB: [12, 13], RCB: [12, 13], LCB: [12, 13], NCB: [12, 13], NB: [12, 13], S: [12, 13],
      FS: [12, 13], SS: [12, 13], DB: [12, 13], cornerback: [12, 13], corner: [12, 13],
      nickelback: [12, 13], "nickel back": [12, 13], safety: [12, 13], "defensive back": [12, 13],
      defender: [9, 10, 11, 12, 13], "defensive player": [9, 10, 11, 12, 13],
      OL: [], OT: [], OG: [], "offensive lineman": [],
    });
    expect(RANKED_ABBREVIATIONS).toEqual(["QB", "RB", "WR", "TE"]);
    expect(SCAN_ONLY_ABBREVIATIONS).toEqual(["LT", "RT", "LG", "RG", "C", "LS", "KR", "PR"]);
    expect(SCAN_ONLY_WORDS).toContain("edge");
  });

  it("names only ESPN position ids of persons: QB RB WR TE K P DT DE LB CB S", () => {
    expect([...KNOWN_POSITION_IDS].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13,
    ]);
    expect([...KNOWN_POSITION_IDS].map((id) => POSITION_NAMES[id]).sort()).toEqual([
      "CB",
      "DE",
      "DT",
      "K",
      "LB",
      "P",
      "QB",
      "RB",
      "S",
      "TE",
      "WR",
    ]);
    // each family holds the ESPN label its words name
    for (const [word, label] of [
      ["quarterback", "QB"],
      ["running back", "RB"],
      ["wideout", "WR"],
      ["tight end", "TE"],
      ["kicker", "K"],
      ["punter", "P"],
      ["defensive tackle", "DT"],
      ["defensive end", "DE"],
      ["linebacker", "LB"],
      ["cornerback", "CB"],
      ["safety", "S"],
    ] as const)
      expect(
        (POSITION_WORDS[word] ?? []).map((id) => POSITION_NAMES[id]),
        word,
      ).toContain(label);
  });
});

describe("a label's position (R8-6 (a))", () => {
  it("an abbreviation counts only in capitals, its rank allowed; a word in any case and spacing", () => {
    expect(ids("LB")).toEqual([10, 11]);
    expect(ids("WR2")).toEqual([3]);
    expect(ids("QB1")).toEqual([1]);
    expect(ids("LB2")).toBeNull(); // only QB, RB, WR and TE carry a rank
    expect(ids("lb")).toBeNull();
    expect(ids("Lb")).toBeNull();
    expect(ids("Linebacker")).toEqual([10, 11]);
    expect(ids("RUNNING  BACK")).toEqual([2]);
    expect(ids("edge\u2011rusher")).toEqual([10, 11]); // a non-breaking hyphen
    expect(positionKey("Defensive\tEnd")).toBe("defensive end");
  });

  it("the scan's forms are never labels: a verb or a common noun before a name, a role", () => {
    for (const w of [...SCAN_ONLY_WORDS, ...SCAN_ONLY_ABBREVIATIONS]) expect(ids(w), w).toBeNull();
    for (const w of ["star", "starter", "rookie", "back", "end", "line", "free-agent"])
      expect(ids(w), w).toBeNull();
  });

  it("property: no arbitrary word is a position unless it is a listed form", () => {
    const listed = new Set([
      ...Object.keys(POSITION_ABBREVIATIONS),
      ...Object.keys(POSITION_WORDS).map(positionKey),
    ]);
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z-]{1,12}$/), (w) => {
        const rank = /^(QB|RB|WR|TE)[1-3]$/u.test(w);
        if (ids(w) !== null)
          expect(listed.has(w) || listed.has(positionKey(w)) || rank, w).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });
});

describe("the scan's positions (R8-6 (b)): every form, its plural, the ambiguous tokens", () => {
  it("every label form and every scan-only form, each with its plural", () => {
    for (const w of [...Object.keys(POSITION_WORDS), ...SCAN_ONLY_WORDS]) {
      expect(SCAN_POSITION_KEYS.has(w), w).toBe(true);
      expect(SCAN_POSITION_KEYS.has(pluralOf(w)), pluralOf(w)).toBe(true);
      expect(scanFinds(w.toUpperCase()), w).toBe(true);
    }
    for (const a of [...Object.keys(POSITION_ABBREVIATIONS), ...SCAN_ONLY_ABBREVIATIONS]) {
      expect(SCAN_POSITION_ABBREVIATIONS.has(a), a).toBe(true);
      expect(scanFinds(a), a).toBe(true);
      expect(scanFinds(`${a}s`), `${a}s`).toBe(true);
    }
    for (const a of RANKED_ABBREVIATIONS) expect(scanFinds(`${a}3`), a).toBe(true);
  });

  it("plurals: a lineman's men, a safety's ies, any other word's s", () => {
    expect(pluralOf("lineman")).toBe("linemen");
    expect(pluralOf("d-lineman")).toBe("d-linemen");
    expect(pluralOf("safety")).toBe("safeties");
    expect(pluralOf("running back")).toBe("running backs");
    expect(pluralOf("tight end")).toBe("tight ends");
  });

  it("an ambiguous token counts as found; a lower-case abbreviation or an initial does not", () => {
    for (const w of ["OT", "corner", "safety", "edge", "Tackle", "guard", "center"])
      expect(scanFinds(w), w).toBe(true);
    for (const w of ["ot", "lb", "Lb", "P.J", "back", "end", "line", "starter"])
      expect(scanFinds(w), w).toBe(false);
  });
});
