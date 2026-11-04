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
// own. The line also carries the main thread's longest run on the CPU between two ticks anywhere in
// the window (cpu_max_ms): a JavaScript block over the bound that is not the window's longest gap
// — a longer gap the host set beside it — is still seen, and is never excused (ruling R8-2).
// tests/e2e/helpers.ts measureStall reads it.
//
// `attr` attributes the longest gap (the Linux CI stall: ~50 ms of the loop blocked while its
// thread ran ~9 ms with no involuntary switch). Inside that gap: the main thread's wall time inside
// node:sqlite calls (every statement's run/get/all/iterate step, exec and prepare), inside the
// synchronous node:fs calls, and inside Atomics.wait (the store's blockFor), each with its count and
// its longest single call and that call's label (the SQL text or the fs function, cut to 60
// characters — code, never data); the GC pauses that overlap it (PerformanceObserver gc entries);
// and, where /proc exists (Linux), the main thread's own voluntary and involuntary switches and its
// run-queue delay, its block I/O, and the system's I/O and CPU pressure stall time and steal. `at`
// is the gap's end as epoch ms, so a test can name the call it fell in. Only the probe's own
// counters are read here: no value, path or environment variable is ever written.
const { monitorEventLoopDelay, performance, PerformanceObserver } =
  process.getBuiltinModule("node:perf_hooks");
const fs = process.getBuiltinModule("node:fs");
const { syncBuiltinESMExports } = process.getBuiltinModule("node:module");
const sqlite = process.getBuiltinModule("node:sqlite");

const h = monitorEventLoopDelay({ resolution: 5 });
h.enable();
const TICK_MS = 5;
const now = () => performance.now();

// --- the main thread's synchronous calls, timed (wall) -------------------------------------------
const LABEL_MAX = 60;
const cut = (s) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "?";
/**
 * One kind of synchronous call: cumulative wall ms and count; the longest since the last tick; the
 * longest in the window (win_top: a long call anywhere, even outside the longest gap).
 */
const kind = () => ({ ms: 0, n: 0, top_ms: 0, top: null, win_ms: 0, win: null });
const calls = { sql: kind(), fs: kind(), wait: kind() };
let depth = 0; // a call inside a timed call (fs inside a sqlite callback) is the outer one's
function timed(k, fn, self, args, label) {
  if (depth > 0) return fn.apply(self, args);
  depth += 1;
  const t0 = now();
  try {
    return fn.apply(self, args);
  } finally {
    const d = now() - t0;
    depth -= 1;
    k.ms += d;
    k.n += 1;
    if (d > k.top_ms) {
      k.top_ms = d;
      k.top = label(self, args);
      if (d > k.win_ms) {
        k.win_ms = d;
        k.win = k.top;
      }
    }
  }
}
const wrap = (owner, name, k, label) => {
  const fn = owner[name];
  if (typeof fn !== "function") return;
  const w = function (...args) {
    return timed(k, fn, this, args, label);
  };
  Object.defineProperty(w, "name", { value: fn.name });
  for (const p of Object.keys(fn)) w[p] = fn[p];
  owner[name] = w;
};
const stmtSql = (st) => {
  try {
    return cut(st.sourceSQL);
  } catch {
    return "?";
  }
};
const execSql = (_db, args) => cut(String(args[0]));
for (const m of ["run", "get", "all"]) wrap(sqlite.StatementSync.prototype, m, calls.sql, stmtSql);
wrap(sqlite.StatementSync.prototype, "iterate", calls.sql, stmtSql);
wrap(sqlite.DatabaseSync.prototype, "exec", calls.sql, execSql);
wrap(sqlite.DatabaseSync.prototype, "prepare", calls.sql, (_db, a) => `prepare ${execSql(_db, a)}`);
wrap(sqlite.DatabaseSync.prototype, "close", calls.sql, () => "close");
try {
  // an iterator's steps run the statement: each next() is a sqlite call
  const db = new sqlite.DatabaseSync(":memory:");
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1").iterate());
  db.close();
  calls.sql.ms = 0;
  calls.sql.n = 0;
  calls.sql.top_ms = 0;
  calls.sql.top = null;
  calls.sql.win_ms = 0;
  calls.sql.win = null;
  wrap(proto, "next", calls.sql, () => "iterate.next");
} catch {
  // no iterator prototype: its steps go unattributed
}
const origReadSync = fs.readSync;
const origOpenSync = fs.openSync;
for (const name of Object.keys(fs)) if (name.endsWith("Sync")) wrap(fs, name, calls.fs, () => name);
syncBuiltinESMExports();
wrap(Atomics, "wait", calls.wait, (_a, args) => `Atomics.wait ${String(args[3] ?? "")}`);

// --- GC pauses (delivered after the fact, matched to the gap by time) ----------------------------
const GC_KEEP = 4096;
let gcs = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push([e.startTime, e.duration, e.detail?.kind ?? 0]);
    if (gcs.length > GC_KEEP) gcs = gcs.slice(-GC_KEEP);
  }).observe({ entryTypes: ["gc"] });
} catch {
  // no gc entries: gc_ms stays null
  gcs = null;
}

// --- Linux: the main thread's own scheduling and I/O, the system's pressure ----------------------
const procFd = (p) => {
  try {
    return origOpenSync(p, "r");
  } catch {
    return null;
  }
};
const task = `/proc/self/task/${String(process.pid)}`;
const fds = {
  status: procFd(`${task}/status`),
  schedstat: procFd(`${task}/schedstat`),
  io: procFd(`${task}/io`),
  psiIo: procFd("/proc/pressure/io"),
  psiCpu: procFd("/proc/pressure/cpu"),
  stat: procFd("/proc/stat"),
};
const buf = Buffer.alloc(4096);
const readProc = (fd, max = buf.length) => {
  if (fd === null) return null;
  try {
    const n = origReadSync(fd, buf, 0, max, 0);
    return buf.toString("latin1", 0, n);
  } catch {
    return null;
  }
};
const field = (text, key) => {
  if (text === null) return null;
  const m = new RegExp(`(?:^|\\n)${key}:?\\s+(\\d+)`).exec(text);
  return m === null ? null : Number(m[1]);
};
const psiTotal = (text, which) => {
  if (text === null) return null;
  const m = new RegExp(`${which} [^\\n]*total=(\\d+)`).exec(text);
  return m === null ? null : Number(m[1]) / 1000;
};
function procSample() {
  if (fds.status === null) return null;
  const status = readProc(fds.status);
  const sched = readProc(fds.schedstat, 256);
  const io = readProc(fds.io, 512);
  const pio = readProc(fds.psiIo, 256);
  const pcpu = readProc(fds.psiCpu, 256);
  const stat = readProc(fds.stat, 512);
  const sp = sched === null ? [] : sched.trim().split(/\s+/).map(Number);
  const cpuLine = stat === null ? null : /^cpu\s+([^\n]*)/.exec(stat);
  const cols = cpuLine === null ? [] : cpuLine[1].trim().split(/\s+/).map(Number);
  const tick = 1000 / 100; // USER_HZ
  return {
    vol: field(status, "voluntary_ctxt_switches"),
    invol: field(status, "nonvoluntary_ctxt_switches"),
    run_delay_ms: sp.length >= 2 ? sp[1] / 1e6 : null,
    rd_kb: field(io, "read_bytes") === null ? null : field(io, "read_bytes") / 1024,
    wr_kb: field(io, "write_bytes") === null ? null : field(io, "write_bytes") / 1024,
    io_some_ms: psiTotal(pio, "some"),
    io_full_ms: psiTotal(pio, "full"),
    cpu_some_ms: psiTotal(pcpu, "some"),
    iowait_ms: cols.length > 4 ? cols[4] * tick : null,
    steal_ms: cols.length > 7 ? cols[7] * tick : null,
  };
}
const procDelta = (a, b) => {
  if (a === null || b === null) return null;
  const out = {};
  for (const k of Object.keys(b))
    out[k] = a[k] === null || b[k] === null ? null : Math.round((b[k] - a[k]) * 10) / 10;
  return out;
};

// --- the ticks ----------------------------------------------------------------------------------
const sample = () => {
  const c = process.threadCpuUsage();
  return {
    t: process.hrtime.bigint(),
    p: now(),
    at: Date.now(),
    cpu_us: c.user + c.system,
    invol: process.resourceUsage().involuntaryContextSwitches,
    sql: [calls.sql.ms, calls.sql.n],
    fs: [calls.fs.ms, calls.fs.n],
    wait: [calls.wait.ms, calls.wait.n],
    proc: procSample(),
  };
};
const tops = () => {
  const out = {};
  for (const k of ["sql", "fs", "wait"]) {
    out[k] = [calls[k].top, calls[k].top_ms];
    calls[k].top = null;
    calls[k].top_ms = 0;
  }
  return out;
};
let last = sample();
tops();
let worst = { gap_ms: 0, gap_cpu_ms: 0, gap_invol: 0 };
let worstAttr = null;
let cpuMax = 0;
const r1 = (x) => Math.round(x * 10) / 10;
setInterval(() => {
  const s = sample();
  const top = tops();
  const gap = Number(s.t - last.t) / 1e6 - TICK_MS;
  const cpu = (s.cpu_us - last.cpu_us) / 1000;
  if (cpu > cpuMax) cpuMax = cpu;
  if (gap > worst.gap_ms) {
    worst = {
      gap_ms: gap,
      gap_cpu_ms: cpu,
      gap_invol: s.invol - last.invol,
    };
    const of = (k) => ({
      [`${k}_ms`]: r1(s[k][0] - last[k][0]),
      [`${k}_n`]: s[k][1] - last[k][1],
      [`${k}_top`]: top[k][0],
      [`${k}_top_ms`]: r1(top[k][1]),
    });
    worstAttr = {
      at: s.at,
      p0: last.p,
      p1: s.p,
      ...of("sql"),
      ...of("fs"),
      ...of("wait"),
      proc: procDelta(last.proc, s.proc),
    };
  }
  last = s;
}, TICK_MS).unref();

/** The GC pauses overlapping the gap [p0, p1]: their total, count, longest and its kind. */
function gcIn(p0, p1) {
  if (gcs === null) return { gc_ms: null, gc_n: null, gc_top_ms: null, gc_top_kind: null };
  let ms = 0;
  let n = 0;
  let top = 0;
  let topKind = null;
  for (const [start, dur, k] of gcs) {
    const o = Math.min(p1, start + dur) - Math.max(p0, start);
    if (o <= 0) continue;
    ms += o;
    n += 1;
    if (dur > top) {
      top = dur;
      topKind = k;
    }
  }
  return { gc_ms: r1(ms), gc_n: n, gc_top_ms: r1(top), gc_top_kind: topKind };
}

process.on("SIGUSR2", () => {
  let attr = null;
  if (worstAttr !== null) {
    const { p0, p1, proc, ...rest } = worstAttr;
    attr = { ...rest, ...gcIn(p0, p1), ...(proc === null ? {} : proc) };
  }
  // the window's longest single call of each kind, wherever it ran
  const win = {};
  for (const k of ["sql", "fs", "wait"]) {
    win[`win_${k}_top`] = calls[k].win;
    win[`win_${k}_top_ms`] = r1(calls[k].win_ms);
    calls[k].win = null;
    calls[k].win_ms = 0;
  }
  if (attr !== null) attr = { ...attr, ...win };
  const line = {
    event: "e2e.heartbeat",
    max_ms: h.max / 1e6,
    p99_ms: h.percentile(99) / 1e6,
    n: h.count,
    ...worst,
    cpu_max_ms: cpuMax,
    attr,
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
  h.reset();
  worst = { gap_ms: 0, gap_cpu_ms: 0, gap_invol: 0 };
  worstAttr = null;
  cpuMax = 0;
  if (gcs !== null) gcs = [];
  last = sample();
  tops();
});
