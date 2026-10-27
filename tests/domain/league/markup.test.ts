// markup.test.ts — the untrusted-text sanitiser's markup and entity scans (src/domain/league/markup.ts)
// held to the regexes they replace (plan 02 §6.2 "Stripping"; Stage C finding
// untrusted-sanitizer-quadratic): on random markup-heavy text each scan returns exactly what its regex
// returned, the two tag rules and the entity decode return what their regexes reach when applied
// until nothing changes, and stripTags is its own fixed point. The sanitiser built on them:
// tests/domain/league/sanitizer-hostile.test.ts; their cost: tests/domain/league/sanitizer.perf.test.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeLevel,
  decodeNested,
  ENTITY_SOURCE,
  removeBlocks,
  removeComments,
  removeTags,
  stripTags,
  type EntityText,
} from "../../../src/domain/league/markup.js";

/** The rules as the sanitiser ran them before (src/domain/league/types.ts `stripTags` at 54b4453). */
const BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<[A-Za-z/!?][^<>]*>/g;
const TRAILING_TAG_RE = /<[A-Za-z/!?][^<>]*$/;
const ENTITIES_RE = new RegExp(ENTITY_SOURCE, "g");

/** `step` applied until nothing changes (every step here shortens the text or keeps it). */
function fixedPoint(s: string, step: (t: string) => string): string {
  let t = s;
  for (let n = step(t); n !== t; n = step(t)) t = n;
  return t;
}
const tagRules = (s: string): string => s.replace(TAG_RE, " ").replace(TRAILING_TAG_RE, " ");
const fourRules = (s: string): string =>
  tagRules(s.replace(BLOCK_RE, " ").replace(COMMENT_RE, " "));

/** Every code unit `\s` matches, and look-alikes it does not (ZWSP, NEL, the Mongolian separator). */
const SPACES = [
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  "\u{a0}",
  "\u{1680}",
  "\u{2000}",
  "\u{200a}",
  "\u{2028}",
  "\u{2029}",
  "\u{202f}",
  "\u{205f}",
  "\u{3000}",
  "\u{feff}",
];
const NOT_SPACES = ["\u{200b}", "\u{85}", "\u{180e}"];

/** Markup pieces: openers, closers, case and `\b` variants, prose `<` and `>`, near misses. */
const MARKUP = [
  "<",
  ">",
  "</",
  "<!",
  "<?",
  "<!--",
  "-->",
  "--",
  "-",
  "!",
  "?",
  "/",
  "<a",
  "<b ",
  "<3",
  "< b",
  "<=",
  "a",
  "x",
  "3",
  "_",
  "=",
  '"',
  "'",
  "é",
  "<é",
  "script",
  "style",
  "SCRIPT",
  "StYlE",
  "scripts",
  "script_",
  "script1",
  "\u{17f}cript",
  "<script",
  "<style",
  "<SCRIPT",
  "<sTyle",
  "<scripts",
  "<script>",
  "<style>",
  "</script>",
  "</style>",
  "</SCRIPT>",
  "</sTyLe >",
  "</script",
  "</style",
  "</scrip",
  "</script x>",
  "</scripts>",
  ...SPACES,
  ...NOT_SPACES,
];

const text = (pieces: readonly string[], maxLength = 40): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...pieces), { maxLength }).map((a) => a.join(""));

describe("each markup scan returns what the regex it replaces returned", () => {
  it("property: removeBlocks is s.replace(/<(script|style)\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>/gi, ' ')", () => {
    fc.assert(
      fc.property(text(MARKUP), (s) => removeBlocks(s) === s.replace(BLOCK_RE, " ")),
      { numRuns: 4000 },
    );
  });

  it("property: removeComments is s.replace(/<!--[\\s\\S]*?-->/g, ' ')", () => {
    fc.assert(
      fc.property(text(MARKUP), (s) => removeComments(s) === s.replace(COMMENT_RE, " ")),
      { numRuns: 4000 },
    );
  });

  it("property: removeTags is the two tag rules applied until nothing changes", () => {
    fc.assert(
      fc.property(text(MARKUP), (s) => removeTags(s) === fixedPoint(s, tagRules)),
      { numRuns: 4000 },
    );
  });

  it("property: stripTags is the four rules applied until nothing changes, in one call", () => {
    fc.assert(
      fc.property(text(MARKUP), (s) => {
        const once = stripTags(s);
        return once === fixedPoint(s, fourRules) && stripTags(once) === once;
      }),
      { numRuns: 4000 },
    );
  });

  it("blocks: the first closer of the opener's own name, ASCII case folded, `\\s*` before its `>`", () => {
    expect(removeBlocks("a<script>alert(1)</script>b")).toBe("a b");
    expect(removeBlocks('a<SCRIPT type="x">1</ScRiPt \t>b')).toBe("a b");
    for (const sp of SPACES) expect(removeBlocks(`<style>x</style${sp}>y`), sp).toBe(" y");
    for (const sp of NOT_SPACES) {
      const s = `<style>x</style${sp}>y`;
      expect(removeBlocks(s), sp).toBe(s);
    }
    expect(removeBlocks("<style>a</script></style>b")).toBe(" b");
    expect(removeBlocks("<script>a</script><script>b")).toBe(" <script>b");
  });

  it("blocks: no `\\b` after the name, no `>` after the opener, or no closer — no block", () => {
    for (const s of [
      "<scripts>1</scripts>",
      "<script_>1</script_>",
      "<\u{17f}cript>1</\u{17f}cript>",
      "<script>1</script x>",
      "<script>1",
      "<script",
      "<style<style<style",
      "<style".repeat(50) + ">",
    ])
      expect(removeBlocks(s), s).toBe(s);
  });

  it("comments: each up to the first `-->` after its opener; an unclosed one stays", () => {
    expect(removeComments("a<!-- b -->c")).toBe("a c");
    expect(removeComments("<!---->")).toBe(" ");
    expect(removeComments("<!-- a <!-- b --> c")).toBe("  c");
    for (const s of ["<!-->", "<!--->", "<!-- a", "<!--".repeat(50)])
      expect(removeComments(s), s).toBe(s);
  });

  it("tags: nested and unclosed tags go to their fixed point; prose `<` and `>` stay", () => {
    expect(removeTags("3 < 4 and 5 > 2")).toBe("3 < 4 and 5 > 2");
    expect(removeTags("a<b>c<d>e")).toBe("a c e");
    expect(removeTags("<a<b>>")).toBe(" ");
    expect(removeTags("x<a y<b>z")).toBe("x ");
    expect(removeTags("a<b<c")).toBe("a ");
    expect(removeTags("<a<3>")).toBe("<a<3>");
    expect(removeTags("a>b<c")).toBe("a>b ");
    expect(removeTags("<a>b<c<3")).toBe(" b<c<3");
    expect(removeTags("Team A" + "<b".repeat(300))).toBe("Team A ");
    expect(removeTags("<a".repeat(300) + ">".repeat(300) + "Team A")).toBe(" Team A");
  });

  it("stripTags: a block, a comment and tags in one call; text without markup is returned as it is", () => {
    expect(stripTags("<script>x</script><!-- y --><b>z</b>")).toBe("   z ");
    for (const s of ["", "Team A", "3 < 4", "a > b", "<3", "&lt;b&gt;", "[x](y)"])
      expect(stripTags(s), s).toBe(s);
  });
});

/** A decode table for the scan (the sanitiser's own is in types.ts; the scan takes any). */
const NAMED: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["semi", ";"],
  ["quot", '"'],
]);
const decode: EntityText = (dec, hex, name) => {
  if (name !== undefined) return NAMED.get(name) ?? "";
  const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
  return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "";
};
/** One level of decoding as the sanitiser did it before: one regex replace. */
const regexLevel =
  (d: EntityText) =>
  (s: string): string =>
    s.replace(ENTITIES_RE, (_m: string, dec?: string, hex?: string, name?: string) =>
      d(dec, hex, name),
    );

/** Entity pieces: whole entities, their parts, the grammar's edges and decoded `&` and `;`. */
const ENTITY_PIECES = [
  "&",
  ";",
  "#",
  "x",
  "X",
  "a",
  "1",
  "f",
  " ",
  "<",
  ">",
  "lt",
  "gt",
  "amp",
  "semi",
  "&lt;",
  "&gt;",
  "&amp;",
  "&semi;",
  "&quot;",
  "&#59;",
  "&#x3b;",
  "&#38;",
  "&#X26;",
  "&#60;",
  "&#0;",
  "&#55296;",
  "&#x110000;",
  "&#1234567;",
  "&#12345678;",
  "&#x10FFFF;",
  "&#x1F600;",
  "&abcdefghijklmnopqrstuvwxyzABCDEF;",
  "&abcdefghijklmnopqrstuvwxyzABCDEFG;",
  "&bogus;",
  "&b;",
  "&#;",
  "&#x;",
];

/** Decoders whose text is longer than its entity, or forms entities again (`;`, `&`, a name). */
const LONGER: EntityText = (dec) => (dec === undefined ? "x".repeat(40) : "<");
const SEMICOLONS: EntityText = () => ";";
const REOPEN: EntityText = (dec) => (dec === undefined ? "&" : "lt;");
const MIXED: EntityText = (dec, hex, name) =>
  name !== undefined ? (name.length % 2 === 0 ? "&a" : "b;") : hex !== undefined ? "&" : "";
const INSIDE: EntityText = (dec) => (dec === undefined ? ";;" : "x;y");

describe("decodeLevel is one regex replace of every entity, in one scan with no callback", () => {
  it("property: the same text as the regex, whatever each entity decodes to", () => {
    for (const d of [decode, LONGER, SEMICOLONS, REOPEN, MIXED, INSIDE])
      fc.assert(
        fc.property(text(ENTITY_PIECES), (s) => decodeLevel(s, d) === regexLevel(d)(s)),
        { numRuns: 1500 },
      );
  });

  it("one level only: what a decode writes is never read again in the same call", () => {
    expect(decodeLevel("&amp;amp;lt;b&amp;gt;", decode)).toBe("&amp;lt;b&gt;");
    expect(decodeLevel("&lt&#59;", decode)).toBe("&lt;");
    expect(decodeLevel("&#38;lt;", decode)).toBe("&lt;");
    expect(decodeLevel("a &b; &#; &#x; &bogus; c &&lt; &lt&gt;", decode)).toBe(
      "a &b; &#; &#x;  c &< &lt>",
    );
    expect(decodeLevel("no entity & no ; here", decode)).toBe("no entity & no ; here");
    expect(decodeLevel(`${"&".repeat(3000)}lt;`, decode)).toBe(`${"&".repeat(2999)}<`);
  });
});

describe("decodeNested is one-level decoding applied until nothing changes, in one scan", () => {
  it("property: the sanitiser's kind of table — every decode shorter than its entity", () => {
    fc.assert(
      fc.property(
        text(ENTITY_PIECES),
        (s) => decodeNested(s, decode) === fixedPoint(s, regexLevel(decode)),
      ),
      { numRuns: 4000 },
    );
  });

  it("property: decoders whose text forms entities again (`;`, `&`, a name) are followed to the end", () => {
    for (const d of [SEMICOLONS, REOPEN, MIXED, INSIDE])
      fc.assert(
        fc.property(
          text(ENTITY_PIECES),
          (s) => decodeNested(s, d) === fixedPoint(s, regexLevel(d)),
        ),
        { numRuns: 1500 },
      );
  });

  it("every level, and a decoded `;` or `&` that closes or opens the entity around it", () => {
    expect(decodeNested("&amp;amp;lt;b&amp;gt;", decode)).toBe("<b>");
    expect(decodeNested("&lt&#59;", decode)).toBe("<");
    expect(decodeNested("&lt&semi;b", decode)).toBe("<b");
    expect(decodeNested("&#38;lt;", decode)).toBe("<");
    expect(decodeNested("&#38;#38;#38;lt;", decode)).toBe("<");
    expect(decodeNested(`&${"amp;".repeat(5000)}lt;`, decode)).toBe("<");
    expect(decodeNested("a &b; &#; &#x; &bogus; c", decode)).toBe("a &b; &#; &#x;  c");
    expect(decodeNested("&#12345678; &#x110000; &#55296;", decode)).toBe("&#12345678;  ");
  });

  it("an entity whose decode is not shorter than it stays as written", () => {
    for (const s of ["&lt;", "&amp;amp;", "a&abcdefghijklmnopqrstuvwxyzABCDEF;b"])
      expect(decodeNested(s, LONGER), s).toBe(s);
    expect(decodeNested("&lt; &#59;", LONGER)).toBe("&lt; <");
    const same: EntityText = (_d, _h, name) => (name === undefined ? "" : `&${name};`);
    expect(decodeNested("&lt; &#60;", same)).toBe("&lt; ");
  });
});
