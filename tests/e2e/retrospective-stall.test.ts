// retrospective-stall.test.ts — E13's main-loop stall does not grow with the recommendation log
// (plan 03 §1.2: ≤ 50 ms during any analytics call, "regardless of log size"; plan 10 A16a; Stage C
// finding reclog-retrospective-unbounded-read: E13 read every week up to the scored one whole, in
// one turn — the stall grew with the never-pruned log, 71 ms at 400 records). The BUILT server over
// real stdio in fixture mode on fx-10h (the heartbeat preload inside the server): weeks 1–4 each
// logged to the per-week cap (100 lineup records, each with ten full-length alternatives and a
// 200-char note),
// then espn_analyze_retrospective for week 4 — the longest stall stays ≤ 50 ms and the scored
// week's calls are all scored.
import { afterAll, describe, expect, it } from "vitest";
import {
  bodyOf,
  HEARTBEAT,
  logRecords,
  makeHome,
  requireDist,
  serve,
  type Served,
} from "./helpers.js";

const PER_WEEK = 100;
const home = makeHome();
let s: Served | null = null;
afterAll(async () => {
  if (s !== null) await s.stop();
  home.cleanup();
});

async function heartbeat(x: Served): Promise<number> {
  const before = x.transport.stderr.length;
  x.transport.signal("SIGUSR2");
  const end = Date.now() + 5000;
  for (;;) {
    const rec = logRecords(x.transport.stderr.slice(before)).find(
      (l) => l.event === "e2e.heartbeat",
    );
    if (rec !== undefined) return rec.max_ms as number;
    if (Date.now() > end) throw new Error("no heartbeat line");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function ok(x: Served, name: string, args: Record<string, unknown>) {
  const r = await x.client.callTool({ name, arguments: args }, { timeout: 120_000 });
  const b = bodyOf(r);
  expect(r.isError, `${name}: ${JSON.stringify(b).slice(0, 300)}`).not.toBe(true);
  return b as { data: Record<string, unknown>; meta: Record<string, unknown> };
}

/** The most E13's stall may grow from a near-empty log to a full one (the bound is log-free). */
const GROWTH_MAX_MS = 15;

describe("E13 over a full log (fx-10h over real stdio)", { timeout: 600_000 }, () => {
  it("four weeks at the per-week cap: the retrospective's longest stall stays ≤ 50 ms and does not grow with the log", async () => {
    requireDist();
    s = await serve(home, { preloads: [HEARTBEAT] });
    const x = s;
    const league = await ok(x, "espn_get_league", { include: ["scoring"] });
    const hash = (league.data.scoring as { settings_hash: string }).settings_hash;
    const note = "n".repeat(200);
    const lineups = new Map<number, { rec: Record<string, unknown>; request_id: unknown }>();
    for (const week of [1, 2, 3, 4]) {
      const lineup = await ok(x, "espn_analyze_lineup", { week, objective: "auto" });
      lineups.set(week, {
        rec: lineup.data.rec as Record<string, unknown>,
        request_id: lineup.meta.request_id,
      });
    }
    /** Logs records `from`..`to` - 1 of `week` (each near its full size). */
    const log = async (week: number, from: number, to: number): Promise<void> => {
      const l = lineups.get(week);
      if (l === undefined) throw new Error("no lineup call");
      // ten alternatives with a full-length action (TEXT_CAPS.rec_log_text) and a full note
      const alternatives = Array.from({ length: 10 }, (_, i) => ({
        action: `alternative ${String(i + 1)} `.padEnd(200, "x"),
        subjects: l.rec.subjects,
        point_estimate: l.rec.point_estimate,
        distribution: l.rec.distribution,
        decision_metric_value: 0,
      }));
      for (let n = from; n < to; n++)
        await ok(x, "espn_record_recommendation", {
          kind: "lineup",
          week,
          rec: l.rec,
          alternatives,
          source_calls: [{ tool: "espn_analyze_lineup", request_id: l.request_id }],
          settings_hash: hash,
          followed_hint: "unknown",
          client_ref: `stall-${String(week)}-${String(n)}`,
          note,
        });
    };
    const stallOf = async (): Promise<number> => {
      await heartbeat(x); // a fresh window: the retrospective alone
      const r = await ok(x, "espn_analyze_retrospective", { week: 4, min_n: 1 });
      expect((r.data.calls as unknown[]).length).toBeGreaterThan(0);
      return heartbeat(x);
    };
    // a near-empty log: five calls of the scored week
    await log(4, 0, 5);
    const small = await stallOf();
    // the full log: every window week at the per-week cap
    for (const week of [1, 2, 3]) await log(week, 0, PER_WEEK);
    await log(4, 5, PER_WEEK);
    const full = await stallOf();
    process.stdout.write(
      `retrospective stall: ${small.toFixed(1)} ms at 5 records, ${full.toFixed(1)} ms at ${String(4 * PER_WEEK)}\n`,
    );
    expect(full).toBeLessThanOrEqual(50);
    expect(full - small).toBeLessThanOrEqual(GROWTH_MAX_MS);
  });
});
