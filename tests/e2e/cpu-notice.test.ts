// cpu-notice.test.ts — the per-tool CPU evidence's CI notices (tests/e2e/helpers.ts cpuNotices,
// noticeLine; the round-4d review's R4D-VS-2). GitHub cuts an annotation's message at 4096
// characters, and the one notice latency.test.ts wrote ended mid-object once three tools needed a
// profiled pass, so its JSON no longer parsed. Now: one notice for the unprofiled readings (in parts
// only when they would not fit), one per profiled entry, every message under 4000 characters and
// parseable on its own, together the whole reading. A pure function over readings at the fields'
// widest (every label at heartbeat.cjs's 80-character cut, five profiled functions); no server.
import { describe, expect, it } from "vitest";
import { cpuNotices, NOTICE_MESSAGE_MAX, noticeLine, type CpuNotice } from "./helpers.js";

const TITLE = "latency per-tool cpu_max (full, cold)";
/** GitHub's own cut: a message this long or longer is truncated. */
const GITHUB_CUT = 4096;

const label = (s: string): string => s.padEnd(80, "x").slice(0, 80);
/** latency.test.ts cpuSplitOf at its widest: every key, the labels at 80 characters. */
const split = (i: number) => ({
  wall_ms: 23.4,
  js_ms: 17.9,
  sql_ms: 3.1,
  sql_n: 42,
  sql_top: label(
    `SELECT body, stamped_at FROM espn_cache WHERE key = ? AND view = ? -- ${String(i)} %`,
  ),
  sql_top_ms: 1.2,
  gc_ms: 0.8,
  gc_n: 3,
  gc_top_kind: "minor",
  fs_ms: 0.4,
  wait_ms: 0,
  invol: 2,
});
const TOOLS = [
  "espn_analyze_matchup_pre",
  "espn_analyze_matchup_season",
  "espn_analyze_replacement",
  "espn_analyze_trade",
  "espn_analyze_injury_cascade",
  "espn_analyze_schedule",
  "espn_analyze_roster",
  "espn_analyze_evidence",
  "espn_analyze_league_activity",
  "espn_analyze_waivers_auto",
];
/** The reading latency.test.ts builds: every tool, and `profiled` of them profiled. */
function reading(profiled: number, tools: readonly string[] = TOOLS): Record<string, unknown> {
  const each: Record<string, unknown> = {};
  tools.forEach((t, i) => {
    each[t] = {
      cpu_max_ms: 21.7,
      gap_ms: 24.3,
      gap_cpu_ms: 20.1,
      gap_invol: 1,
      sql_ms: 2.2,
      gc_ms: 0.6,
      cpu: split(i),
    };
  });
  tools.slice(0, profiled).forEach((t, i) => {
    each[`${t}_profiled`] = {
      cpu_max_ms: 38.2,
      cpu: split(i),
      fn: [0, 1, 2, 3, 4].map((n) =>
        label(`simulateSeason${String(n)} dist/domain/sim.js:${String(n)} 4.1 ms`),
      ),
    };
  });
  return each;
}

/** A message as GitHub shows it (the workflow command's data escapes undone). */
const unescape = (m: string): string =>
  m.replace(/%0D/g, "\r").replace(/%0A/g, "\n").replace(/%25/g, "%");
const parsed = (n: CpuNotice): Record<string, unknown> =>
  JSON.parse(unescape(n.message)) as Record<string, unknown>;

describe("R4D-VS-2: every per-tool CPU notice is under GitHub's cut and parses on its own", () => {
  it("the reading this guards: as one notice, five profiled tools pass GitHub's 4096-character cut", () => {
    // what latency.test.ts wrote before: the whole reading in one message, cut by GitHub mid-object
    expect(JSON.stringify(reading(5)).length).toBeGreaterThan(GITHUB_CUT);
  });

  it.each([0, 1, 3, 5, 10])(
    "%i profiled: one notice for the unprofiled readings, one per profiled entry, each under 4000 characters, together the whole reading",
    (profiled) => {
      const each = reading(profiled);
      const notices = cpuNotices(TITLE, each);
      expect(notices).toHaveLength(1 + profiled);
      const merged: Record<string, unknown> = {};
      for (const n of notices) {
        expect(n.message.length, n.title).toBeLessThan(NOTICE_MESSAGE_MAX);
        Object.assign(merged, parsed(n));
      }
      expect(merged).toEqual(each);
      // the first notice holds every unprofiled reading, under the plain title
      expect(notices[0]?.title).toBe(TITLE);
      expect(Object.keys(parsed(notices[0]!)).sort()).toEqual([...TOOLS].sort());
      // each profiled entry alone, its title naming it
      for (const n of notices.slice(1)) {
        const keys = Object.keys(parsed(n));
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/_profiled$/);
        expect(n.title).toBe(`${TITLE} — ${keys[0] ?? ""}`);
      }
    },
  );

  it("unprofiled readings that would not fit in one notice are split into parts, each whole and under the bound", () => {
    const tools = Array.from({ length: 30 }, (_, i) => `espn_analyze_tool_${String(i)}`);
    const each = reading(0, tools);
    const notices = cpuNotices(TITLE, each);
    expect(notices.length).toBeGreaterThan(1);
    const merged: Record<string, unknown> = {};
    notices.forEach((n, i) => {
      expect(n.message.length).toBeLessThan(NOTICE_MESSAGE_MAX);
      expect(n.title).toBe(`${TITLE} (part ${String(i + 1)} of ${String(notices.length)})`);
      Object.assign(merged, parsed(n));
    });
    expect(merged).toEqual(each);
  });

  it("an entry that alone would pass the bound drops its function labels from the end, then is marked cut, and still parses", () => {
    const fn = Array.from({ length: 80 }, (_, i) => label(`fn${String(i)} dist/x.js:${String(i)}`));
    const each = { espn_analyze_trade_profiled: { cpu_max_ms: 40, cpu: split(0), fn } };
    const [n] = cpuNotices(TITLE, each);
    expect(n).toBeDefined();
    expect(n!.message.length).toBeLessThan(NOTICE_MESSAGE_MAX);
    const v = parsed(n!).espn_analyze_trade_profiled as { fn: string[]; fn_cut: number };
    expect(v.fn.length).toBeGreaterThan(0);
    expect(v.fn).toEqual(fn.slice(0, v.fn.length));
    expect(v.fn_cut).toBe(fn.length - v.fn.length);
    // an entry with no labels to drop is replaced by a marker with its reading
    const wide = { espn_analyze_roster: { cpu_max_ms: 12, cpu: { sql_top: "y".repeat(5000) } } };
    const [m] = cpuNotices(TITLE, wide);
    expect(m!.message.length).toBeLessThan(NOTICE_MESSAGE_MAX);
    expect(parsed(m!)).toEqual({
      espn_analyze_roster: { cut: "over the notice bound", cpu_max_ms: 12 },
    });
  });

  it("noticeLine: the title's `:` and `,` are escaped as a property, the message's %, CR and LF as data — one command per line", () => {
    const line = noticeLine({ title: TITLE, message: cpuNotices(TITLE, reading(1))[0]!.message });
    expect(line.startsWith("::notice title=latency per-tool cpu_max (full%2C cold)::")).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
    // a % in a label reaches GitHub as itself
    const [n] = cpuNotices(TITLE, { t: { cpu: { sql_top: "LIKE '50%'\nx" } } });
    expect(n!.message).toContain("%25");
    expect(parsed(n!)).toEqual({ t: { cpu: { sql_top: "LIKE '50%'\nx" } } });
    // an empty reading is one empty notice, never none
    expect(cpuNotices(TITLE, {})).toEqual([{ title: TITLE, message: "{}" }]);
  });
});
