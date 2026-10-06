// replacement.test.ts — E4 (src/domain/analytics/replacement.ts; plan 07 E4; research 05 §3.1, §4.1;
// sib research 05 §2) as a domain unit test; the hard B7 regression on the nflverse files is
// tests/backtest/replacement.test.ts. Here: the allocation plan of every recorded slot shape (the
// reference league, a two-flex league, a TQB + five-FLEX league, a superflex), a hand-computed
// allocation, the QB replacement depth, the bench effect; properties of the kernel (input-order
// invariance, the greedy flex invariant, seats conserved, baseline ≤ last starter); gap tiers and
// expected excess; the full engine (weekly vs ROS baselines under byes, the stream baseline from the
// pool and streamability, VOR_weekly / VOR_ROS / xVBD, players[] selection, horizon and baseline
// modes, the cooperative deadline) and hostile inputs.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import {
  REPLACEMENT,
  allocate,
  allocationPlanOf,
  analyzeReplacement,
  expectedExcess,
  gapTiers,
  planPositions,
  replacementDepth,
  streamCandidates,
  type AllocationEntry,
  type ReplacementPlayer,
  type ReplacementRequest,
} from "../../../src/domain/analytics/replacement.js";
import { normalCdf } from "../../../src/domain/analytics/math.js";
import { buildRosterSlots } from "../../../src/domain/league/slots.js";
import type { RosterSlots } from "../../../src/domain/league/types.js";
import { bare, clockAndRng, dist, instantPacer, referenceSlots, steppingPacer } from "./helpers.js";

const slotsOf = (counts: Record<string, number>): RosterSlots =>
  buildRosterSlots({
    slot_counts: counts,
    position_limits: {},
    lineup_lock_type: "INDIVIDUAL_GAME",
    undroppable_list: false,
    move_limit: null,
  }).roster;

const e = (key: number, position: string, value: number): AllocationEntry => ({
  key,
  position,
  value,
});

describe("the allocation plan", () => {
  it("the reference league: dedicated QB/2RB/2WR/TE/D/ST/K, one FLEX; QB depth 2 at N = 10", () => {
    const plan = allocationPlanOf(referenceSlots());
    expect(plan.fixed).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, "D/ST": 1, K: 1 });
    expect(plan.flex).toEqual([{ slot: "FLEX", positions: ["RB", "WR", "TE"], count: 1 }]);
    expect(planPositions(plan)).toEqual(["QB", "RB", "WR", "TE", "K", "D/ST"]);
    expect(replacementDepth(plan, 10)).toEqual({ QB: 2, RB: 1, WR: 1, TE: 1, K: 1, "D/ST": 1 });
    expect(replacementDepth(plan, 12).QB).toBe(2);
    expect(replacementDepth(plan, 2).QB).toBe(1);
  });

  it("a two-flex league fills the narrower flexes first; TQB + five FLEX; superflex reads QB at depth 1", () => {
    const twoFlex = allocationPlanOf(
      slotsOf({ "0": 1, "2": 2, "4": 2, "6": 1, "3": 1, "5": 1, "23": 1, "20": 6 }),
    );
    expect(twoFlex.flex.map((f) => f.slot)).toEqual(["RB/WR", "WR/TE", "FLEX"]);
    const tqb = allocationPlanOf(
      slotsOf({ "1": 1, "2": 1, "4": 1, "23": 5, "16": 1, "17": 1, "20": 6 }),
    );
    expect(tqb.fixed).toMatchObject({ TQB: 1, RB: 1, WR: 1 });
    expect(tqb.flex).toEqual([{ slot: "FLEX", positions: ["RB", "WR", "TE"], count: 5 }]);
    const superflex = allocationPlanOf(
      slotsOf({ "0": 1, "2": 2, "4": 2, "6": 1, "7": 1, "20": 5 }),
    );
    expect(superflex.flex[0]?.slot).toBe("OP");
    expect(replacementDepth(superflex, 10).QB).toBe(1);
    // bench and IR never count as seats
    expect(allocationPlanOf(slotsOf({ "20": 9, "21": 3 }))).toEqual({ fixed: {}, flex: [] });
  });
});

describe("allocate (research 05 §4.1)", () => {
  it("a hand-computed N = 2 league: dedicated seats, then the FLEX from the best remaining", () => {
    const plan = allocationPlanOf(slotsOf({ "0": 1, "2": 1, "4": 1, "23": 1, "20": 3 }));
    const entries = [
      e(1, "QB", 25),
      e(2, "QB", 20),
      e(3, "QB", 18),
      e(4, "QB", 15),
      e(11, "RB", 18),
      e(12, "RB", 14),
      e(13, "RB", 13),
      e(14, "RB", 8),
      e(21, "WR", 17),
      e(22, "WR", 15),
      e(23, "WR", 12),
      e(24, "WR", 11),
      e(31, "TE", 12.5),
      e(32, "TE", 7),
    ];
    const a = allocate(entries, plan, 2, { depth: { QB: 1, RB: 1, WR: 1, TE: 1 } });
    // RB 18, 14 and WR 17, 15 are dedicated; FLEX ×2: RB 13, then TE 12.5 over WR 12
    expect(a.flex_split).toEqual({ QB: 0, RB: 1, WR: 0, TE: 1 });
    expect(a.trace).toEqual([
      { slot: "FLEX", position_filled: "RB" },
      { slot: "FLEX", position_filled: "TE" },
    ]);
    expect(a.slotted).toEqual({ QB: 2, RB: 3, WR: 2, TE: 1 });
    expect(a.baseline).toEqual({ QB: 18, RB: 8, WR: 12, TE: 7 });
    expect(a.last_starter).toEqual({ QB: 20, RB: 13, WR: 15, TE: 12.5 });
    expect(a.baseline_rank).toEqual({ QB: 3, RB: 4, WR: 3, TE: 2 });
    expect(a.short).toEqual([]);
  });

  it("the QB depth reads the baseline past the last starter; a short pool reads 0 and is named", () => {
    const plan = allocationPlanOf(slotsOf({ "0": 1, "20": 1 }));
    const qbs = [30, 28, 26, 24, 22].map((v, i) => e(i + 1, "QB", v));
    expect(allocate(qbs, plan, 2).baseline.QB).toBe(26); // depth max(1, round(0.4)) = 1
    expect(allocate(qbs, plan, 2, { depth: { QB: 2 } }).baseline.QB).toBe(24);
    const short = allocate(qbs.slice(0, 2), plan, 2);
    expect(short.baseline.QB).toBe(0);
    expect(short.short).toEqual(["QB"]);
  });

  it("the bench effect deepens the baseline by slotted × share (sib research 05 §2)", () => {
    const plan = allocationPlanOf(slotsOf({ "2": 2, "20": 5 }));
    const rbs = Array.from({ length: 40 }, (_, i) => e(i + 1, "RB", 40 - i));
    const cold = allocate(rbs, plan, 10);
    const warm = allocate(rbs, plan, 10, { bench_share: { RB: 0.1 } });
    expect(cold.baseline_rank.RB).toBe(21);
    expect(warm.extra.RB).toBe(2);
    expect(warm.baseline_rank.RB).toBe(23);
    expect(warm.baseline.RB).toBeLessThan(cold.baseline.RB ?? 0);
    expect(allocate(rbs, plan, 10, { bench_share: { RB: Number.NaN } }).extra.RB).toBe(0);
  });

  it("non-finite values are ignored; positions the league does not start are ignored", () => {
    const plan = allocationPlanOf(referenceSlots());
    const a = allocate([e(1, "QB", Number.NaN), e(2, "QB", 20), e(3, "P", 99)], plan, 2);
    expect(a.ranked.QB?.map((x) => x.key)).toEqual([2]);
    expect(Object.keys(a.ranked)).not.toContain("P");
  });

  const arbEntries = fc.array(
    fc.record({
      position: fc.constantFrom("QB", "RB", "WR", "TE"),
      value: fc.double({ min: 0, max: 30, noNaN: true }),
    }),
    { minLength: 60, maxLength: 160 },
  );

  it("property: input order never matters; seats are conserved; baseline ≤ last starter", () => {
    const plan = allocationPlanOf(referenceSlots());
    fc.assert(
      fc.property(arbEntries, fc.integer({ min: 2, max: 6 }), (raw, n) => {
        const entries = raw.map((r, i) => e(i + 1, r.position, r.value));
        const a = allocate(entries, plan, n);
        const b = allocate([...entries].reverse(), plan, n);
        if (JSON.stringify(a) !== JSON.stringify(b)) return false;
        const seats = (1 + 2 + 2 + 1 + 1) * n;
        const slotted = ["QB", "RB", "WR", "TE"].reduce((s, p) => s + (a.slotted[p] ?? 0), 0);
        const flexFilled = a.trace.length;
        if (slotted !== seats - n + flexFilled) return false;
        for (const p of ["QB", "RB", "WR", "TE"]) {
          const last = a.last_starter[p];
          if (
            last !== null &&
            last !== undefined &&
            (a.ranked[p]?.length ?? 0) >= (a.baseline_rank[p] ?? 0)
          )
            if ((a.baseline[p] ?? 0) > last + 1e-12) return false;
        }
        return true;
      }),
    );
  });

  it("property: the greedy flex invariant — every flex player beats the best unslotted at every flex position", () => {
    const plan = allocationPlanOf(referenceSlots());
    fc.assert(
      fc.property(arbEntries, fc.integer({ min: 2, max: 6 }), (raw, n) => {
        const entries = raw.map((r, i) => e(i + 1, r.position, r.value));
        const a = allocate(entries, plan, n, { depth: { QB: 1, RB: 1, WR: 1, TE: 1 } });
        if (a.trace.length < n) return true; // a short pool
        const fixed = plan.fixed;
        const flexPlayers = ["RB", "WR", "TE"].flatMap((p) =>
          (a.ranked[p] ?? []).slice((fixed[p] ?? 0) * n, a.slotted[p] ?? 0),
        );
        const minFlex = Math.min(...flexPlayers.map((x) => x.value));
        const bestUnslotted = Math.max(
          ...["RB", "WR", "TE"].map((p) => a.ranked[p]?.[a.slotted[p] ?? 0]?.value ?? -Infinity),
        );
        return minFlex >= bestUnslotted - 1e-12;
      }),
    );
  });

  it("refuses a league size outside 2..20", () => {
    const plan = allocationPlanOf(referenceSlots());
    expect(() => allocate([], plan, 1)).toThrow(AnalyticsError);
    expect(() => allocate([], plan, 21)).toThrow(AnalyticsError);
    expect(() => allocate([], plan, 2.5)).toThrow(AnalyticsError);
  });
});

describe("gap tiers and expected excess", () => {
  it("gapTiers: starts at 1, never decreases, at most maxTiers; breaks at a large gap", () => {
    expect(gapTiers([])).toEqual([]);
    expect(gapTiers([20, 19.8, 19.6, 15, 14.9, 14.7, 9])).toEqual([1, 1, 1, 2, 2, 2, 3]);
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 40, noNaN: true }), { maxLength: 60 }),
        (xs) => {
          const v = [...xs].sort((a, b) => b - a);
          const t = gapTiers(v);
          return (
            t.length === v.length &&
            (t.length === 0 || t[0] === 1) &&
            t.every((x, i) => i === 0 || x >= (t[i - 1] ?? 0)) &&
            t.every((x) => x <= REPLACEMENT.maxTiers)
          );
        },
      ),
    );
  });

  it("expectedExcess: E[max(X − b, 0)] — ≥ max(0, μ − b), σ = 0 exact, agrees with numeric integration", () => {
    expect(expectedExcess(12, 0, 10)).toBe(2);
    expect(expectedExcess(8, 0, 10)).toBe(0);
    const mu = 11;
    const sd = 4;
    const b = 10;
    let num = 0;
    const steps = 20_000;
    for (let i = 0; i < steps; i++) {
      const z = -8 + (16 * (i + 0.5)) / steps;
      const x = mu + sd * z;
      num += Math.max(0, x - b) * (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * (16 / steps);
    }
    expect(expectedExcess(mu, sd, b)).toBeCloseTo(num, 4);
    fc.assert(
      fc.property(
        fc.double({ min: -20, max: 40, noNaN: true }),
        fc.double({ min: 0, max: 15, noNaN: true }),
        fc.double({ min: 0, max: 30, noNaN: true }),
        (m, s, bb) => expectedExcess(m, s, bb) >= Math.max(0, m - bb) - 1e-9,
      ),
    );
    expect(normalCdf(0)).toBeCloseTo(0.5, 9);
  });
});

// --- the full engine -----------------------------------------------------------------------------

const W = [5, 6, 7, 8];

/** A 2-team league pool: per position `n` rostered players and `k` available ones, linear values. */
function pool(opts: { byeWeek?: number; available?: boolean } = {}): ReplacementPlayer[] {
  const out: ReplacementPlayer[] = [];
  let id = 1;
  const add = (position: string, base: number, n: number, rostered: boolean) => {
    for (let i = 0; i < n; i++) {
      const mean = base - i;
      out.push({
        player_id: id,
        name: bare(`P${String(id)}`),
        position,
        rostered,
        weeks: W.map((w) => ({ mean, bye: opts.byeWeek === w && i === 0 })),
        ros: null,
        week_dist: dist(mean, 0.5),
      });
      id += 1;
    }
  };
  add("QB", 25, 4, true);
  add("RB", 18, 7, true);
  add("WR", 17, 7, true);
  add("TE", 12, 3, true);
  add("K", 9, 3, true);
  add("D/ST", 8, 3, true);
  if (opts.available !== false) {
    add("QB", 18, 2, false);
    add("RB", 9, 2, false);
    add("WR", 9.5, 2, false);
    add("TE", 7, 2, false);
    add("K", 7.8, 2, false);
    add("D/ST", 6.9, 2, false);
  }
  return out;
}

function rq(over: Partial<ReplacementRequest> = {}): ReplacementRequest {
  const { clock } = clockAndRng();
  return {
    roster: referenceSlots(),
    league_size: 2,
    weeks: W,
    players: pool(),
    clock,
    pacer: instantPacer,
    deadline_ms: null,
    ...over,
  };
}

describe("analyzeReplacement", () => {
  it("ROS baselines per game; the stream baseline is the best AVAILABLE player; streamability vs the last starter", async () => {
    const out = await analyzeReplacement(rq({ detail: "full" }));
    const rb = out.data.positions.find((p) => p.position === "RB");
    // RB: 4 dedicated + FLEX ×2 (RB 14 vs WR 13 → RB, then RB 13 vs WR 13 tie → RB first listed)
    expect(out.allocation.flex_split).toMatchObject({ RB: 2, WR: 0, TE: 0 });
    expect(rb?.starter_baseline_ros).toBe(12); // the 7th RB (18 − 6) — the best unslotted
    expect(rb?.stream_baseline_weekly.map((x) => x.points)).toEqual([9, 9, 9, 9]);
    expect(out.streamability_basis.RB).toBe("pool");
    expect(rb?.streamability).toBeCloseTo(9 / 13, 3); // best available / last starter (RB6 = 13)
    const k = out.data.positions.find((p) => p.position === "K");
    expect(k?.streamability).toBeCloseTo(7.8 / 8, 3);
    expect(out.data.format_notes.streamable_positions).toEqual(["K", "D/ST"]);
    expect(out.data.format_notes.flex_split).toEqual({ rb: 2, wr: 0, te: 0 });
    // QB at N = 2: depth 1 (round(0.4) → at least 1): baseline = QB3 = 23; last starter QB2 = 24
    expect(out.data.format_notes.qb_last_starter_vs_replacement_ppg).toBe(1);
    expect(out.data.rec).toBeNull();
    expect(out.partial).toBe(false);
  });

  it("a bye lowers that week's starter baseline only; VOR_ROS charges the bye week 0 − baseline", async () => {
    const out = await analyzeReplacement(rq({ players: pool({ byeWeek: 6 }) }));
    const qb = out.data.positions.find((p) => p.position === "QB");
    const wk = new Map(qb?.starter_baseline_weekly.map((x) => [x.week, x.points]));
    expect(wk.get(5)).toBe(23);
    expect(wk.get(6)).toBe(22); // QB1 on bye: everyone moves up one
    const top = out.data.players.find((p) => p.player_id === 1);
    // weeks 5, 7, 8: 25 − 23 = 2 each; week 6: 0 − 22
    expect(top?.vor_ros.mean).toBeCloseTo(2 * 3 - 22, 6);
    expect(top?.vor_weekly).toBeCloseTo(25 - 18, 6);
    expect(top?.xvbd).toBeGreaterThan(25 - 23);
    expect(top?.tier).toBe(1);
  });

  it("without a pool, streamability is the allocation proxy and says so", async () => {
    const out = await analyzeReplacement(rq({ players: pool({ available: false }) }));
    expect(Object.values(out.streamability_basis).every((b) => b === "allocation_proxy")).toBe(
      true,
    );
    expect(out.assumptions.some((a) => a.text.includes("no free-agent pool"))).toBe(true);
    expect(out.data.players.every((p) => p.vor_weekly === null)).toBe(true);
    expect(out.data.positions.every((p) => p.stream_baseline_weekly.length === 0)).toBe(true);
  });

  it("players[]: the focus players first-class, the best available per position, capped; positions filter", async () => {
    const out = await analyzeReplacement(rq({ focus_player_ids: [5, 999], max_players: 12 }));
    const ids = out.data.players.map((p) => p.player_id);
    expect(ids).toContain(5);
    expect(ids).not.toContain(999);
    expect(ids.length).toBeLessThanOrEqual(12 + REPLACEMENT.topAvailablePerPosition * 6);
    const qbOnly = await analyzeReplacement(rq({ positions: ["QB"] }));
    expect(qbOnly.data.positions.map((p) => p.position)).toEqual(["QB"]);
    expect(qbOnly.data.players.every((p) => p.position === "QB")).toBe(true);
    expect(qbOnly.data.format_notes.flex_split).toEqual({ rb: 2, wr: 0, te: 0 });
  });

  it("detail: compact keeps three weeks of each weekly array and no flex trace; full keeps all", async () => {
    const compact = await analyzeReplacement(rq());
    expect(compact.data.positions.every((p) => p.starter_baseline_weekly.length === 3)).toBe(true);
    expect(compact.data.positions.every((p) => p.flex_allocation_trace === undefined)).toBe(true);
    const full = await analyzeReplacement(rq({ detail: "full" }));
    expect(full.data.positions.every((p) => p.starter_baseline_weekly.length === 4)).toBe(true);
    expect(
      full.data.positions.find((p) => p.position === "RB")?.flex_allocation_trace,
    ).toHaveLength(2);
    // every decision number is the same at both levels
    expect(compact.data.players).toEqual(full.data.players);
    expect(compact.data.format_notes).toEqual(full.data.format_notes);
  });

  it("horizon week reads only the first week; baseline modes drop the other weekly array", async () => {
    const wk = await analyzeReplacement(rq({ horizon: "week", players: pool({ byeWeek: 6 }) }));
    expect(wk.data.positions[0]?.starter_baseline_weekly).toHaveLength(1);
    const starter = await analyzeReplacement(rq({ baseline: "starter" }));
    expect(starter.data.positions.every((p) => p.stream_baseline_weekly.length === 0)).toBe(true);
    const stream = await analyzeReplacement(rq({ baseline: "stream" }));
    expect(stream.data.positions.every((p) => p.starter_baseline_weekly.length === 0)).toBe(true);
  });

  it("a ROS Dist shifts by the baselines; without one the VOR spread comes from the position CV", async () => {
    const players = pool().map((p) => (p.player_id === 1 ? { ...p, ros: dist(100, 0.3) } : p));
    const out = await analyzeReplacement(rq({ players }));
    const p1 = out.data.players.find((p) => p.player_id === 1);
    expect(p1?.vor_ros.mean).toBeCloseTo(100 - 4 * 23, 4);
    expect((p1?.vor_ros.p90 ?? 0) - (p1?.vor_ros.p10 ?? 0)).toBeCloseTo(
      2 * 1.2815515655446004 * 30,
      1,
    );
  });

  it("a week without a projection counts at the player's per-game value; a first-week bye reads 0 − stream", async () => {
    const players = pool().map((p) =>
      p.player_id === 1
        ? {
            ...p,
            weeks: [
              { mean: 25, bye: true },
              null,
              { mean: 25, bye: false },
              { mean: 25, bye: false },
            ],
          }
        : p,
    );
    const out = await analyzeReplacement(rq({ players, focus_player_ids: [1], detail: "full" }));
    const qb = out.data.positions.find((p) => p.position === "QB");
    const base = new Map(qb?.starter_baseline_weekly.map((x) => [x.week, x.points]));
    const p1 = out.data.players.find((p) => p.player_id === 1);
    const expected =
      0 -
      (base.get(5) ?? 0) +
      (25 - (base.get(6) ?? 0)) +
      (25 - (base.get(7) ?? 0)) +
      (25 - (base.get(8) ?? 0));
    expect(p1?.vor_ros.mean).toBeCloseTo(expected, 6);
    expect(p1?.vor_weekly).toBeCloseTo(0 - 18, 6);
  });

  it("streamCandidates: the best available per position and week, ties to the lower id", () => {
    // ids: rostered QB 1–4, RB 5–11, WR 12–18, TE 19–21, K 22–24, D/ST 25–27; available from 28
    const c = streamCandidates(pool(), W, ["QB", "K"]);
    const tie = pool().map((p) =>
      p.player_id === 29 ? { ...p, weeks: W.map(() => ({ mean: 18, bye: false })) } : p,
    );
    expect(streamCandidates(tie, [5], ["QB"])).toEqual([
      { position: "QB", week: 5, player_id: 28, points: 18 },
    ]);
    expect(c.filter((x) => x.week === 5)).toEqual([
      { position: "QB", week: 5, player_id: 28, points: 18 },
      { position: "K", week: 5, player_id: 36, points: 7.8 },
    ]);
  });

  it("weekly allocations are cooperative: the CPU deadline returns partial with a warning", async () => {
    const out = await analyzeReplacement(
      rq({ pacer: steppingPacer(5), deadline_ms: 8, detail: "full" }),
    );
    expect(out.partial).toBe(true);
    expect(out.warnings.some((w) => w.startsWith("partial:"))).toBe(true);
    expect(out.data.positions[0]?.starter_baseline_weekly.length).toBeLessThan(W.length);
  });

  it("hostile inputs are refused or named, never a NaN", async () => {
    await expect(analyzeReplacement(rq({ league_size: 1 }))).rejects.toThrow(/league size/);
    await expect(analyzeReplacement(rq({ weeks: [] }))).rejects.toThrow(/weeks/);
    await expect(analyzeReplacement(rq({ weeks: [0, 1, 2, 3] }))).rejects.toThrow(/weeks/);
    await expect(analyzeReplacement(rq({ weeks: [5, 6] }))).rejects.toThrow(/horizon/);
    await expect(analyzeReplacement(rq({ max_players: 0 }))).rejects.toThrow(/max_players/);
    await expect(analyzeReplacement(rq({ positions: ["P"] }))).rejects.toThrow(/position/);
    const nan = pool().map((p, i) =>
      i === 0 ? { ...p, weeks: p.weeks.map(() => ({ mean: Number.NaN, bye: false })) } : p,
    );
    const out = await analyzeReplacement(
      rq({ players: [...nan, { ...nan[1]!, player_id: 777, weeks: W.map(() => null) }] }),
    );
    expect(out.warnings).toContain("2 players without a projection in the horizon left out");
    expect(JSON.stringify(out.data)).not.toMatch(/NaN|null,"xvbd":null/);
    const thin = await analyzeReplacement(
      rq({ players: pool().filter((p) => p.position !== "TE") }),
    );
    expect(thin.warnings.some((w) => w.includes("runs out before the baseline at TE"))).toBe(true);
  });
});
