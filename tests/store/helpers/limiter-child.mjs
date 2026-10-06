// limiter-child.mjs — a separate process hammering the shared limiter table through the real store
// (plan 01 §6 cross-process token bucket; plan 05 §2 `providers/espn/limiter` "two limiter instances
// sharing one SQLite file"). Run with `node --import tsx`. Loops for <durationMs> on the wall clock:
// tryRecord with a <windowMs>/<windowMax> window and a <shortMs>/<shortMax> window; a refusal sleeps
// min(retry_after_ms, 25). Prints STARTED, then {"sent":n,"refused":m} and exits.
// Usage: node --import tsx limiter-child.mjs <store> <datasets> <backups> <durationMs> <windowMs> <windowMax> <shortMs> <shortMax>
import { systemClock } from "../../../src/domain/clock.js";
import { createStoreFactory } from "../../../src/store/index.js";

const [storePath, datasetDir, backupDir, durationMs, windowMs, windowMax, shortMs, shortMax] =
  process.argv.slice(2);
const s = createStoreFactory().open({
  path: storePath,
  datasetDir,
  backupDir,
  clock: systemClock,
  migrate: true,
});
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.stdout.write("STARTED\n");
const end = Date.now() + Number(durationMs);
let sent = 0;
let refused = 0;
while (Date.now() < end) {
  const now = Date.now();
  const v = s.repos.limiter.tryRecord({
    at: iso(now),
    keyless: true,
    origin: "server",
    windows: [
      { start: iso(now - Number(windowMs)), max: Number(windowMax) },
      { start: iso(now - Number(shortMs)), max: Number(shortMax) },
    ],
    dailyCap: null,
  });
  if (v.ok) {
    sent += 1;
    s.repos.limiter.recordOutcome(v.id, "ok");
  } else {
    refused += 1;
    await sleep(Math.min(v.retry_after_ms, 25));
  }
}
process.stdout.write(`${JSON.stringify({ sent, refused })}\n`);
s.close();
