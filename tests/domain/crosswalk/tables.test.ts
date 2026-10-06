// tables.test.ts — src/domain/crosswalk/{teams,positions,ids}.ts: the one team table (research 04 §C:
// ESPN WSH/LAR → WAS/LA; plan 05 §2 "an unknown abbreviation fails loudly"), ESPN pro-team ids, the
// position families (ids 1–5), and the ESPN id grammar — each domain copy held equal to the provider's
// table it mirrors (the domain may not import the provider, plan 01 §1.1). Ported from sibling @8db206f.
import { describe, expect, it } from "vitest";
import { NFL_TEAMS, isNflTeam } from "../../../src/config/schema.js";
import {
  ESPN_PERSON_ID_MAX,
  TEAM_UNIT_ID_BASES,
  cleanEspnId,
  isPersonId,
  teamUnitPositionOf,
  teamUnitProTeamId,
} from "../../../src/domain/crosswalk/ids.js";
import {
  POSITION_FAMILIES,
  espnPositionFamily,
  positionFamily,
  samePositionFamily,
} from "../../../src/domain/crosswalk/positions.js";
import {
  ESPN_FREE_AGENT_ABBREV,
  ESPN_FREE_AGENT_PRO_TEAM_ID,
  ESPN_PRO_TEAM_ID_TO_NFLVERSE,
  TEAM_ALIASES,
  knownTeamSpellings,
  normalizeTeam,
  readEspnTeam,
  requireNflTeam,
  teamOfProTeamId,
} from "../../../src/domain/crosswalk/teams.js";
import {
  ESPN_POSITION_TO_NFLVERSE,
  ESPN_TO_NFLVERSE_TEAM,
  TEAM_UNIT_POSITION_IDS,
} from "../../../src/domain/crosswalk/types.js";
import {
  ESPN_PERSON_PLAYER_ID_MAX,
  ESPN_POSITIONS,
  ESPN_PRO_TEAMS,
  ESPN_TEAM_UNIT_ID_RANGES,
  isEspnPlayerIdValue,
  teamUnitProTeamId as providerTeamUnitProTeamId,
} from "../../../src/providers/espn/types.js";
import { espnAbbrevToNflverse } from "../../../src/store/datasets/derive.js";
import { FIXTURE } from "./helpers.js";

describe("normalizeTeam", () => {
  it("maps every nflverse abbreviation to itself, in any case", () => {
    for (const t of NFL_TEAMS) {
      expect(normalizeTeam(t)).toBe(t);
      expect(normalizeTeam(t.toLowerCase())).toBe(t);
    }
  });

  it.each([
    ["WSH", "WAS"],
    ["wsh", "WAS"],
    ["LAR", "LA"],
    ["LA", "LA"],
    ["LAC", "LAC"],
    ["JAC", "JAX"],
    ["LVR", "LV"],
    ["OAK", "LV"],
    ["STL", "LA"],
    ["SD", "LAC"],
    ["SDG", "LAC"],
    ["WFT", "WAS"],
    ["NOS", "NO"],
    ["GNB", "GB"],
    ["KAN", "KC"],
    ["NWE", "NE"],
    ["SFO", "SF"],
    ["TAM", "TB"],
    ["ARZ", "ARI"],
    ["BLT", "BAL"],
    ["CLV", "CLE"],
    ["HST", "HOU"],
    [" Det ", "DET"],
  ])("%j → %s", (abbr, want) => {
    expect(normalizeTeam(abbr)).toBe(want);
  });

  it("the trap pairs stay apart: LA is the Rams, LAC the Chargers; WAS/WSH one team", () => {
    expect(normalizeTeam("LAR")).toBe(normalizeTeam("LA"));
    expect(normalizeTeam("LAR")).not.toBe(normalizeTeam("LAC"));
    expect(normalizeTeam("WSH")).toBe(normalizeTeam("WAS"));
    expect(normalizeTeam("NYG")).not.toBe(normalizeTeam("NYJ"));
  });

  it("covers every ESPN spelling the same way derive.ts does, and the contract's two", () => {
    for (const [id, abbr] of Object.entries(ESPN_PRO_TEAMS)) {
      if (abbr === "FA") continue;
      expect(normalizeTeam(abbr), abbr).toBe(espnAbbrevToNflverse(abbr));
      expect(teamOfProTeamId(Number(id)), id).toBe(espnAbbrevToNflverse(abbr));
    }
    for (const [espn, nfl] of Object.entries(ESPN_TO_NFLVERSE_TEAM)) {
      expect(TEAM_ALIASES[espn]).toBe(nfl);
    }
  });

  it("covers every team spelling of the fixture roster (both sides)", () => {
    for (const p of [...FIXTURE.players, ...FIXTURE.team_units]) {
      expect(normalizeTeam(p.team)).toBe(p.team);
      if (p.espn_team !== "FA") expect(normalizeTeam(p.espn_team)).toBe(p.team);
    }
  });

  it.each([
    "XYZ",
    "FA",
    "",
    "J",
    "JAXX1",
    "L.V.",
    "N0",
    "ＪＡＸ",
    "JAX​",
    "__proto__",
    "constructor",
    "toString",
  ])("returns null for unknown or malformed %j", (abbr) => {
    expect(normalizeTeam(abbr)).toBeNull();
  });

  it("returns null for non-strings", () => {
    expect(normalizeTeam(null)).toBeNull();
    expect(normalizeTeam(undefined)).toBeNull();
    expect(normalizeTeam(7)).toBeNull();
  });

  it("every alias targets a real nflverse team, and no alias shadows one", () => {
    for (const [alias, team] of Object.entries(TEAM_ALIASES)) {
      expect(isNflTeam(team)).toBe(true);
      expect(isNflTeam(alias)).toBe(false);
    }
    expect(knownTeamSpellings()).toHaveLength(NFL_TEAMS.length + Object.keys(TEAM_ALIASES).length);
  });
});

describe("requireNflTeam (the loud failure)", () => {
  it("returns the team for a known spelling", () => {
    expect(requireNflTeam("WSH")).toBe("WAS");
  });

  it("throws RangeError naming a well-formed unknown code", () => {
    expect(() => requireNflTeam("XYZ")).toThrow(
      new RangeError("crosswalk: unknown team abbreviation 'XYZ'"),
    );
  });

  it("throws without echoing malformed input", () => {
    expect(() => requireNflTeam("<script>")).toThrow(
      new RangeError("crosswalk: unknown team abbreviation"),
    );
    expect(() => requireNflTeam(null)).toThrow(RangeError);
  });
});

describe("ESPN pro-team ids", () => {
  it("is ESPN_PRO_TEAMS (minus FA) through the contract's spelling map — 32 distinct teams", () => {
    const expected = Object.fromEntries(
      Object.entries(ESPN_PRO_TEAMS)
        .filter(([id]) => id !== String(ESPN_FREE_AGENT_PRO_TEAM_ID))
        .map(([id, abbr]) => [id, ESPN_TO_NFLVERSE_TEAM[abbr] ?? abbr]),
    );
    expect(ESPN_PRO_TEAM_ID_TO_NFLVERSE).toEqual(expected);
    expect(new Set(Object.values(ESPN_PRO_TEAM_ID_TO_NFLVERSE)).size).toBe(32);
    expect(ESPN_PRO_TEAMS[ESPN_FREE_AGENT_PRO_TEAM_ID]).toBe(ESPN_FREE_AGENT_ABBREV);
  });

  it("free agent, unused, fractional and non-number ids have no team", () => {
    expect(teamOfProTeamId(0)).toBeNull();
    expect(teamOfProTeamId(31)).toBeNull();
    expect(teamOfProTeamId(32)).toBeNull();
    expect(teamOfProTeamId(1.5)).toBeNull();
    expect(teamOfProTeamId("1")).toBeNull();
    expect(teamOfProTeamId(Number.NaN)).toBeNull();
  });
});

describe("readEspnTeam", () => {
  it.each([
    [14, "LAR", { kind: "team", team: "LA" }],
    [28, "WSH", { kind: "team", team: "WAS" }],
    [28, null, { kind: "team", team: "WAS" }],
    [null, "LAR", { kind: "team", team: "LA" }],
    [undefined, "wsh", { kind: "team", team: "WAS" }],
    [0, "FA", { kind: "none" }],
    [0, null, { kind: "none" }],
    [null, "FA", { kind: "none" }],
    [null, null, { kind: "none" }],
    [null, "  ", { kind: "none" }],
    [14, "LAC", { kind: "conflict" }],
    [0, "BUF", { kind: "conflict" }],
    [2, "FA", { kind: "conflict" }],
    [31, null, { kind: "unknown" }],
    [2, "XYZ", { kind: "unknown" }],
    [null, "XYZ", { kind: "unknown" }],
    [1.5, "ATL", { kind: "unknown" }],
    ["2", null, { kind: "unknown" }],
    [null, 7, { kind: "unknown" }],
  ] as const)("(%j, %j) → %j", (id, abbr, want) => {
    expect(readEspnTeam(id, abbr)).toEqual(want);
  });
});

describe("position families", () => {
  it.each([
    ["FB", "RB"],
    ["HB", "RB"],
    ["rb", "RB"],
    ["PK", "K"],
    ["K", "K"],
    ["QB", "QB"],
    ["TE", "TE"],
    [" wr ", "WR"],
  ])("%s is in family %s", (pos, fam) => {
    expect(positionFamily(pos)).toBe(fam);
  });

  it("keeps skill positions apart", () => {
    expect(samePositionFamily("WR", "TE")).toBe(false);
    expect(samePositionFamily("QB", "RB")).toBe(false);
    expect(samePositionFamily("RB", "FB")).toBe(true);
    expect(samePositionFamily("K", "P")).toBe(false);
  });

  it("unknown or malformed positions never match anything, not even themselves", () => {
    for (const p of ["LB", "D/ST", "DEF", "TQB", "W/R/T", "BN", "__proto__", "WRWRWRWRWR", null]) {
      expect(positionFamily(p)).toBeNull();
    }
    expect(samePositionFamily("LB", "LB")).toBe(false);
  });

  it("every family is itself a position of that family", () => {
    for (const fam of new Set(Object.values(POSITION_FAMILIES)))
      expect(positionFamily(fam)).toBe(fam);
  });

  it("ESPN position ids 1–5 map onto the families; every other id has none", () => {
    for (const [id, name] of Object.entries(ESPN_POSITION_TO_NFLVERSE)) {
      expect(espnPositionFamily(Number(id))).toBe(name);
      expect(positionFamily(ESPN_POSITIONS[Number(id)]?.name)).toBe(name);
    }
    for (const id of [0, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 99, -1, 1.5]) {
      expect(espnPositionFamily(id)).toBeNull();
    }
    expect(espnPositionFamily("1")).toBeNull();
  });

  it("covers every fixture player's nflverse position", () => {
    for (const p of FIXTURE.players) {
      expect(positionFamily(p.position)).toBe(p.position);
      expect(espnPositionFamily(p.espn_position_id)).toBe(p.position);
    }
  });
});

describe("ESPN ids", () => {
  it("the person-id bound equals the provider's", () => {
    expect(ESPN_PERSON_ID_MAX).toBe(ESPN_PERSON_PLAYER_ID_MAX);
    expect(isPersonId(1)).toBe(true);
    expect(isPersonId(ESPN_PERSON_ID_MAX)).toBe(true);
    for (const bad of [0, -1, ESPN_PERSON_ID_MAX + 1, 1.5, Number.NaN, "1", null]) {
      expect(isPersonId(bad)).toBe(false);
    }
  });

  it("the team-unit bases equal the provider's ranges, and so do the derived pro-team ids", () => {
    expect([...TEAM_UNIT_POSITION_IDS].sort()).toEqual(
      ESPN_TEAM_UNIT_ID_RANGES.map((r) => Number(r.position_id)).sort(),
    );
    for (const r of ESPN_TEAM_UNIT_ID_RANGES) {
      expect(TEAM_UNIT_ID_BASES[r.position_id]).toBe(r.base);
      for (const id of [r.min, r.max, r.base - 21, r.min - 1, r.max + 1]) {
        const inRange = id >= r.min && id <= r.max;
        expect(teamUnitPositionOf(id) === r.position_id, String(id)).toBe(inRange);
        if (inRange) expect(teamUnitProTeamId(id)).toBe(providerTeamUnitProTeamId(id));
      }
    }
  });

  it("every fixture team unit's id encodes its pro team", () => {
    for (const u of FIXTURE.team_units) {
      expect(teamUnitPositionOf(u.espn_id)).toBe(u.espn_position_id);
      expect(teamUnitProTeamId(u.espn_id)).toBe(u.espn_pro_team_id);
    }
  });

  it("persons and malformed ids are not team units", () => {
    for (const id of [1, 3918298, 0, -1, -13999, -17000, 1.5, Number.NaN, "-16001"]) {
      expect(teamUnitPositionOf(id)).toBeNull();
      expect(teamUnitProTeamId(id)).toBeNull();
    }
  });

  it("accepts exactly what the provider accepts as a player id value (persons + units)", () => {
    for (const id of [
      1, 99_999_999, 100_000_000, 0, -16001, -16999, -17000, -15024, -14001, -13999,
    ]) {
      expect(isPersonId(id) || teamUnitPositionOf(id) !== null, String(id)).toBe(
        isEspnPlayerIdValue(id),
      );
    }
  });

  it.each([
    [3918298, 3918298],
    ["3918298", 3918298],
    [" 3918298 ", 3918298],
    ["99999999", 99_999_999],
    ["100000000", null],
    ["0", null],
    ["03918298", null],
    ["3918298.0", null],
    ["3.9e6", null],
    ["", null],
    ["NA", null],
    [0, null],
    [-16021, null],
    [1.5, null],
    [null, null],
    ["1".repeat(13), null],
  ])("cleanEspnId(%j) → %j", (raw, want) => {
    expect(cleanEspnId(raw)).toBe(want);
  });
});
