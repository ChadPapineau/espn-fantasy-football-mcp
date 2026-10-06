// scan.ts — the deny-list abort's repo-scanner half (plan 05 §3.1 step 2; research 03 §F.3 step 3):
// every scrubbed body is scanned by scripts/dev/scan-secrets.mjs — the same scanner, rules and local
// deny-list (EFF_SCAN_DENYLIST or the default file) the commit hook uses — BEFORE it is written into
// the repo. Fails closed: a scanner error is a refusal, never "clean".
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./http.js";

export interface ScanResult {
  clean: boolean;
  /** Scanner finding lines with the temp path replaced by `label` (rule ids and line numbers only). */
  findings: string[];
  /** Set when the scanner could not run or could not scan (exit 2, signal, timeout). */
  error?: string;
}

/** Scans `text` as if it were the file `label` (the label is only used in the report). */
export function scanWithRepoScanner(text: string, label: string, root = REPO_ROOT): ScanResult {
  const dir = mkdtempSync(path.join(tmpdir(), "eff-scrub-scan-"));
  const file = path.join(dir, "body.json");
  try {
    writeFileSync(file, text, { mode: 0o600 });
    const r = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "dev", "scan-secrets.mjs"), "--", file],
      {
        cwd: root,
        encoding: "utf8",
        env: process.env,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const lines = `${r.stdout}${r.stderr}`
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(file).join(label));
    if (r.status === 0) return { clean: true, findings: [] };
    if (r.status === 1)
      return { clean: false, findings: lines.filter((l) => !l.startsWith("scan-secrets:")) };
    return {
      clean: false,
      findings: lines,
      error: r.error ? r.error.message : `scanner exit ${String(r.status ?? r.signal)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
