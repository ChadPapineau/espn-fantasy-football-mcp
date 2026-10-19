// phase3-tools.test.ts — the Phase 3 records end to end at the TOOL level on the seeded fixture league
// (plan 10 §3.3; tests/integration/helpers/seed.ts — exactly what the stdio suites see), through the
// real composition root in fixture mode under EFF_TOOLSET=full:
//   C9 — E1 stores each v2 projection (expectation, P(active), reported mean, trace); E13 joins the
//        projections stored BEFORE KICKOFF to the final box scores (n_player_weeks, the key grammar)
//        and never applies anything;
//   C8 — E10 logs its scorable claims value-free and reads the calibration table: 0 news claims →
//        posterior null and the hand-set note; 200 scored → the posterior and no note; E13 scores a
//        logged claim of a final week from the box score;
//   C5 — E5 logs the priority run it priced; 13 runs in the league's feed → premium_basis
//        league_fitted (below → the cold-start table, said);
//   C6 — E7 passes the redistribution prior table (its assumption names it).
// Store rows are seeded through the real repositories; league id "0"; ids are public player ids.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { ATTRIBUTION_KEY_RE } from "../../src/domain/reclog/attribution.js";
import { readTrace } from "../../src/domain/reclog/realised.js";
import { SERVED_DIST_KEY, clearMatchupMemo } from "../../src/mcp/tools/projection-v2.js";
import { servedDistOf } from "../../src/mcp/tools/retro-p3.js";
import { envelopeViolations, identifierLeaks } from "../mcp/helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { seedDatasets } from "./helpers/seed.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
  current_week: number;
};
const L = "0";
const SEASON = 2026;

/** Week-4 box-score players of fx-10h (id, ESPN position id). */
function week4Players(): { id: number; pos: number }[] {
  const b = JSON.parse(readFileSync(path.join(FX, "league", "mBoxscore.sp4.json"), "utf8")) as {
    schedule: {
      home?: Side;
      away?: Side;
    }[];
  };
  interface Side {
    rosterForCurrentScoringPeriod?: {
      entries?: { playerPoolEntry: { player: { id: number; defaultPositionId: number } } }[];
    };
  }
  const out: { id: number; pos: number }[] = [];
  for (const m of b.schedule)
    for (const s of [m.home, m.away])
      for (const e of s?.rosterForCurrentScoringPeriod?.entries ?? []) {
        const p = e.playerPoolEntry.player;
        if (p.id > 0) out.push({ id: p.id, pos: p.defaultPositionId });
      }
  return out;
}

let world: World;

beforeAll(async () => {
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: manifest.my_team_id,
    clock: manifest.clock,
    publishEspn: false,
  });
  await seedDatasets(world.store, {
    storePath: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    cache: world.cache,
    clock: world.clock,
    season: SEASON,
  });
  world.store.reopenChangedDatasets();
}, 300_000);
afterAll(() => {
  world.cleanup();
});

async function tool(
  name: string,
  args: Record<string, unknown>,
  toolset: "core" | "full" = "full",
) {
  clearMatchupMemo();
  const c = await connect(world, { options: { toolset } });
  try {
    const r = await call(c.client, name, args);
    expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
    expect(envelopeViolations(r.body as never), name).toEqual([]);
    expect(identifierLeaks(JSON.stringify(r.body)), name).toEqual([]);
    return r.body as { data: Record<string, unknown>; warnings: string[] };
  } finally {
    await c.close();
  }
}

describe("C9: E1 stores v2 projections; E13 attributes the ones stored before kickoff", () => {
  it("an E1 call under full stores each v2-served player's projection with its attribution fields", async () => {
    const roster = (
      await tool("espn_get_roster", { team_id: manifest.my_team_id, week: manifest.current_week })
    ).data.players as { player_id: number; position: string }[];
    const ids = roster.filter((p) => ["RB", "WR"].includes(p.position)).map((p) => p.player_id);
    const e1 = await tool("espn_project_players", {
      players: { player_ids: ids.slice(0, 5) },
      horizon: "week",
      seed: 3,
    });
    const served = (
      e1.data.projections as {
        player_id: number;
        weeks: { points: { mean: number; basis: string } }[];
      }[]
    ).filter((p) => p.weeks[0]?.points.basis === "player_sim");
    expect(served.length).toBeGreaterThan(0);
    for (const p of served) {
      const st = world.store.repos.projections.latest(
        p.player_id,
        SEASON,
        manifest.current_week,
        "v2-opportunity",
      );
      expect(st).not.toBeNull();
      expect(st?.reported_mean).toBeCloseTo(p.weeks[0]?.points.mean ?? NaN, 1);
      expect(st?.p_active).toBeGreaterThanOrEqual(0);
      expect(Object.keys(st?.expectation ?? {})).toEqual(expect.arrayContaining(["targets"]));
      const trace = st?.trace as { shares: unknown[]; rates: unknown[] } | null | undefined;
      expect(Array.isArray(trace?.rates)).toBe(true);
    }
  });

  it("under core, E1 stores v1-ensemble projections (trailing expectation, P(active), reported mean)", async () => {
    const roster = (
      await tool(
        "espn_get_roster",
        { team_id: manifest.my_team_id, week: manifest.current_week },
        "core",
      )
    ).data.players as { player_id: number; position: string }[];
    const ids = roster.map((p) => p.player_id).slice(0, 6);
    const e1 = await tool(
      "espn_project_players",
      { players: { player_ids: ids }, horizon: "week", seed: 5 },
      "core",
    );
    expect(e1.data.model_version).toBe("v1-ensemble");
    const rows = ids
      .map((id) =>
        world.store.repos.projections.latest(id, SEASON, manifest.current_week, "v1-ensemble"),
      )
      .filter((r) => r !== null);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // no tuning trace (v1 has none); the trace keeps only the Dist E1 served, which E13 scores
      // (Stage C finding reclog-retro-forecasts-never-scored)
      expect(readTrace(r.trace)).toBeNull();
      expect(Object.keys(r.trace ?? {})).toEqual([SERVED_DIST_KEY]);
      expect(servedDistOf(r)?.mean).toBe(r.reported_mean);
      expect(typeof r.reported_mean).toBe("number");
      expect(Object.keys(r.expectation).length).toBeGreaterThan(0);
    }
  });

  it("E13 joins week-4 projections stored before kickoff to the box scores; a post-kickoff one is never read", async () => {
    const players = week4Players()
      .filter((p) => p.pos >= 2 && p.pos <= 4)
      .slice(0, 12);
    // one more player backed by a v1-ensemble row (E1 under core stores those): attributed too
    const v1Player = week4Players().find(
      (p) => p.pos >= 1 && p.pos <= 4 && !players.some((x) => x.id === p.id),
    );
    if (v1Player !== undefined)
      world.store.repos.projections.put({
        player_id: v1Player.id,
        gsis_id: null,
        season: SEASON,
        week: 4,
        model_version: "v1-ensemble",
        made_at: "2026-09-21T12:00:00.000Z",
        inputs_as_of: "2026-09-21T12:00:00.000Z",
        expectation: { pass_att: 30, pass_cmp: 20, pass_yd: 230, rush_att: 3 },
        samples: [],
        p_active: 1,
        reported_mean: 15,
        trace: null,
      });
    for (const p of players)
      world.store.repos.projections.put({
        player_id: p.id,
        gsis_id: null,
        season: SEASON,
        week: 4,
        model_version: "v2-opportunity",
        made_at: "2026-09-20T12:00:00.000Z",
        inputs_as_of: "2026-09-20T12:00:00.000Z",
        expectation: { targets: 5, rec: 3.5, rec_yd: 40, rush_att: 4, rush_yd: 15 },
        samples: [],
        p_active: 0.95,
        reported_mean: 9.5,
        trace: null,
      });
    // one projection made AFTER the season's last week-4 kickoff (2026-10-01 onward): never read
    const late = week4Players().find(
      (p) => p.pos === 2 && !players.some((x) => x.id === p.id) && p.id !== v1Player?.id,
    );
    if (late !== undefined)
      world.store.repos.projections.put({
        player_id: late.id,
        gsis_id: null,
        season: SEASON,
        week: 4,
        model_version: "v2-opportunity",
        made_at: "2026-10-06T12:00:00.000Z",
        inputs_as_of: "2026-10-06T12:00:00.000Z",
        expectation: { rush_att: 99 },
        samples: [],
        p_active: 1,
        reported_mean: 99,
        trace: null,
      });
    const r = await tool("espn_analyze_retrospective", { week: 4 });
    const attr = r.data.attribution as Record<string, number> | null;
    expect(attr).not.toBeNull();
    expect(attr?.n_player_weeks).toBe(players.length + (v1Player === undefined ? 0 : 1));
    for (const k of Object.keys(attr ?? {})) expect(k).toMatch(ATTRIBUTION_KEY_RE);
    // proposals are made only with enough evidence; none is ever applied by the server
    expect(r.data.parameter_changes_proposed).toEqual([]);
  });
});

describe("C8: E10 logs claims and reads the calibration table; E13 scores them", () => {
  let subject: number;
  beforeAll(async () => {
    const roster = (
      await tool("espn_get_roster", { team_id: manifest.my_team_id, week: manifest.current_week })
    ).data.players as { player_id: number; position: string }[];
    subject = roster.find((p) => p.position === "WR")?.player_id ?? 0;
  });

  it("below 200 scored news claims: posterior null and the hand-set note; the call's claim is logged", async () => {
    const r = await tool("espn_analyze_evidence", {
      player: { player_ids: [subject] },
      claim: { text: "He is expected to play Sunday", type: "availability" },
    });
    expect(r.data.posterior).toBeNull();
    expect(r.data.calibration_state).toEqual({ table_n: 0, note: "priors are hand-set" });
    const pending = world.store.repos.scoredClaims.pending(L, SEASON, manifest.current_week);
    expect(pending.some((c) => c.player_id === subject && c.claim.source === "user.claim")).toBe(
      true,
    );
  });

  it("with 200 scored news claims the posterior shows and the note is gone", async () => {
    for (let i = 0; i < 200; i++) {
      const c = {
        season: 2025,
        week: 1 + (i % 17),
        player_id: 100_000 + i,
        claim: {
          source: "rss.rotowire" as const,
          type: "availability" as const,
          signal: "questionable" as const,
          prior_status: "QUESTIONABLE" as const,
          prior_p: 0.71,
        },
      };
      world.store.repos.scoredClaims.log(L, c, "2025-09-01T00:00:00.000Z");
    }
    for (let w = 1; w <= 17; w++)
      for (const p of world.store.repos.scoredClaims.pending(L, 2025, w))
        world.store.repos.scoredClaims.score(
          p.key,
          { active: p.player_id % 3 !== 0, borne_out: null },
          "2025-12-31T00:00:00.000Z",
        );
    const r = await tool("espn_analyze_evidence", { player: { player_ids: [subject] } });
    const cal = r.data.calibration_state as { table_n: number; note: string | null };
    expect(cal.table_n).toBeGreaterThanOrEqual(200);
    expect(cal.note).toBeNull();
    expect(r.data.posterior).not.toBeNull();
  });

  it("E13 scores a logged claim of the final week from its box score", async () => {
    const p = week4Players().find((x) => x.pos === 3);
    expect(p).toBeDefined();
    world.store.repos.scoredClaims.log(
      L,
      {
        season: SEASON,
        week: 4,
        player_id: p?.id ?? 0,
        claim: {
          source: "rss.espn",
          type: "availability",
          signal: "questionable",
          prior_status: null,
          prior_p: 1,
        },
      },
      "2026-09-25T00:00:00.000Z",
    );
    expect(world.store.repos.scoredClaims.pending(L, SEASON, 4)).toHaveLength(1);
    await tool("espn_analyze_retrospective", { week: 4 });
    expect(world.store.repos.scoredClaims.pending(L, SEASON, 4)).toHaveLength(0);
  });
});

describe("C8/C9: the retrospective's one-week-later and trace paths", () => {
  it("scores a role claim one week later from the snap shares around it", async () => {
    // a rostered RB of the fixture league with snap counts in the seeded 2026 weeks (fx10h-usage)
    expect(week4Players().some((x) => x.id === 4379399)).toBe(true);
    world.store.repos.scoredClaims.log(
      L,
      {
        season: SEASON,
        week: 3,
        player_id: 4379399,
        claim: {
          source: "rss.rotowire",
          type: "role",
          signal: "up",
          prior_status: null,
          prior_p: 1,
        },
      },
      "2026-09-18T00:00:00.000Z",
    );
    const role = () =>
      world.store.repos.scoredClaims
        .pending(L, SEASON, 3)
        .filter((c) => c.claim.type === "role" && c.player_id === 4379399);
    expect(role()).toHaveLength(1);
    await tool("espn_analyze_retrospective", { week: 4 });
    expect(role()).toHaveLength(0);
  });

  it("a stored v2 trace is read back and carried into the attribution (realised from the week)", async () => {
    const p = week4Players().find((x) => x.pos === 3 && x.id !== 4379399);
    expect(p).toBeDefined();
    world.store.repos.projections.put({
      player_id: p?.id ?? 0,
      gsis_id: null,
      season: SEASON,
      week: 4,
      model_version: "v2-opportunity",
      made_at: "2026-09-22T12:00:00.000Z",
      inputs_as_of: "2026-09-22T12:00:00.000Z",
      expectation: { targets: 7, rec: 4.6, rec_yd: 55 },
      samples: [],
      p_active: 1,
      reported_mean: 10.5,
      trace: {
        matchup: { z: 0.05, beta: 0.5 },
        weather_mult: null,
        shares: [{ name: "target_share", history: [0.18, 0.2], half_life: 8, realised: null }],
        rates: [
          {
            name: "catch_rate",
            n_obs: 15,
            observed: 0.66,
            prior: 0.62,
            k: 10,
            realised: null,
            realised_n: 0,
          },
        ],
      },
    });
    const r = await tool("espn_analyze_retrospective", { week: 4 });
    const attr = r.data.attribution as Record<string, number>;
    // the matchup lift is counted for the traced row (reported beside the layers, never inside)
    expect(attr["matchup_lift.n"]).toBeGreaterThanOrEqual(1);
  });
});

describe("C5: E5 logs its priority runs and re-solves the premium from 13 of them", () => {
  it("cold-start until the feed holds a regular season of runs, then league_fitted", async () => {
    const first = await tool("espn_analyze_waivers", { mode: "priority" });
    expect(first.data.premium_basis).toBe("cold_start_table");
    const runs = world.store.repos.waiverRuns.list(L, SEASON);
    expect(runs.length).toBe(1);
    expect(runs[0]?.run_at).toBe(first.data.next_run_at);
    // a season of runs: one per week, a plausible best surplus each
    for (let i = 0; i < 13; i++)
      world.store.repos.waiverRuns.put(
        L,
        {
          season: SEASON,
          run_at: new Date(
            Date.parse("2026-09-09T07:30:00.000Z") - i * 7 * 86_400_000,
          ).toISOString(),
          W: 12,
          surplus: [4 + (i % 5), 2, 1, -1],
        },
        "2026-09-01T00:00:00.000Z",
      );
    const fitted = await tool("espn_analyze_waivers", { mode: "priority" });
    expect(fitted.data.premium_basis).toBe("league_fitted");
    expect(fitted.warnings.join(" ")).not.toMatch(/cold-start table: the league's feed/);
  });
});

describe("C6: E7 serves cascade v2 (the redistribution prior table)", () => {
  it("names the table in its assumptions for a non-QB starter", async () => {
    const roster = (
      await tool("espn_get_roster", { team_id: manifest.my_team_id, week: manifest.current_week })
    ).data.players as { player_id: number; position: string }[];
    const wr = roster.find((p) => p.position === "WR")?.player_id ?? 0;
    const r = await tool("espn_analyze_injury_cascade", { player: { player_ids: [wr] } });
    const text = JSON.stringify(r.data);
    expect(text).toContain("redistribution table from pbp history");
  });
});
