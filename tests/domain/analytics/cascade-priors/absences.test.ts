// absences.test.ts — the historical absence set (plan 10 C6, B6 "≥ 10 historical starter absences";
// sib research 05 §6 Evaluation "every starter absence of ≥ 2 games … over the next 1–4 weeks"): an
// RB1 who played the last pre-window game and missed ≥ 2 consecutive TEAM games (a bye skipped) is an
// event with his vacated shares, the team's volume before and during, the post window capped at 4
// games and the teammates E7 would see (an opportunity with him, or listed on the first absence
// week's chart; a co-absent starter excluded; OTHER positions only in the team totals); and every
// rule that refuses an event (did not play the game before, one game missed, too small a share,
// too few pre games, the week past the fantasy season), adversarially.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ABSENCE_RULES,
  findAbsences,
  rulesValid,
} from "../../../../src/domain/analytics/cascade-priors/absences.js";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";
import { teamSeason, type Cell } from "./helpers/synth.js";

type Week = Record<string, Cell>;
/** A base week: RB a (15 carries), RB b, WRs c d e, TE f, QB q, an OTHER lineman o. */
const base = (over: Week = {}): Week => ({
  a: ["RB", 3, 15, 0, 3, 1],
  b: ["RB", 2, 4, 0, 1, 2],
  c: ["WR", 8, 0, 2, 0, 1],
  d: ["WR", 6, 0, 1, 0, 1],
  e: ["WR", 3, 0, 0, 0, 2],
  f: ["TE", 5, 0, 1, 0, 1],
  q: ["QB", 0, 3, 0, 0, 1],
  o: ["OTHER", 1, 0, 0, 0],
  ...over,
});

/** Weeks 1–4 normal, 5 a bye, a misses 6–8 (b takes over); g only on the week-6 chart. */
function rbAbsence(): ReturnType<typeof teamSeason> {
  const missing: Week = { ...base(), a: ["RB", 0, 0, 0, 0, 1], b: ["RB", 3, 14, 0, 3, 1] };
  delete missing.a;
  return teamSeason(2024, "T1", {
    1: base(),
    2: base(),
    3: base(),
    4: base(),
    6: { ...missing, g: ["RB", 0, 0, 0, 0, 2] },
    7: missing,
    8: missing,
    9: base(),
  });
}

describe("findAbsences — the event", () => {
  const events = findAbsences(rbAbsence());
  const e = events.find((x) => x.injured.role === "RB1");
  it("one RB1 absence starting week 6 (the bye skipped), pre weeks 1–4, post 6–8", () => {
    expect(e).toBeDefined();
    expect(e?.week).toBe(6);
    expect(e?.pre_weeks).toEqual([1, 2, 3, 4]);
    expect(e?.post_weeks).toEqual([6, 7, 8]);
    expect(e?.games_missed).toBe(3);
    expect(e?.season).toBe(2024);
    expect(e?.team).toBe("T1");
  });
  it("vacated shares over the games he played; team volume per game, OTHER included", () => {
    // team per game before: targets 3+2+8+6+3+5+0+1 = 28, carries 15+4+3 = 22, rz 3+1+2+1+1 = 8
    expect(e?.team_pre).toEqual({ targets: 28, carries: 22, rz: 8 });
    expect(e?.injured.pre.carries).toBeCloseTo(15 / 22, 12);
    expect(e?.injured.pre.targets).toBeCloseTo(3 / 28, 12);
    expect(e?.injured.pre.rz).toBeCloseTo(3 / 8, 12);
    // after: targets 3+8+6+3+5+1 = 26, carries 14+3 = 17
    expect(e?.team_post.targets).toBe(26);
    expect(e?.team_post.carries).toBe(17);
  });
  it("teammates: skill players with an opportunity or on the week's chart, never OTHER or him", () => {
    const ids = e?.teammates.map((t) => t.player);
    expect(ids).toEqual(["b", "c", "d", "e", "f", "g", "q"]);
    const b = e?.teammates.find((t) => t.player === "b");
    expect(b?.role).toBe("RB1"); // the successor by carries
    expect(b?.pre.carries).toBeCloseTo(4 / 22, 12);
    expect(b?.post.carries).toBeCloseTo(14 / 17, 12);
    expect(b?.pre_opportunities).toBe(6);
    const g = e?.teammates.find((t) => t.player === "g");
    expect(g?.role).toBe("RB2");
    expect(g?.depth).toBe(2);
    expect(g?.pre_opportunities).toBe(0);
    expect(e?.teammates.find((t) => t.player === "c")?.role).toBe("WR1");
    expect(e?.teammates.find((t) => t.player === "q")?.role).toBe("QB1");
  });
  it("no other starter is absent, so no other event", () => {
    expect(events.map((x) => x.injured.role)).toEqual(["RB1"]);
  });
});

describe("findAbsences — what refuses an event", () => {
  const weeks = (m: Record<number, Week>) => teamSeason(2024, "T1", m);
  const missing = (): Week => {
    const w = base({ b: ["RB", 3, 14, 0, 3, 1] });
    delete w.a;
    return w;
  };
  it("an absence starts once: a week whose game before he also missed starts nothing", () => {
    const m = missing();
    const evs = findAbsences(weeks({ 1: base(), 2: base(), 3: m, 4: m, 5: m }));
    expect(evs.map((e) => [e.injured.role, e.week])).toEqual([["RB1", 3]]);
  });
  it("one game missed is not an absence; two is", () => {
    const m = missing();
    expect(findAbsences(weeks({ 1: base(), 2: base(), 3: m, 4: base() }))).toHaveLength(0);
    expect(findAbsences(weeks({ 1: base(), 2: base(), 3: m, 4: m, 5: base() }))).toHaveLength(1);
  });
  it("one pre game is too few", () => {
    const m = missing();
    expect(findAbsences(weeks({ 1: base(), 2: m, 3: m }))).toHaveLength(0);
  });
  it("a starter below the minimum share is no starter", () => {
    const thin = (): Week =>
      base({ a: ["RB", 0, 5, 0, 0, 1], b: ["RB", 0, 4, 0, 0, 2], q: ["QB", 0, 9] });
    const m = thin();
    delete m.a;
    // a's carry share 5/18 < 0.35
    expect(findAbsences(weeks({ 1: thin(), 2: thin(), 3: m, 4: m }))).toHaveLength(0);
  });
  it("weeks past the fantasy season (17) do not count as missed", () => {
    const m = missing();
    expect(findAbsences(weeks({ 14: base(), 15: base(), 16: base(), 17: m, 18: m }))).toHaveLength(
      0,
    );
    expect(
      findAbsences(weeks({ 14: base(), 15: base(), 16: base(), 17: m, 18: m }), {
        ...DEFAULT_ABSENCE_RULES,
        last_week: 18,
      }),
    ).toHaveLength(1);
  });
  it("the post window is capped at four games; games_missed counts them all", () => {
    const m = missing();
    const e = findAbsences(weeks({ 1: base(), 2: base(), 3: m, 4: m, 5: m, 6: m, 7: m, 8: m }))[0];
    expect(e?.post_weeks).toEqual([3, 4, 5, 6]);
    expect(e?.games_missed).toBe(6);
  });
  it("a zero-opportunity row is an absence too (inactive but on the chart)", () => {
    const m = base({ a: ["RB", 0, 0, 0, 0, 1], b: ["RB", 3, 14, 0, 3, 1] });
    expect(findAbsences(weeks({ 1: base(), 2: base(), 3: m, 4: m }))).toHaveLength(1);
  });
});

describe("findAbsences — co-absences, receivers, seasons", () => {
  it("a co-absent starter is not a beneficiary; WR1 and WR2 absences are events of their own", () => {
    const m = base();
    delete m.c;
    delete m.d;
    const evs = findAbsences(teamSeason(2024, "T1", { 1: base(), 2: base(), 3: m, 4: m }));
    expect(evs.map((e) => e.injured.role)).toEqual(["WR1", "WR2"]);
    for (const e of evs) {
      const ids = e.teammates.map((t) => t.player);
      expect(ids).not.toContain("c");
      expect(ids).not.toContain("d");
    }
  });
  it("a partly-absent other starter stays a teammate (he played a post game)", () => {
    const m = base();
    delete m.c;
    const m2 = base();
    delete m2.c;
    delete m2.d;
    const evs = findAbsences(teamSeason(2024, "T1", { 1: base(), 2: base(), 3: m, 4: m2 }));
    const wr1 = evs.find((e) => e.injured.role === "WR1");
    expect(wr1?.teammates.map((t) => t.player)).toContain("d");
  });
  it("the successor rule names the depth chart's next receiver behind the two remaining starters", () => {
    const w = (): Week => base({ h: ["WR", 2, 0, 0, 0, 3], i: ["WR", 0, 0, 0, 0, 2] });
    const m = w();
    delete m.c;
    const evs = findAbsences(teamSeason(2024, "T1", { 1: w(), 2: w(), 3: m, 4: m }));
    const e = evs.find((x) => x.injured.role === "WR1");
    const role = (p: string) => e?.teammates.find((t) => t.player === p)?.role;
    // remaining by targets: d 6, e 3, h 2, i 0 → d, e keep WR1, WR2; then depth: e? no — e is a
    // starter; behind them i (depth 2) before h (depth 3)
    expect([role("d"), role("e"), role("i"), role("h")]).toEqual(["WR1", "WR2", "WR3", "WR4"]);
    const usage = findAbsences(
      teamSeason(2024, "T1", { 1: w(), 2: w(), 3: m, 4: m }),
      undefined,
      "usage",
    );
    const u = usage.find((x) => x.injured.role === "WR1");
    expect(u?.teammates.find((t) => t.player === "h")?.role).toBe("WR3");
  });
  it("seasons and teams are read apart; output sorted (season, team, week, role)", () => {
    const m = base();
    delete m.a;
    delete m.f;
    const rows = [
      ...teamSeason(2025, "T1", { 1: base(), 2: base(), 3: m, 4: m }),
      ...teamSeason(2024, "T2", { 1: base(), 2: base(), 3: m, 4: m }),
      ...teamSeason(2024, "T1", { 5: base(), 6: base(), 7: m, 8: m }),
    ];
    expect(
      findAbsences(rows).map(
        (e) => `${String(e.season)}${e.team}${String(e.week)}${e.injured.role}`,
      ),
    ).toEqual(["2024T17RB1", "2024T17TE1", "2024T23RB1", "2024T23TE1", "2025T13RB1", "2025T13TE1"]);
  });
  it("no rows, no events; a lone week, no events", () => {
    expect(findAbsences([])).toEqual([]);
    expect(findAbsences(teamSeason(2024, "T1", { 1: base() }))).toEqual([]);
  });
});

describe("absence rules are validated", () => {
  it("defaults are valid; nonsense is refused with invalid_request", () => {
    expect(rulesValid(DEFAULT_ABSENCE_RULES)).toBe(true);
    const bad = [
      { pre_games: 0 },
      { min_pre_games_played: 5 },
      { min_games_missed: 0 },
      { max_post_games: 1.5 },
      { first_week: 10, last_week: 9 },
      { first_week: Number.NaN },
      { min_starter_share: { RB: 1.2, WR: 0.1, TE: 0.1 } },
      { min_starter_share: { RB: Number.NaN, WR: 0.1, TE: 0.1 } },
    ];
    for (const b of bad) {
      const r = { ...DEFAULT_ABSENCE_RULES, ...b };
      expect(rulesValid(r)).toBe(false);
      expect(() => findAbsences([], r)).toThrow(AnalyticsError);
    }
  });
});
