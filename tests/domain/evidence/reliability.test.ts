// reliability.test.ts — the hand-set reliability model (src/domain/evidence/reliability.ts; research
// 05 §6 rules 2 and 4; sibling research 05 §10.2; plan 07 D6 `reliability_prior`, E10
// `calibration_state`, §6 "priors are hand-set" until ≥ 200 scored claims).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EVIDENCE_POSTERIOR_MIN_N } from "../../../src/domain/analytics/types.js";
import {
  calibrationState,
  CLAIM_TYPES,
  HAND_SET_NOTE,
  INJECTION_RELIABILITY_CAP,
  newsReliabilitySource,
  posteriorAllowed,
  RELIABILITY_PRIORS,
  RELIABILITY_SOURCES,
  reliabilityOf,
  reliabilityPrior,
  reliabilitySourceOf,
  SEASON_OUTLOOK_ZERO_WEEK,
  seasonOutlookWeight,
} from "../../../src/domain/evidence/index.js";
import { UNTRUSTED_SOURCES } from "../../../src/domain/league/types.js";

const SCORED = CLAIM_TYPES.filter((t) => t !== "other");

describe("the priors table", () => {
  it("has a probability for every source × scored type, and coaching intent is the lowest row", () => {
    for (const s of RELIABILITY_SOURCES) {
      const row = RELIABILITY_PRIORS[s];
      expect(Object.keys(row).sort()).toEqual([...SCORED].sort());
      for (const t of SCORED) {
        expect(row[t]).toBeGreaterThan(0);
        expect(row[t]).toBeLessThan(1);
        expect(row.coaching_intent).toBeLessThanOrEqual(row[t]);
      }
      expect(Object.isFrozen(row)).toBe(true);
    }
  });

  it("ranks the feeds above ESPN's editorial text above a user-pasted claim (per type)", () => {
    for (const t of SCORED) {
      const p = (s: (typeof RELIABILITY_SOURCES)[number]) => RELIABILITY_PRIORS[s][t];
      expect(p("rss.rotowire")).toBeGreaterThanOrEqual(p("rss.cbs"));
      expect(p("rss.cbs")).toBeGreaterThanOrEqual(p("espn.player.season_outlook"));
      expect(p("espn.player.outlook")).toBeGreaterThanOrEqual(p("espn.player.season_outlook"));
      expect(p("espn.player.season_outlook")).toBeGreaterThan(p("user.claim"));
    }
  });

  it("`other` has no prior", () => {
    expect(reliabilityPrior("rss.espn", "other")).toBeNull();
    expect(reliabilityOf("rss.espn", "other")).toEqual({
      reliability: null,
      prior: null,
      decayed: false,
      capped: false,
    });
    expect(reliabilityPrior("rss.espn", "transaction")).toBe(0.9);
  });
});

describe("rule 4: league-member text never enters the model", () => {
  it("maps only the news, outlook and user-claim tags to a scored source", () => {
    const mapped = UNTRUSTED_SOURCES.filter((t) => reliabilitySourceOf(t) !== null).sort();
    expect(mapped).toEqual(
      [
        "espn.player.outlook",
        "espn.player.season_outlook",
        "rss.cbs.blurb",
        "rss.cbs.title",
        "rss.espn.blurb",
        "rss.espn.title",
        "rss.rotowire.blurb",
        "rss.rotowire.title",
        "user.claim.text",
      ].sort(),
    );
    for (const t of [
      "espn.team.name",
      "espn.team.abbrev",
      "espn.member.name",
      "espn.league.name",
      "espn.division.name",
      "espn.team.trade_block",
      "espn.board.text",
      "rss.espn.url",
    ] as const)
      expect(reliabilitySourceOf(t)).toBeNull();
    expect(newsReliabilitySource("cbs")).toBe("rss.cbs");
  });
});

describe("rule 2: the preseason outlook decays to zero by week 4 unless lastNewsDate moved", () => {
  it("weights 1 → 0 linearly over weeks 1..4", () => {
    expect(seasonOutlookWeight(1)).toBe(1);
    expect(seasonOutlookWeight(2)).toBeCloseTo(2 / 3, 4);
    expect(seasonOutlookWeight(3)).toBeCloseTo(1 / 3, 4);
    expect(seasonOutlookWeight(SEASON_OUTLOOK_ZERO_WEEK)).toBe(0);
    expect(seasonOutlookWeight(12)).toBe(0);
    expect(seasonOutlookWeight(0)).toBe(1);
    expect(seasonOutlookWeight(null)).toBe(1);
    expect(seasonOutlookWeight(undefined)).toBe(1);
    expect(seasonOutlookWeight(Number.NaN)).toBe(1);
    expect(seasonOutlookWeight(9, true)).toBe(1);
  });

  it("applies the decay only to the season outlook and says so", () => {
    const r = reliabilityOf("espn.player.season_outlook", "availability", { week: 3 });
    expect(r.decayed).toBe(true);
    expect(r.reliability).toBeCloseTo(0.4 / 3, 3);
    expect(reliabilityOf("espn.player.season_outlook", "role", { week: 5 }).reliability).toBe(0);
    expect(
      reliabilityOf("espn.player.season_outlook", "role", { week: 5, news_moved: true }),
    ).toMatchObject({
      reliability: 0.45,
      decayed: false,
    });
    expect(reliabilityOf("espn.player.outlook", "availability", { week: 9 })).toMatchObject({
      reliability: 0.5,
      decayed: false,
    });
  });
});

describe("the injection cap", () => {
  it("caps any flagged text at INJECTION_RELIABILITY_CAP and leaves unflagged text alone", () => {
    expect(reliabilityOf("rss.rotowire", "transaction", { flags: ["imperative"] })).toEqual({
      reliability: INJECTION_RELIABILITY_CAP,
      prior: 0.9,
      decayed: false,
      capped: true,
    });
    expect(reliabilityOf("rss.rotowire", "transaction", { flags: [] }).capped).toBe(false);
    // already below the cap (a fully decayed outlook) → not "capped"
    expect(
      reliabilityOf("espn.player.season_outlook", "role", { week: 6, flags: ["json_like"] }),
    ).toMatchObject({
      reliability: 0,
      capped: false,
    });
  });

  it("never exceeds the plain prior, never leaves [0, 1] (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RELIABILITY_SOURCES),
        fc.constantFrom(...SCORED),
        fc.option(fc.integer({ min: -5, max: 25 })),
        fc.boolean(),
        fc.subarray(["imperative", "second_person", "json_like", "role_marker"] as const),
        (s, t, week, moved, flags) => {
          const r = reliabilityOf(s, t, { week, news_moved: moved, flags });
          expect(r.reliability).not.toBeNull();
          expect(r.reliability ?? -1).toBeGreaterThanOrEqual(0);
          expect(r.reliability ?? 2).toBeLessThanOrEqual(r.prior ?? 0);
          if (flags.length > 0)
            expect(r.reliability ?? 1).toBeLessThanOrEqual(INJECTION_RELIABILITY_CAP);
        },
      ),
    );
  });
});

describe("calibration_state (plan 07 §6; plan 10 B8)", () => {
  it("carries the hand-set note until the table has EVIDENCE_POSTERIOR_MIN_N claims", () => {
    expect(EVIDENCE_POSTERIOR_MIN_N).toBe(200);
    expect(calibrationState()).toEqual({ table_n: 0, note: HAND_SET_NOTE });
    expect(HAND_SET_NOTE).toBe("priors are hand-set");
    expect(calibrationState(199)).toEqual({ table_n: 199, note: "priors are hand-set" });
    expect(calibrationState(200)).toEqual({ table_n: 200, note: null });
    expect(calibrationState(-3)).toEqual({ table_n: 0, note: HAND_SET_NOTE });
    expect(calibrationState(2.5)).toEqual({ table_n: 0, note: HAND_SET_NOTE });
    expect(calibrationState(Number.POSITIVE_INFINITY)).toEqual({ table_n: 0, note: HAND_SET_NOTE });
    expect(posteriorAllowed(calibrationState(0))).toBe(false);
    expect(posteriorAllowed(calibrationState(250))).toBe(true);
  });
});
