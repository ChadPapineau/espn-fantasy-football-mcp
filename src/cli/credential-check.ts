// credential-check.ts — the daily `credential check` job and `eff check-auth` (plan 06 §1.4 "the
// one job exempt from the `rejected` short-circuit", ≤ 1 probe/day off-season and ≤ 2/day in
// season; plan 02 §2.1 the definitive check: mSettings with cookies on a private league, the board
// probe — body discarded — on a public one, the anonymous control deciding whether it
// discriminates; plan 03 §6: a 200 flips `rejected → validated` exactly as `espn_check_auth` does;
// ADV OBJ-04: the rejection notification fires ONCE per rejection and names the next probe time;
// `espn_check_auth` ≤ 1/min — the same limit binds `eff check-auth`). Observations are recorded in
// the store.sqlite `credential_state` row, never in the credential store (plan 03 L5).
import { checkAuthAllowed, dailyProbeAllowed } from "../auth/probe.js";
import type { CredentialObserver } from "../auth/types.js";
import type { Config } from "../config/schema.js";
import type { CredentialProbeResult } from "../providers/platform.js";
import { seasonState } from "../sources/runner.js";
import type { Store, StoreFactory } from "../store/types.js";
import { buildEspnStack, effCodeOf } from "./espn-stack.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import { readJobState, stateNumber, stateToken, updateJobState } from "./job-state.js";
import type { Logger } from "./log.js";
import { createNotifier, type Notifier } from "./notify.js";
import { errorText, openStore } from "./store-access.js";

/** Local wall-clock HH:MM of an instant (the notification's time; the process's time zone). */
export function hhmm(iso: string | null): string {
  if (iso === null) return "the next scheduled check";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "the next scheduled check";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The rejection text (plan 06 §1.4, verbatim shape). */
export function rejectionText(rejectedAt: string | null, nextProbeAt: string | null): string {
  return `ESPN rejected the stored cookies at ${hhmm(rejectedAt)}; I will re-check at ${hhmm(nextProbeAt)} — if that fails too, run \`eff setup\``;
}

/**
 * Notifies a rejection ONCE (keyed by the row's `rejected_since`), after any job observed it. A
 * cleared rejection clears the key. Returns whether a notification was sent.
 */
export async function notifyRejectionOnce(
  store: Store,
  cacheDir: string,
  notifier: Notifier,
): Promise<boolean> {
  let row;
  try {
    row = store.repos.credentialState.get();
  } catch {
    return false;
  }
  const state = readJobState(cacheDir);
  const notified = stateToken(state, "alarm.credential");
  if (row?.state !== "rejected") {
    if (notified !== null) updateJobState(cacheDir, { "alarm.credential": null });
    return false;
  }
  const key = (row.rejected_since ?? row.last_rejected_at ?? "rejected").replace(
    /[^A-Za-z0-9_.:-]/g,
    "_",
  );
  if (notified === key) return false;
  await notifier.alarm(rejectionText(row.last_rejected_at, row.next_probe_at));
  updateJobState(cacheDir, { "alarm.credential": key });
  return true;
}

/** The local calendar day of an instant (`YYYY-MM-DD`, the process's time zone). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The printable verdict of a probe. */
export function verdictLine(r: CredentialProbeResult): string {
  const a = r.accepted === null ? "unknown" : r.accepted ? "accepted" : "rejected";
  const why = r.reason === null ? "" : ` (${r.reason})`;
  return `ESPN cookies: ${a}${why}; probe: ${r.probe}${r.upstream_status === null ? "" : `, HTTP ${String(r.upstream_status)}`}`;
}

/** Runs the definitive probe once through the provider (probe access: works from `rejected`). */
async function probeOnce(
  io: CliIo,
  config: Config,
  store: Store,
  log: Logger,
  observer: CredentialObserver,
): Promise<CredentialProbeResult | { readonly error: string }> {
  const stack = buildEspnStack(io, config, store, log, {
    origin: observer === "daily_job" ? "job" : "server",
    observer,
    probeObserver: observer,
  });
  try {
    return await stack.provider.probeCredential(stack.ref);
  } catch (e) {
    return { error: effCodeOf(e) };
  } finally {
    stack.close();
  }
}

function exitOf(r: CredentialProbeResult | { readonly error: string }): number {
  if ("error" in r) return r.error === "ESPN_LEAGUE_NOT_FOUND" ? EXIT.usage : EXIT.error;
  return r.accepted === false ? EXIT.credentials : EXIT.ok;
}

/** `eff credential-check` (the daily job). */
export async function credentialCheck(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: { readonly notify: boolean; readonly factory?: StoreFactory },
): Promise<number> {
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  if (config.fixtureDir !== null) {
    await writeLine(io.stdout, "credential-check: fixture mode — no credential to check");
    return EXIT.ok;
  }
  let store: Store;
  try {
    store = openStore(config, io.clock, log, {
      migrate: true,
      ...(opts.factory ? { factory: opts.factory } : {}),
    });
  } catch (e) {
    await writeLine(
      io.stderr,
      `eff credential-check: the store could not be opened: ${errorText(e)}`,
    );
    if (opts.notify) await notifier.failure("credential-check", "store");
    return EXIT.error;
  }
  try {
    const row = store.repos.credentialState.get();
    if (row?.league_id !== config.leagueId || row.state === "not_configured") {
      await writeLine(
        io.stdout,
        "credential-check: no credential stored for this league — nothing to probe (run `eff setup`)",
      );
      return EXIT.ok;
    }
    const now = io.clock.nowMs();
    const day = localDay(now);
    const state = readJobState(config.cacheDir);
    const count =
      stateToken(state, "credcheck.day") === day ? (stateNumber(state, "credcheck.count") ?? 0) : 0;
    const inSeason = seasonState(store.datasets.proSchedule, config.season, now) === "in_season";
    if (!dailyProbeAllowed(count, inSeason)) {
      await writeLine(
        io.stdout,
        `credential-check: today's probe cap is reached (${inSeason ? "2 in season" : "1 off-season"}) — nothing sent`,
      );
      return EXIT.ok;
    }
    updateJobState(config.cacheDir, { "credcheck.day": day, "credcheck.count": count + 1 });
    const wasRejected = row.state === "rejected";
    const r = await probeOnce(io, config, store, log, "daily_job");
    if ("error" in r) {
      await writeLine(
        io.stdout,
        `credential-check: the probe could not complete (${r.error}); the state is unchanged`,
      );
      if (opts.notify) await notifier.failure("credential-check", r.error);
      return exitOf(r);
    }
    await writeLine(io.stdout, `credential-check: ${verdictLine(r)}`);
    if (opts.notify) {
      if (r.accepted === false) await notifyRejectionOnce(store, config.cacheDir, notifier);
      else if (r.accepted === true && wasRejected) {
        await notifyRejectionOnce(store, config.cacheDir, notifier);
        await notifier.info("ESPN cookies accepted again — the jobs resume");
      }
    }
    return exitOf(r);
  } finally {
    store.close();
  }
}

/** `eff check-auth` (interactive; ≤ 1 probe per minute, like `espn_check_auth`). */
export async function checkAuth(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: { readonly json: boolean; readonly factory?: StoreFactory },
): Promise<number> {
  if (config.fixtureDir !== null) {
    await writeLine(io.stdout, "check-auth: fixture mode — no credential stored (accepted: null)");
    return EXIT.ok;
  }
  const now = io.clock.nowMs();
  const last = stateNumber(readJobState(config.cacheDir), "checkauth.last");
  const allowed = checkAuthAllowed(last, now);
  if (!allowed.ok) {
    await writeLine(
      io.stderr,
      `eff check-auth: at most one probe per minute — retry in ${String(Math.ceil(allowed.retryAfterMs / 1000))} s`,
    );
    return EXIT.error;
  }
  let store: Store;
  try {
    store = openStore(config, io.clock, log, {
      migrate: true,
      ...(opts.factory ? { factory: opts.factory } : {}),
    });
  } catch (e) {
    await writeLine(io.stderr, `eff check-auth: the store could not be opened: ${errorText(e)}`);
    return EXIT.error;
  }
  try {
    updateJobState(config.cacheDir, { "checkauth.last": now });
    const r = await probeOnce(io, config, store, log, "check_auth");
    if (opts.json) await writeLine(io.stdout, JSON.stringify(r));
    else if ("error" in r)
      await writeLine(io.stdout, `check-auth: the probe could not complete (${r.error})`);
    else {
      await writeLine(io.stdout, verdictLine(r));
      if (r.accepted === false)
        await writeLine(
          io.stdout,
          "→ copy the cookies again from a logged-in browser tab and run `eff setup` in a terminal",
        );
      if (r.accepted === null && r.reason === "not_configured")
        await writeLine(io.stdout, "→ run `eff setup` in a terminal");
    }
    return exitOf(r);
  } finally {
    store.close();
  }
}
