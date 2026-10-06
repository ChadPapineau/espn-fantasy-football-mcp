// seeding.test.ts — src/domain/league/seeding.ts: the A1 `seeding` digest (plan 07 C12; ADV OBJ-13:
// `espn_rule` by default, `points_only` by configuration, `confirmed` only once recorded; HANDOFF D1
// — the owner's league is ESPN's rule), and the one-time evidence (research 05 §2.1): the recorded
// standings of all three leagues follow ESPN's record-first rule (league-c incl. its four division
// winners), a hand-made points-only season is detected, and ambiguous seasons stay `unknown`.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SEEDING_MODES } from "../../../src/config/schema.js";
import {
  seedingDigest,
  seedingEvidence,
  seedingOrder,
  winPct,
  type SeasonStandingInput,
} from "../../../src/domain/league/seeding.js";
import { LEAGUES, readRecorded, standingsFromWire } from "./helpers.js";

const team = (
  team_id: number,
  seed: number | null,
  wins: number,
  losses: number,
  points_for: number,
  division_id = 0,
  ties = 0,
): SeasonStandingInput => ({
  team_id,
  seed,
  division_id,
  wins,
  losses,
  ties,
  points_for,
});

describe("seedingDigest (plan 07 C12)", () => {
  it("default espn_rule, unconfirmed until a valid instant is recorded", () => {
    expect(
      seedingDigest("TOTAL_POINTS_SCORED", {
        seeding_mode: "espn_rule",
        seeding_confirmed_at: null,
      }),
    ).toEqual({
      rule: "TOTAL_POINTS_SCORED",
      mode_configured: "espn_rule",
      confirmed: false,
      mode_in_use: "espn_rule",
      evidence: null,
    });
    expect(
      seedingDigest("TOTAL_POINTS_SCORED", {
        seeding_mode: "espn_rule",
        seeding_confirmed_at: "2026-10-06T12:00:00Z",
      }).confirmed,
    ).toBe(true);
    expect(
      seedingDigest("TOTAL_POINTS_SCORED", {
        seeding_mode: "espn_rule",
        seeding_confirmed_at: "yesterday",
      }).confirmed,
    ).toBe(false);
  });
  it("points_only by configuration; an explicit per-call override changes only mode_in_use", () => {
    const d = seedingDigest("TOTAL_POINTS_SCORED", {
      seeding_mode: "points_only",
      seeding_confirmed_at: "2026-10-06T12:00:00Z",
    });
    expect(d).toMatchObject({
      mode_configured: "points_only",
      mode_in_use: "points_only",
      confirmed: true,
    });
    const o = seedingDigest(
      "TOTAL_POINTS_SCORED",
      { seeding_mode: "espn_rule", seeding_confirmed_at: null },
      null,
      "points_only",
    );
    expect(o).toMatchObject({
      mode_configured: "espn_rule",
      mode_in_use: "points_only",
      confirmed: false,
    });
  });
  it("carries the evidence when onboard asked for it", () => {
    const ev = seedingEvidence(2025, [team(1, 1, 3, 0, 300)], {
      team_count: 1,
      seeding_rule: "TOTAL_POINTS_SCORED",
      playoff_edited: false,
    });
    expect(
      seedingDigest(
        "TOTAL_POINTS_SCORED",
        { seeding_mode: "espn_rule", seeding_confirmed_at: null },
        ev,
      ).evidence,
    ).toBe(ev);
  });
  it("covers every configured mode", () => {
    for (const m of SEEDING_MODES)
      expect(seedingDigest("X", { seeding_mode: m, seeding_confirmed_at: null }).mode_in_use).toBe(
        m,
      );
  });
});

describe("seedingEvidence over the recorded standings (research 05 §2.1)", () => {
  const formats = { "league-a": 4, "league-b": 4, "league-c": 8 } as const;
  it("every recorded league's seeds follow ESPN's rule — record first, points for as the tiebreak", () => {
    // league-a's top four happen to be its top four by points too: indistinguishable → unknown
    const verdict = {
      "league-a": [true, "unknown"],
      "league-b": [false, "espn_rule"],
      "league-c": [false, "espn_rule"],
    } as const;
    for (const l of LEAGUES) {
      const ev = seedingEvidence(2026, standingsFromWire(readRecorded(`${l}/mTeam.json`)), {
        team_count: formats[l],
        seeding_rule: "TOTAL_POINTS_SCORED",
        playoff_edited: false,
      });
      expect(ev.seed_order_matches_record, l).toBe(true);
      expect(ev.seed_order_matches_pf, l).toBe(verdict[l][0]);
      expect(ev.suggests, l).toBe(verdict[l][1]);
      expect(
        ev.table.map((r) => r.seed),
        l,
      ).toEqual([...ev.table.map((r) => r.seed)].sort((a, b) => (a ?? 0) - (b ?? 0)));
    }
  });
  it("…over the whole table too, not only the playoff field", () => {
    for (const l of LEAGUES) {
      const ev = seedingEvidence(2026, standingsFromWire(readRecorded(`${l}/mTeam.json`)), {
        team_count: null,
        seeding_rule: "TOTAL_POINTS_SCORED",
        playoff_edited: null,
      });
      expect(ev.seed_order_matches_record, l).toBe(true);
    }
  });
  it("league-c: four division winners seed 1–4 (a 2-1 team with the league's best points is seeded 5th)", () => {
    const teams = standingsFromWire(readRecorded("league-c/mTeam.json"));
    expect(new Set(teams.map((t) => t.division_id)).size).toBe(4);
    const order = seedingOrder(teams, "espn_rule", "TOTAL_POINTS_SCORED");
    const bySeed = [...teams].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0)).map((t) => t.team_id);
    expect(order).toEqual(bySeed);
    const fifth = teams.find((t) => t.seed === 5);
    expect(fifth?.points_for).toBe(Math.max(...teams.map((t) => t.points_for)));
    // ignoring divisions would seed that team higher — the division rule is load-bearing
    const flat = seedingOrder(
      teams.map((t) => ({ ...t, division_id: 0 })),
      "espn_rule",
      "TOTAL_POINTS_SCORED",
    );
    expect(flat).not.toEqual(bySeed);
  });
  it("league-a: the record and PF ranks of the table (competition ranking)", () => {
    const ev = seedingEvidence(2026, standingsFromWire(readRecorded("league-a/mTeam.json")), {
      team_count: 4,
      seeding_rule: "TOTAL_POINTS_SCORED",
      playoff_edited: false,
    });
    expect(ev.table.map((r) => r.record_rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ev.table.map((r) => r.pf_rank)).toEqual([1, 2, 3, 4, 7, 5, 6, 8, 9, 10]);
    expect(ev.playoff_edited).toBe(false);
  });
});

describe("seedingEvidence on hand-made seasons", () => {
  // six teams, 4-team playoff; record order 1,2,3,4,5,6; points order 3,1,5,2,4,6
  const season = [
    team(1, null, 9, 4, 1500),
    team(2, null, 8, 5, 1400),
    team(3, null, 7, 6, 1600),
    team(4, null, 7, 6, 1350),
    team(5, null, 6, 7, 1450),
    team(6, null, 2, 11, 1200),
  ];
  const seeded = (order: readonly number[]) =>
    season.map((t) => ({ ...t, seed: order.indexOf(t.team_id) + 1 }));
  const opts = {
    team_count: 4,
    seeding_rule: "TOTAL_POINTS_SCORED",
    playoff_edited: true,
  } as const;
  it("seeds in points order (a commissioner's points-only bracket) → points_only", () => {
    const ev = seedingEvidence(2025, seeded([3, 1, 5, 2, 4, 6]), opts);
    expect(ev).toMatchObject({
      seed_order_matches_pf: true,
      seed_order_matches_record: false,
      suggests: "points_only",
      playoff_edited: true,
    });
  });
  it("seeds in record order → espn_rule; seeds in neither → unknown", () => {
    expect(seedingEvidence(2025, seeded([1, 2, 3, 4, 5, 6]), opts).suggests).toBe("espn_rule");
    expect(seedingEvidence(2025, seeded([4, 3, 2, 1, 5, 6]), opts)).toMatchObject({
      seed_order_matches_pf: false,
      seed_order_matches_record: false,
      suggests: "unknown",
    });
  });
  it("only the field matters: non-playoff seeds out of order do not change the verdict", () => {
    expect(seedingEvidence(2025, seeded([3, 1, 5, 2, 6, 4]), opts).suggests).toBe("points_only");
  });
  it("the right order but the wrong qualifiers does not match", () => {
    // 4 (7-6, 1350) qualifies over 5 (6-7, 1450) by record; a points bracket would take 5
    const ev = seedingEvidence(2025, seeded([3, 1, 2, 4, 5, 6]), opts);
    expect(ev.seed_order_matches_pf).toBe(false);
  });
  it("record and points orders coinciding → unknown (indistinguishable); no seeds → unknown", () => {
    const same = [team(1, 1, 10, 3, 1500), team(2, 2, 8, 5, 1400), team(3, 3, 5, 8, 1300)];
    expect(seedingEvidence(2025, same, { ...opts, team_count: 2 })).toMatchObject({
      seed_order_matches_pf: true,
      seed_order_matches_record: true,
      suggests: "unknown",
    });
    const none = seedingEvidence(2025, season, opts);
    expect(none).toMatchObject({
      seed_order_matches_pf: false,
      seed_order_matches_record: false,
      suggests: "unknown",
    });
    expect(seedingEvidence(2025, [], opts)).toMatchObject({ suggests: "unknown", table: [] });
  });
  it("H2H_RECORD: teams level on win % compare equal (the head-to-head tiebreak is not computable)", () => {
    const tied = [team(1, 1, 7, 6, 1300), team(2, 2, 7, 6, 1500), team(3, 3, 5, 8, 1600)];
    expect(
      seedingEvidence(2025, tied, {
        team_count: 2,
        seeding_rule: "H2H_RECORD",
        playoff_edited: false,
      }).seed_order_matches_record,
    ).toBe(true);
    expect(
      seedingEvidence(2025, tied, {
        team_count: 2,
        seeding_rule: "TOTAL_POINTS_SCORED",
        playoff_edited: false,
      }).seed_order_matches_record,
    ).toBe(false);
  });
  it("ties count as half a win; hostile rows (negative, NaN, fractional id) are ignored", () => {
    expect(winPct({ wins: 6, losses: 6, ties: 1 })).toBeCloseTo(6.5 / 13, 12);
    expect(winPct({ wins: 0, losses: 0, ties: 0 })).toBe(0);
    const ev = seedingEvidence(
      2025,
      [
        team(1, 1, 5, 0, 500),
        team(2, 2, -1, 0, 9999),
        { ...team(3, 3, 1, 0, 1), points_for: Number.NaN },
        { ...team(4, 4, 1, 0, 1), team_id: 1.5 },
      ],
      { team_count: null, seeding_rule: "TOTAL_POINTS_SCORED", playoff_edited: null },
    );
    expect(ev.table.map((r) => r.team_id)).toEqual([1]);
  });
  it("seedingOrder under points_only is pure points-for order, ties by team id", () => {
    expect(seedingOrder(season, "points_only", "TOTAL_POINTS_SCORED")).toEqual([3, 1, 5, 2, 4, 6]);
    expect(
      seedingOrder([team(9, null, 1, 0, 10), team(2, null, 0, 1, 10)], "points_only", "X"),
    ).toEqual([2, 9]);
  });
  it("property: seeds assigned by either order are recognised as that order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { minLength: 2, maxLength: 12 }),
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 14 }),
            fc.integer({ min: 0, max: 14 }),
            fc.integer({ min: 900, max: 2000 }),
          ),
          { minLength: 12, maxLength: 12 },
        ),
        fc.constantFrom<"espn_rule" | "points_only">("espn_rule", "points_only"),
        (ids, stats, mode) => {
          const teams = ids.map((id, i) => {
            const [w, l, pf] = stats[i] ?? [0, 0, 0];
            return team(id, null, w, l, pf + i / 100);
          });
          const order = seedingOrder(teams, mode, "TOTAL_POINTS_SCORED");
          const withSeeds = teams.map((t) => ({ ...t, seed: order.indexOf(t.team_id) + 1 }));
          const ev = seedingEvidence(2025, withSeeds, {
            team_count: Math.ceil(ids.length / 2),
            seeding_rule: "TOTAL_POINTS_SCORED",
            playoff_edited: null,
          });
          expect(
            mode === "points_only" ? ev.seed_order_matches_pf : ev.seed_order_matches_record,
          ).toBe(true);
          expect(ev.suggests).not.toBe(mode === "points_only" ? "espn_rule" : "points_only");
        },
      ),
    );
  });
});
