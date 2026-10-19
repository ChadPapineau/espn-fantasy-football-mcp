// waivers-kdst-lines.test.ts — Stage C round 2, finding waivers-kdst-no-line-flattens (plan 07 E5
// Method "§5 K/D-ST (ESPN's brackets from S; native K/D-ST projections labelled)"; WaiverRequest.kdst
// "null → ESPN's projections as given"): the bracket model values a K/D-ST player-week only where its
// game has a betting line — a kicker reads his own team's implied total, a D/ST the opponent's — and
// every other player-week keeps ESPN's projection (the current week) or ROS share (later weeks). The
// regression: the tool passes the pro schedule with the implied totals it could read, which is none
// for a week whose line is not posted (nflverse carries lines a week or so ahead) and none at all
// without the games file; a missing line read as the league-average total, so every K and every D/ST
// — the user's starters included — got one value, the candidates tied in player-id order and the
// stream answered "no claim clears the premium" while saying the bracket model valued them.
// Synthetic data only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  analyzeWaivers,
  type WaiverCandidateInput,
  type WaiverPlayer,
  type WaiverRequest,
} from "../../../src/domain/analytics/waivers.js";
import type { ImpliedTotal } from "../../../src/domain/analytics/projection.js";
import { proSchedule, referenceSettings } from "./helpers.js";
import { myRoster, waiverRequest, WEEKS, wc } from "./p1-helpers.js";

/** My K (9) projected 6 a week and my D/ST (8) 4 — the finding's repro roster. */
function mine(k = 6, dst = 4): WaiverPlayer[] {
  return myRoster().map((p) =>
    p.player_id === 9
      ? { ...p, weekly: WEEKS.map(() => k) }
      : p.player_id === 8
        ? { ...p, weekly: WEEKS.map(() => dst) }
        : p,
  );
}

/** Free-agent streamers: K 501 (team 22) 11, K 502 (team 23) 5, D/ST 601 (team 26) 12, D/ST 602 (team 27) 2. */
const STREAMERS: readonly WaiverCandidateInput[] = [
  wc(501, "K", 11, "FREEAGENT"),
  wc(502, "K", 5, "FREEAGENT"),
  wc(601, "D/ST", 12, "FREEAGENT"),
  wc(602, "D/ST", 2, "FREEAGENT"),
];

/**
 * The pro schedule, every game still ahead of the call (Tuesday 2026-10-06 20:00Z; week 4 kicks off
 * Thursday the 8th): the claim-timing rules then leave every player droppable and every week
 * reachable, so only the K/D-ST valuation can move a number here.
 */
const SCHEDULE = proSchedule(2026, WEEKS, {
  kickoffMs: (w) => Date.UTC(2026, 9, 8 + 7 * (w - 4), 17, 0),
});

/** Implied totals for every team in `weeks`, except the teams listed in `missing`. */
function lines(weeks: readonly number[], missing: readonly number[] = []): ImpliedTotal[] {
  return weeks.flatMap((w) =>
    Array.from({ length: 32 }, (_, i) => i + 1)
      .filter((t) => !missing.includes(t))
      .map((t) => ({ week: w, pro_team_id: t, implied: 17 + ((t * 5 + w) % 12) })),
  );
}

function request(over: Partial<WaiverRequest> = {}): WaiverRequest {
  return waiverRequest({
    mine: mine(),
    candidates: STREAMERS,
    positions: ["K", "D/ST"],
    settings: referenceSettings(),
    ...over,
  });
}

type Data = Awaited<ReturnType<typeof analyzeWaivers>>["data"];
const byId = (d: Data, id: number) => d.candidates.find((x) => x.player_id === id);
/** What a candidate is worth and what to do with him — the fields a missing line must not move. */
const valuation = (d: Data) =>
  d.candidates.map((x) => ({
    player_id: x.player_id,
    s: x.s,
    value: x.value,
    verdict: x.verdict,
    drop: x.conditional_drop?.player_id ?? null,
  }));

describe("no betting line: ESPN's projections stand (finding waivers-kdst-no-line-flattens)", () => {
  it("the pro schedule without any implied total values every K/D-ST exactly as no bracket model would", async () => {
    // regression: all four candidates were valued at the league-average total — s 0, pass, tied
    const plain = await analyzeWaivers(request());
    const unlined = await analyzeWaivers(
      request({ kdst: { schedule: SCHEDULE, implied_totals: [] } }),
    );
    expect(valuation(unlined.data)).toEqual(valuation(plain.data));
    expect(byId(unlined.data, 601)).toMatchObject({ verdict: "fa_add_now" });
    expect(byId(unlined.data, 501)).toMatchObject({ verdict: "fa_add_now" });
    expect(byId(unlined.data, 601)?.s ?? 0).toBeGreaterThan(byId(unlined.data, 501)?.s ?? 0);
    expect(byId(unlined.data, 501)?.s ?? 0).toBeGreaterThan(0);
    for (const id of [502, 602]) expect(byId(unlined.data, id)?.verdict).toBe("pass");
    // ESPN projects them differently, so they never tie
    expect(new Set(unlined.data.candidates.map((x) => x.s)).size).toBe(4);
    // each streamer's own number is ESPN's, this week and next
    expect(byId(unlined.data, 501)?.signals).toEqual([{ kind: "stream", value: 11 }]);
    expect(byId(unlined.data, 501)?.kdst).toMatchObject({
      implied_total: null,
      brackets_e: null,
      next_week: { opponent: "T21", implied_total: null, e: 11 },
    });
    expect(unlined.data.rec.action).toBe("add 2 free agents now");
  });

  it("says the bracket model could not run, week by week, and warns for this week", async () => {
    const out = await analyzeWaivers(request({ kdst: { schedule: SCHEDULE, implied_totals: [] } }));
    const said = out.data.rec.assumptions.find((a) => a.text.startsWith("K and D/ST:"));
    expect(said?.text).toContain("ESPN's projection where not");
    expect(said?.text).toContain("week 4 none, week 5 none, week 6 none");
    expect(
      out.data.rec.assumptions.some((a) => a.text.startsWith("K and D/ST are valued on the")),
    ).toBe(false);
    expect(out.warnings).toContain(
      "6 of 6 K/D-ST players' week 4 games have no betting line: valued on ESPN's projection, not the bracket model",
    );
  });

  it("a kicker-only call counts the kickers' games only (the stream-kdef Skill asks one slot per call)", async () => {
    const out = await analyzeWaivers(
      request({ positions: ["K"], kdst: { schedule: SCHEDULE, implied_totals: [] } }),
    );
    expect(out.warnings).toContain(
      "3 of 3 K/D-ST players' week 4 games have no betting line: valued on ESPN's projection, not the bracket model",
    );
  });

  it("lines posted for this week only: the bracket model this week, ESPN's ROS share in the look-ahead weeks", async () => {
    const out = await analyzeWaivers(
      request({ kdst: { schedule: SCHEDULE, implied_totals: lines([4]) } }),
    );
    const k = byId(out.data, 501);
    expect(k?.kdst?.implied_total).not.toBeNull();
    expect(k?.kdst?.brackets_e).not.toBeNull();
    // next week has no line: ESPN's number, never the league-average model value
    expect(k?.kdst?.next_week).toMatchObject({ implied_total: null, e: 11 });
    const said = out.data.rec.assumptions.find((a) => a.text.startsWith("K and D/ST:"));
    expect(said?.text).toContain("week 4 lined, week 5 none, week 6 none");
    expect(out.warnings.some((w) => w.includes("have no betting line"))).toBe(false);
  });

  it("every game lined: the bracket model throughout, said as before", async () => {
    const out = await analyzeWaivers(
      request({ kdst: { schedule: SCHEDULE, implied_totals: lines([4, 5, 6]) } }),
    );
    expect(
      out.data.rec.assumptions.some((a) =>
        a.text.startsWith("K and D/ST are valued on the implied-total bracket model"),
      ),
    ).toBe(true);
    for (const x of out.data.candidates) expect(x.kdst?.next_week?.implied_total).not.toBeNull();
  });

  it("a game without a line in a lined week: that player keeps ESPN's projection, the rest the model — counted in the warning", async () => {
    // K 501 plays for team 22 (against 21): his game alone has no line
    const out = await analyzeWaivers(
      request({ kdst: { schedule: SCHEDULE, implied_totals: lines([4, 5, 6], [21, 22]) } }),
    );
    expect(byId(out.data, 501)?.signals[0]?.value).toBe(11);
    expect(byId(out.data, 501)?.kdst?.implied_total).toBeNull();
    expect(byId(out.data, 502)?.kdst?.implied_total).not.toBeNull();
    expect(byId(out.data, 502)?.signals[0]?.value).not.toBe(5);
    expect(out.warnings).toContain(
      "1 of 6 K/D-ST players' week 4 games have no betting line: valued on ESPN's projection, not the bracket model",
    );
    const said = out.data.rec.assumptions.find((a) => a.text.startsWith("K and D/ST:"));
    expect(said?.text).toContain("week 4 5 of 6 lined");
  });

  it("property: with no line posted, the schedule changes no valuation, whatever ESPN projects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: 0, max: 20, noNaN: true }), { minLength: 4, maxLength: 4 }),
        fc.double({ min: 0, max: 15, noNaN: true }),
        fc.double({ min: 0, max: 15, noNaN: true }),
        async (vals, k, dst) => {
          const candidates = STREAMERS.map((c, i) => ({
            ...c,
            weekly: WEEKS.map(() => vals[i] ?? 0),
          }));
          const base = { mine: mine(k, dst), candidates };
          const plain = await analyzeWaivers(request(base));
          const unlined = await analyzeWaivers(
            request({ ...base, kdst: { schedule: SCHEDULE, implied_totals: [] } }),
          );
          expect(valuation(unlined.data)).toEqual(valuation(plain.data));
          expect(unlined.data.rec.subjects).toEqual(plain.data.rec.subjects);
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);
});
