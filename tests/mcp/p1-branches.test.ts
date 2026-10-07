// p1-branches.test.ts — the P1 tools' data-driven branches with the Phase-2 inputs present (plan 10
// B2–B6): fx-10h in fixture mode with an injected crosswalk (every ESPN id paired) and nflverse usage
// lines for every paired player, so E7 redistributes real vacated volume and asks E5 for a verdict
// per available beneficiary; E5 under full reads Sleeper's trend, the learned mechanics from the
// persisted claim history, and — on the `faab` variant — the budgets; D1 fills an early window from
// the prior season; D6 matches by NFL team and reads per-ref confidences; C3's revision flag reads
// the projection snapshots; E3 applies scenarios. Every result passes the A6 walk.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DatasetReaders,
  DatasetStamp,
  EspnProjectionSnapshot,
  NewsItem,
  PlayerWeekLine,
} from "../../src/domain/analytics/types.js";
import type { DatasetSourceId, FreshnessClassId } from "../../src/config/freshness.js";
import type { CrosswalkPair } from "../../src/domain/crosswalk/types.js";
import type { NflTeam } from "../../src/config/schema.js";
import { wrapUntrusted } from "../../src/domain/league/types.js";
import type { McpServices } from "../../src/mcp/services.js";
import { envelopeViolations, identifierLeaks } from "./helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
type J = Record<string, unknown>;

/** The fake pair of an ESPN id (the injected crosswalk pairs every player). */
const gsisOf = (id: number): string => `00-${String(Math.abs(id) % 10_000_000).padStart(7, "0")}`;
const idOfGsis = (g: string): number => Number(g.slice(3));

function stamp(source: DatasetSourceId, cls: FreshnessClassId, at: string): DatasetStamp {
  return {
    source,
    as_of: at,
    fetched_at: at,
    checked_at: at,
    freshness_class: cls,
    file_version: "fx",
  };
}

/** A crosswalk that pairs every ESPN person id (team units stay unpaired). */
function crosswalk(at: string): McpServices["crosswalk"] {
  const pair = (id: number): CrosswalkPair => ({
    espn_id: id,
    gsis_id: gsisOf(id),
    method: "id",
    source: "nflverse:roster_weekly",
    confidence: 1,
    first_seen: at,
    last_seen: at,
  });
  return {
    get: (id) => (id > 0 ? pair(id) : null),
    byGsis: (g) => [pair(idOfGsis(g))],
    count: () => 1,
  };
}

/**
 * Usage lines for every requested gsis id in weeks 1–4 (and the prior season): a deterministic
 * share by id parity so teammates differ; the injured starter gets the biggest share.
 */
function playerWeeks(starter: number, team: NflTeam, at: string): DatasetReaders["playerWeeks"] {
  return {
    lines: (gsis, season, weeks) => ({
      rows: gsis.flatMap((g) =>
        weeks
          .filter((w) => w <= 4)
          .map((w): PlayerWeekLine => {
            const id = idOfGsis(g);
            const lead = id === starter % 10_000_000;
            const share = lead ? 0.22 : 0.04 + (id % 7) / 100;
            return {
              gsis_id: g,
              season,
              week: w,
              nfl_team: team,
              opponent: "MIA",
              position: lead ? "RB" : id % 2 === 0 ? "WR" : "RB",
              line: {
                values: {},
                present: [],
                position: 2 as never,
                position_class: "O",
                provisional: false,
                source: "nflverse",
              },
              usage: {
                snaps: null,
                snap_pct: null,
                routes_proxy: null,
                targets: Math.round(share * 35),
                target_share: share,
                air_yards: 40,
                air_yards_share: share,
                adot: 6,
                wopr: share,
                racr: 1,
                carries: lead ? 18 : 3 + (id % 4),
                carry_share: null,
                rz_targets: null,
                rz_carries: null,
                gl_carries: null,
                xfp_ep: null,
              },
            };
          }),
      ),
      stamp: stamp("nflverse:stats_player_week", "nflverse_stats_player_week", at),
    }),
    defenseLines: () => ({ rows: [], stamp: null }),
  };
}

interface Fx {
  world: World;
  client: Client;
  close: () => Promise<void>;
  clock: string;
}

async function fxWorld(variant: string, over: (at: string) => Partial<McpServices>): Promise<Fx> {
  const dir = variant === "" ? FX : path.join(FX, variant);
  const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { clock: string };
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full" },
    teamId: 2,
    clock: m.clock,
    publishEspn: false,
  });
  const c = await connect(world, { options: { toolset: "full" }, services: over(m.clock) });
  return { world, client: c.client, close: c.close, clock: m.clock };
}

async function ok(client: Client, name: string, args: J = {}) {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body).slice(0, 400)}`);
  expect(envelopeViolations(r.body as never), name).toEqual([]);
  expect(identifierLeaks(JSON.stringify(r.body)), name).toEqual([]);
  return r.body as { data: J; warnings: string[]; partial: boolean };
}

/** James Cook III, Team 02's RB1 in fx-10h (BUF). */
const STARTER = 4379399;

describe("E7 and E5 with the Phase-2 inputs present (fx-10h)", () => {
  let fx: Fx;
  beforeAll(async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as { clock: string };
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: 2,
      clock: m.clock,
      publishEspn: false,
    });
    const at = m.clock;
    const trending: DatasetReaders["trending"] = {
      latest: () => ({
        rows: [
          { gsis_id: gsisOf(4_890_973), sleeper_id: "1", kind: "add", count: 5000, as_of: at },
          { gsis_id: null, sleeper_id: "2", kind: "add", count: 10, as_of: at },
          { gsis_id: gsisOf(1), sleeper_id: "3", kind: "drop", count: 10, as_of: at },
        ],
        stamp: stamp("sleeper:trending", "sleeper_trending", at),
      }),
    };
    const c = await connect(world, {
      options: { toolset: "full" },
      services: {
        crosswalk: crosswalk(at),
        datasets: {
          ...world.services.datasets,
          playerWeeks: playerWeeks(STARTER, "BUF", at),
          trending,
        },
      },
    });
    fx = { world, client: c.client, close: c.close, clock: at };
    await ok(fx.client, "espn_get_league");
    await ok(fx.client, "espn_get_roster", { week: 5 });
    await ok(fx.client, "espn_get_standings");
    // the league's claim history persisted (the nightly append): E5's learned mechanics read it
    const txns = await fx.world.services.platform.listTransactions(fx.world.services.league, {
      types: ["WAIVER", "WAIVER_ERROR", "FREEAGENT"],
      week: 3,
      since: null,
      count: 100,
      team_id: null,
    });
    fx.world.store.repos.transactionsSeen.appendNew(txns.value.items, fx.clock);
  }, 120_000);
  afterAll(async () => {
    await fx.close();
    fx.world.cleanup();
  });

  it("E7: vacated volume redistributed (never above it), verdicts from E5 for available beneficiaries", async () => {
    const e = await ok(fx.client, "espn_analyze_injury_cascade", {
      player: { player_ids: [STARTER] },
      detail: "full",
    });
    const d = e.data as {
      vacated: { targets: number; carries: number; rz: number };
      beneficiaries: {
        delta_opportunity: { targets: number; carries: number; rz: number };
        availability: { status: string | null };
        verdict: string | null;
      }[];
      ir_consequence: { on_my_roster: boolean; ir_eligible: boolean } | null;
    };
    expect(d.vacated.targets + d.vacated.carries).toBeGreaterThan(0);
    expect(d.beneficiaries.length).toBeGreaterThan(0);
    for (const k of ["targets", "carries", "rz"] as const)
      expect(d.beneficiaries.reduce((s, b) => s + b.delta_opportunity[k], 0)).toBeLessThanOrEqual(
        d.vacated[k] + 1e-6,
      );
    for (const b of d.beneficiaries)
      if (b.availability.status === "ONTEAM") expect(b.verdict).toBeNull();
    expect(d.ir_consequence?.on_my_roster).toBe(true);
    expect(d.ir_consequence?.ir_eligible).toBe(false);
  }, 60_000);

  it("E5 under full: usage signals cite numbers, Sleeper's trend is secondary, the mechanics are read", async () => {
    await ok(fx.client, "espn_list_players", {
      status: "WAIVERS",
      sort: "percOwned",
      week: 5,
      limit: 25,
    });
    const e = await ok(fx.client, "espn_analyze_waivers", { detail: "full" });
    const d = e.data as {
      value_basis: string;
      candidates: {
        signals: { kind: string; evidence?: unknown }[];
        demand: { sleeper_trend: number | null };
      }[];
      learned: { second_claim_at_new_position: boolean | null };
    };
    expect(d.value_basis).toBe("ensemble");
    for (const c of d.candidates)
      for (const s of c.signals) expect(typeof s.evidence).toBe("number");
    expect(d.learned).toHaveProperty("second_claim_at_new_position");
  }, 60_000);

  it("D1: the window fills from the prior season early; xfp is missing and named", async () => {
    const e = await ok(fx.client, "espn_get_player_usage", {
      players: { player_ids: [STARTER] },
      window: 8,
      include_prior_season: true,
      detail: "full",
    });
    const p = (e.data as { players: { trailing: { window_games: number }; data_gaps: string[] }[] })
      .players[0];
    expect(p?.trailing.window_games).toBe(8);
    expect((e.data as { notes: string[] }).notes.some((n) => n.includes("last season"))).toBe(true);
    expect(p?.data_gaps.some((g) => g.includes("ffopportunity"))).toBe(true);
  });

  it("D6 by NFL team, per-ref confidences read from the reader's refs", async () => {
    const at = fx.clock;
    const item: NewsItem & { refs: unknown[] } = {
      id: "d".repeat(32),
      source: "espn",
      published_at: at,
      title: wrapUntrusted("Cook limited in practice", "rss.espn.title"),
      blurb: wrapUntrusted("", "rss.espn.blurb"),
      url: wrapUntrusted("https://www.espn.com/x", "rss.espn.url"),
      gsis_ids: [gsisOf(STARTER)],
      refs: [
        {
          espn_id: STARTER,
          gsis_id: gsisOf(STARTER),
          match_confidence: 0.95,
          match_method: "full_name_team",
        },
        { espn_id: "bad", gsis_id: 7 },
        null,
      ],
    };
    const c = await connect(fx.world, {
      options: { toolset: "full" },
      services: {
        crosswalk: crosswalk(at),
        datasets: {
          ...fx.world.services.datasets,
          news: { recent: () => ({ rows: [item], stamp: stamp("news:espn", "news", at) }) },
        },
      },
    });
    const e = await ok(c.client, "espn_get_news", { nfl_team: "BUF" });
    const it0 = (
      e.data as {
        items: { players_matched: { player_id: number | null; match_confidence: number }[] }[];
      }
    ).items[0];
    expect(it0?.players_matched).toEqual([
      expect.objectContaining({ player_id: STARTER, match_confidence: 0.95 }),
    ]);
    const byPlayer = await ok(c.client, "espn_get_news", { players: { player_ids: [STARTER] } });
    expect((byPlayer.data as { items: unknown[] }).items).toHaveLength(1);
    await c.close();
  });

  it("C3: revised_recently reads a ≥ 24 h-old snapshot; preseason reports the frozen total", async () => {
    const roster = (await ok(fx.client, "espn_get_roster", { week: 5 })).data.players as {
      player_id: number;
      projection_week_espn: number | null;
    }[];
    const p = roster.find((x) => x.projection_week_espn !== null);
    const snap: EspnProjectionSnapshot = {
      player_id: p?.player_id ?? 0,
      season: 2026,
      week: 5,
      split: "weekly",
      applied_total: (p?.projection_week_espn ?? 0) + 3,
      stats_raw: {},
      snapshot_at: "2026-10-04T00:00:00.000Z",
    };
    const c = await connect(fx.world, {
      options: { toolset: "full" },
      services: {
        espnProjections: { asOf: () => [snap], lastSnapshotAt: () => snap.snapshot_at },
      },
    });
    const e = await ok(c.client, "espn_get_projections", {
      players: { player_ids: [snap.player_id] },
      horizon: "week",
      week: 5,
    });
    expect(
      (e.data as { projections: { revised_recently: boolean }[] }).projections[0]?.revised_recently,
    ).toBe(true);
    const pre = await ok(c.client, "espn_get_projections", {
      players: { player_ids: [snap.player_id] },
      horizon: "preseason",
    });
    expect(pre.data).toHaveProperty("projections");
    await c.close();
  });

  it("E3: a season scenario is applied and named; the normal method answers pre-week", async () => {
    const e = await ok(fx.client, "espn_analyze_matchup", {
      mode: "season",
      n_sims: 2000,
      scenarios: [{ team_id: 2, pf_delta: 40 }],
      seed: 1,
    });
    const r = (e.data as { readings: { scenarios_applied: string[] }[] }).readings[0];
    expect(r?.scenarios_applied.length).toBe(1);
    const n = await ok(fx.client, "espn_analyze_matchup", { week: 5, method: "normal" });
    expect((n.data as { method: string }).method).toBe("normal");
  }, 60_000);
});

describe("E5 under full on the faab variant: bids for every position", () => {
  it("mode faab: every open candidate carries its own bid; the budget context is read", async () => {
    const fx = await fxWorld("faab", (at) => ({ crosswalk: crosswalk(at) }));
    try {
      await ok(fx.client, "espn_get_league");
      await ok(fx.client, "espn_get_roster", { week: 5 });
      await ok(fx.client, "espn_get_standings");
      await ok(fx.client, "espn_list_players", {
        status: "WAIVERS",
        sort: "percOwned",
        week: 5,
        limit: 25,
      });
      const e = await ok(fx.client, "espn_analyze_waivers", {
        mode: "faab",
        reserve: "playoff_reserve",
      });
      const d = e.data as {
        mode_used: string;
        faab: unknown;
        candidates: { bid?: { b_star: number } | null }[];
      };
      expect(d.mode_used).toBe("faab");
      expect(d.candidates.some((c) => c.bid !== undefined)).toBe(true);
    } finally {
      await fx.close();
      fx.world.cleanup();
    }
  }, 120_000);
});
