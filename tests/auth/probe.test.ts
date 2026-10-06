// probe.test.ts — src/auth/probe.ts (plan 02 §2.1 "The definitive check"; ADV OBJ-14, OBJ-26;
// changelog R-5, K1; R3 nit (c); plan 06 §1.4): which probe runs on a private / public league,
// what each status means, which ordinary 200s count as an acceptance, and the two rate limits.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BOARD_PROBE_VIEW,
  SETTINGS_PROBE_VIEW,
  boardControlDiscriminates,
  checkAuthAllowed,
  dailyProbeAllowed,
  ordinaryAcceptanceCounts,
  planDefinitiveProbe,
  probeVerdict,
  type ProbePlan,
} from "../../src/auth/probe.js";
import { CHECK_AUTH_MIN_INTERVAL_MS } from "../../src/auth/types.js";
import { stateRow } from "./helpers.js";

const settings: ProbePlan = { kind: "settings", view: SETTINGS_PROBE_VIEW, discriminates: true };
const board: ProbePlan = { kind: "board", view: BOARD_PROBE_VIEW, discriminates: true };
const deafBoard: ProbePlan = { kind: "board", view: BOARD_PROBE_VIEW, discriminates: false };
const rejectedView: ProbePlan = { kind: "rejected_view", view: "mRoster", discriminates: true };

describe("planDefinitiveProbe", () => {
  it("private league → mSettings with cookies", () => {
    expect(planDefinitiveProbe({ leaguePublic: false, row: null })).toEqual(settings);
  });
  it("public league whose anonymous control answered 401 → the board probe (discriminating)", () => {
    expect(
      planDefinitiveProbe({
        leaguePublic: true,
        row: stateRow({ board_probe_discriminates: true }),
      }),
    ).toEqual(board);
  });
  it("public, board deaf, rejected → the view whose 401 caused the rejection (R3 nit (c))", () => {
    const row = stateRow({
      state: "rejected",
      board_probe_discriminates: false,
      rejected_view: "mRoster",
    });
    expect(planDefinitiveProbe({ leaguePublic: true, row })).toEqual(rejectedView);
  });
  it("public, board deaf, not rejected (or no rejected view) → board, accepted can only be null", () => {
    expect(
      planDefinitiveProbe({
        leaguePublic: true,
        row: stateRow({ board_probe_discriminates: false }),
      }),
    ).toEqual(deafBoard);
    expect(
      planDefinitiveProbe({
        leaguePublic: true,
        row: stateRow({ state: "rejected", rejected_view: null }),
      }),
    ).toEqual(deafBoard);
    expect(planDefinitiveProbe({ leaguePublic: true, row: null })).toEqual(deafBoard);
  });
});

describe("probeVerdict", () => {
  it.each([
    [settings, 200, true, "accepted"],
    [settings, 401, false, "rejected"],
    [settings, 403, false, "rejected"],
    [settings, 404, null, "league_not_found"],
    [settings, 500, null, null],
    [settings, 429, null, null],
    [board, 200, true, "accepted"],
    [board, 404, true, "accepted"], // a board-less league with cookies accepted
    [board, 401, false, "rejected"],
    [deafBoard, 200, null, null],
    [deafBoard, 404, null, null],
    [deafBoard, 401, false, "rejected"],
    [rejectedView, 200, true, "accepted"],
    [rejectedView, 404, null, "league_not_found"],
  ] as const)("%j + %i → accepted %s, %s", (plan, status, accepted, observation) => {
    expect(probeVerdict(plan, status)).toEqual({ accepted, observation });
  });
  it("property: never throws; 401/403 is always a rejection; 5xx never a credential event", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(settings, board, deafBoard, rejectedView),
        fc.integer({ min: 100, max: 599 }),
        (plan, status) => {
          const v = probeVerdict(plan, status);
          if (status === 401 || status === 403)
            return v.observation === "rejected" && v.accepted === false;
          if (status >= 500) return v.observation === null && v.accepted === null;
          return true;
        },
      ),
    );
  });
});

describe("boardControlDiscriminates (ADV OBJ-26)", () => {
  it("only an anonymous 401 discriminates; a failed control decides nothing", () => {
    expect(boardControlDiscriminates(401)).toBe(true);
    expect(boardControlDiscriminates(404)).toBe(false);
    expect(boardControlDiscriminates(200)).toBe(false);
    expect(boardControlDiscriminates(null)).toBeNull();
  });
});

describe("ordinaryAcceptanceCounts (R-5, K1)", () => {
  it("private league: any cookie-bearing 200", () => {
    expect(ordinaryAcceptanceCounts({ leaguePublic: false, view: "mRoster", row: null })).toBe(
      true,
    );
  });
  it("public league: only the discriminating board probe…", () => {
    const disc = stateRow({ board_probe_discriminates: true });
    expect(
      ordinaryAcceptanceCounts({ leaguePublic: true, view: BOARD_PROBE_VIEW, row: disc }),
    ).toBe(true);
    expect(ordinaryAcceptanceCounts({ leaguePublic: true, view: "mRoster", row: disc })).toBe(
      false,
    );
    expect(
      ordinaryAcceptanceCounts({ leaguePublic: true, view: BOARD_PROBE_VIEW, row: stateRow() }),
    ).toBe(false);
    expect(ordinaryAcceptanceCounts({ leaguePublic: true, view: "mRoster", row: null })).toBe(
      false,
    );
  });
  it("…or, after a rejection with a deaf board, a 200 on the rejected view", () => {
    const row = stateRow({
      state: "rejected",
      board_probe_discriminates: false,
      rejected_view: "mTeam",
    });
    expect(ordinaryAcceptanceCounts({ leaguePublic: true, view: "mTeam", row })).toBe(true);
    expect(ordinaryAcceptanceCounts({ leaguePublic: true, view: "mRoster", row })).toBe(false);
    expect(
      ordinaryAcceptanceCounts({
        leaguePublic: true,
        view: "mTeam",
        row: { ...row, rejected_view: null },
      }),
    ).toBe(false);
    expect(
      ordinaryAcceptanceCounts({
        leaguePublic: true,
        view: "mTeam",
        row: { ...row, state: "validated" },
      }),
    ).toBe(false);
  });
});

describe("rate limits", () => {
  it("espn_check_auth: at most once per minute", () => {
    expect(checkAuthAllowed(null, 0)).toEqual({ ok: true });
    expect(checkAuthAllowed(1_000, 1_000 + CHECK_AUTH_MIN_INTERVAL_MS)).toEqual({ ok: true });
    expect(checkAuthAllowed(1_000, 1_500)).toEqual({
      ok: false,
      retryAfterMs: CHECK_AUTH_MIN_INTERVAL_MS - 500,
    });
    expect(checkAuthAllowed(1_000, 1_000.5)).toEqual({
      ok: false,
      retryAfterMs: CHECK_AUTH_MIN_INTERVAL_MS,
    });
  });
  it("daily credential check: ≤ 1/day off-season, ≤ 2/day in season", () => {
    expect(dailyProbeAllowed(0, false)).toBe(true);
    expect(dailyProbeAllowed(1, false)).toBe(false);
    expect(dailyProbeAllowed(1, true)).toBe(true);
    expect(dailyProbeAllowed(2, true)).toBe(false);
    expect(dailyProbeAllowed(-1, true)).toBe(false);
    expect(dailyProbeAllowed(0.5, true)).toBe(false);
  });
});
