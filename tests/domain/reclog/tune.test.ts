// tune.test.ts — the weekly re-fit (src/domain/reclog/tune.ts; plan 10 §3.3 C9; sib research 05
// §12.5): each fit recovers a planted parameter from synthetic evidence and proposes ONE shrunk step
// toward it; the gates (window floor, value unknown, no move, not held in both halves) each fire;
// the proposal set is hashed and re-validated on read (a tampered set is refused); the tuned-
// parameters document is parsed strictly (fast-check: only TuneDocumentError, never another throw);
// apply and revert plans re-validate every proposal and keep a bounded history.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ParameterProposalSet } from "../../../src/domain/reclog/types.js";
import { PARAMETER_NAME_RE } from "../../../src/domain/reclog/types.js";
import {
  HALF_LIFE_GRID,
  K_GRID,
  MAX_WIRE_PROPOSALS,
  TUNABLE_PARAMETERS,
  TUNED_HISTORY_MAX,
  TUNED_PARAMETERS_MAX_BYTES,
  TuneDocumentError,
  currentValue,
  emptyTunedParameters,
  ewm,
  fitHalfLife,
  fitMatchupBeta,
  fitShrinkK,
  fitWeightEspn,
  halves,
  holds,
  legalValue,
  parseTunedParameters,
  planApply,
  planRevert,
  proposalHash,
  proposeParameterChanges,
  renderPlan,
  roundTo,
  serializeTunedParameters,
  showValue,
  shrinkStep,
  shrunkRate,
  tunable,
  tunedValue,
  validateProposalSet,
  wireProposals,
  type TunedParameters,
} from "../../../src/domain/reclog/tune.js";
import type { PlayerWeekAttribution } from "../../../src/domain/reclog/attribution.js";
import { attributed, lcg } from "./attribution-helpers.js";

const NOW = "2026-10-06T18:00:00.000Z";

/** Share evidence: `n` windows over weeks 1..8, realised = EWM at `hTrue(week)`, model used `hUsed`. */
function shareRows(
  n: number,
  hTrue: (week: number) => number,
  hUsed = 3,
  seed = 1,
): PlayerWeekAttribution[] {
  const r = lcg(seed);
  return Array.from({ length: n }, (_, i) => {
    const week = 1 + (i % 8);
    const history = Array.from({ length: 6 }, () => 0.1 + 0.5 * r());
    return attributed({
      week,
      trace: {
        matchup: null,
        weather_mult: null,
        shares: [
          { name: "target_share", history, half_life: hUsed, realised: ewm(history, hTrue(week)) },
        ],
        rates: [],
      },
    });
  });
}

/** Rate evidence: realised = the rate shrunk with `kTrue`; the model used `kUsed`. */
function rateRows(n: number, kTrue: number, kUsed = 200, seed = 2): PlayerWeekAttribution[] {
  const r = lcg(seed);
  return Array.from({ length: n }, (_, i) => {
    const nObs = 10 + Math.floor(190 * r());
    const observed = 3 + 3 * r();
    return attributed({
      week: 1 + (i % 8),
      trace: {
        matchup: null,
        weather_mult: null,
        shares: [],
        rates: [
          {
            name: "yards_per_carry",
            n_obs: nObs,
            observed,
            prior: 4.2,
            k: kUsed,
            realised: shrunkRate(nObs, observed, 4.2, kTrue),
            realised_n: 10,
          },
        ],
      },
    });
  });
}

/** Matchup evidence: realised engine points = base·(1 + βtrue·z); the model used βused. */
function matchupRows(
  n: number,
  betaTrue: number,
  betaUsed = 0.2,
  position = "RB",
  seed = 3,
): PlayerWeekAttribution[] {
  const r = lcg(seed);
  return Array.from({ length: n }, (_, i) => {
    const base = 5 + 15 * r();
    const z = -1 + 2 * r();
    return attributed({
      week: 1 + (i % 8),
      position,
      expected_points: base * (1 + betaUsed * z),
      realised_engine: base * (1 + betaTrue * z),
      trace: { matchup: { z, beta: betaUsed }, weather_mult: null, shares: [], rates: [] },
    });
  });
}

/** Paired evidence: the truth is the model's mean (`modelTruth`) or ESPN's. */
function weightRows(n: number, modelTruth: boolean, seed = 4): PlayerWeekAttribution[] {
  const r = lcg(seed);
  return Array.from({ length: n }, (_, i) => {
    const y = 4 + 16 * r();
    const noise = (r() - 0.5) * 10;
    return attributed({
      week: 1 + (i % 8),
      realised_points: y,
      model_mean: modelTruth ? y : y + noise,
      espn_mean: modelTruth ? y + noise : y,
    });
  });
}

describe("the registry", () => {
  it("names satisfy the wire grammar (≤ 40 chars), bounds are ordered, every fit is known", () => {
    expect(TUNABLE_PARAMETERS).toHaveLength(14);
    const names = new Set<string>();
    for (const p of TUNABLE_PARAMETERS) {
      expect(p.name).toMatch(PARAMETER_NAME_RE);
      expect(p.name.length).toBeLessThanOrEqual(40);
      expect(p.min).toBeLessThan(p.max);
      expect(p.max_step).toBeGreaterThan(0);
      expect(p.min_evidence).toBeGreaterThanOrEqual(100);
      expect(names.has(p.name)).toBe(false);
      names.add(p.name);
      expect(tunable(p.name)).toBe(p);
    }
    expect(tunable("__proto__")).toBeUndefined();
    expect(tunable(7 as unknown as string)).toBeUndefined();
  });

  it("legalValue, roundTo, shrinkStep and showValue", () => {
    const h = tunable("ewm_half_life_games");
    const k = tunable("shrink_k.catch_rate");
    const w = tunable("weight_espn");
    if (h === undefined || k === undefined || w === undefined) throw new Error("registry");
    expect(legalValue(h, 0.5)).toBe(false);
    expect(legalValue(h, Number.NaN)).toBe(false);
    expect(legalValue(h, "3")).toBe(false);
    expect(roundTo(h, 4.26)).toBe(4.5);
    expect(roundTo(k, 597.3)).toBe(600);
    // log: shrunk in log space, capped at ×2, clamped to [1, 5000]
    expect(shrinkStep(k, 200, 5000, 1e9)).toBe(400);
    expect(shrinkStep(k, 4000, 5000, 1e9)).toBe(5000);
    expect(shrinkStep(k, 2, 1, 1e9)).toBe(1);
    // linear: capped at one step
    expect(shrinkStep(h, 3, 8, 1e9)).toBe(4);
    expect(shrinkStep(w, 1, 0.5, 1)).toBe(0.75);
    expect(showValue(null)).toBe("model default");
    expect(showValue(0.3)).toBe("0.3");
  });

  it("ewm and shrunkRate", () => {
    expect(ewm([1], 3)).toBe(1);
    expect(ewm([0, 1], 1)).toBeCloseTo(1 / 1.5, 12);
    expect(shrunkRate(0, 9, 4, 10)).toBe(4);
    expect(shrunkRate(100, 5, 4, 100)).toBe(4.5);
    expect(HALF_LIFE_GRID[0]).toBe(1);
    expect(HALF_LIFE_GRID.at(-1)).toBe(8);
    expect(K_GRID[0]).toBeCloseTo(1, 12);
    expect(K_GRID.at(-1)).toBeCloseTo(5000, 6);
  });

  it("currentValue: the applied override wins, else the newest week's reported value", () => {
    expect(currentValue(0.4, [{ week: 9, value: 0.2 }])).toBe(0.4);
    expect(
      currentValue(null, [
        { week: 2, value: 0.1 },
        { week: 9, value: 0.2 },
        { week: 4, value: 0.3 },
      ]),
    ).toBe(0.2);
    expect(currentValue(null, [])).toBeNull();
  });

  it("halves and holds", () => {
    expect(halves([])).toBeNull();
    expect(
      halves([
        { week: 3, x: 1 },
        { week: 3, x: 2 },
      ]),
    ).toBeNull();
    const h = halves([1, 2, 3, 4].map((w) => ({ week: w, x: w })));
    expect(h?.[0].map((i) => i.week)).toEqual([1, 2]);
    const items = [1, 2, 3, 4].map((w) => ({ week: w, x: w }));
    // proposed better overall but worse in the late half → not held
    const r = holds(items, (xs, which) =>
      which === "current" ? xs.length : xs.reduce((s, i) => s + (i.x <= 2 ? 0 : 1.5), 0),
    );
    expect(r.ok).toBe(false);
    expect(holds(items, (xs, which) => (which === "current" ? 2 : 1)).ok).toBe(true);
    expect(holds([{ week: 1, x: 1 }], (_xs, which) => (which === "current" ? 2 : 1)).ok).toBe(true);
  });
});

describe("ewm_half_life_games", () => {
  it("recovers h = 5 and proposes one step from 3 (shrunk 0.8, capped at 1)", () => {
    const r = fitHalfLife(
      shareRows(400, () => 5),
      null,
    );
    expect(r.evaluation).toMatchObject({
      outcome: "proposed",
      current: 3,
      fitted: 5,
      evidence_n: 400,
    });
    expect(r.proposal).toMatchObject({ parameter: "ewm_half_life_games", current: 3, proposed: 4 });
    expect(r.proposal?.loss_proposed).toBeLessThan(r.proposal?.loss_current ?? 0);
  });

  it("the applied override is the value in effect", () => {
    const r = fitHalfLife(
      shareRows(400, () => 5, 3),
      4,
    );
    expect(r.proposal).toMatchObject({ current: 4, proposed: 5 });
  });

  it("no change when the data says the value in effect", () => {
    expect(
      fitHalfLife(
        shareRows(400, () => 3),
        null,
      ).evaluation.outcome,
    ).toBe("no_change");
  });

  it("not held when the gain is concentrated in half the window", () => {
    const r = fitHalfLife(
      shareRows(400, (w) => (w <= 4 ? 8 : 3)),
      null,
    );
    expect(r.evaluation.outcome).toBe("not_held");
    expect(r.proposal).toBeNull();
  });

  it("the window floor and an unknown value in effect", () => {
    expect(
      fitHalfLife(
        shareRows(60, () => 5),
        null,
      ).evaluation.outcome,
    ).toBe("n_too_small");
    expect(fitHalfLife([], null).evaluation).toMatchObject({
      outcome: "current_unknown",
      evidence_n: 0,
    });
    expect(fitHalfLife([], 3).evaluation.outcome).toBe("n_too_small");
    // an out-of-bounds applied value is never "in effect"
    expect(
      fitHalfLife(
        shareRows(400, () => 5),
        99,
      ).evaluation.outcome,
    ).toBe("current_unknown");
  });

  it("windows without a realised share are not evidence", () => {
    const rows = shareRows(400, () => 5).map((r) =>
      attributed({
        ...r,
        trace: r.trace && {
          ...r.trace,
          shares: r.trace.shares.map((s) => ({ ...s, realised: null })),
        },
      }),
    );
    expect(fitHalfLife(rows, null).evaluation.evidence_n).toBe(0);
  });
});

describe("shrink_k.<rate>", () => {
  it("recovers a larger k and proposes one ×2 step", () => {
    const r = fitShrinkK(rateRows(400, 800), "yards_per_carry", null);
    expect(r.evaluation.outcome).toBe("proposed");
    expect(r.evaluation.fitted).toBeGreaterThan(600);
    expect(r.proposal).toMatchObject({
      parameter: "shrink_k.yards_per_carry",
      current: 200,
      proposed: 400,
    });
  });

  it("a smaller k proposes ÷2; another rate's evidence is not this rate's", () => {
    expect(fitShrinkK(rateRows(400, 20), "yards_per_carry", null).proposal?.proposed).toBe(100);
    expect(fitShrinkK(rateRows(400, 800), "catch_rate", null).evaluation).toMatchObject({
      outcome: "current_unknown",
      evidence_n: 0,
    });
  });

  it("realised_n 0 is no evidence", () => {
    const rows = rateRows(400, 800).map((r) =>
      attributed({
        ...r,
        trace: r.trace && {
          ...r.trace,
          rates: r.trace.rates.map((t) => ({ ...t, realised_n: 0 })),
        },
      }),
    );
    expect(fitShrinkK(rows, "yards_per_carry", null).evaluation.evidence_n).toBe(0);
  });
});

describe("matchup_beta.<POS>", () => {
  it("recovers β = 0.6 exactly and proposes 0.2 → 0.3 (one step)", () => {
    const r = fitMatchupBeta(matchupRows(300, 0.6), "RB", null);
    expect(r.evaluation.fitted).toBeCloseTo(0.6, 9);
    expect(r.proposal).toMatchObject({ parameter: "matchup_beta.RB", current: 0.2, proposed: 0.3 });
  });

  it("only active rows of that position with a matchup trace are evidence", () => {
    const rows = [
      ...matchupRows(300, 0.6, 0.2, "WR"),
      ...matchupRows(50, 0.6).map((r) => attributed({ ...r, active: false })),
      ...matchupRows(50, 0.6).map((r) => attributed({ ...r, trace: null })),
      ...matchupRows(50, 0.6).map((r) => attributed({ ...r, expected_points: 0 })),
    ];
    expect(fitMatchupBeta(rows, "RB", null).evaluation.evidence_n).toBe(0);
    expect(fitMatchupBeta(rows, "WR", null).proposal?.proposed).toBe(0.3);
  });

  it("β shrinks toward 0 when the matchup does not predict, never below 0", () => {
    const r = fitMatchupBeta(matchupRows(300, -0.5, 0.05), "RB", null);
    expect(r.proposal?.proposed).toBe(0);
  });

  it("z = 0 everywhere leaves β unfitted (n too small)", () => {
    const rows = matchupRows(300, 0.6).map((r) =>
      attributed({
        ...r,
        trace: { matchup: { z: 0, beta: 0.2 }, weather_mult: null, shares: [], rates: [] },
      }),
    );
    expect(fitMatchupBeta(rows, "RB", null).evaluation).toMatchObject({
      outcome: "n_too_small",
      fitted: null,
    });
  });
});

describe("weight_espn (plan 07 E1, ADV OBJ-02)", () => {
  it("moves one 0.25 step toward the mixture only when it beats ESPN alone in both halves", () => {
    const r = fitWeightEspn(weightRows(400, true), null, 1);
    expect(r.evaluation.fitted).toBe(0.5);
    expect(r.proposal).toMatchObject({ parameter: "weight_espn", current: 1, proposed: 0.75 });
    expect(fitWeightEspn(weightRows(400, true), 0.75, 1).proposal?.proposed).toBe(0.5);
  });

  it("stays at 1.0 when ESPN is the better forecast; needs ≥ 300 paired weeks", () => {
    expect(fitWeightEspn(weightRows(400, false), null, 1).evaluation.outcome).toBe("no_change");
    expect(fitWeightEspn(weightRows(200, true), null, 1).evaluation.outcome).toBe("n_too_small");
    expect(
      fitWeightEspn(
        weightRows(400, true).map((r) => attributed({ ...r, espn_mean: null })),
        null,
        1,
      ).evaluation.evidence_n,
    ).toBe(0);
  });

  it("moves back up toward 1.0 when ESPN wins again", () => {
    expect(fitWeightEspn(weightRows(400, false), 0.5, 1).proposal).toMatchObject({
      current: 0.5,
      proposed: 0.75,
    });
  });

  it("an illegal shipped weight is unknown", () => {
    expect(fitWeightEspn(weightRows(400, true), null, 0.2).evaluation.outcome).toBe(
      "current_unknown",
    );
  });
});

describe("the proposal set", () => {
  const rows = [...shareRows(400, () => 5), ...matchupRows(300, 0.6), ...rateRows(400, 800)];
  const set = proposeParameterChanges({
    rows,
    tuned: null,
    weight_espn: 1,
    season: 2026,
    week: 5,
    created_at: NOW,
  });

  it("evaluates every registry parameter in order and hashes its proposals", () => {
    expect(set.evaluated.map((e) => e.parameter)).toEqual(TUNABLE_PARAMETERS.map((p) => p.name));
    expect(set.proposals.map((p) => p.parameter)).toEqual([
      "ewm_half_life_games",
      "shrink_k.yards_per_carry",
      "matchup_beta.RB",
    ]);
    expect(set.hash).toBe(proposalHash(2026, 5, set.proposals));
    expect(set.window).toEqual({ first_week: 1, last_week: 5 });
    expect(set.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the applied overrides are the values in effect", () => {
    const tuned: TunedParameters = {
      ...emptyTunedParameters(),
      values: { "matchup_beta.RB": 0.3 },
    };
    const s = proposeParameterChanges({
      rows,
      tuned,
      weight_espn: 1,
      season: 2026,
      week: 5,
      created_at: NOW,
    });
    expect(s.proposals.find((p) => p.parameter === "matchup_beta.RB")).toMatchObject({
      current: 0.3,
      proposed: 0.4,
    });
  });

  it("an empty window is a valid empty set", () => {
    const s = proposeParameterChanges({
      rows: [],
      tuned: null,
      weight_espn: 1,
      season: 2026,
      week: 3,
      created_at: NOW,
    });
    expect(s.proposals).toEqual([]);
    expect(s.window).toEqual({ first_week: 3, last_week: 3 });
    expect(wireProposals(s)).toEqual([]);
    expect(wireProposals(null)).toEqual([]);
  });

  it("the wire carries at most MAX_WIRE_PROPOSALS, as ParameterChange", () => {
    const fat: ParameterProposalSet = {
      ...set,
      proposals: TUNABLE_PARAMETERS.map((p) => ({
        parameter: p.name,
        current: p.min,
        proposed: p.min,
        evidence_n: 1,
        fit: p.fit,
        loss_current: 1,
        loss_proposed: 0,
      })),
    };
    const w = wireProposals(fat);
    expect(w).toHaveLength(MAX_WIRE_PROPOSALS);
    expect(Object.keys(w[0] ?? {}).sort()).toEqual([
      "current",
      "evidence_n",
      "parameter",
      "proposed",
    ]);
  });

  it("validateProposalSet round-trips a real set and refuses a tampered one", () => {
    expect(validateProposalSet(JSON.parse(JSON.stringify(set)))).toEqual(set);
    const edited = JSON.parse(JSON.stringify(set)) as { proposals: { proposed: number }[] };
    const first = edited.proposals[0];
    if (first) first.proposed = 5;
    expect(validateProposalSet(edited)).toBeNull();
  });

  it.each([
    ["schema", { schema: 2 }],
    ["created_at", { created_at: "yesterday" }],
    ["season", { season: 1999 }],
    ["week", { week: 19 }],
    ["window", { window: null }],
    ["hash", { hash: "ABC" }],
    ["proposals", { proposals: "none" }],
    ["evaluated", { evaluated: {} }],
  ])("refuses a bad %s", (_name, over) => {
    expect(validateProposalSet({ ...JSON.parse(JSON.stringify(set)), ...over })).toBeNull();
  });

  it("refuses unknown, duplicate, out-of-bounds or mistyped proposals and evaluations", () => {
    const base = JSON.parse(JSON.stringify(set)) as ParameterProposalSet;
    const p0 = base.proposals[0];
    if (!p0) throw new Error("no proposal");
    const variants: unknown[] = [
      { ...base, proposals: [{ ...p0, parameter: "steal_cookies" }] },
      { ...base, proposals: [p0, p0] },
      { ...base, proposals: [{ ...p0, proposed: 99 }] },
      { ...base, proposals: [{ ...p0, fit: "weight_espn" }] },
      { ...base, proposals: [{ ...p0, evidence_n: -1 }] },
      { ...base, proposals: [{ ...p0, loss_current: Number.NaN }] },
      { ...base, proposals: [null] },
      { ...base, evaluated: [{ ...base.evaluated[0], outcome: "maybe" }] },
      { ...base, evaluated: [{ ...base.evaluated[0], current: 99 }] },
      { ...base, evaluated: [null] },
      null,
      "set",
    ];
    for (const v of variants) expect(validateProposalSet(v)).toBeNull();
  });

  it("never throws on arbitrary input (property)", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(() => validateProposalSet(v)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

describe("the tuned-parameters document", () => {
  const doc: TunedParameters = {
    schema: 1,
    updated_at: NOW,
    values: { weight_espn: 0.75, "matchup_beta.RB": 0.3 },
    history: [
      {
        applied_at: NOW,
        source: "proposal",
        proposal_hash: "a".repeat(64),
        changes: [{ parameter: "weight_espn", before: null, after: 0.75 }],
      },
    ],
  };

  it("round-trips, with sorted value keys and a trailing newline", () => {
    const text = serializeTunedParameters(doc);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.indexOf("matchup_beta.RB")).toBeLessThan(text.indexOf("weight_espn"));
    expect(parseTunedParameters(text)).toEqual(doc);
    expect(parseTunedParameters(serializeTunedParameters(emptyTunedParameters()))).toEqual(
      emptyTunedParameters(),
    );
  });

  it.each([
    ["invalid JSON", "{"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["an unknown key", JSON.stringify({ ...doc, extra: 1 })],
    ["a schema 2", JSON.stringify({ ...doc, schema: 2 })],
    ["a bad updated_at", JSON.stringify({ ...doc, updated_at: "now" })],
    ["values not an object", JSON.stringify({ ...doc, values: [] })],
    ["an unknown parameter", JSON.stringify({ ...doc, values: { exfiltrate: 1 } })],
    [
      "a __proto__ parameter",
      '{"schema":1,"updated_at":null,"values":{"__proto__":1},"history":[]}',
    ],
    ["an out-of-bounds value", JSON.stringify({ ...doc, values: { weight_espn: 0.1 } })],
    ["a string value", JSON.stringify({ ...doc, values: { weight_espn: "1" } })],
    ["history not an array", JSON.stringify({ ...doc, history: {} })],
    [
      "a bad history source",
      JSON.stringify({ ...doc, history: [{ ...doc.history[0], source: "model" }] }),
    ],
    [
      "a bad history hash",
      JSON.stringify({ ...doc, history: [{ ...doc.history[0], proposal_hash: "zz" }] }),
    ],
    [
      "a history change on an unknown parameter",
      JSON.stringify({
        ...doc,
        history: [{ ...doc.history[0], changes: [{ parameter: "x", before: null, after: 1 }] }],
      }),
    ],
    [
      "a history change out of bounds",
      JSON.stringify({
        ...doc,
        history: [
          { ...doc.history[0], changes: [{ parameter: "weight_espn", before: null, after: 7 }] },
        ],
      }),
    ],
    ["a history entry that is not an object", JSON.stringify({ ...doc, history: [1] })],
    [
      "a change that is not an object",
      JSON.stringify({ ...doc, history: [{ ...doc.history[0], changes: [1] }] }),
    ],
    [
      "too long a history",
      JSON.stringify({
        ...doc,
        history: Array.from({ length: TUNED_HISTORY_MAX + 1 }, () => doc.history[0]),
      }),
    ],
  ])("refuses %s with a TuneDocumentError", (_name, text) => {
    expect(() => parseTunedParameters(text)).toThrow(TuneDocumentError);
  });

  it("refuses a document over the size bound", () => {
    expect(() => parseTunedParameters(" ".repeat(TUNED_PARAMETERS_MAX_BYTES + 1))).toThrow(
      /too large/,
    );
  });

  it("only ever throws TuneDocumentError (property)", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.jsonValue().map((v) => JSON.stringify(v)),
        ),
        (text) => {
          try {
            parseTunedParameters(text);
          } catch (e) {
            expect(e).toBeInstanceOf(TuneDocumentError);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("tunedValue: an own value or null", () => {
    expect(tunedValue(doc, "weight_espn")).toBe(0.75);
    expect(tunedValue(doc, "ewm_half_life_games")).toBeNull();
    expect(tunedValue(null, "weight_espn")).toBeNull();
    expect(tunedValue(doc, "constructor")).toBeNull();
  });
});

describe("apply and revert plans", () => {
  const set = (proposals: ParameterProposalSet["proposals"]): ParameterProposalSet => ({
    schema: 1,
    created_at: NOW,
    season: 2026,
    week: 5,
    window: { first_week: 1, last_week: 5 },
    proposals,
    evaluated: [],
    hash: proposalHash(2026, 5, proposals),
  });
  const prop = (parameter: string, current: number, proposed: number) => ({
    parameter,
    current,
    proposed,
    evidence_n: 300,
    fit: (tunable(parameter)?.fit ?? "weight_espn") as "weight_espn",
    loss_current: 2,
    loss_proposed: 1,
  });

  it("applies a valid set, records the history, and renders the diff", () => {
    const p = planApply(
      emptyTunedParameters(),
      set([prop("matchup_beta.RB", 0.2, 0.3), prop("weight_espn", 1, 0.75)]),
      NOW,
    );
    expect(p.changes.map((c) => [c.parameter, c.before, c.after])).toEqual([
      ["matchup_beta.RB", null, 0.3],
      ["weight_espn", null, 0.75],
    ]);
    expect(p.next.values).toEqual({ "matchup_beta.RB": 0.3, weight_espn: 0.75 });
    expect(p.next.history).toHaveLength(1);
    expect(p.next.history[0]?.proposal_hash).toBe(p.proposal_hash);
    expect(renderPlan(p)).toEqual([
      "  matchup_beta.RB: 0.2 (model default) -> 0.3  [evidence n=300]",
      "  weight_espn: 1 (model default) -> 0.75  [evidence n=300]",
    ]);
    expect(parseTunedParameters(serializeTunedParameters(p.next))).toEqual(p.next);
  });

  it("refuses stale, oversized, unknown and out-of-bounds proposals; skips an applied one", () => {
    const doc: TunedParameters = {
      ...emptyTunedParameters(),
      values: { "matchup_beta.RB": 0.25, weight_espn: 0.75 },
    };
    const p = planApply(
      doc,
      set([
        prop("matchup_beta.RB", 0.2, 0.3),
        prop("matchup_beta.WR", 0.2, 0.5),
        prop("bogus", 1, 2),
        prop("ewm_half_life_games", 3, 9),
        prop("weight_espn", 1, 0.75),
        prop("matchup_beta.TE", 0.2, 0.2),
      ]),
      NOW,
    );
    expect(p.refused).toEqual([
      { parameter: "matchup_beta.RB", reason: "stale_current" },
      { parameter: "matchup_beta.WR", reason: "step_too_large" },
      { parameter: "bogus", reason: "unknown_parameter" },
      { parameter: "ewm_half_life_games", reason: "out_of_bounds" },
    ]);
    expect(p.changes).toEqual([]);
    expect(p.next).toBe(doc);
    expect(renderPlan(p)).toContain("  matchup_beta.RB: not applied (stale current)");
  });

  it("a log parameter's step is a factor", () => {
    const ok = planApply(emptyTunedParameters(), set([prop("shrink_k.catch_rate", 200, 400)]), NOW);
    expect(ok.changes).toHaveLength(1);
    const big = planApply(
      emptyTunedParameters(),
      set([prop("shrink_k.catch_rate", 200, 401)]),
      NOW,
    );
    expect(big.refused[0]?.reason).toBe("step_too_large");
  });

  it("history is bounded (oldest dropped)", () => {
    let doc = emptyTunedParameters();
    for (let i = 0; i < TUNED_HISTORY_MAX + 5; i++) {
      const cur = tunedValue(doc, "weight_espn") ?? 1;
      const next = cur === 1 ? 0.75 : 1;
      doc = planApply(doc, set([prop("weight_espn", cur, next)]), NOW).next;
    }
    expect(doc.history).toHaveLength(TUNED_HISTORY_MAX);
    expect(parseTunedParameters(serializeTunedParameters(doc))).toEqual(doc);
  });

  it("revert undoes the last entry; a second revert re-applies it; stale values are refused", () => {
    const applied = planApply(
      emptyTunedParameters(),
      set([prop("weight_espn", 1, 0.75)]),
      NOW,
    ).next;
    const r1 = planRevert(applied, NOW);
    expect(r1.changes).toEqual([
      {
        parameter: "weight_espn",
        before: 0.75,
        after: null,
        effective_before: 0.75,
        evidence_n: null,
      },
    ]);
    expect(r1.next.values).toEqual({});
    expect(r1.next.history.at(-1)?.source).toBe("revert");
    expect(renderPlan(r1)).toEqual(["  weight_espn: 0.75 -> model default"]);
    const r2 = planRevert(r1.next, NOW);
    expect(r2.next.values).toEqual({ weight_espn: 0.75 });
    const tampered: TunedParameters = { ...applied, values: { weight_espn: 0.5 } };
    expect(planRevert(tampered, NOW).refused).toEqual([
      { parameter: "weight_espn", reason: "stale_current" },
    ]);
    expect(planRevert(emptyTunedParameters(), NOW)).toMatchObject({ changes: [], refused: [] });
  });

  it("every applied plan's document stays within bounds (property)", () => {
    const names = TUNABLE_PARAMETERS.map((p) => p.name);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            parameter: fc.constantFrom(...names, "nope"),
            current: fc.double({ min: -10, max: 6000, noNaN: true }),
            proposed: fc.double({ min: -10, max: 6000, noNaN: true }),
          }),
          { maxLength: 14 },
        ),
        (ps) => {
          const p = planApply(
            emptyTunedParameters(),
            set(ps.map((x) => prop(x.parameter, x.current, x.proposed))),
            NOW,
          );
          for (const [k, v] of Object.entries(p.next.values)) {
            const reg = tunable(k);
            expect(reg).toBeDefined();
            if (reg) expect(legalValue(reg, v)).toBe(true);
          }
          expect(() => parseTunedParameters(serializeTunedParameters(p.next))).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });
});
