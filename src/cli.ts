#!/usr/bin/env node
// cli.ts — the `eff` process entry (plan 01 §11; plan 03 §1.1–§1.3): hands argv, the real process
// io and the process's interrupt policy to src/cli/main.ts and exits with its code once output is
// flushed. SIGINT/SIGTERM keep Node's default (the process ends by the signal) except inside a
// scope that claims them, where the first one stops that scope cleanly: a running refresh, the
// setup page (src/cli/interrupt.ts; Stage C finding cli-first-signal-swallowed). `serve` claims
// nothing and installs its own shutdown handlers (plan 03 §1.3). Excluded from coverage (plan 05
// §7: arg dispatch); the logic is in src/cli/. Ported from sibling @5daa625, adapted.
import { createInterrupts, processSignalHost } from "./cli/interrupt.js";
import { defaultIo } from "./cli/io.js";
import { main } from "./cli/main.js";

const code = await main(process.argv.slice(2), defaultIo(), {
  interrupts: createInterrupts(processSignalHost()),
});
// `serve` decides its own exit (it resolves once its close sequence has run)
process.exit(code);
