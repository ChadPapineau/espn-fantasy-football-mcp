// trace.test.ts — v2's tuning trace (src/domain/analytics/projections-v2/trace.ts; plan 10 C9: the
// retrospective's re-fit reads it from the stored projection): the share history is the current
// role's per-game shares oldest first (a change point cuts the older role off), each rate keeps v2's
// (n, observed, prior, k) under the registry's name with the position's own TD rate, the matchup is
// m = 1 + β·z from the cell, weather only when applied, the realised side is unknown; projectV2's
// detail carries it; and V2Trace stays assignable to reclog's ProjectionTrace. Synthetic data only.
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import { fixedClock, seededRng } from "../../../../src/domain/clock.js";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import { expectV2 } from "../../../../src/domain/analytics/projections-v2/expectation.js";
import { projectV2 } from "../../../../src/domain/analytics/projections-v2/project.js";
import {
  TRACE_HISTORY_MAX,
  traceV2,
  type V2Trace,
} from "../../../../src/domain/analytics/projections-v2/trace.js";
import type {
  V2Game,
  V2MatchupTable,
  V2Position,
} from "../../../../src/domain/analytics/projections-v2/types.js";
import { indexTeamGames } from "../../../../src/domain/analytics/projections-v2/window.js";
import type { ProjectionTrace } from "../../../../src/domain/reclog/attribution.js";
import { instantPacer } from "../helpers.js";
import { qbGame, rbGame, settings, target, teamSeason, wrGame } from "./helpers/synthetic.js";

const weeks = [1, 2, 3, 4, 5, 6, 7, 8];
const teamGames = teamSeason(8);
const index = indexTeamGames(teamGames);

function traceOf(
  pos: V2Position,
  games: readonly V2Game[],
  opts: { matchup?: V2MatchupTable | null; windy?: boolean } = {},
): V2Trace {
  const out = expectV2(
    { position: pos, position_id: { QB: 1, RB: 2, WR: 3, TE: 4 }[pos], team: "AAA", games },
    {
      season: 2025,
      week: 9,
      team_index: index,
      team_games: teamGames,
      market: { implied: 22, spread: 0, total: 44 },
      weather:
        opts.windy === true
          ? { roof: "outdoors", temp_f: 50, wind_mph: 20, precip_prob: null }
          : null,
      opponent: "BBB",
      matchup: opts.matchup ?? null,
      priors: DEFAULT_V2_PRIORS,
      params: DEFAULT_V2_PARAMS,
    },
  );
  if (typeof out === "string") throw new Error(out);
  return traceV2(out, games, 2025, 9, index, DEFAULT_V2_PARAMS);
}

describe("traceV2", () => {
  it("is assignable to the retrospective's ProjectionTrace", () => {
    expectTypeOf<V2Trace>().toExtend<ProjectionTrace>();
  });

  it("a WR: target and carry shares oldest first, the receiving rates, the target TD rate", () => {
    const games = weeks.map((w) => wrGame(w, { targets: w })); // a growing role
    const t = traceOf("WR", games);
    const ts = t.shares.find((s) => s.name === "target_share");
    expect(ts?.history).toEqual(weeks.map((w) => Math.round((w / 38) * 1e4) / 1e4));
    expect(ts?.half_life).toBe(DEFAULT_V2_PARAMS.half_life_games);
    expect(ts?.realised).toBeNull();
    const names = t.rates.map((r) => r.name).sort();
    expect(names).toEqual(expect.arrayContaining(["catch_rate", "yards_per_reception", "td_rate"]));
    expect(names).not.toContain("completion_rate"); // a WR throws nothing: no observation
    for (const r of t.rates) {
      expect(r.realised).toBeNull();
      expect(r.realised_n).toBe(0);
      expect(r.n_obs).toBeGreaterThan(0);
      expect(r.k).toBeGreaterThan(0);
    }
    expect(t.matchup).toBeNull();
    expect(t.weather_mult).toBeNull();
  });

  it("a QB carries no target share; its TD rate is per attempt; an RB's per carry", () => {
    const qb = traceOf(
      "QB",
      weeks.map((w) => qbGame(w)),
    );
    expect(qb.shares.map((s) => s.name)).toEqual(["carry_share"]);
    expect(qb.rates.map((r) => r.name)).toEqual(
      expect.arrayContaining(["completion_rate", "int_rate", "td_rate"]),
    );
    const td = qb.rates.find((r) => r.name === "td_rate");
    // ffopportunity's 1.6 expected passing TDs on 34 attempts per game
    expect(td?.observed).toBeCloseTo(1.6 / 34, 3);
    const rb = traceOf(
      "RB",
      weeks.map((w) => rbGame(w)),
    );
    expect(rb.rates.find((r) => r.name === "td_rate")?.observed).toBeCloseTo(0.5 / 16, 3);
    expect(rb.rates.find((r) => r.name === "yards_per_carry")?.observed).toBeCloseTo(70 / 16, 3);
  });

  it("a change point keeps only the current role's games", () => {
    const games = weeks.map((w) =>
      wrGame(w, w <= 4 ? { targets: 2, snap_pct: 0.3 } : { targets: 10, snap_pct: 0.9 }),
    );
    const t = traceOf("WR", games);
    const h = t.shares.find((s) => s.name === "target_share")?.history ?? [];
    expect(h.length).toBeLessThan(8);
    expect(h.every((x) => x === Math.round((10 / 38) * 1e4) / 1e4)).toBe(true);
  });

  it("the matchup is m = 1 + β·z from the cell; weather only when applied", () => {
    const matchup: V2MatchupTable = { "BBB|WR": { afpa: 1.2, relative: 1.15, games: 3 } };
    const t = traceOf(
      "WR",
      weeks.map((w) => wrGame(w)),
      { matchup, windy: true },
    );
    const full = DEFAULT_V2_PARAMS.matchup_full_games;
    expect(t.matchup?.beta).toBe(DEFAULT_V2_PARAMS.matchup_beta.WR);
    expect(t.matchup?.z).toBeCloseTo(Math.min(1, 3 / full) * 0.15, 4);
    expect(t.weather_mult).not.toBeNull();
    expect(t.weather_mult ?? 2).toBeLessThan(1);
  });

  it("property: every share in [0, 1] and every history bounded, whatever the counts", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 1, maxLength: 8 }),
        (targets) => {
          const games = targets.map((n, i) => wrGame(i + 1, { targets: n, rec: Math.min(n, 3) }));
          const t = traceOf("WR", games);
          for (const s of t.shares) {
            expect(s.history.length).toBeLessThanOrEqual(TRACE_HISTORY_MAX);
            for (const x of s.history) {
              expect(x).toBeGreaterThanOrEqual(0);
              expect(x).toBeLessThanOrEqual(1);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("projectV2's detail carries the trace for a modelled player only", async () => {
    const out = await projectV2({
      targets: [
        target(
          "WR",
          weeks.map((w) => wrGame(w)),
          { espn_mean: 14 },
        ),
        target("WR", [], { player_id: 77, gsis_id: "00-9000077" }),
      ],
      season: 2025,
      week: 9,
      settings: settings(),
      team_games: teamGames,
      clock: fixedClock("2025-11-01T12:00:00Z"),
      rng: seededRng(3),
      pacer: instantPacer,
      deadline_ms: null,
      n_sims: 200,
    });
    expect(out.details[0]?.trace?.shares.length).toBeGreaterThan(0);
    expect(out.details[1]?.skipped).toBe("no_history");
    expect(out.details[1]?.trace).toBeUndefined();
  });
});
