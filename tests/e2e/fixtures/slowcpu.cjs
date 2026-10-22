// slowcpu.cjs — a K× slower CPU, emulated for the per-call CPU deadline (plan 07 E1 [A-7]; plan 10
// A16a; Stage C finding analytics-cpu-deadline-per-run): `process.threadCpuUsage` — the one meter
// the server's deadline reads (src/domain/clock.ts threadCpuClock) — reports K × the thread's real
// CPU since this preload ran (EFF_E2E_CPU_SCALE, default 1). SIGUSR2 writes the scaled total as one
// JSON line (`e2e.cpu`) on stderr, so a test measures a call's emulated CPU from outside the server's
// own accounting. Wall time is untouched: a batch still ends at its real 12 ms.
const K = Number(process.env.EFF_E2E_CPU_SCALE ?? "1");
const real = process.threadCpuUsage.bind(process);
const base = real();
const scaled = () => {
  const u = real();
  return {
    user: base.user + (u.user - base.user) * K,
    system: base.system + (u.system - base.system) * K,
  };
};
process.threadCpuUsage = (prev) => {
  const s = scaled();
  return prev === undefined ? s : { user: s.user - prev.user, system: s.system - prev.system };
};
process.on("SIGUSR2", () => {
  const s = scaled();
  process.stderr.write(
    `${JSON.stringify({ event: "e2e.cpu", cpu_ms: (s.user + s.system) / 1000 })}\n`,
  );
});
