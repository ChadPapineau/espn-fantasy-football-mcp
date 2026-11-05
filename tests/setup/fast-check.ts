// fast-check.ts — every test file's fast-check setup (vitest `setupFiles`; the round-4b account: a
// property failed once under a full coverage run and its counterexample was not captured). A failing
// property already names its seed and path in fast-check's own error; this also writes them, with
// the counterexample, as one stderr line that survives a long run's truncated failure summary
// (grep `fast-check: property failed`), and lets the run be replayed exactly:
//   FC_SEED=<seed> FC_PATH=<path> npx vitest run <file> -t <test name>
// FC_SEED alone fixes every property's seed (FC_PATH replays the one named property's path). Only
// the report and the replay seed change: no property's runs, arbitraries or verdict.
import fc from "fast-check";

/** The one stderr line of a failed run (the seed, the path and the shrunk counterexample). */
export function failureLine(d: fc.RunDetails<unknown>): string | null {
  if (!d.failed) return null;
  return `fast-check: property failed — seed ${String(d.seed)}, path "${String(d.counterexamplePath)}" (replay: FC_SEED=${String(d.seed)} FC_PATH=${String(d.counterexamplePath)}); counterexample ${fc.stringify(d.counterexample)}\n`;
}

const seed = process.env.FC_SEED;
const path = process.env.FC_PATH;
fc.configureGlobal({
  ...fc.readConfigureGlobal(),
  ...(seed !== undefined && /^-?\d+$/.test(seed) ? { seed: Number(seed) } : {}),
  ...(path !== undefined && /^[\d:]+$/.test(path) ? { path } : {}),
});
fc.installGlobalPlugin(() => ({
  onAllRunsComplete: (d) => {
    const line = failureLine(d);
    if (line !== null) process.stderr.write(line);
  },
}));
