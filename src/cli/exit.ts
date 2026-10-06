// exit.ts — the `eff` exit codes shared by every subcommand (plan 03 §1.3 "Exit codes (shared with
// the CLI)": 0 clean · 1 error · 2 usage/config · 3 credentials · 4 drift · 5 forced) and the usage
// error every parser throws. Ported from sibling @5daa625, adapted (the ESPN 3/4 codes are live).
import { EXIT_CODES, type ExitCode } from "../config/schema.js";

/** Process exit codes (one copy: src/config/schema.ts EXIT_CODES). */
export const EXIT = EXIT_CODES;
export type { ExitCode };

/** A usage error: printed as one stderr line plus a pointer to `eff help`, exit 2. */
export class UsageError extends Error {
  readonly exitCode = EXIT.usage;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The worst of several exit codes (plan 03 §5: "exit code = worst finding"): the numeric maximum. */
export function worstExit(codes: readonly number[]): number {
  let worst: number = EXIT.ok;
  for (const c of codes) if (Number.isInteger(c) && c > worst) worst = c;
  return worst;
}
