// retro-forecasts.test.ts — espn_analyze_retrospective scores the projections and probabilities the
// tools served (plan 07 E13: projection CRPS/MAE against ESPN, the Brier table with ESPN's
// comparators from the pre-week scoreboard_snapshot — T-07; plan 01 §9.2). Stage C finding
// reclog-retro-forecasts-never-scored: E13 passed player_forecasts [] and empty probabilities, so
// every metric read "n too small (0 of 30)" forever whatever was stored, and no tool read
// scoreboardSnapshots.forWeek — while forWeek has no season, so a rollover would have read a
// previous season's week N. Attempt 2 (the verifier: the P(win) part was not fixed): OUR P(win) of
// the lineups as played was filled, for every starter E1 had stored no row for — every kicker and
// D/ST, every player without a trailing line, a whole lineup nobody projected — from ESPN's number
// in the FINAL box score (a game-day value, 0 for an inactive starter): with no projection ever
// served it still scored n = 2. Now E1 stores every first-week projection it serves (an empty
// expectation where it has no line; the attribution skips those), and a week is scored only when
// every starter of both lineups carries a Dist served before his kickoff. Through the real write
// path and the real store (fixture mode on league-a; no network).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { LiveMatchup } from "../../src/domain/league/types.js";
import { SERVED_DIST_KEY } from "../../src/mcp/tools/projection-v2.js";
import { servedDistOf } from "../../src/mcp/tools/retro-p3.js";
import { datasetDir, storePath } from "../../src/config/paths.js";
import {
  SEASON,
  T0,
  call,
  connect,
  makeWorld,
  publishEspnDatasets,
  type World,
} from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;
let me = 0;
const opp = new Map<number, number>();
/** My roster's week-3 E1 rows (id, position, opponent) as served before lock. */
let served3: { player_id: number; position: string; weeks: { opponent: string | null }[] }[] = [];

const side = (team: number, p: number | null) => ({
  team_id: team,
  name: { untrusted_text: { value: "Team", source: "espn.team.name", chars: 4, truncated: false } },
  points_live: null,
  projected_pre_espn: null,
  projected_live_espn: null,
  win_probability_espn: p,
  players: null,
});

beforeAll(async () => {
  // the clock only runs forward (the ESPN limiter counts requests by instant): before week 2 locks
  world = await makeWorld({
    league: "league-a",
    publishNflverse: true,
    clock: "2026-09-15T12:00:00.000Z",
  });
  ({ client, close } = await connect(world));
  const league = await call(client, "espn_get_league");
  me = (league.body.data as { league: { my_team: { team_id: number } } }).league.my_team.team_id;
  for (const w of [2, 3]) {
    const sb = await call(client, "espn_get_scoreboard", { week: w });
    const m = (
      sb.body.data as {
        matchups: { home: { team_id: number }; away: { team_id: number } | null }[];
      }
    ).matchups.find((x) => x.home.team_id === me || x.away?.team_id === me);
    opp.set(w, m?.home.team_id === me ? (m.away?.team_id ?? 0) : (m?.home.team_id ?? 0));
  }
  // both lineups projected before each week locked, as the weekly Skill projects them
  for (const [w, at] of [
    [2, "2026-09-15T12:00:00.000Z"],
    [3, "2026-09-22T12:00:00.000Z"],
  ] as const) {
    world.clock.set(at);
    for (const team of [me, opp.get(w) ?? 0]) {
      const r = await call(client, "espn_project_players", {
        players: { team_id: team },
        horizon: "week",
        week: w,
        allow_stale: true,
      });
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      if (w === 3 && team === me)
        served3 = (r.body.data as { projections: typeof served3 }).projections;
    }
  }
  // ESPN's pre-week win probability: this season's week 3; for week 2 only LAST season's snapshot
  const live = (p: number): LiveMatchup[] => [
    {
      matchup_id: 1,
      home: side(me, p),
      away: side(99, 1 - p),
      is_mine: true,
    } as unknown as LiveMatchup,
  ];
  world.store.repos.scoreboardSnapshots.put({
    week: 3,
    taken_at: "2026-09-23T12:00:00.000Z",
    matchups: live(0.5),
    playoff_pct_espn: {},
  });
  world.store.repos.scoreboardSnapshots.put({
    week: 2,
    taken_at: "2025-09-16T12:00:00.000Z",
    matchups: live(0.9),
    playoff_pct_espn: {},
  });
  // the recording day (weeks 1–3 final), the pro schedule refreshed as the nightly job would
  world.clock.set(T0);
  await publishEspnDatasets({
    storePath: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    clock: world.clock,
  });
  world.store.reopenChangedDatasets();
}, 240_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("E13 scores what was served (Stage C reclog-retro-forecasts-never-scored)", () => {
  it("E1 stores the Dist it served with each first-week projection", async () => {
    const roster = await call(client, "espn_get_roster", { week: 3 });
    const ids = (roster.body.data as { players: { player_id: number }[] }).players.map(
      (p) => p.player_id,
    );
    const stored = ids
      .map((id) => world.store.repos.projections.getAsOf(id, SEASON, 3, "v1-ensemble", T0))
      .filter((x) => x !== null);
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) {
      expect(row.trace?.[SERVED_DIST_KEY]).toBeDefined();
      expect(servedDistOf(row)?.mean).toBe(row.reported_mean);
    }
  });

  it("every player E1 served a game week is stored — a kicker and a D/ST too (no trailing line)", () => {
    const playing = served3.filter(
      (p) => p.player_id !== 0 && (p.weeks[0]?.opponent ?? null) !== null,
    );
    expect(playing.some((p) => p.position === "K")).toBe(true);
    expect(playing.some((p) => p.position === "D/ST")).toBe(true);
    for (const p of playing) {
      const row =
        world.store.repos.projections.getAsOf(p.player_id, SEASON, 3, "v2-opportunity", T0) ??
        world.store.repos.projections.getAsOf(p.player_id, SEASON, 3, "v1-ensemble", T0);
      expect(row, `${p.position} ${String(p.player_id)}`).not.toBeNull();
      expect(row === null ? null : servedDistOf(row), p.position).not.toBeNull();
    }
  });

  it("projection CRPS vs ESPN, P(active) and P(win) beside ESPN's pre-week number of THIS season", async () => {
    const r = await call(client, "espn_analyze_retrospective", { week: 3, min_n: 1 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    const m = (
      r.body.data as {
        metrics: {
          projection_vs_espn: {
            crps_ours: number | null;
            crps_espn: number | null;
            n_player_weeks: number;
          };
          brier: Record<string, { ours: unknown; espn: unknown; n: number }>;
        };
      }
    ).metrics;
    expect(m.projection_vs_espn.n_player_weeks).toBeGreaterThan(5);
    expect(m.projection_vs_espn.crps_ours).not.toBeNull();
    expect(m.projection_vs_espn.crps_espn).not.toBeNull();
    expect(m.brier.p_active?.n).toBeGreaterThan(5);
    // two weeks of P(win) forecasts: ESPN's number for week 3 only — last season's week-2 snapshot
    // never answers for this season's week 2
    expect(m.brier.p_win?.n).toBe(2);
    expect(m.brier.p_win?.espn).not.toBeNull();
    expect(r.body.warnings as string[]).toContain(
      "retrospective: p_win ESPN comparator present on 1 of 2 forecasts",
    );
    const sources = (r.body.meta as { source: string[] }).source;
    expect(sources).toEqual(
      expect.arrayContaining(["store:projection", "store:scoreboard_snapshot"]),
    );
  }, 120_000);
});

describe("OUR P(win) is only what was served before lock (attempt 2)", () => {
  // no nflverse excerpts: no player has a trailing line, so before the fix E1 stored NO row at all
  // and every starter's Dist came from the final box score
  const pWinAt3 = async (served: "none" | "mine" | "both") => {
    const w = await makeWorld({ league: "league-a", clock: "2026-09-22T12:00:00.000Z" });
    const c = await connect(w);
    try {
      const league = await call(c.client, "espn_get_league");
      const mine = (league.body.data as { league: { my_team: { team_id: number } } }).league.my_team
        .team_id;
      const sb = await call(c.client, "espn_get_scoreboard", { week: 3 });
      const m = (
        sb.body.data as {
          matchups: { home: { team_id: number }; away: { team_id: number } | null }[];
        }
      ).matchups.find((x) => x.home.team_id === mine || x.away?.team_id === mine);
      const theirs = m?.home.team_id === mine ? (m.away?.team_id ?? 0) : (m?.home.team_id ?? 0);
      expect(theirs).toBeGreaterThan(0);
      // before week 3 locks, as the weekly Skill projects them
      for (const team of served === "none" ? [] : served === "mine" ? [mine] : [mine, theirs]) {
        const r = await call(c.client, "espn_project_players", {
          players: { team_id: team },
          horizon: "week",
          week: 3,
          allow_stale: true,
        });
        expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      }
      // the recording day (weeks 1–3 final), the pro schedule refreshed as the nightly job would
      w.clock.set(T0);
      await publishEspnDatasets({
        storePath: storePath(w.cache),
        datasetDir: datasetDir(w.cache),
        clock: w.clock,
      });
      w.store.reopenChangedDatasets();
      const r = await call(c.client, "espn_analyze_retrospective", { week: 3, min_n: 1 });
      expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
      const data = r.body.data as {
        metrics: { brier: { p_win: { ours: unknown; n: number } } };
        sample_size: Record<string, { n: number } | undefined>;
      };
      return {
        pWin: data.metrics.brier.p_win,
        attributed: data.sample_size.attribution?.n ?? 0,
        warnings: r.body.warnings as string[],
      };
    } finally {
      await c.close();
      w.cleanup();
    }
  };
  const unscored =
    /^\d+ week\(s\) without a pre-lock projection for every starter of both lineups: no P\(win\) forecast for them$/;

  it("nothing served: no P(win) of ours — never ESPN's final box-score number (the verifier's repro)", async () => {
    const got = await pWinAt3("none");
    expect(got.pWin.n).toBe(0);
    expect(got.pWin.ours).toMatch(/^n too small \(0 of 1\)/);
    expect(got.warnings.some((x) => unscored.test(x))).toBe(true);
  }, 240_000);

  it("one lineup served: the week is not ours either (the opponent's starters were not projected)", async () => {
    const got = await pWinAt3("mine");
    expect(got.pWin.n).toBe(0);
    expect(got.pWin.ours).toMatch(/^n too small \(0 of 1\)/);
    expect(got.warnings.some((x) => unscored.test(x))).toBe(true);
  }, 240_000);

  it("both lineups served before lock: week 3 is ours — kickers and D/ST included", async () => {
    const got = await pWinAt3("both");
    expect(got.pWin.n).toBe(1);
    expect(typeof got.pWin.ours).toBe("number");
    // no player had a trailing line: every stored row is line-free, and the attribution (which has
    // no line to decompose in them) reads none of them
    expect(got.attributed).toBe(0);
  }, 240_000);
});
