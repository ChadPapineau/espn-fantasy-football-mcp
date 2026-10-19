// boxscore-bye.test.ts — a bye never blocks espn_get_box_score's `final`, and a bye player reads `bye`
// in the box score exactly as espn_get_roster derives it (plan 07 A5 game states incl. `bye`; plan 07
// B1). Stage C finding boxscore-bye-blocks-final: A5 took each player's game state from the box score
// alone (an actual line or not): ESPN sends no weekly entry in a bye week, so a bye player read `pre`
// during the week and `bye` after it, and `final` (every entry `final`) stayed false for any week
// with one rostered player on bye — nearly every week 5–14. Fixture mode on fx-10h, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BoxScoreMatchup, ProSchedule, Stamped } from "../../src/providers/platform.js";
import { faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");

function manifestOf(dir: string): { clock: string; my_team_id: number } {
  return JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
}

interface BoxPlayer {
  player_id: number;
  game_state: string;
}
interface Box {
  final: boolean;
  matchups: { home: { players: BoxPlayer[] }; away: { players: BoxPlayer[] } | null }[];
}
const boxPlayers = (b: Box): BoxPlayer[] =>
  b.matchups.flatMap((m) => [...m.home.players, ...(m.away?.players ?? [])]);

describe("a bye in the box score (Stage C boxscore-bye-blocks-final)", () => {
  it("live week 5 (sunday-live): the KC bench player on bye reads bye in the box score, as on the roster", async () => {
    const dir = path.join(FX, "sunday-live");
    const m = manifestOf(dir);
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: dir },
      teamId: m.my_team_id,
      clock: m.clock,
      publishEspn: false,
    });
    try {
      const c = await connect(world);
      // 4428331 plays for KC, on bye in week 5: ESPN's week-5 box score carries no entry for him
      const box = await call(c.client, "espn_get_box_score", { week: 5 });
      expect(box.isError, JSON.stringify(box.body).slice(0, 300)).toBe(false);
      const inBox = boxPlayers(box.body.data as Box).find((p) => p.player_id === 4428331);
      const roster = await call(c.client, "espn_get_roster", { week: 5 });
      const onRoster = (
        roster.body.data as { players: { player_id: number; game_state: string }[] }
      ).players.find((p) => p.player_id === 4428331);
      expect(onRoster?.game_state).toBe("bye");
      expect(inBox?.game_state).toBe("bye");
      // the week is live: never final
      expect((box.body.data as Box).final).toBe(false);
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);

  it("a finished week with one rostered player on bye is final", async () => {
    const m = manifestOf(FX);
    const world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX },
      teamId: m.my_team_id,
      clock: m.clock,
      publishEspn: false,
    });
    try {
      // week 4 as ESPN serves a bye: team 28 (my bench player 4697815's) has no week-4 game, and the
      // box score carries no actual line for him
      const BYE_TEAM = 28;
      const BYE_PLAYER = 4697815;
      const s = faulty(world.services, {
        getProSchedule: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<ProSchedule>;
          const games = got.value.games.filter(
            (g) =>
              !(
                g.week === 4 &&
                (g.home_pro_team_id === BYE_TEAM || g.away_pro_team_id === BYE_TEAM)
              ),
          );
          return { ...got, value: { ...got.value, games } };
        },
        getBoxScores: async (real, ...args) => {
          const got = (await real(...args)) as Stamped<readonly BoxScoreMatchup[]>;
          const strip = (side: BoxScoreMatchup["home"]): BoxScoreMatchup["home"] => ({
            ...side,
            entries: side.entries.map((e) =>
              e.player.ref.id === BYE_PLAYER
                ? { ...e, actual: null, projected: null, game_state: "bye" as const }
                : e,
            ),
          });
          return {
            ...got,
            value: got.value.map((x) => ({
              ...x,
              home: strip(x.home),
              away: x.away === null ? null : strip(x.away),
            })),
          };
        },
      });
      const c = await connect(world, { services: s });
      const r = await call(c.client, "espn_get_box_score", { week: 4 });
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const box = r.body.data as Box;
      const states = boxPlayers(box).map((p) => p.game_state);
      expect(states).toContain("bye");
      expect(states.every((x) => x === "final" || x === "bye")).toBe(true);
      expect(box.final).toBe(true);
      expect((r.body.meta as { provisional: boolean }).provisional).toBe(false);
      // the control: the same week with no bye is final as well
      const plain = await connect(world);
      const p = await call(plain.client, "espn_get_box_score", { week: 4 });
      expect((p.body.data as Box).final).toBe(true);
      await plain.close();
      await c.close();
    } finally {
      world.cleanup();
    }
  }, 60_000);
});
