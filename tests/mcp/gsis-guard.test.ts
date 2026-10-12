// gsis-guard.test.ts — a dataset row whose player id is not a GSIS id never fails a whole answer.
// Stage C finding `tools-depth-chart-nongsis-id-internal`: the nflverse 2026 depth-chart file gives
// some players placeholder ids shaped AAA999999; D4 copied them into `gsis_id`, the output schema
// (GSIS_ID_RE) refused, and the whole team answered INTERNAL (tool.output_invalid) — one team live,
// eight teams' files carry such rows. Every tool that copies a dataset id into `gsis_id` now goes
// through schemas.ts asGsisId: the row still answers (null gsis_id, its ESPN id kept). D6's news
// refs read from the store take the same guard. Fake readers over the PORT contract (plan 05 §3).
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FreshnessClassId, DatasetSourceId } from "../../src/config/freshness.js";
import type {
  DatasetReaders,
  DatasetStamp,
  DepthChartRow,
  NewsItem,
} from "../../src/domain/analytics/types.js";
import { bareUntrusted, wrapUntrusted } from "../../src/domain/league/types.js";
import { asGsisId } from "../../src/mcp/tools/schemas.js";
import { envelopeViolations } from "./helpers/walk.js";
import { call, connect, makeWorld, T0, type World } from "./helpers/world.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld({});
}, 120_000);
afterAll(() => {
  world.cleanup();
});

function stamp(source: DatasetSourceId, cls: FreshnessClassId): DatasetStamp {
  return {
    source,
    as_of: T0,
    fetched_at: T0,
    checked_at: T0,
    freshness_class: cls,
    file_version: "x",
  };
}

async function withReaders(over: Partial<DatasetReaders>) {
  return connect(world, {
    options: { toolset: "full" },
    services: { datasets: { ...world.services.datasets, ...over } },
  });
}

/** A placeholder id the 2026 depth-chart file carries for a few players (three letters, six digits). */
const PLACEHOLDER = "ABC123456";

const row = (o: Partial<DepthChartRow>): DepthChartRow => ({
  season: 2026,
  week: null,
  nfl_team: "NO",
  pos_grp: "Offense",
  pos_abb: "RB",
  rank: 1,
  gsis_id: null,
  espn_id: null,
  name: bareUntrusted("Running Back", "player_name"),
  ...o,
});

const DEPTH: DepthChartRow[] = [
  row({ rank: 1, gsis_id: "00-0036973", espn_id: 4_239_996 }),
  row({ rank: 2, gsis_id: PLACEHOLDER, espn_id: 4_000_321 }),
  row({ rank: 3, gsis_id: PLACEHOLDER, espn_id: null }),
  row({ pos_abb: "WR", rank: 1, gsis_id: "not an id at all", espn_id: null }),
];

describe("asGsisId", () => {
  it("passes a GSIS id and nulls every other shape", () => {
    expect(asGsisId("00-0036973")).toBe("00-0036973");
    for (const v of [PLACEHOLDER, "00-003697", "00-00369733", " 00-0036973", null, undefined, 7])
      expect(asGsisId(v)).toBeNull();
  });
});

describe("D4 espn_get_depth_chart with placeholder ids", () => {
  let c: { client: Client; close: () => Promise<void> };
  beforeAll(async () => {
    c = await withReaders({
      depthCharts: {
        chart: () => ({
          rows: DEPTH,
          stamp: stamp("nflverse:depth_charts", "nflverse_depth_charts"),
        }),
      },
    });
  });
  afterAll(async () => {
    await c.close();
  });

  it("the team still answers: non-GSIS ids become null, ESPN ids stay, ranks intact", async () => {
    const r = await call(c.client, "espn_get_depth_chart", { nfl_team: "NO" });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect(envelopeViolations(r.body as never)).toEqual([]);
    const slots = (
      r.body.data as {
        teams: {
          groups: {
            slots: {
              pos_abb: string;
              rank: number;
              gsis_id: string | null;
              player_id: number | null;
            }[];
          }[];
        }[];
      }
    ).teams[0]?.groups.flatMap((g) => g.slots);
    expect(slots?.map((s) => [s.pos_abb, s.rank, s.gsis_id, s.player_id])).toEqual([
      ["RB", 1, "00-0036973", 4_239_996],
      ["RB", 2, null, 4_000_321],
      ["RB", 3, null, null],
      ["WR", 1, null, null],
    ]);
    expect(JSON.stringify(r.body)).not.toContain(PLACEHOLDER);
  });

  it("a player lookup on that team answers too (never INTERNAL)", async () => {
    // a rostered player the recorded pool pages know (the fixture answers filterIds from them);
    // the chart stub answers for his team's read
    const pool = await call(c.client, "espn_list_players", { status: "ONTEAM", limit: 100 });
    const p = (
      pool.body.data as { players: { player_id: number; pro_team: string | null }[] }
    ).players.find((x) => x.pro_team !== null && x.pro_team !== "FA");
    const r = await call(c.client, "espn_get_depth_chart", {
      player: { player_ids: [p?.player_id ?? 0] },
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  });
});

describe("D6 espn_get_news with a non-GSIS id in an item", () => {
  it("the item answers; the bad id is dropped from players_matched", async () => {
    const item: NewsItem = {
      id: "d".repeat(32),
      source: "rotowire",
      published_at: new Date(Date.parse(T0) - 3600_000).toISOString(),
      title: wrapUntrusted("Back ruled out", "rss.rotowire.title"),
      blurb: wrapUntrusted("He will not play.", "rss.rotowire.blurb"),
      url: wrapUntrusted("https://www.rotowire.com/x", "rss.rotowire.url"),
      gsis_ids: [PLACEHOLDER, "00-0036973"],
    };
    const c = await withReaders({
      news: { recent: () => ({ rows: [item], stamp: stamp("news:rotowire", "news") }) },
    });
    const r = await call(c.client, "espn_get_news", {});
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    const matched = (r.body.data as { items: { players_matched: { gsis_id: string | null }[] }[] })
      .items[0]?.players_matched;
    expect(matched?.map((m) => m.gsis_id)).toEqual(["00-0036973"]);
    await c.close();
  });
});
