// slowcpu.cjs — a K× slower CPU, emulated for the per-call CPU deadline (plan 07 E1 [A-7]; plan 10
// A16a; Stage C finding analytics-cpu-deadline-per-run): `process.threadCpuUsage` — the one meter
// the server's deadline reads (src/domain/clock.ts threadCpuClock) — reports K × the thread's real
// CPU since this preload ran (EFF_E2E_CPU_SCALE, default 1). SIGUSR2 writes the scaled total as one
// JSON line (`e2e.cpu`) on stderr, so a test measures a call's emulated CPU from outside the server's
// own accounting. Wall time is untouched: a batch still ends at its real 12 ms.
// The probe's own CPU (its handler: the reading, the JSON line, the write) is never on either meter:
// it is not the server's work, and a reading's write landed inside the very interval two readings
// bound (Stage C finding ci-cpu-deadline-scaled-flaky: ≈ 1 ms of every measured call at 6×).
const K = Number(process.env.EFF_E2E_CPU_SCALE ?? "1");
const real = process.threadCpuUsage.bind(process);
const base = real();
/** The probe's own real CPU so far (µs), left off both meters. */
const probe = { user: 0, system: 0 };
const scaled = () => {
  const u = real();
  return {
    user: base.user + (u.user - base.user - probe.user) * K,
    system: base.system + (u.system - base.system - probe.system) * K,
  };
};
process.threadCpuUsage = (prev) => {
  const s = scaled();
  return prev === undefined ? s : { user: s.user - prev.user, system: s.system - prev.system };
};
process.on("SIGUSR2", () => {
  const t0 = real();
  const s = scaled();
  process.stderr.write(
    `${JSON.stringify({ event: "e2e.cpu", cpu_ms: (s.user + s.system) / 1000 })}\n`,
  );
  const t1 = real();
  probe.user += t1.user - t0.user;
  probe.system += t1.system - t0.system;
});
