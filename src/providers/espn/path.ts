// path.ts — the ONE ESPN path builder (plan 02 §5; plan 01 §5.3; research 03 §A.1–§A.2): league
// routes `…/seasons/{s}/segments/0/leagues/{id}[/communication/]`, the season route and the season
// players route, each a separate builder. Views come from the whitelist by route (the do-nothing
// views are refused, so a typo can never silently return a skeleton); every value is an integer or a
// whitelisted token, so nothing is URL-encoded from free text; the read host comes from config within
// the `*.fantasy.espn.com` rule and is never the write host (plan 02 S12; ADV OBJ-06). Views are
// emitted in whitelist order, so two spellings of one request are one URL (the cache key).
import {
  ESPN_API_BASE_PATH,
  ESPN_LEAGUE_ID_RE,
  ESPN_READ_HOST_DEFAULT,
  isAllowedReadHost,
} from "../../config/schema.js";
import {
  COMMUNICATION_VIEWS,
  ESPN_FIRST_SEASON,
  ESPN_SEGMENT,
  LEAGUE_VIEWS,
  SEASON_PLAYER_VIEWS,
  SEASON_VIEWS,
  SOLO_VIEWS,
  type CommunicationView,
  type EspnView,
  type LeagueView,
  type SeasonPlayerView,
  type SeasonView,
} from "./types.js";

/** The routes the builder knows (the recording manifest's `request.route` names). */
export type EspnRoute = "league" | "communication" | "season" | "players";

/** The last season the builder accepts (a grammar bound; config bounds the real one). */
export const ESPN_LAST_SEASON = 2100;
/** `scoringPeriodId` outer bound (plan 02 §5: 0–22; kickers carry 19–22). */
export const SCORING_PERIOD_MAX = 22;

/** A built request target: everything the transport, the cache key and fixture mode need. */
export interface EspnTarget {
  readonly route: EspnRoute;
  readonly host: string;
  /** The URL path (no query). */
  readonly path: string;
  /** The query string, canonical (`view=…&view=…&scoringPeriodId=N`). */
  readonly query: string;
  /** `https://<host><path>?<query>`. */
  readonly url: string;
  /** The requested views, in whitelist order. */
  readonly views: readonly EspnView[];
  readonly season: number;
  readonly scoringPeriodId: number | null;
}

/** A refused build: carries `effCode` VALIDATION (plan 01 §4.3: builder refusals) and a fixed reason. */
export class EspnRequestError extends Error {
  readonly effCode = "VALIDATION" as const;
  readonly effDetails: { readonly reason: string };
  constructor(reason: string) {
    super(`espn request refused: ${reason}`);
    this.name = "EspnRequestError";
    this.effDetails = Object.freeze({ reason });
  }
}

/**
 * The read host to use: the configured value when it passes the override rule, else a throw — a
 * host that is not `<label>.fantasy.espn.com`, or is the write host, is never used.
 */
export function readHost(configured: string = ESPN_READ_HOST_DEFAULT): string {
  if (!isAllowedReadHost(configured)) throw new EspnRequestError("read_host_refused");
  return configured;
}

function checkSeason(season: number): void {
  if (!Number.isInteger(season) || season < ESPN_FIRST_SEASON || season > ESPN_LAST_SEASON)
    throw new EspnRequestError("season_out_of_range");
}

function checkLeagueId(leagueId: string): void {
  if (typeof leagueId !== "string" || !ESPN_LEAGUE_ID_RE.test(leagueId))
    throw new EspnRequestError("invalid_league_id");
}

function checkPeriod(sp: number | null | undefined): number | null {
  if (sp === null || sp === undefined) return null;
  if (!Number.isInteger(sp) || sp < 0 || sp > SCORING_PERIOD_MAX)
    throw new EspnRequestError("scoring_period_out_of_range");
  return sp;
}

/** Validates and orders views against one route's whitelist (duplicates collapse). */
function orderViews<V extends string>(views: readonly string[], allowed: readonly V[]): V[] {
  if (!Array.isArray(views) || views.length === 0) throw new EspnRequestError("no_views");
  for (const v of views)
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v))
      throw new EspnRequestError("view_not_whitelisted");
  return allowed.filter((v) => views.includes(v));
}

function target(
  route: EspnRoute,
  host: string,
  path: string,
  views: readonly EspnView[],
  season: number,
  sp: number | null,
): EspnTarget {
  const query = [
    ...views.map((v) => `view=${v}`),
    ...(sp === null ? [] : [`scoringPeriodId=${String(sp)}`]),
  ].join("&");
  return Object.freeze({
    route,
    host,
    path,
    query,
    url: `https://${host}${path}?${query}`,
    views: Object.freeze([...views]),
    season,
    scoringPeriodId: sp,
  });
}

/** A target's first view — the one its stamps, errors and logs name (builders guarantee ≥ 1). */
export function primaryView(t: EspnTarget): EspnView {
  const [v] = t.views;
  if (v === undefined) throw new EspnRequestError("no_views");
  return v;
}

/** The league route path prefix for a season and league id (validated). */
export function leaguePath(season: number, leagueId: string): string {
  checkSeason(season);
  checkLeagueId(leagueId);
  return `${ESPN_API_BASE_PATH}/seasons/${String(season)}/segments/${String(ESPN_SEGMENT)}/leagues/${leagueId}`;
}

/** A league-route request. `mRoster` is always requested alone (plan 01 §5.2 — the 3.2 MB bootstrap). */
export function leagueTarget(spec: {
  readonly host: string;
  readonly season: number;
  readonly leagueId: string;
  readonly views: readonly LeagueView[];
  readonly scoringPeriodId?: number | null;
}): EspnTarget {
  const host = readHost(spec.host);
  const path = leaguePath(spec.season, spec.leagueId);
  const views = orderViews(spec.views, LEAGUE_VIEWS);
  if (views.length > 1 && views.some((v) => SOLO_VIEWS.includes(v)))
    throw new EspnRequestError("solo_view_composed");
  return target("league", host, path, views, spec.season, checkPeriod(spec.scoringPeriodId));
}

/** The board route (`…/communication/`) — the credential board probe only (plan 02 §2.1). */
export function communicationTarget(spec: {
  readonly host: string;
  readonly season: number;
  readonly leagueId: string;
  readonly views?: readonly CommunicationView[];
}): EspnTarget {
  const host = readHost(spec.host);
  const path = `${leaguePath(spec.season, spec.leagueId)}/communication/`;
  const views = orderViews(spec.views ?? COMMUNICATION_VIEWS, COMMUNICATION_VIEWS);
  return target("communication", host, path, views, spec.season, null);
}

/** The keyless season route (`/seasons/{s}?view=proTeamSchedules_wl`; no league id). */
export function seasonTarget(spec: {
  readonly host: string;
  readonly season: number;
  readonly views?: readonly SeasonView[];
}): EspnTarget {
  const host = readHost(spec.host);
  checkSeason(spec.season);
  const views = orderViews(spec.views ?? SEASON_VIEWS, SEASON_VIEWS);
  return target(
    "season",
    host,
    `${ESPN_API_BASE_PATH}/seasons/${String(spec.season)}`,
    views,
    spec.season,
    null,
  );
}

/** The keyless season players route (`/seasons/{s}/players?view=players_wl`; root-level filter). */
export function seasonPlayersTarget(spec: {
  readonly host: string;
  readonly season: number;
  readonly views?: readonly SeasonPlayerView[];
}): EspnTarget {
  const host = readHost(spec.host);
  checkSeason(spec.season);
  const views = orderViews(spec.views ?? SEASON_PLAYER_VIEWS, SEASON_PLAYER_VIEWS);
  return target(
    "players",
    host,
    `${ESPN_API_BASE_PATH}/seasons/${String(spec.season)}/players`,
    views,
    spec.season,
    null,
  );
}
