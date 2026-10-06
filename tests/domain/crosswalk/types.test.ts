// types.test.ts — src/domain/crosswalk/types.ts constants (plan 05 §2 `domain/crosswalk`: ESPN WSH/LAR
// → nflverse WAS/LA, positions 1–5, D/ST and HC never matched; plan 06 §1.3 alert threshold 1, ≥ 1 %
// owned; plan 07 C1 methods).
import { describe, expect, it } from "vitest";
import { NFL_TEAMS, isNflTeam } from "../../../src/config/schema.js";
import {
  CROSSWALK_METHODS,
  ESPN_POSITION_TO_NFLVERSE,
  ESPN_TO_NFLVERSE_TEAM,
  LAST_SEEN_GRANULARITY_MS,
  TEAM_UNIT_POSITIONS,
  TOP_OWNED_PERCENT,
  UNMATCHED_ALERT_THRESHOLD,
} from "../../../src/domain/crosswalk/types.js";
import { ESPN_POSITIONS, ESPN_PRO_TEAM_ABBREVS } from "../../../src/providers/espn/types.js";

describe("crosswalk constants", () => {
  it("methods are plan 07 C1's four", () => {
    expect(CROSSWALK_METHODS).toEqual(["id", "match", "override", "none"]);
    expect(Object.isFrozen(CROSSWALK_METHODS)).toBe(true);
  });
  it("every ESPN pro-team abbreviation maps onto an nflverse team (WSH→WAS, LAR→LA, rest identical)", () => {
    expect(ESPN_TO_NFLVERSE_TEAM).toEqual({ WSH: "WAS", LAR: "LA" });
    const mapped = ESPN_PRO_TEAM_ABBREVS.map((a) => ESPN_TO_NFLVERSE_TEAM[a] ?? a);
    for (const t of mapped) expect(isNflTeam(t), t).toBe(true);
    expect(new Set(mapped).size).toBe(32);
    expect([...mapped].sort()).toEqual([...NFL_TEAMS].sort());
  });
  it("the matcher's positions are ESPN position ids with the same display name", () => {
    for (const [id, name] of Object.entries(ESPN_POSITION_TO_NFLVERSE))
      expect(ESPN_POSITIONS[Number(id)]?.name, id).toBe(name);
  });
  it("team units are never matched", () => {
    expect(TEAM_UNIT_POSITIONS).toEqual(["D/ST", "HC"]);
    for (const p of TEAM_UNIT_POSITIONS)
      expect(Object.values(ESPN_POSITION_TO_NFLVERSE)).not.toContain(p);
  });
  it("thresholds", () => {
    expect(UNMATCHED_ALERT_THRESHOLD).toBe(1);
    expect(TOP_OWNED_PERCENT).toBe(1);
    expect(LAST_SEEN_GRANULARITY_MS).toBe(7 * 86_400_000);
  });
});
