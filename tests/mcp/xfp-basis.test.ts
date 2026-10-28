// xfp-basis.test.ts — D1's `xfp_ep` / `xfp_gap` on the league's scoring basis, end to end (plan 07 D1;
// plan 08 §5; sib research 05 §4.1 item 4; src/domain/analytics/xfp.ts). Stage C finding
// analytics-xfp-gap-scoring-basis: ffopportunity's own `total_fantasy_points_exp` is full PPR with a
// 4-pt passing TD, and D1 set it against fx-10h's points (the owner's format: half-PPR, 5-pt passing
// TD, −2 INT, −2 fumble lost) correcting receptions only — a QB who played exactly to his expectation
// read −1 per passing TD per game ("touchdown luck"). Here the store's expected components reach D1,
// which scores them under the league's S: a player who plays to expectation shows no gap, and a real
// under-producer shows his gap in league points. fx-10h in fixture mode, injected readers; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatasetSourceId, FreshnessClassId } from "../../src/config/freshness.js";
import type { NflTeam } from "../../src/config/schema.js";
import type {
  DatasetReaders,
  DatasetStamp,
  EpExpected,
  EpWeeklyRow,
  PlayerWeekLine,
} from "../../src/domain/analytics/types.js";
import type { CrosswalkPair } from "../../src/domain/crosswalk/types.js";
import { statLineFromPlayerWeek } from "../../src/domain/scoring/nflverse.js";
import type { McpServices } from "../../src/mcp/services.js";
import { envelopeViolations, identifierLeaks } from "./helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
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
    countMatchedByName: () => 0,
  };
}

const ZERO: EpExpected = {
  pass_att: 0,
  pass_cmp: 0,
  pass_yd: 0,
  pass_td: 0,
  pass_int: 0,
  pass_2pt: 0,
  pass_1d: 0,
  rush_att: 0,
  rush_yd: 0,
  rush_td: 0,
  rush_2pt: 0,
  rush_1d: 0,
  targets: 0,
  rec: 0,
  rec_yd: 0,
  rec_td: 0,
  rec_2pt: 0,
  rec_1d: 0,
};

/**
 * Two games every player of the fixture plays, by id parity: a passer's (250 yards, 2 TDs, 10 rushing
 * yards — 21 points under fx-10h's S, ffopportunity's own 19) and a pass catcher's (4 catches, 40
 * yards, a TD — 12 points, ffopportunity's own 14). Each is exactly the expectation in weeks 1–3; in
 * week 4 the expectation runs ahead of the game by half a TD (the real under-producer).
 */
const PASSER: EpExpected = {
  ...ZERO,
  pass_att: 34,
  pass_cmp: 22,
  pass_yd: 250,
  pass_td: 2,
  pass_1d: 12,
  rush_att: 3,
  rush_yd: 10,
};
const CATCHER: EpExpected = { ...ZERO, targets: 6, rec: 4, rec_yd: 40, rec_td: 1, rec_1d: 3 };
const passer = (id: number): boolean => id % 2 === 0;
const gameOf = (id: number): EpExpected => (passer(id) ? PASSER : CATCHER);
const UNDER_WEEK = 4;

function actualLine(x: EpExpected, nflPosition: string) {
  return statLineFromPlayerWeek({
    position: nflPosition,
    attempts: x.pass_att,
    completions: x.pass_cmp,
    passing_yards: x.pass_yd,
    passing_tds: x.pass_td,
    passing_interceptions: x.pass_int,
    passing_2pt_conversions: x.pass_2pt,
    passing_first_downs: x.pass_1d,
    sacks_suffered: 0,
    carries: x.rush_att,
    rushing_yards: x.rush_yd,
    rushing_tds: x.rush_td,
    rushing_2pt_conversions: x.rush_2pt,
    rushing_first_downs: x.rush_1d,
    targets: x.targets,
    receptions: x.rec,
    receiving_yards: x.rec_yd,
    receiving_tds: x.rec_td,
    receiving_2pt_conversions: x.rec_2pt,
    receiving_first_downs: x.rec_1d,
    sack_fumbles: 0,
    sack_fumbles_lost: 0,
    rushing_fumbles: 0,
    rushing_fumbles_lost: 0,
    receiving_fumbles: 0,
    receiving_fumbles_lost: 0,
    special_teams_tds: 0,
    fumble_recovery_tds: 0,
  });
}

function playerWeeks(team: NflTeam, at: string): DatasetReaders["playerWeeks"] {
  return {
    lines: (gsis, season, weeks) => ({
      rows: gsis.flatMap((g) =>
        weeks
          .filter((w) => w <= 4)
          .map((w): PlayerWeekLine => {
            const id = idOfGsis(g);
            const nflPosition = passer(id) ? "QB" : "WR";
            return {
              gsis_id: g,
              season,
              week: w,
              nfl_team: team,
              opponent: "MIA",
              position: nflPosition,
              line: actualLine(gameOf(id), nflPosition),
              usage: null,
            };
          }),
      ),
      stamp: stamp("nflverse:stats_player_week", "nflverse_stats_player_week", at),
    }),
    defenseLines: () => ({ rows: [], stamp: null }),
  };
}

function epWeekly(at: string): DatasetReaders["epWeekly"] {
  return {
    rows: (gsis, season, weeks) => ({
      rows: gsis.flatMap((g) =>
        weeks.map((w): EpWeeklyRow => {
          const id = idOfGsis(g);
          const x = gameOf(id);
          const under = w === UNDER_WEEK;
          const expected: EpExpected = passer(id)
            ? { ...x, pass_td: x.pass_td + (under ? 0.5 : 0) }
            : { ...x, rec_td: x.rec_td + (under ? 0.5 : 0) };
          return {
            gsis_id: g,
            season,
            week: w,
            // ffopportunity's own number for the same expectation (full PPR, 4-pt passing TD)
            xfp_total: passer(id) ? 19 + (under ? 2 : 0) : 14 + (under ? 3 : 0),
            expected,
          };
        }),
      ),
      stamp: stamp("ffopportunity:ep_weekly", "ffopportunity_ep_weekly", at),
    }),
  };
}

interface UsagePlayer {
  player_id: number | null;
  position: string;
  games: {
    week: number;
    xfp_ep: number | null;
    points_league: number | null;
    xfp_gap: number | null;
  }[];
  trailing: { window_games: number; xfp_gap_sum: number | null };
}

describe("D1 on fx-10h (the owner's format): xFP and the gap on one scoring basis", () => {
  let world: World;
  let players: UsagePlayer[];
  let close: () => Promise<void>;
  beforeAll(async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as { clock: string };
    world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: 2,
      clock: m.clock,
      publishEspn: false,
    });
    const at = m.clock;
    const c = await connect(world, {
      options: { toolset: "full" },
      services: {
        crosswalk: crosswalk(at),
        datasets: {
          ...world.services.datasets,
          playerWeeks: playerWeeks("BUF", at),
          epWeekly: epWeekly(at),
        },
      },
    });
    close = c.close;
    await call(c.client, "espn_get_league", {});
    const r = await call(c.client, "espn_get_player_usage", {
      players: { team_id: 2 },
      detail: "full",
    });
    if (r.isError) throw new Error(`D1 failed: ${JSON.stringify(r.body).slice(0, 400)}`);
    expect(envelopeViolations(r.body as never)).toEqual([]);
    expect(identifierLeaks(JSON.stringify(r.body))).toEqual([]);
    players = (r.body as { data: { players: UsagePlayer[] } }).data.players.filter(
      (p) => p.player_id !== null && p.games.length > 0,
    );
  }, 120_000);
  afterAll(async () => {
    await close();
    world.cleanup();
  });

  it("covers both shapes of game (the fixture roster has passers and pass catchers by id parity)", () => {
    expect(players.some((p) => passer(p.player_id ?? 1))).toBe(true);
    expect(players.some((p) => !passer(p.player_id ?? 0))).toBe(true);
    for (const p of players) expect(p.games.map((g) => g.week)).toEqual([1, 2, 3, 4]);
  });

  const toExpectation = (qb: boolean) => (): void => {
    const points = qb ? 21 : 12;
    const mine = players.filter((p) => passer(p.player_id ?? 0) === qb);
    expect(mine.length).toBeGreaterThan(0);
    for (const p of mine)
      for (const g of p.games.filter((x) => x.week !== UNDER_WEEK)) {
        expect(g.xfp_gap, String(p.player_id)).toBe(0);
        expect(g.points_league, String(p.player_id)).toBe(points);
        expect(g.xfp_ep, String(p.player_id)).toBe(points);
      }
  };
  it(
    "a passer who plays to his expectation (250 yards, 2 TDs): gap 0 and xfp_ep = his 21 points — no 'touchdown luck' from the 5-pt passing TD",
    toExpectation(true),
  );
  it(
    "a pass catcher who plays to his expectation (4 catches, 40 yards, a TD): gap 0 and xfp_ep = his 12 half-PPR points, not ffopportunity's full-PPR 14",
    toExpectation(false),
  );

  it("a real under-producer shows his gap in league points (half a passing TD = 2.5, half a receiving TD = 3)", () => {
    for (const p of players) {
      const qb = passer(p.player_id ?? 0);
      const g = p.games.find((x) => x.week === UNDER_WEEK);
      expect(g?.xfp_ep, String(p.player_id)).toBe(qb ? 23.5 : 15);
      expect(g?.xfp_gap, String(p.player_id)).toBe(qb ? 2.5 : 3);
      // the trailing sum reads the same rows: only week 4 differs from its expectation
      expect(p.trailing.window_games).toBe(4);
      expect(p.trailing.xfp_gap_sum, String(p.player_id)).toBe(qb ? 2.5 : 3);
    }
  });
});
