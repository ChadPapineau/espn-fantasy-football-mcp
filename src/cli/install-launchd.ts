// install-launchd.ts — `eff install-launchd [--jobs a,b] [--dry-run]` and `eff uninstall-launchd
// [--dry-run]` (plan 06 J1, §2; plan 03 L4): one LaunchAgent plist per job with absolute paths,
// installed with `launchctl bootstrap gui/<uid>` after a `bootout` (re-running replaces a loaded
// job); refused when `dist/cli.js` sits under a file-provider directory (plan 06 §2 "Runtime
// location"). `--dry-run` prints the plists and the launchctl commands and changes nothing — on any
// platform. Jobs whose sources this build does not ship are listed, never installed.
// Ported from sibling @5daa625, adapted.
import { existsSync } from "node:fs";
import type { LenientConfig } from "../config/schema.js";
import { EXIT, UsageError } from "./exit.js";
import { distEntry, write, writeLine, type CliIo } from "./io.js";
import {
  installJobs,
  jobEnv,
  JOBS,
  LAUNCHCTL,
  labelOf,
  launchctl,
  plistPath,
  removeJobs,
  renderPlist,
  selectJobs,
  type LaunchdJob,
} from "./launchd.js";
import { runtimeLocationProblems } from "./print-config.js";
import { availableRefreshJobs, type SourceRegistry } from "./refresh.js";

/** The jobs this build can run (a refresh job whose sources are not shipped is not). */
export function availableJobs(registry?: SourceRegistry): LaunchdJob[] {
  const refreshable = availableRefreshJobs(registry);
  return JOBS.filter((j) => j.refreshJob === null || refreshable.includes(j.refreshJob));
}

/** The jobs to install: `--jobs`, else every available job. */
export function jobsFor(spec: string | undefined, registry?: SourceRegistry): LaunchdJob[] {
  const available = availableJobs(registry);
  try {
    return selectJobs(spec, available);
  } catch (e) {
    throw new UsageError(
      `--jobs: ${(e as Error).message}; available: ${available.map((j) => j.name).join(", ")}`,
    );
  }
}

/** `eff install-launchd`. */
export async function installLaunchd(
  io: CliIo,
  config: LenientConfig,
  opts: {
    readonly jobs: string | undefined;
    readonly dryRun: boolean;
    readonly registry?: SourceRegistry;
  },
): Promise<number> {
  const jobs = jobsFor(opts.jobs, opts.registry);
  const entry = distEntry(io.packageRoot);
  const env = jobEnv(config);
  const unavailable = JOBS.filter((j) => !availableJobs(opts.registry).includes(j));
  if (opts.dryRun) {
    if (!existsSync(entry))
      await writeLine(
        io.stderr,
        `eff install-launchd: warning: ${entry} does not exist yet — run \`npm run build\` before installing`,
      );
    const uid = io.uid ?? 501;
    for (const job of jobs) {
      const file = plistPath(io.home, job);
      await writeLine(io.stdout, `# ${file} — ${job.description}`);
      await write(io.stdout, renderPlist({ job, node: io.execPath, entry, env, home: io.home }));
      await writeLine(
        io.stdout,
        `# would run: ${LAUNCHCTL} ${launchctl.bootout(uid, labelOf(job)).join(" ")}`,
      );
      await writeLine(
        io.stdout,
        `# would run: ${LAUNCHCTL} ${launchctl.bootstrap(uid, file).join(" ")}`,
      );
      await writeLine(io.stdout, "");
    }
    if (unavailable.length > 0)
      await writeLine(
        io.stderr,
        `eff install-launchd: not available in this build (not installed): ${unavailable.map((j) => j.name).join(", ")}`,
      );
    await writeLine(
      io.stderr,
      `eff install-launchd: dry run — ${String(jobs.length)} job(s), nothing written`,
    );
    return EXIT.ok;
  }
  if (io.platform !== "darwin") {
    await writeLine(
      io.stderr,
      "eff install-launchd: launchd is macOS-only (use --dry-run to see the plists, or schedule the `eff` jobs with your platform's scheduler)",
    );
    return EXIT.usage;
  }
  if (io.uid === null) {
    await writeLine(io.stderr, "eff install-launchd: no user id available");
    return EXIT.error;
  }
  if (!existsSync(entry)) {
    await writeLine(
      io.stderr,
      `eff install-launchd: ${entry} does not exist — run \`npm run build\` first`,
    );
    return EXIT.error;
  }
  const where = runtimeLocationProblems(io, entry);
  if (where.length > 0) {
    await writeLine(
      io.stderr,
      "eff install-launchd: refused — the runtime install is under a file-provider (iCloud) or synced directory:",
    );
    for (const p of where) await writeLine(io.stderr, `  ${p}`);
    await writeLine(
      io.stderr,
      "  install from a clone outside it, or `npm install -g` from the release tarball.",
    );
    return EXIT.error;
  }
  const steps = await installJobs({
    jobs,
    home: io.home,
    node: io.execPath,
    entry,
    env,
    uid: io.uid,
    exec: io.exec,
  });
  let failed = 0;
  for (const s of steps) {
    if (!s.ok) failed++;
    await writeLine(
      io.stdout,
      `${s.ok ? "ok  " : "FAIL"} ${s.kind} ${s.detail}${s.ok ? "" : ` (launchctl exit ${String(s.code ?? "killed")})`}`,
    );
  }
  if (unavailable.length > 0)
    await writeLine(
      io.stdout,
      `not available in this build (not installed): ${unavailable.map((j) => j.name).join(", ")}`,
    );
  await writeLine(
    io.stdout,
    failed === 0
      ? `installed ${String(jobs.length)} job(s); \`eff doctor\` verifies they are loaded`
      : `${String(failed)} job(s) failed to load`,
  );
  return failed === 0 ? EXIT.ok : EXIT.error;
}

/** `eff uninstall-launchd`: boots out and removes every plist of ours (plan 03 §8 step 1). */
export async function uninstallLaunchd(
  io: CliIo,
  opts: { readonly dryRun: boolean },
): Promise<number> {
  if (io.platform !== "darwin" || io.uid === null) {
    await writeLine(io.stdout, "launchd: not available on this platform — nothing to boot out");
    return EXIT.ok;
  }
  const steps = await removeJobs({
    home: io.home,
    uid: io.uid,
    exec: io.exec,
    dryRun: opts.dryRun,
  });
  const prefix = opts.dryRun ? "would " : "";
  for (const s of steps)
    await writeLine(
      io.stdout,
      `${prefix}${s.kind === "remove" ? "remove" : "launchctl"} ${s.detail}${s.ok ? "" : " (not removed)"}`,
    );
  if (steps.length === 0) await writeLine(io.stdout, "no launchd jobs of ours are installed");
  return steps.every((s) => s.ok) ? EXIT.ok : EXIT.error;
}
