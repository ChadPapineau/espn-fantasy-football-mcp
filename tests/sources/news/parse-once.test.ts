// parse-once.test.ts — one news refresh parses its feed exactly once (Stage C remediation
// news-rss-quadratic-children: assertSchema parsed it twice — the shape and the row count — and
// publish a third time). parseRss is wrapped in a spy for this file only; the real runner, source
// and an in-memory STRICT sqlite publisher run around it. No network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { createNewsSource, NEWS_FEEDS } from "../../../src/sources/news/index.js";
import { parseRss } from "../../../src/sources/news/xml.js";
import { fsTempArea, runRefresh } from "../../../src/sources/runner.js";
import { fakeProSchedule, fakeRefreshLog, NO_DOWNLOAD, proGame } from "../runner/helpers.js";
import { sqlitePublisher } from "../weather/helpers.js";
import { CAPTURED, fakeGet, NEWS_NOW } from "./helpers.js";

vi.mock("../../../src/sources/news/xml.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../src/sources/news/xml.js")>();
  return { ...mod, parseRss: vi.fn(mod.parseRss) };
});

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eff-news-once-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("one parse per run", () => {
  it("a published news refresh calls parseRss once", async () => {
    const spy = vi.mocked(parseRss);
    spy.mockClear();
    const r = await runRefresh(
      { source: createNewsSource("espn"), seasons: [2026], week: 5 },
      {
        http: fakeGet({ [NEWS_FEEDS.espn.url]: CAPTURED.espn() }),
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
    expect(r.status).toBe("published");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
