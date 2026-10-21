// matchup-tie.test.ts — Stage C finding matchup-tie-winner-null (plan 07 A3; plan 05 §2
// `providers/espn/normalize`): ESPN's `schedule[].winner` "TIE" is a decided result. It read as
// null (the wire list knew HOME/AWAY/UNDECIDED only), so every season simulation re-played a
// finished tie as a remaining game. Held here: the wire's winner values are exactly the domain's
// MatchupWinner (a type-level equality, so the two lists cannot drift apart again); the normaliser
// keeps a recorded tie as TIE (league-c's 2024 season: three regular-season ties); a value ESPN
// adds still reads as null, never coerced; and the real provider in fixture mode serves the
// recorded ties as TIE.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { MatchupWinner } from "../../../src/domain/league/types.js";
import { normalizeMatchups } from "../../../src/providers/espn/normalize.js";
import { MATCHUP_WINNERS } from "../../../src/providers/espn/types.js";
import { mMatchupSchema } from "../../../src/providers/espn/views/index.js";
import { historyBody, historyFixtureFetch } from "../../fixtures/helpers/history-fixtures.js";
import { makeWorld } from "./helpers.js";

/** League-c's recorded 2024 season (both parts of the split response). */
const season2024 = () => mMatchupSchema.parse(historyBody(2024, "league-c", "mMatchup"));

describe("matchup winners (Stage C finding matchup-tie-winner-null)", () => {
  it("the wire's winner values are exactly the domain's MatchupWinner, TIE included", () => {
    expectTypeOf<(typeof MATCHUP_WINNERS)[number]>().toEqualTypeOf<MatchupWinner>();
    expect([...MATCHUP_WINNERS].sort()).toEqual(["AWAY", "HOME", "TIE", "UNDECIDED"]);
  });

  it("a recorded finished tie is TIE, never null (2024: 107-107, 75-75, 114-114)", () => {
    const ms = normalizeMatchups(season2024(), null, null);
    const ties = ms.filter((m) => m.winner === "TIE");
    expect(ties.map((m) => [m.matchup_period, m.home.points, m.away?.points])).toEqual([
      [1, 107, 107],
      [3, 75, 75],
      [11, 114, 114],
    ]);
    // every recorded row has a winner ESPN names: none is read as unknown
    expect(ms.filter((m) => m.winner === null)).toEqual([]);
  });

  it("every known value passes through unchanged; a value ESPN adds reads as null", () => {
    const body = season2024();
    const row = body.schedule[0];
    if (row === undefined) throw new Error("no recorded row");
    for (const v of [...MATCHUP_WINNERS, "DRAW", "tie", "", " TIE", "TIE "]) {
      const [m] = normalizeMatchups({ ...body, schedule: [{ ...row, winner: v }] }, null, null);
      expect(m?.winner, JSON.stringify(v)).toBe(
        (MATCHUP_WINNERS as readonly string[]).includes(v) ? v : null,
      );
    }
  });

  it("the real provider serves the recorded ties as TIE (fixture mode over the history)", async () => {
    const w = makeWorld({ fetch: historyFixtureFetch("league-c") });
    const got = await w.provider.getMatchups({ ...w.ref, season: 2024 });
    expect(got.value.filter((m) => m.winner === "TIE").map((m) => m.matchup_period)).toEqual([
      1, 3, 11,
    ]);
    expect(got.value.some((m) => m.winner === null)).toBe(false);
  });
});
