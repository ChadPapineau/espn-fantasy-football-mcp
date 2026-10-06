// credential-child.mjs — a separate process applying <n> read-modify-write transitions to the shared
// credential_state row through the real store (plan 02 §2.1 "recorded by whichever process makes the
// observation"; M2: transitions serialise). Each transition advances `next_probe_at` by 1 ms, so a
// lost update anywhere shows as a total below the sum of both processes' counts. Run with tsx.
// Usage: node --import tsx credential-child.mjs <store> <datasets> <backups> <n>
import { systemClock } from "../../../src/domain/clock.js";
import { createStoreFactory } from "../../../src/store/index.js";

const [storePath, datasetDir, backupDir, n] = process.argv.slice(2);
const s = createStoreFactory().open({
  path: storePath,
  datasetDir,
  backupDir,
  clock: systemClock,
  migrate: true,
});
process.stdout.write("STARTED\n");
for (let i = 0; i < Number(n); i++) {
  s.repos.credentialState.transition((row) => {
    if (row === null) throw new Error("no row");
    const next = Date.parse(row.next_probe_at ?? "2026-10-06T00:00:00.000Z") + 1;
    return {
      ...row,
      next_probe_at: new Date(next).toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: "daily_job",
    };
  });
  if (i % 10 === 0) await new Promise((r) => setImmediate(r));
}
process.stdout.write("DONE\n");
s.close();
