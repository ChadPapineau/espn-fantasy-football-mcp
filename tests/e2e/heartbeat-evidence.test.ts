// heartbeat-evidence.test.ts — the stall probe's own evidence (tests/e2e/fixtures/heartbeat.cjs;
// helpers.ts hostSetStall, measureStall). The stall bounds of plan 10 A16a repeat a window only
// when the HOST set it (the OS took the server's thread off the CPU, or an idle process beside it
// stalled too), so the evidence must never excuse a stall the server causes itself. Two real stalls
// in a process with the probe preloaded: a JavaScript block (the loop busy on the CPU) and a
// synchronous wait (the loop off the CPU with no involuntary switch — a blocking read). Each is over
// the bound and is the process's own; neither may read as the host's. No network.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT,
  heartbeatRecordOf,
  hostSetStall,
  NO_SOCKET,
  ROOT,
  type HeartbeatSource,
} from "./helpers.js";

/** A process with the probe preloaded that, on SIGUSR1, stalls its loop `ms` the given way. */
async function stallingProcess(kind: "busy" | "wait", ms: number) {
  const block =
    kind === "busy"
      ? `const end = Date.now() + ${String(ms)}; while (Date.now() < end) {}`
      : `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(ms)});`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      NO_SOCKET,
      "--import",
      HEARTBEAT,
      "-e",
      `process.on("SIGUSR1", () => { ${block} process.stderr.write("e2e.stalled\\n"); }); process.stderr.write("e2e.ready\\n"); setInterval(() => {}, 1_000_000);`,
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
  const wait = async (line: string) => {
    const end = Date.now() + 10_000;
    while (!stderr.includes(line)) {
      if (Date.now() > end) throw new Error(`no ${line}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await wait("e2e.ready");
  const src: HeartbeatSource = { signal: (s) => child.kill(s), stderr };
  return {
    src,
    stall: async () => {
      child.kill("SIGUSR1");
      await wait("e2e.stalled");
    },
    stop: () => child.kill("SIGKILL"),
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
          expect(hb.gap_cpu_ms).toBeGreaterThan(80);
          expect(hostSetStall(hb, 5, 50)).toBe(false);
          expect(hostSetStall(hb, 200, 50)).toBe(false);
        } else {
          // off the CPU: its own unless the process saw an involuntary switch inside the gap
          expect(hb.gap_cpu_ms).toBeLessThan(50);
          expect(hostSetStall(hb, 5, 50), JSON.stringify(hb)).toBe(hb.gap_invol > 0);
        }
      } finally {
        p.stop();
      }
    },
    30_000,
  );

  it("hostSetStall: the host only with preemption inside a gap the thread barely used, or a starved control", () => {
    const hb = (gap_cpu_ms: number, gap_invol: number) => ({
      max_ms: 90,
      gap_ms: 90,
      gap_cpu_ms,
      gap_invol,
    });
    expect(hostSetStall(hb(20, 3), 5, 50)).toBe(true); // preempted: 20 ms of its own in a 90 ms gap
    expect(hostSetStall(hb(80, 3), 5, 50)).toBe(false); // its own CPU over the bound
    expect(hostSetStall(hb(20, 0), 5, 50)).toBe(false); // off the CPU by itself: a blocking wait
    expect(hostSetStall(hb(20, 0), 40, 50)).toBe(true); // an idle process beside it stalled 40 ms
    expect(hostSetStall(hb(80, 0), 40, 50)).toBe(false); // …but its own CPU is never excused
  });
});
