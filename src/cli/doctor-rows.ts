// doctor-rows.ts — the `eff doctor` row shape and the exit-code rule (plan 03 §5: "`--json` for
// scripts"; "Exit code = worst finding (0 ok, 1 fail, 2 config, 3 credentials, 4 drift)" — the
// numeric maximum of the findings). A row's message never carries a secret, a credential length or
// fingerprint, a league id, or a team or member name.
import { EXIT } from "./exit.js";

/** A row's verdict. `na` = not applicable here; `skip` = not run (offline, missing input). */
export type RowStatus = "ok" | "warn" | "fail" | "config" | "credentials" | "drift" | "na" | "skip";

/** One doctor row (the `--json` shape; stable). */
export interface DoctorRow {
  /** The plan 03 §5 row number (0 = the configuration itself). */
  readonly n: number;
  readonly id: string;
  readonly title: string;
  readonly status: RowStatus;
  /** One line. */
  readonly message: string;
  /** What to do, when not ok. */
  readonly fix: string | null;
  readonly details: readonly string[];
}

/** Builds a row. */
export function row(
  n: number,
  id: string,
  title: string,
  status: RowStatus,
  message: string,
  fix: string | null = null,
  details: readonly string[] = [],
): DoctorRow {
  return { n, id, title, status, message, fix, details };
}

/** The exit code a status contributes. */
export function exitOfStatus(s: RowStatus): number {
  switch (s) {
    case "fail":
      return EXIT.error;
    case "config":
      return EXIT.usage;
    case "credentials":
      return EXIT.credentials;
    case "drift":
      return EXIT.drift;
    default:
      return EXIT.ok;
  }
}

/** The exit code of a report: the worst (numerically largest) finding. */
export function exitCodeFor(rows: readonly DoctorRow[]): number {
  return rows.reduce<number>((w, r) => Math.max(w, exitOfStatus(r.status)), EXIT.ok);
}
