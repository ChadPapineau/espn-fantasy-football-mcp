// statline.test.ts — `toStatLine(nflverse)` in the store (plan 08 §3.2 column map, §3.3 position
// class; the D/ST line of READER_QUERIES["PlayerWeekReader.defenseLines"]): sums over present
// columns only (a NULL stat is absent, never 0), ESPN position ids, the D/ST family scalars, and
// properties over arbitrary rows (present = sorted keys, every value finite).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CANONICAL_NAME_RE } from "../../src/domain/scoring/types.js";
import {
  DEFENSE_STAT_MAP,
  defenseRowToStatLine,
  PLAYER_STAT_MAP,
  playerRowToStatLine,
  positionOf,
  sqlNum,
} from "../../src/store/datasets/statline.js";
import { DS_STATS_PLAYER_WEEK, DS_TEAM_DEFENSE_WEEK } from "../../src/store/datasets/tables.js";

describe("the column maps", () => {
  it("every canonical name is well-formed and every source column exists in the contract", () => {
    const playerCols = new Set(DS_STATS_PLAYER_WEEK.columns.map((c) => c.name));
    for (const [canonical, cols] of Object.entries(PLAYER_STAT_MAP)) {
      expect(canonical).toMatch(CANONICAL_NAME_RE);
      for (const c of cols) expect(playerCols.has(c), `${canonical} ← ${c}`).toBe(true);
    }
    const defCols = new Set(DS_TEAM_DEFENSE_WEEK.columns.map((c) => c.name));
    for (const [canonical, cols] of Object.entries(DEFENSE_STAT_MAP)) {
      expect(canonical).toMatch(CANONICAL_NAME_RE);
      expect(canonical.startsWith("dst_")).toBe(true);
      for (const c of cols) expect(defCols.has(c), `${canonical} ← ${c}`).toBe(true);
    }
  });
});

describe("positionOf (nflverse → ESPN position id and class)", () => {
  it("maps the fantasy positions and the IDP groups; position_group is the fallback", () => {
    expect(positionOf("QB", null)).toEqual([1, "O"]);
    expect(positionOf("FB", null)).toEqual([2, "O"]);
    expect(positionOf("WR", null)).toEqual([3, "O"]);
    expect(positionOf("TE", null)).toEqual([4, "O"]);
    expect(positionOf("K", null)).toEqual([5, "K"]);
    expect(positionOf("P", null)).toEqual([7, "K"]);
    expect(positionOf("OLB", null)).toEqual([11, "IDP"]);
    expect(positionOf("FS", null)).toEqual([13, "IDP"]);
    expect(positionOf("XYZ", "RB")).toEqual([2, "O"]);
    expect(positionOf("T", "OL")).toEqual([0, "O"]);
    expect(positionOf(null, null)).toEqual([0, "O"]);
    expect(positionOf("__proto__", "constructor")).toEqual([0, "O"]);
  });
});

describe("sqlNum", () => {
  it("finite numbers and bigints only", () => {
    expect(sqlNum(3)).toBe(3);
    expect(sqlNum(3n)).toBe(3);
    expect(sqlNum(Number.NaN)).toBeNull();
    expect(sqlNum(Number.POSITIVE_INFINITY)).toBeNull();
    expect(sqlNum("3")).toBeNull();
    expect(sqlNum(null)).toBeNull();
  });
});

describe("playerRowToStatLine", () => {
  it("sums the present columns; a NULL stat is absent (not 0); a present 0 is present", () => {
    const line = playerRowToStatLine({
      position: "RB",
      position_group: "RB",
      carries: 18,
      rushing_yards: 97,
      rushing_tds: 0,
      rushing_fumbles: 1,
      receiving_fumbles: null,
      sack_fumbles: null,
      rushing_fumbles_lost: null,
      targets: null,
    });
    expect(line.values).toEqual({ rush_att: 18, rush_yd: 97, rush_td: 0, fum: 1 });
    expect(line.present).toEqual(["fum", "rush_att", "rush_td", "rush_yd"]);
    expect(line.position).toBe(2);
    expect(line.position_class).toBe("O");
    expect(line.source).toBe("nflverse");
    expect(line.provisional).toBe(false);
  });

  it("FG buckets follow the league-bound partition", () => {
    const line = playerRowToStatLine({
      position: "K",
      fg_made_0_19: 1,
      fg_made_20_29: 2,
      fg_made_30_39: null,
      fg_made_40_49: 1,
      fg_made_60_: 1,
      fg_missed_50_59: 1,
    });
    expect(line.values).toMatchObject({ fg_0_39: 3, fg_40_49: 1, fg_60p: 1, fg_miss_50_59: 1 });
    expect(line.present).not.toContain("fg_50_59");
  });

  it("property: present is the sorted key list and every value is finite", () => {
    const cols = DS_STATS_PLAYER_WEEK.columns.filter((c) => c.type !== "TEXT").map((c) => c.name);
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...cols),
          fc.oneof(fc.integer({ min: -50, max: 600 }), fc.constant(null)),
        ),
        fc.constantFrom("QB", "RB", "WR", "TE", "K", "LB", "OT", null),
        (vals, pos) => {
          const line = playerRowToStatLine({ ...vals, position: pos });
          const keys = Object.keys(line.values).sort();
          return (
            JSON.stringify(keys) === JSON.stringify(line.present) &&
            Object.values(line.values).every((v) => Number.isFinite(v))
          );
        },
      ),
    );
  });
});

describe("defenseRowToStatLine", () => {
  it("D/ST class, position 16, points allowed and yards allowed as the family scalars", () => {
    const line = defenseRowToStatLine(
      {
        def_sacks: 2.5,
        def_interceptions: 1,
        def_fg_blocks: 1,
        def_punt_blocks: 1,
        opp_passing_yards: 210,
        opp_sack_yards_lost: 15,
        opp_rushing_yards: 95,
      },
      17,
    );
    expect(line.position).toBe(16);
    expect(line.position_class).toBe("DST");
    expect(line.values).toMatchObject({
      dst_sack: 2.5,
      dst_int: 1,
      dst_blk: 2,
      dst_pa_raw: 17,
      dst_ya_raw: 290,
    });
  });

  it("no points allowed (not final) and no opponent rows → those scalars are absent", () => {
    const line = defenseRowToStatLine(
      { def_sacks: 0, opp_passing_yards: null, opp_rushing_yards: 80 },
      null,
    );
    expect(line.present).toEqual(["dst_sack"]);
    // sack yards: the magnitude is subtracted whatever its sign; missing counts 0
    expect(
      defenseRowToStatLine(
        { opp_passing_yards: 210, opp_sack_yards_lost: -15, opp_rushing_yards: 95 },
        null,
      ).values.dst_ya_raw,
    ).toBe(290);
    expect(
      defenseRowToStatLine({ opp_passing_yards: 100, opp_rushing_yards: 50 }, 0).values,
    ).toEqual({
      dst_pa_raw: 0,
      dst_ya_raw: 150,
    });
  });
});
