// heartbeat.cjs — the end-to-end stall probe (plan 10 A16a: "main-loop stall ≤ 50 ms during any
// analytics call, measured by a heartbeat timer in the process test"; ADV OBJ-07): an event-loop
// delay histogram at 5 ms resolution inside the server process; SIGUSR2 writes the window's maximum
// as one JSON log line on stderr and starts a new window.
// The line also carries the evidence that tells the server's own stall from the host's (Stage C
// final gate: on a loaded Mac the OS's preemption read as a 107 ms stall of six lineup calls whose
// own was 21 ms): over the window's longest gap between two ticks of a 5 ms timer, the main thread's
// own CPU time and the process's involuntary context switches. A loop blocked by JavaScript spends
// the gap on the CPU; one waiting on a synchronous read spends it off the CPU with no involuntary
// switch; only a thread the OS took off the CPU shows involuntary switches with little CPU of its
// own. tests/e2e/helpers.ts measureStall reads it.
const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
const h = monitorEventLoopDelay({ resolution: 5 });
h.enable();
const TICK_MS = 5;
const sample = () => {
  const c = process.threadCpuUsage();
  return {
    t: process.hrtime.bigint(),
    cpu_us: c.user + c.system,
    invol: process.resourceUsage().involuntaryContextSwitches,
  };
};
let last = sample();
let worst = { gap_ms: 0, gap_cpu_ms: 0, gap_invol: 0 };
setInterval(() => {
  const s = sample();
  const gap = Number(s.t - last.t) / 1e6 - TICK_MS;
  if (gap > worst.gap_ms)
    worst = {
      gap_ms: gap,
      gap_cpu_ms: (s.cpu_us - last.cpu_us) / 1000,
      gap_invol: s.invol - last.invol,
    };
  last = s;
}, TICK_MS).unref();
process.on("SIGUSR2", () => {
  const line = {
    event: "e2e.heartbeat",
    max_ms: h.max / 1e6,
    p99_ms: h.percentile(99) / 1e6,
    n: h.count,
    ...worst,
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
  h.reset();
  worst = { gap_ms: 0, gap_cpu_ms: 0, gap_invol: 0 };
  last = sample();
});
