// limiter-child.ts — one "server process" for the cross-process limiter test: it opens the shared
// SQLite limiter table and makes N acquisitions through the real EspnLimiter on a shared VIRTUAL
// clock (real time × SPEED from a common base, so both processes agree on "now" and the test runs
// in well under a second per virtual minute). Prints one JSON line: sent and refused counts.
import { EspnLimiter } from "../../../../src/providers/espn/limiter.js";
import { openSqliteLimiter } from "./sqlite-limiter.js";

const [file, nArg, baseArg, realStartArg, speedArg] = process.argv.slice(2);
const n = Number(nArg);
const base = Number(baseArg);
const realStart = Number(realStartArg);
const speed = Number(speedArg);
const nowMs = (): number => base + (Date.now() - realStart) * speed;
const repo = openSqliteLimiter(String(file));
const limiter = new EspnLimiter({
  repo,
  clock: { nowMs, nowIso: () => new Date(nowMs()).toISOString() },
  origin: "server",
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(1, ms / speed))),
});
let sent = 0;
let refused = 0;
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
repo.close();
process.stdout.write(`${JSON.stringify({ sent, refused })}\n`);
