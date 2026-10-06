// news.test.ts — a stored RSS row as a NewsItem and the D6 claim fields (src/domain/evidence/news.ts;
// plan 07 D6; plan 02 §6.2 — every RSS string leaves the store wrapped with its `rss.<feed>.*` tag;
// plan 10 B8 — the 05 §6 injection texts plus inj-league-name / inj-division-name never appear
// outside an `untrusted_text` wrapper).
import { describe, expect, it } from "vitest";
import { INJECTIONS } from "../../../scripts/fx10h/variants.js";
import {
  CLAIM_TYPES,
  DESIGNATIONS,
  INJECTION_RELIABILITY_CAP,
  isNewsFeed,
  NEWS_FEED_KEYS,
  newsClaim,
  newsItemFromRow,
  readStoredNewsRow,
  RULE_IDS,
} from "../../../src/domain/evidence/index.js";
import { bareStrings } from "../../sources/news/helpers.js";

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  item_id: "0123456789abcdef0123456789abcdef",
  source: "rotowire",
  published_ms: Date.parse("2026-10-06T18:05:00Z"),
  first_seen_ms: Date.parse("2026-10-06T18:10:00Z"),
  title: "Player A: Ruled out for Sunday",
  blurb: "Player A (ankle) was ruled out Friday.",
  link: "https://www.rotowire.com/football/player/a-1",
  ...over,
});

describe("newsItemFromRow", () => {
  it("wraps title, blurb and URL with the feed's tags and keeps the ids and instant", () => {
    const item = newsItemFromRow(row(), ["00-0034857", "bad", "00-0034857", 7, "00-0012345"]);
    expect(item).toEqual({
      id: "0123456789abcdef0123456789abcdef",
      source: "rotowire",
      published_at: "2026-10-06T18:05:00.000Z",
      title: {
        untrusted_text: {
          value: "Player A: Ruled out for Sunday",
          source: "rss.rotowire.title",
          chars: 30,
          truncated: false,
        },
      },
      blurb: {
        untrusted_text: {
          value: "Player A (ankle) was ruled out Friday.",
          source: "rss.rotowire.blurb",
          chars: 38,
          truncated: false,
        },
      },
      url: {
        untrusted_text: {
          value: "https://www.rotowire.com/football/player/a-1",
          source: "rss.rotowire.url",
          chars: 44,
          truncated: false,
        },
      },
      gsis_ids: ["00-0012345", "00-0034857"],
    });
  });

  it("caps at the wrapper's class (news title 160, blurb 400) and turns absent text into empty wrappers", () => {
    const item = newsItemFromRow(
      row({ title: "T".repeat(900), blurb: null, link: null, source: "cbs" }),
    );
    expect(item?.title.untrusted_text).toMatchObject({
      chars: 160,
      truncated: true,
      source: "rss.cbs.title",
    });
    expect(item?.blurb.untrusted_text).toEqual({
      value: "",
      source: "rss.cbs.blurb",
      chars: 0,
      truncated: false,
    });
    expect(item?.url.untrusted_text.value).toBe("");
  });

  it.each([
    ["a short id", { item_id: "abc" }],
    ["an upper-case id", { item_id: "0123456789ABCDEF0123456789ABCDEF" }],
    ["an unknown feed", { source: "reddit" }],
    ["a fractional instant", { published_ms: 1.5 }],
    ["a negative first sighting", { first_seen_ms: -1 }],
    ["a far-future instant", { published_ms: 4e13 }],
    ["an empty title", { title: "  " }],
    ["a numeric title", { title: 7 }],
    ["a numeric blurb", { blurb: 7 }],
    ["an object link", { link: {} }],
  ])("refuses a row with %s", (_why, over) => {
    expect(newsItemFromRow(row(over))).toBeNull();
  });

  it("refuses non-objects and inherited fields", () => {
    for (const v of [null, 7, "x", [], [row()]]) expect(readStoredNewsRow(v)).toBeNull();
    const proto = Object.create(row()) as object;
    expect(readStoredNewsRow(proto)).toBeNull();
    expect(readStoredNewsRow({ ...row(), blurb: undefined, link: undefined })).toMatchObject({
      blurb: null,
      link: null,
    });
    expect(NEWS_FEED_KEYS).toEqual(["rotowire", "espn", "cbs"]);
    expect(isNewsFeed("espn")).toBe(true);
    expect(isNewsFeed(1)).toBe(false);
  });
});

describe("newsClaim", () => {
  it("extracts from the wrapped title, then the blurb, with the feed's prior", () => {
    const item = newsItemFromRow(row());
    if (item === null) throw new Error("row");
    expect(newsClaim(item)).toMatchObject({
      claim: { type: "availability", direction: "down", extractor: "rules_v1" },
      reliability_prior: 0.8,
      flags: [],
      extract: { rule: "availability.ruled_out", designation: "out", field: "title" },
    });
    const blurbOnly = newsItemFromRow(
      row({ title: "Week 5 notes", blurb: "Player A signed with the Jets." }),
    );
    if (blurbOnly === null) throw new Error("row");
    expect(newsClaim(blurbOnly)).toMatchObject({
      claim: { type: "transaction" },
      reliability_prior: 0.9,
    });
    const none = newsItemFromRow(row({ title: "Week 5 power rankings", blurb: null }));
    if (none === null) throw new Error("row");
    expect(newsClaim(none)).toEqual({
      claim: null,
      reliability_prior: null,
      flags: [],
      extract: null,
    });
  });

  it("reads the SANITISED text: markup cannot hide or forge a claim", () => {
    const hidden = newsItemFromRow(
      row({ title: "Week 5 notes <script>ruled out</script>", blurb: "<!-- signs with Jets -->" }),
    );
    if (hidden === null) throw new Error("row");
    expect(newsClaim(hidden).claim).toBeNull();
  });

  it("unions the wrappers' injection flags and caps the prior of a flagged item", () => {
    const item = newsItemFromRow(
      row({ title: INJECTIONS.outlookSystem, blurb: INJECTIONS.teamNameJson }),
    );
    if (item === null) throw new Error("row");
    const f = newsClaim(item);
    expect(f.flags).toEqual(["imperative", "json_like", "role_marker"]);
    expect(f.reliability_prior === null || f.reliability_prior <= INJECTION_RELIABILITY_CAP).toBe(
      true,
    );
  });
});

describe("B8: the injection texts never appear outside an untrusted_text wrapper", () => {
  const TEXTS = Object.values(INJECTIONS);
  /** The closed vocabulary's own words (a rule id may share a word with a text, e.g. "cleared"). */
  const VOCAB = new Set(
    [...RULE_IDS, ...DESIGNATIONS, ...CLAIM_TYPES]
      .flatMap((v) => v.split(/[._]/))
      .map((w) => w.toLowerCase()),
  );
  it.each(TEXTS.map((t) => [t]))("%s", (text) => {
    const item = newsItemFromRow(
      row({
        title: text,
        blurb: text,
        link: `https://www.espn.com/x?q=${encodeURIComponent(text)}`,
      }),
    );
    if (item === null) throw new Error("row");
    const out = { ...item, ...newsClaim(item) };
    // every bare string is an id, an instant, a feed key or the closed claim vocabulary
    const fragments = text
      .split(/[^A-Za-z]+/)
      .filter((w) => w.length >= 6)
      .map((w) => w.toLowerCase())
      .filter((w) => !VOCAB.has(w));
    for (const [path, s] of bareStrings(out)) {
      const lower = s.toLowerCase();
      for (const w of fragments) expect(lower, path).not.toContain(w);
    }
    // and the text is there, inside its wrapper
    expect(item.title.untrusted_text.value.length).toBeGreaterThan(0);
  });
});
