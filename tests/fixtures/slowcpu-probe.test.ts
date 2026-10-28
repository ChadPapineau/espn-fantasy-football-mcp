// slowcpu-probe.test.ts — the e2e CPU probe (tests/e2e/fixtures/slowcpu.cjs) measures the server,
// never itself. tests/e2e/cpu-deadline-scaled.test.ts bounds a call by two SIGUSR2 readings and
// compares the interval with the server's own count (tool.end cpu_ms); the probe's handler — its
// reading, its JSON line, its write — ran after the first reading, so its CPU landed inside every
// interval it bounded (≈ 1 ms of each measured call on a 6× CPU; Stage C finding
// ci-cpu-deadline-scaled-flaky). Driven here on a fake thread meter, so the arithmetic is exact: the
// interval holds K × the work between the readings and nothing of the probe, and the meter the
// server's deadline reads (process.threadCpuUsage) leaves the probe out too. One forked worker per
// test file (vitest `pool: forks`), so the patched process is this file's alone.
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROBE = path.join(import.meta.dirname, "..", "e2e", "fixtures", "slowcpu.cjs");
const K = 6;
/** The fake thread meter (µs): the test advances it; the probe's write costs PROBE_US. */
const meter = { user: 0, system: 0 };
const PROBE_US = 500;
const lines: string[] = [];

const original = {
  threadCpuUsage: process.threadCpuUsage.bind(process),
  write: process.stderr.write.bind(process.stderr),
  scale: process.env.EFF_E2E_CPU_SCALE,
};

beforeAll(() => {
  process.threadCpuUsage = (prev?: NodeJS.CpuUsage) =>
    prev === undefined
      ? { ...meter }
      : { user: meter.user - prev.user, system: meter.system - prev.system };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    // the probe's own work: a JSON line and a write cost real CPU
    meter.user += PROBE_US;
    return true;
  };
  process.env.EFF_E2E_CPU_SCALE = String(K);
  createRequire(import.meta.url)(PROBE);
});
afterAll(() => {
  process.removeAllListeners("SIGUSR2");
  process.threadCpuUsage = original.threadCpuUsage;
  process.stderr.write = original.write;
  if (original.scale === undefined) delete process.env.EFF_E2E_CPU_SCALE;
  else process.env.EFF_E2E_CPU_SCALE = original.scale;
});

/** One probe reading (the SIGUSR2 handler, run synchronously) → its emulated CPU (ms). */
function reading(): number {
  const before = lines.length;
  process.emit("SIGUSR2", "SIGUSR2");
  const line = lines.slice(before).find((l) => l.includes('"e2e.cpu"'));
  if (line === undefined) throw new Error("no e2e.cpu line");
  return (JSON.parse(line) as { cpu_ms: number }).cpu_ms;
}

describe("the CPU probe leaves its own cost off both meters (Stage C ci-cpu-deadline-scaled-flaky)", () => {
  it("two readings bound K × the work between them, none of the probe's write", () => {
    const a = reading();
    meter.user += 2_000; // the call's work: 2 ms real
    meter.system += 1_000; // and 1 ms in the kernel
    const b = reading();
    expect(b - a).toBeCloseTo(K * 3, 9);
    // back to back: nothing between the readings, nothing measured
    expect(reading() - reading()).toBeCloseTo(0, 9);
  });

  it("the server's deadline meter (process.threadCpuUsage) reads K × its work, the probe left out", () => {
    const s0 = process.threadCpuUsage();
    reading();
    meter.user += 4_000;
    reading();
    const d = process.threadCpuUsage(s0);
    expect((d.user + d.system) / 1000).toBeCloseTo(K * 4, 9);
  });
});
