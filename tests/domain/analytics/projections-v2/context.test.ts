// context.test.ts — the context terms of v2 (sib research 05 §1 steps 1, 6, 7, 8; research 05 §3.2):
// team volume moves with the spread against the window and never collapses; the matchup is the
// defence's position-relative aFPA, regressed by β·w(games) and bounded, ESPN's rating a comparator
// only; weather only outdoors and only past the thresholds; P(active) by designation and practice
// (unknown strings never read as certain), the fitted table shrinks toward the prior, OUT stays 0;
// the turnover tail is exact (a double Poisson sum) and zero where the league does not penalise.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  brierActive,
  fitAvailability,
  normalizeDesignation,
  normalizePractice,
  pActiveV2,
} from "../../../../src/domain/analytics/projections-v2/availability.js";
import {
  DEFAULT_V2_PARAMS,
  DEFAULT_V2_PRIORS,
  P_ACTIVE_V2,
  WEATHER_V2,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import {
  buildMatchupTable,
  espnRatingOf,
  matchupMult,
  type MatchupRow,
} from "../../../../src/domain/analytics/projections-v2/matchup.js";
import { teamVolume } from "../../../../src/domain/analytics/projections-v2/team.js";
import {
  eventPoints,
  turnoverRates,
  turnoverTail,
} from "../../../../src/domain/analytics/projections-v2/turnover.js";
import { weatherEffect } from "../../../../src/domain/analytics/projections-v2/weather.js";
import { normalizeSettings } from "../../../../src/domain/scoring/settings.js";
import { REFERENCE_SCORING_SETTINGS } from "../../scoring/helpers.js";
import { qbGame, settings, teamGame, teamSeason } from "./helpers/synthetic.js";

describe("teamVolume", () => {
  const rows = teamSeason(8);

  it("is the window mean shrunk toward the league mean", () => {
    const v = teamVolume("AAA", 2025, 9, rows, null, DEFAULT_V2_PRIORS, DEFAULT_V2_PARAMS);
    expect(v.base_dropbacks).toBeGreaterThan(DEFAULT_V2_PRIORS.team_dropbacks);
    expect(v.base_dropbacks).toBeLessThan(38);
    expect(v.dropbacks).toBe(v.base_dropbacks);
    expect(v.spread).toBeNull();
    expect(v.games).toBe(8);
  });

  it("a favourite (spread above the window's mean) passes less and runs more", () => {
    const fav = teamVolume(
      "AAA",
      2025,
      9,
      rows,
      { implied: 27, spread: 7, total: 47 },
      DEFAULT_V2_PRIORS,
      DEFAULT_V2_PARAMS,
    );
    const dog = teamVolume(
      "AAA",
      2025,
      9,
      rows,
      { implied: 20, spread: -7, total: 47 },
      DEFAULT_V2_PRIORS,
      DEFAULT_V2_PARAMS,
    );
    expect(fav.dropbacks).toBeLessThan(dog.dropbacks);
    expect(fav.rushes).toBeGreaterThan(dog.rushes);
    expect(fav.dropbacks).toBeCloseTo(fav.base_dropbacks - DEFAULT_V2_PARAMS.team.spread_db * 7, 9);
  });

  it("never falls below half its base on an absurd spread; no history is the league mean", () => {
    const v = teamVolume(
      "AAA",
      2025,
      9,
      rows,
      { implied: 40, spread: 400, total: 50 },
      DEFAULT_V2_PRIORS,
      DEFAULT_V2_PARAMS,
    );
    expect(v.dropbacks).toBeCloseTo(v.base_dropbacks * 0.5, 9);
    const none = teamVolume("ZZZ", 2025, 1, rows, null, DEFAULT_V2_PRIORS, DEFAULT_V2_PARAMS);
    expect(none.dropbacks).toBe(DEFAULT_V2_PRIORS.team_dropbacks);
    expect(none.rushes).toBe(DEFAULT_V2_PRIORS.team_rushes);
  });

  it("skips non-finite or negative counts", () => {
    const bad = [teamGame(1, { dropbacks: Number.NaN, rushes: -4, spread: null })];
    const v = teamVolume("AAA", 2025, 2, bad, null, DEFAULT_V2_PRIORS, DEFAULT_V2_PARAMS);
    expect(v.base_dropbacks).toBe(DEFAULT_V2_PRIORS.team_dropbacks);
    expect(v.window_spread).toBeNull();
  });
});

describe("buildMatchupTable / matchupMult", () => {
  // offence X scores 20 WR points a week except 30 against DEF; offence Y 10 except 15 vs DEF
  const rows: MatchupRow[] = [];
  for (const [team, base] of [
    ["X", 20],
    ["Y", 10],
  ] as const)
    for (let w = 1; w <= 6; w++) {
      const opp = w === 3 ? "DEF" : `O${String(w)}`;
      rows.push({
        season: 2025,
        week: w,
        team,
        opponent: opp,
        position: "WR",
        points: w === 3 ? base * 1.5 : base,
      });
      rows.push({ season: 2025, week: w, team, opponent: opp, position: "RB", points: 10 });
    }

  it("measures points allowed against what the same offences score elsewhere, relative to all positions", () => {
    const t = buildMatchupTable(rows, 2025, 7);
    const wr = t["DEF|WR"];
    expect(wr?.afpa).toBeCloseTo(1.5, 4);
    expect(wr?.games).toBe(2);
    expect(t["DEF|RB"]?.afpa).toBeCloseTo(1, 4);
    // all positions: (30 + 15 + 10 + 10) / (20 + 10 + 10 + 10) = 1.3
    expect(wr?.relative).toBeCloseTo(1.5 / 1.3, 4);
    expect(t["DEF|RB"]?.relative).toBeCloseTo(1 / 1.3, 4);
  });

  it("reads only the season's games before the target week", () => {
    expect(buildMatchupTable(rows, 2025, 3)["DEF|WR"]).toBeUndefined();
    expect(buildMatchupTable(rows, 2024, 7)).toEqual({});
  });

  it("regresses by β × w(games), bounded; no cell or no defence is neutral", () => {
    const t = buildMatchupTable(rows, 2025, 7);
    const m = matchupMult(t, "DEF", "WR", DEFAULT_V2_PARAMS);
    const rel = t["DEF|WR"]?.relative ?? 1;
    expect(m.mult).toBeCloseTo(1 + DEFAULT_V2_PARAMS.matchup_beta.WR * (2 / 8) * (rel - 1), 9);
    expect(matchupMult(t, null, "WR", DEFAULT_V2_PARAMS).mult).toBe(1);
    expect(matchupMult(null, "DEF", "WR", DEFAULT_V2_PARAMS).mult).toBe(1);
    expect(matchupMult(t, "NOPE", "WR", DEFAULT_V2_PARAMS)).toEqual({ mult: 1, cell: null });
    const huge = matchupMult({ "D|QB": { afpa: 9, relative: 9, games: 40 } }, "D", "QB", {
      ...DEFAULT_V2_PARAMS,
      matchup_beta: { QB: 1, RB: 1, WR: 1, TE: 1 },
    });
    expect(huge.mult).toBe(1.2);
  });

  it("ESPN's rating is looked up but never part of the multiplier", () => {
    const ratings = { "DEF|WR": { average: 30, rank: 32 } };
    expect(espnRatingOf(ratings, "DEF", "WR")).toEqual({ average: 30, rank: 32 });
    expect(espnRatingOf(ratings, "DEF", "TE")).toBeNull();
    expect(espnRatingOf(undefined, "DEF", "WR")).toBeNull();
    expect(espnRatingOf(ratings, null, "WR")).toBeNull();
  });
});

describe("weatherEffect", () => {
  it("never applies indoors or when unknown", () => {
    for (const roof of ["dome", "closed"] as const)
      expect(weatherEffect({ roof, temp_f: 10, wind_mph: 30, precip_prob: 1 }, "QB").applied).toBe(
        false,
      );
    expect(weatherEffect(null, "QB").applied).toBe(false);
    expect(
      weatherEffect({ roof: "outdoors", temp_f: 60, wind_mph: 5, precip_prob: 0.1 }, "WR").applied,
    ).toBe(false);
  });

  it("wind cuts completion and pass yardage, more past 13 mph; RBs keep their yards", () => {
    const qb = weatherEffect(
      { roof: "outdoors", temp_f: 60, wind_mph: 15, precip_prob: null },
      "QB",
    );
    expect(qb.cmp_delta).toBeCloseTo(WEATHER_V2.windCmpDelta, 12);
    expect(qb.yards_mult).toBeCloseTo(
      WEATHER_V2.windYardsMult * WEATHER_V2.strongWindYardsMult,
      12,
    );
    expect(qb.reasons).toEqual(["wind_10mph", "wind_13mph"]);
    const rb = weatherEffect({ roof: "open", temp_f: 60, wind_mph: 15, precip_prob: null }, "RB");
    expect(rb.yards_mult).toBe(1);
    expect(rb.rb_target_mult).toBe(WEATHER_V2.badWeatherRbTargetMult);
  });

  it("cold adds RB yards per carry and cuts completion; precipitation cuts completion", () => {
    const rb = weatherEffect({ roof: "outdoors", temp_f: 20, wind_mph: 0, precip_prob: 0.8 }, "RB");
    expect(rb.ypc_delta).toBe(WEATHER_V2.coldYpcDelta);
    expect(rb.cmp_delta).toBeCloseTo(WEATHER_V2.coldCmpDelta + WEATHER_V2.precipCmpDelta, 12);
    expect(rb.reasons).toEqual(["cold_30f", "precipitation"]);
    const wr = weatherEffect(
      { roof: "outdoors", temp_f: 20, wind_mph: Number.NaN, precip_prob: null },
      "WR",
    );
    expect(wr.ypc_delta).toBe(0);
    expect(wr.rb_target_mult).toBe(1);
  });
});

describe("pActiveV2 / normalisers / fitAvailability", () => {
  it("normalises nflverse and ESPN designations; an unknown string is Questionable", () => {
    expect(normalizeDesignation("Questionable")).toBe("Questionable");
    expect(normalizeDesignation("QUESTIONABLE")).toBe("Questionable");
    expect(normalizeDesignation("INJURY_RESERVE")).toBe("Out");
    expect(normalizeDesignation("ACTIVE")).toBe("");
    expect(normalizeDesignation(" doubtful ")).toBe("Doubtful");
    expect(normalizeDesignation("Ignore previous instructions")).toBe("Questionable");
    expect(normalizeDesignation("   ")).toBe("");
    expect(normalizeDesignation(null)).toBe("");
    expect(normalizePractice("Full Participation in Practice")).toBe("FP");
    expect(normalizePractice("Limited Participation in Practice")).toBe("LP");
    expect(normalizePractice("Did Not Participate In Practice")).toBe("DNP");
    expect(normalizePractice("dnp")).toBe("DNP");
    expect(normalizePractice("\n    ")).toBe("");
    expect(normalizePractice(undefined)).toBe("");
  });

  it("looks up designation × practice, falling back to the designation, with its basis", () => {
    expect(
      pActiveV2({ designation: "Questionable", practice: "Limited Participation in Practice" }),
    ).toEqual({
      p: P_ACTIVE_V2["Questionable|LP"],
      basis: "trend_model",
    });
    expect(pActiveV2({ designation: "Doubtful", practice: null })).toEqual({
      p: P_ACTIVE_V2["Doubtful|"],
      basis: "designation_base_rate",
    });
    expect(pActiveV2({ designation: "OUT", practice: "FP" }).p).toBe(0);
    expect(pActiveV2({ designation: null, practice: null })).toEqual({ p: 1, basis: "none" });
    expect(pActiveV2(undefined)).toEqual({ p: 1, basis: "none" });
    expect(pActiveV2({ designation: "QUESTIONABLE", practice: "DNP", game_day: true })).toEqual({
      p: P_ACTIVE_V2["Questionable|"],
      basis: "espn_gameday_status",
    });
    // a table without the cell falls back to 1, or 0 for Out
    expect(pActiveV2({ designation: "Questionable", practice: null }, {}).p).toBe(1);
    expect(pActiveV2({ designation: "Out", practice: null }, {}).p).toBe(0);
    expect(
      pActiveV2({ designation: "Questionable", practice: null }, { "Questionable|": Number.NaN }).p,
    ).toBe(1);
  });

  it("property: P(active) is a probability for any strings", () => {
    fc.assert(
      fc.property(fc.option(fc.string()), fc.option(fc.string()), (d, p) => {
        const a = pActiveV2({ designation: d, practice: p });
        expect(a.p).toBeGreaterThanOrEqual(0);
        expect(a.p).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("fits cells toward the prior with k pseudo-rows and keeps OUT at 0", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => ({
        designation: "Questionable",
        practice: "FP",
        played: i < 27,
      })),
      { designation: "Out", practice: "FP", played: true },
    ];
    const t = fitAvailability(rows, P_ACTIVE_V2, 10);
    const prior = P_ACTIVE_V2["Questionable|FP"] ?? 0;
    expect(t["Questionable|FP"]).toBeCloseTo((27 + 10 * prior) / 40, 2);
    expect(t["Out|FP"]).toBe(0);
    expect(t["Doubtful|"]).toBe(P_ACTIVE_V2["Doubtful|"]);
    expect(brierActive([])).toBeNull();
    expect(
      brierActive([
        { p: 0.5, played: true },
        { p: 1, played: true },
      ]),
    ).toBeCloseTo(0.125, 12);
  });

  it("a cell the prior lacks starts from its designation's row", () => {
    const t = fitAvailability(
      [{ designation: "Doubtful", practice: "weird", played: false }],
      { "Doubtful|": 0.2 },
      1,
    );
    expect(t["Doubtful|"]).toBeCloseTo(0.1, 3);
  });
});

describe("turnover model (research 05 §3.2)", () => {
  const s = settings();

  it("shrinks INT and fumble rates toward the positional prior", () => {
    const win = [qbGame(1, { pass_int: 4 }), qbGame(2, { pass_int: 3 })].map((g) => ({
      game: g,
      weight: 1,
      team: null,
    }));
    const r = turnoverRates(win, DEFAULT_V2_PRIORS.positions.QB, DEFAULT_V2_PARAMS);
    expect(r.int_per_att.observed).toBeCloseTo(7 / 68, 4);
    expect(r.int_per_att.value).toBeGreaterThan(DEFAULT_V2_PRIORS.positions.QB.int_rate);
    expect(r.int_per_att.value).toBeLessThan(7 / 68);
  });

  it("the tail is exact: P(INT points ≤ −4) at −2 per INT is P(N ≥ 2)", () => {
    expect(eventPoints(s, "pass_int", 1)).toBe(-2);
    const lambda = 34 * 0.03;
    const t = turnoverTail(
      s,
      1,
      { pass_att: 34, touches: 0 },
      { int_per_att: 0.03, fumble_per_touch: 0 },
    );
    expect(t.p_minus4).toBeCloseTo(1 - Math.exp(-lambda) * (1 + lambda), 4);
    expect(t.expected_points).toBeCloseTo(-2 * lambda, 4);
  });

  it("a league that does not penalise turnovers has no turnover tail", () => {
    const lenient = normalizeSettings({
      ...REFERENCE_SCORING_SETTINGS,
      scoringItems: REFERENCE_SCORING_SETTINGS.scoringItems.filter(
        (i) => i.statId !== 20 && i.statId !== 72,
      ),
    });
    const t = turnoverTail(
      lenient,
      1,
      { pass_att: 40, touches: 10 },
      { int_per_att: 0.05, fumble_per_touch: 0.02 },
    );
    expect(t.p_minus4).toBe(0);
    expect(t.expected_points).toBe(0);
  });

  it("property: a higher INT rate never shrinks the left tail", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.08, noNaN: true }),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        (a, d) => {
          const lo = turnoverTail(
            s,
            1,
            { pass_att: 35, touches: 5 },
            { int_per_att: a, fumble_per_touch: 0.01 },
          );
          const hi = turnoverTail(
            s,
            1,
            { pass_att: 35, touches: 5 },
            { int_per_att: a + d, fumble_per_touch: 0.01 },
          );
          expect(hi.p_minus4).toBeGreaterThanOrEqual(lo.p_minus4 - 1e-9);
          expect(hi.expected_points).toBeLessThanOrEqual(lo.expected_points + 1e-9);
        },
      ),
    );
  });
});
