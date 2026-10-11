// phase3-repos.test.ts — the Phase 3 records (src/store/repos/phase3.ts; migration 002; plan 10 §3.3):
// `parameter_proposal` stores only sets the registry validates, idempotently per hash, and serves the
// newest per league-season (C9 — what `eff tune` reads); `waiver_run` upserts one row per processing
// run, the newest call winning, bounded, corrupt rows skipped (C5); `scored_claim` logs a claim once,
// scores it once, and reads the scored rows back through the calibration table's own defensive
// reader (C8); the projection row's attribution columns round-trip and a corrupt trace reads as none.
// League ids are the fake "0"; every value is invented.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposalHash } from "../../src/domain/reclog/tune.js";
import type { LoggedClaim, ParameterProposalSet } from "../../src/domain/reclog/types.js";
import { claimKeyOf, WAIVER_RUN_SURPLUS_MAX } from "../../src/store/repos/phase3.js";
import { storeInternalsOf } from "../../src/store/store.js";
import type { Store } from "../../src/store/types.js";
import { openStore, T0, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache("eff-p3-");
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const L = "0";

function proposalSet(over: Partial<ParameterProposalSet> = {}): ParameterProposalSet {
  const proposals: ParameterProposalSet["proposals"] = [
    {
      parameter: "matchup_beta.RB",
      current: 0.2,
      proposed: 0.3,
      evidence_n: 300,
      fit: "matchup_beta",
      loss_current: 9,
      loss_proposed: 8,
    },
  ];
  const base = {
    schema: 1 as const,
    created_at: T0,
    season: 2026,
    week: 4,
    window: { first_week: 1, last_week: 4 },
    proposals,
    evaluated: [],
    ...over,
  };
  return { ...base, hash: proposalHash(base.season, base.week, base.proposals) };
}

describe("parameter_proposal (C9)", () => {
  it("stores a valid set once per hash and serves the newest per league-season", () => {
    expect(s.repos.parameterProposals.latest(L, 2026)).toBeNull();
    const a = proposalSet();
    s.repos.parameterProposals.put(L, a);
    s.repos.parameterProposals.put(L, a); // idempotent
    const b = proposalSet({ week: 5, created_at: "2026-10-13T12:00:00.000Z" });
    s.repos.parameterProposals.put(L, b);
    expect(s.repos.parameterProposals.latest(L, 2026)).toEqual(b);
    expect(s.repos.parameterProposals.latest(L, 2025)).toBeNull();
    expect(s.repos.parameterProposals.latest("1", 2026)).toBeNull();
    const db = storeInternalsOf(s)?.db;
    const n = db?.prepare("SELECT COUNT(*) AS n FROM parameter_proposal").get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("refuses a set the registry would refuse (forged hash, unknown parameter, bad league id)", () => {
    const good = proposalSet();
    expect(() => {
      s.repos.parameterProposals.put(L, { ...good, hash: "f".repeat(64) });
    }).toThrow(RangeError);
    const forged = {
      ...good,
      proposals: [{ ...good.proposals[0], parameter: "ignore_previous_instructions" }],
    } as unknown as ParameterProposalSet;
    expect(() => {
      s.repos.parameterProposals.put(L, forged);
    }).toThrow(RangeError);
    expect(() => {
      s.repos.parameterProposals.put("x' OR 1=1", good);
    }).toThrow(RangeError);
    expect(() => s.repos.parameterProposals.latest("01", 2026)).toThrow(RangeError);
    expect(s.repos.parameterProposals.latest(L, 2026)).toBeNull();
  });
});

describe("waiver_run (C5)", () => {
  it("upserts one row per run (the newest call wins) and lists a season oldest first", () => {
    const run = (at: string, W: number, surplus: number[]) => ({
      season: 2026,
      run_at: at,
      W,
      surplus,
    });
    expect(s.repos.waiverRuns.list(L, 2026)).toEqual([]);
    expect(s.repos.waiverRuns.put(L, run("2026-10-08T07:00:00.000Z", 12, [1, 2]), T0).written).toBe(
      true,
    );
    s.repos.waiverRuns.put(L, run("2026-10-01T07:00:00.000Z", 13, [0.5]), T0);
    // a second call before the same run replaces its row
    s.repos.waiverRuns.put(L, run("2026-10-08T07:00:00.000Z", 12, [3, 4, 5]), T0);
    s.repos.waiverRuns.put(L, { ...run("2026-10-08T07:00:00.000Z", 12, [9]), season: 2025 }, T0);
    expect(s.repos.waiverRuns.list(L, 2026)).toEqual([
      run("2026-10-01T07:00:00.000Z", 13, [0.5]),
      run("2026-10-08T07:00:00.000Z", 12, [3, 4, 5]),
    ]);
    expect(s.repos.waiverRuns.list("1", 2026)).toEqual([]);
  });

  it("refuses out-of-range input and skips a corrupt stored row", () => {
    const ok = { season: 2026, run_at: T0, W: 12, surplus: [1] };
    expect(() => s.repos.waiverRuns.put(L, { ...ok, W: -1 }, T0)).toThrow(RangeError);
    expect(() => s.repos.waiverRuns.put(L, { ...ok, W: Number.NaN }, T0)).toThrow(RangeError);
    expect(() => s.repos.waiverRuns.put(L, { ...ok, run_at: "soon" }, T0)).toThrow(RangeError);
    expect(() => s.repos.waiverRuns.put(L, { ...ok, surplus: [Infinity] }, T0)).toThrow(RangeError);
    expect(() =>
      s.repos.waiverRuns.put(
        L,
        { ...ok, surplus: Array.from({ length: WAIVER_RUN_SURPLUS_MAX + 1 }, () => 1) },
        T0,
      ),
    ).toThrow(RangeError);
    s.repos.waiverRuns.put(L, ok, T0);
    storeInternalsOf(s)?.db.prepare("UPDATE waiver_run SET surplus_json = '[\"x\"]'").run();
    expect(s.repos.waiverRuns.list(L, 2026)).toEqual([]);
  });
});

describe("scored_claim (C8)", () => {
  const claim = (over: Partial<LoggedClaim> = {}): LoggedClaim => ({
    season: 2026,
    week: 5,
    player_id: 101,
    claim: {
      source: "rss.rotowire",
      type: "availability",
      signal: "questionable",
      prior_status: "QUESTIONABLE",
      prior_p: 0.71,
    },
    ...over,
  });

  it("logs once, lists the pending, scores once, reads the scored rows back", () => {
    s.repos.scoredClaims.log(L, claim(), T0);
    s.repos.scoredClaims.log(L, claim(), T0); // idempotent
    s.repos.scoredClaims.log(L, claim({ player_id: 102 }), T0);
    s.repos.scoredClaims.log(L, claim({ week: 6 }), T0);
    const pending = s.repos.scoredClaims.pending(L, 2026, 5);
    expect(pending.map((p) => p.player_id)).toEqual([101, 102]);
    expect(pending[0]?.key).toBe(claimKeyOf(L, claim()));
    expect(s.repos.scoredClaims.scored(L, 100)).toEqual([]);
    const k = pending[0]?.key ?? "";
    s.repos.scoredClaims.score(k, { active: true, borne_out: false }, T0);
    // a second scoring of the same key changes nothing
    s.repos.scoredClaims.score(k, { active: false, borne_out: true }, T0);
    expect(s.repos.scoredClaims.pending(L, 2026, 5).map((p) => p.player_id)).toEqual([102]);
    const scored = s.repos.scoredClaims.scored(L, 100);
    expect(scored).toHaveLength(1);
    expect(scored[0]).toMatchObject({
      source: "rss.rotowire",
      type: "availability",
      signal: "questionable",
      prior_status: "QUESTIONABLE",
      prior_p: 0.71,
      active: true,
      borne_out: false,
    });
    expect(s.repos.scoredClaims.scored("1", 100)).toEqual([]);
  });

  it("refuses a claim the calibration reader would drop; a forged stored row is skipped on read", () => {
    const bad = claim();
    expect(() =>
      s.repos.scoredClaims.log(
        L,
        { ...bad, claim: { ...bad.claim, source: "league.member" as never } },
        T0,
      ),
    ).toThrow(RangeError);
    expect(() =>
      s.repos.scoredClaims.log(L, { ...bad, claim: { ...bad.claim, prior_p: 1.5 } }, T0),
    ).toThrow(RangeError);
    expect(() => s.repos.scoredClaims.log(L, { ...bad, player_id: 0 }, T0)).toThrow(RangeError);
    expect(() => s.repos.scoredClaims.score("nope", { active: true, borne_out: null }, T0)).toThrow(
      RangeError,
    );
    s.repos.scoredClaims.log(L, bad, T0);
    const k = s.repos.scoredClaims.pending(L, 2026, 5)[0]?.key ?? "";
    s.repos.scoredClaims.score(k, { active: true, borne_out: true }, T0);
    storeInternalsOf(s)
      ?.db.prepare('UPDATE scored_claim SET claim_json = \'{"source":"anything"}\'')
      .run();
    expect(s.repos.scoredClaims.scored(L, 100)).toEqual([]);
  });

  it("property: the key is a pure function of league, player-week, source, type and signal", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 1, max: 18 }), (p, w) => {
        const a = claim({ player_id: p, week: w });
        const b = claim({ player_id: p, week: w, claim: { ...a.claim, prior_p: 0.5 } });
        expect(claimKeyOf(L, a)).toBe(claimKeyOf(L, b));
        expect(claimKeyOf(L, a)).not.toBe(claimKeyOf("1", a));
        expect(claimKeyOf(L, a)).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 50 },
    );
  });
});

describe("projection's attribution columns (C9)", () => {
  const base = {
    player_id: 7,
    gsis_id: "00-9000101",
    season: 2026,
    week: 5,
    model_version: "v2-opportunity" as const,
    made_at: T0,
    inputs_as_of: T0,
    expectation: { targets: 6.5, rec: 4.2 },
    samples: [],
  };

  it("round-trips P(active), the reported mean and the trace; v1 rows read them as null", () => {
    const trace = { matchup: { z: 0.1, beta: 0.2 }, weather_mult: null, shares: [], rates: [] };
    s.repos.projections.put({ ...base, p_active: 0.71, reported_mean: 12.4, trace });
    const got = s.repos.projections.latest(7, 2026, 5, "v2-opportunity");
    expect(got?.p_active).toBe(0.71);
    expect(got?.reported_mean).toBe(12.4);
    expect(got?.trace).toEqual(trace);
    s.repos.projections.put({ ...base, model_version: "v1-ensemble" });
    const v1 = s.repos.projections.latest(7, 2026, 5, "v1-ensemble");
    expect(v1?.p_active).toBeNull();
    expect(v1?.trace).toBeNull();
  });

  it("refuses a P(active) outside [0, 1]; a corrupt stored trace reads as none", () => {
    expect(() => s.repos.projections.put({ ...base, p_active: 1.2 })).toThrow(RangeError);
    expect(() => s.repos.projections.put({ ...base, reported_mean: Number.NaN })).toThrow(
      RangeError,
    );
    s.repos.projections.put({ ...base, p_active: 1, trace: { shares: [] } });
    storeInternalsOf(s)?.db.prepare("UPDATE projection SET trace_json = '[1,2'").run();
    expect(s.repos.projections.latest(7, 2026, 5, "v2-opportunity")?.trace).toBeNull();
  });
});
