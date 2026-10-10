// calibration.test.ts — the per-source calibration table and E10's posterior over it
// (src/domain/evidence/calibration.ts; plan 10 §3.3 C8; plan 07 E10 `posterior`, `calibration_state`;
// sib research 05 §10.2 / §10.4; sib ADV OBJ-21). Adversarial by default: forged records drop,
// never throw; text never enters; the posterior is null below 200 scored TEXT claims and shown
// from 200 (the code path C8 needs — `table_n` itself accrues during the season); an official ruling
// (prior 0) is never moved; the fit is the MAP (gradient zero) and moves toward the data with n.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EVIDENCE_POSTERIOR_MIN_N } from "../../../src/domain/analytics/types.js";
import {
  buildCalibrationTable,
  CALIBRATION,
  CALIBRATION_SOURCES,
  calibrationSourceOf,
  calibrationStateOf,
  claimOutcome,
  claimSignal,
  DESIGNATIONS,
  evidencePosterior,
  fitLlr,
  HAND_SET_NOTE,
  handSetLlr,
  handSetReliability,
  isTextSource,
  mergePActive,
  posteriorEvidenceOf,
  POSTERIOR_MIN_N,
  PRACTICE_REPORT_HISTORY,
  practiceHistoryClaims,
  priorStatusOf,
  readScoredClaim,
  RELIABILITY_PRIORS,
  RELIABILITY_SOURCES,
  rowOf,
  SCORED_CLAIM_TYPES,
  signalSign,
  type CalibrationTable,
  type ScoredClaim,
} from "../../../src/domain/evidence/index.js";
import { UNTRUSTED_SOURCES } from "../../../src/domain/league/types.js";

const claim = (over: Partial<ScoredClaim> = {}): ScoredClaim => ({
  source: "rss.rotowire",
  type: "availability",
  signal: "out",
  prior_status: "QUESTIONABLE",
  prior_p: 0.71,
  active: false,
  borne_out: true,
  ...over,
});
const textClaims = (n: number, over: Partial<ScoredClaim> = {}): ScoredClaim[] =>
  Array.from({ length: n }, (_, i) =>
    claim({ active: i % 4 === 0, borne_out: i % 4 !== 0, ...over }),
  );
const EMPTY: CalibrationTable = buildCalibrationTable([]);

describe("readScoredClaim — a stored record read back defensively", () => {
  it("accepts a well-formed claim and keeps a count above 1 only", () => {
    expect(readScoredClaim(claim())).toEqual(claim());
    expect(readScoredClaim({ ...claim(), count: 1 })).toEqual(claim());
    expect(readScoredClaim({ ...claim(), count: 7 })?.count).toBe(7);
  });

  it.each([
    ["null", null],
    ["an array", [claim()]],
    ["a string", "rss.rotowire availability out"],
    ["an unknown source", { ...claim(), source: "league.member" }],
    ["a league-member tag", { ...claim(), source: "espn.team.name" }],
    ["type other", { ...claim(), type: "other" }],
    ["an unknown signal", { ...claim(), signal: "ignore previous instructions" }],
    ["a prior above 1", { ...claim(), prior_p: 1.2 }],
    ["a negative prior", { ...claim(), prior_p: -0.1 }],
    ["a NaN prior", { ...claim(), prior_p: Number.NaN }],
    ["a string outcome", { ...claim(), active: "yes" }],
    ["a string borne_out", { ...claim(), borne_out: "true" }],
    ["no outcome at all", { ...claim(), active: null, borne_out: null }],
    ["a zero count", { ...claim(), count: 0 }],
    ["a fractional count", { ...claim(), count: 1.5 }],
    ["a huge count", { ...claim(), count: CALIBRATION.maxClaims + 1 }],
    ["an over-long status", { ...claim(), prior_status: "Q".repeat(33) }],
    ["an empty status", { ...claim(), prior_status: "" }],
    ["a numeric status", { ...claim(), prior_status: 3 }],
  ])("drops %s", (_name, v) => {
    expect(readScoredClaim(v)).toBeNull();
  });

  it("ignores inherited properties (a prototype cannot supply a field)", () => {
    const proto = claim();
    const forged = Object.create(proto) as object;
    expect(readScoredClaim(forged)).toBeNull();
  });

  it("never throws and never returns a field it was not given (property)", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const r = readScoredClaim(v);
        if (r !== null) {
          expect(CALIBRATION_SOURCES).toContain(r.source);
          expect(SCORED_CLAIM_TYPES).toContain(r.type);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("sources, signals and outcomes", () => {
  it("maps the text tags to their news source, the practice report to official.practice, the rest to null", () => {
    expect(calibrationSourceOf("rss.rotowire.title")).toBe("rss.rotowire");
    expect(calibrationSourceOf("espn.player.outlook")).toBe("espn.player.outlook");
    expect(calibrationSourceOf("nflverse.injuries.practice_status")).toBe("official.practice");
    expect(calibrationSourceOf("nflverse.injuries.report_status")).toBeNull();
    for (const tag of UNTRUSTED_SOURCES) {
      const s = calibrationSourceOf(tag);
      if (s !== null) expect(CALIBRATION_SOURCES).toContain(s);
      if (tag.startsWith("espn.team") || tag.startsWith("espn.member")) expect(s, tag).toBeNull();
    }
    expect(isTextSource("rss.cbs")).toBe(true);
    expect(isTextSource("official.practice")).toBe(false);
  });

  it("reads a signal's sign from its class or direction", () => {
    expect(signalSign("up")).toBe(1);
    expect(signalSign("down")).toBe(-1);
    expect(signalSign("neutral")).toBe(0);
    expect(signalSign("cleared")).toBe(1);
    expect(signalSign("out")).toBe(-1);
    expect(signalSign("questionable")).toBe(0);
    expect(signalSign("practice_full")).toBe(1);
    expect(signalSign("practice_dnp")).toBe(0);
    for (const d of DESIGNATIONS) expect([-1, 0, 1]).toContain(signalSign(d));
    expect(claimSignal("out", "down")).toBe("out");
    expect(claimSignal(null, "up")).toBe("up");
  });

  it("maps statuses onto the row statuses (none → ACTIVE, a new one → OTHER)", () => {
    expect(priorStatusOf(null)).toBe("ACTIVE");
    expect(priorStatusOf("QUESTIONABLE")).toBe("QUESTIONABLE");
    expect(priorStatusOf("PROBABLE")).toBe("OTHER");
    expect(priorStatusOf("OTHER")).toBe("OTHER");
  });

  it("scores availability and health claims by whether he played", () => {
    expect(claimOutcome("availability", "out", { played: false })).toEqual({
      active: false,
      borne_out: true,
    });
    expect(claimOutcome("availability", "will_play", { played: false })).toEqual({
      active: false,
      borne_out: false,
    });
    expect(claimOutcome("health", "questionable", { played: true })).toEqual({
      active: true,
      borne_out: null,
    });
    expect(claimOutcome("availability", "out", { played: null })).toEqual({
      active: null,
      borne_out: null,
    });
  });

  it("scores a role claim by a ≥ 10-point snap move the way it said, within two games", () => {
    expect(
      claimOutcome("role", "up", { played: true, snap_before: 0.4, snap_after: 0.52 }),
    ).toEqual({ active: null, borne_out: true });
    expect(
      claimOutcome("role", "up", { played: true, snap_before: 0.4, snap_after: 0.45 }),
    ).toEqual({ active: null, borne_out: false });
    expect(
      claimOutcome("coaching_intent", "down", { played: true, snap_before: 0.7, snap_after: 0.5 }),
    ).toEqual({ active: null, borne_out: true });
    expect(
      claimOutcome("role", "neutral", { played: true, snap_before: 0.4, snap_after: 0.9 }),
    ).toEqual({ active: null, borne_out: null });
    expect(
      claimOutcome("role", "up", { played: true, snap_before: null, snap_after: 0.9 }),
    ).toEqual({ active: null, borne_out: null });
    expect(claimOutcome("role", "up", { played: true })).toEqual({ active: null, borne_out: null });
    expect(
      claimOutcome("role", "up", { played: true, snap_before: Number.NaN, snap_after: 0.5 }),
    ).toEqual({ active: null, borne_out: null });
    expect(claimOutcome("transaction", "up", { played: true })).toEqual({
      active: null,
      borne_out: null,
    });
  });

  it("hand-set: the reliability table's value; the ratio's sign × max(0, logit r)", () => {
    expect(handSetReliability("rss.rotowire", "availability")).toBe(
      RELIABILITY_PRIORS["rss.rotowire"].availability,
    );
    expect(handSetReliability("official.practice", "health")).toBe(0.85);
    expect(handSetReliability("official.practice", "availability")).toBe(0.9);
    expect(handSetLlr("rss.rotowire", "availability", "out")).toBeCloseTo(-Math.log(0.8 / 0.2), 9);
    expect(handSetLlr("rss.rotowire", "availability", "questionable")).toBe(0);
    // a source no better than a coin carries no weight a priori, in either direction
    expect(handSetLlr("user.claim", "availability", "out")).toBeCloseTo(0, 12);
    expect(handSetLlr("user.claim", "availability", "cleared")).toBe(0);
    for (const s of RELIABILITY_SOURCES)
      for (const t of SCORED_CLAIM_TYPES)
        expect(Number.isFinite(handSetLlr(s, t, "up"))).toBe(true);
  });
});

describe("fitLlr — the row ratio's MAP", () => {
  it("returns the prior mean with no data, with the prior's sd", () => {
    expect(fitLlr([], 0.7)).toEqual({ llr: 0.7, sd: 1 });
  });

  it("sets the log-posterior's gradient to zero (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            offset: fc.double({ min: -4, max: 4, noNaN: true }),
            active: fc.boolean(),
            w: fc.integer({ min: 1, max: 50 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        fc.double({ min: -2, max: 2, noNaN: true }),
        (data, mu0) => {
          const { llr, sd } = fitLlr(data, mu0);
          const sig = (x: number): number => 1 / (1 + Math.exp(-x));
          const g =
            -(llr - mu0) +
            data.reduce((a, d) => a + d.w * ((d.active ? 1 : 0) - sig(d.offset + llr)), 0);
          if (Math.abs(llr) < CALIBRATION.maxAbsLlr) expect(Math.abs(g)).toBeLessThan(1e-6);
          expect(sd).toBeGreaterThan(0);
          expect(sd).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("converges where a plain Newton step overshoots (a prior of 1 − eps against an 80 % row)", () => {
    const offset = Math.log(0.99 / 0.01);
    const data = [
      { offset, active: true, w: 800 },
      { offset, active: false, w: 200 },
    ];
    const { llr } = fitLlr(data, 0);
    const p = 1 / (1 + Math.exp(-(offset + llr)));
    expect(p).toBeGreaterThan(0.79);
    expect(p).toBeLessThan(0.81);
  });

  it("reads an unweighted datum as one claim", () => {
    const one = fitLlr([{ offset: 0.3, active: true }], 0);
    expect(one).toEqual(fitLlr([{ offset: 0.3, active: true, w: 1 }], 0));
  });

  it("returns the bracket edge when the data push past it", () => {
    expect(fitLlr([{ offset: -10, active: true, w: 1000 }], 0).llr).toBe(CALIBRATION.maxAbsLlr);
    expect(fitLlr([{ offset: 10, active: false, w: 1000 }], 0).llr).toBe(-CALIBRATION.maxAbsLlr);
  });

  it("moves from the hand-set value toward the data as the count grows", () => {
    const at = (n: number): number =>
      fitLlr(
        [
          { offset: 0, active: true, w: n },
          { offset: 0, active: false, w: n },
        ],
        2,
      ).llr;
    expect(at(1)).toBeGreaterThan(at(10));
    expect(at(10)).toBeGreaterThan(at(1000));
    expect(Math.abs(at(1000))).toBeLessThan(0.01);
  });
});

describe("buildCalibrationTable", () => {
  it("is empty with the hand-set note for no claims", () => {
    expect(EMPTY).toEqual({ rows: [], table_n: 0, n_total: 0, dropped: 0 });
    expect(calibrationStateOf(EMPTY)).toEqual({ table_n: 0, note: HAND_SET_NOTE });
  });

  it("counts text claims in table_n and official claims in n_total only", () => {
    const t = buildCalibrationTable([
      ...textClaims(3),
      claim({ source: "official.practice", type: "health", signal: "practice_full", count: 500 }),
    ]);
    expect(t.table_n).toBe(3);
    expect(t.n_total).toBe(503);
    expect(calibrationStateOf(t).note).toBe(HAND_SET_NOTE);
  });

  it("drops forged records and counts them, never throwing", () => {
    const t = buildCalibrationTable([null, 7, "x", { ...claim(), source: "evil" }, claim()]);
    expect(t.dropped).toBe(4);
    expect(t.n_total).toBe(1);
  });

  it("reads at most maxClaims records (the rest counted as dropped)", () => {
    const many = Array.from({ length: CALIBRATION.maxClaims + 5 }, () => claim());
    const t = buildCalibrationTable(many);
    expect(t.n_total).toBe(CALIBRATION.maxClaims);
    expect(t.dropped).toBe(5);
  });

  it("fits reliability as a Beta posterior around the hand-set value", () => {
    const t = buildCalibrationTable(textClaims(40));
    const row = rowOf(t, "rss.rotowire", "availability", "out", "QUESTIONABLE");
    expect(row).not.toBeNull();
    expect(row?.n).toBe(40);
    expect(row?.k).toBe(30);
    expect(row?.reliability).toBeCloseTo((10 * 0.8 + 30) / 50, 12);
    expect(row?.calibrated).toBe(true);
    expect(rowOf(t, "rss.rotowire", "availability", "out", null)).toBeNull();
  });

  it("splits rows by the prior's status and sorts them by key", () => {
    const t = buildCalibrationTable([
      claim({ prior_status: null, prior_p: 1, active: true, borne_out: false }),
      claim({ prior_status: "QUESTIONABLE" }),
      claim({ prior_status: "PROBABLE" }),
    ]);
    expect(t.rows.map((r) => r.prior_status)).toEqual(["ACTIVE", "OTHER", "QUESTIONABLE"]);
    expect(t.rows.map((r) => r.key)).toEqual([...t.rows.map((r) => r.key)].sort());
  });

  it("never fits on a ruling (prior 0) but still counts its reliability", () => {
    const t = buildCalibrationTable([
      claim({
        prior_status: "OUT",
        prior_p: 0,
        signal: "cleared",
        active: false,
        borne_out: false,
      }),
    ]);
    const row = t.rows[0];
    expect(row?.m).toBe(0);
    expect(row?.n).toBe(1);
    expect(row?.llr).toBe(row?.llr_prior);
  });

  it("weighted records equal the same records repeated (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 40 }), (a, b) => {
        const up = claim({ active: true, borne_out: false });
        const down = claim({ active: false, borne_out: true });
        const counted = buildCalibrationTable([
          { ...up, count: a },
          ...(b > 0 ? [{ ...down, count: b }] : []),
        ]);
        const repeated = buildCalibrationTable([
          ...Array.from({ length: a }, () => up),
          ...Array.from({ length: b }, () => down),
        ]);
        expect(counted.rows[0]?.llr).toBeCloseTo(repeated.rows[0]?.llr ?? Number.NaN, 9);
        expect(counted.rows[0]?.reliability).toBeCloseTo(repeated.rows[0]?.reliability ?? 0, 12);
        expect(counted.n_total).toBe(repeated.n_total);
      }),
      { numRuns: 60 },
    );
  });
});

describe("mergePActive — the posterior P(active)", () => {
  const seeded = buildCalibrationTable(practiceHistoryClaims());

  it("returns the prior unchanged with no applicable item, null for no prior", () => {
    expect(mergePActive(0.71, "QUESTIONABLE", [], seeded)).toBe(0.71);
    expect(mergePActive(null, "QUESTIONABLE", [], seeded)).toBeNull();
    expect(mergePActive(1.5, "QUESTIONABLE", [], seeded)).toBeNull();
    const roleOnly = [
      { source: "rss.rotowire" as const, type: "role" as const, signal: "up" as const, time_ms: 1 },
    ];
    expect(mergePActive(0.71, "QUESTIONABLE", roleOnly, seeded)).toBe(0.71);
  });

  it("never moves an official ruling (prior 0), whatever the evidence (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            source: fc.constantFrom(...CALIBRATION_SOURCES),
            type: fc.constantFrom("availability" as const, "health" as const),
            signal: fc.constantFrom(...DESIGNATIONS, "up" as const, "down" as const),
            time_ms: fc.option(fc.integer({ min: 0, max: 2e12 })),
          }),
          { maxLength: 8 },
        ),
        (ev) => {
          expect(mergePActive(0, "OUT", ev, seeded)).toBe(0);
          const p = mergePActive(0.5, "QUESTIONABLE", ev, seeded);
          expect(p).not.toBeNull();
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reproduces the history's rates through the seeded official rows", () => {
    // a Questionable player who did not practise by Friday played 53 % of the time, 2023–2025
    const q = mergePActive(
      0.71,
      "QUESTIONABLE",
      [{ source: "official.practice", type: "health", signal: "practice_dnp", time_ms: null }],
      seeded,
    );
    expect(q).toBeGreaterThan(0.5);
    expect(q).toBeLessThan(0.56);
    // no designation but a Friday DNP: about 80 %, not the designation-only 1
    const a = mergePActive(
      1,
      null,
      [{ source: "official.practice", type: "health", signal: "practice_dnp", time_ms: null }],
      seeded,
    );
    expect(a).toBeGreaterThan(0.77);
    expect(a).toBeLessThan(0.83);
  });

  it("keeps only the latest item per source (later beats earlier) and weights flagged items 0", () => {
    const out = {
      source: "rss.rotowire" as const,
      type: "availability" as const,
      signal: "out" as const,
    };
    const cleared = { ...out, signal: "cleared" as const };
    const late = mergePActive(
      0.71,
      "QUESTIONABLE",
      [
        { ...out, time_ms: 1000 },
        { ...cleared, time_ms: 2000 },
      ],
      EMPTY,
    );
    const onlyCleared = mergePActive(0.71, "QUESTIONABLE", [{ ...cleared, time_ms: 2000 }], EMPTY);
    expect(late).toBe(onlyCleared);
    expect(late).toBeGreaterThan(0.71);
    expect(mergePActive(0.71, "QUESTIONABLE", [{ ...out, time_ms: 1, weight: 0 }], EMPTY)).toBe(
      0.71,
    );
    // an undated item is older than any dated one of the same source
    expect(
      mergePActive(
        0.71,
        "QUESTIONABLE",
        [
          { ...cleared, time_ms: 5 },
          { ...out, time_ms: null },
        ],
        EMPTY,
      ),
    ).toBe(onlyCleared);
  });

  it("uses the hand-set ratio where the table has no row, the fitted one where it has", () => {
    const item = [
      {
        source: "rss.espn" as const,
        type: "availability" as const,
        signal: "out" as const,
        time_ms: 1,
      },
    ];
    const handSet = mergePActive(0.71, "QUESTIONABLE", item, EMPTY);
    const fitted = buildCalibrationTable(
      textClaims(300, { source: "rss.espn", active: true, borne_out: false }),
    );
    // the table learned that this source's "out" calls were mostly wrong: the posterior rises
    expect(mergePActive(0.71, "QUESTIONABLE", item, fitted)).toBeGreaterThan(handSet ?? 1);
    expect(handSet).toBeLessThan(0.71);
  });
});

describe("evidencePosterior — E10's gate (sib ADV OBJ-21)", () => {
  const prior = { p_active: 0.71, role_shares: { snap_pct: 0.55 } };
  const ev = [
    {
      source: "official.practice" as const,
      type: "health" as const,
      signal: "practice_dnp" as const,
      time_ms: null,
    },
  ];

  it("is null below 200 scored text claims — even with a large calibrated official channel", () => {
    expect(POSTERIOR_MIN_N).toBe(EVIDENCE_POSTERIOR_MIN_N);
    const t = buildCalibrationTable([...practiceHistoryClaims(), ...textClaims(199)]);
    expect(t.table_n).toBe(199);
    expect(calibrationStateOf(t)).toEqual({ table_n: 199, note: HAND_SET_NOTE });
    expect(
      evidencePosterior({ prior, prior_status: "QUESTIONABLE", evidence: ev, table: t }),
    ).toBeNull();
  });

  it("is shown from 200: the note drops and P(active) is merged, role shares passed through", () => {
    const t = buildCalibrationTable([...practiceHistoryClaims(), ...textClaims(200)]);
    expect(calibrationStateOf(t)).toEqual({ table_n: 200, note: null });
    const post = evidencePosterior({ prior, prior_status: "QUESTIONABLE", evidence: ev, table: t });
    expect(post).not.toBeNull();
    expect(post?.role_shares).toEqual({ snap_pct: 0.55 });
    expect(post?.p_active).toBeLessThan(0.71);
    expect(
      evidencePosterior({ prior: null, prior_status: null, evidence: ev, table: t }),
    ).toBeNull();
    expect(
      evidencePosterior({
        prior: { p_active: null, role_shares: null },
        prior_status: null,
        evidence: ev,
        table: t,
      }),
    ).toEqual({ p_active: null, role_shares: null });
  });
});

describe("posteriorEvidenceOf — E10's items for the merge", () => {
  it("drops non-calibration tags, weights flagged items 0, keeps the decay, reads the time", () => {
    const out = posteriorEvidenceOf([
      {
        source: "espn.team.name",
        type: "availability",
        direction: "down",
        designation: "out",
        time: null,
      },
      {
        source: "nflverse.injuries.report_status",
        type: "availability",
        direction: "down",
        designation: "out",
        time: null,
      },
      {
        source: "rss.cbs.title",
        type: "availability",
        direction: "down",
        designation: "out",
        time: "2026-10-09T12:00:00Z",
        flags: ["imperative"],
      },
      {
        source: "espn.player.season_outlook",
        type: "role",
        direction: "up",
        designation: null,
        time: "not a date",
        decay: 0.5,
      },
      {
        source: "nflverse.injuries.practice_status",
        type: "health",
        direction: "up",
        designation: "practice_full",
        time: null,
        decay: Number.NaN,
      },
      {
        source: "user.claim.text",
        type: "availability",
        direction: "up",
        designation: null,
        time: null,
        decay: 7,
      },
    ]);
    expect(out).toEqual([
      {
        source: "rss.cbs",
        type: "availability",
        signal: "out",
        time_ms: Date.parse("2026-10-09T12:00:00Z"),
        weight: 0,
      },
      {
        source: "espn.player.season_outlook",
        type: "role",
        signal: "up",
        time_ms: null,
        weight: 0.5,
      },
      {
        source: "official.practice",
        type: "health",
        signal: "practice_full",
        time_ms: null,
        weight: 0,
      },
      { source: "user.claim", type: "availability", signal: "up", time_ms: null, weight: 1 },
    ]);
  });
});

describe("PRACTICE_REPORT_HISTORY — the seed", () => {
  it("is twelve value-free cells, played ≤ n, and seeds no text claim", () => {
    expect(PRACTICE_REPORT_HISTORY).toHaveLength(12);
    for (const h of PRACTICE_REPORT_HISTORY) {
      expect(Number.isSafeInteger(h.n) && h.n > 0).toBe(true);
      expect(h.played).toBeGreaterThanOrEqual(0);
      expect(h.played).toBeLessThanOrEqual(h.n);
    }
    const t = buildCalibrationTable(practiceHistoryClaims());
    expect(t.table_n).toBe(0);
    expect(t.n_total).toBe(PRACTICE_REPORT_HISTORY.reduce((a, h) => a + h.n, 0));
    expect(t.dropped).toBe(0);
  });
});
