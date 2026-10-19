// smoke.ts — `eff smoke [--week N] [--json]`, the LIVE smoke against the configured league (plan 05
// §1 "Live smoke … never in CI", §5: "with real cookies it reads settings, one roster, one pool page,
// scores one completed week against appliedTotal per stat, and runs the probe diff"; plan 06 §1.5
// the manual row and the pre-release checklist's go/no-go; plan 08 §6 step 2; plan 10 A1b: the last
// final week scored with `match: true` for every rostered player-week per stat). Run by the owner,
// never by CI or launchd. Every request goes through the ONE provider (read host only, the limiter
// as an interactive `server` origin, the cookie only to the read host) and the keyless probes;
// nothing is written but the cache and limiter rows any read writes. Output is counts and fixed
// codes only — never a team, member or player name, never an id beyond week numbers. Exit: 0 every
// check passed (or was skipped for a stated reason); 1 a failed check; 3 credentials not configured
// or rejected (no cookies stored for a private league, or ESPN refusing them); 4 drift or a moved
// host (plan 03 §1.3).
import type { Config } from "../config/schema.js";
import type { StoreFactory } from "../store/types.js";
import { buildEspnStack, driftObservations, effCodeOf } from "./espn-stack.js";
import { EXIT } from "./exit.js";
import { createHttpClient } from "../http/client.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { hostProbe, shapeProbe, worstStatus, type ProbeCheck } from "./probe.js";
import { goldenCounts } from "./snapshot.js";
import { errorText, openStore } from "./store-access.js";

/** One smoke check's verdict (fixed vocabulary; counts only in `detail`). */
export interface SmokeCheck {
  readonly check: "settings" | "roster" | "pool" | "golden" | "probe";
  readonly status: "ok" | "fail" | "skip";
  readonly detail: string;
  /** The plan 01 §4.3 code of a failed read, when there is one. */
  readonly code: string | null;
}

/** The pool page size the smoke reads (one page). */
export const SMOKE_POOL_LIMIT = 50;

/** Options of `eff smoke`. */
export interface SmokeOptions {
  readonly json: boolean;
  readonly week: string | undefined;
  readonly factory?: StoreFactory;
}

/** The read codes that mean "credentials not configured or rejected" (plan 03 §1.3 exit 3). */
export const SMOKE_CREDENTIAL_CODES: readonly string[] = Object.freeze([
  // ESPN refused the stored cookies
  "ESPN_AUTH_REJECTED",
  // none is stored and the league needs them (Stage C finding cli-smoke-exit-not-configured: this
  // was exit 1, "a failed check" — check-auth and doctor #6 already say 3)
  "ESPN_REQUIRES_COOKIES",
]);

/** The exit code of a smoke run (plan 03 §1.3). */
export function smokeExit(checks: readonly SmokeCheck[], probe: readonly ProbeCheck[]): number {
  if (checks.some((c) => c.code !== null && SMOKE_CREDENTIAL_CODES.includes(c.code)))
    return EXIT.credentials;
  const p = probe.length === 0 ? "green" : worstStatus(probe);
  if (p === "red" || p === "host_moved") return EXIT.drift;
  return checks.some((c) => c.status === "fail") ? EXIT.error : EXIT.ok;
}

/** `eff smoke`. */
export async function smoke(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: SmokeOptions,
): Promise<number> {
  let week: number | null = null;
  if (opts.week !== undefined) {
    if (!/^\d{1,2}$/.test(opts.week) || Number(opts.week) < 1 || Number(opts.week) > 25) {
      await writeLine(io.stderr, "eff smoke: --week takes a scoring period from 1 to 25");
      return EXIT.usage;
    }
    week = Number(opts.week);
  }
  let store;
  try {
    store = openStore(config, io.clock, log, {
      migrate: true,
      ...(opts.factory ? { factory: opts.factory } : {}),
    });
  } catch (e) {
    await writeLine(io.stderr, `eff smoke: the store could not be opened: ${errorText(e)}`);
    return EXIT.error;
  }
  const stack = buildEspnStack(io, config, store, log, { origin: "server", observer: "server" });
  const checks: SmokeCheck[] = [];
  const failed = (check: SmokeCheck["check"], e: unknown): SmokeCheck => {
    const code = effCodeOf(e);
    return { check, status: "fail", detail: `the read failed (${code})`, code };
  };
  let probe: ProbeCheck[] = [];
  try {
    const ref = stack.ref;
    // 1. settings
    let current: number | null = null;
    let settings = null;
    try {
      const league = (await stack.provider.getLeague(ref)).value;
      settings = (await stack.provider.getScoringSettings(ref)).value;
      current = league.clock.current_scoring_period;
      checks.push({
        check: "settings",
        status: "ok",
        detail: `${String(league.size)} teams, scoring period ${String(current)}, ${String(settings.rules.length)} scoring rule(s)`,
        code: null,
      });
    } catch (e) {
      checks.push(failed("settings", e));
    }
    // 2. one roster (the user's team when it is known, else the league's first)
    if (current !== null) {
      try {
        const rosters = (await stack.provider.getRosters(ref, current)).value;
        const mine =
          rosters.find((r) => r.is_mine) ??
          rosters.find((r) => config.teamId !== null && r.team.team_id === config.teamId) ??
          rosters[0];
        checks.push(
          mine === undefined
            ? { check: "roster", status: "fail", detail: "no roster in the league", code: null }
            : {
                check: "roster",
                status: "ok",
                detail: `${String(mine.entries.length)} rostered player(s) on ${mine.is_mine || mine.team.team_id === config.teamId ? "your team" : "a league team (ESPN_TEAM_ID not recorded)"}; ${String(rosters.length)} roster(s) read`,
                code: null,
              },
        );
      } catch (e) {
        checks.push(failed("roster", e));
      }
      // 3. one pool page
      try {
        const page = await stack.provider.listPlayers(
          ref,
          { status: "AVAILABLE", position: null, sort: "percOwned", week: current, injured: null },
          { limit: SMOKE_POOL_LIMIT, offset: 0 },
        );
        checks.push({
          check: "pool",
          status: page.value.items.length > 0 ? "ok" : "fail",
          detail: `${String(page.value.items.length)} available player(s) on the first page`,
          code: null,
        });
      } catch (e) {
        checks.push(failed("pool", e));
      }
    } else {
      checks.push({ check: "roster", status: "skip", detail: "settings unread", code: null });
      checks.push({ check: "pool", status: "skip", detail: "settings unread", code: null });
    }
    // 4. the golden check on one completed week, per stat (plan 08 §6 step 2; A1b)
    const finalWeek = week ?? (current === null ? null : current - 1);
    if (settings === null || finalWeek === null)
      checks.push({ check: "golden", status: "skip", detail: "settings unread", code: null });
    else if (finalWeek < 1)
      checks.push({
        check: "golden",
        status: "skip",
        detail: "no completed week yet (the season has not played one)",
        code: null,
      });
    else {
      try {
        const boxes = (await stack.provider.getBoxScores(ref, finalWeek)).value;
        const g = goldenCounts(boxes, settings);
        checks.push(
          g.checked === 0
            ? {
                check: "golden",
                status: "fail",
                detail: `week ${String(finalWeek)}: no player-week with ESPN's applied points to check`,
                code: null,
              }
            : {
                check: "golden",
                status: g.mismatched === 0 ? "ok" : "fail",
                detail: `week ${String(finalWeek)}: ${String(g.checked - g.mismatched)}/${String(g.checked)} player-week(s) match ESPN per stat and in total`,
                code: null,
              },
        );
      } catch (e) {
        checks.push(failed("golden", e));
      }
    }
    // 5. the probe diff (keyless; recorded nowhere — `eff probe` is the drift job)
    if (config.fixtureDir !== null)
      checks.push({
        check: "probe",
        status: "skip",
        detail: "fixture mode makes no network call",
        code: null,
      });
    else {
      const deps = {
        http: createHttpClient({
          ...(io.fetch === null ? {} : { fetch: io.fetch }),
          espnReadHost: config.espnReadHost,
          log,
        }),
        limiter: store.repos.limiter,
        clock: io.clock,
        host: config.espnReadHost,
        observations: driftObservations(io, log),
        origin: "server" as const,
      };
      probe = [await hostProbe(deps, config.season)];
      const league = config.probeLeagueId ?? config.leagueId;
      probe.push(await shapeProbe(deps, config.season, league, config.probeLeagueId !== null));
      const worst = worstStatus(probe);
      checks.push({
        check: "probe",
        status: worst === "green" || worst === "additive" ? "ok" : "fail",
        detail: probe
          .map((c) => `${c.name} ${c.status}${c.reason === null ? "" : ` (${c.reason})`}`)
          .join("; "),
        code: null,
      });
    }
  } finally {
    stack.close();
    store.close();
  }
  const code = smokeExit(checks, probe);
  if (opts.json)
    await writeLine(
      io.stdout,
      JSON.stringify({ smoke: "espn-live", at: io.clock.nowIso(), exit_code: code, checks }),
    );
  else {
    for (const c of checks)
      await writeLine(io.stdout, `${c.check.padEnd(9)} ${c.status.padEnd(5)} ${c.detail}`);
    await writeLine(
      io.stdout,
      code === EXIT.ok ? "smoke: passed" : `smoke: FAILED (exit ${String(code)})`,
    );
  }
  return code;
}
