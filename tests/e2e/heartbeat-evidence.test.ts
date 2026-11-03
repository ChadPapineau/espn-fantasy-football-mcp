// heartbeat-evidence.test.ts — the stall probe's own evidence (tests/e2e/fixtures/heartbeat.cjs;
// helpers.ts hostSetStall, measureStall). The stall bounds of plan 10 A16a repeat a window only
// when the HOST set it (the OS took the server's thread off the CPU, or an idle process beside it
// stalled too), so the evidence must never excuse a stall the server causes itself. Real stalls in
// a process with the probe preloaded: a JavaScript block (the loop busy on the CPU), a synchronous
// wait (the loop off the CPU with no involuntary switch — a blocking read), and a block beside a
// longer wait (ruling R8-2: a JavaScript block over the bound is never excused, even when another
// gap is the window's longest). Each is over the bound and is the process's own; none may read as
// the host's. A block spins on the thread's own CPU time, so it spends exactly that much CPU however
// loaded the machine is. stallEvidence's line, which the latency suite prints with each verdict,
// carries that evidence. No network.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT,
  heartbeatRecordOf,
  hostSetStall,
  measureStall,
  NO_SOCKET,
  ROOT,
  stallEvidence,
  type HeartbeatSource,
} from "./helpers.js";

/** A busy block of `ms` of the main thread's own CPU (never wall time: a preempted spin runs on). */
const busy = (ms: number): string =>
  `{ const cpu = () => { const c = process.threadCpuUsage(); return (c.user + c.system) / 1000; }; const end = cpu() + ${String(ms)}; while (cpu() < end) {} }`;
/** A synchronous wait of `ms` off the CPU (a blocking read). */
const wait = (ms: number): string =>
  `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(ms)});`;

/**
 * A process with the probe preloaded that, on SIGUSR1, stalls its loop `ms` the given way —
 * "masked": a block of `ms`, then, after a few ticks of the probe, a wait of 1 s, the window's
 * longest gap.
 */
async function stallingProcess(kind: "busy" | "wait" | "masked", ms: number) {
  const marker = `process.stderr.write("e2e.stalled\\n");`;
  const handler =
    kind === "busy"
      ? `${busy(ms)} ${marker}`
      : kind === "wait"
        ? `${wait(ms)} ${marker}`
        : `${busy(ms)} setTimeout(() => { ${wait(1000)} ${marker} }, 30);`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      NO_SOCKET,
      "--import",
      HEARTBEAT,
      "-e",
      `process.on("SIGUSR1", () => { ${handler} }); process.stderr.write("e2e.ready\\n"); setInterval(() => {}, 1_000_000);`,
    ],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
  );
  const stderr: string[] = [];
  let err = "";
  child.stderr.on("data", (b: Buffer) => {
    err += b.toString("utf8");
    const lines = err.split("\n");
    err = lines.pop() ?? "";
    stderr.push(...lines.filter(Boolean));
  });
  const lineOf = async (line: string, from: number) => {
    const end = Date.now() + 10_000;
    while (!stderr.slice(from).includes(line)) {
      if (Date.now() > end) throw new Error(`no ${line}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await lineOf("e2e.ready", 0);
  const src: HeartbeatSource = { signal: (s) => child.kill(s), stderr };
  return {
    src,
    /** One stall, done (a fresh marker each time). */
    stall: async () => {
      const from = stderr.length;
      child.kill("SIGUSR1");
      await lineOf("e2e.stalled", from);
    },
    stop: () => child.kill("SIGKILL"),
  };
}

/** An idle control that always reads `ms` — a host starving every process beside the server. */
function starvedControl(ms: number): HeartbeatSource {
  const stderr: string[] = [];
  return {
    stderr,
    signal: () => {
      stderr.push(JSON.stringify({ event: "e2e.heartbeat", max_ms: ms }));
    },
  };
}

describe("the heartbeat's evidence never excuses the process's own stall", () => {
  it.each(["busy", "wait"] as const)(
    "a %s stall of 120 ms: measured over the bound, and not the host's",
    async (kind) => {
      const p = await stallingProcess(kind, 120);
      try {
        await heartbeatRecordOf(p.src); // a fresh window
        await p.stall();
        await new Promise((r) => setTimeout(r, 30));
        const hb = await heartbeatRecordOf(p.src);
        expect(hb.max_ms).toBeGreaterThan(100);
        expect(hb.gap_ms).toBeGreaterThan(100);
        if (kind === "busy") {
          // on the CPU for the whole block: its own, even beside a starved control
          expect(hb.gap_cpu_ms).toBeGreaterThan(100);
          expect(hb.cpu_max_ms).toBeGreaterThan(100);
          expect(hostSetStall(hb, 5, 50)).toBe(false);
          expect(hostSetStall(hb, 200, 50)).toBe(false);
        } else {
          // off the CPU: its own unless the process saw an involuntary switch inside the gap
          expect(hb.gap_cpu_ms).toBeLessThan(50);
          expect(hb.cpu_max_ms).toBeLessThan(50);
          expect(hostSetStall(hb, 5, 50), JSON.stringify(hb)).toBe(hb.gap_invol > 0);
        }
      } finally {
        p.stop();
      }
    },
    30_000,
  );

  it("a busy stall of 120 ms beside a longer wait: the wait is the window's longest gap, and the block is still seen and never excused", async () => {
    const p = await stallingProcess("masked", 120);
    try {
      await heartbeatRecordOf(p.src); // a fresh window
      await p.stall();
      await new Promise((r) => setTimeout(r, 30));
      const hb = await heartbeatRecordOf(p.src);
      // the longest gap is the 1 s wait, off the CPU: alone, a switch or a starved control would
      // excuse it…
      expect(hb.gap_ms, JSON.stringify(hb)).toBeGreaterThan(900);
      expect(hb.gap_cpu_ms).toBeLessThan(50);
      // …but the 120 ms block beside it ran on the CPU, and refuses the excuse
      expect(hb.cpu_max_ms).toBeGreaterThan(100);
      expect(hostSetStall({ ...hb, gap_invol: hb.gap_invol + 1 }, 200, 50)).toBe(false);
    } finally {
      p.stop();
    }
  }, 30_000);

  it("measureStall measures a window holding a JavaScript block over the bound beside a starved control — once, never a repeat", async () => {
    // ruling R8-2: a window is repeated only on the host's evidence, and a JavaScript block over the
    // bound is never excused; on the longest gap's evidence alone this window was repeated three
    // times and the server's own block was reported as a host that "cannot be measured"
    const p = await stallingProcess("masked", 120);
    try {
      const w = await measureStall(p.src, starvedControl(200), () => p.stall(), 50);
      expect(w.attempts).toBe(1);
      expect(w.control_ms).toBe(200);
      expect(w.stall_ms).toBeGreaterThan(100);
      expect(w.server.cpu_max_ms).toBeGreaterThan(100);
    } finally {
      p.stop();
    }
  }, 30_000);

  it("stallEvidence prints what a verdict rests on: a JavaScript block's own CPU, and every repeated window", async () => {
    // a real block over the bound beside a quiet control (5 ms): measured once, and its line names
    // the server's own CPU — a red stall says it was the server's, not an unexcused wait
    const p = await stallingProcess("busy", 120);
    try {
      const w = await measureStall(p.src, starvedControl(5), () => p.stall(), 50);
      const ev = JSON.parse(stallEvidence(w)) as Record<string, unknown>;
      expect(ev.attempts).toBe(1);
      expect(ev.stall_ms).toBeGreaterThan(100);
      expect(ev.gap_cpu_ms).toBeGreaterThan(100);
      expect(ev.cpu_max_ms).toBeGreaterThan(100);
      expect(ev.control_ms).toBe(5);
      expect(ev.repeated).toEqual([]);
    } finally {
      p.stop();
    }
    // a window repeated on the host's evidence: the measured window, then the repeated one, at 0.1 ms
    const hb = (max_ms: number, gap_cpu_ms: number, gap_invol: number, cpu_max_ms: number) => ({
      max_ms,
      gap_ms: max_ms - 5,
      gap_cpu_ms,
      gap_invol,
      cpu_max_ms,
    });
    expect(
      stallEvidence({
        stall_ms: 31.26,
        control_ms: 6.04,
        attempts: 2,
        server: hb(31.26, 30.71, 4, 30.71),
        repeated: [{ server: hb(74.83, 4.44, 9, 23.08), control_ms: 36.51 }],
      }),
    ).toBe(
      JSON.stringify({
        attempts: 2,
        stall_ms: 31.3,
        gap_ms: 26.3,
        gap_cpu_ms: 30.7,
        gap_invol: 4,
        cpu_max_ms: 30.7,
        control_ms: 6,
        repeated: [
          {
            stall_ms: 74.8,
            gap_ms: 69.8,
            gap_cpu_ms: 4.4,
            gap_invol: 9,
            cpu_max_ms: 23.1,
            control_ms: 36.5,
          },
        ],
      }),
    );
  }, 30_000);

  it("hostSetStall: the host only with preemption inside a gap the thread barely used, or a starved control", () => {
    const hb = (gap_cpu_ms: number, gap_invol: number, cpu_max_ms = gap_cpu_ms) => ({
      max_ms: 90,
      gap_ms: 90,
      gap_cpu_ms,
      gap_invol,
      cpu_max_ms,
    });
    expect(hostSetStall(hb(20, 3), 5, 50)).toBe(true); // preempted: 20 ms of its own in a 90 ms gap
    expect(hostSetStall(hb(80, 3), 5, 50)).toBe(false); // its own CPU over the bound
    expect(hostSetStall(hb(20, 0), 5, 50)).toBe(false); // off the CPU by itself: a blocking wait
    expect(hostSetStall(hb(20, 0), 40, 50)).toBe(true); // an idle process beside it stalled 40 ms
    expect(hostSetStall(hb(80, 0), 40, 50)).toBe(false); // …but its own CPU is never excused
    // a block over the bound elsewhere in the window: never excused, whatever the longest gap shows
    expect(hostSetStall(hb(20, 3, 60), 5, 50)).toBe(false);
    expect(hostSetStall(hb(20, 0, 60), 40, 50)).toBe(false);
    expect(hostSetStall(hb(20, 3, 50), 40, 50)).toBe(true); // at the bound, not over it
  });
});
