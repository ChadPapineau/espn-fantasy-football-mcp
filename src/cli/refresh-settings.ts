// refresh-settings.ts — `eff refresh espn:settings` (plan 08 §9 "Invalidation triggers": "the settings
// TTL (24 h, plan 01 A-6); status.standingsUpdateDate / waiverLastExecutionDate moving (plan 01
// §5.2); the E6 > 10 % rule; `eff refresh espn:settings`"; plan 01 §5.2 "League settings" row). The
// owner's way to make every process see a commissioner's scoring edit now instead of within the
// settings' 24 h TTL: it marks the league-season's cached settings outdated in every process
// (FantasyPlatform.invalidateSettings — the provider's own cache bookkeeping, no request) and reads
// them again, once, through the same provider and limiter the jobs use (one mSettings read, the
// cookie when the league needs it; read host only). A changed hash is recorded, and the store raises
// `settings_changed` in the same write (plan 03 §5 #22), so the engines re-score and `onboard` can
// explain the change. Before, the target did not exist ("unknown target"), and a settings edit stayed
// unseen for up to a day (Stage C finding cache-settings-invalidation-triggers-missing). It runs as the
// snapshot jobs run (src/cli/espn-jobs.ts: the store, the rejected-credential gate, a job lock, the
// provider), typed by the owner (`server` origin: never the jobs' daily caps) unless `--notify`.
import type { Config } from "../config/schema.js";
import { endJob, jobFailure, jobWorked, startJob } from "./espn-jobs.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";

/** The job name the run is recorded under (job-state.json; doctor #11 lists it). */
export const SETTINGS_REFRESH_JOB = "refresh-settings";

/** What one run did (`--json`). */
export interface SettingsRefreshReport {
  readonly target: "espn:settings";
  /** The newest recorded settings hash before the re-read (null: none recorded yet). */
  readonly before_hash: string | null;
  readonly settings_hash: string;
  /** The re-read hash differs from the one recorded before: `settings_changed` was raised. */
  readonly changed: boolean;
}

/** `eff refresh espn:settings [--notify] [--json]`. */
export async function refreshSettings(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: { readonly notify: boolean; readonly json: boolean },
): Promise<number> {
  const job = SETTINGS_REFRESH_JOB;
  const run = await startJob(io, config, log, job, { notify: opts.notify });
  if (typeof run === "number") return run;
  try {
    const ref = run.stack.ref;
    let before: string | null = null;
    try {
      before =
        run.store.repos.leagueSettings.latest(ref.league_id, ref.season)?.settings_hash ?? null;
    } catch {
      before = null;
    }
    // every process's cached settings are outdated from now; the read below asks ESPN again
    run.stack.provider.invalidateSettings(ref);
    const got = await run.stack.provider.getScoringSettings(ref);
    const after = got.value.settings_hash;
    const changed = before !== null && before !== after;
    jobWorked(io, config, job);
    const report: SettingsRefreshReport = {
      target: "espn:settings",
      before_hash: before,
      settings_hash: after,
      changed,
    };
    if (opts.json) await writeLine(io.stdout, JSON.stringify(report));
    else
      await writeLine(
        io.stdout,
        changed
          ? `espn:settings re-read: the league's settings changed (${after.slice(0, 12)}…, was ${(before ?? "").slice(0, 12)}…) — settings_changed raised; the next analytics call re-scores (\`onboard\` explains it; \`eff doctor --ack settings_changed\` once reviewed)`
          : `espn:settings re-read: unchanged (${after.slice(0, 12)}…)${before === null ? " — recorded" : ""}`,
      );
    return EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}
