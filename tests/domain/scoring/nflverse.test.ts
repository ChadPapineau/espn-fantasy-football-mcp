// nflverse.test.ts — src/domain/scoring/nflverse.ts (plan 08 §3.2 toStatLine(nflverse), U-6 points
// allowed, E8 conventions; A-1 column names asserted against the dataset contract).
import { describe, expect, it } from "vitest";
import {
  coerceScalar,
  espnPositionForNflverse,
  parseKickList,
  pointsAllowed,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
} from "../../../src/domain/scoring/nflverse.js";
import { score } from "../../../src/domain/scoring/engine.js";
import {
  DS_TEAM_DEFENSE_WEEK,
  PLAYER_WEEK_STAT_COLUMNS,
} from "../../../src/store/datasets/tables.js";
import { item, settingsOf } from "./helpers.js";

describe("coerceScalar (reader values → stat or NOT PRESENT)", () => {
  it.each([
    [5, 5],
    [-0, 0],
    [10n, 10],
    [" 12.5 ", 12.5],
    ["-3", -3],
    [".5", 0.5],
  ])("%s → %s", (raw, v) => {
    expect(Object.is(coerceScalar(raw), v)).toBe(true);
  });
  it.each([
    null,
    undefined,
    "",
    "1e2",
    "0x10",
    "NaN",
    "Infinity",
    "١٢",
    "1".repeat(40),
    Number.NaN,
    2e9,
    2n ** 60n,
    {},
    true,
  ])("%s → null (absent, never 0)", (raw) => {
    expect(coerceScalar(raw)).toBeNull();
  });
});

describe("espnPositionForNflverse", () => {
  it.each([
    ["QB", 1],
    ["rb", 2],
    ["FB", 2],
    [" WR ", 3],
    ["TE", 4],
    ["K", 5],
    ["P", 7],
    ["DE", 10],
    ["CB", 12],
    ["SAF", 13],
  ])("%s → %s", (p, id) => {
    expect(espnPositionForNflverse(p)).toBe(id);
  });
  it.each(["LS", "OL", "", "CONSTRUCTOR", "__proto__", null, 5])("%j → null", (p) => {
    expect(espnPositionForNflverse(p)).toBeNull();
  });
});

describe("parseKickList", () => {
  it("parses ;-separated integer distances; null and blank are no kicks", () => {
    expect(parseKickList("51;43")).toEqual([51, 43]);
    expect(parseKickList(null)).toEqual([]);
    expect(parseKickList(undefined)).toEqual([]);
    expect(parseKickList("  ")).toEqual([]);
  });
  it.each(["51;x", "51;;43", "121", "-3", "45.5", "1e2"])("refuses %j", (list) => {
    expect(() => parseKickList(list)).toThrow(expect.objectContaining({ code: "invalid_line" }));
  });
  it("refuses a non-string or an absurd length", () => {
    expect(() => parseKickList(51)).toThrow(/short string/);
    expect(() => parseKickList("40;".repeat(200))).toThrow(/short string/);
  });
});

describe("statLineFromPlayerWeek", () => {
  const qb = {
    position: "QB",
    attempts: 35,
    completions: 24,
    passing_yards: 312,
    passing_tds: 2,
    passing_interceptions: 1,
    sacks_suffered: 3,
    passing_2pt_conversions: 1,
    rushing_2pt_conversions: null,
    sack_fumbles: 1,
    sack_fumbles_lost: 1,
    rushing_fumbles: 0,
    rushing_fumbles_lost: 0,
    carries: 4,
    rushing_yards: -2,
    special_teams_tds: 0,
    fumble_recovery_tds: 0,
    fumble_recovery_own: 0,
  };
  it("maps the contract columns to canonical names; null is absent", () => {
    const l = statLineFromPlayerWeek(qb);
    expect(l.values).toMatchObject({
      pass_att: 35,
      pass_cmp: 24,
      pass_inc: 11,
      pass_yd: 312,
      pass_ypg: 312,
      pass_td: 2,
      pass_int: 1,
      sacked: 3,
      pass_2pt: 1,
      two_pt_total: 1,
      fum: 1,
      fum_lost: 1,
      turnovers: 2,
      rush_att: 4,
      rush_yd: -2,
      ret_td_total: 0,
      kr_td: 0,
      pr_td: 0,
      fum_rec_td_off: 0,
      gp: 1,
    });
    expect(l.values).not.toHaveProperty("rush_2pt");
    expect(l.values).not.toHaveProperty("rec");
    expect(l).toMatchObject({
      position: 1,
      position_class: "O",
      provisional: false,
      source: "nflverse",
    });
    expect(l.present).toEqual([...l.present].sort());
  });
  it("derives incompletions only when both columns exist; return TDs > 0 leave the split absent", () => {
    const l = statLineFromPlayerWeek({
      position: "WR",
      attempts: 1,
      receptions: 5,
      special_teams_tds: 1,
      fumble_recovery_tds: 1,
      fumble_recovery_own: 2,
    });
    expect(l.values).not.toHaveProperty("pass_inc");
    expect(l.values).not.toHaveProperty("kr_td");
    expect(l.values).toMatchObject({ rec: 5, rec_stat: 5, ret_td_total: 1, fum_rec_td_off: 1 });
    expect(
      statLineFromPlayerWeek({ position: "WR", fumble_recovery_tds: 1, fumble_recovery_own: 0 })
        .values.fum_rec_td_off,
    ).toBe(0);
  });
  it("takes the crosswalked ESPN position over the row's, and labels provisional/source", () => {
    const l = statLineFromPlayerWeek(
      { position: "CB", receptions: 3 },
      { position: 3, provisional: true, source: "nflverse:test" },
    );
    expect(l).toMatchObject({
      position: 3,
      position_class: "O",
      provisional: true,
      source: "nflverse:test",
    });
  });
  it("refuses a row with no fantasy position", () => {
    expect(() => statLineFromPlayerWeek({ position: "LS" })).toThrow(/no fantasy position/);
  });
  it("bins kicks from the lists into ESPN's buckets, blocked counted as missed (recorded)", () => {
    const l = statLineFromPlayerWeek({
      position: "K",
      fg_att: 5,
      fg_made: 3,
      fg_made_list: "52;38;61",
      fg_missed_list: "45",
      fg_blocked_list: "33",
      pat_att: 3,
      pat_made: 2,
      pat_missed: 0,
      pat_blocked: 1,
    });
    expect(l.values).toMatchObject({
      fg_0_39: 1,
      fg_40_49: 0,
      fg_50_59: 1,
      fg_60p: 1,
      fg_50p: 2,
      fg_miss_0_39: 1,
      fg_miss_40_49: 1,
      fg_att_0_39: 2,
      fg_att_50p: 2,
      fg_made_total: 3,
      fg_miss_total: 2,
      fg_att_total: 5,
      fg_yd: 151,
      fg_yd_miss: 78,
      fg_yd_att: 229,
      pat_att: 3,
      pat_made: 2,
      pat_miss: 1,
    });
  });
  it("a non-kicker row has no FG or PAT stats at all", () => {
    const l = statLineFromPlayerWeek({ position: "RB", carries: 3 });
    expect(Object.keys(l.values).some((k) => k.startsWith("fg_") || k.startsWith("pat_"))).toBe(
      false,
    );
  });
  it("reads only dataset-contract columns (A-1, src/store/datasets/tables.ts)", () => {
    const touched = (
      columns: readonly string[],
      extra: Record<string, unknown>,
      run: (row: Record<string, unknown>) => unknown,
    ) => {
      const seen = new Set<string>();
      const target: Record<string, unknown> = {
        ...Object.fromEntries(columns.map((c) => [c, 1])),
        ...extra,
      };
      const proxy = new Proxy(target, {
        get: (t, k, r): unknown => {
          seen.add(String(k));
          return Reflect.get(t, k, r) as unknown;
        },
        getOwnPropertyDescriptor: (t, k) => (
          seen.add(String(k)),
          Reflect.getOwnPropertyDescriptor(t, k)
        ),
      });
      run(proxy);
      return [...seen];
    };
    const pw = PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name);
    const lists = {
      fg_made_list: "40",
      fg_missed_list: null,
      fg_blocked_list: null,
      position: "K",
    };
    for (const c of touched(pw, lists, (r) => statLineFromPlayerWeek(r)))
      expect([...pw, "position"], c).toContain(c);
    const td = DS_TEAM_DEFENSE_WEEK.columns.map((c) => c.name);
    for (const c of touched(td, {}, (r) => statLineFromTeamDefense(r, { pointsAllowed: null })))
      expect(td, c).toContain(c);
  });
});

describe("pointsAllowed (U-6, settled on the recorded fixtures)", () => {
  it("nets the opponent defence's INT/fumble-return TDs and safeties, floored at 0", () => {
    expect(pointsAllowed({ score: 27, opponent_int_tds: 1, opponent_safeties: 1 })).toBe(19);
    expect(pointsAllowed({ score: 6, opponent_fumble_tds: 1 })).toBe(0);
    expect(pointsAllowed({ score: 3, opponent_int_tds: 1 })).toBe(0);
    expect(pointsAllowed({ score: 27, opponent_int_tds: 1 }, "final_score")).toBe(27);
    expect(pointsAllowed({ score: 17 })).toBe(17);
  });
  it.each([
    { score: -1 },
    { score: Number.NaN },
    { score: 10, opponent_int_tds: -1 },
    { score: 10, opponent_safeties: Number.POSITIVE_INFINITY },
  ])("refuses %j", (input) => {
    expect(() => pointsAllowed(input)).toThrow(expect.objectContaining({ code: "invalid_line" }));
  });
});

describe("statLineFromTeamDefense", () => {
  const row = {
    def_sacks: 3.5,
    def_interceptions: 2,
    def_fumbles_forced: 1,
    fumble_recovery_opp: 1,
    def_tds: 1,
    fumble_recovery_tds_opp: 0,
    special_teams_tds: 0,
    def_safeties: 0,
    def_fg_blocks: 0,
    def_punt_blocks: 1,
    def_pat_blocks: 1,
    kickoff_return_yards: 80,
    punt_return_yards: 12,
    opp_passing_yards: 250,
    opp_sack_yards_lost: -21,
    opp_rushing_yards: 90,
  };
  it("maps the team-defence row; yards allowed net of |sack yards| (recorded, 70/70)", () => {
    const l = statLineFromTeamDefense(row, { pointsAllowed: { score: 20, opponent_int_tds: 0 } });
    expect(l.values).toEqual({
      dst_sack: 3.5,
      dst_int: 2,
      dst_ff: 1,
      dst_fr: 1,
      dst_int_td: 1,
      dst_fr_td: 0,
      dst_td: 1,
      dst_safety: 0,
      dst_blk: 2,
      kr_yd: 80,
      pr_yd: 12,
      ret_td_total: 1,
      kr_td: 0,
      pr_td: 0,
      dst_blk_td: 0,
      dst_pa_raw: 20,
      dst_ya_raw: 319,
      gp: 1,
    });
    expect(l).toMatchObject({ position: 16, position_class: "DST", source: "nflverse" });
    expect(
      statLineFromTeamDefense({ ...row, opp_sack_yards_lost: 21 }, { pointsAllowed: null }).values
        .dst_ya_raw,
    ).toBe(319);
  });
  it("leaves points / yards allowed absent without a final score or opponent yardage", () => {
    const l = statLineFromTeamDefense(
      { ...row, opp_rushing_yards: null, special_teams_tds: 1, opp_sack_yards_lost: null },
      { pointsAllowed: null },
    );
    expect(l.values).not.toHaveProperty("dst_pa_raw");
    expect(l.values).not.toHaveProperty("dst_ya_raw");
    expect(l.values).not.toHaveProperty("kr_td");
    expect(
      statLineFromTeamDefense({ ...row, opp_sack_yards_lost: null }, { pointsAllowed: null }).values
        .dst_ya_raw,
    ).toBe(340);
  });
  it("uses the requested points-allowed definition", () => {
    const l = statLineFromTeamDefense(row, {
      pointsAllowed: { score: 27, opponent_int_tds: 1 },
      definition: "final_score",
    });
    expect(l.values.dst_pa_raw).toBe(27);
  });
  it("scores under a league's tiers through the engine (bracketized)", () => {
    const s = settingsOf([
      item(92, 0, { "16": 1 }),
      item(130, 0, { "16": 2 }),
      item(131, 0, { "16": 0 }),
      item(99, 0, { "16": 1 }),
    ]);
    const l = statLineFromTeamDefense(row, { pointsAllowed: { score: 14 } });
    expect(score(l, s).points).toBe(1 + 0 + 3.5);
  });
});
