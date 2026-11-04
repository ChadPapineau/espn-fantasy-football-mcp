// stall-verdict.test.ts — the stall measurement's verdict (tests/e2e/helpers.ts judgeStall,
// measureStall, stallReport; plan 10 A16a; ruling R8-2 as amended by changelog §R10, R10-9). A window
// over the 50 ms bound is repeated, at most three windows, only on the host's evidence. When the host
// set every window by the idle control's stall and the server's own longest run on the CPU between
// two heartbeat ticks (cpu_max_ms) stays under the bound in each, the measurement passes, reported as
// "host-set; the server's own longest CPU run N ms" — never as a plain pass; a window whose
// cpu_max_ms reaches the bound fails as the server's own stall; where cpu_max_ms cannot be read, or a
// window's only evidence was the process's involuntary switches, R8-2 stands ("cannot be measured").
// Every cell on recorded windows (a pure function), then measureStall over scripted heartbeat
// sources, then one end-to-end run: the BUILT server and a real idle control both frozen by the host
// (SIGSTOP/SIGCONT, as an OS that stops every process does) in each window — a host-set pass with its
// report line. No network.
import { afterAll, describe, expect, it } from "vitest";
import {
  CONTROL_STARVED_MS,
  HEARTBEAT,
  heartbeatOf,
  judgeStall,
  makeHome,
  measureStall,
  requireDist,
  serve,
  StallControl,
  STALL_WINDOW_ATTEMPTS,
  stallEvidence,
  stallPassed,
  stallReport,
  type E2eHome,
  type Heartbeat,
  type HeartbeatSource,
  type RecordedWindow,
  type Served,
} from "./helpers.js";

const BOUND = 50;

/** A server window: its stall, its longest gap's own CPU and switches, its longest CPU run. */
const hb = (
  max_ms: number,
  o: { gap_cpu_ms?: number; gap_invol?: number; cpu_max_ms?: number | null } = {},
): Heartbeat => ({
  max_ms,
  gap_ms: max_ms - 5,
  gap_cpu_ms: o.gap_cpu_ms ?? 2,
  gap_invol: o.gap_invol ?? 0,
  cpu_max_ms: o.cpu_max_ms === undefined ? 12 : o.cpu_max_ms,
});
const win = (server: Heartbeat, control_ms: number): RecordedWindow => ({ server, control_ms });
/** A window the host set by the idle control's stall (R10-9's evidence), the server's run `cpu`. */
const frozen = (cpu: number | null, stall = 120): RecordedWindow =>
  win(hb(stall, { cpu_max_ms: cpu }), 130);

describe("judgeStall: every cell of R8-2 as amended by changelog §R10, R10-9", () => {
  it("a window within the bound passes at once, plainly", () => {
    expect(judgeStall([win(hb(31), 5)], BOUND)).toEqual({ kind: "within" });
    expect(judgeStall([win(hb(BOUND), 200)], BOUND)).toEqual({ kind: "within" }); // at the bound
  });

  it("a window over the bound that nothing shows the host set is the server's own stall", () => {
    // off the CPU with no switch and a quiet control: a blocking wait of its own
    expect(judgeStall([win(hb(90), 5)], BOUND)).toEqual({ kind: "own" });
    // a JavaScript block over the bound, even beside a starved control (R8-2)
    expect(judgeStall([win(hb(90, { cpu_max_ms: 60 }), 200)], BOUND)).toEqual({ kind: "own" });
    expect(judgeStall([win(hb(90, { gap_cpu_ms: 80 }), 200)], BOUND)).toEqual({ kind: "own" });
  });

  it("a window the host set is repeated, up to the cap", () => {
    expect(STALL_WINDOW_ATTEMPTS).toBe(3);
    expect(judgeStall([frozen(12)], BOUND)).toEqual({ kind: "repeat" });
    expect(judgeStall([frozen(12), frozen(30)], BOUND)).toEqual({ kind: "repeat" });
    // the process's own involuntary switches are host evidence too (unchanged)
    expect(judgeStall([win(hb(90, { gap_invol: 4 }), 5)], BOUND)).toEqual({ kind: "repeat" });
  });

  it("repeated windows, then one within the bound or the server's own: that one decides", () => {
    expect(judgeStall([frozen(12), frozen(12), win(hb(20), 5)], BOUND)).toEqual({ kind: "within" });
    expect(judgeStall([frozen(12), win(hb(90), 5)], BOUND)).toEqual({ kind: "own" });
    expect(
      judgeStall([frozen(12), frozen(12), win(hb(90, { cpu_max_ms: 51 }), 200)], BOUND),
    ).toEqual({ kind: "own" });
  });

  it("R10-9: every window host-set by the control's stall, the own CPU run under the bound — a host-set pass", () => {
    const v = judgeStall([frozen(12.3), frozen(37.04), frozen(20)], BOUND);
    expect(v).toEqual({ kind: "host_set", own_cpu_max_ms: 37.04 });
    // just under the bound in every window still passes
    expect(judgeStall([frozen(49.9), frozen(49.9), frozen(49.9)], BOUND)).toEqual({
      kind: "host_set",
      own_cpu_max_ms: 49.9,
    });
    // a control just past its starved mark is the evidence; the server's stall may be anything
    expect(
      judgeStall(
        [frozen(5, 400), win(hb(70, { cpu_max_ms: 4 }), CONTROL_STARVED_MS + 0.1), frozen(5)],
        BOUND,
      ),
    ).toEqual({ kind: "host_set", own_cpu_max_ms: 5 });
  });

  it("R10-9: a window whose own CPU run reaches the bound fails as the server's own stall", () => {
    // at the bound in the FIRST window: the server's own at once, never repeated (hostSetStall reads
    // "reaches" as judgeStall's last check does; it used to excuse a run equal to the bound, so the
    // window was repeated and a later window within the bound passed the measurement)
    expect(judgeStall([frozen(BOUND)], BOUND)).toEqual({ kind: "own" });
    expect(judgeStall([frozen(12), frozen(BOUND)], BOUND)).toEqual({ kind: "own" });
    expect(judgeStall([win(hb(60, { cpu_max_ms: BOUND }), 40)], BOUND)).toEqual({ kind: "own" });
    expect(() =>
      judgeStall([win(hb(60, { cpu_max_ms: BOUND }), 40), win(hb(30), 5)], BOUND),
    ).toThrow(RangeError);
    // a window at the bound ends the measurement: no window is taken after it
    expect(() => judgeStall([frozen(12), frozen(BOUND), frozen(12)], BOUND)).toThrow(RangeError);
    // …even when another window's run cannot be read
    expect(judgeStall([frozen(null), frozen(12), frozen(BOUND)], BOUND)).toEqual({ kind: "own" });
  });

  it("R10-9: where cpu_max_ms cannot be read, R8-2 stands — it cannot be measured", () => {
    expect(judgeStall([frozen(12), frozen(null), frozen(12)], BOUND)).toEqual({
      kind: "unmeasurable",
    });
    expect(judgeStall([frozen(null), frozen(null), frozen(null)], BOUND)).toEqual({
      kind: "unmeasurable",
    });
  });

  it("R10-9: a window the host set by the process's switches alone (a quiet control) leaves R8-2 standing", () => {
    // the control is what tells a host freeze from an off-CPU wait inside the server
    const switches = win(hb(90, { gap_invol: 6, cpu_max_ms: 3 }), 5);
    expect(judgeStall([frozen(12), switches, frozen(12)], BOUND)).toEqual({ kind: "unmeasurable" });
    expect(judgeStall([switches, switches, switches], BOUND)).toEqual({ kind: "unmeasurable" });
    const atMark = win(hb(90, { gap_invol: 2, cpu_max_ms: 3 }), CONTROL_STARVED_MS);
    expect(judgeStall([frozen(12), frozen(12), atMark], BOUND)).toEqual({ kind: "unmeasurable" });
  });

  it("refuses no window, and a window after the one that ended the measurement", () => {
    expect(() => judgeStall([], BOUND)).toThrow(RangeError);
    expect(() => judgeStall([win(hb(20), 5), frozen(12)], BOUND)).toThrow(RangeError);
    expect(() => judgeStall([win(hb(90), 5), frozen(12)], BOUND)).toThrow(RangeError);
  });

  it("the report line: R10-9's pass is never reported as a plain one", () => {
    expect(stallReport({ kind: "host_set", own_cpu_max_ms: 37.04 }, 128.5, BOUND)).toBe(
      "host-set; the server's own longest CPU run 37.0 ms",
    );
    expect(stallReport({ kind: "within" }, 31.26, BOUND)).toBe(
      "within the bound: 31.3 ms <= 50 ms",
    );
    expect(stallReport({ kind: "own" }, 72, BOUND)).toBe("the server's own stall: 72.0 ms > 50 ms");
    expect(stallReport({ kind: "within" }, 6.1, 21.774783)).toBe(
      "within the bound: 6.1 ms <= 21.8 ms",
    );
    expect(stallReport({ kind: "unmeasurable" }, 72, BOUND)).toContain("cannot be measured");
    expect(stallPassed({ verdict: { kind: "within" } })).toBe(true);
    expect(stallPassed({ verdict: { kind: "host_set", own_cpu_max_ms: 1 } })).toBe(true);
    expect(stallPassed({ verdict: { kind: "own" } })).toBe(false);
  });
});

/** A heartbeat source that answers each fresh-window read, then the measured window, in turn. */
function scripted(windows: readonly Record<string, unknown>[]): HeartbeatSource {
  const stderr: string[] = [];
  let reads = 0;
  return {
    stderr,
    signal: () => {
      // measureStall reads a fresh window, then the measured one: odd reads are the measured ones
      const w = reads % 2 === 1 ? (windows[(reads - 1) / 2] ?? {}) : { max_ms: 0 };
      reads++;
      stderr.push(JSON.stringify({ event: "e2e.heartbeat", ...w }));
    },
  };
}
const line = (max_ms: number, cpu_max_ms: unknown): Record<string, unknown> => ({
  max_ms,
  gap_ms: max_ms - 5,
  gap_cpu_ms: 1,
  gap_invol: 0,
  cpu_max_ms,
});

describe("measureStall over scripted windows (the verdict, the windows taken, the report)", () => {
  it("three host-set windows with the own CPU run under the bound: a host-set pass, with every window", async () => {
    const server = scripted([line(120, 12), line(140, 31.2), line(118, 8)]);
    const control = scripted([{ max_ms: 110 }, { max_ms: 130 }, { max_ms: 100 }]);
    let runs = 0;
    const w = await measureStall(
      server,
      control,
      () => {
        runs++;
        return Promise.resolve();
      },
      BOUND,
    );
    expect(runs).toBe(3);
    expect(w.attempts).toBe(3);
    expect(w.verdict).toEqual({ kind: "host_set", own_cpu_max_ms: 31.2 });
    expect(w.report).toBe("host-set; the server's own longest CPU run 31.2 ms");
    expect(stallPassed(w)).toBe(true);
    expect(w.repeated.map((x) => x.server.max_ms)).toEqual([120, 140]);
    expect(JSON.parse(stallEvidence(w))).toMatchObject({ attempts: 3, stall_ms: 118 });
  });

  it("a line without cpu_max_ms (or a malformed one) reads null, and three such windows cannot be measured", async () => {
    for (const bad of [undefined, "12", -1, Number.NaN]) {
      const server = scripted([line(120, bad), line(120, bad), line(120, bad)]);
      const control = scripted([{ max_ms: 110 }, { max_ms: 110 }, { max_ms: 110 }]);
      await expect(
        measureStall(server, control, () => Promise.resolve(), BOUND),
        String(bad),
      ).rejects.toThrow(/cannot be measured.*rerun when it is quieter/);
    }
  });

  it("the server's own stall is returned after one window, failing stallPassed", async () => {
    const w = await measureStall(
      scripted([line(90, 3)]),
      scripted([{ max_ms: 5 }]),
      () => Promise.resolve(),
      BOUND,
    );
    expect(w.attempts).toBe(1);
    expect(w.verdict).toEqual({ kind: "own" });
    expect(stallPassed(w)).toBe(false);
  });

  it("a window whose own CPU run is exactly the bound beside a starved control is the server's own, never repeated (changelog §R10, R10-9)", async () => {
    // before: hostSetStall excused a run equal to the bound, so this window was repeated and the
    // next one, within the bound, passed the measurement
    let runs = 0;
    const w = await measureStall(
      scripted([line(60, BOUND), line(30, 3)]),
      scripted([{ max_ms: 40 }, { max_ms: 5 }]),
      () => {
        runs++;
        return Promise.resolve();
      },
      BOUND,
    );
    expect(runs).toBe(1);
    expect(w.attempts).toBe(1);
    expect(w.verdict).toEqual({ kind: "own" });
    expect(stallPassed(w)).toBe(false);
  });
});

describe("a host that freezes every process: R10-9's pass end to end (fx-10h over real stdio)", () => {
  let home: E2eHome | null = null;
  let s: Served | null = null;
  let control: StallControl | null = null;
  afterAll(async () => {
    control?.stop();
    if (s !== null) await s.stop();
    home?.cleanup();
  });

  it("the server and the idle control stopped together in every window: host-set, the server's own CPU run reported", async () => {
    requireDist();
    home = makeHome();
    s = await serve(home, { preloads: [HEARTBEAT] });
    const served = s;
    await served.client.callTool({ name: "espn_get_league", arguments: {} });
    control = await StallControl.start();
    const ctl = control;
    await heartbeatOf(served.transport);
    // the host: both processes taken off the CPU for 150 ms (an OS stopping every process), then a
    // cheap read — the server's own work stays far under the bound
    const freeze = async (): Promise<void> => {
      served.transport.signal("SIGSTOP");
      ctl.signal("SIGSTOP");
      await new Promise((r) => setTimeout(r, 150));
      served.transport.signal("SIGCONT");
      ctl.signal("SIGCONT");
      await new Promise((r) => setTimeout(r, 30));
      const r = await served.client.callTool({ name: "espn_get_league", arguments: {} });
      expect(r.isError).not.toBe(true);
    };
    const w = await measureStall(served.transport, ctl, freeze, BOUND);
    process.stdout.write(`host-freeze stall: ${w.report} ${stallEvidence(w)}\n`);
    expect(w.attempts).toBe(STALL_WINDOW_ATTEMPTS);
    expect(w.stall_ms).toBeGreaterThan(BOUND);
    for (const x of [...w.repeated, { server: w.server, control_ms: w.control_ms }])
      expect(x.control_ms).toBeGreaterThan(CONTROL_STARVED_MS);
    expect(w.verdict.kind).toBe("host_set");
    expect(w.report).toMatch(/^host-set; the server's own longest CPU run \d+\.\d ms$/);
    expect(stallPassed(w)).toBe(true);
  }, 120_000);
});
