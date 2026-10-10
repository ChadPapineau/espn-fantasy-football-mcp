// schedules.ts — `nflverse:schedules` (plan 01 §5.2 schedules + lines rows; research 04 §B.1.6: the
// `espn` column is the ESPN game id, 272/272): `schedules/games.parquet` (ONE file, every season since
// 1999) → `ds_schedules` for the run's seasons + the checked-in `ds_venues` reference, in one dataset
// file so the reader joins them without crossing files. Kickoff: Eastern wall time → UTC instant
// (derive.ts, DST-aware); roof "" → NULL; lines: spread_line + = HOME favoured (nflverse dictionary),
// implied team totals home = (total + spread) / 2, away = (total − spread) / 2. Ported from sibling
// @521f9f3, adapted (ESPN game id, venue cross-check against the ESPN-driven weather path).
// Phase 3 (plan 10 §3.3 "≥ 3 historical seasons", D9), additive: the file always holds the backtest
// seasons [current − 3, current − 1] besides the run's own (seasons.ts `withBacktestContext`) — the
// held-out backtests read their games and lines here, and a publish rewrites the whole file.
import type { GameLines } from "../../domain/analytics/types.js";
import {
  impliedPoints,
  kickoffUtcFromEastern,
  normalizeRoof,
} from "../../store/datasets/derive.js";
import { DS_SCHEDULES, DS_VENUES } from "../../store/datasets/tables.js";
import type { DataSource, ReleaseVersion, SourceContext, TempFile } from "../source.js";
import { resolveVenueId, venueForGame, venueRows } from "../venues.js";
import { eachRow, makeNflverseSource } from "./base.js";
import { withBacktestContext } from "./seasons.js";
import {
  TableLoader,
  asInt,
  asReal,
  buildRow,
  decimalIdOf,
  type Derivation,
  type RawRow,
} from "./rows.js";

/** The derived ds_schedules columns (tables.ts derivations); malformed ESPN ids are noted on `loader`. */
export function scheduleDerivations(loader: TableLoader): Readonly<Record<string, Derivation>> {
  return Object.freeze({
    espn_game_id: (r: RawRow) => decimalIdOf(loader, "espn", r.espn),
    kickoff_utc: (r: RawRow) => kickoffUtcFromEastern(r.gameday, r.gametime),
    roof: (r: RawRow) => normalizeRoof(r.roof),
    venue_id: (r: RawRow) => resolveVenueId(r.game_id, r.stadium_id, r.stadium),
  });
}

/** A game's betting lines as a reader exposes them, minus the stamp's `as_of`. */
export type GameLinesView = Omit<GameLines, "as_of">;

/**
 * The lines of a games / ds_schedules row (tables.ts READER_QUERIES NflGamesReader mapping): null when
 * spread, total and both moneylines are all null, else the implied team totals — positive spread =
 * home favoured, so the favourite always gets the larger total.
 */
export function gameLines(row: RawRow): GameLinesView | null {
  const spread = asReal(row.spread_line);
  const total = asReal(row.total_line);
  const away = asInt(row.away_moneyline);
  const home = asInt(row.home_moneyline);
  if (spread === null && total === null && away === null && home === null) return null;
  return {
    spread_line: spread,
    total_line: total,
    implied: impliedPoints(spread, total),
    moneyline: { away, home },
  };
}

/** The schedules DataSource as Phase 1 built it: exactly the run's seasons. */
const runSeasonsSchedulesSource: DataSource = makeNflverseSource({
  id: "nflverse:schedules",
  tag: "schedules",
  file: { all: "games.parquet", seasonless: false },
  seasonGate: "always",
  async publish(files, into) {
    const games = new TableLoader(into, DS_SCHEDULES);
    const venues = new TableLoader(into, DS_VENUES);
    const derived = scheduleDerivations(games);
    let unknownVenue = 0;
    let noKickoff = 0;
    let venueDiffers = 0;
    await eachRow("nflverse:schedules", files, (raw, file) => {
      // games.parquet holds every season: rows outside the file's season are the documented
      // row_filter, not an anomaly, so they are not counted.
      if (file.season !== null && asInt(raw.season) !== file.season) return;
      const row = buildRow(DS_SCHEDULES, raw, derived);
      if (!games.add(row)) return;
      if (row.venue_id === null) unknownVenue++;
      if (row.kickoff_utc === null) noKickoff++;
      // The weather path knows a game only from the ESPN schedule (venues.ts venueForGame): a game
      // whose real venue it would miss needs a GAME_VENUE_OVERRIDES row (a new neutral-site game).
      // Super Bowls are skipped: a neutral US site, and no fantasy week (venues.ts).
      const espnPath = venueForGame(row.game_id, row.home_team)?.stadium_id ?? null;
      if (row.game_type !== "SB" && row.venue_id !== null && espnPath !== row.venue_id)
        venueDiffers++;
    });
    for (const v of venueRows()) venues.add(v);
    const warnings: string[] = [];
    if (unknownVenue > 0) {
      warnings.push(
        `ds_schedules: ${String(unknownVenue)} game(s) at a venue not in src/sources/venues.ts`,
      );
    }
    if (noKickoff > 0)
      warnings.push(`ds_schedules: ${String(noKickoff)} game(s) without a kickoff time`);
    if (venueDiffers > 0) {
      warnings.push(
        `ds_schedules: ${String(venueDiffers)} game(s) whose venue differs from the ESPN-driven weather venue (src/sources/venues.ts GAME_VENUE_OVERRIDES / HOME_VENUES)`,
      );
    }
    return { loaders: [games, venues], warnings };
  },
});

/**
 * The schedules DataSource: Phase 1's, with the run's seasons widened to hold the backtest seasons
 * (seasons.ts `withBacktestContext`) in both the version (so a grown season set republishes) and the
 * fetch (one download either way: games.parquet holds every season).
 */
export const schedulesSource: DataSource = Object.freeze({
  ...runSeasonsSchedulesSource,
  // async: a malformed run season rejects (never a synchronous throw from a DataSource method)
  version: async (ctx: SourceContext): Promise<ReleaseVersion | null> =>
    runSeasonsSchedulesSource.version(withBacktestContext(ctx)),
  fetch: async (v: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> =>
    runSeasonsSchedulesSource.fetch(v, withBacktestContext(ctx)),
});
