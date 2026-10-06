// espn-http.ts — the few ESPN requests the CLI sends itself, outside the provider (plan 03 §2.1
// steps 5–6: `eff setup`'s anonymous and cookie-bearing probes and the `mTeam` team resolution;
// plan 06 §1.2: `eff probe`'s keyless host and shape probes; plan 03 §5 #14 clock skew). Every one
// goes through the ONE http client (src/http: read-host allow-list, never the write host, redirects
// refused, cookie only to the read host, bounded bodies) and the cross-process limiter table (plan
// 01 §6: a request whose row cannot be written is not sent; the jobs' daily caps), and records its
// outcome for the breaker view. Bodies are parsed only where a check needs them; a board body is
// discarded unread (plan 02 §2.1).
import { HttpError, requestOutcomeOf } from "../http/errors.js";
import type { HttpClient } from "../http/client.js";
import type { Clock } from "../domain/clock.js";
import { boardProbeFilter } from "../providers/espn/filter.js";
import { limiterRequest } from "../providers/espn/limiter.js";
import { communicationTarget, leagueTarget } from "../providers/espn/path.js";
import type { SetupNetwork, TeamResolution } from "../auth/setup.js";
import type { CookieHeader } from "../auth/types.js";
import type { LimiterRepository, RequestOrigin } from "../store/types.js";
import type { RequestOutcome } from "../config/schema.js";

/** One answered request: the status, the (capped) body and the headers. */
export interface EspnAnswer {
  readonly status: number;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

/** An unanswered request: a fixed-vocabulary code (never a message). */
export interface EspnFailure {
  readonly error: string;
}

/** What the CLI's ESPN requests need. */
export interface EspnHttpDeps {
  readonly http: Pick<HttpClient, "espnGet">;
  /** The limiter table (null only where no request is ever made: setup's test mode). */
  readonly limiter: LimiterRepository | null;
  readonly clock: Clock;
  readonly origin: RequestOrigin;
  /** Waits for a full window (default: a real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The longest a CLI request waits for a full limiter window before it reports `rate_limited`. */
export const MAX_LIMITER_WAIT_MS = 5_000;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

function outcomeOfStatus(status: number): RequestOutcome {
  if (status === 304) return "not_modified";
  if (status >= 200 && status < 300) return "ok";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

/** One ESPN GET under the limiter (one attempt: the CLI never retries a probe). */
export async function espnRequest(
  deps: EspnHttpDeps,
  req: {
    readonly url: string;
    readonly cookie: CookieHeader | null;
    readonly fantasyFilter?: string;
    readonly maxBytes?: number;
  },
): Promise<EspnAnswer | EspnFailure> {
  if (deps.limiter === null) return { error: "no_limiter" };
  const keyless = req.cookie === null;
  const sleep = deps.sleep ?? realSleep;
  let id: number | null = null;
  for (let attempt = 0; attempt < 2 && id === null; attempt++) {
    let verdict;
    try {
      verdict = deps.limiter.tryRecord(limiterRequest(deps.clock.nowMs(), keyless, deps.origin));
    } catch {
      return { error: "limiter_unavailable" };
    }
    if (verdict.ok) id = verdict.id;
    else if (verdict.reason === "daily_cap") return { error: "daily_cap" };
    else if (attempt === 0 && verdict.retry_after_ms <= MAX_LIMITER_WAIT_MS)
      await sleep(verdict.retry_after_ms);
    else return { error: "rate_limited" };
  }
  if (id === null) return { error: "rate_limited" };
  const record = (o: RequestOutcome): void => {
    try {
      deps.limiter?.recordOutcome(id, o);
    } catch {
      // the row stays `pending`; the breaker view ignores pending rows
    }
  };
  try {
    const r = await deps.http.espnGet(req.url, {
      signal: AbortSignal.timeout(20_000),
      cookie: req.cookie,
      ...(req.fantasyFilter === undefined ? {} : { fantasyFilter: req.fantasyFilter }),
      ...(req.maxBytes === undefined ? {} : { maxBytes: req.maxBytes }),
    });
    record(outcomeOfStatus(r.status));
    return { status: r.status, body: r.body, headers: r.headers };
  } catch (e) {
    if (e instanceof HttpError) {
      const o = requestOutcomeOf(e);
      if (o !== null) record(o);
      if (e.kind === "redirect_refused" || e.kind === "too_many_redirects")
        return { error: "host_moved" };
      if (e.status !== null && e.kind !== "timeout")
        return { status: e.status, body: new Uint8Array(), headers: {} };
      return { error: e.kind };
    }
    record("network_error");
    return { error: "network" };
  }
}

/** Parses a JSON body (bounded by the client); null when it is not JSON. */
export function jsonBody(a: EspnAnswer): unknown {
  try {
    return JSON.parse(Buffer.from(a.body).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** The SWID grammar compared case-insensitively, braces kept. */
function sameGuid(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toUpperCase() === b.toUpperCase();
}

/**
 * The user's team from an `mTeam` body (plan 03 §2.1 step 6): every team whose `owners[]` holds
 * the SWID. Never returns or prints a name.
 */
export function teamsOwnedBy(body: unknown, swid: string): number[] {
  if (typeof body !== "object" || body === null) return [];
  const teams = (body as { teams?: unknown }).teams;
  if (!Array.isArray(teams)) return [];
  const out: number[] = [];
  for (const t of teams.slice(0, 64)) {
    if (typeof t !== "object" || t === null) continue;
    const { id, owners } = t as { id?: unknown; owners?: unknown };
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    if (Array.isArray(owners) && owners.some((o) => sameGuid(o, swid)) && !out.includes(id))
      out.push(id);
  }
  return out;
}

/** The ESPN requests `eff setup` makes (src/auth/setup.ts SetupNetwork), over `espnRequest`. */
export function createSetupNetwork(
  deps: EspnHttpDeps,
  league: { readonly host: string; readonly season: number; readonly leagueId: string },
): SetupNetwork {
  const settingsUrl = leagueTarget({ ...league, views: ["mSettings"] }).url;
  const teamUrl = leagueTarget({ ...league, views: ["mTeam"] }).url;
  const boardUrl = communicationTarget(league).url;
  const status = async (
    url: string,
    cookie: CookieHeader | null,
    filter?: string,
  ): Promise<{ status: number } | { error: string }> => {
    const r = await espnRequest(deps, {
      url,
      cookie,
      ...(filter === undefined ? {} : { fantasyFilter: filter }),
    });
    return "error" in r ? { error: r.error } : { status: r.status };
  };
  return {
    anonymousSettings: () => status(settingsUrl, null),
    anonymousBoard: () => status(boardUrl, null, boardProbeFilter()),
    settingsWithCookies: (header) => status(settingsUrl, header),
    boardWithCookies: (header) => status(boardUrl, header, boardProbeFilter()),
    resolveTeam: async (header, swid): Promise<TeamResolution> => {
      const r = await espnRequest(deps, { url: teamUrl, cookie: header });
      if ("error" in r) return { kind: "error", code: r.error };
      if (r.status !== 200) return { kind: "error", code: `http_${String(r.status)}` };
      const ids = teamsOwnedBy(jsonBody(r), swid);
      if (ids.length === 1 && ids[0] !== undefined) return { kind: "one", teamId: ids[0] };
      return ids.length === 0 ? { kind: "none" } : { kind: "many", count: ids.length };
    },
  };
}
