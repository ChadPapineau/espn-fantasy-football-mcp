// rank-final.test.ts — `rankFinalStandings` (src/domain/analytics/seeding.ts, the Phase 3 additive
// export behind plan 10 C4): the simulator's own chain applied once to final standings; its
// refusals (typed AnalyticsError `invalid_request`, never a crash), the truncated chain, the coin's
// two orders, and that it agrees with the simulator's current-standings cutoff ranking.
import { describe, expect, it } from "vitest";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";
import {
  rankFinalStandings,
  type FinalGame,
  type FinalStandingTeam,
} from "../../../../src/domain/analytics/seeding.js";

const T = (
  team_id: number,
  wins: number,
  pf: number,
  division_id: number | null = 0,
): FinalStandingTeam => ({
  team_id,
  division_id,
  wins,
  losses: 3 - wins,
  ties: 0,
  points_for: pf,
  points_against: 300,
});
const teams = [T(1, 2, 300), T(2, 2, 320), T(3, 1, 280), T(4, 1, 280)];
const games: FinalGame[] = [{ home: 3, away: 4, winner: "AWAY" }];

describe("rankFinalStandings", () => {
  it("ranks by the chain: win %, then PF, then head-to-head", () => {
    const r = rankFinalStandings({ teams, games, mode: "espn_rule", rule: "TOTAL_POINTS_SCORED" });
    expect(r.order).toEqual([2, 1, 4, 3]);
    expect(r.divisions_first).toBe(false);
    expect(r.known_rule).toBe(true);
    expect(r.chain[0]).toBe("win_pct");
  });

  it("reading (b) ranks by points for; ties fall to the coin in the requested order", () => {
    const b = rankFinalStandings({
      teams,
      games,
      mode: "points_only",
      rule: "TOTAL_POINTS_SCORED",
    });
    expect(b.order).toEqual([2, 1, 3, 4]);
    const rev = rankFinalStandings({
      teams,
      games,
      mode: "points_only",
      rule: "TOTAL_POINTS_SCORED",
      coin: "reverse",
    });
    expect(rev.order).toEqual([2, 1, 4, 3]);
    expect(b.chain).toEqual(["points_for", "coin_flip"]);
  });

  it("a truncated chain leaves ties in team-list order", () => {
    const zero = rankFinalStandings({ teams, games, mode: "espn_rule", rule: "X", levels: 0 });
    expect(zero.order).toEqual([1, 2, 3, 4]);
    expect(zero.known_rule).toBe(false);
    const one = rankFinalStandings({ teams, games, mode: "espn_rule", rule: "X", levels: 1 });
    expect(one.order).toEqual([1, 2, 3, 4]);
    const two = rankFinalStandings({ teams, games, mode: "espn_rule", rule: "X", levels: 2 });
    expect(two.order).toEqual([2, 1, 3, 4]);
  });

  it("division winners first under espn_rule with more than one division (not under points_only)", () => {
    const d = [T(1, 3, 300, 1), T(2, 2, 400, 1), T(3, 0, 100, 2), T(4, 1, 200, null)];
    const a = rankFinalStandings({
      teams: d,
      games: [],
      mode: "espn_rule",
      rule: "TOTAL_POINTS_SCORED",
    });
    expect(a.divisions_first).toBe(true);
    // winners: div 1 → 1; div 2 → 3; the null "division" → 4
    expect(a.order).toEqual([1, 4, 3, 2]);
    const b = rankFinalStandings({
      teams: d,
      games: [],
      mode: "points_only",
      rule: "TOTAL_POINTS_SCORED",
    });
    expect(b.divisions_first).toBe(false);
    expect(b.order).toEqual([2, 1, 4, 3]);
  });

  it("refuses malformed seasons with a typed error", () => {
    const bad: [string, () => unknown][] = [
      [
        "one team",
        () =>
          rankFinalStandings({ teams: teams.slice(0, 1), games: [], mode: "espn_rule", rule: "R" }),
      ],
      [
        "21 teams",
        () =>
          rankFinalStandings({
            teams: Array.from({ length: 21 }, (_, i) => T(i + 1, 1, 1)),
            games: [],
            mode: "espn_rule",
            rule: "R",
          }),
      ],
      [
        "duplicate id",
        () =>
          rankFinalStandings({
            teams: [T(1, 1, 1), T(1, 2, 2)],
            games: [],
            mode: "espn_rule",
            rule: "R",
          }),
      ],
      [
        "NaN",
        () =>
          rankFinalStandings({
            teams: [T(1, 1, Number.NaN), T(2, 1, 1)],
            games: [],
            mode: "espn_rule",
            rule: "R",
          }),
      ],
      [
        "negative",
        () =>
          rankFinalStandings({
            teams: [T(1, 1, -1), T(2, 1, 1)],
            games: [],
            mode: "espn_rule",
            rule: "R",
          }),
      ],
      [
        "fractional id",
        () =>
          rankFinalStandings({
            teams: [T(1.5, 1, 1), T(2, 1, 1)],
            games: [],
            mode: "espn_rule",
            rule: "R",
          }),
      ],
      [
        "unknown team",
        () =>
          rankFinalStandings({
            teams,
            games: [{ home: 1, away: 9, winner: "HOME" }],
            mode: "espn_rule",
            rule: "R",
          }),
      ],
      [
        "self game",
        () =>
          rankFinalStandings({
            teams,
            games: [{ home: 1, away: 1, winner: "HOME" }],
            mode: "espn_rule",
            rule: "R",
          }),
      ],
      [
        "undecided",
        () =>
          rankFinalStandings({
            teams,
            games: [{ home: 1, away: 2, winner: "UNDECIDED" as never }],
            mode: "espn_rule",
            rule: "R",
          }),
      ],
      [
        "levels",
        () => rankFinalStandings({ teams, games, mode: "espn_rule", rule: "R", levels: -1 }),
      ],
      [
        "levels frac",
        () => rankFinalStandings({ teams, games, mode: "espn_rule", rule: "R", levels: 1.5 }),
      ],
    ];
    for (const [label, f] of bad) {
      let err: unknown = null;
      try {
        f();
      } catch (e) {
        err = e;
      }
      expect(err, label).toBeInstanceOf(AnalyticsError);
      expect((err as AnalyticsError).code, label).toBe("invalid_request");
    }
  });

  it("a tie game counts half for head-to-head", () => {
    const tied = [T(1, 1, 300), T(2, 1, 300)];
    const r = rankFinalStandings({
      teams: tied,
      games: [{ home: 1, away: 2, winner: "TIE" }],
      mode: "espn_rule",
      rule: "TOTAL_POINTS_SCORED",
    });
    // head-to-head 0.5 each, division record 0.5 each, PA equal → the coin (forward: team 1)
    expect(r.order).toEqual([1, 2]);
    expect(
      rankFinalStandings({
        teams: tied,
        games: [{ home: 1, away: 2, winner: "TIE" }],
        mode: "espn_rule",
        rule: "TOTAL_POINTS_SCORED",
        coin: "reverse",
      }).order,
    ).toEqual([2, 1]);
  });
});
