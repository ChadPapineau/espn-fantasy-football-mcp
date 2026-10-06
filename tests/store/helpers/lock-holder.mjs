// lock-holder.mjs — a SECOND process holding store.sqlite's writer lock (plan 05 §2 `store`
// "busy_timeout under a concurrent writer"; §4.1 "SQLite write lock held by another process"):
// BEGIN IMMEDIATE, a write, print LOCKED, block <holdMs> with Atomics.wait (the lock stays held the
// whole time), COMMIT, print RELEASED. Plain node:sqlite — it imports nothing from src/.
// Usage: node lock-holder.mjs <db path> <holdMs>
import { DatabaseSync } from "node:sqlite";

const [file, holdArg] = process.argv.slice(2);
if (file === undefined || holdArg === undefined) {
  process.stderr.write("usage: lock-holder.mjs <db> <holdMs>\n");
  process.exit(2);
}
const db = new DatabaseSync(file, { timeout: 5000 });
db.exec("BEGIN IMMEDIATE");
db.prepare(
  "INSERT INTO probe_log (at, at_ms, kind, ok, status, upstream_status, error) VALUES (?, ?, 'host', 1, 'green', 200, NULL)",
).run("2026-10-06T12:00:00.000Z", Date.parse("2026-10-06T12:00:00.000Z"));
process.stdout.write("LOCKED\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdArg));
db.exec("COMMIT");
db.close();
process.stdout.write("RELEASED\n");
