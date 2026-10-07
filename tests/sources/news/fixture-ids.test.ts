// fixture-ids.test.ts — the claim fixtures/news/README.md makes about its UUID-shaped values (the
// B2a gate's round 3; the same note as fixtures/nflverse/ATTRIBUTION.md and
// fixtures/fx10h-usage/ATTRIBUTION.md, held as tests/sources/nflverse/fx10h-usage.test.ts holds
// those): every UUID-shaped value under fixtures/news/ is the guid of a CBS item — a `<guid>` element of a
// CBS capture, or the `guid` of a `feed: "cbs"` item in a labelled set that is equal to a captured
// one — none brace-wrapped (the ESPN member-GUID form), none in the fixture pseudonym range; the
// test that quotes one quotes a captured guid.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const NEWS = path.join(ROOT, "fixtures/news");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function files(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)],
  );
}

/** The guids of the CBS captures' items, from their `<guid>` elements. */
function capturedCbsGuids(): Set<string> {
  const out = new Set<string>();
  for (const f of ["captured/cbs.xml", "captured/holdout-cbs.xml"]) {
    const xml = readFileSync(path.join(NEWS, f), "utf8");
    for (const m of xml.matchAll(/<guid\b[^>]*>\s*([^<]*?)\s*<\/guid>/g)) out.add(m[1] ?? "");
  }
  return out;
}

describe("fixtures/news: UUID-shaped values are CBS's public article ids (README)", () => {
  const cbs = capturedCbsGuids();

  it("in the captures: only inside a CBS capture's <guid> elements", () => {
    let inGuids = 0;
    for (const p of files(path.join(NEWS, "captured"))) {
      const text = readFileSync(p, "utf8");
      const found = text.match(UUID) ?? [];
      if (!path.basename(p).includes("cbs")) {
        expect(found, p).toEqual([]);
        continue;
      }
      // every UUID of the file is a whole guid element's value
      const guids = [...text.matchAll(/<guid\b[^>]*>\s*([^<]*?)\s*<\/guid>/g)].map((m) => m[1]);
      const uuidGuids = guids.filter((g) => g !== undefined && BARE_UUID.test(g));
      expect(found.length, p).toBe(uuidGuids.length);
      inGuids += uuidGuids.length;
    }
    expect(inGuids).toBe(40);
    expect(cbs.size).toBe(40);
  });

  it("in the labelled sets: only as the guid of a CBS item, equal to a captured guid", () => {
    for (const f of ["labelled/items.json", "labelled/holdout.json"]) {
      const text = readFileSync(path.join(NEWS, f), "utf8");
      const doc = JSON.parse(text) as { items: { feed: string; guid: string }[] };
      const fromItems = doc.items.filter((i) => BARE_UUID.test(i.guid));
      for (const i of fromItems) {
        expect(i.feed, `${f} ${i.guid}`).toBe("cbs");
        expect(cbs.has(i.guid), `${f} ${i.guid}`).toBe(true);
      }
      // nothing else in the file is UUID-shaped
      expect((text.match(UUID) ?? []).length, f).toBe(fromItems.length);
    }
  });

  it("none is brace-wrapped (the SWID form), none in the fixture pseudonym range, and the note is there", () => {
    for (const p of files(NEWS)) {
      if (p.endsWith(".md")) continue;
      const text = readFileSync(p, "utf8");
      expect(text, p).not.toMatch(/\{[0-9a-f]{8}-[0-9a-f]{4}-/i);
      for (const u of text.match(UUID) ?? [])
        expect(u.toLowerCase().startsWith("00000000-0000-4000-8000-"), u).toBe(false);
    }
    // the one test that quotes a guid quotes a captured one
    const xmlTest = readFileSync(path.join(ROOT, "tests/sources/news/xml.test.ts"), "utf8");
    const quoted = xmlTest.match(UUID) ?? [];
    expect(quoted.length).toBeGreaterThan(0);
    for (const u of quoted) expect(cbs.has(u), u).toBe(true);
    const md = readFileSync(path.join(NEWS, "README.md"), "utf8");
    expect(md).toContain("## UUID-shaped values are public CBS article ids, not member GUIDs");
  });
});
