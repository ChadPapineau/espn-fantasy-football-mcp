// edges.test.ts — v2's edge cases and the tuned-parameter seam (plan 10 C9: `eff tune --apply`
// writes the human-applied values; overrides.ts maps the retrospective registry's names onto v2 and
// ignores — never guesses — the rest): degenerate dispersions, a QB with no passing role, pooled
// carry-location priors, role metrics without a team denominator, hostile matchup rows, empty
// objective sets and the harness's fallbacks.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "../../../../src/domain/clock.js";
import {
  evaluateCases,
  gammaForecast,
  v2Forecast,
  type BacktestCase,
  type BacktestWorld,
} from "../../../../src/domain/analytics/projections-v2/backtest.js";
import { normalizeDesignation } from "../../../../src/domain/analytics/projections-v2/availability.js";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import { expectV2 } from "../../../../src/domain/analytics/projections-v2/expectation.js";
import {
  objective,
  paramAt,
  withParam,
} from "../../../../src/domain/analytics/projections-v2/fit.js";
import { buildMatchupTable } from "../../../../src/domain/analytics/projections-v2/matchup.js";
import {
  applyTunedOverrides,
  TUNED_NAME_TO_V2_PATH,
} from "../../../../src/domain/analytics/projections-v2/overrides.js";
import { buildV2Priors } from "../../../../src/domain/analytics/projections-v2/rates.js";
import { simulateLines } from "../../../../src/domain/analytics/projections-v2/simulate.js";
import type { V2Game, V2Position } from "../../../../src/domain/analytics/projections-v2/types.js";
import {
  indexTeamGames,
  playerWindow,
} from "../../../../src/domain/analytics/projections-v2/window.js";
import { qbGame, rbGame, settings, teamSeason, wrGame } from "./helpers/synthetic.js";

const rows = teamSeason(10);
const ctx = {
  season: 2025,
  week: 9,
  team_index: indexTeamGames(rows),
  team_games: rows,
  market: null,
  weather: null,
  opponent: null,
  matchup: null,
  priors: DEFAULT_V2_PRIORS,
  params: DEFAULT_V2_PARAMS,
};

describe("applyTunedOverrides (the eff tune seam)", () => {
  it("maps the registry's names onto v2 paths and returns weight_espn apart", () => {
    const out = applyTunedOverrides(DEFAULT_V2_PARAMS, {
      ewm_half_life_games: 5,
      "shrink_k.catch_rate": 40,
      "shrink_k.td_rate": 90,
      "matchup_beta.TE": 0.3,
      weight_espn: 0.75,
    });
    expect(out.params.half_life_games).toBe(5);
    expect(out.params.k.catch_rate).toBe(40);
    expect(out.params.k.xtd).toBe(90);
    expect(out.params.matchup_beta.TE).toBe(0.3);
    expect(out.weight_espn).toBe(0.75);
    expect(out.applied).toEqual([
      "ewm_half_life_games",
      "matchup_beta.TE",
      "shrink_k.catch_rate",
      "shrink_k.td_rate",
      "weight_espn",
    ]);
    expect(out.ignored).toEqual([]);
    expect(DEFAULT_V2_PARAMS.half_life_games).not.toBe(5);
  });

  it("ignores names without a v2 counterpart, non-finite and out-of-bounds values", () => {
    const out = applyTunedOverrides(DEFAULT_V2_PARAMS, {
      "shrink_k.yards_per_target": 50,
      "shrink_k.yards_per_attempt": 50,
      "matchup_beta.QB": 3,
      ewm_half_life_games: Number.NaN,
      weight_espn: 1.5,
      __proto__: 1,
      unknown: 2,
    });
    expect(out.params).toBe(DEFAULT_V2_PARAMS);
    expect(out.weight_espn).toBeNull();
    expect(out.applied).toEqual([]);
    expect(out.ignored).toEqual(
      [
        "ewm_half_life_games",
        "matchup_beta.QB",
        "shrink_k.yards_per_attempt",
        "shrink_k.yards_per_target",
        "unknown",
        "weight_espn",
      ].sort(),
    );
  });

  it("every mapped path exists in V2Params", () => {
    for (const path of Object.values(TUNED_NAME_TO_V2_PATH))
      expect(Number.isFinite(paramAt(DEFAULT_V2_PARAMS, path))).toBe(true);
  });

  it("property: any value set either applies inside its bounds or is ignored", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...Object.keys(TUNED_NAME_TO_V2_PATH), "weight_espn"),
          fc.double(),
        ),
        (o) => {
          const out = applyTunedOverrides(DEFAULT_V2_PARAMS, o);
          expect(out.applied.length + out.ignored.length).toBe(Object.keys(o).length);
        },
      ),
    );
  });
});

describe("edges of the model", () => {
  it("zero yardage CVs make the yards deterministic per event", () => {
    const r = expectV2(
      { position: "WR", position_id: 3, team: "AAA", games: [1, 2, 3, 4].map((w) => wrGame(w)) },
      ctx,
    );
    if (typeof r === "string") throw new Error(r);
    const flat = withParam(withParam(DEFAULT_V2_PARAMS, "sim.cv_yds_catch", 0), "sim.cv_eff", 0);
    const lines = simulateLines(
      r.expectation,
      1,
      { ...flat, sim: { ...flat.sim, script_coupling: 0 } },
      seededRng(1),
      50,
    );
    for (const l of lines) {
      const rec = l.values.rec ?? 0;
      expect(l.values.rec_yd).toBe(Math.round(rec * r.expectation.yards_per_rec));
    }
  });

  it("a QB with no passing role and no share prior draws no dropbacks", () => {
    const games = [1, 2, 3, 4].map((w) =>
      qbGame(w, { pass_att: 0, pass_cmp: 0, pass_yd: 0, pass_td: 0, pass_int: 0, sacks: 0 }),
    );
    const p = withParam(DEFAULT_V2_PARAMS, "k.share", 0);
    const r = expectV2(
      { position: "QB", position_id: 1, team: "AAA", games },
      { ...ctx, params: p },
    );
    if (typeof r === "string") throw new Error(r);
    expect(r.expectation.pass_att).toBe(0);
    const lines = simulateLines(r.expectation, 1, p, seededRng(2), 30);
    expect(lines.every((l) => l.values.pass_att === 0 && l.values.sacked === 0)).toBe(true);
  });

  it("an RB without ffopportunity reads his goal-line and red-zone carries", () => {
    const games = [1, 2, 3, 4].map((w) =>
      rbGame(w, { x_rush_td: null, rz_carries: 4, gl_carries: 2 }),
    );
    const r = expectV2({ position: "RB", position_id: 2, team: "AAA", games }, ctx);
    if (typeof r === "string") throw new Error(r);
    expect(r.expectation.td_basis).toBe("pbp_location");
    expect(r.rz_share).toBeNull();
  });

  it("pools the carry-location priors once enough red-zone carries exist", () => {
    const rbs: V2Game[] = Array.from({ length: 80 }, (_, i) =>
      rbGame((i % 17) + 1, {
        rz_carries: 3,
        rz_rush_td: 1,
        gl_carries: 1,
        gl_rush_td: 1,
        rush_td: 1,
      }),
    );
    const p = buildV2Priors(new Map<V2Position, V2Game[]>([["RB", rbs]]), []);
    expect(p.positions.RB.td_gl_carry).toBe(1);
    expect(p.positions.RB.td_rz_carry).toBe(0);
    expect(p.positions.RB.td_other_carry).toBe(0);
  });

  it("the role metric needs a snap share in [0, 1] or a team denominator", () => {
    const games = [0.3, 0.3, 0.3, 1.7, 2, 2].map((s, i) => wrGame(i + 1, { snap_pct: s }));
    const noTeams = playerWindow(games, 2025, 7, new Map(), DEFAULT_V2_PARAMS);
    expect(noTeams.change_point).toBeNull();
    expect(noTeams.games.every((g) => g.team === null)).toBe(true);
  });

  it("matchup rows with non-finite points or no opponent are skipped", () => {
    const t = buildMatchupTable(
      [
        { season: 2025, week: 1, team: "X", opponent: "D", position: "WR", points: Number.NaN },
        { season: 2025, week: 2, team: "X", opponent: null, position: "WR", points: 10 },
      ],
      2025,
      5,
    );
    expect(t).toEqual({});
  });

  it("unknown designation strings read as Questionable in any case", () => {
    expect(normalizeDesignation("out")).toBe("Out");
    expect(normalizeDesignation("Note")).toBe("Questionable");
  });
});

describe("harness fallbacks", () => {
  const world: BacktestWorld = {
    players: [],
    team_games: rows,
    weather: new Map(),
    reports: new Map(),
    settings: settings(),
  };

  it("an empty case set scores +∞ (the fit never prefers it); unknown players are skipped", () => {
    expect(objective(world, [], DEFAULT_V2_PARAMS, {})).toBe(Number.POSITIVE_INFINITY);
    const c: BacktestCase = {
      gsis_id: "00-9999999",
      position: "WR",
      season: 2025,
      week: 3,
      team: "AAA",
      played: true,
      actual: 5,
      availability: { designation: null, practice: null },
      relevant: true,
      espn_mean: null,
    };
    expect(evaluateCases(world, [c])).toEqual([]);
  });

  it("forecasts: a non-finite target mean keeps v2's own; an empty sample reads 0", () => {
    const r = {
      gsis_id: "x",
      position: "WR" as const,
      season: 2025,
      week: 3,
      team: "AAA",
      played: true,
      actual: 4,
      availability: { designation: null, practice: null },
      relevant: true,
      espn_mean: null,
      p_active: 1,
      v2_mean: 0,
      v2_sorted: new Float64Array(0),
      t4_mean: 3,
      std_mean: 3,
      cv: 0.6,
      expectation: expectV2(
        { position: "WR", position_id: 3, team: "AAA", games: [wrGame(1)] },
        ctx,
      ) as never,
    };
    expect(v2Forecast(r, Number.NaN)).toMatchObject({ mean: 0, p10: 0, p90: 0 });
    expect(v2Forecast(r, 5).crps).toBe(gammaForecast(5, 0.6, 4).crps);
  });
});
