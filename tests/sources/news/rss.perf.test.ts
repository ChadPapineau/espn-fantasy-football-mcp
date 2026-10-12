// rss.perf.test.ts — a hostile feed at the body cap stays cheap (plan 05 §4.2: wall-clock budgets
// run in the process project, never under coverage; plan 02 §6.1 #3: news RSS is a hostile
// surface). Stage C remediation news-rss-quadratic-children: an item with ~200 000 distinct child
// names under MAX_RSS_BYTES cost ~166 s per parse (an Array scan per child) and the news job parsed
// it three times per run; the whole refresh — fetch, assertSchema, publish — now runs in seconds.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { createNewsSource, MAX_RSS_BYTES, NEWS_FEEDS } from "../../../src/sources/news/index.js";
import { parseRss } from "../../../src/sources/news/xml.js";
import { fsTempArea, runRefresh } from "../../../src/sources/runner.js";
import { fakeProSchedule, fakeRefreshLog, NO_DOWNLOAD, proGame } from "../runner/helpers.js";
import { sqlitePublisher } from "../weather/helpers.js";
import { fakeGet, NEWS_NOW } from "./helpers.js";

/** One item carrying as many distinct self-closing children as fit under the body cap. */
function capSizedFeed(): string {
  const head = `<rss version="2.0"><channel><title>T</title><item><title>A</title><guid>g</guid><pubDate>Tue, 06 Oct 2026 18:00:00 GMT</pubDate>`;
  const tail = `</item></channel></rss>`;
  const parts: string[] = [];
  let bytes = head.length + tail.length;
  for (let i = 0; ; i++) {
    const c = `<a${i.toString(36)}/>`;
    if (bytes + c.length > MAX_RSS_BYTES) break;
    parts.push(c);
    bytes += c.length;
  }
  return `${head}${parts.join("")}${tail}`;
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eff-news-perf-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a cap-sized hostile feed", () => {
  const feed = capSizedFeed();

  it("parses in < 1 s", () => {
    expect(feed.length).toBeGreaterThan(MAX_RSS_BYTES - 16);
    const t0 = performance.now();
    const d = parseRss(feed);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(d.items).toHaveLength(1);
  });

  it("a whole refresh (fetch, assertSchema, publish) in < 5 s, with a bounded warning list", async () => {
    const t0 = performance.now();
    const r = await runRefresh(
      { source: createNewsSource("espn"), seasons: [2026], week: 5 },
      {
        http: fakeGet({ [NEWS_FEEDS.espn.url]: feed }),
        download: NO_DOWNLOAD,
        clock: fixedClock(NEWS_NOW),
        rng: seededRng(5),
        publisher: sqlitePublisher(),
        refreshLog: fakeRefreshLog(),
        proSchedule: fakeProSchedule([proGame(401, "2026-10-04T17:00:00Z")]),
        temp: fsTempArea(join(root, "tmp")),
        sleep: () => Promise.resolve(),
      },
    );
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(r.status).toBe("published");
    expect(r.status === "published" && r.warnings.length).toBeLessThan(40);
  });
});
