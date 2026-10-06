// helpers.ts — weather test plumbing: the authored fixtures (fixtures/weather, synthetic), a
// publisher whose DatasetWriter is a real in-memory node:sqlite database built with tables.ts
// `ddlFor` (so every published row is checked against the STRICT table's types and NOT NULLs), the
// week-5 ESPN pro games exercising every selection rule, and an nflverse roof reader.
// Ported from sibling @cf3b015, adapted (games come from the ESPN pro schedule).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  DatasetResult,
  NflGame,
  NflGamesReader,
} from "../../../src/domain/analytics/types.js";
import type { ProGame } from "../../../src/domain/league/types.js";
import { ddlFor } from "../../../src/store/datasets/tables.js";
import type {
  DatasetPublisher,
  DatasetRow,
  DatasetWriter,
  PublishOutcome,
  PublishStats,
} from "../../../src/store/types.js";
import { proGame } from "../runner/helpers.js";

const FIX = new URL("../../../fixtures/weather/", import.meta.url);

/** A fixture's text. */
export function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIX), "utf8");
}

/** A fixture parsed (a fresh copy each call, safe to mutate). */
export function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(fixtureText(name)) as Record<string, unknown>;
}

/** A 200 JSON response. */
export function json(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A writer over an in-memory sqlite db. */
export function sqliteWriter(db: DatabaseSync): DatasetWriter {
  return {
    path: ":memory:",
    createTable(spec) {
      for (const sql of ddlFor(spec)) db.exec(sql);
    },
    insert(table, rows: readonly DatasetRow[]) {
      let n = 0;
      db.exec("BEGIN");
      for (const r of rows) {
        const cols = Object.keys(r);
        const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
        db.prepare(sql).run(...cols.map((c) => r[c] ?? null));
        n++;
      }
      db.exec("COMMIT");
      return n;
    },
  };
}

/** A publisher whose file is an in-memory sqlite db the test can query. */
export function sqlitePublisher(): DatasetPublisher & { db: DatabaseSync | null; calls: number } {
  const p = {
    db: null as DatabaseSync | null,
    calls: 0,
    async publish(
      source: string,
      version: string,
      _released: string | null,
      fill: (w: DatasetWriter) => Promise<PublishStats>,
    ): Promise<PublishOutcome> {
      p.calls++;
      const db = new DatabaseSync(":memory:");
      const stats = await fill(sqliteWriter(db));
      p.db = db;
      return { ok: true, file: `/cache/ds/${source}.sqlite`, file_version: version, stats };
    },
    recordUnchanged() {
      /* nothing */
    },
    close() {
      /* nothing */
    },
  };
  return p;
}

/** All rows of a table, ordered by game_id. */
export function rowsOf(db: DatabaseSync | null, table: string): Record<string, unknown>[] {
  if (db === null) throw new Error("nothing was published");
  return db.prepare(`SELECT * FROM "${table}" ORDER BY game_id`).all();
}

/** "Now" for every weather test: Thursday 2026-10-01 12:00 UTC (week 5 is the coming week). */
export const WEATHER_NOW = "2026-10-01T12:00:00.000Z";

/** ESPN pro-team ids (research 03 §B.2) used below. */
export const T = {
  ATL: 1,
  CHI: 3,
  CLE: 5,
  DAL: 6,
  DET: 8,
  GB: 9,
  IND: 11,
  LV: 13,
  LAR: 14,
  MIN: 16,
  PHI: 21,
  ARI: 22,
  JAX: 30,
  HOU: 34,
} as const;

const g = (
  id: number,
  away: number,
  home: number,
  kickoff: string | null,
  extra: Partial<ProGame> = {},
): ProGame => proGame(id, kickoff, { away_pro_team_id: away, home_pro_team_id: home, ...extra });

/**
 * Week-5 ESPN games (synthetic ids) exercising every selection rule. Fetched: DAL@CLE (open-air),
 * JAX@IND (retractable, nflverse roof "open"), PHI@JAX (the London override — non-US), CHI@GB.
 * Skipped: MIN@DET (dome), ARI@HOU (retractable, roof "closed"), LV@LAR (SoFi, a fixed roof),
 * a TBD game, a null kickoff, a kickoff already past, an unknown team id; week 6 is out of range.
 * The DAL@CLE row is listed twice (ESPN lists every game under both teams) and deduplicated.
 */
export function weekFiveGames(): ProGame[] {
  return [
    g(401, T.DAL, T.CLE, "2026-10-04T17:00:00.000Z"),
    g(401, T.DAL, T.CLE, "2026-10-04T17:00:00.000Z"),
    g(402, T.MIN, T.DET, "2026-10-04T17:00:00.000Z"),
    g(403, T.ARI, T.HOU, "2026-10-04T17:00:00.000Z"),
    g(404, T.JAX, T.IND, "2026-10-05T00:20:00.000Z"),
    g(405, T.PHI, T.JAX, "2026-10-04T13:30:00.000Z"),
    g(406, T.LV, T.LAR, "2026-10-04T20:05:00.000Z"),
    g(407, T.CHI, T.GB, "2026-10-04T17:00:00.000Z"),
    g(408, T.ATL, T.DAL, "2026-10-04T07:00:00.000Z", { start_time_tbd: true }),
    g(409, T.ATL, T.CHI, null),
    g(410, T.ATL, T.GB, "2026-10-01T10:00:00.000Z"),
    g(411, 99, T.CLE, "2026-10-04T17:00:00.000Z"),
    g(412, T.DAL, T.CLE, "2026-10-11T17:00:00.000Z", { week: 6 }),
  ];
}

/** An nflverse game with just the fields the weather path reads (the roof). */
export function nflGame(espnId: number, roof: string | null): NflGame {
  return {
    game_id: `g${String(espnId)}`,
    espn_game_id: espnId,
    season: 2026,
    week: 5,
    kickoff: null,
    away: "ARI",
    home: "HOU",
    roof,
    surface: null,
    stadium: null,
    divisional: null,
    rest_days: { away: null, home: null },
    lines: null,
    is_final: false,
    score: null,
  };
}

/** An nflverse reader answering roofs: 403 (HOU) closed, 404 (IND) open. */
export function roofReader(
  roofs: Readonly<Record<number, string | null>> = { 403: "closed", 404: "open" },
): NflGamesReader & {
  asked: number[][];
} {
  const asked: number[][] = [];
  return {
    asked,
    games: (): DatasetResult<NflGame> => ({ rows: [], stamp: null }),
    byEspnGameId(ids): DatasetResult<NflGame> {
      asked.push([...ids]);
      return {
        rows: ids
          .filter((id) => Object.hasOwn(roofs, id))
          .map((id) => nflGame(id, roofs[id] ?? null)),
        stamp: null,
      };
    },
  };
}
