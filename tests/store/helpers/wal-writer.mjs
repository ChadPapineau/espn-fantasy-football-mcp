// wal-writer.mjs — a SECOND process writing store.sqlite with checkpoints disabled, so its committed
// rows live only in store.sqlite-wal (plan 03 L7 / T-15(b): a file copy would miss them; VACUUM INTO
// must not). Commits <n> probe_log rows, prints READY, keeps its connection open until stdin closes.
// Plain node:sqlite. Usage: node wal-writer.mjs <db path> <n>
import { DatabaseSync } from "node:sqlite";

const [file, n] = process.argv.slice(2);
const db = new DatabaseSync(file, { timeout: 5000 });
db.exec("PRAGMA wal_autocheckpoint = 0");
const ins = db.prepare(
  "INSERT INTO probe_log (at, at_ms, kind, ok, status, upstream_status, error) VALUES (?, ?, 'shape', 1, 'green', 200, NULL)",
);
db.exec("BEGIN IMMEDIATE");
for (let i = 0; i < Number(n); i++) ins.run("2026-10-06T12:00:00.000Z", 1_759_752_000_000 + i);
db.exec("COMMIT");
process.stdout.write("READY\n");
let stop = false;
process.stdin.on("end", () => {
  stop = true;
});
process.stdin.on("close", () => {
  stop = true;
});
process.stdin.resume();
const wait = () => {
  if (stop) {
    db.close();
    process.exit(0);
  }
  setTimeout(wait, 20);
};
wait();
