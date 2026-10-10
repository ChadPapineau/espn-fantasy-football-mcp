// shipped.ts — the redistribution prior table E7 uses (plan 10 §3.3, C6): the generated table
// (generated/table.ts, built from the committed 2023–2025 pbp usage excerpt by
// tests/domain/analytics/cascade-priors/make-usage-excerpt.ts), deep-frozen so no caller can change
// it. Rebuilt and compared byte for byte by tests/domain/analytics/cascade-priors/table.test.ts.
// New here.
import { CASCADE_PRIOR_TABLE_DATA } from "./generated/table.js";
import type { CascadePriorTable } from "./types.js";

function freeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

/** The shipped redistribution prior table (2023–2025 pbp absences). */
export const CASCADE_PRIORS: CascadePriorTable = freeze(CASCADE_PRIOR_TABLE_DATA);
