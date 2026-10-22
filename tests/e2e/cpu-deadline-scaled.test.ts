// cpu-deadline-scaled.test.ts — the 8 s per-CALL CPU deadline on a slow machine (plan 07 E1 [A-7]:
// "a call that would exceed the deadline returns partial: true"; E3 "past the 8 s per-call CPU
// deadline"; plan 10 A16a). Stage C finding analytics-cpu-deadline-per-run: on an emulated 6× and 30×
// slower CPU the analytics calls ran far past 8 s with partial false — first because each
// cooperative run had its own 8 s, then (round 2) because E1's set-up and summary runs had no
// deadline, a batch was cut by wall time only, and the call's CPU outside every batch (dataset
// reads, scoring, assembly) was never counted. The BUILT server over real stdio, `full` on a seeded
// fx-10h, the deadline ON (EFF_TEST_STUBS=0, a temp file credential store, no network — the
// no-socket preload), its thread CPU scaled by tests/e2e/fixtures/slowcpu.cjs; each call's emulated
// CPU is read from the preload, outside the server's own accounting, on a warm second pass (the
// datasets a call decodes are cached once per process, whichever call came first).
// Measured on the owner's Mac (warm): at 6× every call within 10 % of 8 s; at 30× every call cut
// short says so, and what runs past 8 s is the work outside the samplers (the reads and the answer's
// assembly, ×30) — before: 6× up to 11.2 s and 30× up to 54 s, partial false.
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bodyOf,
  logRecords,
  makeHome,
  requireDist,
  seedHome,
  serve,
  type E2eHome,
  type Served,
} from "./helpers.js";

const SLOWCPU = path.join(import.meta.dirname, "fixtures", "slowcpu.cjs");
const DEADLINE_MS = 8000;

const CALLS: readonly [string, Record<string, unknown>][] = [
  ["espn_project_players", { players: { team_id: 2 }, horizon: "season", seed: 1 }],
  ["espn_project_players", { players: { team_id: 2 }, horizon: "week", week: 5, seed: 1 }],
  ["espn_analyze_lineup", { week: 5, objective: "pwin" }],
  ["espn_analyze_matchup", { week: 5, mode: "pre", seed: 1 }],
  ["espn_analyze_matchup", { mode: "season", seed: 4 }],
  ["espn_analyze_replacement", {}],
  ["espn_analyze_trade", { find_partners: { need_position: "WR" }, seed: 2 }],
  ["espn_analyze_schedule", {}],
  ["espn_analyze_roster", { seed: 3 }],
  ["espn_analyze_waivers", { mode: "auto", phase: "auto" }],
  ["espn_analyze_league_activity", {}],
];

interface Measured {
  /** The call's emulated CPU, read from the preload around it. */
  readonly cpu_ms: number;
  /** What the server itself counted for the call (tool.end's cpu_ms). */
  readonly logged_cpu_ms: number;
  readonly partial: boolean;
  /** The call's "partial: … before the CPU deadline" lines (and v2's). */
  readonly cut: readonly string[];
}

/** A served home whose thread CPU runs K× slow; `measure` runs every call twice, the second measured. */
function scaled(k: number): {
  home: E2eHome;
  measure: () => Promise<Record<string, Measured>>;
  stop: () => Promise<void>;
} {
  const home = makeHome({
    env: {
      EFF_TOOLSET: "full",
      EFF_TEST_STUBS: "0",
      EFF_CREDENTIAL_STORE: "file",
      EFF_E2E_CPU_SCALE: String(k),
    },
  });
  home.env.EFF_CREDENTIAL_FILE = path.join(home.root, "config", "session.json");
  let s: Served | null = null;
  const cpuNow = async (): Promise<number> => {
    if (s === null) throw new Error("not served");
    const before = s.transport.stderr.length;
    s.transport.signal("SIGUSR2");
    const end = Date.now() + 60_000;
    for (;;) {
      const rec = logRecords(s.transport.stderr.slice(before)).find((l) => l.event === "e2e.cpu");
      if (rec !== undefined) return rec.cpu_ms as number;
      if (Date.now() > end) throw new Error("no e2e.cpu line");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (s === null) throw new Error("not served");
    const r = await s.client.callTool({ name, arguments: args }, { timeout: 3_600_000 });
    const b = bodyOf(r);
    expect(r.isError, `${name}: ${JSON.stringify(b).slice(0, 300)}`).not.toBe(true);
    return b;
  };
  return {
    home,
    measure: async () => {
      requireDist();
      await seedHome(home);
      s = await serve(home, { preloads: [SLOWCPU] });
      await callTool("espn_get_roster", { week: 5 });
      for (const [name, args] of CALLS) await callTool(name, args);
      const out: Record<string, Measured> = {};
      for (const [name, args] of CALLS) {
        const key = `${name}${typeof args.mode === "string" ? `_${args.mode}` : ""}${typeof args.horizon === "string" ? `_${args.horizon}` : ""}`;
        const logFrom = s.transport.stderr.length;
        const c0 = await cpuNow();
        const b = await callTool(name, args);
        const c1 = await cpuNow();
        const end = logRecords(s.transport.stderr.slice(logFrom)).find(
          (l) => l.event === "tool.end" && l.tool === name,
        );
        out[key] = {
          cpu_ms: Math.round(c1 - c0),
          logged_cpu_ms: typeof end?.cpu_ms === "number" ? end.cpu_ms : -1,
          partial: b.partial === true,
          cut: ((b.warnings as string[] | undefined) ?? []).filter((w) => w.startsWith("partial:")),
        };
      }
      process.stdout.write(`cpu report (×${String(k)}): ${JSON.stringify(out)}\n`);
      return out;
    },
    stop: async () => {
      if (s !== null) await s.stop();
      home.cleanup();
    },
  };
}

/** Rules every scale holds: a said cut is flagged; the server counts the call's whole CPU. */
function commonRules(report: Record<string, Measured>): string[] {
  const bad: string[] = [];
  for (const [key, m] of Object.entries(report)) {
    // a cut the warnings name is never passed off as complete
    if (m.cut.length > 0 && !m.partial)
      bad.push(`${key}: ${String(m.cut.length)} partial: line(s), partial false`);
    // the deadline counts the call's CPU outside every batch too (its reads, its assembly): the
    // server's own count is the call's whole CPU, as measured from outside (within 15 %)
    if (m.logged_cpu_ms < 0.85 * m.cpu_ms)
      bad.push(`${key}: the server counted ${String(m.logged_cpu_ms)} of ${String(m.cpu_ms)} ms`);
  }
  return bad;
}

describe(
  "on a 6× slower CPU every analytics call stops within a batch or so of the 8 s deadline",
  {
    timeout: 3_600_000,
  },
  () => {
    const run = scaled(6);
    afterAll(run.stop);

    it("each call's emulated CPU ≤ 1.25 × 8 s; a cut is flagged and said; the server counts it all", async () => {
      const report = await run.measure();
      const over = Object.entries(report)
        .filter(([, m]) => m.cpu_ms > 1.25 * DEADLINE_MS)
        .map(([key, m]) => `${key}: ${String(m.cpu_ms)} ms`);
      expect(over).toEqual([]);
      expect(commonRules(report)).toEqual([]);
    });
  },
);

describe(
  "on a 30× slower CPU every call cut short says so, and none runs a fresh budget",
  {
    timeout: 3_600_000,
  },
  () => {
    const run = scaled(30);
    afterAll(run.stop);

    it("a call past 1.25 × 8 s is partial; none passes 3 × 8 s; a cut is said; the server counts it all", async () => {
      const report = await run.measure();
      const bad: string[] = [];
      for (const [key, m] of Object.entries(report)) {
        if (m.cpu_ms > 1.25 * DEADLINE_MS && !m.partial)
          bad.push(`${key}: ${String(m.cpu_ms)} ms, partial false`);
        // a run that started a fresh 8 s (the defect) took E3, E6 and E2 to 30–54 s here
        if (m.cpu_ms > 3 * DEADLINE_MS) bad.push(`${key}: ${String(m.cpu_ms)} ms`);
      }
      expect(bad).toEqual([]);
      expect(commonRules(report)).toEqual([]);
    });
  },
);
