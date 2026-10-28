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
  makeHome,
  measureStall,
  requireDist,
  serve,
  StallControl,
  STALL_WINDOW_ATTEMPTS,
  type Served,
} from "./helpers.js";

const PER_WEEK = 100;
const home = makeHome();
let s: Served | null = null;
let control: StallControl | null = null;
afterAll(async () => {
  control?.stop();
  if (s !== null) await s.stop();
  home.cleanup();
});

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
    // the host control (helpers.ts StallControl): a window over its bound while an idle process
    // beside the server stalled too measured the host's preemption, and is repeated
    control = await StallControl.start();
    const ctl = control;
    const stallOf = async (boundMs: number): Promise<number> =>
      (
        await measureStall(
          x.transport,
          ctl,
          async () => {
            const r = await ok(x, "espn_analyze_retrospective", { week: 4, min_n: 1 });
            expect((r.data.calls as unknown[]).length).toBeGreaterThan(0);
          },
          boundMs,
        )
      ).stall_ms;
    // a near-empty log: five calls of the scored week — the least of several windows, so that a
    // window the host inflated cannot shrink the growth below (CI read 16.9 ms > 15 at 92e933d)
    await log(4, 0, 5);
    let small = Number.POSITIVE_INFINITY;
    for (let i = 0; i < STALL_WINDOW_ATTEMPTS; i++) small = Math.min(small, await stallOf(50));
    // the full log: every window week at the per-week cap
    for (const week of [1, 2, 3]) await log(week, 0, PER_WEEK);
    await log(4, 5, PER_WEEK);
    const full = await stallOf(Math.min(50, small + GROWTH_MAX_MS));
    process.stdout.write(
      `retrospective stall: ${small.toFixed(1)} ms at 5 records, ${full.toFixed(1)} ms at ${String(4 * PER_WEEK)}\n`,
    );
    expect(full).toBeLessThanOrEqual(50);
    expect(full - small).toBeLessThanOrEqual(GROWTH_MAX_MS);
  });
});
