// normalize.test.ts — src/domain/crosswalk/normalize.ts: merge_name normalisation (research 04 §C
// step 2: lowercase, strip punctuation and Jr/Sr/II–V, ASCII-fold) and id cleaning; the fixture
// roster's suffix / apostrophe / hyphen / initials cases. Ported from sibling @8db206f, adapted.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
  NAME_SUFFIXES,
  cleanGsisId,
  cleanId,
  compareCodePoints,
  mergeName,
  nameKey,
  surnameKey,
} from "../../../src/domain/crosswalk/normalize.js";
import { FIXTURE } from "./helpers.js";

describe("mergeName", () => {
  it.each([
    ["Josh Allen", "josh allen"],
    ["James Cook III", "james cook"],
    ["Travis Etienne Jr.", "travis etienne"],
    ["Kyle Pitts Sr.", "kyle pitts"],
    ["Oronde Gadsden II", "oronde gadsden"],
    ["Harold Fannin Jr", "harold fannin"],
    ["Odell Beckham Jr. II", "odell beckham"],
    ["Amon-Ra St. Brown", "amonra st brown"],
    ["Jaxon Smith-Njigba", "jaxon smithnjigba"],
    ["Ja'Marr Chase", "jamarr chase"],
    ["Ja’Marr Chase", "jamarr chase"],
    ["Ka'imi Fairbairn", "kaimi fairbairn"],
    ["Kaʻimi Fairbairn", "kaimi fairbairn"],
    ["Ka´imi Fairbairn", "kaimi fairbairn"],
    ["C.J. Stroud", "cj stroud"],
    ["  JOSH\t\tALLEN  ", "josh allen"],
    ["Nîck Fölk", "nick folk"],
    ["Zdeněk Łukasz Ødegaard", "zdenek lukasz odegaard"],
    ["Björn Straße", "bjorn strasse"],
    ["İbrahim Ağır", "ibrahim agir"],
    ["José Ñúñez", "jose nunez"],
    ["Ｊｏｓｈ Allen", "josh allen"],
    ["Mike V", "mike v"],
    ["Jr Sr", "jr sr"],
    ["Walker III IV", "walker iii"],
  ])("%j → %j", (raw, want) => {
    expect(mergeName(raw)).toBe(want);
  });

  it("decomposed and precomposed diacritics give one name", () => {
    const precomposed = "José López";
    const decomposed = "José López";
    expect(precomposed).not.toBe(decomposed);
    expect(mergeName(precomposed)).toBe("jose lopez");
    expect(mergeName(decomposed)).toBe("jose lopez");
  });

  it("treats O'Neil, O’Neil and ONeil as one name", () => {
    expect(mergeName("Mike O'Neil")).toBe("mike oneil");
    expect(mergeName("Mike O’Neil")).toBe("mike oneil");
    expect(mergeName("Mike ONeil")).toBe("mike oneil");
  });

  it.each([
    ["Cyrillic А homoglyph", "Josh Аllen"],
    ["Greek ο homoglyph", "Jοsh Allen"],
    ["zero-width space", "Jo​sh Allen"],
    ["zero-width joiner", "Josh‍Allen"],
    ["soft hyphen", "Jo­sh Allen"],
    ["RTL override", "‮Josh Allen"],
    ["control char", "Josh\u0000Allen"],
    ["emoji", "Josh Allen \u{1F3C8}"],
    ["math symbol", "Josh + Allen"],
    ["markup", "<b>Josh</b> Allen"],
    ["CJK", "大谷 翔平"],
    ["only punctuation", "...---'''"],
    ["empty", ""],
    ["whitespace", "   "],
  ])("rejects (never merges) %s", (_label, raw) => {
    expect(mergeName(raw)).toBeNull();
    expect(nameKey(raw)).toBeNull();
    expect(surnameKey(raw)).toBeNull();
  });

  it("rejects non-strings and over-long names", () => {
    expect(mergeName(null)).toBeNull();
    expect(mergeName(undefined)).toBeNull();
    expect(mergeName(42)).toBeNull();
    expect(mergeName({ toString: () => "Josh Allen" })).toBeNull();
    expect(mergeName("a".repeat(MAX_NAME_CHARS))).toBe("a".repeat(MAX_NAME_CHARS));
    expect(mergeName("a".repeat(MAX_NAME_CHARS + 1))).toBeNull();
    expect(mergeName("x ".repeat(5_000_000))).toBeNull();
  });

  it("the suffix list is the research's Jr/Sr/II–V", () => {
    expect(NAME_SUFFIXES).toEqual(["jr", "sr", "ii", "iii", "iv", "v"]);
    expect(Object.isFrozen(NAME_SUFFIXES)).toBe(true);
  });

  it("normalises both sides of every fixture player to the same key", () => {
    for (const p of FIXTURE.players) {
      if (p.tags.includes("nickname_differs")) continue;
      expect(nameKey(p.espn_name), p.espn_name).toBe(nameKey(p.nflverse_name));
      expect(nameKey(p.espn_name)).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("a nickname nflverse does not share is a different name (an override's job)", () => {
    const palmer = FIXTURE.players.find((p) => p.tags.includes("nickname_differs"));
    expect(palmer).toBeDefined();
    expect(nameKey(palmer?.espn_name)).not.toBe(nameKey(palmer?.nflverse_name));
    expect(surnameKey(palmer?.espn_name)).toBe(surnameKey(palmer?.nflverse_name));
  });

  it("is idempotent on any input (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 80 }), (s) => {
        const once = mergeName(s);
        if (once !== null) {
          expect(mergeName(once)).toBe(once);
          expect(once).toMatch(/^[a-z0-9]+(?: [a-z0-9]+)*$/);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("ignores case, outer whitespace and trailing suffixes on name-like input (property)", () => {
    const part = fc.stringMatching(/^[A-Za-z][a-z]{1,10}$/);
    const suffix = fc.constantFrom(" Jr.", " Sr", " II", " III", " IV", " V");
    fc.assert(
      fc.property(part, part, suffix, (a, b, s) => {
        const base = nameKey(`${a} ${b}`);
        expect(nameKey(`  ${a.toUpperCase()}   ${b.toLowerCase()}${s} `)).toBe(base);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("nameKey / surnameKey", () => {
  it("ignores spacing and punctuation between tokens", () => {
    expect(nameKey("Jaxon Smith Njigba")).toBe(nameKey("Jaxon Smith-Njigba"));
    expect(nameKey("CJ Stroud")).toBe(nameKey("C. J. Stroud"));
    expect(nameKey("Amon-Ra St.Brown")).toBe(nameKey("Amon-Ra St. Brown"));
    expect(nameKey("Josh Allen")).toBe("joshallen");
  });

  it("keeps different names different (same surname is not the same name)", () => {
    expect(nameKey("Josh Allen")).not.toBe(nameKey("Keenan Allen"));
    expect(nameKey("Jordan Love")).not.toBe(nameKey("Jeremiyah Love"));
    expect(nameKey("Derrick Henry")).not.toBe(nameKey("Hunter Henry"));
  });

  it("surnameKey is the last token after suffix stripping; single tokens have none", () => {
    expect(surnameKey("James Cook III")).toBe("cook");
    expect(surnameKey("Amon-Ra St. Brown")).toBe("brown");
    expect(surnameKey("Madonna")).toBeNull();
    expect(surnameKey(7)).toBeNull();
  });
});

describe("cleanId", () => {
  it.each([
    [" 00-0034857", "00-0034857"],
    ["00-0034857 ", "00-0034857"],
    ["30977", "30977"],
    ["", null],
    ["   ", null],
    ["NA", null],
    ["na", null],
    ["N/A", null],
    ["null", null],
    ["None", null],
    ["NaN", null],
    ["undefined", null],
    ["-", null],
    ["30 977", null],
    ["30977\n1", null],
    ["30977\u0000", null],
  ])("%j → %j", (raw, want) => {
    expect(cleanId(raw)).toBe(want);
  });

  it("rejects non-strings and over-long ids", () => {
    expect(cleanId(30977)).toBeNull();
    expect(cleanId(null)).toBeNull();
    expect(cleanId("1".repeat(MAX_ID_CHARS))).toBe("1".repeat(MAX_ID_CHARS));
    expect(cleanId("1".repeat(MAX_ID_CHARS + 1))).toBeNull();
  });
});

describe("cleanGsisId", () => {
  it("trims and checks the grammar", () => {
    expect(cleanGsisId(" 00-0034857")).toBe("00-0034857");
    expect(cleanGsisId("00-0034857")).toBe("00-0034857");
    expect(cleanGsisId("NA")).toBeNull();
    expect(cleanGsisId("00-003485")).toBeNull();
    expect(cleanGsisId("00-00348570")).toBeNull();
    expect(cleanGsisId("01-0034857")).toBeNull();
    expect(cleanGsisId("ABC123456")).toBeNull();
    expect(cleanGsisId("００-0034857")).toBeNull();
    expect(cleanGsisId(null)).toBeNull();
  });
});

describe("compareCodePoints", () => {
  it("is a total, locale-free order for ids", () => {
    expect(compareCodePoints("00-0033897", "00-0099250")).toBe(-1);
    expect(compareCodePoints("00-0099250", "00-0033897")).toBe(1);
    expect(compareCodePoints("00-0099250", "00-0099250")).toBe(0);
    expect(["b", "B", "a", "A"].sort(compareCodePoints)).toEqual(["A", "B", "a", "b"]);
  });
});
