// limiter-child.ts — one "server process" for the cross-process limiter test: it opens the shared
// limiter table — the test's minimal SQLite repository, or the real store's (`store` mode) — and
// makes N acquisitions through the real EspnLimiter on a shared VIRTUAL clock (real time × SPEED
// from a common base, so both processes agree on "now" and a virtual minute takes about a second).
// With HOLD (virtual ms) > 0 the N acquisitions run concurrently and each request is held that long
// before it finishes (the in-flight cap's test), and each held interval is reported. Prints one
// JSON line: sent and refused counts (and the held intervals, virtual ms).
import path from "node:path";
import { EspnLimiter } from "../../../../src/providers/espn/limiter.js";
import { storeFactory } from "../../../../src/store/index.js";
import type { LimiterRepository } from "../../../../src/store/types.js";
import { openSqliteLimiter } from "./sqlite-limiter.js";

const [file, nArg, baseArg, realStartArg, speedArg, impl, holdArg] = process.argv.slice(2);
const hold = Number(holdArg ?? "0");
const n = Number(nArg);
const base = Number(baseArg);
const realStart = Number(realStartArg);
const speed = Number(speedArg);
const nowMs = (): number => base + (Date.now() - realStart) * speed;
const clock = { nowMs, nowIso: () => new Date(nowMs()).toISOString() };
let repo: LimiterRepository;
let close: () => void;
if (impl === "store") {
  const dir = path.dirname(String(file));
  const store = storeFactory.open({
    path: String(file),
    datasetDir: path.join(dir, "datasets"),
    backupDir: path.join(dir, "backups"),
    clock,
    migrate: false,
  });
  repo = store.repos.limiter;
  close = () => {
    store.close();
  };
} else {
  const r = openSqliteLimiter(String(file));
  repo = r;
  close = () => {
    r.close();
  };
}
const limiter = new EspnLimiter({
  repo,
  clock,
  origin: "server",
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(1, ms / speed))),
});
let sent = 0;
let refused = 0;
const held: [number, number][] = [];
if (hold > 0) {
  await Promise.all(
    Array.from({ length: n }, async () => {
      try {
        const t = await limiter.acquire({
          keyless: true,
          deadlineAtMs: nowMs() + 60_000,
          signal: null,
        });
        sent++;
        const start = nowMs();
        await new Promise((r) => setTimeout(r, Math.max(1, hold / speed)));
        held.push([start, nowMs()]);
        t.finish("ok");
      } catch {
        refused++;
      }
    }),
  );
} else {
  for (let i = 0; i < n; i++) {
    try {
      const t = await limiter.acquire({
        keyless: true,
        deadlineAtMs: nowMs() + 20_000,
        signal: null,
      });
      sent++;
      t.finish("ok");
    } catch {
      refused++;
    }
  }
}
close();
process.stdout.write(`${JSON.stringify({ sent, refused, held })}\n`);
