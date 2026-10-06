// limiter-child.mjs — a separate process hammering the shared limiter table through the real store
// (plan 01 §6 cross-process token bucket; plan 05 §2 `providers/espn/limiter` "two limiter instances
// sharing one SQLite file"). Run with `node --import tsx`. Prints STARTED once the store is open,
// then waits for a `GO` line on stdin (the start barrier: every process starts contending at the
// same moment, whatever its own startup took). Then it loops until it has sent <quota> requests or
// <deadlineMs> has passed on the wall clock (the safety net; a correct limiter reaches the quota
// long before it): tryRecord with a <windowMs>/<windowMax> window and a <shortMs>/<shortMax>
// window; a refusal sleeps min(retry_after_ms, 25). Prints {"sent":n,"refused":m} and exits.
// Usage: node --import tsx limiter-child.mjs <store> <datasets> <backups> <deadlineMs> <windowMs> <windowMax> <shortMs> <shortMax> <quota>
import { systemClock } from "../../../src/domain/clock.js";
import { createStoreFactory } from "../../../src/store/index.js";

const [
  storePath,
  datasetDir,
  backupDir,
  deadlineMs,
  windowMs,
  windowMax,
  shortMs,
  shortMax,
  quota,
] = process.argv.slice(2);
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
await new Promise((resolve, reject) => {
  let buf = "";
  let go = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    if (!go && buf.split("\n").some((l) => l.trim() === "GO")) {
      go = true;
      resolve(undefined);
    }
  });
  process.stdin.on("end", () => {
    if (!go) reject(new Error("stdin closed before GO"));
  });
});
const end = Date.now() + Number(deadlineMs);
const want = Number(quota);
let sent = 0;
let refused = 0;
while (sent < want && Date.now() < end) {
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
