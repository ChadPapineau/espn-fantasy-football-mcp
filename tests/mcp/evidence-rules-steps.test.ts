// evidence-rules-steps.test.ts — espn_analyze_evidence compiles the rules_v1 table a rule a step when
// it is the process's first extractor (round 3b's timing account: its first claim step paid the
// whole table's compile, cold cpu_max 10.9–14.8 ms on the owner's Mac; plan 03 §1.2's ≤ 20 ms batch;
// plan 10 A16a), as espn_get_news does (slice-steps.test.ts). Counted on the frozen slice meter,
// never timed: a step is the work between two points where the turn may end, and a pattern's first
// runs over text of one width are its compiles. A file of its own: the table is compiled once per
// process, so E10 must be the first extractor here. fx-10h under EFF_TOOLSET=full with the nflverse
// excerpts published; no network.
import type { Client } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Cooperative from "../../src/domain/analytics/cooperative.js";
import { grantedTurns } from "../../src/domain/analytics/cooperative.js";
import { RULES_V1_TABLE } from "../../src/domain/evidence/claims.js";
import { frozenMeter, withSliceMeter } from "../domain/analytics/slice-meter.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

/** What the steps held (shared with the module mock, hoisted above it). */
const probe = vi.hoisted(() => {
  const p = {
    on: false,
    open: 0,
    openFirst: 0,
    steps: [] as number[],
    firstSteps: [] as number[],
    boundary(): void {
      if (!p.on) return;
      p.steps.push(p.open);
      p.firstSteps.push(p.openFirst);
      p.open = 0;
      p.openFirst = 0;
    },
    conditional: 0,
  };
  return p;
});

vi.mock("../../src/domain/analytics/cooperative.js", async (importOriginal) => {
  const m = await importOriginal<typeof Cooperative>();
  /** `work` with a boundary between two of its steps (where inTurns may give up the turn). */
  function* stepped<T>(work: Generator<unknown, T, undefined>): Generator<unknown, T, undefined> {
    for (;;) {
      const r = work.next();
      if (r.done === true) return r.value;
      probe.boundary();
      const at = m.grantedTurns();
      yield r.value;
      if (probe.on) probe.conditional += m.grantedTurns() - at;
    }
  }
  return {
    ...m,
    turnIfSpent: async () => {
      probe.boundary();
      const at = m.grantedTurns();
      await m.turnIfSpent();
      if (probe.on) probe.conditional += m.grantedTurns() - at;
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
      if (units > 0) probe.boundary();
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
  // no extractor runs in these (only espn_get_news, espn_get_player_outlook and E10 read claims)
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

/** The steps as one line: how many, the units, and each step that held any (index:units). */
function stepsLine(steps: readonly number[]): string {
  const held = steps.flatMap((u, i) => (u > 0 ? [`${String(i)}:${String(u)}`] : []));
  return `${String(steps.length)} steps, ${String(steps.reduce((a, b) => a + b, 0))} units; ${held.slice(0, 40).join(" ")}`;
}

describe("espn_analyze_evidence: the rule table compiles a rule a step when E10 is the process's first extractor", () => {
  it("cold, then warm: no step holds more than one rule's first runs; the answer is the default meter's", async () => {
    // the unit: a run of one of the table's patterns, first (a compile) and any. A pattern's first
    // two runs over text of one width compile it (once, then natively), and its first run over
    // text of the other width compiles it natively again: the first two runs of each width count
    const rules = new Set(RULES_V1_TABLE.map((r) => r.re));
    const runs = new Map<string, number>();
    const ids = new WeakMap<RegExp, number>();
    let nextId = 0;
    const real = RegExp.prototype[Symbol.matchAll];
    RegExp.prototype[Symbol.matchAll] = function (this: RegExp, s: string) {
      if (probe.on && rules.has(this)) {
        if (!ids.has(this)) ids.set(this, nextId++);
        const key = `${String(ids.get(this))}:${/[^\u0000-ÿ]/u.test(s) ? "two" : "one"}`;
        const n = runs.get(key) ?? 0;
        runs.set(key, n + 1);
        if (n < 2) probe.openFirst += 1;
        probe.open += 1;
      }
      return real.call(this, s);
    };
    // a pasted claim: E10 reads it with the rules whatever the player's own texts hold
    const args = {
      player: { gsis_ids: ["00-0037248"] },
      claim: { text: "He was ruled out for Sunday's game with an ankle injury." },
    };
    const counted = async () => {
      Object.assign(probe, {
        on: true,
        open: 0,
        openFirst: 0,
        steps: [],
        firstSteps: [],
        conditional: 0,
      });
      const before = grantedTurns();
      let r: Awaited<ReturnType<typeof call>>;
      try {
        r = await withSliceMeter(frozenMeter, () => call(client, "espn_analyze_evidence", args));
        probe.boundary();
      } finally {
        probe.on = false;
      }
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      // no conditional yield gave up the turn on the frozen meter
      expect(probe.conditional, "conditional passes").toBe(0);
      return {
        steps: [...probe.steps],
        firstSteps: [...probe.firstSteps],
        passes: grantedTurns() - before,
        data: r.body.data,
      };
    };
    try {
      const cold = await counted();
      // the whole table compiled over both widths in the call (the warm-up), no step holding more
      // than one rule's first runs (two of each width): before the split, the pasted claim's step
      // held every rule's
      expect(runs.size, stepsLine(cold.firstSteps)).toBe(2 * RULES_V1_TABLE.length);
      expect(
        Math.max(...cold.firstSteps),
        `first runs: ${stepsLine(cold.firstSteps)}`,
      ).toBeLessThanOrEqual(4);
      // the split is not vacuous: the call ran the table many times over
      expect(cold.steps.reduce((a, b) => a + b, 0)).toBeGreaterThan(4 * RULES_V1_TABLE.length);
      // warm: no first run left, the same answer, and no pass through the gate the warm-up adds
      const warm = await counted();
      expect(Math.max(...warm.firstSteps), stepsLine(warm.firstSteps)).toBe(0);
      expect(warm.passes).toBeLessThanOrEqual(cold.passes);
      expect(stable(warm.data)).toBe(stable(cold.data));
      // the default meter's answer is the frozen meter's
      const plain = await call(client, "espn_analyze_evidence", args);
      expect(plain.isError).toBe(false);
      expect(stable(plain.body.data)).toBe(stable(cold.data));
    } finally {
      RegExp.prototype[Symbol.matchAll] = real;
    }
  }, 120_000);
});
