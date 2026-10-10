// project.perf.test.ts — v2-opportunity's CPU and stall budgets (plan 07 E1 A-7: the 8 s CPU deadline;
// plan 01 §1.1, plan 03 §1.2: cooperative batches, the main loop never stalls more than 50 ms; ADV
// OBJ-07), run in the `process` project (wall clock, never under coverage): the worst in-bounds call
// — 64 targets, every one with an ESPN mean (so the anchored ensemble simulates too), n_sims at the
// E1 ceiling shared down by V2_SIMS.maxTotalLines — finishes inside half the deadline, never partial;
// one scoring step (scoreSamples over V2_SIMS.max lines) stays under 20 ms; a 5 ms heartbeat never
// sees a gap over 50 ms while it runs on the real event loop.
import { describe, expect, it } from "vitest";
import { seededRng, systemClock } from "../../../../src/domain/clock.js";
import { SIMS } from "../../../../src/domain/analytics/constants.js";
import { V2_SIMS } from "../../../../src/domain/analytics/projections-v2/constants.js";
import { projectV2 } from "../../../../src/domain/analytics/projections-v2/project.js";
import {
  simDist,
  simulateLines,
} from "../../../../src/domain/analytics/projections-v2/simulate.js";
import { expectV2 } from "../../../../src/domain/analytics/projections-v2/expectation.js";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import type { V2Request, V2Target } from "../../../../src/domain/analytics/projections-v2/types.js";
import { indexTeamGames } from "../../../../src/domain/analytics/projections-v2/window.js";
import { qbGame, rbGame, settings, target, teamSeason, wrGame } from "./helpers/synthetic.js";

const weeks = Array.from({ length: 16 }, (_, i) => (i % 8) + 1);
const make = [
  (i: number): V2Target =>
    target(
      "QB",
      weeks.map((w, j) => qbGame(w, {}, 2024 + Math.floor(j / 8))),
      { player_id: i, espn_mean: 18 },
    ),
  (i: number): V2Target =>
    target(
      "RB",
      weeks.map((w, j) => rbGame(w, {}, 2024 + Math.floor(j / 8))),
      { player_id: i, espn_mean: 12 },
    ),
  (i: number): V2Target =>
    target(
      "WR",
      weeks.map((w, j) => wrGame(w, {}, 2024 + Math.floor(j / 8))),
      { player_id: i, espn_mean: 13 },
    ),
];
const pick = (i: number): ((i: number) => V2Target) => {
  const f = make[i % 3];
  if (f === undefined) throw new Error("no maker");
  return f;
};
const rows = [...teamSeason(8, "AAA", 2024), ...teamSeason(8, "AAA", 2025)];
const req = (): V2Request => ({
  targets: Array.from({ length: 64 }, (_, i) => pick(i)(i + 1)),
  season: 2025,
  week: 9,
  settings: settings(),
  team_games: rows,
  markets: { AAA: { implied: 24, spread: 3, total: 45 } },
  opponents: { AAA: "BBB" },
  clock: systemClock,
  rng: seededRng(1),
  n_sims: SIMS.max,
});

/** Runs `work` while a 5 ms heartbeat records the longest gap between beats. */
async function maxStall(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);
  try {
    await work();
  } finally {
    clearInterval(beat);
  }
  return Math.max(worst, performance.now() - last);
}

describe("v2-opportunity budgets", () => {
  it("the worst in-bounds call stays inside half the 8 s CPU deadline, never partial", async () => {
    const t0 = performance.now();
    const out = await projectV2(req());
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(out.partial).toBe(false);
    expect(out.data.projections).toHaveLength(64);
  });

  it("one scoring step (scoreSamples over V2_SIMS.max lines) stays under 20 ms", () => {
    const r = expectV2(
      { position: "WR", position_id: 3, team: "AAA", games: weeks.map((w) => wrGame(w)) },
      {
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
      },
    );
    if (typeof r === "string") throw new Error(r);
    const lines = simulateLines(r.expectation, 1, DEFAULT_V2_PARAMS, seededRng(2), V2_SIMS.max);
    simDist(lines, settings());
    const t0 = performance.now();
    simDist(lines, settings());
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("heartbeat: the event loop never stalls more than 50 ms while v2 runs", async () => {
    expect(await maxStall(() => projectV2(req()))).toBeLessThanOrEqual(50);
  });
});
