// rz-share.test.ts — the red-zone share D1's trailing summary, E7's cascade and E5's rz_shift signal
// read (plan 07 D1, E5, E7; tables.ts PbpReader.playerUsage mapping): Σ(the player's RZ targets +
// carries) ÷ Σ(his team's), over the weeks the pbp file covers — null when it covers none, clamped
// to [0, 1]; and E5's usage week reads the same share from a game row's `rz_team`.
import { describe, expect, it } from "vitest";
import { usageWeekOf } from "../../src/domain/analytics/phase2.js";
import type { UsageGameRow } from "../../src/domain/analytics/types.js";
import { rzShareOf } from "../../src/mcp/tools/p1-common.js";

const g = (week: number, v: Partial<UsageGameRow> = {}): UsageGameRow => ({
  week,
  opponent: "MIA",
  snaps: 40,
  snap_pct: 0.6,
  routes_proxy: 20,
  targets: 6,
  target_share: 0.2,
  air_yards: 60,
  air_yards_share: 0.2,
  adot: 10,
  wopr: 0.4,
  racr: 1,
  carries: 2,
  carry_share: 0.1,
  rz_targets: 1,
  rz_carries: 1,
  gl_carries: 0,
  rz_team: 10,
  xfp_ep: 12,
  points_league: 11,
  xfp_gap: 1,
  ...v,
});

describe("rzShareOf", () => {
  it("sums over the covered weeks only", () => {
    expect(rzShareOf([g(1), g(2, { rz_targets: 3, rz_carries: 0, rz_team: 5 })])).toBeCloseTo(
      5 / 15,
      12,
    );
    // an uncovered week (rz_team null / absent / 0) is left out of both sums
    expect(rzShareOf([g(1), g(2, { rz_team: null }), g(3, { rz_team: 0 })])).toBeCloseTo(0.2, 12);
    const { rz_team: _drop, ...noTeam } = g(4);
    expect(rzShareOf([noTeam])).toBeNull();
    expect(rzShareOf([])).toBeNull();
  });

  it("clamps a share above 1 (a team count lower than the player's) and treats null counts as 0", () => {
    expect(rzShareOf([g(1, { rz_targets: 9, rz_carries: 9, rz_team: 4 })])).toBe(1);
    expect(rzShareOf([g(1, { rz_targets: null, rz_carries: null })])).toBe(0);
  });

  it("E5's usage week reads the same share from rz_team", () => {
    expect(usageWeekOf(g(1), g(1).rz_team ?? null).rz_share).toBeCloseTo(0.2, 12);
    expect(usageWeekOf(g(1), null).rz_share).toBeNull();
  });
});
