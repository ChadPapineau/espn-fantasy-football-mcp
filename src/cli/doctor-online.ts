// doctor-online.ts — `eff doctor --online` rows #14–#19 (plan 03 §5; L5): every one a read-only GET
// under the limiter; #14 and #15 share one keyless `proTeamSchedules_wl` request (no cookie, no
// league id); #16 is the definitive credential probe (plan 02 §2.1), recorded in the store.sqlite
// `credential_state` row exactly as `espn_check_auth` does — never in the credential store — and
// never interpreted as "expired"; #17 the anonymous `mSettings` read; #18 the own-team resolution;
// #19 nflverse `timestamp.txt` reachability. Nothing here prints a value, a league id or a name.
import type { Config, LenientConfig } from "../config/schema.js";
import { createHttpClient } from "../http/client.js";
import { leagueTarget } from "../providers/espn/path.js";
import { NFLVERSE_RELEASE_BASE, NFLVERSE_TAGS } from "../sources/nflverse/release.js";
import type { Store } from "../store/types.js";
import { buildEspnStack, driftObservations, effCodeOf } from "./espn-stack.js";
import { espnRequest } from "./espn-http.js";
import type { CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { hostProbe, type ProbeCheck } from "./probe.js";
import { errorText } from "./store-access.js";
import { row, type DoctorRow } from "./doctor-rows.js";

/** Clock skew above this warns, above FAIL_SKEW_S fails (plan 03 §5 #14). */
export const WARN_SKEW_S = 60;
export const FAIL_SKEW_S = 300;

/** Row 14 from the host probe's server time. */
export function clockSkewRow(check: ProbeCheck, nowMs: number): DoctorRow {
  const title = "Clock skew (online)";
  if (check.server_time_ms === null)
    return row(
      14,
      "clock_skew",
      title,
      "warn",
      "the probe answer carried no server time",
      "re-run `eff doctor --online`",
    );
  const skew = Math.round(Math.abs(nowMs - check.server_time_ms) / 1000);
  if (skew > FAIL_SKEW_S)
    return row(
      14,
      "clock_skew",
      title,
      "fail",
      `local clock is ${String(skew)} s off ESPN's`,
      "fix the system clock (kickoff windows depend on it)",
    );
  if (skew > WARN_SKEW_S)
    return row(
      14,
      "clock_skew",
      title,
      "warn",
      `local clock is ${String(skew)} s off ESPN's`,
      "fix the system clock",
    );
  return row(14, "clock_skew", title, "ok", `within ${String(skew)} s of ESPN's clock`);
}

/** Row 15 from the host probe (plan 01 §7; ADV OBJ-06 — the override is probed, never rewritten). */
export function hostRow(check: ProbeCheck, overridden: boolean): DoctorRow {
  const title = "API host / shape probe (online)";
  const details = check.signals.slice(0, 10).map((s) => `${s.view}: ${s.kind} ${s.path}`);
  switch (check.status) {
    case "green":
      return row(
        15,
        "host_probe",
        title,
        "ok",
        `the read host answers with the expected shape${overridden ? " (EFF_ESPN_READ_HOST override)" : ""}`,
      );
    case "additive":
      return row(
        15,
        "host_probe",
        title,
        "ok",
        "additive drift only (new keys or enum values — reviewed by a human)",
        null,
        details,
      );
    case "red":
      return row(
        15,
        "host_probe",
        title,
        "drift",
        "ESPN removed or renamed a key the server reads",
        "run `eff probe` and read the diff; the manifest is re-baselined after re-recording (plan 01 §7)",
        details,
      );
    case "host_moved":
      return row(
        15,
        "host_probe",
        title,
        "drift",
        "ESPN_HOST_MOVED: the read host redirected or answered non-JSON",
        "set EFF_ESPN_READ_HOST=<label>.fantasy.espn.com if ESPN moved within fantasy.espn.com — the permanent fix is a release",
        details,
      );
    default:
      return row(
        15,
        "host_probe",
        title,
        "fail",
        `the read host is unreachable (${check.reason ?? check.status})`,
        "check the network; cached data keeps working meanwhile",
      );
  }
}

/** Runs rows #14–#19. `store` is the existing store (null → the credential rows are skipped). */
export async function onlineRows(
  io: CliIo,
  config: LenientConfig,
  store: Store | null,
  log: Logger,
): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const http = createHttpClient({
    ...(io.fetch === null ? {} : { fetch: io.fetch }),
    espnReadHost: config.espnReadHost,
    log,
  });
  const overridden = config.origins.EFF_ESPN_READ_HOST !== "default";
  if (store === null) {
    for (const [n, id, t] of [
      [14, "clock_skew", "Clock skew (online)"],
      [15, "host_probe", "API host / shape probe (online)"],
      [16, "credential_validity", "Credential validity (online)"],
      [17, "league_reachability", "League reachability (online)"],
      [18, "own_team", "Own team (online)"],
    ] as const)
      rows.push(
        row(
          n,
          id,
          t,
          "skip",
          "store.sqlite is not open (the limiter table lives there) — run `eff refresh all` first",
        ),
      );
  } else {
    const host = await hostProbe(
      {
        http,
        limiter: store.repos.limiter,
        clock: io.clock,
        host: config.espnReadHost,
        observations: driftObservations(io, log),
      },
      config.season,
    );
    rows.push(clockSkewRow(host, io.clock.nowMs()), hostRow(host, overridden));
    rows.push(...(await leagueRows(io, config, store, log)));
  }
  rows.push(await sourcesRow(io, config, log));
  return rows;
}

async function leagueRows(
  io: CliIo,
  config: LenientConfig,
  store: Store,
  log: Logger,
): Promise<DoctorRow[]> {
  if (config.leagueId === null) {
    return [
      row(
        16,
        "credential_validity",
        "Credential validity (online)",
        "skip",
        "ESPN_LEAGUE_ID is not set",
      ),
      row(
        17,
        "league_reachability",
        "League reachability (online)",
        "config",
        "ESPN_LEAGUE_ID is not set",
        "set ESPN_LEAGUE_ID (env or config.json)",
      ),
      row(18, "own_team", "Own team (online)", "skip", "ESPN_LEAGUE_ID is not set"),
    ];
  }
  const full = config as Config;
  const out: DoctorRow[] = [];
  const stack = buildEspnStack(io, full, store, log, {
    origin: "server",
    observer: "doctor",
    probeObserver: "doctor",
  });
  try {
    // #16 — the definitive check, recorded as `doctor` (plan 03 L5)
    try {
      const r = await stack.provider.probeCredential(stack.ref);
      if (r.accepted === true)
        out.push(
          row(
            16,
            "credential_validity",
            "Credential validity (online)",
            "ok",
            `accepted: true (probe: ${r.probe})`,
          ),
        );
      else if (r.accepted === false)
        out.push(
          row(
            16,
            "credential_validity",
            "Credential validity (online)",
            "credentials",
            `accepted: false (probe: ${r.probe}) — ESPN did not accept the stored cookies`,
            "copy them again from a logged-in browser tab and run `eff setup` in a terminal",
          ),
        );
      else
        out.push(
          row(
            16,
            "credential_validity",
            "Credential validity (online)",
            r.reason === "not_configured" ? "credentials" : "warn",
            `accepted: null (${r.reason ?? "unknown"})`,
            r.reason === "not_configured" ? "run `eff setup` in a terminal" : null,
          ),
        );
    } catch (e) {
      const code = effCodeOf(e);
      out.push(
        row(
          16,
          "credential_validity",
          "Credential validity (online)",
          code === "ESPN_LEAGUE_NOT_FOUND" ? "config" : "fail",
          `the probe could not complete (${code})`,
          code === "ESPN_LEAGUE_NOT_FOUND"
            ? "check ESPN_LEAGUE_ID and ESPN_SEASON"
            : "re-run later",
        ),
      );
    }
    // #17 — the anonymous mSettings read (no cookies)
    const url = leagueTarget({
      host: full.espnReadHost,
      season: full.season,
      leagueId: full.leagueId,
      views: ["mSettings"],
    }).url;
    const a = await espnRequest(
      {
        http: createHttpClient({
          ...(io.fetch === null ? {} : { fetch: io.fetch }),
          espnReadHost: full.espnReadHost,
          log,
        }),
        limiter: store.repos.limiter,
        clock: io.clock,
        origin: "server",
      },
      { url, cookie: null },
    );
    if ("error" in a)
      out.push(
        row(
          17,
          "league_reachability",
          "League reachability (online)",
          "fail",
          `no answer (${a.error})`,
          "check the network",
        ),
      );
    else if (a.status === 200)
      out.push(
        row(
          17,
          "league_reachability",
          "League reachability (online)",
          "ok",
          "200 — a public league (anonymous reads work)",
        ),
      );
    else if (a.status === 401 || a.status === 403)
      out.push(
        row(
          17,
          "league_reachability",
          "League reachability (online)",
          "ok",
          `${String(a.status)} — a private league (cookies needed; #16 says whether they are accepted)`,
        ),
      );
    else if (a.status === 404)
      out.push(
        row(
          17,
          "league_reachability",
          "League reachability (online)",
          "config",
          `404 — no such league for season ${String(full.season)}`,
          "check ESPN_LEAGUE_ID and ESPN_SEASON",
        ),
      );
    else
      out.push(
        row(
          17,
          "league_reachability",
          "League reachability (online)",
          "fail",
          `HTTP ${String(a.status)}`,
          "re-run later",
        ),
      );
    // #18 — the own team (needs cookies on a private league)
    try {
      const t = (await stack.provider.resolveOwnTeam(stack.ref)).value;
      if (t.reason === "resolved" && t.team_id !== null)
        out.push(
          row(
            18,
            "own_team",
            "Own team (online)",
            "ok",
            `the SWID owns team id ${String(t.team_id)}${full.teamId !== null && full.teamId !== t.team_id ? ` (config.json records ${String(full.teamId)} — re-run \`eff setup\`)` : ""}`,
          ),
        );
      else if (t.reason === "no_credential")
        out.push(row(18, "own_team", "Own team (online)", "skip", "no credential stored"));
      else
        out.push(
          row(
            18,
            "own_team",
            "Own team (online)",
            "warn",
            t.reason === "ambiguous"
              ? "the SWID owns several teams in this league"
              : "no team in this league lists the SWID as an owner",
            "ESPN_TEAM_ID stays unset (writes stay off)",
          ),
        );
    } catch (e) {
      out.push(
        row(18, "own_team", "Own team (online)", "warn", `could not resolve (${effCodeOf(e)})`),
      );
    }
  } finally {
    stack.close();
  }
  return out;
}

/** Row 19: nflverse release reachability (timestamp.txt only). */
async function sourcesRow(io: CliIo, config: LenientConfig, log: Logger): Promise<DoctorRow> {
  const http = createHttpClient({
    ...(io.fetch === null ? {} : { fetch: io.fetch }),
    espnReadHost: config.espnReadHost,
    log,
  });
  const details: string[] = [];
  let bad = 0;
  for (const tag of NFLVERSE_TAGS) {
    try {
      const r = await http.get(`${NFLVERSE_RELEASE_BASE}/${tag}/timestamp.txt`, {
        signal: AbortSignal.timeout(20_000),
        maxBytes: 256,
      });
      details.push(`nflverse ${tag}: HTTP ${String(r.status)}`);
      if (r.status !== 200) bad++;
    } catch (e) {
      bad++;
      details.push(`nflverse ${tag}: ${errorText(e)}`);
    }
  }
  return bad === 0
    ? row(
        19,
        "sources_online",
        "Sources (online)",
        "ok",
        "every nflverse release answers",
        null,
        details,
      )
    : row(
        19,
        "sources_online",
        "Sources (online)",
        "fail",
        `${String(bad)} release(s) unreachable`,
        "check the network; `eff refresh` keeps the previous data meanwhile",
        details,
      );
}
