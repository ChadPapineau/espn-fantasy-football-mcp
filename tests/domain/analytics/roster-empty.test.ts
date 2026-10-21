// roster-empty.test.ts — Stage C round 2, finding analytics-empty-roster-validation (plan 01 §4.3:
// VALIDATION is a zod failure with field and reason; NOT_FOUND "the requested team/player/week is not
// in the league"): before the draft every roster is empty, a league state the engines used to refuse
// as `invalid_request` — VALIDATION, "fix the arguments", which the Skills read as "fix the arguments;
// never retry blindly" — though the arguments were valid. The refusal is now `roster_empty`: NOT_FOUND
// with reason `roster_empty` and the fixed server texts (src/mcp/errors.ts shows a message or hint
// only when its own server table lists it; never text from data — so the table lists these two, and
// the mapped result must carry them: a table that does not list them answered "not in this league …
// check the id or week", the verifier's round-2 finding). The per-engine refusals are held in each
// engine's test file; this one holds the error itself and its mapping.
import { describe, expect, it } from "vitest";
import {
  AnalyticsError,
  ensurePlayers,
  ROSTER_EMPTY_TEXT,
} from "../../../src/domain/analytics/errors.js";
import {
  ERROR_TABLE,
  SERVER_HINTS,
  SERVER_MESSAGES,
  toToolError,
} from "../../../src/mcp/errors.js";

describe("roster_empty: a league state, not an argument error", () => {
  it("carries NOT_FOUND, the reason, the field and the fixed texts — never VALIDATION", () => {
    const e = new AnalyticsError("roster_empty", "the roster has no players", "players");
    expect(e).toMatchObject({
      code: "roster_empty",
      effCode: "NOT_FOUND",
      effDetails: {
        field: "players",
        reason: "roster_empty",
        message: ROSTER_EMPTY_TEXT.message,
        hint: ROSTER_EMPTY_TEXT.hint,
      },
    });
    // the other codes carry no server text
    expect(new AnalyticsError("invalid_request", "x", "players").effDetails).toEqual({
      field: "players",
      reason: "invalid_request",
    });
  });

  it("ensurePlayers refuses an empty roster only; the bounds above it stay with the engines", () => {
    expect(() => {
      ensurePlayers(0, "players");
    }).toThrow(AnalyticsError);
    expect(() => {
      ensurePlayers(1, "players");
    }).not.toThrow();
    expect(() => {
      ensurePlayers(200, "players");
    }).not.toThrow();
    try {
      ensurePlayers(0, "team_id");
    } catch (e) {
      expect(e).toMatchObject({ code: "roster_empty", effDetails: { field: "team_id" } });
    }
  });

  it("the fixed texts are short, plain and data-free", () => {
    for (const t of [ROSTER_EMPTY_TEXT.message, ROSTER_EMPTY_TEXT.hint]) {
      expect(t.length).toBeLessThanOrEqual(120);
      expect(t).not.toMatch(/fix the arguments/i);
    }
  });

  it("maps to a coded NOT_FOUND result with reason roster_empty (the arguments were valid)", () => {
    const r = toToolError(new AnalyticsError("roster_empty", "x", "players"), "r-0123456789ab");
    const err = r.structuredContent.error;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.reason).toBe("roster_empty");
    expect(err.retryable).toBe(false);
    expect(err.hint).not.toBe(ERROR_TABLE.VALIDATION.hint);
    // the fixed texts themselves, never the table's "not in this league … check the id or week"
    expect(err.message).toBe(ROSTER_EMPTY_TEXT.message);
    expect(err.hint).toBe(ROSTER_EMPTY_TEXT.hint);
    expect(err.message).not.toBe(ERROR_TABLE.NOT_FOUND.message);
    expect(err.hint).not.toBe(ERROR_TABLE.NOT_FOUND.hint);
  });

  it("the mapper's server tables list the texts (the only way a fixed text reaches the wire)", () => {
    expect(Object.values(SERVER_MESSAGES)).toContain(ROSTER_EMPTY_TEXT.message);
    expect(Object.values(SERVER_HINTS)).toContain(ROSTER_EMPTY_TEXT.hint);
  });
});
