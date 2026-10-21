// projections-roster.test.ts — espn_project_players answers a whole roster at the default detail
// (plan 07 E1 token line; plan 07 C8's 10 000-character analytics budget; §5.2 compact keeps every
// identifier and decision number). Stage C finding projections-roster-truncated: the result was only
// HALVED to fit, so the owner's 16-player roster came back as 8 of 16 (week, core), 7 of 15 (week,
// full) and 3 of 15 (ROS) — and the five Skills that project a roster this way read part of it.
// Attempt 1 added budget steps that thin the rows (a shared assumption stated once in warnings[],
// drivers, weeks beyond the first, then only ros_total) before any player is dropped, one at a
// time — but under `full` at horizon week (v2's rows are the longest) the seeded fixture league
// still lost a player in 68 of its 130 sixteen-player sets. Now two more steps run first: the
// numbers go to the precision a decision reads (points 0.1, probabilities 0.01), then the
// assumptions only one player carries go (their ids said). Fixture mode on fx-10h; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import {
  ANALYTICS_BUDGET_CHARS,
  TRUNCATION_HINTS,
  buildEnvelope,
  fitToBudget,
  serializeEnvelope,
  toDataInputs,
  type InputStamp,
} from "../../src/mcp/envelope.js";
import { EVERY_ASSUMPTION_OMITTED, projectionTrims } from "../../src/mcp/tools/analytics.js";
import { seedDatasets } from "../integration/helpers/seed.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");

type J = Record<string, unknown>;
interface Proj {
  player_id: number;
  weeks: unknown[];
  ros_total: unknown;
}

describe.each(["core", "full"] as const)("E1 for a whole roster under %s", (toolset) => {
  it("16 players (my roster + 1) at week, ros and season: every player answered", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      clock: string;
      my_team_id: number;
    };
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: toolset },
      teamId: m.my_team_id,
      clock: m.clock,
      publishNflverse: toolset === "full",
    });
    try {
      const c = await connect(world, { options: { toolset } });
      const mine = (await call(c.client, "espn_get_roster", { week: 5 })).body.data as {
        players: { player_id: number }[];
      };
      const other = (await call(c.client, "espn_get_roster", { week: 5, team_id: 3 })).body
        .data as { players: { player_id: number }[] };
      const ids = [...mine.players.map((p) => p.player_id), other.players[0]?.player_id ?? 0];
      expect(ids).toHaveLength(16);
      for (const horizon of ["week", "ros", "season"] as const) {
        const r = await call(c.client, "espn_project_players", {
          players: { player_ids: ids },
          horizon,
        });
        expect(r.isError, `${horizon}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
        const projections = (r.body.data as { projections: Proj[] }).projections;
        expect(projections.map((p) => p.player_id).sort(), horizon).toEqual([...ids].sort());
        const warnings = r.body.warnings as string[];
        expect(
          warnings.some((w) => w.startsWith("result truncated")),
          horizon,
        ).toBe(false);
        expect(
          warnings.some((w) => w.startsWith("projections truncated")),
          horizon,
        ).toBe(false);
        if (horizon !== "week") for (const p of projections) expect(p.ros_total).not.toBeNull();
        else for (const p of projections) expect(p.weeks).toHaveLength(1);
        expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(10_000);
      }
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 120_000);
});

describe("E1 for a whole roster under full on the SEEDED fixture league (every source loaded)", () => {
  it("my roster + each of another team's players at week: every player answered, in budget", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      clock: string;
      my_team_id: number;
    };
    // the state a refresh leaves (the e2e seed): v2's inputs and their history twins, the official
    // report, the news and trending feeds — the longest E1 rows and the longest envelope
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: m.my_team_id,
      clock: m.clock,
      publishEspn: false,
    });
    try {
      await seedDatasets(world.store, {
        storePath: storePath(world.cache),
        datasetDir: datasetDir(world.cache),
        cache: world.cache,
        clock: world.clock,
        season: 2026,
      });
      world.store.reopenChangedDatasets();
      const c = await connect(world, { options: { toolset: "full" } });
      const roster = async (team?: number) =>
        (
          (
            await call(c.client, "espn_get_roster", {
              week: 5,
              ...(team === undefined ? {} : { team_id: team }),
            })
          ).body.data as { players: { player_id: number }[] }
        ).players.map((p) => p.player_id);
      const mine = await roster();
      const other = await roster(m.my_team_id === 1 ? 3 : 1);
      expect(mine).toHaveLength(15);
      for (const extra of other) {
        // the ESPN limiter's per-minute window (fixture mode counts requests too)
        world.clock.advance(4_000);
        const ids = [...mine, extra];
        const r = await call(c.client, "espn_project_players", {
          players: { player_ids: ids },
          horizon: "week",
          week: 5,
        });
        expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
        const got = (r.body.data as { projections: Proj[] }).projections;
        expect(got.map((p) => p.player_id).sort(), String(extra)).toEqual([...ids].sort());
        for (const p of got) expect(p.weeks).toHaveLength(1);
        const warnings = r.body.warnings as string[];
        expect(
          warnings.filter((w) => /^(?:result|projections) truncated/.test(w)),
          String(extra),
        ).toEqual([]);
        expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(10_000);
      }
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 180_000);
});

// Round 2 (the verifier): under `full` at horizon week a week with no market line yet — the state
// the weekly Skill meets on the Tuesday after Monday night — carries "no market line" on most rows,
// and 2–12 of 130 sixteen-player sets still lost a player at weeks 6–8. Every trim's warning is
// shorter now (each counts against the budget), a shared assumption names the shorter player list
// ("every projection but …"), every assumption line is traded for one before any player goes, and a
// dropped player is named.
describe("E1 for a whole roster under full in a week with no market line yet (SEEDED)", () => {
  it("my roster + each of another team's players at weeks 6, 7 and 8: every player answered", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      clock: string;
      my_team_id: number;
    };
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: m.my_team_id,
      clock: m.clock,
      publishEspn: false,
    });
    try {
      await seedDatasets(world.store, {
        storePath: storePath(world.cache),
        datasetDir: datasetDir(world.cache),
        cache: world.cache,
        clock: world.clock,
        season: 2026,
      });
      world.store.reopenChangedDatasets();
      const c = await connect(world, { options: { toolset: "full" } });
      const roster = async (team?: number) =>
        (
          (
            await call(c.client, "espn_get_roster", {
              week: 5,
              ...(team === undefined ? {} : { team_id: team }),
            })
          ).body.data as { players: { player_id: number }[] }
        ).players.map((p) => p.player_id);
      const mine = await roster();
      const other = await roster(m.my_team_id === 1 ? 3 : 1);
      for (const week of [6, 7, 8])
        for (const extra of other) {
          world.clock.advance(4_000);
          const ids = [...mine, extra];
          const r = await call(c.client, "espn_project_players", {
            players: { player_ids: ids },
            horizon: "week",
            week,
          });
          const label = `week ${String(week)} + ${String(extra)}`;
          expect(r.isError, `${label}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
          const got = (r.body.data as { projections: Proj[] }).projections;
          const missing = ids.filter((id) => !got.some((p) => p.player_id === id));
          expect(
            got.map((p) => p.player_id).sort(),
            `${label}: missing ${JSON.stringify(missing)}; warnings ${JSON.stringify(r.body.warnings)}`,
          ).toEqual([...ids].sort());
          expect(
            (r.body.warnings as string[]).filter((w) =>
              /^(?:result|projections) truncated/.test(w),
            ),
            label,
          ).toEqual([]);
          expect(JSON.stringify(r.body).length, label).toBeLessThanOrEqual(10_000);
        }
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 600_000);
});

// The verifier's round-2 case, built from E1's own row (v2 under `full`, compact detail) so it runs in
// milliseconds: 16 players, 13 sharing "no market line", 2 a designation, 3 an assumption of their
// own, six drivers each, numbers at three decimals, the eleven inputs a refresh leaves. Attempt 2's
// steps lost the last player of a set like this; every row must stay, inside the 10 000 characters.
describe("E1's budget on a whole v2 roster in a week with no market line (the full envelope)", () => {
  const SOURCES = [
    "espn:mSettings",
    "espn:kona_player_info",
    "espn:pro_schedule",
    "nflverse:stats_player_week",
    "nflverse:schedules",
    "ffopportunity:ep_weekly",
    "ffopportunity:ep_weekly_history",
    "nflverse:stats_team_week",
    "nflverse:stats_team_week_history",
    "nflverse:roster_weekly",
    "nflverse:injuries",
  ];
  const NOW = Date.parse("2026-10-07T01:00:15.593Z");
  const NO_LINE = {
    text: "no market line for the game: team volume and touchdown rates use the trailing environment",
    revisit_trigger: "the game's spread and total are published",
  };
  const OUT = {
    text: "the designation rules him out: the estimate is 0",
    revisit_trigger: "his status changes before kickoff",
  };
  const POS = ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "WR", "WR", "RB", "TE", "QB", "WR", "RB"];
  const OPP = ["LV", "DEN", "KC", "BUF", "NYJ", "SF"];
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  const projRow = (i: number, nameChars: number): J => {
    const mean = r3(5.137 + ((i * 3.731) % 17));
    const dst = i === 15;
    const assumptions = [
      ...(i <= 12 ? [NO_LINE] : []),
      ...(i === 3 || i === 9 ? [OUT] : []),
      ...(i === 5 || i === 10 || i === 14
        ? [
            {
              text: `his role is read from ${String(i % 3)} games`,
              revisit_trigger: "a third game",
            },
          ]
        : []),
    ];
    return {
      player_id: dst ? -16_001 : 4_100_000 + i * 37_123,
      gsis_id: dst ? null : `00-00${String(37_000 + i * 13)}`,
      name: `${String.fromCharCode(65 + i)}${"x".repeat(nameChars - 1)}`,
      position: dst ? "D/ST" : i === 14 ? "K" : (POS[i] ?? "WR"),
      weeks: [
        {
          week: 6,
          points: {
            mean,
            p10: r3(mean * 0.335),
            p25: r3(mean * 0.566),
            p50: r3(mean * 0.907),
            p75: r3(mean * 1.321),
            p90: r3(mean * 1.791),
            p_zero: r3(0.0371 * (i % 3)),
            basis: i >= 14 ? "position_cv" : "player_sim",
          },
          p_active: i % 5 === 0 ? 0.855 : 1,
          opponent: OPP[i % OPP.length] ?? null,
          implied_total: null,
          inputs: { espn: mean, own: r3(mean * 0.851), weight_espn: 1 },
          disagreement: { pct: 0.149, flagged: i % 4 === 0 },
        },
      ],
      ros_total: null,
      drivers: [
        { name: "espn_projection", contribution: Math.round(mean * 100) / 100 },
        { name: "opportunity_and_yardage", contribution: 10.2 },
        { name: "touchdowns_location", contribution: 3.6 },
        { name: "own_minus_espn", contribution: -2.46 },
        { name: "matchup_regressed", contribution: 0.27 },
        { name: "turnover_tail", contribution: -0.22 },
      ],
      role_confidence_games: 3,
      assumptions,
    };
  };
  const envelopeOf = (nameChars: number) => {
    const stamps: InputStamp[] = SOURCES.map((source, k) => ({
      source,
      as_of: new Date(NOW - 86_400_000 + k * 977_123).toISOString(),
      fetched_at: new Date(NOW - k * 1_000).toISOString(),
      state: "fresh",
    }));
    const projections = Array.from({ length: 16 }, (_, i) => projRow(i, nameChars));
    return buildEnvelope({
      data: {
        model_version: "v2-opportunity",
        projections,
        completed_samples: 4000,
        inputs: toDataInputs(stamps, NOW),
      },
      requestId: "r-fb6ccdc91dbf",
      nowMs: NOW,
      inputs: stamps,
      estimate: true,
      bareFields: [{ path: "data.projections[].name", source: "espn.player.name" }],
      warnings: ["1 players not modelled by v2"],
    });
  };

  it.each([14, 18, 22])("names of %i characters: all 16 players, inside the budget", (chars) => {
    const env = envelopeOf(chars);
    expect(serializeEnvelope(env).length).toBeGreaterThan(ANALYTICS_BUDGET_CHARS);
    const r = fitToBudget(env, ANALYTICS_BUDGET_CHARS, "projections", {
      pageable: false,
      hint: TRUNCATION_HINTS.analyticsCompact,
      trims: projectionTrims(16),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.envelope.data.projections as unknown as {
      player_id: number;
      weeks: unknown[];
    }[];
    expect(rows.map((x) => x.player_id)).toEqual(
      Array.from({ length: 16 }, (_, i) => (i === 15 ? -16_001 : 4_100_000 + i * 37_123)),
    );
    expect(rows.every((x) => x.weeks.length === 1)).toBe(true);
    expect(r.envelope.warnings.filter((w) => w.includes("truncated"))).toEqual([]);
    expect(serializeEnvelope(r.envelope).length).toBeLessThanOrEqual(ANALYTICS_BUDGET_CHARS);
  });
});

describe("projectionTrims (units)", () => {
  const dist = { mean: 1, p10: 0, p25: 0, p50: 1, p75: 2, p90: 3, p_zero: 0, basis: "position_cv" };
  const row = (id: number, weeks: number, ros: boolean, assumption = "shared text"): J => ({
    player_id: id,
    weeks: Array.from({ length: weeks }, (_, i) => ({ week: 5 + i })),
    ros_total: ros ? dist : null,
    drivers: [
      { name: "a", contribution: 1 },
      { name: "b", contribution: -3 },
    ],
    assumptions: [{ text: assumption, revisit_trigger: "later" }],
  });
  const apply = (steps: ReturnType<typeof projectionTrims>, d: unknown): unknown => {
    const out = steps.reduce<unknown>((acc, t) => t(acc)?.data ?? acc, d);
    return out;
  };

  it("hoists an assumption shared by two or more players into one warning naming them", () => {
    const [hoist] = projectionTrims(3);
    const d = { projections: [row(1, 1, false), row(2, 1, false), row(3, 1, false, "own")] };
    const r = hoist?.(d);
    expect(r?.warning).toBe("assumption of projections 1, 2: shared text (revisit when later)");
    const rows = (r?.data as { projections: { assumptions: unknown[] }[] }).projections;
    expect(rows.map((x) => x.assumptions.length)).toEqual([0, 0, 1]);
    // nothing left to share: the step stops
    expect(hoist?.(r?.data)).toBeNull();
  });

  it("names the players an assumption does NOT apply to when that list is shorter", () => {
    const [hoist] = projectionTrims(4);
    const all = { projections: [row(1, 1, false), row(2, 1, false), row(3, 1, false)] };
    expect(hoist?.(all)?.warning).toBe(
      "assumption of every projection: shared text (revisit when later)",
    );
    const ids = [4379399, 4430878, 4890973, 4428331];
    const most = {
      projections: [...ids.map((id) => row(id, 1, false)), row(16014, 1, false, "own")],
    };
    expect(hoist?.(most)?.warning).toBe(
      "assumption of every projection but 16014: shared text (revisit when later)",
    );
    // two of five: naming them is shorter
    const few = {
      projections: [
        row(1, 1, false),
        row(2, 1, false),
        ...ids.slice(0, 3).map((id) => row(id, 1, false, `own ${String(id)}`)),
      ],
    };
    expect(hoist?.(few)?.warning).toBe(
      "assumption of projections 1, 2: shared text (revisit when later)",
    );
  });

  it("an assumption line over the 400-character warning cap stays on its rows", () => {
    const [hoist] = projectionTrims(2);
    const long = "x".repeat(380);
    expect(hoist?.({ projections: [row(1, 1, false, long), row(2, 1, false, long)] })).toBeNull();
  });

  it("drivers: the largest by |contribution| first, weeks to one, then none; ros_total carries the horizon", () => {
    const steps = projectionTrims(2);
    const d = { projections: [row(1, 3, true), row(2, 3, true)] };
    const top = steps[1]?.(d);
    expect(
      (top?.data as { projections: { drivers: { name: string }[] }[] }).projections[0]?.drivers,
    ).toEqual([{ name: "b", contribution: -3 }]);
    const one = steps[2]?.(top?.data);
    expect(
      (one?.data as { projections: { weeks: unknown[] }[] }).projections.map((x) => x.weeks.length),
    ).toEqual([1, 1]);
    const all = apply(steps.slice(0, 5), d) as { projections: Proj[] };
    expect(all.projections.every((p) => p.weeks.length === 0 && p.ros_total !== null)).toBe(true);
    // a week horizon (no ros_total) never loses its week row
    const wk = apply(steps.slice(0, 5), { projections: [row(1, 1, false), row(2, 1, false)] }) as {
      projections: Proj[];
    };
    expect(wk.projections.every((p) => p.weeks.length === 1)).toBe(true);
  });

  it("detail full keeps every row: only the lossless hoist, then one player at a time", () => {
    const steps = projectionTrims(2, true);
    expect(steps).toHaveLength(2);
    const d = { projections: [row(1, 3, true), row(2, 3, true)] };
    const out = apply(steps.slice(0, 1), d) as {
      projections: { weeks: unknown[]; drivers: unknown[] }[];
    };
    expect(out.projections.map((p) => [p.weeks.length, p.drivers.length])).toEqual([
      [3, 2],
      [3, 2],
    ]);
  });

  it("before any player leaves: the numbers to a decision's precision, then lone assumptions (ids said)", () => {
    const steps = projectionTrims(2);
    const precision = steps[steps.length - 4];
    const lone = steps[steps.length - 3];
    const wk = {
      week: 5,
      points: {
        mean: 15.94,
        p10: 5.735,
        p25: 9.295,
        p50: 14.437,
        p75: 20.864,
        p90: 27.796,
        p_zero: 0.0371,
        basis: "player_sim",
      },
      p_active: 0.8549,
      opponent: "LAR",
      implied_total: 26.25,
      inputs: { espn: 15.94, own: 12.489, weight_espn: 1 },
      disagreement: { pct: 0.215, flagged: false },
    };
    const d = {
      projections: [
        { ...row(1, 1, false), weeks: [wk], assumptions: [] },
        { ...row(2, 1, false, "only his"), weeks: [wk] },
      ],
    };
    const r = precision?.(d);
    const w0 = (r?.data as { projections: { weeks: (typeof wk)[] }[] }).projections[0]?.weeks[0];
    expect(w0?.points).toEqual({
      mean: 15.9,
      p10: 5.7,
      p25: 9.3,
      p50: 14.4,
      p75: 20.9,
      p90: 27.8,
      p_zero: 0.04,
      basis: "player_sim",
    });
    expect([w0?.p_active, w0?.implied_total, w0?.inputs, w0?.disagreement.pct]).toEqual([
      0.85,
      26.3,
      { espn: 15.9, own: 12.5, weight_espn: 1 },
      0.22,
    ]);
    expect(r?.warning).toBe(
      "projections[] numbers rounded to fit the budget (points 0.1, probabilities 0.01)",
    );
    // nothing left to round: the step stops
    expect(precision?.(r?.data)).toBeNull();
    const a = lone?.(r?.data);
    expect(a?.warning).toMatch(/^projections\[\]\.assumptions of 2 omitted to fit/);
    expect(
      (a?.data as { projections: { assumptions: unknown[] }[] }).projections.every(
        (x) => x.assumptions.length === 0,
      ),
    ).toBe(true);
    expect(lone?.(a?.data)).toBeNull();
    // the quantiles stay ordered (rounding is monotone)
    const p = w0?.points;
    expect(
      p !== undefined && p.p10 <= p.p25 && p.p25 <= p.p50 && p.p50 <= p.p75 && p.p75 <= p.p90,
    ).toBe(true);
  });

  it("before any player leaves, every assumption line is traded for one (a whole roster that needs it)", () => {
    // 16 rows: one long assumption every row shares, and one of each row's own
    const shared = {
      text: "no market line for the game: team volume and touchdown rates use the trailing environment",
      revisit_trigger: "the game's spread and total are published",
    };
    const rows = Array.from({ length: 16 }, (_, i) => ({
      ...row(4_000_000 + i, 1, false),
      drivers: [],
      assumptions: [shared, { text: `own reason ${String(i)}`, revisit_trigger: "later" }],
    }));
    const env = buildEnvelope({
      data: { projections: rows },
      requestId: "r-0123456789ab",
      nowMs: 0,
      inputs: [],
    });
    // the answer once every assumption went, its one line said: the budget is exactly that
    const bare = {
      ...env,
      data: { projections: rows.map((r) => ({ ...r, assumptions: [] })) },
      truncated: true,
      warnings: [EVERY_ASSUMPTION_OMITTED],
    };
    const budget = serializeEnvelope(bare).length;
    const steps = projectionTrims(16);
    const r = fitToBudget(env, budget, "projections", { pageable: false, hint: "h", trims: steps });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.data.projections).toHaveLength(16);
    expect(r.envelope.warnings).toEqual([EVERY_ASSUMPTION_OMITTED]);
    expect(serializeEnvelope(r.envelope).length).toBe(budget);
    // without that step the same budget loses a player (attempt 2's steps)
    const before = projectionTrims(16);
    const old = before.filter((_, i) => i !== before.length - 2);
    const o = fitToBudget(env, budget, "projections", { pageable: false, hint: "h", trims: old });
    expect(o.ok && o.envelope.data.projections.length < 16).toBe(true);
    // a shared line shorter than the one that would stand for it stays (the step would cost budget)
    const short = projectionTrims(3);
    const h = short[0]?.({
      projections: [row(1, 1, false, "s"), row(2, 1, false, "s"), row(3, 1, false, "s")],
    });
    expect(h?.warning).toBe("assumption of every projection: s (revisit when later)");
    expect(short[short.length - 2]?.(h?.data)).toBeNull();
  });

  it("the last step drops ONE player at a time, never half, and names every player left out", () => {
    const steps = projectionTrims(4);
    const last = steps[steps.length - 1];
    const r = last?.({ projections: [row(1, 1, false), row(2, 1, false), row(3, 1, false)] });
    expect((r?.data as { projections: unknown[] }).projections).toHaveLength(2);
    expect(r?.warning).toBe(
      "projections truncated to 2 of 4 to fit the budget; call again with player_ids [3] for the rest",
    );
    // a second drop names both, in the order requested
    const r2 = last?.(r?.data);
    expect(r2?.warning).toBe(
      "projections truncated to 1 of 4 to fit the budget; call again with player_ids [2, 3] for the rest",
    );
  });
});
