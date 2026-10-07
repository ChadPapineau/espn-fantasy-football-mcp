// feeds.test.ts — the per-item field rules of the news sources (src/sources/news/feeds.ts): the three
// feeds equal tables.ts NEWS_TABLES `upstream`, pubDate in every observed format (RotoWire's 12-hour
// clock included — `rssDateMs` alone refuses it), tracking parameters stripped, layout whitespace
// collapsed, the CBS promo filter, and the hosts src/http's allow-list must carry.
import { describe, expect, it } from "vitest";
import { checkUrl, DATA_SOURCE_HOSTS } from "../../../src/http/allowlist.js";
import { rssDateMs } from "../../../src/store/datasets/derive.js";
import { NEWS_TABLES } from "../../../src/store/datasets/tables.js";
import {
  cleanLink,
  collapse,
  isPromo,
  NEWS_FEED_HOSTS,
  NEWS_FEEDS,
  pubDateMs,
} from "../../../src/sources/news/feeds.js";
import { SLEEPER_HOST, sleeperTrendingUrl } from "../../../src/sources/sleeper/index.js";

describe("NEWS_FEEDS", () => {
  it("names the same feeds as the dataset contract", () => {
    for (const f of Object.values(NEWS_FEEDS)) {
      const upstream = NEWS_TABLES[f.id][0]?.upstream ?? "";
      expect(upstream.startsWith(`${f.url} `), f.id).toBe(true);
      expect(new URL(f.url).hostname).toBe(f.host);
    }
    expect(NEWS_FEED_HOSTS).toEqual(["www.rotowire.com", "www.espn.com", "www.cbssports.com"]);
  });

  it("every request URL passes the real allow-list (https, default port, exact host)", () => {
    // the hosts are listed in src/http's allow-list itself (no test-side widening)
    for (const h of [...NEWS_FEED_HOSTS, SLEEPER_HOST]) expect(DATA_SOURCE_HOSTS).toContain(h);
    const allow = DATA_SOURCE_HOSTS;
    for (const f of Object.values(NEWS_FEEDS)) expect(checkUrl(f.url, allow).hostname).toBe(f.host);
    expect(checkUrl(sleeperTrendingUrl("add"), allow).hostname).toBe(SLEEPER_HOST);
    // and none of them is an ESPN fantasy host (no cookie can ever be attached to these requests)
    for (const h of [...NEWS_FEED_HOSTS, SLEEPER_HOST])
      expect(h.endsWith(".fantasy.espn.com")).toBe(false);
  });
});

describe("pubDateMs", () => {
  it.each([
    ["Tue, 06 Oct 2026 11:05:00 AM PDT", "2026-10-06T18:05:00.000Z"],
    ["Tue, 06 Oct 2026 6:12:00 AM PDT", "2026-10-06T13:12:00.000Z"],
    ["Mon, 05 Oct 2026 9:24:00 PM PDT", "2026-10-06T04:24:00.000Z"],
    ["Mon, 05 Oct 2026 12:00:00 AM PDT", "2026-10-05T07:00:00.000Z"],
    ["Mon, 05 Oct 2026 12:30 PM EDT", "2026-10-05T16:30:00.000Z"],
    ["Mon, 05 Oct 2026 1:30 p.m. EDT", "2026-10-05T17:30:00.000Z"],
    ["Tue, 6 Oct 2026 12:51:32 EST", "2026-10-06T17:51:32.000Z"],
    ["\n   Tue, 06 Oct 2026 19:27:55 +0000\n  ", "2026-10-06T19:27:55.000Z"],
    [
      `\n${" ".repeat(24)}Tue, 06 Oct 2026 19:27:55 +0000\n${" ".repeat(20)}`,
      "2026-10-06T19:27:55.000Z",
    ],
    ["2026-10-06T19:27:55Z", "2026-10-06T19:27:55.000Z"],
  ])("%j → %s", (raw, iso) => {
    expect(pubDateMs(raw)).toBe(Date.parse(iso));
  });

  it("refuses what rssDateMs refuses, and impossible 12-hour times", () => {
    expect(rssDateMs("Tue, 06 Oct 2026 6:12:00 AM PDT")).toBeNull(); // the reason this exists
    for (const bad of [
      "Tue, 06 Oct 2026 13:05:00 PM PDT",
      "Tue, 06 Oct 2026 0:05:00 AM PDT",
      "Tue, 06 Oct 2026 11:05:00 AM XYZ",
      "yesterday",
      "",
      "x".repeat(100),
      null,
      7,
    ])
      expect(pubDateMs(bad)).toBeNull();
  });
});

describe("cleanLink", () => {
  it("keeps a clean link verbatim (the item key stays stable)", () => {
    const l = "https://www.rotowire.com//football/player/joe-mixon-11707";
    expect(cleanLink(`  ${l}\n`)).toBe(l);
    expect(cleanLink("https://www.rotowire.com/rss/news.php?sport=NFL")).toBe(
      "https://www.rotowire.com/rss/news.php?sport=NFL",
    );
  });

  it("drops tracking parameters and the fragment, keeps the rest", () => {
    expect(
      cleanLink(
        "https://www.espn.com/nfl/story/_/id/1/x?utm_source=rss&utm_medium=feed&ex_cid=abc#top",
      ),
    ).toBe("https://www.espn.com/nfl/story/_/id/1/x");
    expect(cleanLink("https://www.cbssports.com/nfl/news/a/?ftag=RSS&page=2&fbclid=Z")).toBe(
      "https://www.cbssports.com/nfl/news/a/?page=2",
    );
  });

  it("refuses non-http(s), quotes, spaces, scripts and over-long links", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "ftp://x.example/a",
      'https://x.example/"onmouseover=',
      "https://x.example/a b",
      `https://x.example/${"a".repeat(2100)}`,
      "/relative/path",
      "",
      null,
      42,
    ])
      expect(cleanLink(bad)).toBeNull();
  });
});

describe("collapse / isPromo", () => {
  it("collapses layout whitespace; empty → null", () => {
    expect(collapse("\n   Ranking NFL\n   division leaders  ")).toBe(
      "Ranking NFL division leaders",
    );
    expect(collapse("   \n ")).toBeNull();
    expect(collapse(null)).toBeNull();
  });

  it("flags sportsbook promotions, not betting news", () => {
    expect(
      isPromo("Use FanDuel promo code to get $250 in bonus bets by targeting Falcons vs. Saints"),
    ).toBe(true);
    expect(isPromo("Saints-Falcons NFL betting promos: Collect nearly $3,000 in bonuses")).toBe(
      true,
    );
    expect(isPromo("DraftKings sign-up bonus for Week 5")).toBe(true);
    expect(isPromo("Week 5 betting: Odds, lines and totals for every game")).toBe(false);
    expect(isPromo("Saints vs. Falcons picks, player props: Expert's best bets")).toBe(false);
    expect(isPromo("Player A promoted to the active roster")).toBe(false);
  });
});
