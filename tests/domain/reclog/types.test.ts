// types.test.ts — src/domain/reclog/types.ts: the dedup scope (plan 07 E12 — only records with a
// `client_ref` deduplicate, and only within (league_id, season, week, kind, client_ref)), the
// "n too small (k of N)" caveat (plan 07 E13 `min_n`, sib ADV OBJ-05), and the id grammars.
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { BareText } from "../../../src/domain/league/types.js";
import {
  toRecordView,
  type RecommendationListItem,
  type RecommendationRecordView,
  type RetrospectiveCall,
  CLIENT_REF_RE,
  DECISION_METRIC_RE,
  DEFAULT_MIN_N,
  LOG_ID_RE,
  RECLOG_TEXT_PATHS,
  RECLOG_UNTRUSTED_SOURCE,
  RECOMMENDATION_KINDS,
  RECORD_DEDUP_SCOPE,
  TOOL_NAME_RE,
  nTooSmall,
  recordDedupScope,
  sameRecordDedupScope,
  type RecommendationKind,
} from "../../../src/domain/reclog/types.js";
import { isUntrustedSource } from "../../../src/domain/league/types.js";

type ScopeInput = Parameters<typeof recordDedupScope>[0];
const base: ScopeInput = {
  league_id: "0",
  season: 2026,
  week: 5,
  kind: "lineup",
  client_ref: "c-1",
};

describe("recordDedupScope", () => {
  it("returns the frozen five-field scope for a record with a client_ref", () => {
    const s = recordDedupScope({ ...base, extra: "ignored" } as ScopeInput);
    expect(s).toEqual(base);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.keys(s ?? {})).toEqual([...RECORD_DEDUP_SCOPE]);
  });
  it("returns null without a client_ref (never deduplicated)", () => {
    expect(recordDedupScope({ ...base, client_ref: null })).toBeNull();
  });
});

describe("sameRecordDedupScope", () => {
  it("is true only when both carry a client_ref and all five fields match", () => {
    expect(sameRecordDedupScope(base, { ...base })).toBe(true);
    for (const [k, v] of [
      ["league_id", "1"],
      ["season", 2025],
      ["week", 6],
      ["kind", "waiver"],
      ["client_ref", "c-2"],
    ] as const)
      expect(sameRecordDedupScope(base, { ...base, [k]: v }), k).toBe(false);
  });
  it("two records without a client_ref never deduplicate, even if otherwise equal", () => {
    expect(sameRecordDedupScope({ ...base, client_ref: null }, { ...base, client_ref: null })).toBe(
      false,
    );
    expect(sameRecordDedupScope(base, { ...base, client_ref: null })).toBe(false);
    expect(sameRecordDedupScope({ ...base, client_ref: null }, base)).toBe(false);
  });
  it("property: symmetric, and reflexive exactly when a client_ref is present", () => {
    const kind = fc.constantFrom(...RECOMMENDATION_KINDS);
    const rec = fc.record({
      league_id: fc.constantFrom("0", "1"),
      season: fc.constantFrom(2025, 2026),
      week: fc.integer({ min: 0, max: 18 }),
      kind,
      client_ref: fc.option(fc.constantFrom("a", "b"), { nil: null }),
    });
    fc.assert(
      fc.property(rec, rec, (a, b) => {
        const sa = a as ScopeInput;
        const sb = b as ScopeInput;
        return (
          sameRecordDedupScope(sa, sb) === sameRecordDedupScope(sb, sa) &&
          sameRecordDedupScope(sa, sa) === (sa.client_ref !== null)
        );
      }),
    );
  });
});

describe("nTooSmall", () => {
  it("formats k of min, defaulting min to 30", () => {
    expect(nTooSmall(4)).toBe("n too small (4 of 30)");
    expect(nTooSmall(12, 50)).toBe("n too small (12 of 50)");
    expect(DEFAULT_MIN_N).toBe(30);
  });
  it("floors fractions and clamps hostile inputs", () => {
    expect(nTooSmall(4.9, 30.7)).toBe("n too small (4 of 30)");
    expect(nTooSmall(-3)).toBe("n too small (0 of 30)");
    expect(nTooSmall(Number.NaN, Number.NaN)).toBe("n too small (0 of 30)");
    expect(nTooSmall(Infinity, -Infinity)).toBe("n too small (0 of 30)");
    expect(nTooSmall(5, 0)).toBe("n too small (5 of 30)");
    expect(nTooSmall(0.5, 0.5)).toBe("n too small (0 of 30)");
    // a huge count prints as digits, never as 1e+21
    expect(nTooSmall(1e21, 1e300)).toBe(
      `n too small (${String(Number.MAX_SAFE_INTEGER)} of ${String(Number.MAX_SAFE_INTEGER)})`,
    );
  });
  it("property: always matches the literal grammar", () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), (k, m) =>
        /^n too small \(\d+ of \d+\)$/.test(nTooSmall(k, m)),
      ),
    );
  });
});

describe("grammars and vocabularies", () => {
  it("log ids are rec- + a Crockford ULID", () => {
    expect(LOG_ID_RE.test(`rec-${"0".repeat(26)}`)).toBe(true);
    expect(LOG_ID_RE.test("rec-01HZY3M4N5P6Q7R8S9T0V1W2X3")).toBe(true);
    for (const bad of [
      `rec-${"I".repeat(26)}`,
      `rec-${"0".repeat(25)}`,
      `REC-${"0".repeat(26)}`,
      `rec-${"u".repeat(26)}`,
    ])
      expect(LOG_ID_RE.test(bad), bad).toBe(false);
  });
  it("tool names, decision metrics and client refs are bounded", () => {
    expect(TOOL_NAME_RE.test("espn_get_roster")).toBe(true);
    expect(TOOL_NAME_RE.test("get_roster")).toBe(false);
    expect(TOOL_NAME_RE.test(`espn_${"a".repeat(36)}`)).toBe(false);
    expect(DECISION_METRIC_RE.test("p_win")).toBe(true);
    expect(DECISION_METRIC_RE.test("P-win")).toBe(false);
    expect(CLIENT_REF_RE.test("abc.DEF_1:2-3")).toBe(true);
    for (const bad of ["", "a b", "x".repeat(65), "a/b", "a\n"])
      expect(CLIENT_REF_RE.test(bad), bad).toBe(false);
  });
  it("kinds are distinct snake case and include the session kind", () => {
    expect(new Set(RECOMMENDATION_KINDS).size).toBe(RECOMMENDATION_KINDS.length);
    for (const k of RECOMMENDATION_KINDS) expect(k).toMatch(/^[a-z_]+$/);
    expect(RECOMMENDATION_KINDS).toContain("session" satisfies RecommendationKind);
  });
  it("model-authored text is read back as untrusted under a registered tag", () => {
    expect(isUntrustedSource(RECLOG_UNTRUSTED_SOURCE)).toBe(true);
    expect(Object.isFrozen(RECLOG_TEXT_PATHS)).toBe(true);
    expect(RECLOG_TEXT_PATHS.length).toBeGreaterThan(0);
  });
});

describe("CAT-09: the read-back view never carries league_id (espn-ff://rec/{log_id})", () => {
  it("toRecordView strips the key at run time; everything else is kept", () => {
    const record = {
      league_id: "0",
      season: 2026,
      kind: "lineup",
      week: 4,
      rec: {} as never,
      alternatives: [],
      source_calls: [],
      settings_hash: "a".repeat(64),
      seeding_mode_used: null,
      followed_hint: "unknown",
      client_ref: null,
      note: null,
      log_id: "rec-01J9Z3K4M5N6P7Q8R9S0T1V2W3",
      recorded_at: "2026-10-05T18:00:00.000Z",
    } as const;
    const view = toRecordView(record);
    expect("league_id" in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain("league_id");
    expect(view).toEqual(
      Object.fromEntries(Object.entries(record).filter(([k]) => k !== "league_id")),
    );
    expectTypeOf<RecommendationRecordView>().not.toHaveProperty("league_id");
  });
  it("read-back strings are BareText (a raw string does not type-check)", () => {
    expectTypeOf<RecommendationListItem["action_summary"]>().toEqualTypeOf<BareText>();
    expectTypeOf<RetrospectiveCall["recommended"]>().toEqualTypeOf<BareText>();
    expectTypeOf<RetrospectiveCall["best_alternative"]>().toEqualTypeOf<BareText | null>();
  });
});
