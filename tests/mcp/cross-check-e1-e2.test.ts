// cross-check-e1-e2.test.ts — changelog §R10, R10-29 (plan 01 D15; plan 07 C13, E1, E2): E2's
// `espn_cross_check.starter_disagreements[]` compares ESPN's weekly projection with the own model's
// line (E1's `inputs.own`) by E1's disagreement percentage and flag rule — never with the blended
// mean, which is ESPN's own while `weight_espn = 1.0` (before, the list compared ESPN with itself and
// was always empty). `ours` is that own line; a starter with no own line is never listed. E1
// (`espn_project_players`) and E2 (`espn_analyze_lineup`) agree for every starter: on the base
// fixture, on `espn-proj-disagree` (plan 09 SS-6-E's variant: Team 02's first RB starter at 1.5×
// ESPN's recording, about 30 % from the own line by E1's pct) and over synthetic rosters (a
// property). The production stdio entry in fixture mode on fx-10h, the datasets published as the
// eval servers' `--seed-datasets` publishes them (the own line needs the trailing rows); no network.
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { analyzeLineup, type LineupPlayer } from "../../src/domain/analytics/lineup.js";
import { seedDatasets } from "../integration/helpers/seed.js";
import { bare, clockAndRng, dist, ELIGIBLE, referenceSlots } from "../domain/analytics/helpers.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const CLOCK_AT = "2026-10-07T01:00:00.000Z";

interface E1Week {
  inputs: { espn: number | null; own: number | null };
  disagreement: { pct: number | null; flagged: boolean };
}
interface Slot {
  slot: string;
  player_id: number;
}

describe.each([
  ["base", "", "core", [4032473, 4430878, 4431452, 4882093, 5083076]],
  [
    "espn-proj-disagree",
    "espn-proj-disagree",
    "core",
    [4032473, 4379399, 4430878, 4431452, 4882093, 5083076],
  ],
  ["base", "", "full", null],
] as const)(
  "R10-29 on %s (%s, %s): E1 and E2 agree for every starter",
  (_n, variant, toolset, listed) => {
    let world: World;
    let client: Client;
    let close: () => Promise<void>;
    beforeAll(async () => {
      world = await makeWorld({
        env: { EFF_FIXTURE_DIR: path.join(FX, variant), EFF_TOOLSET: toolset },
        teamId: 2,
        clock: CLOCK_AT,
        publishEspn: false,
      });
      await seedDatasets(world.store, {
        storePath: storePath(world.cache),
        datasetDir: datasetDir(world.cache),
        cache: world.cache,
        clock: world.clock,
        season: 2026,
      });
      world.store.reopenChangedDatasets();
      ({ client, close } = await connect(world, { modern: true, options: { toolset } }));
    }, 300_000);
    afterAll(async () => {
      await close();
      world.cleanup();
    });

    it("every starter E1 flags with an own line is listed with E1's numbers; no other is", async () => {
      const e1 = await call(client, "espn_project_players", {
        players: { team_id: 2 },
        horizon: "week",
      });
      expect(e1.isError, JSON.stringify(e1.body).slice(0, 300)).toBe(false);
      const byId = new Map(
        (e1.body.data as { projections: { player_id: number; weeks: E1Week[] }[] }).projections.map(
          (p) => [p.player_id, p.weeks[0]],
        ),
      );
      const e2 = await call(client, "espn_analyze_lineup", {});
      expect(e2.isError, JSON.stringify(e2.body).slice(0, 300)).toBe(false);
      const d = e2.body.data as {
        no_move: boolean;
        espn_cross_check: {
          starter_disagreements: { player_id: number; ours: number; espn: number; pct: number }[];
        };
      };
      // no move on these fixtures: the told lineup is the current one, the roster's starters
      expect(d.no_move).toBe(true);
      const roster = await call(client, "espn_get_roster", { week: 5 });
      const starters = (roster.body.data as { players: Slot[] }).players
        .filter((s) => s.slot !== "BE" && s.slot !== "IR")
        .map((s) => s.player_id);
      expect(starters.length).toBe(9);
      const want = starters
        .flatMap((id) => {
          const w = byId.get(id);
          if (w === undefined) return [];
          const { espn, own } = w.inputs;
          const { pct, flagged } = w.disagreement;
          return own !== null && espn !== null && pct !== null && flagged
            ? [{ player_id: id, ours: own, espn, pct }]
            : [];
        })
        .sort((a, b) => a.player_id - b.player_id);
      expect(d.espn_cross_check.starter_disagreements).toEqual(want);
      // never against the blended mean: at weight_espn 1.0 that list would be empty
      expect(want.length).toBeGreaterThan(0);
      if (listed !== null)
        expect(d.espn_cross_check.starter_disagreements.map((x) => x.player_id)).toEqual(listed);
    }, 120_000);

    if (variant === "espn-proj-disagree")
      it("SS-6-E's starter: ESPN about 30 % from the own line by E1's pct (James Cook III, RB)", async () => {
        const e2 = await call(client, "espn_analyze_lineup", {});
        const x = (
          e2.body.data as {
            espn_cross_check: {
              starter_disagreements: {
                player_id: number;
                ours: number;
                espn: number;
                pct: number;
              }[];
            };
          }
        ).espn_cross_check.starter_disagreements.find((y) => y.player_id === 4379399);
        expect(x).toEqual({ player_id: 4379399, ours: 16.868, espn: 23.849, pct: 0.293 });
      }, 120_000);
  },
);

describe("R10-29 property: over synthetic rosters E2 lists exactly the told starters E1 flags with an own line", () => {
  const SLOTS: [string, number][] = [
    ["QB", 0],
    ["RB", 2],
    ["RB", 2],
    ["WR", 4],
    ["WR", 4],
    ["TE", 6],
    ["RB", 23],
    ["D/ST", 16],
    ["K", 17],
    ["RB", 20],
    ["WR", 20],
  ];
  it("listed ⟺ a starter of the told lineup, own line present and E1-flagged; the numbers are E1's", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            mean: fc.double({ min: 1, max: 30, noNaN: true }),
            espn: fc.option(fc.double({ min: 0.5, max: 30, noNaN: true }), { nil: null }),
            own: fc.option(fc.double({ min: 0, max: 30, noNaN: true }), { nil: null }),
          }),
          { minLength: SLOTS.length, maxLength: SLOTS.length },
        ),
        (rows) => {
          const players: LineupPlayer[] = SLOTS.map(([pos, slot], i) => {
            const r = rows[i] ?? { mean: 5, espn: null, own: null };
            const pct =
              r.espn !== null && r.own !== null && r.espn > 0
                ? Math.round((Math.abs(r.espn - r.own) / r.espn) * 1000) / 1000
                : null;
            return {
              player_id: i + 1,
              gsis_id: null,
              name: bare(`Player ${String(i + 1)}`),
              position: pos,
              eligible_slot_ids: ELIGIBLE[pos] ?? [20],
              injury_status: null,
              pro_team_id: i + 1,
              slot_id: slot,
              locked: false,
              lock_at: "2026-10-11T17:00:00.000Z",
              points: dist(r.mean, 0.5),
              p_active: 1,
              // the blended mean equals ESPN's (weight_espn 1.0): what the old list compared
              espn_projection: r.mean,
              e1_cross_check: {
                espn: r.espn,
                own: r.own,
                pct,
                flagged: pct !== null && pct > 0.25,
              },
              percent_started: 50,
              role_games: 4,
            };
          });
          const out = analyzeLineup({
            roster: referenceSlots(),
            players,
            opponent: null,
            seeding_config: { mode: "espn_rule", confirmed_at: null },
            clock: clockAndRng("2026-10-10T12:00:00.000Z").clock,
          });
          // the told lineup: the current one with the made changes applied (rec.subjects)
          const told = new Set(
            out.rec.no_move
              ? out.current_lineup
                  .filter((s) => s.slot !== "BE" && s.slot !== "IR")
                  .map((s) => s.player_id)
              : out.rec.subjects.filter((s) => s.role === "start").map((s) => s.player_id ?? -1),
          );
          const byId = new Map(players.map((p) => [p.player_id, p]));
          for (const x of out.espn_cross_check.starter_disagreements) {
            const c = byId.get(x.player_id)?.e1_cross_check;
            expect(c?.flagged).toBe(true);
            expect(c?.own).not.toBeNull();
            expect(x).toEqual({ player_id: x.player_id, ours: c?.own, espn: c?.espn, pct: c?.pct });
          }
          if (out.rec.no_move) {
            const want = [...told]
              .filter((id) => {
                const c = byId.get(id)?.e1_cross_check;
                return c?.flagged === true && c.own !== null;
              })
              .sort((a, b) => a - b);
            expect(out.espn_cross_check.starter_disagreements.map((x) => x.player_id)).toEqual(
              want,
            );
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});
