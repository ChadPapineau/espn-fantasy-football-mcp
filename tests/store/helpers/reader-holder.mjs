// reader-holder.mjs — a SECOND process holding an open READ transaction on store.sqlite (what the
// weekly VACUUM INTO backup, doctor's quick_check, `eff status` or a job's read hold): BEGIN, one
// SELECT (the WAL read mark is taken), print READING, block <holdMs> with Atomics.wait (the snapshot
// stays open the whole time), COMMIT, print RELEASED. Plain node:sqlite — it imports nothing from
// src/. Usage: node reader-holder.mjs <db path> <holdMs>
import { DatabaseSync } from "node:sqlite";

const [file, holdArg] = process.argv.slice(2);
if (file === undefined || holdArg === undefined) {
  process.stderr.write("usage: reader-holder.mjs <db> <holdMs>\n");
  process.exit(2);
}
const db = new DatabaseSync(file, { timeout: 5000 });
db.exec("BEGIN");
db.prepare("SELECT COUNT(*) AS n FROM schema_version").get();
process.stdout.write("READING\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdArg));
db.exec("COMMIT");
db.close();
process.stdout.write("RELEASED\n");
