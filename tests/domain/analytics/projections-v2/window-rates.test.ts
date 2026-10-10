// window-rates.test.ts — sib research 05 §1 step 2 (the weighted window and the change-point
// re-base) and step 4 (shrinkage per rate, the pooled priors): weights halve every h games and
// decay per season back, a jump of ≥ 15 snap points held two games re-bases, a one-game blip or a
// sub-threshold drift does not, hostile counts are dropped; shrinkage lies between the observation
// and the prior (fast-check), k → ∞ is the prior; buildV2Priors pools and keeps the defaults on thin
// pools.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import {
  buildV2Priors,
  shrinkRate,
} from "../../../../src/domain/analytics/projections-v2/rates.js";
import type { V2Game, V2Position } from "../../../../src/domain/analytics/projections-v2/types.js";
import {
  countsFinite,
  detectChangePoint,
  indexTeamGames,
  isBefore,
  playerWindow,
  teamGameKey,
  weightedSum,
} from "../../../../src/domain/analytics/projections-v2/window.js";
import { game, teamSeason, wrGame } from "./helpers/synthetic.js";

const idx = indexTeamGames(teamSeason(17));

describe("playerWindow", () => {
  it("reads only games before the target week, most recent first, weights halving every h games", () => {
    const games = [1, 2, 3, 4, 5, 6].map((w) => wrGame(w));
    const win = playerWindow(games, 2025, 5, idx, DEFAULT_V2_PARAMS);
    expect(win.games.map((g) => g.game.week)).toEqual([4, 3, 2, 1]);
    const h = DEFAULT_V2_PARAMS.half_life_games;
    win.games.forEach((g, i) => {
      expect(g.weight).toBeCloseTo(0.5 ** (i / h), 12);
    });
    expect(win.change_point).toBeNull();
    expect(win.role_games).toBe(4);
    expect(win.games[0]?.team?.week).toBe(4);
  });

  it("discounts a game of an earlier season by prior_season_weight per season back", () => {
    const games = [wrGame(17, {}, 2024), wrGame(1)];
    const win = playerWindow(games, 2025, 2, idx, DEFAULT_V2_PARAMS);
    expect(win.games[1]?.weight).toBeCloseTo(
      0.5 ** (1 / DEFAULT_V2_PARAMS.half_life_games) * DEFAULT_V2_PARAMS.prior_season_weight,
      12,
    );
  });

  it("caps the window at max_games", () => {
    const games = Array.from({ length: 30 }, (_, i) =>
      wrGame((i % 17) + 1, {}, 2020 + Math.floor(i / 17)),
    );
    const win = playerWindow(games, 2026, 1, idx, { ...DEFAULT_V2_PARAMS, max_games: 5 });
    expect(win.games).toHaveLength(5);
  });

  it("re-bases at a snap-share jump held two games (the earlier games keep pre_weight)", () => {
    const snaps = [0.3, 0.32, 0.28, 0.31, 0.62, 0.65, 0.66];
    const games = snaps.map((s, i) => wrGame(i + 1, { snap_pct: s }));
    const win = playerWindow(games, 2025, 8, idx, DEFAULT_V2_PARAMS);
    expect(win.change_point).toMatchObject({ season: 2025, week: 5, metric: "snap_pct" });
    expect(win.change_point?.delta).toBeCloseTo(0.62 - (0.31 + 0.28 + 0.32) / 3, 6);
    expect(win.role_games).toBe(3);
    const pre = DEFAULT_V2_PARAMS.change_point.pre_weight;
    const h = DEFAULT_V2_PARAMS.half_life_games;
    expect(win.games[3]?.weight).toBeCloseTo(0.5 ** (3 / h) * pre, 12);
    expect(win.games[2]?.weight).toBeCloseTo(0.5 ** (2 / h), 12);
  });

  it("does not re-base on a one-game blip, a drift under the threshold, or a jump not yet held", () => {
    const blip = [0.3, 0.3, 0.3, 0.3, 0.7, 0.3, 0.3].map((s, i) => wrGame(i + 1, { snap_pct: s }));
    expect(playerWindow(blip, 2025, 8, idx, DEFAULT_V2_PARAMS).change_point).toBeNull();
    const drift = [0.3, 0.34, 0.38, 0.42, 0.44, 0.46].map((s, i) => wrGame(i + 1, { snap_pct: s }));
    expect(playerWindow(drift, 2025, 7, idx, DEFAULT_V2_PARAMS).change_point).toBeNull();
    const fresh = [0.3, 0.3, 0.3, 0.3, 0.8].map((s, i) => wrGame(i + 1, { snap_pct: s }));
    expect(playerWindow(fresh, 2025, 6, idx, DEFAULT_V2_PARAMS).change_point).toBeNull();
  });

  it("falls back to the opportunity share without snap counts (a downward role change too)", () => {
    const tg = [10, 10, 10, 10, 2, 2].map((t, i) => wrGame(i + 1, { targets: t, snap_pct: null }));
    const win = playerWindow(tg, 2025, 7, idx, DEFAULT_V2_PARAMS);
    expect(win.change_point?.metric).toBe("opportunity_share");
    expect(win.change_point?.delta).toBeLessThan(0);
  });

  it("drops a game with a hostile count (NaN, negative, infinite) instead of reading 0", () => {
    const games = [
      wrGame(1),
      wrGame(2, { targets: Number.NaN }),
      wrGame(3, { rec: -1 }),
      wrGame(4, { rec_yd: Number.POSITIVE_INFINITY }),
      wrGame(5, { rec_yd: -3 }),
    ];
    const win = playerWindow(games, 2025, 6, idx, DEFAULT_V2_PARAMS);
    expect(win.games.map((g) => g.game.week)).toEqual([5, 1]);
    expect(countsFinite(game({ week: 1.5 }))).toBe(false);
  });

  it("is empty with no prior game", () => {
    expect(playerWindow([wrGame(3)], 2025, 3, idx, DEFAULT_V2_PARAMS).games).toHaveLength(0);
  });
});

describe("detectChangePoint / helpers", () => {
  it("needs three baseline games of the same metric", () => {
    const chrono = [0.3, 0.9, 0.9].map((s, i) => ({
      game: wrGame(i + 1, { snap_pct: s }),
      weight: 1,
      team: null,
    }));
    expect(detectChangePoint(chrono, DEFAULT_V2_PARAMS)).toBeNull();
  });

  it("isBefore, teamGameKey, weightedSum", () => {
    expect(isBefore({ season: 2024, week: 18 }, 2025, 1)).toBe(true);
    expect(isBefore({ season: 2025, week: 1 }, 2025, 1)).toBe(false);
    expect(teamGameKey("AAA", 2025, 3)).toBe("AAA|2025|3");
    const w = weightedSum(
      [
        { game: wrGame(1), weight: 1, team: null },
        { game: wrGame(2), weight: 0.5, team: null },
      ],
      (x) => (x.game.week === 2 ? null : x.game.targets),
    );
    expect(w).toEqual({ sum: 8, weight: 1, games: 1 });
  });
});

describe("shrinkRate", () => {
  it("is (num + k·prior)/(den + k) and reports n, k, the observation and the prior", () => {
    const s = shrinkRate("catch_rate", 30, 40, 60, 0.6);
    expect(s.value).toBeCloseTo((30 + 60 * 0.6) / 100, 12);
    expect(s).toMatchObject({ rate: "catch_rate", n: 40, k: 60, observed: 0.75, prior: 0.6 });
  });

  it("no observation, or a hostile one, is the prior", () => {
    expect(shrinkRate("x", 0, 0, 10, 0.3).value).toBe(0.3);
    expect(shrinkRate("x", Number.NaN, 5, 10, 0.3).value).toBe(0.3);
    expect(shrinkRate("x", 3, -5, 10, 0.3).observed).toBeNull();
    expect(shrinkRate("x", 3, 5, Number.NaN, 0.3).value).toBeCloseTo(0.6, 12);
  });

  it("property: the shrunk rate lies between the observation and the prior; k → ∞ is the prior", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.double({ min: 0.1, max: 500, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 30, noNaN: true }),
        (num, den, k, prior) => {
          const s = shrinkRate("r", num, den, k, prior);
          const obs = num / den;
          expect(s.value).toBeGreaterThanOrEqual(Math.min(obs, prior) - 1e-9);
          expect(s.value).toBeLessThanOrEqual(Math.max(obs, prior) + 1e-9);
          expect(shrinkRate("r", num, den, 1e12, prior).value).toBeCloseTo(prior, 6);
        },
      ),
    );
  });
});

describe("buildV2Priors", () => {
  it("keeps every default on thin pools", () => {
    const p = buildV2Priors(new Map(), []);
    expect(p).toEqual(DEFAULT_V2_PRIORS);
  });

  it("pools rates from history once a pool is thick enough", () => {
    const wrs: V2Game[] = Array.from({ length: 80 }, (_, i) =>
      wrGame((i % 17) + 1, {
        targets: 10,
        rec: 7,
        rec_yd: 70,
        rz_targets: 2,
        rz_rec_td: 1,
        rec_td: 1,
        x_rec_td: 0.5,
      }),
    );
    const games = new Map<V2Position, V2Game[]>([["WR", wrs]]);
    const p = buildV2Priors(games, teamSeason(17));
    expect(p.positions.WR.catch_rate).toBe(0.7);
    expect(p.positions.WR.yards_per_rec).toBe(10);
    expect(p.positions.WR.xtd_per_target).toBe(0.05);
    expect(p.positions.WR.td_rz_target).toBe(0.5);
    expect(p.positions.WR.td_other_target).toBe(0);
    // 17 team-games is under the 32 a league mean needs
    expect(p.team_dropbacks).toBe(DEFAULT_V2_PRIORS.team_dropbacks);
    expect(p.positions.QB).toEqual(DEFAULT_V2_PRIORS.positions.QB);
  });

  it("pools the team means from ≥ 32 team-games", () => {
    const p = buildV2Priors(new Map(), [...teamSeason(17), ...teamSeason(17, "BBB")]);
    expect(p.team_dropbacks).toBe(38);
    expect(p.team_rushes).toBe(26);
    expect(p.team_implied).toBe(22);
  });
});
