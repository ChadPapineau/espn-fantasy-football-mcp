// slice-steps.test.ts — the remaining long slices of round 3's turn profiler, split (changelog §R10
// timing items; plan 03 §1.2: the loop never blocks for more than one SQLite statement or one ≤ 20 ms
// CPU batch; plan 10 A16a). On the owner's Mac each ran 10–18 ms of CPU in one turn (30–50 ms on a
// ~3× slower machine): espn_get_news's first claim read (the cold rules_v1 compile and five items),
// espn_analyze_injury_cascade's claim evaluation (E5's players for every roster), espn_analyze_
// league_activity's valuation of every roster and the pool, E1's trailing reads in
// espn_analyze_lineup and espn_analyze_roster, and espn_search_players' name index. Counted on the
// frozen slice meter, never timed: a step is the work between two points where the turn may end (a
// turnIfSpent, a yieldTurn, a step of inTurns or of a cooperative run), and each step holds at most
// one unit of its slice — a rule's compile, an item's claim, a roster's players, one dataset
// statement, NAME_INDEX_STEP names — while the call holds many; before the split one step held them
// all. On the frozen meter no conditional yield is taken, so a warm call's passes through the turn
// gate are the unconditional ones only (a literal each), and its answer is the default meter's. The
// tools on fx-10h under EFF_TOOLSET=full with the nflverse excerpts published; no network.
import type { Client } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Cooperative from "../../src/domain/analytics/cooperative.js";
import type * as Normalize from "../../src/domain/crosswalk/normalize.js";
import type * as Analytics from "../../src/mcp/tools/analytics.js";
import type * as P1Common from "../../src/mcp/tools/p1-common.js";
import { grantedTurns } from "../../src/domain/analytics/cooperative.js";
import type { DatasetStamp, NewsItem } from "../../src/domain/analytics/types.js";
import { RULES_V1_TABLE } from "../../src/domain/evidence/claims.js";
import { wrapUntrusted } from "../../src/mcp/envelope.js";
import type { McpServices } from "../../src/mcp/services.js";
import { NAME_INDEX_STEP } from "../../src/mcp/tools/players.js";
import { ACTIVITY_POOL_STEP } from "../../src/mcp/tools/market-p1.js";
import { frozenMeter, withSliceMeter } from "../domain/analytics/slice-meter.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

/** The most players one step may value: a roster's worth (a literal; fixture rosters hold ≤ 20). */
const ROSTER_STEP_MAX = 26;

/** What the steps held (shared with the module mocks, hoisted above them). */
const probe = vi.hoisted(() => {
  const p = {
    on: false,
    /** Which unit the mocks count now ("" for none). */
    kind: "",
    /** Units counted since the last point where the turn may end, and the first runs among them. */
    open: 0,
    openFirst: 0,
    /** The units each step held, in order, and the first runs each held. */
    steps: [] as number[],
    firstSteps: [] as number[],
    /** A point where the turn may end: the step so far is closed. */
    boundary(): void {
      if (!p.on) return;
      p.steps.push(p.open);
      p.firstSteps.push(p.openFirst);
      p.open = 0;
      p.openFirst = 0;
    },
    unit(n = 1): void {
      if (p.on) p.open += n;
    },
    first(): void {
      if (p.on) p.openFirst += 1;
    },
    /** Passes through the turn gate a conditional yield took (turnIfSpent, an inTurns step). */
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
// the units: a player valued for E5 (waiverPlayerOf), for E11 (valueWeeks), a name folded (mergeName)
vi.mock("../../src/mcp/tools/analytics.js", async (importOriginal) => {
  const m = await importOriginal<typeof Analytics>();
  return {
    ...m,
    waiverPlayerOf: (...a: Parameters<typeof m.waiverPlayerOf>) => {
      if (probe.kind === "e5") probe.unit();
      return m.waiverPlayerOf(...a);
    },
  };
});
vi.mock("../../src/mcp/tools/p1-common.js", async (importOriginal) => {
  const m = await importOriginal<typeof P1Common>();
  return {
    ...m,
    valueWeeks: (...a: Parameters<typeof m.valueWeeks>) => {
      if (probe.kind === "e11") probe.unit();
      return m.valueWeeks(...a);
    },
  };
});
vi.mock("../../src/domain/crosswalk/normalize.js", async (importOriginal) => {
  const m = await importOriginal<typeof Normalize>();
  return {
    ...m,
    mergeName: (...a: Parameters<typeof m.mergeName>) => {
      if (probe.kind === "names") probe.unit();
      return m.mergeName(...a);
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

/**
 * One call counted on the frozen meter: the units of `kind` in each step, the passes through the
 * turn gate, and the answer.
 */
async function counted(
  c: Client,
  kind: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ steps: number[]; firstSteps: number[]; passes: number; data: unknown }> {
  Object.assign(probe, {
    on: true,
    open: 0,
    openFirst: 0,
    steps: [],
    firstSteps: [],
    conditional: 0,
    kind,
  });
  const before = grantedTurns();
  let r: Awaited<ReturnType<typeof call>>;
  try {
    r = await withSliceMeter(frozenMeter, () => call(c, name, args));
    probe.boundary();
  } finally {
    probe.on = false;
    probe.kind = "";
  }
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
  // no conditional yield gave up the turn: a slice that never spends its share (a warm call)
  // takes no pass through the gate the split added (round 3's parallel-call numbers)
  expect(probe.conditional, `${name}: conditional passes`).toBe(0);
  return {
    steps: [...probe.steps],
    firstSteps: [...probe.firstSteps],
    passes: grantedTurns() - before,
    data: r.body.data,
  };
}

/** The steps as one line: how many, the units, and each step that held any (index:units). */
function stepsLine(steps: readonly number[]): string {
  const held = steps.flatMap((u, i) => (u > 0 ? [`${String(i)}:${String(u)}`] : []));
  return `${String(steps.length)} steps, ${String(steps.reduce((a, b) => a + b, 0))} units; ${held.slice(0, 40).join(" ")}`;
}

/** Each step holds at most `max` units, the call more than three steps' worth. */
function expectSplit(steps: readonly number[], max: number, what: string): void {
  const total = steps.reduce((a, b) => a + b, 0);
  expect(total, `${what}: the call's units (the split is not vacuous)`).toBeGreaterThan(3 * max);
  expect(Math.max(...steps), `${what}: ${stepsLine(steps)}`).toBeLessThanOrEqual(max);
}

/**
 * An answer as text with the running clock's marks levelled (its instants, its ages): the world's
 * clock moves between two calls, nothing else may differ.
 */
function stable(data: unknown): string {
  return JSON.stringify(data, (k, v: unknown) =>
    k === "age_s"
      ? 0
      : typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(v)
        ? "<instant>"
        : v,
  );
}

/**
 * Where two answers differ once levelled (stable): "" when they are the same, else the first path
 * that differs and both values, cut — a failure names what moved, never 4 000 characters of both.
 */
function sameAnswer(a: unknown, b: unknown): string {
  const walk = (x: unknown, y: unknown, at: string): string => {
    if (JSON.stringify(x) === JSON.stringify(y)) return "";
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null)
      return `${at}: ${(JSON.stringify(x) as string | undefined)?.slice(0, 200) ?? "undefined"} vs ${(JSON.stringify(y) as string | undefined)?.slice(0, 200) ?? "undefined"}`;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const d = walk(
        (x as Record<string, unknown>)[k],
        (y as Record<string, unknown>)[k],
        `${at}.${k}`,
      );
      if (d !== "") return d;
    }
    return `${at}: differs`;
  };
  return walk(JSON.parse(stable(a)) as unknown, JSON.parse(stable(b)) as unknown, "data");
}

/** The answer on the default meter (byte-identical to the frozen meter's). */
async function plain(name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await call(client, name, args);
  expect(r.isError).toBe(false);
  return r.body.data;
}

describe("espn_get_news: the rule table compiles a rule a step, and each item's claim is a step", () => {
  it("cold, then warm: no step compiles more than one rule or reads more than one item's claim", async () => {
    const at = world.clock.nowIso();
    const stamp = {
      source: "news:rotowire",
      as_of: at,
      fetched_at: at,
      checked_at: at,
      freshness_class: "news",
      file_version: "test",
    } as unknown as DatasetStamp;
    const items: NewsItem[] = Array.from({ length: 20 }, (_, k) => ({
      id: k.toString(16).padStart(32, "0"),
      source: "rotowire",
      published_at: at,
      url: wrapUntrusted("https://www.rotowire.com/x", "rss.rotowire.url"),
      title: wrapUntrusted(`Player ${String(k)} notes for the week`, "rss.rotowire.title"),
      // a bullet stays past Latin-1 once folded: text of two bytes per character, compiled apart
      blurb: wrapUntrusted(
        k % 3 === 0
          ? "He was ruled out for Sunday's game with an ankle injury."
          : k % 3 === 1
            ? "He was limited in practice on Wednesday and is listed on the injury report."
            : "Practice report \u2022 he was a full participant on Thursday.",
        "rss.rotowire.blurb",
      ),
      gsis_ids: [],
    }));
    const datasets = {
      ...world.services.datasets,
      news: { ...world.services.datasets.news, recent: () => ({ rows: items, stamp }) },
    } as unknown as McpServices["datasets"];
    const c = await connect(world, { options: { toolset: "full" }, services: { datasets } });
    // the unit: a run of one of the table's patterns, first (a compile) and any. A pattern's first
    // two runs over text of one width compile it (once, then natively), and its first run over text
    // of the other width compiles it natively again: the first two runs of each width are counted
    const rules = new Set(RULES_V1_TABLE.map((r) => r.re));
    const runs = new Map<string, number>();
    const ids = new WeakMap<RegExp, number>();
    let nextId = 0;
    const real = RegExp.prototype[Symbol.matchAll];
    RegExp.prototype[Symbol.matchAll] = function (this: RegExp, s: string) {
      if (probe.on && rules.has(this)) {
        if (!ids.has(this)) ids.set(this, nextId++);
        const key = `${String(ids.get(this))}:${/[^\u0000-\u00ff]/u.test(s) ? "two" : "one"}`;
        const n = runs.get(key) ?? 0;
        runs.set(key, n + 1);
        if (n < 2) probe.first();
        probe.unit();
      }
      return real.call(this, s);
    };
    try {
      const args = { since_hours: 168, limit: 20 };
      const cold = await counted(c.client, "news", "espn_get_news", args);
      // a step's pattern runs: one rule's warm-up runs, or one item's title and blurb
      expectSplit(cold.steps, 2 * RULES_V1_TABLE.length, "pattern runs");
      // the compile: every rule ran over both widths in the call, and no step held more than one
      // rule's first runs (two of each width)
      expect(runs.size).toBe(2 * RULES_V1_TABLE.length);
      expect(
        Math.max(...cold.firstSteps),
        `first runs: ${stepsLine(cold.firstSteps)}`,
      ).toBeLessThanOrEqual(4);
      // warm: the same answer, and no pass through the gate past the call's own
      const warm = await counted(c.client, "news", "espn_get_news", args);
      expectSplit(warm.steps, 2 * RULES_V1_TABLE.length, "warm pattern runs");
      // the call's own turn and the envelope's (six with a pass every five items before)
      expect(warm.passes).toBeLessThanOrEqual(2);
      expect(stable(warm.data)).toBe(stable(cold.data));
      const again = await call(c.client, "espn_get_news", args);
      expect(stable(again.body.data)).toBe(stable(cold.data));
    } finally {
      RegExp.prototype[Symbol.matchAll] = real;
      await c.close();
    }
  }, 120_000);
});

describe("espn_analyze_injury_cascade: E5's players a candidate, my roster or a rival's roster a step", () => {
  it("no step values more than a roster's players; the answer is the default meter's", async () => {
    const roster = (await plain("espn_get_roster", { week: 5 })) as {
      players: { player_id: number; position: string; injury_status: string | null }[];
    };
    const hurt =
      roster.players.find((p) => p.position === "RB" && p.injury_status !== null) ??
      roster.players.find((p) => p.position === "RB");
    const args = { player: { player_ids: [hurt?.player_id] }, assume_weeks_out: 2 };
    await plain("espn_analyze_injury_cascade", args);
    const r = await counted(client, "e5", "espn_analyze_injury_cascade", args);
    expectSplit(r.steps, ROSTER_STEP_MAX, "players valued for E5");
    expect(stable(r.data)).toBe(stable(await plain("espn_analyze_injury_cascade", args)));
  }, 120_000);
});

describe("espn_analyze_league_activity: each roster's players and each pool page a step", () => {
  it("no step values more than a roster's players; the answer is the default meter's", async () => {
    expect(ACTIVITY_POOL_STEP).toBeLessThanOrEqual(ROSTER_STEP_MAX);
    const args = { since_days: 30 };
    await plain("espn_analyze_league_activity", args);
    const r = await counted(client, "e11", "espn_analyze_league_activity", args);
    expectSplit(r.steps, ROSTER_STEP_MAX, "players valued for E11");
    expect(stable(r.data)).toBe(stable(await plain("espn_analyze_league_activity", args)));
  }, 120_000);
});

describe("E1's trailing reads: one dataset statement a step (espn_analyze_lineup, espn_analyze_roster)", () => {
  /** The statements E1 reads its trailing lines and implied totals with. */
  const E1_READS = new Set(["playerWeeks.lines", "playerWeeks.defenseLines", "nflGames.games"]);
  it.each([
    ["espn_analyze_lineup", { week: 5, objective: "auto", seed: 3 }],
    ["espn_analyze_roster", { seed: 3 }],
  ] as const)(
    "%s: no step reads more than one of them",
    async (name, args) => {
      const ds = world.services.datasets;
      const datasets = Object.fromEntries(
        Object.entries(ds).map(([k, v]) => [
          k,
          new Proxy(v as object, {
            get(t, p, rcv) {
              const f = Reflect.get(t, p, rcv) as unknown;
              if (typeof f !== "function" || typeof p !== "string") return f;
              return (...a: unknown[]) => {
                if (probe.kind === "reads" && E1_READS.has(`${k}.${p}`)) probe.unit();
                return (f as (...x: unknown[]) => unknown).apply(t, a);
              };
            },
          }),
        ]),
      ) as unknown as McpServices["datasets"];
      const c = await connect(world, { options: { toolset: "full" }, services: { datasets } });
      try {
        await call(c.client, name, args);
        const r = await counted(c.client, "reads", name, args);
        const total = r.steps.reduce((a, b) => a + b, 0);
        // each E1 run reads this season's lines, the prior season's and the implied totals
        expect(total, `${name}: ${stepsLine(r.steps)}`).toBeGreaterThanOrEqual(3);
        expect(Math.max(...r.steps), `${name}: ${stepsLine(r.steps)}`).toBe(1);
        // the same answer later on the running clock (ages levelled): its inputs' ages gain digits
        // over 100 s (the CI flake of run 41865100926: the lineup's answer, 9 991 characters with
        // one-digit ages, fitted whole on one call and was trimmed on the next once an age had two —
        // envelope.ts fitLengthOf counts every age at a fixed width, so the fit no longer moves)
        world.clock.advance(100_000);
        const again = await call(c.client, name, args);
        expect(sameAnswer(r.data, again.body.data), name).toBe("");
      } finally {
        await c.close();
      }
    },
    180_000,
  );
});

describe("espn_search_players: the name index folds NAME_INDEX_STEP names a step", () => {
  it("no step folds more than a step's names; the answer is the default meter's", async () => {
    const args = { query: "Robinson" };
    await plain("espn_search_players", args);
    // a few names beside the fold's (the query's, a crosswalk's) are allowed in a step
    const r = await counted(client, "names", "espn_search_players", args);
    expectSplit(r.steps, NAME_INDEX_STEP + 20, "names folded");
    // the call's own turn and the envelope's: the split takes none
    expect(r.passes).toBeLessThanOrEqual(2);
    expect(stable(r.data)).toBe(stable(await plain("espn_search_players", args)));
  }, 120_000);
});
