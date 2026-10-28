// news-filters.test.ts — D6 espn_get_news applies its filters before any cut (plan 07 D6 inputs
// `since_hours`, `sources`, `players`; common.ts newsMatching). The store's reader merges the three
// feeds and keeps the newest N across them, and filters by gsis id only. Stage C finding
// news-sources-filter-after-cut: D6 asked the reader for the 50 newest items and only then kept
// `sources`, so on the seeded fx-10h cache sources:['cbs'] answered 25 of its 33 in-window items and
// ['espn'] 20 of 25, with no warning. Stage C finding crosswalk-unpaired-joins-silent (D6 part): a
// selected player with no crosswalk pair was dropped (a single one answered "no news can be
// matched") although the stored refs carry his ESPN id. The seeded cache `eff refresh all` leaves
// (tests/integration/helpers/seed.ts: the three captured feeds through the real runner), the real
// reader, fx-10h at its own clock under EFF_TOOLSET=full; fixture mode, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import type { NewsItem } from "../../src/domain/analytics/types.js";
import { NEWS_READ_MAX } from "../../src/mcp/tools/common.js";
import { EVIDENCE_UNREAD, NO_PAIR_NEWS_NOTE } from "../../src/mcp/tools/market-p1.js";
import { seedDatasets } from "../integration/helpers/seed.js";
import { envelopeViolations } from "./helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const WEEK_H = 168;
/** The store reader's own ceiling (src/store/datasets/readers-p2.ts NEWS_RECENT_MAX). */
const READER_MAX = 500;

let world: World;
let client: Client;
let close: () => Promise<void>;
/** Every in-window item of the seeded feeds, through the real reader (well under its ceiling). */
let inWindow: readonly NewsItem[];

beforeAll(async () => {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: false,
  });
  await seedDatasets(world.store, {
    storePath: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    cache: world.cache,
    clock: world.clock,
    season: 2026,
  });
  world.store.reopenChangedDatasets();
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await call(client, "espn_get_league");
  const since = new Date(world.clock.nowMs() - WEEK_H * 3600 * 1000).toISOString();
  inWindow = world.store.datasets.news.recent(since, READER_MAX, null).rows;
}, 300_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

interface Item {
  id: string;
  source: string;
  players_matched: { player_id: number | null }[];
}

async function news(
  c: Client,
  args: Record<string, unknown>,
): Promise<{ items: Item[]; warnings: string[]; truncated: boolean }> {
  const r = await call(c, "espn_get_news", args);
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  expect(envelopeViolations(r.body as never)).toEqual([]);
  return {
    items: (r.body.data as { items: Item[] }).items,
    warnings: r.body.warnings as string[],
    truncated: r.body.truncated === true,
  };
}

/**
 * The answer is every wanted item, or — when the list budget (plan 07 C8) cut it — the newest of
 * them with `truncated: true` and the envelope's own warning: never fewer in silence.
 */
function everyOrSaidCut(got: Awaited<ReturnType<typeof news>>, want: readonly NewsItem[]): void {
  const ids = got.items.map((x) => x.id);
  if (got.truncated) {
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(want.length);
    expect(ids).toEqual(want.slice(0, ids.length).map((x) => x.id));
  } else expect(ids).toEqual(want.map((x) => x.id));
}

describe("D6 `sources` is applied before any cut (Stage C news-sources-filter-after-cut)", () => {
  it("the seeded cache holds more in-window items than one feed's share of the newest 50", () => {
    // the repro's precondition: the feeds together exceed the old read of 50
    expect(inWindow.length).toBeGreaterThan(50);
    expect(inWindow.length).toBeLessThan(READER_MAX);
    // the tool's ceiling is the reader's
    expect(NEWS_READ_MAX).toBe(READER_MAX);
  });

  it.each(["cbs", "espn", "rotowire"] as const)(
    "sources:['%s'] answers every in-window item of the feed (limit 50), newest first, with no cut warning",
    async (feed) => {
      const want = inWindow.filter((it) => it.source === feed);
      expect(want.length).toBeGreaterThan(0);
      const got = await news(client, { since_hours: WEEK_H, limit: 50, sources: [feed] });
      everyOrSaidCut(got, want.slice(0, 50));
      expect(got.items.every((x) => x.source === feed)).toBe(true);
      if (want.length <= 50)
        expect(got.warnings.some((w) => w.startsWith("more matching items"))).toBe(false);
    },
  );

  it("two feeds together: every in-window item of both, in the reader's order", async () => {
    const want = inWindow.filter((it) => it.source === "cbs" || it.source === "espn").slice(0, 50);
    const got = await news(client, { since_hours: WEEK_H, limit: 50, sources: ["cbs", "espn"] });
    everyOrSaidCut(got, want);
  });

  it("a limit below the matches is said (more matching items exist), never silent", async () => {
    const cbs = inWindow.filter((it) => it.source === "cbs");
    expect(cbs.length).toBeGreaterThan(5);
    const got = await news(client, { since_hours: WEEK_H, limit: 5, sources: ["cbs"] });
    expect(got.items.map((x) => x.id)).toEqual(cbs.slice(0, 5).map((x) => x.id));
    expect(got.warnings.some((w) => w.startsWith("more matching items than the limit"))).toBe(true);
  });

  it("no filter: the newest items across feeds, as before", async () => {
    const got = await news(client, { since_hours: WEEK_H, limit: 20 });
    expect(got.items.map((x) => x.id)).toEqual(inWindow.slice(0, 20).map((x) => x.id));
  });
});

describe("D6 finds an unpaired player's items by his ESPN id (Stage C crosswalk-unpaired-joins-silent)", () => {
  /** The ESPN ids an in-window item refs without a gsis id, that the crosswalk has no pair for. */
  function unpairedRefs(): number[] {
    const out = new Set<number>();
    for (const it of inWindow)
      for (const r of (
        it as unknown as { refs?: { espn_id: number | null; gsis_id: string | null }[] }
      ).refs ?? [])
        if (r.espn_id !== null && r.espn_id > 0 && r.gsis_id === null) {
          const pair = world.store.repos.crosswalk.get(r.espn_id);
          if (pair?.espn_id !== r.espn_id) out.add(r.espn_id);
        }
    return [...out].sort((a, b) => a - b);
  }
  const refsName = (it: NewsItem, id: number) =>
    ((it as unknown as { refs?: { espn_id: number | null }[] }).refs ?? []).some(
      (r) => r.espn_id === id,
    );

  it("selected alone or beside a paired player, his items are answered — never dropped in silence", async () => {
    // an unpaired player of the fixture pool whom an in-window item refs by ESPN id
    let subject: number | null = null;
    for (const id of unpairedRefs()) {
      const r = await call(client, "espn_get_projections", {
        players: { player_ids: [id] },
        horizon: "week",
      });
      if (!r.isError) {
        subject = id;
        break;
      }
    }
    if (subject === null) throw new Error("no unpaired pool player with an in-window item");
    const his = inWindow.filter((it) => refsName(it, subject));
    expect(his.length).toBeGreaterThan(0);
    const alone = await news(client, { since_hours: WEEK_H, players: { player_ids: [subject] } });
    everyOrSaidCut(alone, his.slice(0, 20));
    expect(alone.warnings).toContain(
      "a selected player has no crosswalk pair: his items are matched by the ESPN id in their refs",
    );
    expect(alone.warnings.some((w) => w.includes("no news can be matched"))).toBe(false);
    // E10 reads the same items for him, and says so only now that the news was read (attempt 3)
    const ev = await call(client, "espn_analyze_evidence", { player: { player_ids: [subject] } });
    expect(ev.isError, JSON.stringify(ev.body).slice(0, 300)).toBe(false);
    expect(ev.body.warnings).toContain(NO_PAIR_NEWS_NOTE);
    expect(ev.body.warnings).not.toContain(EVIDENCE_UNREAD.news);
    expect((ev.body.meta as { source: string[] }).source.some((x) => x.startsWith("news:"))).toBe(
      true,
    );
    // beside a paired player: both players' items, newest first
    let paired: { espn: number; gsis: string } | null = null;
    for (const it of inWindow)
      for (const r of (
        it as unknown as { refs?: { espn_id: number | null; gsis_id: string | null }[] }
      ).refs ?? [])
        if (paired === null && r.espn_id !== null && r.gsis_id !== null && r.espn_id !== subject) {
          const pair = world.store.repos.crosswalk.get(r.espn_id);
          if (pair?.espn_id === r.espn_id && pair.gsis_id === r.gsis_id)
            paired = { espn: r.espn_id, gsis: r.gsis_id };
        }
    if (paired === null) throw new Error("no paired player with an in-window item");
    const mate = paired;
    const both = await news(client, {
      since_hours: WEEK_H,
      limit: 50,
      players: { player_ids: [subject, mate.espn] },
    });
    const want = inWindow.filter(
      (it) => refsName(it, subject) || refsName(it, mate.espn) || it.gsis_ids.includes(mate.gsis),
    );
    expect(want.some((it) => !refsName(it, subject))).toBe(true);
    everyOrSaidCut(both, want.slice(0, 50));
  });
});
