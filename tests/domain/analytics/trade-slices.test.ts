// trade-slices.test.ts — E6's pair evaluations run one lineup solve per cooperative step (trade.ts
// `Steps`, cooperative.ts runCooperativeSteps; plan 03 §1.2: the loop never blocks for more than one
// ≤ 20 ms batch; changelog §R10 timing items: one partner-search package — its drops, the wire's
// ranking, both sides' weeks — was one step of more than 50 lineup solves, counted). Counted, never
// timed: every lineup solve runs inside a cooperative step; a step of a pair run (the partner search,
// the counters, the offer's own pair) solves at most STEP_SOLVES — a fixed ceiling, never read from
// the code it holds — and a Monte Carlo path at most 4 × the value weeks; one package is many solves
// (the split is not vacuous); the answer is byte-identical however the batches fall; a deadline
// between two steps of a package leaves that package unevaluated and says so. Synthetic rosters.
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Cooperative from "../../../src/domain/analytics/cooperative.js";
import type * as Lineup from "../../../src/domain/analytics/lineup.js";
import type * as Trade from "../../../src/domain/analytics/trade.js";
import type { TradePlayer, TradeRequest, TradeTeam } from "../../../src/domain/analytics/trade.js";
import { wrapUntrusted } from "../../../src/domain/league/types.js";
import {
  clockAndRng,
  instantPacer,
  referenceRules,
  referenceSlots,
  steppingPacer,
} from "./helpers.js";
import { SLOT, WEEK, WEEKS, tp, tradeRoster } from "./p1-helpers.js";

const LINEUP = "../../../src/domain/analytics/lineup.js";
const COOPERATIVE = "../../../src/domain/analytics/cooperative.js";
const TRADE_MODULE = "../../../src/domain/analytics/trade.js";

/**
 * The most lineup solves one step of a pair run may make: a literal, never read from trade.ts. A
 * solve of a 16-player roster into nine seats is tens of µs even on a slowed machine, so a step stays
 * far inside one 12 ms batch; a whole package (the shape before the fix) is hundreds of solves.
 */
const STEP_SOLVES = 1;

const name = (s: string) => wrapUntrusted(s, "espn.team.name");
function team(id: number, shape: "balanced" | "rb_rich" | "wr_rich"): TradeTeam {
  return {
    team_id: id,
    name: name(`Team ${String(id).padStart(2, "0")}`),
    players: tradeRoster(id, 10, shape),
  };
}
const ME = team(1, "rb_rich");
const PARTNER = team(2, "wr_rich");
const OTHERS = Array.from({ length: 4 }, (_, i) => team(i + 3, "balanced"));
/** A wire of uneven values: a seat a trade frees is filled from it (fillJointly ranks it). */
const WIRE: readonly TradePlayer[] = Array.from({ length: 6 }, (_, k) =>
  tp(9_000 + k, k % 2 === 0 ? "WR" : "RB", 4 + k, SLOT.BE),
);

function req(over: Partial<TradeRequest> = {}): TradeRequest {
  const { clock, rng } = clockAndRng("2026-10-06T20:00:00.000Z", 5);
  return {
    roster: referenceSlots(),
    rules: referenceRules(),
    weeks: WEEKS,
    as_of_week: WEEK,
    me: ME,
    teams: [PARTNER, ...OTHERS],
    offer: null,
    find_partners: { need_position: "WR", max_partners: 3 },
    seeding_config: { mode: "espn_rule", confirmed_at: null },
    free_agents: WIRE,
    n_sims: 40,
    clock,
    rng,
    pacer: instantPacer,
    deadline_ms: null,
    ...over,
  };
}
/** A 2-for-1 (my two for their one): the partner's roster frees a seat, mine overflows. */
const UNEVEN_OFFER = { partner_team_id: 2, give: [102, 103], get: [204] } as const;

/** What one counted run of analyzeTrade solved, by cooperative step. */
interface Counted {
  readonly trade: typeof Trade;
  /** Solves inside each step, in order, and which kind of run the step was in. */
  readonly steps: { readonly solves: number; readonly run: "units" | "steps" }[];
  /** Solves made outside every cooperative step (synchronous with the call's own turn). */
  readonly outside: () => number;
  /** Solves of each runCooperativeSteps run (one entry per run, in order). */
  readonly runs: number[];
}

/** analyzeTrade loaded with the lineup solves counted, each attributed to the step that made it. */
async function counted(): Promise<Counted> {
  vi.resetModules();
  const steps: { solves: number; run: "units" | "steps" }[] = [];
  const runs: number[] = [];
  let open: number | null = null;
  let outside = 0;
  vi.doMock(LINEUP, async (importOriginal) => {
    const m = await importOriginal<typeof Lineup>();
    return {
      ...m,
      fastLineupValue: (...a: Parameters<typeof m.fastLineupValue>) => {
        if (open === null) outside += 1;
        else open += 1;
        return m.fastLineupValue(...a);
      },
    };
  });
  vi.doMock(COOPERATIVE, async (importOriginal) => {
    const m = await importOriginal<typeof Cooperative>();
    const inStep = <T>(run: "units" | "steps", f: () => T): T => {
      open = 0;
      try {
        return f();
      } finally {
        steps.push({ solves: open, run });
        open = null;
      }
    };
    return {
      ...m,
      runCooperative: (
        units: number,
        step: (i: number) => void,
        opts: Cooperative.CooperativeOptions,
      ) =>
        m.runCooperative(
          units,
          (i) => {
            inStep("units", () => {
              step(i);
            });
          },
          opts,
        ),
      runCooperativeSteps: async <T>(
        work: Iterator<unknown, T, undefined>,
        opts: Cooperative.CooperativeOptions,
      ) => {
        const from = steps.length;
        const r = await m.runCooperativeSteps(
          { next: () => inStep("steps", () => work.next()) },
          opts,
        );
        runs.push(steps.slice(from).reduce((s, x) => s + x.solves, 0));
        return r;
      },
    };
  });
  return {
    trade: (await import(TRADE_MODULE)) as typeof Trade,
    steps,
    outside: () => outside,
    runs,
  };
}

afterEach(() => {
  vi.doUnmock(LINEUP);
  vi.doUnmock(COOPERATIVE);
  vi.resetModules();
});

const pairSteps = (c: Counted) => c.steps.filter((s) => s.run === "steps").map((s) => s.solves);

describe("E6's pair evaluations: one lineup solve a step (counted)", () => {
  it("the partner search: every solve inside a step, no step past STEP_SOLVES (a fixed ceiling)", async () => {
    const c = await counted();
    const out = await c.trade.analyzeTrade(req());
    expect(out.data.kind).toBe("partners");
    expect(out.partial).toBe(false);
    expect(c.outside()).toBe(0);
    const pair = pairSteps(c);
    expect(pair.length).toBeGreaterThan(0);
    expect(Math.max(...pair)).toBeLessThanOrEqual(STEP_SOLVES);
    // the split is not vacuous: the search solved far more than one package's worth of steps
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0]).toBeGreaterThan(50 * STEP_SOLVES);
  });

  it("an offer: its own pair and its counters one solve a step, a Monte Carlo path at most 4 × weeks", async () => {
    const c = await counted();
    // a 2-for-1 that spans 0 (fair) or loses: the counters run too
    const out = await c.trade.analyzeTrade(
      req({ offer: UNEVEN_OFFER, find_partners: null, n_sims: 30 }),
    );
    expect(out.data.kind).toBe("evaluation");
    expect(c.outside()).toBe(0);
    expect(Math.max(...pairSteps(c))).toBeLessThanOrEqual(STEP_SOLVES);
    const mc = c.steps.filter((s) => s.run === "units").map((s) => s.solves);
    expect(mc.length).toBeGreaterThanOrEqual(30);
    expect(Math.max(...mc)).toBeLessThanOrEqual(4 * WEEKS.length);
    // ONE package — the offer's own pair, which ran in the call's turn before — is many solves: a
    // whole package per step (the shape before) is far past the ceiling
    expect(c.runs[0]).toBeGreaterThan(10 * STEP_SOLVES);
  });

  it("the answer is byte-identical however the batches fall (every step one batch, or one batch)", async () => {
    const { analyzeTrade } = await import(TRADE_MODULE).then((m) => m as typeof Trade);
    for (const over of [{}, { offer: UNEVEN_OFFER, find_partners: null }] as const) {
      // instantPacer: the clock never moves, so the whole run is one batch; steppingPacer(13): every
      // clock read passes the 12 ms batch, so each batch is one chunk of steps
      const one = await analyzeTrade(req({ ...over, pacer: instantPacer }));
      const pacer = steppingPacer(13);
      const many = await analyzeTrade(req({ ...over, pacer }));
      expect(pacer.yields).toBeGreaterThan(50);
      expect(JSON.stringify(many)).toBe(JSON.stringify(one));
    }
  });

  it("a deadline inside a package leaves it unevaluated, and the partial warning counts whole packages", async () => {
    const { analyzeTrade } = await import(TRADE_MODULE).then((m) => m as typeof Trade);
    const whole = await analyzeTrade(req());
    // a clock that moves 1 ms a read: 60 ms of "CPU" is a few hundred steps, inside the search
    const cut = await analyzeTrade(req({ pacer: steppingPacer(1), deadline_ms: 60 }));
    expect(cut.partial).toBe(true);
    const line = cut.warnings.find((w) => /^partial: \d+ of \d+ packages evaluated/.test(w));
    expect(line).toBeDefined();
    const [k, total] = (line?.match(/(\d+) of (\d+)/) ?? []).slice(1).map(Number);
    expect(k).toBeLessThan(total ?? 0);
    expect(whole.partial).toBe(false);
    if (cut.data.kind !== "partners" || whole.data.kind !== "partners")
      throw new Error("expected partner searches");
    // every partner the cut search proposes was found on packages it evaluated whole: a proposal
    // with the same Δ as the whole search's, or one the whole search beat
    for (const p of cut.data.partners) {
      const full = whole.data.partners.find((x) => x.team_id === p.team_id);
      if (full !== undefined) expect(full.delta_me.mean).toBeGreaterThanOrEqual(p.delta_me.mean);
    }
  });
});
