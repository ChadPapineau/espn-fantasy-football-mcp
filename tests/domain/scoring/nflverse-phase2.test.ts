// nflverse-phase2.test.ts — src/domain/scoring/nflverse.ts, Phase 2 (plan 10 B13; plan 08 §4.3 long
// TDs from ds_pbp, §3.2 U-6 points allowed from ds_stats_team_week / ds_pbp rows): hand-built rows,
// adversarial by default (malformed ids and plays, inherited keys, impossible counts), fast-check on
// the long-TD counts. The recorded-evidence half is tests/golden/nflverse-phase2.test.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { score } from "../../../src/domain/scoring/engine.js";
import {
  defenseScoresFromPlays,
  DST_POINTS_ALLOWED_EVIDENCE,
  LONG_TD_CANONICALS,
  longTdCounts,
  MAX_PLAYS,
  type NflverseRow,
  pointsAllowed,
  pointsAllowedFromTeamWeek,
  statLineFromPlayerWeek,
  yardsAllowedFromTeamWeek,
} from "../../../src/domain/scoring/nflverse.js";
import { DS_PBP, DS_STATS_TEAM_WEEK } from "../../../src/store/datasets/tables.js";
import { item, settingsOf } from "./helpers.js";

const QB = "00-0000001";
const WR = "00-0000002";
const RB = "00-0000003";
const zeros = Object.fromEntries(LONG_TD_CANONICALS.map((c) => [c, 0]));
const passTd = (yards: unknown, passer = QB, scorer = WR): NflverseRow => ({
  pass_touchdown: 1,
  rush_touchdown: 0,
  yards_gained: yards,
  passer_player_id: passer,
  td_player_id: scorer,
});
const rushTd = (yards: unknown, scorer = RB): NflverseRow => ({
  pass_touchdown: 0,
  rush_touchdown: 1,
  yards_gained: yards,
  passer_player_id: null,
  td_player_id: scorer,
});

describe("the columns read are ds_pbp / ds_stats_team_week contract columns (plan 08 A-1)", () => {
  it.each([
    [
      DS_PBP,
      [
        "pass_touchdown",
        "rush_touchdown",
        "yards_gained",
        "passer_player_id",
        "td_player_id",
        "posteam",
        "defteam",
        "td_team",
        "touchdown",
        "interception",
        "safety",
        "play_type",
      ],
    ],
    [
      DS_STATS_TEAM_WEEK,
      [
        "team",
        "def_tds",
        "fumble_recovery_tds",
        "fumble_recovery_opp",
        "def_safeties",
        "passing_yards",
        "rushing_yards",
        "sack_yards_lost",
      ],
    ],
  ])("%s", (table, columns) => {
    const names = new Set(table.columns.map((c) => c.name));
    for (const c of columns) expect(names.has(c), c).toBe(true);
  });
});

describe("longTdCounts (plan 08 §4.3: a TD's length from ds_pbp yards_gained)", () => {
  it("names the six long-TD members in registry-scalar order", () => {
    expect(LONG_TD_CANONICALS).toEqual([
      "pass_td_40",
      "pass_td_50",
      "rec_td_40",
      "rec_td_50",
      "rush_td_40",
      "rush_td_50",
    ]);
  });
  it("a 45-yard pass TD counts 40+ for the passer and the receiver, not 50+", () => {
    const plays = [passTd(45)];
    expect(longTdCounts(plays, QB)).toEqual({ ...zeros, pass_td_40: 1 });
    expect(longTdCounts(plays, WR)).toEqual({ ...zeros, rec_td_40: 1 });
    expect(longTdCounts(plays, RB)).toEqual(zeros);
  });
  it("bounds are inclusive and cumulative: 39 → none, 40 → 40+, 50 → both, 62-yard rush → both", () => {
    expect(longTdCounts([passTd(39)], QB)).toEqual(zeros);
    expect(longTdCounts([passTd(40)], QB)).toEqual({ ...zeros, pass_td_40: 1 });
    expect(longTdCounts([passTd(50)], QB)).toEqual({ ...zeros, pass_td_40: 1, pass_td_50: 1 });
    expect(longTdCounts([rushTd(62)], RB)).toEqual({ ...zeros, rush_td_40: 1, rush_td_50: 1 });
    expect(longTdCounts([passTd(41), passTd(55), passTd(3)], QB)).toEqual({
      ...zeros,
      pass_td_40: 2,
      pass_td_50: 1,
    });
  });
  it("a player who threw and caught the same TD gets both roles", () => {
    expect(longTdCounts([passTd(44, QB, QB)], QB)).toEqual({
      ...zeros,
      pass_td_40: 1,
      rec_td_40: 1,
    });
  });
  it("reader values coerce: bigint, decimal strings", () => {
    const play = { ...passTd(60n), pass_touchdown: "1" };
    expect(longTdCounts([play], QB)).toEqual({ ...zeros, pass_td_40: 1, pass_td_50: 1 });
  });
  it("non-TD plays and other players' TDs never count — even with no length", () => {
    const plays = [
      { ...passTd(80), pass_touchdown: 0 },
      { ...rushTd(70), rush_touchdown: null },
      passTd(null, "00-0000009", "00-0000008"),
    ];
    expect(longTdCounts(plays, QB)).toEqual(zeros);
  });
  it.each([null, undefined, 40.5, "abc", "1e2", Number.NaN])(
    "one of the player's TDs with length %j → null (underivable, never a guess)",
    (yards) => {
      expect(longTdCounts([passTd(60), rushTd(yards, QB)], QB)).toBeNull();
    },
  );
  it("ids must match as strings: a numeric id, an empty or an oversized one never matches", () => {
    const plays: NflverseRow[] = [
      { ...passTd(60), passer_player_id: 1, td_player_id: "" },
      { ...passTd(60), passer_player_id: "x".repeat(33) },
    ];
    expect(longTdCounts(plays, QB)).toEqual(zeros);
  });
  it("inherited keys are never read (a play built on a polluted prototype counts nothing)", () => {
    const play = Object.create(passTd(70)) as NflverseRow;
    expect(longTdCounts([play], QB)).toEqual(zeros);
  });
  it.each<[unknown, string]>([
    ["", "empty"],
    ["x".repeat(33), "oversized"],
    [5, "a number"],
    [null, "null"],
  ])("refuses a gsis id that is %j (%s)", (id) => {
    expect(() => longTdCounts([], id as string)).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
  it.each([
    ["not an array", (): unknown => ({ length: 0 })],
    ["a null play", (): unknown => [null]],
    ["a scalar play", (): unknown => [5]],
    ["an array play", (): unknown => [[1]]],
    ["too many plays", (): unknown => new Array<NflverseRow>(MAX_PLAYS + 1).fill({})],
  ])("refuses %s", (_label, plays) => {
    expect(() => longTdCounts(plays() as NflverseRow[], QB)).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
  it("returns a frozen record", () => {
    expect(Object.isFrozen(longTdCounts([passTd(60)], QB))).toBe(true);
  });
  it("property: per role, 50+ ≤ 40+ ≤ the player's TDs of that kind", () => {
    const ids = fc.constantFrom(QB, WR, RB, "00-0000004");
    const play = fc.record({
      pass_touchdown: fc.constantFrom(0, 1),
      rush_touchdown: fc.constantFrom(0, 1),
      yards_gained: fc.integer({ min: -10, max: 99 }),
      passer_player_id: ids,
      td_player_id: ids,
    });
    fc.assert(
      fc.property(fc.array(play, { maxLength: 30 }), ids, (plays, id) => {
        const c = longTdCounts(plays, id)!;
        const tds = {
          pass_td: plays.filter((p) => p.pass_touchdown === 1 && p.passer_player_id === id).length,
          rec_td: plays.filter((p) => p.pass_touchdown === 1 && p.td_player_id === id).length,
          rush_td: plays.filter((p) => p.rush_touchdown === 1 && p.td_player_id === id).length,
        };
        for (const [scalar, n] of Object.entries(tds)) {
          const forty = c[`${scalar}_40`]!;
          const fifty = c[`${scalar}_50`]!;
          if (!(fifty <= forty && forty <= n)) return false;
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe("statLineFromPlayerWeek + long_tds (plan 08 §4.3: the gap Phase 2 closes)", () => {
  const s = settingsOf([item(4, 4), item(15, 1), item(16, 2), item(43, 6), item(45, 1)]);
  const row = { position: "QB", passing_tds: 2, receiving_tds: 0, rushing_tds: 0 };
  it("without pbp counts a long-TD league's line is underivable (Phase 1); with them it is complete", () => {
    const weekly = score(statLineFromPlayerWeek(row), s);
    expect(weekly.complete).toBe(false);
    expect(weekly.underivable).toEqual(["pass_td_40", "pass_td_50"]);
    expect(score(statLineFromPlayerWeek(row, { long_tds: null }), s).complete).toBe(false);
    const counts = longTdCounts([passTd(52), passTd(12)], QB)!;
    const r = score(statLineFromPlayerWeek(row, { long_tds: counts }), s);
    expect(r.complete).toBe(true);
    expect(r.underivable).toEqual([]);
    expect(r.points).toBe(2 * 4 + 1 + 2);
  });
  it("a partial count set is accepted (the rest stays absent)", () => {
    const line = statLineFromPlayerWeek(row, { long_tds: { pass_td_40: 1 } });
    expect(line.values.pass_td_40).toBe(1);
    expect(line.present).not.toContain("pass_td_50");
  });
  it("a row without the TD count still takes the counts (nothing to check them against)", () => {
    const line = statLineFromPlayerWeek(
      { position: "WR" },
      { long_tds: { rec_td_40: 1, rec_td_50: 1 } },
    );
    expect(line.values.rec_td_50).toBe(1);
  });
  it.each([
    ["an array", []],
    ["a string", "pass_td_40"],
    ["a non-long-TD stat", { pass_td: 1 }],
    ["a prototype name", JSON.parse('{"__proto__": 1}') as object],
    ["a negative count", { pass_td_40: -1 }],
    ["a fractional count", { pass_td_40: 0.5 }],
    ["an absurd count", { pass_td_40: 21 }],
    ["a string count", { pass_td_40: "1" }],
    ["a non-cumulative pair (50+ > 40+)", { pass_td_40: 0, pass_td_50: 1 }],
    ["more long TDs than TDs", { pass_td_40: 3 }],
  ])("refuses long_tds that is %s", (_label, long) => {
    expect(() =>
      statLineFromPlayerWeek(row, { long_tds: long as unknown as Record<string, number> }),
    ).toThrow(expect.objectContaining({ code: "invalid_line" }));
  });
});

const D = "DEN";
const O = "LA";
const play = (over: Partial<Record<string, unknown>>): NflverseRow => ({
  posteam: O,
  defteam: D,
  play_type: "pass",
  touchdown: 0,
  td_team: null,
  interception: 0,
  safety: 0,
  ...over,
});

describe("defenseScoresFromPlays (plan 08 §3.2 U-6: what ESPN nets)", () => {
  it("counts the defence's INT- and fumble-return TDs on scrimmage plays and every safety it scored", () => {
    const plays = [
      play({ touchdown: 1, td_team: D, interception: 1 }),
      play({ play_type: "run", touchdown: 1, td_team: D }),
      play({ play_type: "qb_kneel", touchdown: 1, td_team: D }),
      play({ play_type: "no_play", safety: 1 }),
      play({ play_type: "punt", safety: 1 }),
    ];
    expect(defenseScoresFromPlays(plays, D)).toEqual({
      int_return_tds: 1,
      fumble_return_tds: 2,
      safeties: 2,
    });
  });
  it("special-teams TDs, offensive TDs, the other team's scores and a TD without a play type are not netted", () => {
    const plays = [
      play({ play_type: "punt", touchdown: 1, td_team: D }),
      play({ posteam: D, defteam: O, play_type: "kickoff", touchdown: 1, td_team: D }),
      play({ play_type: "field_goal", touchdown: 1, td_team: D }),
      play({ play_type: "no_play", touchdown: 1, td_team: D }),
      play({ play_type: null, touchdown: 1, td_team: D }),
      play({ touchdown: 1, td_team: O }),
      play({ posteam: D, defteam: O, touchdown: 1, td_team: O, interception: 1 }),
      play({ posteam: D, defteam: O, safety: 1 }),
    ];
    expect(defenseScoresFromPlays(plays, D)).toEqual({
      int_return_tds: 0,
      fumble_return_tds: 0,
      safeties: 0,
    });
  });
  it.each([[""], [null], ["x".repeat(40)]])("refuses a defence team %j", (team) => {
    expect(() => defenseScoresFromPlays([], team!)).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
  it("refuses a malformed play list", () => {
    expect(() => defenseScoresFromPlays([null as unknown as NflverseRow], D)).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
});

describe("pointsAllowedFromTeamWeek / yardsAllowedFromTeamWeek (the opponent's ds_stats_team_week row)", () => {
  const opp = {
    team: D,
    def_tds: 1,
    fumble_recovery_tds: 1,
    fumble_recovery_opp: 2,
    def_safeties: 1,
    passing_yards: 274,
    rushing_yards: 124,
    sack_yards_lost: -17,
  };
  it("reads def_tds, min(fumble_recovery_tds, fumble_recovery_opp) and def_safeties", () => {
    const input = pointsAllowedFromTeamWeek(opp, 30);
    expect(input).toEqual({
      score: 30,
      opponent_int_tds: 1,
      opponent_fumble_tds: 1,
      opponent_safeties: 1,
    });
    expect(pointsAllowed(input!)).toBe(30 - 12 - 2);
    expect(Object.isFrozen(input)).toBe(true);
  });
  it("an own-recovery TD with no defensive recovery is not a fumble-return TD", () => {
    const own = { ...opp, fumble_recovery_tds: 1, fumble_recovery_opp: 0 };
    expect(pointsAllowedFromTeamWeek(own, 30)?.opponent_fumble_tds).toBe(0);
  });
  it("with the game's plays the TD counts are pbp-exact; safeties still come from the row", () => {
    const plays = [play({ touchdown: 1, td_team: D, interception: 1 })];
    expect(pointsAllowedFromTeamWeek(opp, 30, plays)).toEqual({
      score: 30,
      opponent_int_tds: 1,
      opponent_fumble_tds: 0,
      opponent_safeties: 1,
    });
  });
  it("NULL / absent counts are 0; a decimal-string score coerces", () => {
    expect(pointsAllowedFromTeamWeek({ def_tds: null }, "24")).toEqual({
      score: 24,
      opponent_int_tds: 0,
      opponent_fumble_tds: 0,
      opponent_safeties: 0,
    });
  });
  it.each([null, undefined, -3, 20.5, Number.NaN, "x", {}])(
    "no final score (%j) → null: dst_pa stays absent",
    (s) => {
      expect(pointsAllowedFromTeamWeek(opp, s)).toBeNull();
    },
  );
  it.each([
    ["a null row", null],
    ["an array row", []],
    ["a negative count", { def_tds: -1 }],
    ["a fractional count", { def_safeties: 0.5 }],
  ])("refuses %s", (_label, row) => {
    expect(() => pointsAllowedFromTeamWeek(row as NflverseRow, 10)).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
  it("refuses plays when the row names no team", () => {
    expect(() => pointsAllowedFromTeamWeek({ def_tds: 0 }, 10, [])).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
  it("yards allowed = gross passing + rushing − |sack yards| (either sign); null without a yardage", () => {
    expect(yardsAllowedFromTeamWeek(opp)).toBe(274 + 124 - 17);
    expect(yardsAllowedFromTeamWeek({ ...opp, sack_yards_lost: 17 })).toBe(381);
    expect(yardsAllowedFromTeamWeek({ passing_yards: 100, rushing_yards: 50 })).toBe(150);
    expect(yardsAllowedFromTeamWeek({ passing_yards: 100 })).toBeNull();
    expect(yardsAllowedFromTeamWeek({ rushing_yards: 100 })).toBeNull();
    expect(() => yardsAllowedFromTeamWeek(null as unknown as NflverseRow)).toThrow(
      expect.objectContaining({ code: "invalid_line" }),
    );
  });
});

describe("DST_POINTS_ALLOWED_EVIDENCE (re-derived by tests/golden/nflverse-phase2.test.ts)", () => {
  it("is frozen and internally consistent: the weeks final_score misses are the netted kinds", () => {
    const e = DST_POINTS_ALLOWED_EVIDENCE;
    expect(
      Object.isFrozen(e) && Object.isFrozen(e.weeks_with) && Object.isFrozen(e.unobserved),
    ).toBe(true);
    expect(e.net_of_defense_matches).toBe(e.recorded_dst_weeks);
    const netted = e.weeks_with.int_return_td + e.weeks_with.fumble_return_td + e.weeks_with.safety;
    expect(e.recorded_dst_weeks - e.final_score_matches).toBe(netted);
    expect(e.tries_after_netted_td.good + e.tries_after_netted_td.failed).toBe(
      e.weeks_with.int_return_td + e.weeks_with.fumble_return_td,
    );
  });
});
