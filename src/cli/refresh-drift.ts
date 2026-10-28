// refresh-drift.ts — `eff refresh espn:drift [--notify] [--json]` (plan 01 §7: drift is a fact about
// the LATEST answer of a view — src/drift/state.ts, Stage C finding drift-red-never-clears; plan 06
// §1.2 the daily probe). The probe reads two things: the keyless season route (proTeamSchedules_wl)
// and, keyless, mSettings+mNav+mTeam on a PUBLIC league — on a private league with no probe league
// configured it reads no league view at all. So a red row on any other view stayed red until a tool
// call happened to re-read that view. The final gate found mPendingTransactions red for 16 days
// (the F2 event of 2026-10-11) with every probe green meanwhile: `eff probe` and
// `eff doctor --online` exited 4, and doctor's fix ("run eff probe and read the diff") went in a
// circle. This command re-reads, once each, every view the stored drift_state row marks red,
// through the provider and limiter the jobs use (src/cli/espn-jobs.ts: the store, the
// rejected-credential gate, a job lock; read host only; the stored credential when the league needs
// it; `server` origin unless --notify) with force_refresh. The provider's in-call check judges each
// answer: a complete one clears that view's removed keys, and a key still missing stays red. A view
// no read of this build requests is named, never guessed at.
import { parseDiffs } from "../drift/index.js";
import type { Config } from "../config/schema.js";
import type { Week } from "../domain/league/types.js";
import type { ReadOptions } from "../providers/platform.js";
import type { EspnView } from "../providers/espn/types.js";
import { redViews } from "./drift-recheck.js";
import { endJob, jobFailure, jobWorked, startJob, type JobRun } from "./espn-jobs.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";

/** The job name the run is recorded under (job-state.json; doctor #11 lists it). */
export const DRIFT_REFRESH_JOB = "refresh-drift";

/** What a re-read needs: the run's provider and league, and the week to read. */
interface Reread {
  readonly run: JobRun;
  readonly week: Week;
}

const FORCE: ReadOptions = Object.freeze({ force_refresh: true });
/** One read serves two views (mSettings + mNav; mTeam + mStandings): shared, so it is made once. */
const leagueRead = (r: Reread): Promise<unknown> =>
  r.run.stack.provider.getLeague(r.run.stack.ref, FORCE);
const standingsRead = (r: Reread): Promise<unknown> =>
  r.run.stack.provider.getStandings(r.run.stack.ref, FORCE);

/** The player card of the pool's most-owned player (a card read needs a player id). */
async function playercardRead(r: Reread): Promise<unknown> {
  const { provider, ref } = r.run.stack;
  const page = await provider.listPlayers(
    ref,
    { status: "ALL", position: null, sort: "percOwned", week: r.week, injured: null },
    { limit: 1, offset: 0 },
  );
  const first = page.value.items[0];
  if (first === undefined) throw Object.assign(new Error("no player"), { effCode: "NOT_FOUND" });
  return provider.getPlayerStats(ref, [first.ref], { type: "season" }, FORCE);
}

/**
 * One read of the provider per view — the read the tools make of it, forced past the cache. A view
 * missing here is one no read of this build requests (`mScoreboard`, `mDraftDetail`; the board
 * probe's `kona_league_communication` is `eff check-auth`'s).
 */
export const DRIFT_REREADS: Readonly<Partial<Record<EspnView, (r: Reread) => Promise<unknown>>>> =
  Object.freeze({
    mSettings: leagueRead,
    mNav: leagueRead,
    mTeam: standingsRead,
    mStandings: standingsRead,
    mRoster: (r) => r.run.stack.provider.getRosters(r.run.stack.ref, r.week, FORCE),
    mMatchup: (r) => r.run.stack.provider.getMatchups(r.run.stack.ref, FORCE),
    mMatchupScore: (r) => r.run.stack.provider.getLiveMatchups(r.run.stack.ref, r.week, FORCE),
    mBoxscore: (r) => r.run.stack.provider.getBoxScores(r.run.stack.ref, r.week, FORCE),
    mTransactions2: (r) =>
      r.run.stack.provider.listTransactions(
        r.run.stack.ref,
        { types: [], week: r.week, since: null, count: 25, team_id: null },
        FORCE,
      ),
    mPendingTransactions: (r) =>
      r.run.stack.provider.listPendingTransactions(r.run.stack.ref, FORCE),
    mPositionalRatings: (r) =>
      r.run.stack.provider.getPositionalRatings(r.run.stack.ref, r.week, FORCE),
    kona_player_info: (r) =>
      r.run.stack.provider.listPlayers(
        r.run.stack.ref,
        { status: "ALL", position: null, sort: "percOwned", week: r.week, injured: null },
        { limit: 25, offset: 0 },
        FORCE,
      ),
    kona_playercard: playercardRead,
    proTeamSchedules_wl: (r) => r.run.stack.provider.getProSchedule(r.run.stack.ref.season, FORCE),
    players_wl: (r) => r.run.stack.provider.getSeasonPlayers(r.run.stack.ref.season, FORCE),
  });

/** One red view's outcome. */
export interface DriftRecheckView {
  readonly view: EspnView;
  /** `cleared`: its answer had every key; `red`: still missing (`removed`); `not_read`: see `reason`. */
  readonly outcome: "cleared" | "red" | "not_read";
  /** The keys the row still records missing for it (after the re-read). */
  readonly removed: readonly string[];
  /** Why it was not re-read or judged: `no_read` (no read of this build), or the read's error code. */
  readonly reason: string | null;
}

/** What one run did (`--json`). */
export interface DriftRefreshReport {
  readonly target: "espn:drift";
  /** drift_state's status before and after. */
  readonly before: string;
  readonly after: string;
  readonly views: readonly DriftRecheckView[];
}

/** The code of a read the provider served from its cache after ESPN failed, else null. */
const degradedCode = (got: unknown): string | null => {
  const c = (got as { stamp?: { degraded?: { code?: unknown } | null } } | null)?.stamp?.degraded
    ?.code;
  return typeof c === "string" && /^[A-Z][A-Z_]{0,39}$/.test(c) ? c : null;
};

const errorCode = (e: unknown): string => {
  const c = (e as { effCode?: unknown } | null)?.effCode;
  return typeof c === "string" && /^[A-Z][A-Z_]{0,39}$/.test(c) ? c : "INTERNAL";
};

/** `eff refresh espn:drift [--notify] [--json]`. */
export async function refreshDrift(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: { readonly notify: boolean; readonly json: boolean },
): Promise<number> {
  const job = DRIFT_REFRESH_JOB;
  const run = await startJob(io, config, log, job, { notify: opts.notify });
  if (typeof run === "number") return run;
  try {
    const row = run.store.repos.driftState.get();
    const before = row?.status ?? "green";
    const red = row === null ? [] : redViews(row.diff_json);
    if (row?.status === "host_moved") {
      await writeLine(
        io.stdout,
        "espn:drift: the read host moved — re-reading views cannot end that; run `eff doctor --online`",
      );
      return EXIT.drift;
    }
    if (red.length === 0) {
      const report: DriftRefreshReport = { target: "espn:drift", before, after: before, views: [] };
      jobWorked(io, config, job);
      await writeLine(
        io.stdout,
        opts.json ? JSON.stringify(report) : `espn:drift: no view is red (drift_state ${before})`,
      );
      return EXIT.ok;
    }
    // the week a weekly view is read for: the league's current scoring period (the tools' default);
    // a league read that fails — mSettings itself red, ESPN down — is judged with the views below
    let week = 1;
    try {
      const league = await run.stack.provider.getLeague(run.stack.ref);
      week = Math.max(1, league.value.clock.current_scoring_period);
    } catch (e) {
      const code = errorCode(e);
      if (code === "ESPN_AUTH_REJECTED" || code === "ESPN_REQUIRES_COOKIES") throw e;
    }
    const reasons = new Map<EspnView, string>();
    // each read once (mSettings and mNav are one read): its failure, if any, is every such view's
    const done = new Map<(r: Reread) => Promise<unknown>, string | null>();
    for (const view of red) {
      const read = DRIFT_REREADS[view];
      if (read === undefined) {
        reasons.set(view, "no_read");
        continue;
      }
      if (!done.has(read)) {
        let failure: string | null = null;
        try {
          // a copy served from the cache because ESPN failed was never re-judged: say why
          failure = degradedCode(await read({ run, week }));
        } catch (e) {
          // a drift error is the judgement itself (the key is still missing); anything else is not
          const code = errorCode(e);
          if (code === "ESPN_AUTH_REJECTED" || code === "ESPN_REQUIRES_COOKIES") throw e;
          if (code !== "ESPN_DRIFT_DETECTED") failure = code;
        }
        done.set(read, failure);
      }
      const failure = done.get(read) ?? null;
      if (failure !== null) reasons.set(view, failure);
    }
    const after = run.store.repos.driftState.get();
    const still = new Map(
      parseDiffs(after?.diff_json ?? "[]").map((d) => [d.view, d.removed] as const),
    );
    const views: DriftRecheckView[] = red.map((view) => {
      const removed = still.get(view) ?? [];
      const reason = reasons.get(view) ?? null;
      return {
        view,
        outcome:
          reason !== null && removed.length > 0
            ? "not_read"
            : removed.length > 0
              ? "red"
              : "cleared",
        removed,
        reason: removed.length > 0 ? reason : null,
      };
    });
    const status = after?.status ?? "green";
    const report: DriftRefreshReport = { target: "espn:drift", before, after: status, views };
    jobWorked(io, config, job);
    if (opts.json) await writeLine(io.stdout, JSON.stringify(report));
    else {
      for (const v of views)
        await writeLine(
          io.stdout,
          v.outcome === "cleared"
            ? `${v.view}: cleared — ESPN's answer has every key the server reads`
            : v.outcome === "red"
              ? `${v.view}: still red — removed ${v.removed.slice(0, 5).join(", ")}${v.removed.length > 5 ? ", …" : ""}`
              : `${v.view}: not re-read (${v.reason === "no_read" ? "no read of this build requests it" : (v.reason ?? "?")}) — removed ${v.removed.slice(0, 5).join(", ")}`,
        );
      await writeLine(io.stdout, `drift_state: ${before} → ${status}`);
    }
    return status === "red" || status === "host_moved" ? EXIT.drift : EXIT.ok;
  } catch (e) {
    return await jobFailure(io, config, run, job, e, opts.notify);
  } finally {
    endJob(io, run);
  }
}
