// selftest-agent.ts — the launchd plumbing of `eff setup`'s keychain self-test (plan 03 §2.1 step
// 4; plan 02 §2.2 "One store per install"; plan 06 §2; ADV OBJ-05, OBJ-25): a ONE-SHOT LaunchAgent
// (a private plist in a 0700 temp dir, RunAtLoad, booted out afterwards) runs `eff selftest-read`,
// which reads the throwaway `<service>-selftest` item through the same addon and writes a 0600
// report holding a DIGEST of what it read — never the value. The setup side polls the report until
// the self-test's 10 s bound aborts it. Anything but a matching digest makes setup choose the file
// store for the whole install (src/auth/selftest.ts decides; this file only carries the read).
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  runKeychainSelftest,
  selftestReadOnce,
  type KeychainSelftestResult,
  type LaunchdReader,
  type SelftestReadReport,
} from "../auth/selftest.js";
import { SELFTEST_ACCOUNT } from "../auth/keychain.js";
import {
  ensureSecureDir,
  readSecureFile,
  resolveAbsolute,
  runTempDir,
  writeSecureFileAtomic,
} from "../config/paths.js";
import { EXIT, UsageError } from "./exit.js";
import { distEntry, writeLine, type CliIo } from "./io.js";
import { LABEL_PREFIX, LAUNCHCTL, launchctl, xmlEscape } from "./launchd.js";
import { existsSync } from "node:fs";

/** How often the setup side looks for the agent's report. */
export const REPORT_POLL_MS = 200;
/** The report file name inside the private temp dir. */
export const REPORT_FILE = "report.json";

const REPORT_CODE_RE = /^[a-z0-9_.-]{1,40}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** Parses the agent's report (anything malformed is an error report, never a pass). */
export function parseReport(text: string): SelftestReadReport {
  let v: unknown;
  try {
    v = JSON.parse(text) as unknown;
  } catch {
    return { status: "error", code: "bad_report" };
  }
  if (typeof v !== "object" || v === null) return { status: "error", code: "bad_report" };
  const r = v as { status?: unknown; digest?: unknown; code?: unknown };
  if (r.status === "read" && typeof r.digest === "string" && DIGEST_RE.test(r.digest))
    return { status: "read", digest: r.digest };
  if (r.status === "missing") return { status: "missing" };
  if (r.status === "error" && typeof r.code === "string" && REPORT_CODE_RE.test(r.code))
    return { status: "error", code: r.code };
  return { status: "error", code: "bad_report" };
}

/** The one-shot agent's plist (RunAtLoad, no KeepAlive; output discarded). */
export function selftestPlist(opts: {
  readonly label: string;
  readonly node: string;
  readonly entry: string;
  readonly service: string;
  readonly report: string;
}): string {
  for (const p of [opts.node, opts.entry, opts.report])
    if (!path.isAbsolute(p)) throw new RangeError("selftest plist: paths must be absolute");
  const args = [
    opts.node,
    opts.entry,
    "selftest-read",
    "--service",
    opts.service,
    "--report",
    opts.report,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(opts.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((a) => `    <string>${xmlEscape(a)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    "  <string>/dev/null</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>/dev/null</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The setup side: bootstraps the one-shot agent and polls its report until `signal` aborts. */
export function createLaunchdReader(io: CliIo, cacheDir: string): LaunchdReader {
  return async (target, signal) => {
    if (io.platform !== "darwin") return { status: "error", code: "unsupported_platform" };
    if (io.uid === null) return { status: "error", code: "no_uid" };
    const entry = distEntry(io.packageRoot);
    if (!existsSync(entry)) return { status: "error", code: "not_built" };
    const uid = io.uid;
    const base = runTempDir(cacheDir);
    ensureSecureDir(base, { create: true, what: "run temp directory" });
    const dir = mkdtempSync(path.join(base, "selftest-"));
    const label = `${LABEL_PREFIX}.selftest.${randomBytes(4).toString("hex")}`;
    const report = path.join(dir, REPORT_FILE);
    const plist = path.join(dir, `${label}.plist`);
    let booted = false;
    try {
      writeFileSync(
        plist,
        selftestPlist({ label, node: io.execPath, entry, service: target.service, report }),
        { mode: 0o600, flag: "wx" },
      );
      const r = await io.exec(LAUNCHCTL, launchctl.bootstrap(uid, plist));
      if (r.code !== 0) return { status: "error", code: "bootstrap_failed" };
      booted = true;
      while (!signal.aborted) {
        const text = readReport(report);
        if (text !== null) return parseReport(text);
        await new Promise((resolve) => setTimeout(resolve, REPORT_POLL_MS));
      }
      return { status: "error", code: "timeout" };
    } finally {
      if (booted) await io.exec(LAUNCHCTL, launchctl.bootout(uid, label));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function readReport(file: string): string | null {
  try {
    return readSecureFile(file, { requirePrivate: true, maxBytes: 4096, what: "selftest report" });
  } catch {
    return null;
  }
}

/** `eff setup`'s self-test runner for a service (the keyring loaded through the io). */
export function createSelftestRunner(
  io: CliIo,
  cacheDir: string,
): (service: string) => Promise<KeychainSelftestResult> {
  return async (service) => {
    const at = io.clock.nowIso();
    let keyring;
    try {
      keyring = await io.loadKeyring();
    } catch {
      return { outcome: "error", reason: "write_failed", code: null, at, cleanup: "deleted" };
    }
    return runKeychainSelftest({
      service,
      keyring,
      readUnderLaunchd: createLaunchdReader(io, cacheDir),
      now: () => io.clock.nowIso(),
    });
  };
}

/**
 * `eff selftest-read --service <s>-selftest --report <abs path>` — the agent side (internal; run
 * only by the one-shot LaunchAgent). Reads the throwaway item, writes the digest report 0600.
 */
export async function selftestRead(
  io: CliIo,
  opts: { readonly service: string | undefined; readonly report: string | undefined },
): Promise<number> {
  if (opts.service === undefined || opts.report === undefined)
    throw new UsageError("selftest-read needs --service and --report");
  let report: string;
  try {
    report = resolveAbsolute(opts.report, io.home, "--report");
  } catch {
    throw new UsageError("selftest-read: --report must be an absolute path");
  }
  ensureSecureDir(path.dirname(report), { create: false, what: "selftest report directory" });
  let result: SelftestReadReport;
  try {
    const keyring = await io.loadKeyring();
    result = await selftestReadOnce(
      keyring,
      { service: opts.service, account: SELFTEST_ACCOUNT },
      AbortSignal.timeout(10_000),
    );
  } catch {
    result = { status: "error", code: "unavailable" };
  }
  writeSecureFileAtomic(report, JSON.stringify(result), "selftest report");
  await writeLine(io.stdout, `selftest-read: ${result.status}`);
  return EXIT.ok;
}
