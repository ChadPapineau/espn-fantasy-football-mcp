// usage-signals.test.ts — E5's usage-first detection (plan 07 E5 P1; plan 10 B3 hard parts; sib
// research 05 §4.1): each signal fires on its threshold and only then, a one-game spike or a jump
// inside a teammate's absence is not a role change, and — the B3 property — every signal cites a
// finite NUMBER as evidence for any input whatsoever. The detector's input has no ownership field, so
// `percent_change` cannot become a signal (the type test pins it). Synthetic data only.
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  detectSignals,
  hasNumericEvidence,
  usageWeekOf,
  type SignalInput,
  type UsageWeek,
} from "../../../src/domain/analytics/usageSignals.js";
import { SIGNALS } from "../../../src/domain/analytics/marketConstants.js";
import type { UsageGameRow } from "../../../src/domain/analytics/types.js";

const wk = (
  week: number,
  snap: number | null,
  tgt: number | null = null,
  rz: number | null = null,
  xfp: number | null = null,
  points: number | null = null,
): UsageWeek => ({ week, snap_pct: snap, target_share: tgt, rz_share: rz, xfp, points });

const kinds = (input: SignalInput): string[] => detectSignals(input).map((s) => s.kind);

describe("detectSignals — each signal on its threshold", () => {
  it("a snap-share jump of ≥ 15 points held two straight games fires snap_jump", () => {
    const games = [wk(1, 0.3), wk(2, 0.32), wk(3, 0.28), wk(4, 0.5), wk(5, 0.55)];
    const s = detectSignals({ position: "RB", games });
    const snap = s.find((x) => x.kind === "snap_jump");
    expect(snap).toBeDefined();
    expect(snap?.value).toBeCloseTo(0.525 - 0.3, 3);
    expect(snap?.evidence).toBe(0.55);
  });
  it("a one-game spike, or a jump held below the threshold, does not fire", () => {
    expect(
      kinds({
        position: "RB",
        games: [wk(1, 0.3), wk(2, 0.3), wk(3, 0.3), wk(4, 0.3), wk(5, 0.7)],
      }),
    ).not.toContain("snap_jump");
    expect(
      kinds({
        position: "RB",
        games: [wk(1, 0.3), wk(2, 0.3), wk(3, 0.3), wk(4, 0.44), wk(5, 0.44)],
      }),
    ).not.toContain("snap_jump");
  });
  it("a jump whose hold window lies inside a teammate's absence is not a role change", () => {
    const games = [wk(1, 0.3), wk(2, 0.3), wk(3, 0.3), wk(4, 0.6), wk(5, 0.6)];
    expect(kinds({ position: "RB", games, teammate_absent_weeks: [4, 5] })).not.toContain(
      "snap_jump",
    );
    // one hold week outside the absence: the role held after the teammate returned
    expect(kinds({ position: "RB", games, teammate_absent_weeks: [4] })).toContain("snap_jump");
  });
  it("target share, red-zone share, xFP gap", () => {
    const games = [
      wk(1, 0.7, 0.12, 0.05, 10, 9),
      wk(2, 0.7, 0.13, 0.05, 10, 4),
      wk(3, 0.7, 0.12, 0.06, 12, 6),
      wk(4, 0.72, 0.2, 0.2, 14, 7),
      wk(5, 0.71, 0.21, 0.22, 15, 8),
    ];
    const s = detectSignals({ position: "WR", games });
    expect(s.map((x) => x.kind)).toEqual(["target_share_jump", "xfp_gap", "rz_shift"]);
    const xfp = s.find((x) => x.kind === "xfp_gap");
    expect(xfp?.value).toBeCloseTo((12 + 14 + 15 - (6 + 7 + 8)) / 3, 3);
    expect(xfp?.evidence).toBe(41);
  });
  it("an xFP gap below 2 points a game, or a window short of three games, does not fire", () => {
    const small = [
      wk(1, 0.7, 0.2, null, 10, 9),
      wk(2, 0.7, 0.2, null, 10, 9),
      wk(3, 0.7, 0.2, null, 10, 9),
    ];
    expect(kinds({ position: "WR", games: small })).not.toContain("xfp_gap");
    const short = [
      wk(1, 0.7, 0.2, null, 20, 1),
      wk(2, 0.7, 0.2, null, 20, 1),
      wk(3, 0.7, 0.2, null, null, null),
    ];
    expect(kinds({ position: "WR", games: short })).not.toContain("xfp_gap");
  });
  it("depth chart, implied total and the cascade, before any usage history", () => {
    const s = detectSignals({
      position: "RB",
      games: [],
      depth: { rank_now: 1, rank_before: 2 },
      implied: { this_week: 27, season_mean: 22 },
      cascade: { inherited_share: 0.31, vacated_share: 0.62 },
    });
    expect(s).toEqual([
      { kind: "injury_cascade", value: 0.31, evidence: 0.62 },
      { kind: "depth_chart", value: 1, evidence: 1 },
      { kind: "implied_total", value: 5, evidence: 27 },
    ]);
  });
  it("no depth signal for a demotion or an unknown rank; no implied-total signal below 2.5 points", () => {
    expect(
      detectSignals({ position: "WR", games: [], depth: { rank_now: 2, rank_before: 1 } }),
    ).toEqual([]);
    expect(
      detectSignals({ position: "WR", games: [], depth: { rank_now: 1, rank_before: null } }),
    ).toEqual([]);
    expect(
      detectSignals({ position: "WR", games: [], implied: { this_week: 24, season_mean: 22 } }),
    ).toEqual([]);
    expect(
      detectSignals({
        position: "WR",
        games: [],
        cascade: { inherited_share: 0, vacated_share: 0.4 },
      }),
    ).toEqual([]);
  });
  it("fewer than three games: no usage signal at all; duplicate weeks collapse", () => {
    expect(kinds({ position: "RB", games: [wk(1, 0.1), wk(2, 0.9)] })).toEqual([]);
    const dup = [wk(1, 0.3), wk(1, 0.3), wk(2, 0.3), wk(3, 0.6), wk(4, 0.6)];
    expect(kinds({ position: "RB", games: dup })).toContain("snap_jump");
  });
  it("a null in the hold window or too few baseline games never guesses", () => {
    expect(
      kinds({ position: "RB", games: [wk(1, 0.3), wk(2, 0.3), wk(3, 0.6), wk(4, null)] }),
    ).toEqual([]);
    expect(
      kinds({ position: "RB", games: [wk(1, null), wk(2, 0.3), wk(3, 0.6), wk(4, 0.6)] }),
    ).toEqual([]);
  });
});

describe("plan 10 B3 hard: every signal cites a numeric evidence; percent_change is not an input", () => {
  const share = fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null });
  const pts = fc.option(fc.double({ min: -5, max: 40, noNaN: true }), { nil: null });
  const game = fc.record({
    week: fc.integer({ min: 1, max: 18 }),
    snap_pct: share,
    target_share: share,
    rz_share: share,
    xfp: pts,
    points: pts,
  });
  const input = fc.record({
    position: fc.constantFrom("QB", "RB", "WR", "TE", "K", "D/ST"),
    games: fc.array(game, { maxLength: 12 }),
    depth: fc.option(
      fc.record({
        rank_now: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
        rank_before: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
      }),
      { nil: null },
    ),
    implied: fc.option(
      fc.record({
        this_week: fc.option(fc.double({ min: 0, max: 45, noNaN: true }), { nil: null }),
        season_mean: fc.option(fc.double({ min: 0, max: 45, noNaN: true }), { nil: null }),
      }),
      { nil: null },
    ),
    cascade: fc.option(
      fc.record({
        inherited_share: fc.double({ min: -1, max: 1, noNaN: true }),
        vacated_share: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      { nil: null },
    ),
    teammate_absent_weeks: fc.array(fc.integer({ min: 1, max: 18 }), { maxLength: 4 }),
  });
  it("for any input, every signal's value and evidence are finite numbers and each kind appears once", () => {
    fc.assert(
      fc.property(input, (i) => {
        const s = detectSignals(i);
        expect(s.every(hasNumericEvidence)).toBe(true);
        expect(new Set(s.map((x) => x.kind)).size).toBe(s.length);
        expect(s.some((x) => x.kind === "stream")).toBe(false);
      }),
      { numRuns: 400 },
    );
  });
  it("the detector's input type carries no ownership or trend field", () => {
    expectTypeOf<SignalInput>().not.toHaveProperty("percent_change");
    expectTypeOf<SignalInput>().not.toHaveProperty("percent_owned");
    expectTypeOf<SignalInput>().not.toHaveProperty("sleeper_trend");
  });
  it("hasNumericEvidence refuses text or missing evidence", () => {
    expect(hasNumericEvidence({ kind: "stream", value: 3 })).toBe(false);
    expect(hasNumericEvidence({ kind: "stream", value: Number.NaN, evidence: 2 })).toBe(false);
    expect(
      hasNumericEvidence({ kind: "stream", value: 1, evidence: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });
});

describe("usageWeekOf — a D1 row", () => {
  const row: UsageGameRow = {
    week: 3,
    opponent: "T1",
    snaps: 40,
    snap_pct: 0.62,
    routes_proxy: 0.62,
    targets: 7,
    target_share: 0.2,
    air_yards: 60,
    air_yards_share: 0.25,
    adot: 8.5,
    wopr: 0.47,
    racr: 1.1,
    carries: 2,
    carry_share: 0.08,
    rz_targets: 2,
    rz_carries: 1,
    gl_carries: 0,
    xfp_ep: 13.1,
    points_league: 9.4,
    xfp_gap: 3.7,
  };
  it("maps shares, xFP and points; the red-zone share against the team's red-zone opportunities", () => {
    expect(usageWeekOf(row, 10)).toEqual({
      week: 3,
      snap_pct: 0.62,
      target_share: 0.2,
      rz_share: 0.3,
      xfp: 13.1,
      points: 9.4,
    });
    expect(usageWeekOf(row, null).rz_share).toBeNull();
    expect(usageWeekOf(row, 0).rz_share).toBeNull();
    expect(usageWeekOf({ ...row, rz_targets: null, rz_carries: null }, 10).rz_share).toBeNull();
    expect(usageWeekOf({ ...row, rz_targets: 30 }, 10).rz_share).toBe(1);
  });
  it("the thresholds are the plan's (15 points held two games)", () => {
    expect(SIGNALS.snapJump).toBe(0.15);
    expect(SIGNALS.holdGames).toBe(2);
  });
});
