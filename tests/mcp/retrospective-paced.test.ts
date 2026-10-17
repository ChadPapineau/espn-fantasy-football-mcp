// retrospective-paced.test.ts — E13 reads the recommendation log the paced way (Stage C finding
// reclog-retrospective-unbounded-read; plan 03 §1.2: the loop never blocks longer than one bounded
// statement; plan 10 A16a). The log is never pruned and E13 read every week from 1 to the scored
// one whole — one synchronous statement and parse per week, all in one turn — so its stall grew with
// the log (71 ms at 400 records over stdio). Through the real composition root (fixture mode,
// league-a at the recording instant, week 3 final): E13 learns the earlier weeks from the index
// alone (weekCounts — an earlier week is scored without facts, so only its presence counts), reads
// the scored week in paced pages through the turn gate (forWeekPaced), writes the week's outcomes in
// one transaction (recordOutcomes), never calls forWeek or recordOutcome — and answers exactly what
// the whole read answers. No network, no cookie.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OUTCOMES_PER_WRITE_MAX,
  type PacedRecommendationLog,
} from "../../src/domain/reclog/types.js";
import { OUTCOMES_PER_BATCH_MAX } from "../../src/store/repos/reclog.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({});
  ({ client, close } = await connect(world));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

interface Env {
  data: Record<string, unknown>;
  meta: { request_id: string };
}
async function ok(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Env> {
  const r = await call(c, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
  return r.body as unknown as Env;
}

/** The log with every method counted (the composition root's own store underneath). */
function counted(log: PacedRecommendationLog): {
  log: PacedRecommendationLog;
  calls: string[];
  paces: () => number;
} {
  const calls: string[] = [];
  let paces = 0;
  const wrapped: PacedRecommendationLog = {
    record: (i, at) => log.record(i, at),
    get: (id) => log.get(id),
    list: (q) => log.list(q),
    outcome: (id) => log.outcome(id),
    forWeek: (l, s, w) => {
      calls.push(`forWeek ${String(w)}`);
      return log.forWeek(l, s, w);
    },
    recordOutcome: (o) => {
      calls.push("recordOutcome");
      log.recordOutcome(o);
    },
    weekCounts: (l, s) => {
      calls.push("weekCounts");
      return log.weekCounts(l, s);
    },
    forWeekPaced: (l, s, w, pace) => {
      calls.push(`forWeekPaced ${String(w)}`);
      return log.forWeekPaced(l, s, w, () => {
        paces += 1;
        return pace();
      });
    },
    recordOutcomes: (os) => {
      calls.push(`recordOutcomes ${String(os.length)}`);
      log.recordOutcomes(os);
    },
  };
  return { log: wrapped, calls, paces: () => paces };
}

describe("E13 reads the log the paced way (reclog-retrospective-unbounded-read)", () => {
  const WEEK = 3;
  beforeAll(async () => {
    const league = await ok(client, "espn_get_league", { include: ["scoring"] });
    const hash = (league.data.scoring as { settings_hash: string }).settings_hash;
    // decisions in weeks 1, 2 and the scored week 3 (the lineup call of each week, logged)
    for (const week of [1, 2, WEEK]) {
      const lineup = await ok(client, "espn_analyze_lineup", { week });
      for (const n of [1, 2, 3])
        await ok(client, "espn_record_recommendation", {
          kind: "lineup",
          week,
          rec: lineup.data.rec,
          alternatives: [],
          source_calls: [{ tool: "espn_analyze_lineup", request_id: lineup.meta.request_id }],
          settings_hash: hash,
          client_ref: `paced-${String(week)}-${String(n)}`,
        });
    }
  }, 120_000);

  it("earlier weeks from the index, the scored week in paced pages, the outcomes in one write", async () => {
    const spy = counted(world.services.recommendationLog);
    const c = await connect(world, { services: { recommendationLog: spy.log } });
    try {
      const e = await ok(c.client, "espn_analyze_retrospective", { week: WEEK, min_n: 1 });
      expect((e.data.calls as unknown[]).length).toBe(3);
      expect(spy.calls).toEqual(["weekCounts", `forWeekPaced ${String(WEEK)}`, "recordOutcomes 3"]);
      expect(spy.calls.some((x) => x.startsWith("forWeek "))).toBe(false);
      expect(spy.paces()).toBeGreaterThanOrEqual(2);
    } finally {
      await c.close();
    }
  });

  it("E13's outcome writes fit the store's one-transaction batch", () => {
    expect(OUTCOMES_PER_WRITE_MAX).toBeLessThanOrEqual(OUTCOMES_PER_BATCH_MAX);
  });

  it("the answer equals the whole read's: an earlier week's calls count only as a week in the window", async () => {
    // the whole read: every week read with forWeek, as E13 did, behind the same port
    const base = world.services.recommendationLog;
    const whole: PacedRecommendationLog = {
      ...base,
      record: (i, at) => base.record(i, at),
      get: (id) => base.get(id),
      list: (q) => base.list(q),
      outcome: (id) => base.outcome(id),
      forWeek: (l, s, w) => base.forWeek(l, s, w),
      recordOutcome: (o) => {
        base.recordOutcome(o);
      },
      weekCounts: (l, s) =>
        Array.from({ length: WEEK }, (_, i) => i + 1)
          .map((w) => ({ week: w, n: base.forWeek(l, s, w).length }))
          .filter((x) => x.n > 0),
      forWeekPaced: (l, s, w) => Promise.resolve(base.forWeek(l, s, w)),
      recordOutcomes: (os) => {
        for (const o of os) base.recordOutcome(o);
      },
    };
    const paced = await ok(client, "espn_analyze_retrospective", { week: WEEK, min_n: 1 });
    const w = await connect(world, { services: { recommendationLog: whole } });
    try {
      const all = await ok(w.client, "espn_analyze_retrospective", { week: WEEK, min_n: 1 });
      const strip = (d: Record<string, unknown>): Record<string, unknown> => {
        const { inputs: _i, rec: _r, ...rest } = d;
        return rest;
      };
      expect(strip(paced.data)).toEqual(strip(all.data));
    } finally {
      await w.close();
    }
  });
});
