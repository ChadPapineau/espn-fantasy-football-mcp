// xfp.test.ts — xFP on the league's scoring basis (src/domain/analytics/xfp.ts; plan 08 §5; plan 07 D1
// `xfp_ep` / `xfp_gap` and E5's `xfp_gap` signal; sib research 05 §4.1 item 4). Stage C finding
// analytics-xfp-gap-scoring-basis: ffopportunity's own total is full PPR with a 4-pt passing TD —
// shown on every recorded excerpt row — so it was never comparable with a half-PPR, 5-pt-pass-TD
// league's points. Re-scored under the league's S the expectation moves by exactly the format, and a
// player who plays to expectation shows no gap: the finding's WR and QB, and a property over any line
// and any of the formats. Fixtures and synthetic lines only; no network.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EP_EXPECTED_COLUMNS,
  epExpectedOf,
  expectedLineOf,
  leagueXfp,
  xfpOf,
} from "../../../src/domain/analytics/xfp.js";
import type { EpExpected } from "../../../src/domain/analytics/types.js";
import { score } from "../../../src/domain/scoring/engine.js";
import {
  espnPositionForNflverse,
  statLineFromPlayerWeek,
} from "../../../src/domain/scoring/nflverse.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import { EP_WEEKLY_COLUMNS } from "../../../src/store/datasets/tables.js";
import { REFERENCE_SCORING_SETTINGS } from "../scoring/helpers.js";
import { p2Rows } from "../../sources/nflverse/helpers/phase2-fixtures.js";

/** The reference S (the owner's format: half-PPR, 5-pt pass TD, INT −2, fumble lost −2) with items reset. */
function variant(points: ReadonlyMap<number, number>): ScoringSettings {
  return normalizeSettings({
    ...REFERENCE_SCORING_SETTINGS,
    scoringItems: REFERENCE_SCORING_SETTINGS.scoringItems.map((i) => {
      const p = points.get(i.statId);
      return p === undefined ? i : { ...i, points: p };
    }),
  });
}
const OWNER = variant(new Map());
/** ffopportunity's own scoring: full PPR (item 53 → 1), a 4-pt passing TD (item 4 → 4). */
const FFO = variant(
  new Map([
    [53, 1],
    [4, 4],
  ]),
);
/** A standard non-PPR league with a 6-pt passing TD. */
const STANDARD6 = variant(
  new Map([
    [53, 0],
    [4, 6],
  ]),
);

const recorded = (): Record<string, unknown>[] =>
  [2024, 2025, 2026]
    .flatMap((s) => p2Rows(`ffopportunity:ep_weekly@${String(s)}`))
    .filter((r) => typeof r.player_id === "string" && r.player_id !== "");

const num = (r: Record<string, unknown>, k: string): number => {
  const v = r[k];
  return typeof v === "number" ? v : Number.NaN;
};

describe("ffopportunity's components (xfp.ts epExpectedOf)", () => {
  it("every column read is one the store keeps verbatim (tables.ts EP_WEEKLY_COLUMNS)", () => {
    const kept = new Set(EP_WEEKLY_COLUMNS.map((c) => c.name));
    for (const col of Object.values(EP_EXPECTED_COLUMNS)) expect(kept.has(col), col).toBe(true);
    expect(Object.keys(EP_EXPECTED_COLUMNS)).toHaveLength(18);
  });

  it("every recorded player row reads whole; a missing, non-numeric or absurd cell gives null", () => {
    const rows = recorded();
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) expect(epExpectedOf((c) => r[c])).not.toBeNull();
    const r0 = rows[0] ?? {};
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "3", 1e6]) {
      expect(epExpectedOf((c) => (c === "receptions_exp" ? bad : r0[c]))).toBeNull();
    }
    expect(leagueXfp(null, OWNER, 3)).toBeNull();
    expect(leagueXfp(undefined, OWNER, 3)).toBeNull();
  });
});

describe("the scoring basis (Stage C analytics-xfp-gap-scoring-basis)", () => {
  it("ffopportunity's own total is full PPR with a 4-pt passing TD: its components scored so reproduce it on every recorded row", () => {
    for (const r of recorded()) {
      const pos = espnPositionForNflverse(r.position);
      expect(pos, String(r.position)).not.toBeNull();
      const ours = leagueXfp(
        epExpectedOf((c) => r[c]),
        FFO,
        pos ?? 0,
      );
      // the cells are rounded to 2 dp; ffopportunity weighs an expected rushing 2-pt conversion a
      // little above 2 points (recorded: 2.2–2.5×), unexplained — both bounded here
      const slack = 0.06 + 0.5 * num(r, "rush_two_point_conv_exp");
      expect(
        Math.abs((ours ?? Number.NaN) - num(r, "total_fantasy_points_exp")),
      ).toBeLessThanOrEqual(slack);
    }
  });

  it("under the owner's S the expectation moves by exactly the format: −½ a point per expected catch, +1 per expected passing TD", () => {
    for (const r of recorded()) {
      const x = epExpectedOf((c) => r[c]);
      const pos = espnPositionForNflverse(r.position) ?? 0;
      const owner = leagueXfp(x, OWNER, pos) ?? Number.NaN;
      const ffo = leagueXfp(x, FFO, pos) ?? Number.NaN;
      expect(owner - ffo).toBeCloseTo(
        -0.5 * num(r, "receptions_exp") + num(r, "pass_touchdown_exp"),
        3,
      );
    }
  });

  // The finding's two repros, as D1 and E5 now see them (xfp_ep, xfp_gap = xfpOf)
  const exact = (c: Partial<EpExpected>): EpExpected => ({
    pass_att: 0,
    pass_cmp: 0,
    pass_yd: 0,
    pass_td: 0,
    pass_int: 0,
    pass_2pt: 0,
    pass_1d: 0,
    rush_att: 0,
    rush_yd: 0,
    rush_td: 0,
    rush_2pt: 0,
    rush_1d: 0,
    targets: 0,
    rec: 0,
    rec_yd: 0,
    rec_td: 0,
    rec_2pt: 0,
    rec_1d: 0,
    ...c,
  });

  it("the finding's WR — 4 catches, 40 yards, a TD, exactly his expectation: xFP 12 against 12, no gap", () => {
    const wr = exact({ targets: 6, rec: 4, rec_yd: 40, rec_td: 1, rec_1d: 3 });
    expect(leagueXfp(wr, FFO, 3)).toBe(14); // ffopportunity's own number: full PPR
    // the league's points for the same line: 4 × ½ + 40 × 0.1 + 6
    expect(xfpOf({ expected: wr }, OWNER, 3, 12)).toEqual({ xfp_ep: 12, xfp_gap: 0 });
  });

  it("the finding's QB — 250 yards and 2 TDs, exactly his expectation: xFP 20 against 20, no 'touchdown luck'", () => {
    const qb = exact({ pass_att: 34, pass_cmp: 22, pass_yd: 250, pass_td: 2, pass_1d: 12 });
    expect(leagueXfp(qb, FFO, 1)).toBe(18); // 250 × 0.04 + 2 × 4
    expect(xfpOf({ expected: qb }, OWNER, 1, 20)).toEqual({ xfp_ep: 20, xfp_gap: 0 });
  });

  it("no expected components or no S: both sides null, never ffopportunity's own total", () => {
    expect(xfpOf(undefined, OWNER, 3, 12)).toEqual({ xfp_ep: null, xfp_gap: null });
    expect(xfpOf({ expected: null }, OWNER, 3, 12)).toEqual({ xfp_ep: null, xfp_gap: null });
    expect(xfpOf({}, OWNER, 3, 12)).toEqual({ xfp_ep: null, xfp_gap: null });
    const wr = exact({ targets: 6, rec: 4, rec_yd: 40 });
    expect(xfpOf({ expected: wr }, null, 3, 12)).toEqual({ xfp_ep: null, xfp_gap: null });
    expect(xfpOf({ expected: wr }, OWNER, 3, null)).toEqual({ xfp_ep: 6, xfp_gap: null });
    // an id the engine refuses
    expect(leagueXfp(wr, OWNER, 100)).toBeNull();
  });

  it("property: a player whose game equals his expectation shows no gap, under every format", () => {
    const n = (max: number) => fc.integer({ min: 0, max });
    fc.assert(
      fc.property(
        fc.record({
          pass_att: n(50),
          pass_cmp: n(50),
          pass_yd: n(450),
          pass_td: n(5),
          pass_int: n(3),
          pass_2pt: n(1),
          pass_1d: n(25),
          rush_att: n(30),
          rush_yd: n(220),
          rush_td: n(3),
          rush_2pt: n(1),
          rush_1d: n(12),
          targets: n(15),
          rec: n(14),
          rec_yd: n(220),
          rec_td: n(3),
          rec_2pt: n(1),
          rec_1d: n(10),
        }),
        fc.constantFrom("QB", "RB", "WR", "TE"),
        fc.constantFrom(OWNER, FFO, STANDARD6),
        (c, position, settings) => {
          const x: EpExpected = {
            ...c,
            pass_cmp: Math.min(c.pass_cmp, c.pass_att),
            rec: Math.min(c.rec, c.targets),
          };
          // the same game as nflverse reports it (no fumble, sack, return or TD length to differ)
          const actual = statLineFromPlayerWeek({
            position,
            attempts: x.pass_att,
            completions: x.pass_cmp,
            passing_yards: x.pass_yd,
            passing_tds: x.pass_td,
            passing_interceptions: x.pass_int,
            passing_2pt_conversions: x.pass_2pt,
            passing_first_downs: x.pass_1d,
            sacks_suffered: 0,
            carries: x.rush_att,
            rushing_yards: x.rush_yd,
            rushing_tds: x.rush_td,
            rushing_2pt_conversions: x.rush_2pt,
            rushing_first_downs: x.rush_1d,
            targets: x.targets,
            receptions: x.rec,
            receiving_yards: x.rec_yd,
            receiving_tds: x.rec_td,
            receiving_2pt_conversions: x.rec_2pt,
            receiving_first_downs: x.rec_1d,
            sack_fumbles: 0,
            sack_fumbles_lost: 0,
            rushing_fumbles: 0,
            rushing_fumbles_lost: 0,
            receiving_fumbles: 0,
            receiving_fumbles_lost: 0,
            special_teams_tds: 0,
            fumble_recovery_tds: 0,
          });
          const pos = espnPositionForNflverse(position) ?? 0;
          const points = score(actual, settings).points;
          const pair = xfpOf({ expected: x }, settings, pos, points);
          return pair.xfp_gap !== null && Math.abs(pair.xfp_gap) < 1e-6;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the expected line carries the translator's keys for what ffopportunity models, and nothing it does not", () => {
    const line = expectedLineOf(exact({ pass_att: 30, pass_cmp: 20, targets: 2, rec: 1 }), 1);
    expect(line.values.pass_inc).toBe(10);
    expect(line.values.gp).toBe(1);
    for (const k of ["fum", "fum_lost", "sacked", "kr_td", "pr_td", "ret_td_total"])
      expect(line.values[k], k).toBeUndefined();
    expect(line.source.startsWith("projection:")).toBe(true);
  });
});
