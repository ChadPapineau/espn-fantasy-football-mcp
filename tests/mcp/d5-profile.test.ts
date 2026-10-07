// d5-profile.test.ts — D5's pbp team profile (plan 07 D5; plan 10 §3.2): `teamProfileOf` turns the
// store's defence-week rows (PbpReader.teamProfile) into window rates — pace per game, pass rate,
// PROE weighted by the plays that carry it, sack and takeaway rates, EPA allowed per dropback and per
// rush — null wherever a denominator is 0 or an EPA sum is missing, every rate inside [0, 1].
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PbpTeamProfileRow } from "../../src/domain/analytics/types.js";
import { teamProfileOf } from "../../src/mcp/tools/datasets-p1.js";

const row = (week: number, v: Partial<PbpTeamProfileRow> = {}): PbpTeamProfileRow => ({
  nfl_team: "DET",
  season: 2026,
  week,
  plays: 60,
  dropbacks: 36,
  sacks: 3,
  interceptions: 1,
  fumbles_lost: 1,
  epa_dropback_sum: -3.6,
  epa_rush_sum: 1.2,
  rushes: 24,
  pass_oe_mean: 2,
  pass_oe_n: 50,
  ...v,
});

describe("teamProfileOf", () => {
  it("window rates over two games", () => {
    const p = teamProfileOf([
      row(1),
      row(2, { plays: 70, dropbacks: 44, pass_oe_mean: -3, pass_oe_n: 50 }),
    ]);
    expect(p.pace_plays_per_game).toBe(65);
    expect(p.pass_rate).toBeCloseTo(80 / 130, 12);
    expect(p.proe).toBeCloseTo(-0.5, 12);
    expect(p.sack_rate).toBeCloseTo(6 / 80, 12);
    expect(p.takeaway_rate).toBeCloseTo(4 / 130, 12);
    expect(p.epa_allowed?.pass).toBeCloseTo(-7.2 / 80, 12);
    expect(p.epa_allowed?.rush).toBeCloseTo(2.4 / 48, 12);
  });

  it("no rows, zero denominators or a missing EPA sum read null, never NaN", () => {
    expect(teamProfileOf([])).toEqual({
      pace_plays_per_game: null,
      pass_rate: null,
      proe: null,
      sack_rate: null,
      takeaway_rate: null,
      epa_allowed: null,
    });
    const z = teamProfileOf([row(1, { plays: 0, dropbacks: 0, rushes: 0, pass_oe_n: 0 })]);
    expect([z.pass_rate, z.proe, z.sack_rate, z.takeaway_rate, z.epa_allowed]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(teamProfileOf([row(1), row(2, { epa_rush_sum: null })]).epa_allowed).toBeNull();
  });

  it("every rate stays in [0, 1] for any counts (property)", () => {
    const n = fc.integer({ min: 0, max: 200 });
    fc.assert(
      fc.property(fc.array(fc.tuple(n, n, n, n, n), { minLength: 1, maxLength: 6 }), (xs) => {
        const p = teamProfileOf(
          xs.map(([plays, dropbacks, sacks, ints, fum], i) =>
            row(i + 1, { plays, dropbacks, sacks, interceptions: ints, fumbles_lost: fum }),
          ),
        );
        for (const v of [p.pass_rate, p.sack_rate, p.takeaway_rate])
          if (v !== null) expect(v >= 0 && v <= 1).toBe(true);
      }),
    );
  });
});
