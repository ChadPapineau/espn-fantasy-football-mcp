// heartbeat.cjs — the end-to-end stall probe (plan 10 A16a: "main-loop stall ≤ 50 ms during any
// analytics call, measured by a heartbeat timer in the process test"; ADV OBJ-07): an event-loop
// delay histogram at 5 ms resolution inside the server process; SIGUSR2 writes the window's maximum
// as one JSON log line on stderr and starts a new window.
const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
const h = monitorEventLoopDelay({ resolution: 5 });
h.enable();
process.on("SIGUSR2", () => {
  const line = {
    event: "e2e.heartbeat",
    max_ms: h.max / 1e6,
    p99_ms: h.percentile(99) / 1e6,
    n: h.count,
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
  h.reset();
});
