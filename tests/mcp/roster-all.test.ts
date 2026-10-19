// roster-all.test.ts — espn_get_roster all: true never drops this week's opponent (plan 07 B1 `all`;
// skills/weekly step 2 reads "the user's roster and the opponent's from the same cached read").
// Stage C finding roster-all-truncated-drops-opponent: ten compact rosters exceed the 20 000-character
// budget, teams left from the end and the order was mine then team id, so on fx-10h week 5 the
// opponent (team 10) was cut — `rosters truncated to 6 of 10 teams` — and the warning did not say
// which teams were missing. Fixture mode on fx-10h (10 teams, the owner's size), no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");

describe("all: true keeps my opponent (Stage C roster-all-truncated-drops-opponent)", () => {
  it("week 5: mine first, the opponent second; the warning names every team left out", async () => {
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
      clock: string;
      my_team_id: number;
    };
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX },
      teamId: m.my_team_id,
      clock: m.clock,
    });
    try {
      const c = await connect(world);
      const sb = await call(c.client, "espn_get_scoreboard", { week: 5 });
      const mine = (
        sb.body.data as {
          matchups: { home: { team_id: number }; away: { team_id: number } | null }[];
        }
      ).matchups.find((x) => x.home.team_id === m.my_team_id || x.away?.team_id === m.my_team_id);
      const opponent =
        mine?.home.team_id === m.my_team_id ? mine.away?.team_id : mine?.home.team_id;
      expect(opponent).toBe(10); // the finding's week: [2, 10]
      const r = await call(c.client, "espn_get_roster", { all: true, week: 5 });
      expect(r.isError).toBe(false);
      const ids = (r.body.data as { rosters: { team_id: number }[] }).rosters.map((x) => x.team_id);
      expect(ids[0]).toBe(m.my_team_id);
      expect(ids[1]).toBe(opponent);
      // the rest by id, and every omitted team named so the model can ask for it
      expect(ids.slice(2)).toEqual([...ids.slice(2)].sort((a, b) => a - b));
      expect(r.body.truncated).toBe(true);
      const omitted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((t) => !ids.includes(t));
      expect(omitted.length).toBeGreaterThan(0);
      const w = (r.body.warnings as string[]).find((x) => x.startsWith("rosters truncated"));
      expect(w).toBe(
        `rosters truncated to ${String(ids.length)} of 10 teams to fit the 20000-character budget (mine and this week's opponent first); not shown: team ${omitted.join(", ")} — pass team_id for any of them`,
      );
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);
});
