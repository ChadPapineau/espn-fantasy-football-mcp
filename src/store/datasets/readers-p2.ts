// readers-p2.ts — the Phase-2 dataset ports over their per-source read-only connections (plan 10
// §3.2; plan 01 §5.2/§5.5; plan 07 D1, D4, D6, E5), running EXACTLY the SQL of PHASE_2_READER_QUERIES
// (tables.ts) with JSON-array list parameters and applying each entry's `mapping`: the depth chart
// (the current snapshot runs, or 2024's legacy last week), ffopportunity's expected points, the RSS
// news items with their player refs (every string wrapped — src/domain/evidence `newsItemWithRefs`),
// Sleeper's trending list (secondary) with gsis ids from the roster file, the D5 pbp team profile
// (by defteam), and the usage extras the
// Phase-1 `PlayerWeekReader.lines` gains once the snap-count and pbp files are loaded (snaps and
// snap share, red-zone and goal-line volume, carry share, the routes proxy). A prior season's
// statement runs on the source's HISTORY file when the current file does not hold that season
// (`dataset_meta.seasons`). A file that is not loaded reads as never loaded (`stamp: null`), never an
// exception; every row a mapping cannot place is skipped and counted by a fixed-vocabulary warning.
import { isNflTeam, type NflTeam } from "../../config/schema.js";
import type { DatasetSourceId } from "../../config/freshness.js";
import type {
  DatasetResult,
  DatasetStamp,
  DepthChartReader,
  DepthChartRow,
  EpWeeklyReader,
  EpWeeklyRow,
  NewsItem,
  NewsReader,
  PbpReader,
  PbpTeamProfileRow,
  TrendingReader,
  TrendingRow,
} from "../../domain/analytics/types.js";
import { newsItemWithRefs, readStoredNewsRow } from "../../domain/evidence/index.js";
import { bareUntrusted, type IsoInstant, type Week } from "../../domain/league/types.js";
import type { DatasetConnection } from "./connections.js";
import { DEPTH_LABEL_OTHER, DEPTH_LABELS } from "./derive.js";
import {
  DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM,
  PHASE_2_READER_QUERIES,
  type Phase2ReaderMethod,
} from "./tables.js";

/** A row as SQLite returns it. */
type SqlRow = Readonly<Record<string, unknown>>;

/** What the Phase-2 readers need from the store's reader factory. */
export interface Phase2ReaderDeps {
  /**
   * The connection to read `source` from for `season` (its history file when the current one does
   * not hold the season); null when neither is loaded.
   */
  readonly connFor: (
    source: DatasetSourceId,
    history: DatasetSourceId | null,
    season: number | null,
  ) => DatasetConnection | null;
  readonly stampOf: (c: DatasetConnection) => DatasetStamp;
  readonly warn: (code: string) => void;
}

/** The usage extras of one player-week (PlayerWeekLine.usage fields the stats file lacks). */
export interface UsageExtras {
  readonly snaps: number | null;
  readonly snap_pct: number | null;
  readonly routes_proxy: number | null;
  readonly carry_share: number | null;
  readonly rz_targets: number | null;
  readonly rz_carries: number | null;
  readonly gl_carries: number | null;
}

/** One player-week the extras are asked for (the stats line's own team). */
export interface UsageKey {
  readonly gsis_id: string;
  readonly week: Week;
  readonly nfl_team: NflTeam;
}

/** The key of a player-week in the extras map. */
export const usageKeyOf = (gsis: string, week: number): string => `${gsis}|${String(week)}`;

/** Most news items one `recent` call returns (the tool's own bound is lower). */
export const NEWS_RECENT_MAX = 500;
/**
 * Extra rows asked of each feed beyond `limit`: a stored row that does not read back is dropped
 * BEFORE the merged list is cut, so a bad row never shortens the answer below `limit`.
 */
export const NEWS_DROP_SLACK = 16;

const NEVER_LOADED = Object.freeze({
  rows: Object.freeze([]),
  stamp: null,
}) as DatasetResult<never>;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) ? n : null;
};
const team = (v: unknown): NflTeam | null => (typeof v === "string" && isNflTeam(v) ? v : null);
const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b <= 0 ? null : a / b;

/** The `season` a dataset file holds per its `dataset_meta.seasons` (JSON array), else []. */
export function seasonsOf(c: DatasetConnection): readonly number[] {
  try {
    const v = JSON.parse(c.meta.seasons ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

export function createPhase2Readers(d: Phase2ReaderDeps): {
  readonly depthCharts: DepthChartReader;
  readonly epWeekly: EpWeeklyReader;
  readonly news: NewsReader;
  readonly trending: TrendingReader;
  readonly pbp: PbpReader;
  readonly usageExtras: (
    keys: readonly UsageKey[],
    season: number,
  ) => ReadonlyMap<string, UsageExtras>;
} {
  /** Statement `i` of a Phase-2 reader on its file for `season` (history-routed); null = not loaded. */
  function run(
    method: Phase2ReaderMethod,
    i: number,
    params: Record<string, string | number | null>,
    season: number | null,
  ): { rows: SqlRow[]; conn: DatasetConnection } | null {
    const st = PHASE_2_READER_QUERIES[method].statements[i];
    if (st === undefined) throw new Error(`store: ${method} has no statement ${String(i)}`);
    const conn = d.connFor(st.source, st.history, season);
    if (conn === null) return null;
    const rows = conn.db.prepare(st.sql).all(params) as unknown as SqlRow[];
    return { rows, conn };
  }

  // --- DepthChartReader.chart ------------------------------------------------------------------

  /**
   * A stored depth label held to the closed vocabulary once more on the way out (the publisher
   * already wrote DEPTH_LABELS or OTHER — derive.ts depthLabel): anything else reads as OTHER,
   * counted, so a label is never third-party text in a tool result.
   */
  const label = (v: unknown): string | null => {
    const t = str(v);
    if (t === null) return null;
    if (t === DEPTH_LABEL_OTHER || DEPTH_LABELS.has(t)) return t;
    d.warn("dataset_label_other");
    return DEPTH_LABEL_OTHER;
  };

  const depthCharts: DepthChartReader = {
    chart(season, teams): DatasetResult<DepthChartRow> {
      const list = JSON.stringify([...new Set(teams)]);
      const snapshot = season >= DEPTH_CHARTS_SNAPSHOT_SCHEMA_FROM;
      const res = snapshot
        ? run("DepthChartReader.chart", 0, { season, teams: list }, season)
        : run("DepthChartReader.chart", 1, { season, teams: list }, season);
      if (res === null) return NEVER_LOADED;
      const rows: DepthChartRow[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        const grp = label(snapshot ? r.pos_grp : r.formation);
        const abb = label(r.pos_abb);
        const rank = int(snapshot ? r.pos_rank : r.depth_team);
        if (t === null || grp === null || abb === null || rank === null) {
          d.warn("dataset_row_skipped");
          continue;
        }
        rows.push({
          season: int(r.season) ?? season,
          week: snapshot ? null : int(r.week),
          nfl_team: t,
          pos_grp: grp,
          pos_abb: abb,
          rank,
          gsis_id: str(r.gsis_id),
          espn_id: snapshot ? int(r.espn_id) : null,
          name: bareUntrusted(str(snapshot ? r.player_name : r.full_name) ?? "", "player_name"),
        });
      }
      return { rows, stamp: d.stampOf(res.conn) };
    },
  };

  // --- EpWeeklyReader.rows ---------------------------------------------------------------------

  const epWeekly: EpWeeklyReader = {
    rows(gsisIds, season, weeks): DatasetResult<EpWeeklyRow> {
      const res = run(
        "EpWeeklyReader.rows",
        0,
        {
          season,
          weeks: JSON.stringify([...new Set(weeks)]),
          gsis_ids: JSON.stringify([...new Set(gsisIds)]),
        },
        season,
      );
      if (res === null) return NEVER_LOADED;
      const rows: EpWeeklyRow[] = [];
      for (const r of res.rows) {
        const gsis = str(r.player_id);
        const s = int(r.season);
        const w = int(r.week);
        if (gsis === null || s === null || w === null) {
          d.warn("dataset_row_skipped");
          continue;
        }
        rows.push({
          gsis_id: gsis,
          season: s,
          week: w,
          xfp_total: num(r.total_fantasy_points_exp),
        });
      }
      return { rows, stamp: d.stampOf(res.conn) };
    },
  };

  // --- NewsReader.recent -----------------------------------------------------------------------

  const news: NewsReader = {
    recent(sinceIso: IsoInstant, limit: number, gsisIds): DatasetResult<NewsItem> {
      const since = Date.parse(sinceIso);
      const cap = Math.max(0, Math.min(NEWS_RECENT_MAX, Math.trunc(limit)));
      if (!Number.isFinite(since)) throw new RangeError("store: sinceIso must be ISO-8601");
      const gsis = gsisIds === null ? null : JSON.stringify([...new Set(gsisIds)]);
      const found: { row: SqlRow; feed: number }[] = [];
      let stamp: DatasetStamp | null = null;
      for (let feed = 0; feed < 3; feed++) {
        const res = run(
          "NewsReader.recent",
          feed,
          { since_ms: since, gsis_ids: gsis, limit: cap === 0 ? 0 : cap + NEWS_DROP_SLACK },
          null,
        );
        if (res === null) continue; // a feed never loaded is skipped
        const st = d.stampOf(res.conn);
        // the freshest feed's stamp stands for the merged list (each feed is its own file)
        if (stamp === null || Date.parse(st.checked_at) > Date.parse(stamp.checked_at)) stamp = st;
        for (const row of res.rows) {
          if (readStoredNewsRow(row) === null) {
            d.warn("dataset_row_skipped");
            continue;
          }
          found.push({ row, feed });
        }
      }
      if (stamp === null) return NEVER_LOADED;
      found.sort((a, b) => {
        const pa = num(a.row.published_ms) ?? 0;
        const pb = num(b.row.published_ms) ?? 0;
        if (pa !== pb) return pb - pa;
        const ia = str(a.row.item_id) ?? "";
        const ib = str(b.row.item_id) ?? "";
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      });
      const kept = found.slice(0, cap);
      const refs = new Map<number, SqlRow[]>();
      for (let feed = 0; feed < 3; feed++) {
        const ids = kept.filter((k) => k.feed === feed).map((k) => str(k.row.item_id));
        if (ids.length === 0) continue;
        const res = run("NewsReader.recent", 3 + feed, { item_ids: JSON.stringify(ids) }, null);
        refs.set(feed, res?.rows ?? []);
      }
      const rows: NewsItem[] = [];
      for (const k of kept) {
        const item = newsItemWithRefs(k.row, refs.get(k.feed) ?? []);
        if (item === null) {
          d.warn("dataset_row_skipped");
          continue;
        }
        rows.push(item);
      }
      return { rows, stamp };
    },
  };

  // --- TrendingReader.latest -------------------------------------------------------------------

  const trending: TrendingReader = {
    latest(): DatasetResult<TrendingRow> {
      const res = run("TrendingReader.latest", 0, {}, null);
      if (res === null) return NEVER_LOADED;
      const ids = [
        ...new Set(res.rows.map((r) => str(r.sleeper_id)).filter((x): x is string => x !== null)),
      ];
      const gsisOf = new Map<string, string>();
      if (ids.length > 0) {
        const roster = run("TrendingReader.latest", 1, { sleeper_ids: JSON.stringify(ids) }, null);
        // the FIRST row per sleeper id is the newest season/week (the statement's order)
        for (const r of roster?.rows ?? []) {
          const sid = str(r.sleeper_id);
          const g = str(r.gsis_id);
          if (sid !== null && g !== null && !gsisOf.has(sid)) gsisOf.set(sid, g);
        }
      }
      const rows: TrendingRow[] = [];
      for (const r of res.rows) {
        const sid = str(r.sleeper_id);
        const kind = r.kind === "add" || r.kind === "drop" ? r.kind : null;
        const count = int(r.count);
        const asOf = str(r.as_of);
        if (sid === null || kind === null || count === null || asOf === null) {
          d.warn("dataset_row_skipped");
          continue;
        }
        rows.push({ gsis_id: gsisOf.get(sid) ?? null, sleeper_id: sid, kind, count, as_of: asOf });
      }
      return { rows, stamp: d.stampOf(res.conn) };
    },
  };

  // --- PbpReader.teamProfile ----------------------------------------------------------------------

  const pbp: PbpReader = {
    teamProfile(teams, season, weeks): DatasetResult<PbpTeamProfileRow> {
      const res = run(
        "PbpReader.teamProfile",
        0,
        {
          season,
          weeks: JSON.stringify([...new Set(weeks)]),
          teams: JSON.stringify([...new Set(teams)]),
        },
        season,
      );
      if (res === null) return NEVER_LOADED;
      const rows: PbpTeamProfileRow[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        const w = int(r.week);
        const plays = int(r.plays);
        if (t === null || w === null || plays === null) {
          d.warn("dataset_row_skipped");
          continue;
        }
        rows.push({
          nfl_team: t,
          season: int(r.season) ?? season,
          week: w,
          plays,
          dropbacks: int(r.dropbacks) ?? 0,
          sacks: int(r.sacks) ?? 0,
          interceptions: int(r.interceptions) ?? 0,
          fumbles_lost: int(r.fumbles_lost) ?? 0,
          epa_dropback_sum: num(r.epa_dropback_sum),
          epa_rush_sum: num(r.epa_rush_sum),
          rushes: int(r.rushes) ?? 0,
          pass_oe_mean: num(r.pass_oe_mean),
          pass_oe_n: int(r.pass_oe_n) ?? 0,
        });
      }
      return { rows, stamp: d.stampOf(res.conn) };
    },
  };

  // --- the usage extras: SnapCountReader.counts + PbpReader.playerUsage --------------------------

  /** gsis_id → pfr_id for `season` (statement 1 wins, else statement 2; conflicts dropped). */
  function pfrIds(gsis: readonly string[], season: number): Map<string, string> {
    const list = JSON.stringify(gsis);
    const fromRoster = run("SnapCountReader.counts", 0, { season, gsis_ids: list }, null);
    const fromPlayers = run("SnapCountReader.counts", 1, { gsis_ids: list }, null);
    const pick = (rows: readonly SqlRow[]): Map<string, string | null> => {
      const m = new Map<string, string | null>();
      for (const r of rows) {
        const g = str(r.gsis_id);
        const p = str(r.pfr_id);
        if (g === null || p === null || p === "") continue;
        const prev = m.get(g);
        m.set(g, prev === undefined || prev === p ? p : null); // two pfr ids → unknown
      }
      return m;
    };
    const a = pick(fromRoster?.rows ?? []);
    const b = pick(fromPlayers?.rows ?? []);
    const chosen = new Map<string, string>();
    for (const g of gsis) {
      const p = a.has(g) ? a.get(g) : b.get(g);
      if (p === null) d.warn("dataset_pfr_id_ambiguous");
      if (typeof p === "string") chosen.set(g, p);
    }
    // a pfr id claimed by two gsis ids is never guessed
    const owners = new Map<string, number>();
    for (const p of chosen.values()) owners.set(p, (owners.get(p) ?? 0) + 1);
    for (const [g, p] of [...chosen])
      if ((owners.get(p) ?? 0) > 1) {
        chosen.delete(g);
        d.warn("dataset_pfr_id_ambiguous");
      }
    return chosen;
  }

  function usageExtras(
    keys: readonly UsageKey[],
    season: number,
  ): ReadonlyMap<string, UsageExtras> {
    const out = new Map<string, UsageExtras>();
    if (keys.length === 0) return out;
    const gsis = [...new Set(keys.map((k) => k.gsis_id))];
    const weeks = JSON.stringify([...new Set(keys.map((k) => k.week))]);
    // snaps (nflverse snap_counts, keyed by pfr id)
    const snapBy = new Map<string, { snaps: number | null; pct: number | null }>();
    const pfr = pfrIds(gsis, season);
    if (pfr.size > 0) {
      const gsisOfPfr = new Map<string, string>();
      for (const [g, p] of pfr) gsisOfPfr.set(p, g);
      const res = run(
        "SnapCountReader.counts",
        2,
        { season, weeks, pfr_ids: JSON.stringify([...gsisOfPfr.keys()]) },
        season,
      );
      for (const r of res?.rows ?? []) {
        const p = str(r.pfr_player_id);
        const g = p === null ? undefined : gsisOfPfr.get(p);
        const w = int(r.week);
        if (g === undefined || w === null) continue;
        snapBy.set(usageKeyOf(g, w), { snaps: int(r.offense_snaps), pct: num(r.offense_pct) });
      }
    }
    // red-zone / goal-line volume and the team totals (nflverse pbp)
    const ids = JSON.stringify(gsis);
    const targets = run("PbpReader.playerUsage", 0, { season, weeks, gsis_ids: ids }, season);
    const carries = run("PbpReader.playerUsage", 1, { season, weeks, gsis_ids: ids }, season);
    const teams = JSON.stringify([...new Set(keys.map((k) => k.nfl_team))]);
    const totals = run("PbpReader.playerUsage", 2, { season, weeks, teams }, season);
    const sum = (rows: readonly SqlRow[] | undefined, col: string) => {
      const m = new Map<string, number>();
      for (const r of rows ?? []) {
        const g = str(r.gsis_id);
        const w = int(r.week);
        const v = num(r[col]);
        if (g === null || w === null || v === null) continue;
        const k = usageKeyOf(g, w);
        m.set(k, (m.get(k) ?? 0) + v);
      }
      return m;
    };
    const rzT = sum(targets?.rows, "rz_targets");
    const rzC = sum(carries?.rows, "rz_carries");
    const glC = sum(carries?.rows, "gl_carries");
    const car = sum(carries?.rows, "carries");
    const teamBy = new Map<string, SqlRow>();
    for (const r of totals?.rows ?? []) {
      const t = str(r.team);
      const w = int(r.week);
      if (t !== null && w !== null) teamBy.set(`${t}|${String(w)}`, r);
    }
    for (const k of keys) {
      const key = usageKeyOf(k.gsis_id, k.week);
      const snap = snapBy.get(key);
      const tw = teamBy.get(`${k.nfl_team}|${String(k.week)}`);
      // a week the pbp file covers (its team had plays): absent player rows are 0, else unknown
      const covered = tw !== undefined;
      const count = (m: Map<string, number>): number | null => (covered ? (m.get(key) ?? 0) : null);
      const pct = snap?.pct ?? null;
      const dropbacks = covered ? num(tw.dropbacks) : null;
      out.set(key, {
        snaps: snap?.snaps ?? null,
        snap_pct: pct,
        routes_proxy: pct === null || dropbacks === null ? null : pct * dropbacks,
        carry_share: covered ? ratio(car.get(key) ?? 0, num(tw.carries)) : null,
        rz_targets: count(rzT),
        rz_carries: count(rzC),
        gl_carries: count(glC),
      });
    }
    return out;
  }

  return { depthCharts, epWeekly, news, trending, pbp, usageExtras };
}
