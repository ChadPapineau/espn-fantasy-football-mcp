// players-steps.test.ts — the round-4b review's F1: espn_analyze_trade mapped every rostered
// player's record (a crosswalk read and his value weeks; 145 players on fx-10h, ~3 store statements
// each) and the wire's in one synchronous stretch, which set trade's 22–24 ms run on the CPU on the
// Linux CI runner (the full analytics window's longest gap: 429 store statements in it), past plan
// 03 §1.2's ≤ 20 ms batch. The records are now mapped a player a step, the turn given up between two
// once the slice has spent its share (cooperative.ts turnIfSpent). Counted, never timed: a step is
// the work between two points where the turn may end (turnIfSpent, yieldTurn, a cooperative run's
// batch edge), and each player's record reads his value weeks once (p1-common.ts valueWeeks). E3's
// season mode (espn_analyze_matchup mode season) mapped every rostered player's E1 subject (his
// crosswalk read) the same way, 20.7–24.0 ms on the runner with 280 store statements in the gap: its
// subjects are now read a player a step too (common.ts crosswalkOf counted). Each answer is
// byte-identical to a second call's (the clock's marks levelled). fx-10h under EFF_TOOLSET=full; no
// network.
import type { Client } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Cooperative from "../../src/domain/analytics/cooperative.js";
import type * as Common from "../../src/mcp/tools/common.js";
import type * as P1Common from "../../src/mcp/tools/p1-common.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

/** What the steps held (shared with the module mocks, hoisted above them). */
const probe = vi.hoisted(() => {
  const p = {
    on: false,
    open: 0,
    total: 0,
    steps: [] as number[],
    /** crosswalkOf reads, counted the same way (E3's season subjects). */
    openX: 0,
    totalX: 0,
    stepsX: [] as number[],
    boundary(): void {
      if (!p.on) return;
      if (p.open > 0) p.steps.push(p.open);
      if (p.openX > 0) p.stepsX.push(p.openX);
      p.open = 0;
      p.openX = 0;
    },
    reset(): void {
      p.open = 0;
      p.total = 0;
      p.steps = [];
      p.openX = 0;
      p.totalX = 0;
      p.stepsX = [];
    },
  };
  return p;
});

vi.mock("../../src/domain/analytics/cooperative.js", async (importOriginal) => {
  const m = await importOriginal<typeof Cooperative>();
  function* stepped<T>(work: Generator<unknown, T, undefined>): Generator<unknown, T, undefined> {
    for (;;) {
      const r = work.next();
      if (r.done === true) return r.value;
      probe.boundary();
      yield r.value;
    }
  }
  return {
    ...m,
    turnIfSpent: async () => {
      probe.boundary();
      await m.turnIfSpent();
    },
    yieldTurn: () => {
      probe.boundary();
      return m.yieldTurn();
    },
    inTurns: <T>(work: Generator<unknown, T, undefined>) => m.inTurns(stepped(work)),
    runCooperative: (
      units: number,
      step: (i: number) => void,
      opts: Cooperative.CooperativeOptions,
    ) => {
      probe.boundary();
      return m.runCooperative(
        units,
        (i) => {
          step(i);
          probe.boundary();
        },
        opts,
      );
    },
    runCooperativeSteps: <T>(
      work: Iterator<unknown, T, undefined>,
      opts: Cooperative.CooperativeOptions,
    ) => {
      probe.boundary();
      return m.runCooperativeSteps<T>(
        {
          next: () => {
            const r = work.next();
            probe.boundary();
            return r;
          },
        },
        opts,
      );
    },
  };
});

vi.mock("../../src/mcp/tools/p1-common.js", async (importOriginal) => {
  const m = await importOriginal<typeof P1Common>();
  return {
    ...m,
    valueWeeks: (...a: Parameters<typeof m.valueWeeks>) => {
      if (probe.on) {
        probe.open++;
        probe.total++;
      }
      return m.valueWeeks(...a);
    },
  };
});

vi.mock("../../src/mcp/tools/common.js", async (importOriginal) => {
  const m = await importOriginal<typeof Common>();
  return {
    ...m,
    crosswalkOf: (...a: Parameters<typeof m.crosswalkOf>) => {
      if (probe.on) {
        probe.openX++;
        probe.totalX++;
      }
      return m.crosswalkOf(...a);
    },
  };
});

const FX = path.join(ESPN_FIXTURES, "fx-10h");
let world: World;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishNflverse: true,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  for (const [name, args] of [
    ["espn_get_league", {}],
    ["espn_get_roster", { week: 5 }],
    ["espn_get_standings", {}],
  ] as const) {
    const r = await call(client, name, args);
    expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
  }
}, 300_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** An answer as text with the running clock's marks levelled (its instants, its ages). */
function stable(data: unknown): string {
  return JSON.stringify(data, (k, v: unknown) =>
    k === "age_s"
      ? 0
      : typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(v)
        ? "<instant>"
        : v,
  );
}

const ARGS = { find_partners: { need_position: "WR" }, seed: 2 } as const;

describe("F1: espn_analyze_trade maps its players a player a step", () => {
  it("every rostered player's record is read once, never two in one step; the answer is unchanged", async () => {
    probe.reset();
    probe.on = true;
    const first = await call(client, "espn_analyze_trade", ARGS);
    probe.boundary();
    probe.on = false;
    expect(first.isError, JSON.stringify(first.body).slice(0, 300)).toBe(false);
    // the league's rostered players (fx-10h: 145), each read once for his record
    expect(probe.total).toBeGreaterThanOrEqual(100);
    // a player a step: no step holds two players' records
    expect(Math.max(...probe.steps)).toBe(1);
    expect(probe.steps.length).toBe(probe.total);
    const again = await call(client, "espn_analyze_trade", ARGS);
    expect(stable((again.body as { data?: unknown }).data)).toBe(
      stable((first.body as { data?: unknown }).data),
    );
  });
});

describe("F1: espn_analyze_matchup's season mode reads its E1 subjects a player a step", () => {
  it("every rostered player's subject is read, never two in one step; the answer is unchanged", async () => {
    const args = { mode: "season", seed: 4 } as const;
    probe.reset();
    probe.on = true;
    const first = await call(client, "espn_analyze_matchup", args);
    probe.boundary();
    probe.on = false;
    expect(first.isError, JSON.stringify(first.body).slice(0, 300)).toBe(false);
    // the league's rostered players (fx-10h: 145) less the team units, each read for his subject
    expect(probe.totalX).toBeGreaterThanOrEqual(100);
    expect(Math.max(...probe.stepsX)).toBe(1);
    const again = await call(client, "espn_analyze_matchup", args);
    expect(stable((again.body as { data?: unknown }).data)).toBe(
      stable((first.body as { data?: unknown }).data),
    );
  });
});
