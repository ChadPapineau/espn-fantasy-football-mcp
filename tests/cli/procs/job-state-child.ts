// job-state-child.ts — a child process for tests/cli/job-runs.test.ts: `argv[4]` updates of
// job-state.json in `argv[2]`, each adding one key `w.<argv[3]>.<i>` (as concurrently running
// launchd jobs each add their own keys). With the state lock no key of either writer is lost.
import { updateJobState } from "../../../src/cli/job-state.js";

const [dir, tag, n] = [
  process.argv[2] ?? "",
  process.argv[3] ?? "x",
  Number(process.argv[4] ?? "20"),
];
let ok = 0;
for (let i = 0; i < n; i++) if (updateJobState(dir, { [`w.${tag}.${String(i)}`]: i })) ok++;
process.stdout.write(`${String(ok)}\n`);
