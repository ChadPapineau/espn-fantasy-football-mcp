// types.test.ts — src/providers/espn/types.ts (research 03 §A.1 routes, §A.2 view whitelist and the
// do-nothing views, §B.2 slot ids ≠ position ids, D/ST negative ids, pro teams, enums with unknown
// tolerance, the five meaning-changing stat splits; plan 01 §4.3 upstream_type allow-list).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NFL_TEAMS, SEASON_MIN } from "../../../src/config/schema.js";
import { ESPN_TO_NFLVERSE_TEAM } from "../../../src/domain/crosswalk/types.js";
import { POSITION_CLASSES } from "../../../src/domain/scoring/types.js";
import {
  COMMUNICATION_VIEWS,
  ESPN_DST_PLAYER_ID_BASE,
  ESPN_DST_PLAYER_ID_MAX,
  ESPN_DST_PLAYER_ID_MIN,
  ESPN_FIRST_SEASON,
  ESPN_GAME,
  ESPN_POSITIONS,
  ESPN_PRO_TEAMS,
  ESPN_PRO_TEAM_ABBREVS,
  ESPN_SEGMENT,
  ESPN_SLOTS,
  ESPN_VIEWS,
  FILTER_IDS_MAX,
  FILTER_LIMIT_MAX,
  FILTER_OFFSET_MAX,
  KNOWN_UPSTREAM_TYPES,
  LEAGUE_SUB_PATHS,
  LEAGUE_VIEWS,
  PLAYOFF_SEEDING_RULES,
  POSITIONAL_RATING_POSITION_IDS,
  REFUSED_VIEWS,
  SEASON_PLAYER_VIEWS,
  SEASON_VIEWS,
  SLOT_BENCH,
  SLOT_FLEX,
  SLOT_IR,
  SOLO_VIEWS,
  STAT_SOURCE_IDS,
  STAT_SPLITS,
  STAT_SPLIT_TYPE_IDS,
  UPSTREAM_TYPE_FAMILY_RE,
  WAIVER_PROCESS_DAYS,
  isEspnView,
  isKnownValue,
  statSplitName,
  upstreamTypeOrUnknown,
} from "../../../src/providers/espn/types.js";

describe("routes and views", () => {
  it("game, segment, first season, sub-paths", () => {
    expect(ESPN_GAME).toBe("ffl");
    expect(ESPN_SEGMENT).toBe(0);
    expect(ESPN_FIRST_SEASON).toBe(SEASON_MIN);
    expect(LEAGUE_SUB_PATHS).toEqual(["", "communication/"]);
  });
  it("the whitelist is the union of the route families, without duplicates", () => {
    expect(ESPN_VIEWS).toEqual([
      ...LEAGUE_VIEWS,
      ...COMMUNICATION_VIEWS,
      ...SEASON_VIEWS,
      ...SEASON_PLAYER_VIEWS,
    ]);
    expect(new Set(ESPN_VIEWS).size).toBe(ESPN_VIEWS.length);
    expect(Object.isFrozen(ESPN_VIEWS)).toBe(true);
  });
  it("no refused view is whitelisted (do-nothing views, mStatus's IP, allon, the message board)", () => {
    for (const v of REFUSED_VIEWS) expect(isEspnView(v), v).toBe(false);
    for (const v of [
      "mStatus",
      "allon",
      "kona_league_messageboard",
      "mLiveScoring",
      "mRosterSettings",
    ])
      expect(REFUSED_VIEWS).toContain(v);
  });
  it("isEspnView is exact (case, whitespace, prototype keys)", () => {
    for (const v of ESPN_VIEWS) expect(isEspnView(v)).toBe(true);
    for (const v of [
      "",
      "mroster",
      "mRoster ",
      " mRoster",
      "mRoster,mTeam",
      "toString",
      "__proto__",
      "constructor",
    ])
      expect(isEspnView(v), JSON.stringify(v)).toBe(false);
  });
  it("mRoster is always requested alone", () => {
    expect(SOLO_VIEWS).toEqual(["mRoster"]);
  });
  it("filter bounds", () => {
    expect(FILTER_LIMIT_MAX).toBe(100);
    expect(FILTER_OFFSET_MAX).toBe(5000);
    expect(FILTER_IDS_MAX).toBe(50);
  });
});

describe("slot ids and position ids are different numberings (research 03 §B.2 trap)", () => {
  it("id 1 is the TQB slot but the QB position; id 16 is the D/ST slot and the D/ST position", () => {
    expect(ESPN_SLOTS[1]?.name).toBe("TQB");
    expect(ESPN_POSITIONS[1]?.name).toBe("QB");
    expect(ESPN_SLOTS[0]?.name).toBe("QB");
    expect(ESPN_POSITIONS[0]).toBeUndefined();
    expect(ESPN_SLOTS[2]?.name).toBe("RB");
    expect(ESPN_POSITIONS[2]?.name).toBe("RB");
    expect(ESPN_SLOTS[4]?.name).toBe("WR");
    expect(ESPN_POSITIONS[4]?.name).toBe("TE");
    expect(ESPN_SLOTS[17]?.name).toBe("K");
    expect(ESPN_POSITIONS[5]?.name).toBe("K");
  });
  it("slot table: ids 0..25 keyed by their own id, eligible lists only known position ids", () => {
    expect(Object.keys(ESPN_SLOTS).map(Number)).toEqual(Array.from({ length: 26 }, (_, i) => i));
    for (const [k, s] of Object.entries(ESPN_SLOTS)) {
      expect(s.id).toBe(Number(k));
      for (const p of s.eligible)
        expect(ESPN_POSITIONS[p], `slot ${k} eligible ${String(p)}`).toBeDefined();
      expect(Object.isFrozen(s)).toBe(true);
      expect(Object.isFrozen(s.eligible)).toBe(true);
    }
  });
  it("bench, IR and FLEX", () => {
    expect([SLOT_BENCH, SLOT_IR, SLOT_FLEX]).toEqual([20, 21, 23]);
    expect(ESPN_SLOTS[SLOT_BENCH]?.class).toBe("bench");
    expect(ESPN_SLOTS[SLOT_IR]?.class).toBe("ir");
    expect(ESPN_SLOTS[SLOT_FLEX]?.eligible).toEqual([2, 3, 4]);
  });
  it("position table: classes are scoring classes; P is classed K [A]", () => {
    for (const [k, p] of Object.entries(ESPN_POSITIONS)) {
      expect(p.id).toBe(Number(k));
      expect(POSITION_CLASSES).toContain(p.class);
    }
    expect(ESPN_POSITIONS[7]).toMatchObject({ name: "P", class: "K" });
    expect(ESPN_POSITIONS[16]).toMatchObject({ name: "D/ST", class: "DST" });
    expect(POSITIONAL_RATING_POSITION_IDS).toEqual([1, 2, 3, 4, 5, 16]);
  });
});

describe("pro teams and D/ST ids", () => {
  it("32 NFL teams plus FA; abbreviations map onto nflverse", () => {
    expect(ESPN_PRO_TEAMS[0]).toBe("FA");
    expect(ESPN_PRO_TEAM_ABBREVS).toHaveLength(32);
    expect(ESPN_PRO_TEAM_ABBREVS).not.toContain("FA");
    expect(ESPN_PRO_TEAMS[31]).toBeUndefined();
    expect(ESPN_PRO_TEAMS[32]).toBeUndefined();
    const nfl = ESPN_PRO_TEAM_ABBREVS.map((a) => ESPN_TO_NFLVERSE_TEAM[a] ?? a).sort();
    expect(nfl).toEqual([...NFL_TEAMS].sort());
  });
  it("D/ST ids are −(16000 + proTeamId) and every pro team's fits the bound", () => {
    expect(ESPN_DST_PLAYER_ID_BASE).toBe(-16000);
    for (const id of Object.keys(ESPN_PRO_TEAMS)
      .map(Number)
      .filter((i) => i > 0)) {
      const dst = ESPN_DST_PLAYER_ID_BASE - id;
      expect(dst).toBeGreaterThanOrEqual(ESPN_DST_PLAYER_ID_MIN);
      expect(dst).toBeLessThanOrEqual(ESPN_DST_PLAYER_ID_MAX);
    }
  });
});

describe("enums with unknown tolerance", () => {
  it("isKnownValue is exact and never coerces", () => {
    expect(isKnownValue(PLAYOFF_SEEDING_RULES, "TOTAL_POINTS_SCORED")).toBe(true);
    expect(isKnownValue(PLAYOFF_SEEDING_RULES, "total_points_scored")).toBe(false);
    expect(isKnownValue(PLAYOFF_SEEDING_RULES, "NEW_RULE")).toBe(false);
    expect(isKnownValue(WAIVER_PROCESS_DAYS, "WEDNESDAY")).toBe(true);
  });
});

describe("stat splits (meaning-changing)", () => {
  it("names the five combinations", () => {
    expect(statSplitName(0, 1)).toBe("weekly_actual");
    expect(statSplitName(1, 1)).toBe("weekly_projection");
    expect(statSplitName(0, 0)).toBe("season_actual");
    expect(statSplitName(1, 0)).toBe("ros_projection");
    expect(statSplitName(1, 2)).toBe("preseason_projection");
  });
  it("every other combination is drift (null)", () => {
    expect(statSplitName(0, 2)).toBeNull();
    for (const [s, t] of [
      [2, 1],
      [0, 3],
      [-1, 0],
      [Number.NaN, 1],
      [1, 1.5],
    ] as const)
      expect(statSplitName(s, t), `${String(s)},${String(t)}`).toBeNull();
  });
  it("property: a non-null name round-trips to its pair; ids stay within the known sets", () => {
    fc.assert(
      fc.property(fc.integer({ min: -2, max: 4 }), fc.integer({ min: -2, max: 4 }), (s, t) => {
        const name = statSplitName(s, t);
        if (name === null) return true;
        return (
          STAT_SPLITS[name].source_id === s &&
          STAT_SPLITS[name].split_type === t &&
          (STAT_SOURCE_IDS as readonly number[]).includes(s) &&
          (STAT_SPLIT_TYPE_IDS as readonly number[]).includes(t)
        );
      }),
    );
  });
});

describe("upstreamTypeOrUnknown (the only upstream strings that may surface)", () => {
  it("passes known types and the AUTH_/TRAN_ families", () => {
    for (const t of KNOWN_UPSTREAM_TYPES) expect(upstreamTypeOrUnknown(t)).toBe(t);
    expect(upstreamTypeOrUnknown("AUTH_SOMETHING_NEW")).toBe("AUTH_SOMETHING_NEW");
    expect(upstreamTypeOrUnknown("TRAN_X2")).toBe("TRAN_X2");
  });
  it.each([
    undefined,
    null,
    42,
    {},
    "",
    "auth_lower",
    "AUTH_",
    "AUTH_X",
    `AUTH_${"A".repeat(61)}`,
    "OTHER_FAMILY",
    "AUTH_BAD CHARS",
    "AUTH_X\nTRAN_Y",
    "<script>",
  ])("%j → UNKNOWN", (v) => {
    expect(upstreamTypeOrUnknown(v)).toBe("UNKNOWN");
  });
  it("the family grammar is anchored", () => {
    expect(UPSTREAM_TYPE_FAMILY_RE.test("xAUTH_OK")).toBe(false);
    expect(UPSTREAM_TYPE_FAMILY_RE.test("AUTH_OK ")).toBe(false);
  });
});
