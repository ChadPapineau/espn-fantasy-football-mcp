// platform.test.ts — src/providers/platform.ts (plan 01 §9 FantasyPlatform; plan 07 G1 capabilities;
// plan 01 §5.3/§5.6/§6 per-call budget): ESPN-native capabilities true, writes literal false and
// frozen, the per-call constants, and the re-exports the mcp layer depends on.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, classifyError } from "../../src/mcp/errors.js";
import * as espn from "../../src/providers/espn/types.js";
import { SOURCE_RATE_LIMITS } from "../../src/sources/source.js";
import {
  ATTEMPT_TIMEOUT_MS,
  BREAKER_FAILURE_OUTCOMES,
  DEGRADED_CODES,
  ESPN_BACKOFF,
  ESPN_BREAKER,
  ESPN_JOB_DAILY_CAPS,
  ESPN_LIMITER,
  ESPN_REQUEST_ROW_TTL_MS,
  ESPN_TEAM_UNIT_ID_RANGES,
  PLAYER_SORT_MAP,
  REQUEST_OUTCOMES,
  UpstreamBudgetExhausted,
  WRITE_GATE_FAILING_THIS_BUILD,
  breakerFromOutcomes,
  createUpstreamBudget,
  degradedWarning,
  isEspnPlayerIdValue,
  isPartialWarning,
  isUpstreamBudgetExhausted,
  partialWarning,
  type CheckAuthData,
  type RequestOutcome,
  type StatusData,
  ESPN_DST_PLAYER_ID_MAX,
  ESPN_DST_PLAYER_ID_MIN,
  ESPN_PRO_TEAM_ABBREVS,
  FORCE_REFRESH_MIN_INTERVAL_MS,
  KNOWN_UPSTREAM_TYPES,
  MAX_UPSTREAM_PER_CALL,
  NO_WRITES,
  PER_CALL_DEADLINE_MS,
  UPSTREAM_TYPE_FAMILY_RE,
  espnCapabilities,
  isEspnView,
  upstreamTypeOrUnknown,
  type PlatformCapabilities,
} from "../../src/providers/platform.js";

describe("espnCapabilities", () => {
  it.each(["faab", "priority_move_to_last", "continuous", "unknown"] as const)(
    "waiver system %s",
    (w) => {
      const c: PlatformCapabilities = espnCapabilities(w, "2026-10-05T18:00:00.000Z");
      expect(c).toEqual({
        read: true,
        native_projections: true,
        native_ownership: true,
        live_scoring: true,
        waiver_system: w,
        writes: false,
        write: { lineup: false, add_drop: false, waiver: false, trade: false },
        discovered_at: "2026-10-05T18:00:00.000Z",
      });
      expect(Object.isFrozen(c)).toBe(true);
    },
  );
  it("the result cannot be mutated into a write grant", () => {
    const c = espnCapabilities("faab", "x");
    expect(() => {
      (c as unknown as { writes: boolean }).writes = true;
    }).toThrow(TypeError);
    expect(() => {
      (NO_WRITES as unknown as { lineup: boolean }).lineup = true;
    }).toThrow(TypeError);
    expect(c.writes).toBe(false);
    expect(NO_WRITES.lineup).toBe(false);
  });
});

describe("per-call budget", () => {
  it("three upstream requests, a 20 s deadline with 15 s attempts, force_refresh ≥ 60 s apart", () => {
    expect(MAX_UPSTREAM_PER_CALL).toBe(3);
    expect(PER_CALL_DEADLINE_MS).toBe(20_000);
    expect(ATTEMPT_TIMEOUT_MS).toBe(15_000);
    expect(ATTEMPT_TIMEOUT_MS).toBeLessThan(PER_CALL_DEADLINE_MS);
    expect(FORCE_REFRESH_MIN_INTERVAL_MS).toBe(60_000);
  });
});

describe("re-exports (the only door from src/mcp into the ESPN provider)", () => {
  it("are the provider's own bindings", () => {
    expect(isEspnView).toBe(espn.isEspnView);
    expect(upstreamTypeOrUnknown).toBe(espn.upstreamTypeOrUnknown);
    expect(KNOWN_UPSTREAM_TYPES).toBe(espn.KNOWN_UPSTREAM_TYPES);
    expect(UPSTREAM_TYPE_FAMILY_RE).toBe(espn.UPSTREAM_TYPE_FAMILY_RE);
    expect(ESPN_PRO_TEAM_ABBREVS).toBe(espn.ESPN_PRO_TEAM_ABBREVS);
    expect([ESPN_DST_PLAYER_ID_MIN, ESPN_DST_PLAYER_ID_MAX]).toEqual([-16999, -16001]);
  });
});

describe("B3: createUpstreamBudget — the per-call cap and deadline (plan 01 §5.6, §6)", () => {
  const T = Date.parse("2026-10-05T18:00:00Z");
  it("pays for at most MAX_UPSTREAM_PER_CALL new requests; a retry costs no budget but must start before the deadline", () => {
    const b = createUpstreamBudget("r-0123456789ab", T);
    expect(b.deadline_at_ms).toBe(T + PER_CALL_DEADLINE_MS);
    expect([b.tryConsume(), b.tryConsume(), b.tryConsume(), b.tryConsume()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(b.used()).toBe(3);
    // a retry of request 3 only asks canStart — never tryConsume
    expect(b.canStart(T + PER_CALL_DEADLINE_MS - 1)).toBe(true);
    expect(b.canStart(T + PER_CALL_DEADLINE_MS)).toBe(false);
    expect(b.canStart(Number.NaN)).toBe(false);
    expect(Object.isFrozen(b)).toBe(true);
  });
  it("abort() stops every further start and consumption; the signal reports it", () => {
    const b = createUpstreamBudget("r-0123456789ab", T, 2, 5000);
    expect(b.tryConsume()).toBe(true);
    b.abort();
    expect(b.signal.aborted).toBe(true);
    expect(b.tryConsume()).toBe(false);
    expect(b.canStart(T)).toBe(false);
  });
  it("refuses bounds the plan does not allow", () => {
    for (const [max, dl] of [
      [4, 1000],
      [-1, 1000],
      [1.5, 1000],
      [1, 0],
      [1, PER_CALL_DEADLINE_MS + 1],
      [1, Number.NaN],
    ] as const)
      expect(
        () => createUpstreamBudget("r-0123456789ab", T, max, dl),
        `${String(max)}/${String(dl)}`,
      ).toThrow(RangeError);
    expect(() => createUpstreamBudget("r-0123456789ab", Number.NaN)).toThrow(RangeError);
    const zero = createUpstreamBudget("r-0123456789ab", T, 0);
    expect(zero.tryConsume()).toBe(false);
  });
  it("property: used() never exceeds max, whatever the call sequence", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.array(fc.boolean(), { maxLength: 20 }),
        (max, seq) => {
          const b = createUpstreamBudget("r-0123456789ab", T, max);
          for (const s of seq) if (s) b.tryConsume();
          return b.used() <= max && b.used() === Math.min(max, seq.filter(Boolean).length);
        },
      ),
    );
  });
});

describe("B3: UpstreamBudgetExhausted is a signal, not an error code", () => {
  it("carries the view and reason, no effCode (uncaught it maps to INTERNAL, never a code)", () => {
    const e = new UpstreamBudgetExhausted("mBoxscore", "budget");
    expect(e.missing).toEqual({ view: "mBoxscore", reason: "budget" });
    expect(Object.isFrozen(e.missing)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(e, "effCode")).toBe(false);
    expect(isUpstreamBudgetExhausted(e)).toBe(true);
    expect(isUpstreamBudgetExhausted(new Error("upstream budget exhausted"))).toBe(false);
    expect(classifyError(e).code).toBe("INTERNAL");
  });
  it("partialWarning names the view and the limit; fixed text only", () => {
    expect(partialWarning({ view: "mBoxscore", reason: "budget" })).toBe(
      "partial: espn:mBoxscore was not requested (the 3-request budget of this call was used); ask a narrower question for it",
    );
    expect(partialWarning({ view: "mMatchupScore", reason: "deadline" })).toBe(
      "partial: espn:mMatchupScore was not requested (the 20 s upstream deadline of this call passed); retry for it",
    );
  });
  it("isPartialWarning recognises partialWarning's lines (both reasons) and nothing else", () => {
    for (const reason of ["budget", "deadline"] as const)
      for (const view of ["mTeam", "proTeamSchedules_wl", "kona_player_info"] as const)
        expect(isPartialWarning(partialWarning({ view, reason }))).toBe(true);
    for (const w of [
      "partial:",
      "partial: espn:mTeam",
      "standings unavailable: waiver rank unknown (cold-start premium at k = N/2)",
      "candidates truncated to 5 of 25 to fit the 10000-character budget",
      "espn:mTeam was not requested (the 3-request budget of this call was used)",
      "",
    ])
      expect(isPartialWarning(w), w).toBe(false);
  });
  it("degradedWarning carries the code and the source tag", () => {
    expect(DEGRADED_CODES).toEqual([
      "ESPN_UPSTREAM_UNAVAILABLE",
      "ESPN_HOST_MOVED",
      "RATE_LIMITED",
    ]);
    for (const c of DEGRADED_CODES) expect(ERROR_CODES).toContain(c);
    expect(
      degradedWarning("espn:mTeam", {
        code: "RATE_LIMITED",
        served: "stale_cache",
        hard_limit_suspended: false,
      }),
    ).toBe("RATE_LIMITED: espn:mTeam served from stale cache");
  });
});

describe("B4/B5: transport policy constants and the breaker derived from outcomes", () => {
  it("states plan 01 §6 and plan 06 §1.4's numbers once (config), re-exported here", () => {
    expect(ESPN_LIMITER).toEqual({ perMinute: 30, perSecond: 1, concurrency: 2 });
    expect(ESPN_BREAKER).toEqual({ failures: 3, openMs: 300_000 });
    expect(ESPN_BACKOFF).toEqual({ baseMs: 1000, maxMs: 8000, jitter: 0.25, maxAttempts: 3 });
    expect(ESPN_JOB_DAILY_CAPS).toEqual({ cookie: 40, keyless: 30 });
    expect(ESPN_REQUEST_ROW_TTL_MS).toBe(48 * 3600 * 1000);
    expect(SOURCE_RATE_LIMITS.espn_season.maxPerDay).toBe(ESPN_JOB_DAILY_CAPS.keyless);
    for (const o of [ESPN_LIMITER, ESPN_BREAKER, ESPN_BACKOFF, ESPN_JOB_DAILY_CAPS])
      expect(Object.isFrozen(o)).toBe(true);
    expect(BREAKER_FAILURE_OUTCOMES).toEqual(["server_error", "rate_limited", "timeout"]);
    for (const o of BREAKER_FAILURE_OUTCOMES) expect(REQUEST_OUTCOMES).toContain(o);
  });
  const T = Date.parse("2026-10-05T18:00:00Z");
  const row = (agoMs: number, outcome: RequestOutcome) => ({ at_ms: T - agoMs, outcome });
  it("opens after 3 consecutive failures, for 5 minutes from the newest", () => {
    const b = breakerFromOutcomes(
      [row(1000, "timeout"), row(2000, "server_error"), row(3000, "rate_limited"), row(4000, "ok")],
      T,
    );
    expect(b).toEqual({
      breaker_open: true,
      breaker_open_until: new Date(T - 1000 + 300_000).toISOString(),
      consecutive_failures: 3,
    });
    expect(
      breakerFromOutcomes(
        [row(300_001, "timeout"), row(300_002, "timeout"), row(300_003, "timeout")],
        T,
      ).breaker_open,
    ).toBe(false);
  });
  it("a success, a 304 or a client error resets the run; pending rows are skipped", () => {
    expect(
      breakerFromOutcomes(
        [row(1, "ok"), row(2, "timeout"), row(3, "timeout"), row(4, "timeout")],
        T,
      ),
    ).toMatchObject({ breaker_open: false, consecutive_failures: 0 });
    expect(
      breakerFromOutcomes(
        [row(1, "timeout"), row(2, "not_modified"), row(3, "timeout"), row(4, "timeout")],
        T,
      ).consecutive_failures,
    ).toBe(1);
    expect(
      breakerFromOutcomes([row(1, "timeout"), row(2, "client_error"), row(3, "timeout")], T)
        .breaker_open,
    ).toBe(false);
    expect(
      breakerFromOutcomes(
        [row(1, "pending"), row(2, "timeout"), row(3, "timeout"), row(4, "timeout")],
        T,
      ).breaker_open,
    ).toBe(true);
    expect(
      breakerFromOutcomes([row(1, "network_error"), row(2, "timeout"), row(3, "timeout")], T)
        .consecutive_failures,
    ).toBe(0);
    expect(breakerFromOutcomes([], T)).toEqual({
      breaker_open: false,
      breaker_open_until: null,
      consecutive_failures: 0,
    });
    expect(
      breakerFromOutcomes([row(1, "timeout"), row(2, "timeout"), row(3, "timeout")], Number.NaN)
        .breaker_open,
    ).toBe(false);
  });
});

describe("CAT-15: ops vocabularies", () => {
  it("write_gate_failing reads module_not_built in this build; check_auth carries the reason", () => {
    expect(WRITE_GATE_FAILING_THIS_BUILD).toBe("module_not_built");
    const d: CheckAuthData = {
      accepted: null,
      probe: "board",
      reason: "board_not_discriminating",
      state: "validated",
      upstream_status: 404,
      checked_at: "2026-10-05T18:00:00.000Z",
      next_allowed_at: "2026-10-05T18:01:00.000Z",
    };
    expect(d.reason).toBe("board_not_discriminating");
    const w: StatusData["capabilities"]["write_gate_failing"] = WRITE_GATE_FAILING_THIS_BUILD;
    expect(w).toBe("module_not_built");
  });
});

describe("CAT-01 re-exports", () => {
  it("platform re-exports the team-unit ranges and the id predicate", () => {
    expect(ESPN_TEAM_UNIT_ID_RANGES).toBe(espn.ESPN_TEAM_UNIT_ID_RANGES);
    expect(isEspnPlayerIdValue).toBe(espn.isEspnPlayerIdValue);
    expect(PLAYER_SORT_MAP).toBe(espn.PLAYER_SORT_MAP);
  });
});
