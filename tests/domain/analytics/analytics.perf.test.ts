// analytics.perf.test.ts — the latency and stall budgets of the samplers (plan 10 A16a; plan 07 E1
// A-7; plan 01 §1.1, plan 03 §1.2; ADV OBJ-07), run in the `process` project (wall clock, never under
// coverage): E1 for 32 players at n_sims 4000 < 3 s; the worst in-bounds E1 call at N_SIMS_MAX
// (64 players × 18 weeks, shared down by maxTotalSamples) inside half the 8 s CPU deadline, never
// partial — the measurement N_SIMS_MAX rests on; the seeding simulator at 10 000 paths < 5 s; and a
// heartbeat timer never stalled more than 50 ms while the samplers run on the real event loop.
import { describe, expect, it } from "vitest";
import { N_SIMS_MAX, SIMS } from "../../../src/domain/analytics/constants.js";
import { projectPlayers, type ProjectionTarget } from "../../../src/domain/analytics/projection.js";
import { simulateSeason, type SeasonSimRequest } from "../../../src/domain/analytics/seeding.js";
import { seededRng, systemClock } from "../../../src/domain/clock.js";
import { asPositionId } from "../../../src/domain/scoring/types.js";
import { bare, POSITION_ID, proSchedule, referenceSettings } from "./helpers.js";

const POS = ["QB", "RB", "WR", "TE", "K", "D/ST"];
function targets(n: number): ProjectionTarget[] {
  return Array.from({ length: n }, (_, i) => {
    const pos = POS[i % POS.length] ?? "WR";
    const trailing =
      pos === "QB"
        ? Array.from({ length: 6 }, (_, w) => ({
            season: 2026,
            week: w + 1,
            line: {
              values: { pass_yd: 250, pass_td: 2, pass_int: 1 },
              present: ["pass_int", "pass_td", "pass_yd"],
              position: asPositionId(1),
              position_class: "O" as const,
              provisional: false,
              source: "nflverse",
            },
          }))
        : [];
    return {
      player_id: i + 1,
      gsis_id: null,
      name: bare(`Player ${String(i + 1)}`),
      position: pos,
      position_id: POSITION_ID[pos] ?? 3,
      pro_team_id: (i % 32) + 1,
      injury_status: i % 5 === 0 ? "QUESTIONABLE" : null,
      espn_week: 12,
      espn_ros: 150,
      trailing,
    };
  });
}

const schedule = proSchedule(
  2026,
  Array.from({ length: 18 }, (_, i) => i + 1),
);
const e1 = (n: number, weeks: number, sims: number) =>
  projectPlayers({
    targets: targets(n),
    season: 2026,
    horizon: weeks === 1 ? "week" : "ros",
    week: 1,
    final_week: weeks,
    settings: referenceSettings(),
    schedule,
    clock: systemClock,
    rng: seededRng(1),
    n_sims: sims,
  });

function season(n: number): SeasonSimRequest {
  const teams = Array.from({ length: 12 }, (_, i) => ({
    team_id: i + 1,
    division_id: i % 2,
    wins: 2,
    losses: 2,
    ties: 0,
    points_for: 400 + i * 5,
    points_against: 400,
  }));
  const remaining: { period: number; home: number; away: number }[] = [];
  for (let w = 5; w <= 14; w++)
    for (let i = 0; i < 6; i++)
      remaining.push({ period: w, home: ((i + w) % 12) + 1, away: ((i + w + 6) % 12) + 1 });
  return {
    teams,
    played: [],
    remaining,
    me: 1,
    playoff: {
      team_count: 6,
      seeding_rule: "TOTAL_POINTS_SCORED",
      reseed: false,
      rounds: [{ weeks: [15] }, { weeks: [16] }, { weeks: [17] }],
    },
    seeding_mode: "both",
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    clock: systemClock,
    rng: seededRng(1),
    n_sims: n,
  };
}

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

describe("sampler budgets (A16a)", () => {
  it("E1: 32 players at n_sims 4000 in < 3 s", async () => {
    const t0 = performance.now();
    const out = await e1(32, 1, 4000);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(out.partial).toBe(false);
  });

  it("N_SIMS_MAX: the worst in-bounds E1 call stays inside half the CPU deadline, never partial", async () => {
    expect(N_SIMS_MAX).toBe(SIMS.max);
    const t0 = performance.now();
    const out = await e1(64, 18, N_SIMS_MAX);
    const ms = performance.now() - t0;
    expect(out.partial).toBe(false);
    expect(ms).toBeLessThan(4000);
    const single = performance.now();
    const one = await e1(64, 1, N_SIMS_MAX);
    expect(one.data.completed_samples).toBe(N_SIMS_MAX);
    expect(performance.now() - single).toBeLessThan(4000);
  });

  it("the seeding simulator: 10 000 paths, both readings, every marginal value, in < 5 s", async () => {
    const t0 = performance.now();
    const out = await simulateSeason(season(10_000));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(out.data.n_sims).toBe(10_000);
  });

  it("heartbeat: the event loop never stalls more than 50 ms while the samplers run", async () => {
    expect(await maxStall(() => e1(64, 18, N_SIMS_MAX))).toBeLessThanOrEqual(50);
    expect(await maxStall(() => simulateSeason(season(20_000)))).toBeLessThanOrEqual(50);
  });
});
