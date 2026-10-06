// columns.test.ts — nflverse → canonical (plan 08 §3.2; §3.1 names; §3.3/§3.4 classes; §4.1 FG
// buckets): every mapped column is a contract column the loader asserts (A-1), the canonical names
// follow the grammar and plan 08's ESPN vocabulary, real fixture rows translate value-for-value, the
// K buckets account for blocked kicks, the D/ST line follows the defenseLines mapping, and the
// translator is NaN-free with `present` = the sorted keys (fast-check). Ported from sibling @521f9f3,
// adapted.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ESPN_POSITIONS } from "../../../src/providers/espn/types.js";
import { CANONICAL_NAME_RE, asPositionId } from "../../../src/domain/scoring/types.js";
import {
  ESPN_FG_BUCKETS,
  ESPN_POSITION_CLASS,
  MAPPED_STAT_COLUMNS,
  NFLVERSE_POSITION_TO_ESPN,
  NFLVERSE_STAT_MAP,
  espnPositionOf,
  kickDistances,
  pointsAllowedFor,
  toDefenseStatLine,
  toStatLine,
  translatePlayerWeek,
  unmappedStatColumns,
} from "../../../src/sources/nflverse/columns.js";
import { EXPECTED_COLUMNS } from "../../../src/sources/nflverse/schemas.js";
import {
  DS_TEAM_DEFENSE_WEEK,
  PLAYER_WEEK_STAT_COLUMNS,
} from "../../../src/store/datasets/tables.js";
import { FX, fixtureRows } from "./helpers/fixtures.js";

const statCols = PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name);
const rows = fixtureRows(FX.stats);
const rowOf = (name: string, week: number) => {
  const r = rows.find((x) => x.player_display_name === name && x.week === week);
  if (!r) throw new Error(`fixture row ${name} w${String(week)}`);
  return r;
};

describe("the mapping table", () => {
  it("names follow the canonical grammar; one mapping per canonical", () => {
    const names = NFLVERSE_STAT_MAP.map((m) => m.canonical);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(CANONICAL_NAME_RE);
    for (const b of ESPN_FG_BUCKETS) {
      expect(`fgm_${b.suffix}`).toMatch(CANONICAL_NAME_RE);
      expect(`fga_${b.suffix}`).toMatch(CANONICAL_NAME_RE);
    }
    expect(Object.isFrozen(NFLVERSE_STAT_MAP)).toBe(true);
  });

  it("A-1: every mapped column is a stored ds_stats_player_week column the loader asserts", () => {
    const asserted = Object.keys(EXPECTED_COLUMNS["nflverse:stats_player_week"]);
    for (const c of MAPPED_STAT_COLUMNS) {
      expect(statCols, c).toContain(c);
      expect(asserted, c).toContain(c);
    }
  });

  it("the D/ST translator reads only ds_team_defense_week columns", () => {
    const dst = new Set(DS_TEAM_DEFENSE_WEEK.columns.map((c) => c.name));
    const line = toDefenseStatLine(Object.fromEntries([...dst].map((c) => [c, 1]))).line;
    expect(line?.present).toEqual([
      "dst_blk",
      "dst_ff",
      "dst_fr",
      "dst_fr_td",
      "dst_int",
      "dst_int_td",
      "dst_kr_yd",
      "dst_pr_yd",
      "dst_ret_td",
      "dst_sack",
      "dst_safety",
      "dst_ya_raw",
    ]);
  });

  it("plan 08 §3.2 rows: 2-pt kept separate (+ the 62 union), fumbles summed over sack/rush/rec", () => {
    const by = Object.fromEntries(NFLVERSE_STAT_MAP.map((m) => [m.canonical, m.columns]));
    expect(by.pass_2pt).toEqual(["passing_2pt_conversions"]);
    expect(by.rush_2pt).toEqual(["rushing_2pt_conversions"]);
    expect(by.rec_2pt).toEqual(["receiving_2pt_conversions"]);
    expect(by.two_pt_total).toHaveLength(3);
    expect(by.fum_lost).toEqual([
      "sack_fumbles_lost",
      "rushing_fumbles_lost",
      "receiving_fumbles_lost",
    ]);
    expect(by.ret_td_total).toEqual(["special_teams_tds"]);
    expect(by.kr_td).toBeUndefined(); // needs pbp
    expect(by.pr_td).toBeUndefined();
  });

  it("unmapped columns are the usage / fantasy-points extras", () => {
    const un = unmappedStatColumns(statCols);
    expect(un).toContain("target_share");
    expect(un).toContain("fantasy_points_ppr");
    expect(un).not.toContain("passing_yards");
  });
});

describe("position ids and classes (mirror of src/providers/espn/types.ts ESPN_POSITIONS)", () => {
  it("every class equals ESPN_POSITIONS' class, every nflverse code lands on an ESPN position id", () => {
    for (const [id, cls] of Object.entries(ESPN_POSITION_CLASS)) {
      expect(ESPN_POSITIONS[Number(id)]?.class, id).toBe(cls);
    }
    expect(Object.keys(ESPN_POSITION_CLASS).sort()).toEqual(Object.keys(ESPN_POSITIONS).sort());
    for (const [code, id] of Object.entries(NFLVERSE_POSITION_TO_ESPN)) {
      expect(ESPN_POSITIONS[id], code).toBeDefined();
    }
    for (const p of ["QB", "RB", "WR", "TE", "K"]) {
      expect(ESPN_POSITIONS[NFLVERSE_POSITION_TO_ESPN[p] ?? -1]?.name).toBe(p);
    }
  });

  it("espnPositionOf: position first, then the group; case and whitespace tolerant; hostile → null", () => {
    expect(espnPositionOf("WR", "WR")).toBe(3);
    expect(espnPositionOf(" qb ", null)).toBe(1);
    expect(espnPositionOf("FB", "RB")).toBe(2);
    expect(espnPositionOf(null, "TE")).toBe(4);
    expect(espnPositionOf("OL", "OL")).toBeNull();
    expect(espnPositionOf("LS", "SPEC")).toBeNull();
    expect(espnPositionOf("__proto__", "constructor")).toBeNull();
    expect(espnPositionOf(5, {})).toBeNull();
  });
});

describe("toStatLine(nflverse) on real fixture rows", () => {
  it("a QB week: values are the raw columns, sums for fumbles, present = sorted keys", () => {
    const r = rowOf("Josh Allen", 1);
    const t = translatePlayerWeek(r);
    expect(t.issues).toEqual([]);
    const line = t.line!;
    expect(line.position).toBe(1);
    expect(line.position_class).toBe("O");
    expect(line.source).toBe("nflverse");
    expect(line.provisional).toBe(false);
    expect(line.values.pass_yd).toBe(r.passing_yards);
    expect(line.values.pass_td).toBe(r.passing_tds);
    expect(line.values.pass_att).toBe(r.attempts);
    expect(line.values.rush_yd).toBe(r.rushing_yards);
    expect(line.values.sacked).toBe(r.sacks_suffered);
    expect(line.values.fum_lost).toBe(
      Number(r.sack_fumbles_lost) +
        Number(r.rushing_fumbles_lost) +
        Number(r.receiving_fumbles_lost),
    );
    expect(line.present).toEqual(Object.keys(line.values).sort());
    expect(line.values.fg_0_39).toBeUndefined(); // K items never on an O line
    expect(Object.isFrozen(line)).toBe(true);
  });

  it("every fixture-roster skill row translates with no NaN and only O-class stats", () => {
    for (const r of rows.filter((x) => ["QB", "RB", "WR", "TE"].includes(String(x.position)))) {
      const line = toStatLine(r, { provisional: true });
      expect(line?.position_class).toBe("O");
      expect(line?.provisional).toBe(true);
      for (const v of Object.values(line?.values ?? {})) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("a kicker week: ESPN buckets from nflverse bins; attempts = made + missed per bucket", () => {
    const kickers = rows.filter((x) => x.position === "K" && Number(x.fg_att) > 0);
    expect(kickers.length).toBeGreaterThan(20);
    for (const r of kickers) {
      const line = toStatLine(r)!;
      expect(line.position_class).toBe("K");
      const v = line.values;
      expect(v.fg_0_39).toBe(
        Number(r.fg_made_0_19) + Number(r.fg_made_20_29) + Number(r.fg_made_30_39),
      );
      expect(v.fg_50p_legacy).toBe(Number(r.fg_made_50_59) + Number(r.fg_made_60_));
      expect(v.fga_total).toBe(r.fg_att); // fg_att = made + missed + blocked (nflverse)
      expect(v.fgm_total).toBe(Number(r.fg_missed) + Number(r.fg_blocked));
      const bucketAtt = ESPN_FG_BUCKETS.reduce((a, b) => a + (v[`fga_${b.suffix}`] ?? 0), 0);
      expect(bucketAtt).toBe(r.fg_att);
      expect(v.pat_miss).toBe(Number(r.pat_missed) + Number(r.pat_blocked));
    }
  });

  it("a blocked FG counts as missed in its distance bucket; a list that disagrees is reported", () => {
    const base = {
      position: "K",
      fg_made: 1,
      fg_made_40_49: 1,
      fg_missed: 0,
      fg_missed_40_49: 0,
      fg_missed_50_59: 0,
      fg_missed_0_19: 0,
      fg_missed_20_29: 0,
      fg_missed_30_39: 0,
      fg_missed_60_: 0,
    };
    const ok = translatePlayerWeek({ ...base, fg_blocked: 1, fg_blocked_list: "54" });
    expect(ok.issues).toEqual([]);
    expect(ok.line?.values).toMatchObject({
      fgm_50_59: 1,
      fga_40_49: 1,
      fgm_40_49: 0,
      fgm_total: 1,
      fga_total: 2,
    });
    const bad = translatePlayerWeek({ ...base, fg_blocked: 2, fg_blocked_list: "54" });
    expect(bad.issues).toContainEqual({
      column: "fg_blocked_list",
      issue: "does not match fg_blocked; blocks left out of the buckets",
    });
    expect(bad.line?.values.fgm_50_59).toBe(0);
    expect(bad.line?.values.fgm_total).toBe(2);
  });

  it("IDP, unknown positions and the ESPN position override", () => {
    const lb = translatePlayerWeek({ position: "LB", position_group: "LB", def_sacks: 1 });
    expect(lb.line?.position_class).toBe("IDP");
    expect(lb.line?.values).toEqual({});
    expect(lb.issues).toContainEqual({
      column: null,
      issue: "no player-week mapping for class IDP",
    });
    const ol = translatePlayerWeek({ position: "OL", passing_yards: 3 });
    expect(ol.line).toBeNull();
    expect(ol.issues[0]?.column).toBe("position");
    // TQB (15) scores as offence; the line carries the ESPN id so `overrides["15"]` can apply
    const tqb = toStatLine({ position: "QB", passing_yards: 250 }, { position: asPositionId(15) });
    expect(tqb).toMatchObject({ position: 15, position_class: "O", values: { pass_yd: 250 } });
    const unknownId = translatePlayerWeek({ passing_yards: 1 }, { position: asPositionId(99) });
    expect(unknownId.line).toBeNull();
  });

  it("null is absent, 0 is present, junk is reported and never stored", () => {
    const t = translatePlayerWeek({
      position: "RB",
      carries: 0,
      rushing_yards: null,
      receptions: "7",
      targets: Number.NaN,
      rushing_tds: 1.5,
      receiving_yards: 10n,
      receiving_tds: 2n ** 70n,
    });
    expect(t.line?.values.rush_att).toBe(0);
    expect(t.line?.values.rush_yd).toBeUndefined();
    expect(t.line?.values.rec).toBeUndefined();
    expect(t.line?.values.targets).toBeUndefined();
    expect(t.line?.values.rec_yd).toBe(10);
    expect(t.line?.values.rec_td).toBeUndefined();
    expect(t.line?.values.rush_td).toBe(1.5);
    expect(t.issues).toEqual(
      expect.arrayContaining([
        { column: "receptions", issue: "not a number (string)" },
        { column: "targets", issue: "not finite" },
        { column: "rushing_tds", issue: "count is 1.5" },
        { column: "receiving_tds", issue: "out of range" },
      ]),
    );
  });

  it("property: any row → NaN-free values, present = sorted keys, never throws", () => {
    const value = fc.oneof(
      fc.constant(null),
      fc.integer({ min: -50, max: 600 }),
      fc.double(),
      fc.string({ maxLength: 4 }),
      fc.bigInt(),
    );
    fc.assert(
      fc.property(
        fc.constantFrom("QB", "RB", "WR", "TE", "K", "P", "LB", "OL", null),
        fc.dictionary(fc.constantFrom(...MAPPED_STAT_COLUMNS), value),
        (position, cols) => {
          const t = translatePlayerWeek({ ...cols, position });
          if (t.line === null) return position === "OL" || position === null;
          const keys = Object.keys(t.line.values).sort();
          return (
            JSON.stringify(keys) === JSON.stringify(t.line.present) &&
            Object.values(t.line.values).every((v) => Number.isFinite(v))
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("the D/ST line (READER_QUERIES PlayerWeekReader.defenseLines mapping)", () => {
  it("maps every input; yards allowed need all three parts; points allowed is the scalar", () => {
    const row = {
      def_sacks: 2.5,
      def_interceptions: 1,
      def_fumbles_forced: 2,
      fumble_recovery_opp: 1,
      def_tds: 1,
      fumble_recovery_tds_opp: 0,
      special_teams_tds: 1,
      def_safeties: 0,
      def_fg_blocks: 1,
      def_punt_blocks: 0,
      def_pat_blocks: 1,
      kickoff_return_yards: 88,
      punt_return_yards: 12,
      opp_passing_yards: 250,
      opp_sack_yards_lost: 15,
      opp_rushing_yards: 80,
    };
    const t = toDefenseStatLine(row, { pointsAllowed: 17, provisional: true });
    expect(t.issues).toEqual([]);
    expect(t.line).toMatchObject({
      position: 16,
      position_class: "DST",
      provisional: true,
      source: "nflverse",
    });
    expect(t.line?.values).toEqual({
      dst_sack: 2.5,
      dst_int: 1,
      dst_ff: 2,
      dst_fr: 1,
      dst_int_td: 1,
      dst_fr_td: 0,
      dst_ret_td: 1,
      dst_safety: 0,
      dst_blk: 1,
      dst_kr_yd: 88,
      dst_pr_yd: 12,
      dst_pa_raw: 17,
      dst_ya_raw: 315,
    });
    expect(toDefenseStatLine(row, { includePatBlocks: true }).line?.values.dst_blk).toBe(2);
    const noYa = toDefenseStatLine({ ...row, opp_rushing_yards: null }).line;
    expect(noYa?.values.dst_ya_raw).toBeUndefined();
    expect(noYa?.values.dst_pa_raw).toBeUndefined();
    const badPa = toDefenseStatLine(row, { pointsAllowed: Number.NaN });
    expect(badPa.issues).toContainEqual({ column: "points_allowed", issue: "not finite" });
  });

  it("pointsAllowedFor: the opponent's final score; null when not final or not playing", () => {
    const g = { away_team: "PIT", home_team: "CLE", away_score: 24, home_score: 27 };
    expect(pointsAllowedFor("PIT", g)).toBe(27);
    expect(pointsAllowedFor("CLE", g)).toBe(24);
    expect(pointsAllowedFor("BUF", g)).toBeNull();
    expect(pointsAllowedFor("PIT", { ...g, home_score: null })).toBeNull();
  });
});

describe("kickDistances", () => {
  it.each([
    ["51;43", [51, 43]],
    [" 51 ; 43 ", [51, 43]],
    ["51;;x;0;100;-3;43", [51, 43]],
    ["", []],
    [null, []],
    [51, []],
    ["9".repeat(401), []],
  ] as const)("%j → %j", (input, want) => {
    expect(kickDistances(input)).toEqual(want);
  });

  it("matches the fixture's made counts where the list is present", () => {
    for (const r of rows.filter((x) => typeof x.fg_made_list === "string")) {
      expect(kickDistances(r.fg_made_list)).toHaveLength(Number(r.fg_made));
    }
  });
});
