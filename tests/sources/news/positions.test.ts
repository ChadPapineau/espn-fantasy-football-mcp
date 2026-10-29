// positions.test.ts — the closed position vocabulary of the news matcher (src/sources/news/positions.ts;
// ruling R8-6, docs/plan/changelog.md §R8: a position "directly before" a shared name, "in
// parentheses directly after it" or "in the headline's name tag" labels him, a label must fit "position
// from ESPN position_id", and the broad scan finds "a position in every written form (hyphenated,
// abbreviated, singular/plural)"). The ids are ESPN's position ids (src/domain/league/slots.ts
// POSITION_NAMES). Every list is held here word for word and, from these literals, entry by entry
// through a behaviour: a deleted entry fails a behaviour test as well as the literal. Where a position
// is read — next to the name, and anywhere for the scan — is labels.ts', held by match-r86.test.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { POSITION_NAMES } from "../../../src/domain/league/slots.js";
import {
  AMBIGUOUS_LABEL_WORDS,
  CAPS_ONLY_POSITION_ABBREVIATIONS,
  isAmbiguousLabelWord,
  KNOWN_POSITION_IDS,
  pluralOf,
  POSITION_ABBREVIATIONS,
  POSITION_WORDS,
  positionFound,
  positionKey,
  positionLabelIds,
  SCAN_ONLY_ABBREVIATIONS,
  SCAN_ONLY_WORDS,
} from "../../../src/sources/news/index.js";

const ids = (written: string): number[] | null => {
  const s = positionLabelIds(written);
  return s === null ? null : [...s].sort((a, b) => a - b);
};

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
const RUSHER = [9, 10, 11];
const DB = [12, 13];
const DEFENSE = [9, 10, 11, 12, 13];
const OL: number[] = [];
// prettier-ignore
const ABBREVIATIONS: Readonly<Record<string, readonly number[]>> = {
  QB, RB, HB: RB, FB: RB, WR, TE, K, PK: K, P,
  DT, NT: DT, LDT: DT, RDT: DT, DE, LDE: DE, RDE: DE, DL, IDL: DL,
  EDGE, OLB: EDGE, LOLB: EDGE, ROLB: EDGE,
  LB, ILB: LB, MLB: LB, WLB: LB, SLB: LB, LILB: LB, RILB: LB,
  CB, RCB: CB, LCB: CB, NCB: CB, S, FS: S, SS: S, NB: DB, DB,
  OL, OT: OL, OG: OL,
};
// prettier-ignore
const WORDS: Readonly<Record<string, readonly number[]>> = {
  quarterback: QB, "signal caller": QB,
  "running back": RB, halfback: RB, tailback: RB, fullback: RB,
  receiver: WR, wideout: WR, "wide receiver": WR, "slot receiver": WR,
  "tight end": TE,
  kicker: K, placekicker: K, punter: P,
  "defensive tackle": DT, "nose tackle": DT, "d-tackle": DT,
  "defensive end": DE, "d-end": DE,
  lineman: DL, "d-lineman": DL, "defensive lineman": DL, "3-technique": DL,
  "edge rusher": EDGE, "outside linebacker": EDGE,
  linebacker: LB, "inside linebacker": LB, "middle linebacker": LB,
  "pass rusher": RUSHER,
  cornerback: CB, corner: CB, "slot corner": CB,
  safety: S, "free safety": S, "strong safety": S,
  "nickel back": DB, "defensive back": DB,
  defender: DEFENSE, "defensive player": DEFENSE,
  "offensive lineman": OL,
};
const AMBIGUOUS = ["corner", "safety"];
// prettier-ignore
const SCAN_ABBREVIATIONS = [
  "LT", "RT", "LG", "RG", "C", "LS", "KR", "PR", "ST", "DI", "ATH", "MIKE", "WILL", "SAM",
];
// prettier-ignore
const SCAN_WORDS = [
  "tackle", "guard", "center", "centre", "nose", "rusher", "backer", "off-ball", "rover",
  "returner", "return man", "snapper", "gunner", "holder", "specialist", "special teams",
  "special teamer", "tackler", "pass catcher", "flanker", "split end", "slot", "h-back",
  "wingback", "slotback", "scatback", "nickel", "dime", "dimeback",
  "secondary", "defensive line", "offensive line", "o-line", "d-line", "defensive front",
  "defensive interior", "front seven", "pass rush", "linebacking", "receiving corps", "backfield",
];
// prettier-ignore
const CAPS_ONLY = ["C", "DE", "DI", "K", "LB", "LT", "MIKE", "OL", "P", "S", "SAM", "ST", "WILL"];

const sorted = (o: Readonly<Record<string, unknown>> | readonly string[]): unknown =>
  Array.isArray(o)
    ? [...(o as readonly string[])].sort()
    : Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe("the vocabulary is closed and maps to ESPN's position ids", () => {
  it("word for word", () => {
    expect(sorted(POSITION_ABBREVIATIONS)).toEqual(sorted(ABBREVIATIONS));
    expect(sorted(POSITION_WORDS)).toEqual(sorted(WORDS));
    expect(sorted(AMBIGUOUS_LABEL_WORDS)).toEqual(sorted(AMBIGUOUS));
    expect(sorted(SCAN_ONLY_ABBREVIATIONS)).toEqual(sorted(SCAN_ABBREVIATIONS));
    expect(sorted(SCAN_ONLY_WORDS)).toEqual(sorted(SCAN_WORDS));
    expect(sorted(CAPS_ONLY_POSITION_ABBREVIATIONS)).toEqual(sorted(CAPS_ONLY));
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
    // out every holder of another ESPN position. At dbe9686 DT and DE were {DT, DE}, CB and S {CB, S},
    // LB {DE, LB}: "Vikings CB Smith" went to the Vikings S, and no label reached the Eagles DT.
    for (const [abbr, word] of [
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
      const id = Object.entries(POSITION_NAMES).find(([, n]) => n === abbr)?.[0];
      expect(ids(abbr), abbr).toEqual([Number(id)]);
      expect(ids(word), word).toEqual([Number(id)]);
    }
    // a writer's group forms span the ids a player they describe may carry
    expect(ids("DL")).toEqual([9, 10]);
    expect(ids("EDGE")).toEqual([10, 11]);
    expect(ids("OLB")).toEqual([10, 11]);
    expect(ids("DB")).toEqual([12, 13]);
    expect(ids("edge rusher")).toEqual([10, 11]);
    expect(ids("defender")).toEqual([9, 10, 11, 12, 13]);
  });
});

describe("a label's position (R8-6 (a))", () => {
  it("each abbreviation, in capitals only, its rank allowed", () => {
    for (const [form, want] of Object.entries(ABBREVIATIONS)) {
      expect(ids(form), form).toEqual([...want]);
      // a depth chart's rank: "LB1", "CB2", "WR10" (at dbe9686 only QB, RB, WR and TE 1–3)
      for (const rank of ["1", "2", "4", "10"])
        expect(ids(`${form}${rank}`), `${form}${rank}`).toEqual([...want]);
      // in lower case or title case it is no label ("lb" is a pound; "Lb")
      if (!(form.toLowerCase() in WORDS)) {
        expect(ids(form.toLowerCase()), form.toLowerCase()).toBeNull();
        if (form.length > 1)
          expect(ids(`${form.slice(0, 1)}${form.slice(1).toLowerCase()}`)).toBeNull();
      }
    }
    expect(ids("LB0")).toBeNull();
    expect(ids("LB100")).toBeNull();
  });

  it("each word, in any case and spacing, hyphenated or glued", () => {
    for (const [form, want] of Object.entries(WORDS)) {
      expect(ids(form), form).toEqual([...want]);
      expect(ids(form.toUpperCase()), form.toUpperCase()).toEqual([...want]);
      expect(ids(form.replace(/\b\p{L}/gu, (c) => c.toUpperCase())), form).toEqual([...want]);
      expect(ids(form.replaceAll(" ", "-")), form).toEqual([...want]);
      expect(ids(form.replace(/[\s-]/gu, "")), form).toEqual([...want]);
    }
    // a hyphen inside a one-word form ("wide-out", "full-back", "place-kicker")
    expect(ids("wide-out")).toEqual(WR);
    expect(ids("full-back")).toEqual(RB);
    expect(ids("half-back")).toEqual(RB);
    expect(ids("place-kicker")).toEqual(K);
    expect(ids("RUNNING  BACK")).toEqual(RB);
  });

  it("the scan's forms are never labels: a verb or a common noun before a name, a role", () => {
    for (const w of [...SCAN_WORDS, ...SCAN_ABBREVIATIONS]) expect(ids(w), w).toBeNull();
    for (const w of [
      "star",
      "starter",
      "rookie",
      "back",
      "end",
      "line",
      "free-agent",
      "edge",
      "Edge",
    ])
      expect(ids(w), w).toBeNull();
  });

  it("each ambiguous label word is known as one; no other word is", () => {
    for (const w of AMBIGUOUS) {
      expect(isAmbiguousLabelWord(w), w).toBe(true);
      expect(isAmbiguousLabelWord(w.toUpperCase()), w).toBe(true);
    }
    for (const w of ["cornerback", "free safety", "slot corner", "linebacker", "CB", "S"])
      expect(isAmbiguousLabelWord(w), w).toBe(false);
  });

  it("property: no arbitrary word is a position unless it is a listed form", () => {
    const listed = new Set(
      [...Object.keys(WORDS)].flatMap((w) => {
        const k = positionKey(w);
        return [k, k.replaceAll(" ", "-"), k.replace(/[\s-]/gu, "")];
      }),
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z-]{1,12}$/), (w) => {
        if (ids(w) === null) return;
        const k = positionKey(w);
        const abbreviation = w === w.toUpperCase() && /^(\p{Lu}+?)([1-9][0-9]?)?$/u.test(w);
        expect(
          listed.has(k) ||
            listed.has(k.replaceAll("-", "")) ||
            (abbreviation && w.replace(/[0-9]+$/u, "") in ABBREVIATIONS),
          w,
        ).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });
});

describe("the scan's positions (R8-6 (b)): every form, its plural, the ambiguous tokens", () => {
  it("each word form, each spelling, each plural, in any case", () => {
    for (const w of [...Object.keys(WORDS), ...SCAN_WORDS]) {
      for (const v of [w, w.replaceAll(" ", "-"), w.replace(/[\s-]/gu, "")]) {
        for (const c of [v, pluralOf(v)]) {
          expect(positionFound(c), c).toBe(true);
          expect(positionFound(c.toUpperCase()), c.toUpperCase()).toBe(true);
        }
      }
    }
  });

  it("each abbreviation in capitals, its plural and its rank; in lower case unless caps-only", () => {
    for (const a of [...Object.keys(ABBREVIATIONS), ...SCAN_ABBREVIATIONS]) {
      for (const v of [a, `${a}s`, `${a}S`, `${a}1`, `${a}4`, `${a}10`, `${a}1s`])
        expect(positionFound(v), v).toBe(true);
      const caps = CAPS_ONLY.includes(a);
      // "lb" is a pound, "will" a verb, "s" a letter: only in capitals; "cb", "olb", "idl" in any case
      for (const v of [a.toLowerCase(), `${a.slice(0, 1)}${a.slice(1).toLowerCase()}`]) {
        if (v === a || v.toLowerCase() in WORDS || SCAN_WORDS.includes(v.toLowerCase())) continue;
        expect(positionFound(v), v).toBe(!caps);
        const plural = `${v}s`;
        const another =
          plural.toUpperCase() in ABBREVIATIONS ||
          SCAN_ABBREVIATIONS.includes(plural.toUpperCase());
        if (!another) expect(positionFound(plural), plural).toBe(!caps);
      }
    }
    // the edge: the EDGE abbreviation in any case ("edge" is no label, a verb before a name)
    expect(positionFound("edge")).toBe(true);
    expect(positionFound("Edge")).toBe(true);
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
        expect(positionFound(v), v).toBe(true);
    for (const v of ["4i", "2i", "4i-technique", "1-TECH", "5-Technique"])
      expect(positionFound(v), v).toBe(true);
    for (const v of ["tech", "technique", "1", "10-tech", "ten-technique", "4", "high-tech"])
      expect(positionFound(v), v).toBe(false);
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

  it("an ambiguous token counts as found; an initial, a time, a plain word does not", () => {
    for (const w of [
      "OT",
      "corner",
      "safety",
      "edge",
      "Tackle",
      "guard",
      "center",
      "slot",
      "dime",
      "nose",
    ])
      expect(positionFound(w), w).toBe(true);
    for (const w of [
      "lb",
      "Lb",
      "lbs",
      "will",
      "s",
      "P.J",
      "PJ",
      "PM",
      "back",
      "end",
      "line",
      "starter",
      "team",
    ])
      expect(positionFound(w), w).toBe(false);
  });
});
