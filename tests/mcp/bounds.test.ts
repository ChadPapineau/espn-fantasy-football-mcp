// bounds.test.ts — src/mcp/bounds.ts (plan 02 §5 bounds: scoringPeriodId 0–22, a tool's week 1–18,
// teamId 1–20, ≤ 25 ids, limit 1–100, offset 0–5 000, search ≤ 64; plan 07 legend PlayerSelector
// with `pool`; E12's input schema; no league id argument). Adversarial: off-by-one at every bound,
// duplicates, two selectors at once, hostile strings, unicode, oversized records.
import fc from "fast-check";
import { z } from "zod/v4";
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_CPU_DEADLINE_MS,
  BOUNDS,
  COOPERATIVE_BATCH_MS,
  MAX_LOOP_STALL_MS,
  N_SIMS_MAX,
  RECORD_LIMITS,
  analyticsFreshnessShape,
  clientRefSchema,
  detailSchema,
  espnFreshnessShape,
  gsisIdSchema,
  isoInstantSchema,
  leagueIncludeSchema,
  limitSchema,
  logIdSchema,
  matchupPeriodSchema,
  nSimsSchema,
  nflTeamSchema,
  objectiveSchema,
  offsetSchema,
  outlookSelectorSchema,
  pageInputShape,
  playerIdsSchema,
  playerSelectorSchema,
  playerSortSchema,
  playerStatusSchema,
  positionSchema,
  recordRecommendationInputSchema,
  requestIdSchema,
  scoringPeriodSchema,
  searchQuerySchema,
  seasonSchema,
  seasonSchemaFor,
  seedSchema,
  seedingModeArgSchema,
  singlePlayerSelectorSchema,
  statIdSchema,
  teamIdSchema,
  transactionTypesSchema,
  txnCountSchema,
  weekSchema,
} from "../../src/mcp/bounds.js";

const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success;

describe("the bound table (plan 02 §5; changelog F61)", () => {
  it("states the plan's numbers", () => {
    expect(BOUNDS.scoringPeriod).toEqual({ min: 0, max: 22 });
    expect(BOUNDS.week).toEqual({ min: 1, max: 18 });
    expect(BOUNDS.teamId).toEqual({ min: 1, max: 20 });
    expect(BOUNDS.limit).toEqual({ min: 1, max: 100, default: 25 });
    expect(BOUNDS.offset).toEqual({ min: 0, max: 5000, default: 0 });
    expect(BOUNDS.playerIds.max).toBe(25);
    expect(BOUNDS.outlookIds.max).toBe(12);
    expect(BOUNDS.searchChars.max).toBe(64);
    expect(BOUNDS.season.min).toBe(2018);
    expect([ANALYTICS_CPU_DEADLINE_MS, COOPERATIVE_BATCH_MS, MAX_LOOP_STALL_MS]).toEqual([
      8000, 20, 50,
    ]);
    expect(N_SIMS_MAX).toBe(BOUNDS.nSims.max);
  });
  it.each([
    [weekSchema, 1, 18],
    [scoringPeriodSchema, 0, 22],
    [matchupPeriodSchema, 1, 17],
    [teamIdSchema, 1, 20],
    [seedSchema, 0, 2 ** 31 - 1],
    [seasonSchema, 2018, 2100],
  ] as const)(
    "integer bound %#: min and max in, one past out, fractions out",
    (schema, min, max) => {
      expect(ok(schema, min)).toBe(true);
      expect(ok(schema, max)).toBe(true);
      expect(ok(schema, min - 1)).toBe(false);
      expect(ok(schema, max + 1)).toBe(false);
      expect(ok(schema, min + 0.5)).toBe(false);
      expect(ok(schema, String(min))).toBe(false);
      expect(ok(schema, Number.NaN)).toBe(false);
    },
  );
  it("property: week accepts exactly the integers 1..18", () => {
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }), (n) => {
        expect(ok(weekSchema, n)).toBe(Number.isInteger(n) && n >= 1 && n <= 18);
      }),
      { numRuns: 1000 },
    );
  });
  it("seasonSchemaFor bounds 2018..current and refuses a bad current", () => {
    const s = seasonSchemaFor(2026);
    expect(ok(s, 2026)).toBe(true);
    expect(ok(s, 2027)).toBe(false);
    expect(ok(s, 2017)).toBe(false);
    expect(() => seasonSchemaFor(2017)).toThrow(RangeError);
    expect(() => seasonSchemaFor(2026.5)).toThrow(RangeError);
  });
  it("paging and detail defaults", () => {
    expect(limitSchema.parse(undefined)).toBe(25);
    expect(offsetSchema.parse(undefined)).toBe(0);
    expect(ok(limitSchema, 101)).toBe(false);
    expect(ok(offsetSchema, 5001)).toBe(false);
    expect(detailSchema.parse(undefined)).toBe("compact");
    expect(ok(detailSchema, "verbose")).toBe(false);
    expect(nSimsSchema.parse(undefined)).toBe(4000);
    expect(ok(nSimsSchema, 999)).toBe(false);
    expect(ok(nSimsSchema, N_SIMS_MAX + 1)).toBe(false);
    expect(txnCountSchema.parse(undefined)).toBe(25);
    expect(ok(txnCountSchema, 201)).toBe(false);
    expect(Object.keys(pageInputShape)).toEqual(["limit", "offset"]);
    expect(Object.keys(espnFreshnessShape)).toEqual(["force_refresh", "allow_stale"]);
    expect(Object.keys(analyticsFreshnessShape)).toEqual(["allow_stale"]);
  });
});

describe("ids and grammars", () => {
  it("player ids: 1..25 distinct ESPN ids, D/ST ids included", () => {
    expect(ok(playerIdsSchema, [1, 4_362_628, -16_002])).toBe(true);
    expect(ok(playerIdsSchema, [])).toBe(false);
    expect(
      ok(
        playerIdsSchema,
        Array.from({ length: 26 }, (_, i) => i + 1),
      ),
    ).toBe(false);
    expect(ok(playerIdsSchema, [5, 5])).toBe(false);
    expect(ok(playerIdsSchema, [0])).toBe(false);
    expect(ok(playerIdsSchema, ["5"])).toBe(false);
  });
  it("gsis ids, iso instants, stat ids, positions, client refs, log ids, request ids", () => {
    expect(ok(gsisIdSchema, "00-0012345")).toBe(true);
    for (const bad of ["0-0012345", "00-001234", "00-00123456", "00-001234x", ""])
      expect(ok(gsisIdSchema, bad), bad).toBe(false);
    expect(ok(isoInstantSchema, "2026-10-05T12:00:00Z")).toBe(true);
    expect(ok(isoInstantSchema, "yesterday")).toBe(false);
    expect(ok(statIdSchema, "53")).toBe(true);
    expect(ok(statIdSchema, "53a")).toBe(false);
    for (const p of ["QB", "D/ST", "RB/WR", "FLEX", "K"])
      expect(ok(positionSchema, p), p).toBe(true);
    for (const p of ["", "1B", "D/ST!", "a".repeat(11), "Q B"])
      expect(ok(positionSchema, p), p).toBe(false);
    expect(ok(clientRefSchema, "start-sit:w4.flex_1")).toBe(true);
    for (const bad of ["", "has space", "x".repeat(65), "semi;colon"])
      expect(ok(clientRefSchema, bad), bad).toBe(false);
    expect(ok(logIdSchema, "rec-01HZY3M5S8K2Q4T6V7W9X0ABCD")).toBe(true);
    expect(ok(logIdSchema, "rec-01HZY3M5S8K2Q4T6V7W9X0ABCI")).toBe(false);
    expect(ok(requestIdSchema, "r-0123456789ab")).toBe(true);
    expect(ok(requestIdSchema, "r-0123456789AB")).toBe(false);
  });
  it("nfl_team accepts ESPN's abbreviations and nflverse's two spellings, normalised to ESPN's", () => {
    expect(nflTeamSchema.parse("WSH")).toBe("WSH");
    expect(nflTeamSchema.parse("WAS")).toBe("WSH");
    expect(nflTeamSchema.parse("LA")).toBe("LAR");
    expect(nflTeamSchema.parse("KC")).toBe("KC");
    for (const bad of ["FA", "XXX", "wsh", "", "KC "])
      expect(ok(nflTeamSchema, bad), bad).toBe(false);
  });
  it("search: trimmed, 1..64, printable only", () => {
    expect(searchQuerySchema.parse("  Patrick  ")).toBe("Patrick");
    expect(ok(searchQuerySchema, "   ")).toBe(false);
    expect(ok(searchQuerySchema, "x".repeat(65))).toBe(false);
    for (const bad of ["a\u202eb", "a\u200bb", "a\u0000b", "a\u{e0041}b"])
      expect(ok(searchQuerySchema, bad)).toBe(false);
    expect(ok(searchQuerySchema, "José Nuñez Jr.")).toBe(true);
  });
});

describe("PlayerSelector (plan 07 legend; T-11)", () => {
  it.each([
    [{ player_ids: [1, 2] }],
    [{ gsis_ids: ["00-0012345"] }],
    [{ team_id: 3 }],
    [{ nfl_team: "WAS" }],
    [{ pool: { status: "FREEAGENT", position: "D/ST", top: 50 } }],
  ])("accepts %j", (v) => {
    expect(ok(playerSelectorSchema, v)).toBe(true);
  });
  it.each([
    [{}],
    [{ player_ids: [1], team_id: 3 }],
    [{ team_id: 21 }],
    [{ gsis_ids: ["00-0012345", "00-0012345"] }],
    [{ pool: { status: "ONTEAM", position: "QB", top: 5 } }],
    [{ pool: { status: "FREEAGENT", position: "QB", top: 51 } }],
    [{ pool: { status: "FREEAGENT", position: "QB", top: 5, extra: 1 } }],
    [{ league_id: 1 }],
  ])("refuses %j", (v) => {
    expect(ok(playerSelectorSchema, v)).toBe(false);
  });
  it("single-player and outlook selectors are narrower", () => {
    expect(ok(singlePlayerSelectorSchema, { player_ids: [1] })).toBe(true);
    expect(ok(singlePlayerSelectorSchema, { player_ids: [1, 2] })).toBe(false);
    expect(ok(singlePlayerSelectorSchema, { gsis_ids: ["00-0012345"] })).toBe(true);
    expect(ok(singlePlayerSelectorSchema, { gsis_ids: ["00-0012345", "00-0012346"] })).toBe(false);
    expect(
      ok(outlookSelectorSchema, { player_ids: Array.from({ length: 12 }, (_, i) => i + 1) }),
    ).toBe(true);
    expect(
      ok(outlookSelectorSchema, { player_ids: Array.from({ length: 13 }, (_, i) => i + 1) }),
    ).toBe(false);
    expect(ok(outlookSelectorSchema, { team_id: 1 })).toBe(true);
  });
});

describe("plan 07 input enums", () => {
  it("accept their values and nothing else", () => {
    expect(playerStatusSchema.options).toEqual([
      "FREEAGENT",
      "WAIVERS",
      "AVAILABLE",
      "ONTEAM",
      "ALL",
    ]);
    expect(playerSortSchema.options).toContain("percChanged");
    expect(objectiveSchema.options).toEqual(["auto", "mean", "pwin", "blend", "points_only"]);
    expect(seedingModeArgSchema.options).toEqual(["config", "espn_rule", "points_only", "both"]);
    expect(ok(transactionTypesSchema, ["WAIVER", "WAIVER_ERROR"])).toBe(true);
    expect(ok(transactionTypesSchema, [])).toBe(false);
    expect(ok(transactionTypesSchema, ["TRADE_ACCEPTED"])).toBe(false);
    expect(ok(leagueIncludeSchema, ["seeding_evidence"])).toBe(true);
    expect(ok(leagueIncludeSchema, ["members"])).toBe(false);
  });
});

describe("the E12 record input (plan 07 E12)", () => {
  const dist = {
    mean: 10,
    p10: 2,
    p25: 6,
    p50: 10,
    p75: 14,
    p90: 18,
    p_zero: 0.05,
    basis: "position_cv",
  };
  const rec = {
    action: "Start Player One at FLEX",
    subjects: [{ player_id: 4_362_628, gsis_id: null, role: "start", slot: "FLEX" }],
    lineup: null,
    point_estimate: 12.5,
    distribution: dist,
    delta_vs_next: { value: 1.2, p10: -2, p90: 4 },
    decision_metric: "expected_points",
    drivers: [],
    assumptions: [],
    confidence: { role_games: 4, inputs: [] },
    as_of: "2026-10-05T17:00:00Z",
    latest_execution_time: null,
    no_move: false,
    log_id: null,
  };
  const valid = {
    kind: "lineup",
    week: 5,
    rec,
    settings_hash: "a".repeat(64),
    source_calls: [{ tool: "espn_analyze_lineup", request_id: "r-0123456789ab" }],
    client_ref: "start-sit-w5",
  };
  it("accepts a well-formed record with defaults filled", () => {
    const r = recordRecommendationInputSchema.parse(valid);
    expect(r.alternatives).toEqual([]);
    expect(r.followed_hint).toBe("unknown");
    expect(ok(recordRecommendationInputSchema, { ...valid, week: 0, kind: "onboarding" })).toBe(
      true,
    );
    expect(
      ok(recordRecommendationInputSchema, { ...valid, kind: "session", seeding_mode_used: "both" }),
    ).toBe(true);
  });
  it.each([
    ["a league id argument", { league_id: "0" }],
    ["a season argument", { season: 2026 }],
    ["week 19", { week: 19 }],
    ["an unknown kind", { kind: "draft" }],
    ["a non-null log_id", { rec: { ...rec, log_id: "rec-01HZY3M5S8K2Q4T6V7W9X0ABCD" } }],
    [
      "a foreign tool name",
      { source_calls: [{ tool: "ff_get_roster", request_id: "r-0123456789ab" }] },
    ],
    [
      "too many source calls",
      {
        source_calls: Array.from(
          { length: RECORD_LIMITS.sourceCalls + 1 },
          () => valid.source_calls[0],
        ),
      },
    ],
    ["a bad settings hash", { settings_hash: "XYZ" }],
    ["a hidden-character note", { note: "fine\u202e reversed" }],
    ["an over-long note", { note: "n".repeat(201) }],
    ["a client ref with a space", { client_ref: "a b" }],
  ])("refuses %s", (_label, over) => {
    expect(ok(recordRecommendationInputSchema, { ...valid, ...over })).toBe(false);
  });
  it("refuses an input over 20 000 serialised characters", () => {
    const subjects = Array.from({ length: 20 }, () => ({
      player_id: 4_362_628,
      gsis_id: "00-0012345",
      role: "start",
      slot: "FLEX",
    }));
    const alt = {
      action: "a".repeat(200),
      subjects,
      point_estimate: 1,
      distribution: dist,
      decision_metric_value: 1,
    };
    const big = {
      ...valid,
      rec: {
        ...rec,
        drivers: Array.from({ length: 20 }, () => ({ name: "d".repeat(200), contribution: 1 })),
        assumptions: Array.from({ length: 20 }, () => ({
          text: "t".repeat(200),
          revisit_trigger: "r".repeat(200),
        })),
      },
      alternatives: Array.from({ length: 10 }, () => alt),
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(BOUNDS.recordInputChars);
    const r = recordRecommendationInputSchema.safeParse(big);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("input_too_large");
  });
});
