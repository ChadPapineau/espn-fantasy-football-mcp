// positions.test.ts — the closed position vocabulary of the news matcher (src/sources/news/positions.ts;
// ruling R8-6, docs/plan/changelog.md §R8: a position "directly before" a shared name, "in
// parentheses directly after it" or "in the headline's name tag" labels him, a label must fit "position
// from ESPN position_id", and the broad scan finds a position in every written form; ruling R8-7 (1):
// the forms are "every ESPN position, its standard abbreviations and the alignment words ('weakside',
// 'strongside', 'Mike', 'Will', 'Sam'), each written glued, hyphenated or with a space, singular or
// plural", and (3) every form the scan reads is a label form). The ids are ESPN's position ids
// (src/domain/league/slots.ts POSITION_NAMES). Every list is held here word for word and, from these
// literals, entry by entry through a behaviour: a deleted entry fails a behaviour test as well as the
// literal. Where a position is read and in which case an abbreviation counts (R8-7 (2)) is labels.ts',
// held by match-r86.test.ts and match-r87.test.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { POSITION_NAMES } from "../../../src/domain/league/slots.js";
import {
  AMBIGUOUS_LABEL_WORDS,
  isAmbiguousLabelWord,
  KNOWN_POSITION_IDS,
  pluralOf,
  POSITION_ABBREVIATIONS,
  POSITION_WORDS,
  positionAbbreviation,
  positionKey,
  positionWordIds,
  spellingsOf,
} from "../../../src/sources/news/index.js";

const sortedIds = (ids: readonly number[] | null | undefined): number[] | null =>
  ids === null || ids === undefined ? null : [...ids].sort((a, b) => a - b);
const word = (written: string): number[] | null => sortedIds(positionWordIds(written));
const abbr = (written: string): number[] | null =>
  sortedIds(positionAbbreviation(written)?.ids ?? null);

const QB = [1];
const RB = [2];
const WR = [3];
const TE = [4];
const K = [5];
const P = [7];
const DT = [9];
const DE = [10];
const LB = [11];
const CB = [12];
const S = [13];
const DL = [9, 10];
const EDGE = [10, 11];
const FRONT = [9, 10, 11];
const DB = [12, 13];
const ROVER = [11, 12, 13];
const DEFENSE = [9, 10, 11, 12, 13];
const RETURNER = [2, 3, 12, 13];
const GUNNER = [3, 12, 13];
const CATCHER = [2, 3, 4];
const BACK = [2, 3];
const H_BACK = [2, 4];
const SLOT = [3, 12];
const CORPS = [3, 4];
const BACKFIELD = [1, 2, 12, 13];
const HOLDER = [1, 7];
const SPECIALIST = [5, 7];
const ANY = [1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13];
const OL: number[] = [];
// prettier-ignore
const ABBREVIATIONS: Readonly<Record<string, readonly number[]>> = {
  QB, RB, HB: RB, FB: RB, WR, TE, K, PK: K, P,
  DT, NT: DT, LDT: DT, RDT: DT, DE, LDE: DE, RDE: DE, DL, IDL: DL, DI: DL,
  EDGE, OLB: EDGE, LOLB: EDGE, ROLB: EDGE, WILL: EDGE, SAM: EDGE,
  LB, ILB: LB, MLB: LB, WLB: LB, SLB: LB, LILB: LB, RILB: LB, MIKE: LB,
  CB, RCB: CB, LCB: CB, NCB: CB, S, FS: S, SS: S, SAF: S, NB: DB, DB,
  KR: RETURNER, PR: RETURNER, ST: ANY, ATH: ANY,
  OL, OT: OL, OG: OL, G: OL, C: OL, LT: OL, RT: OL, LG: OL, RG: OL, IOL: OL, LS: OL,
};
// prettier-ignore
const WORDS: Readonly<Record<string, readonly number[]>> = {
  "quarter back": QB, "signal caller": QB,
  "running back": RB, "half back": RB, "tail back": RB, "full back": RB,
  receiver: WR, "wide out": WR, "wide receiver": WR, "slot receiver": WR, flanker: WR,
  "split end": WR,
  "tight end": TE,
  kicker: K, "place kicker": K, punter: P,
  "defensive tackle": DT, "nose tackle": DT, "d tackle": DT, nose: DT,
  "defensive end": DE, "d end": DE,
  "line man": DL, "d line man": DL, "defensive line man": DL, tackle: DL,
  "d line": DL, "defensive line": DL, "defensive interior": DL,
  "edge rusher": EDGE, "outside line backer": EDGE, backer: EDGE, "line backing": EDGE,
  "line backer": LB, "inside line backer": LB, "middle line backer": LB, "off ball": LB,
  "pass rusher": FRONT, rusher: FRONT, "pass rush": FRONT, "defensive front": FRONT,
  "front seven": FRONT, "weak side": FRONT, "strong side": FRONT,
  "corner back": CB, corner: CB, "slot corner": CB,
  safety: S, "free safety": S, "strong safety": S,
  "nickel back": DB, "defensive back": DB, nickel: DB, dime: DB, "dime back": DB, secondary: DB,
  rover: ROVER,
  defender: DEFENSE, "defensive player": DEFENSE, tackler: DEFENSE,
  returner: RETURNER, "return man": RETURNER, gunner: GUNNER,
  "pass catcher": CATCHER, "wing back": BACK, "slot back": BACK, "scat back": BACK,
  "h back": H_BACK, slot: SLOT, "receiving corps": CORPS, "back field": BACKFIELD,
  holder: HOLDER, specialist: SPECIALIST, "special teams": ANY, "special teamer": ANY,
  "offensive line man": OL, "offensive line": OL, "o line": OL, guard: OL, center: OL,
  centre: OL, snapper: OL, "long snapper": OL,
};
// prettier-ignore
const AMBIGUOUS = [
  "back field", "corner", "dime", "gunner", "holder", "nickel", "nose", "rover", "safety",
  "secondary", "slot", "specialist", "tackle",
];

const sorted = (o: Readonly<Record<string, unknown>> | readonly string[]): unknown =>
  Array.isArray(o)
    ? [...(o as readonly string[])].sort()
    : Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe("the vocabulary is closed and maps to ESPN's position ids", () => {
  it("word for word", () => {
    expect(sorted(POSITION_ABBREVIATIONS)).toEqual(sorted(ABBREVIATIONS));
    expect(sorted(POSITION_WORDS)).toEqual(sorted(WORDS));
    expect(sorted(AMBIGUOUS_LABEL_WORDS)).toEqual(sorted(AMBIGUOUS));
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
  });

  it("ESPN's own position, abbreviated or spelled out, fits only its own id (fail closed)", () => {
    // R8-6 (a): "position from ESPN position_id"; R8-3 clause 4, choice 6(c): a written position rules
    // out every holder of another ESPN position
    for (const [a, w] of [
      ["QB", "quarterback"],
      ["RB", "running back"],
      ["WR", "wide receiver"],
      ["TE", "tight end"],
      ["K", "kicker"],
      ["P", "punter"],
      ["DT", "defensive tackle"],
      ["DE", "defensive end"],
      ["LB", "linebacker"],
      ["CB", "cornerback"],
      ["S", "safety"],
    ] as const) {
      const id = Object.entries(POSITION_NAMES).find(([, n]) => n === a)?.[0];
      expect(abbr(a), a).toEqual([Number(id)]);
      expect(word(w), w).toEqual([Number(id)]);
    }
    // a writer's group forms span the ids a player they describe may carry, wide rather than narrow
    expect(abbr("DL")).toEqual([9, 10]);
    expect(abbr("EDGE")).toEqual([10, 11]);
    expect(abbr("WILL")).toEqual([10, 11]);
    expect(abbr("MIKE")).toEqual([11]);
    expect(word("tackle")).toEqual([9, 10]);
    expect(word("weakside")).toEqual([9, 10, 11]);
    expect(word("defender")).toEqual([9, 10, 11, 12, 13]);
    // an offensive-line form fits no universe player
    expect(abbr("OT")).toEqual([]);
    expect(word("guard")).toEqual([]);
  });

  it("R8-7 (1): every ESPN position, its standard abbreviations and the alignment words are listed", () => {
    for (const [ids, forms] of [
      [QB, ["QB", "quarterback", "signal caller"]],
      [RB, ["RB", "HB", "FB", "running back", "halfback", "tailback", "fullback"]],
      [WR, ["WR", "wide receiver", "wideout", "slot receiver", "flanker", "split end"]],
      [TE, ["TE", "tight end"]],
      [K, ["K", "PK", "kicker", "placekicker"]],
      [P, ["P", "punter"]],
      [DT, ["DT", "NT", "defensive tackle", "nose tackle"]],
      [DE, ["DE", "defensive end"]],
      [LB, ["LB", "ILB", "MLB", "linebacker", "MIKE"]],
      [CB, ["CB", "cornerback", "corner"]],
      [S, ["S", "FS", "SS", "safety", "free safety", "strong safety"]],
    ] as const)
      for (const f of forms) {
        const got = /^[A-Z]+$/u.test(f) ? abbr(f) : word(f);
        expect(got, f).toEqual([...ids]);
      }
    // the alignment words the ruling names
    for (const f of ["weakside", "strongside", "weak-side", "strong side", "weaksides"])
      expect(word(f), f).toEqual(FRONT);
    for (const f of ["MIKE", "WILL", "SAM"]) expect(abbr(f), f).not.toBeNull();
  });
});

describe("spellings: glued, hyphenated or with a space, each join chosen apart", () => {
  it("a two-part form", () => {
    expect(spellingsOf("half back").sort()).toEqual(["half back", "half-back", "halfback"]);
    expect(spellingsOf("d line").sort()).toEqual(["d line", "d-line", "dline"]);
  });
  it("a three-part form: nine spellings", () => {
    expect(spellingsOf("d line man")).toHaveLength(9);
    expect(spellingsOf("d line man")).toEqual(
      expect.arrayContaining(["d-lineman", "d lineman", "dlineman", "d line man", "d-line-man"]),
    );
  });
  it("R8-7 (1): the spaced spellings the last attack found missing (violation 10)", () => {
    // "The D line reserve was let go" (the TEN CB at 0.80 at 66bb2a2)
    for (const [f, ids] of [
      ["D line", DL],
      ["O line", OL],
      ["half back", RB],
      ["full back", RB],
      ["tail back", RB],
      ["wide out", WR],
      ["wing back", BACK],
      ["scat back", BACK],
      ["off ball", LB],
      ["h back", H_BACK],
      ["line backer", LB],
      ["corner back", CB],
      ["place kicker", K],
      ["quarter back", QB],
    ] as const)
      expect(word(f), f).toEqual([...ids]);
  });
});

describe("a position abbreviation (labels and the scan)", () => {
  it("each abbreviation, any case here (labels.ts reads the case), its rank and its plural", () => {
    for (const [form, want] of Object.entries(ABBREVIATIONS)) {
      // a plural that is an abbreviation of its own is that one ("SS", strong safety, beside "S")
      const another = `${form}S` in ABBREVIATIONS;
      for (const w of [form, form.toLowerCase(), `${form}1`, `${form}10`])
        expect(abbr(w), w).toEqual(sortedIds(want));
      if (another) expect(abbr(`${form}s`), form).toEqual(sortedIds(ABBREVIATIONS[`${form}S`]));
      else
        for (const w of [`${form}s`, `${form}S`]) {
          expect(abbr(w), w).toEqual(sortedIds(want));
          expect(positionAbbreviation(w)?.stem, w).toBe(form);
        }
      expect(positionAbbreviation(`${form}2`)?.stem, form).toBe(form);
    }
    expect(abbr("LB0")).toBeNull();
    expect(abbr("LB100")).toBeNull();
    expect(abbr("WR1s")).toEqual(WR);
  });
});

describe("a position word (labels and the scan)", () => {
  it("each word, in any case and every spelling, and its plural", () => {
    for (const [form, want] of Object.entries(WORDS))
      for (const sp of spellingsOf(form))
        for (const w of [sp, sp.toUpperCase(), sp.replace(/\b\p{L}/gu, (c) => c.toUpperCase())]) {
          expect(word(w), w).toEqual(sortedIds(want));
          expect(word(pluralOf(w.toLowerCase())), pluralOf(w)).toEqual(sortedIds(want));
        }
    expect(word("RUNNING  BACK")).toEqual(RB);
  });

  it("a technique: an alignment number (a digit or its word, an 'i' allowed) and tech or technique", () => {
    // prettier-ignore
    const numbers = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "zero", "one", "two", "three",
      "four", "five", "six", "seven", "eight", "nine"];
    for (const n of numbers)
      for (const v of [
        `${n}-tech`,
        `${n}-technique`,
        `${n} technique`,
        `${n}tech`,
        `${n}-techniques`,
      ])
        expect(word(v), v).toEqual(DL);
    for (const v of ["4i", "2i", "4i-technique", "1-TECH", "5-Technique"])
      expect(word(v), v).toEqual(DL);
    for (const v of ["tech", "technique", "1", "10-tech", "ten-technique", "4", "high-tech"])
      expect(word(v), v).toBeNull();
  });

  it("plurals: a lineman's men, a safety's ies, any other word's s", () => {
    expect(pluralOf("lineman")).toBe("linemen");
    expect(pluralOf("d-lineman")).toBe("d-linemen");
    expect(pluralOf("return man")).toBe("return men");
    expect(pluralOf("safety")).toBe("safeties");
    expect(pluralOf("secondary")).toBe("secondaries");
    expect(pluralOf("running back")).toBe("running backs");
    expect(pluralOf("tight end")).toBe("tight ends");
  });

  it("no plain word is a position: the parts of a form, a role word, an initial, a time", () => {
    for (const w of [
      "back",
      "end",
      "line",
      "starter",
      "star",
      "rookie",
      "team",
      "edge",
      "free-agent",
    ])
      expect(word(w), w).toBeNull();
    for (const w of ["P.J", "PJ", "PM", "AM", "IR", "I", "A", "US"]) expect(abbr(w), w).toBeNull();
  });

  it("each ambiguous label word is known as one, in every spelling; no other word is", () => {
    for (const w of AMBIGUOUS)
      for (const sp of spellingsOf(w)) {
        expect(isAmbiguousLabelWord(sp), sp).toBe(true);
        expect(isAmbiguousLabelWord(sp.toUpperCase()), sp).toBe(true);
      }
    for (const w of [
      "cornerback",
      "free safety",
      "slot corner",
      "linebacker",
      "CB",
      "S",
      "receiver",
    ])
      expect(isAmbiguousLabelWord(w), w).toBe(false);
  });

  it("property: no arbitrary word is a position unless it is a listed form", () => {
    const listed = new Set(
      Object.keys(WORDS).flatMap((w) => spellingsOf(w).flatMap((sp) => [sp, pluralOf(sp)])),
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z-]{1,12}$/), (w) => {
        if (word(w) !== null) expect(listed.has(positionKey(w)), w).toBe(true);
        if (abbr(w) !== null)
          expect(
            w.toUpperCase().replace(/[0-9]+S?$|S$/u, "") in ABBREVIATIONS ||
              w.toUpperCase() in ABBREVIATIONS,
            w,
          ).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });
});
