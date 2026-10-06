// harness.ts — test plumbing for the nflverse sources (plan 05 §2 `sources/*`: no network, ever): a
// fake HttpGet + HttpDownload serving fixture bytes by release URL, a SourceContext on a fresh temp
// dir with a fixed clock and a fake ESPN pro schedule, and a real DatasetWriter over node:sqlite built
// from the contract's own DDL (tables.ts ddlFor, STRICT). Ported from sibling @521f9f3, adapted.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProGame } from "../../../../src/domain/league/types.js";
import { fixedClock } from "../../../../src/domain/clock.js";
import type { HttpDownload, HttpGet, SourceContext } from "../../../../src/sources/source.js";
import { ddlFor } from "../../../../src/store/datasets/tables.js";
import type { DatasetRow, DatasetTableSpec, DatasetWriter } from "../../../../src/store/types.js";
import { fixtureRoutes } from "./fixtures.js";

/** What a route answers: bytes (200), a status, or a thrown error. */
export type Route = Uint8Array | number | Error;

export interface FakeHttp {
  readonly http: HttpGet;
  readonly download: HttpDownload;
  /** Every URL requested, in order (both transports). */
  readonly calls: string[];
}

const ASSET_HOST = "https://release-assets.githubusercontent.com/x/";

/** A fake transport pair: 200 + bytes for a known route, 404 otherwise; never the network. */
export function fakeHttp(routes: ReadonlyMap<string, Route>): FakeHttp {
  const calls: string[] = [];
  const answer = (
    url: string,
    signal: AbortSignal,
    maxBytes: number,
  ): { status: number; body: Uint8Array } => {
    calls.push(url);
    if (signal.aborted) throw new Error("aborted");
    const r = routes.get(url);
    if (r instanceof Error) throw r;
    const status = typeof r === "number" ? r : r === undefined ? 404 : 200;
    const body = r instanceof Uint8Array ? r : new Uint8Array(0);
    if (body.length > maxBytes) throw new Error("too_large");
    return { status, body };
  };
  const http: HttpGet = (url, opts) => {
    try {
      const { status, body } = answer(url, opts.signal, opts.maxBytes);
      return Promise.resolve({
        status,
        body,
        headers: {},
        final_url: `${ASSET_HOST}${String(calls.length)}`,
      });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error("fake http"));
    }
  };
  const download: HttpDownload = (url, opts) => {
    try {
      const { status, body } = answer(url, opts.signal, opts.maxBytes);
      if (status === 200) writeFileSync(opts.dest, body, { flag: "wx", mode: 0o600 });
      return Promise.resolve({
        status,
        bytes: status === 200 ? body.length : 0,
        headers: {},
        final_url: `${ASSET_HOST}${String(calls.length)}`,
        path: opts.dest,
      });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error("fake download"));
    }
  };
  return { http, download, calls };
}

export interface Ctx {
  readonly ctx: SourceContext;
  readonly tempDir: string;
  readonly calls: string[];
  readonly abort: AbortController;
  /** Seasons reported through `ctx.notPublished`. */
  readonly unpublished: number[];
  cleanup(): void;
}

/** One ESPN pro-schedule game for the fake reader. */
export function proGame(season: number, week: number, kickoff: string | null): ProGame {
  return {
    espn_game_id: 1,
    season,
    week,
    kickoff,
    start_time_tbd: kickoff === null,
    valid_for_locking: kickoff !== null,
    stats_official: false,
    home_pro_team_id: 1,
    away_pro_team_id: 2,
  };
}

export interface CtxOptions {
  readonly routes?: ReadonlyMap<string, Route>;
  readonly now?: string;
  /** The fake ESPN pro schedule's games (default: none); a function to throw or vary. */
  readonly proGames?: readonly ProGame[] | (() => readonly ProGame[]);
  readonly overrides?: Partial<SourceContext>;
}

/** A SourceContext over the fake transports and a fresh temp dir. */
export function makeCtx(seasons: readonly number[], o: CtxOptions = {}): Ctx {
  const tempDir = mkdtempSync(join(tmpdir(), "eff-nflverse-test-"));
  const { http, download, calls } = fakeHttp(o.routes ?? fixtureRoutes());
  const abort = new AbortController();
  const unpublished: number[] = [];
  const games = o.proGames ?? [];
  const ctx: SourceContext = {
    http,
    download,
    signal: abort.signal,
    clock: fixedClock(o.now ?? "2026-10-06T12:00:00.000Z"),
    seasons,
    week: null,
    datasets: {
      proSchedule: {
        games: (season, weeks) => {
          const all = typeof games === "function" ? games() : games;
          return {
            rows: all.filter(
              (g) => g.season === season && (weeks === null || weeks.includes(g.week)),
            ),
            stamp: null,
          };
        },
        teams: () => ({ rows: [], stamp: null }),
      },
    },
    tempDir,
    notPublished: (season) => {
      unpublished.push(season);
    },
    ...o.overrides,
  };
  return {
    ctx,
    tempDir,
    calls,
    abort,
    unpublished,
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

type SqlValue = string | number | null | Uint8Array;

/** A DatasetWriter over a real SQLite file (the contract's STRICT DDL), recording batch sizes. */
export class SqliteWriter implements DatasetWriter {
  readonly path: string;
  readonly db: DatabaseSync;
  readonly batches: { table: string; rows: number }[] = [];
  readonly created: string[] = [];
  private static seq = 0;

  constructor(dir: string) {
    SqliteWriter.seq++;
    this.path = join(dir, `staging-${String(SqliteWriter.seq)}.sqlite`);
    this.db = new DatabaseSync(this.path);
  }

  createTable(spec: DatasetTableSpec): void {
    for (const sql of ddlFor(spec)) this.db.exec(sql);
    this.created.push(spec.name);
  }

  insert(table: string, rows: readonly DatasetRow[]): number {
    if (rows.length === 0) return 0;
    const cols = Object.keys(rows[0] ?? {});
    const stmt = this.db.prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols
        .map(() => "?")
        .join(", ")})`,
    );
    this.db.exec("BEGIN");
    try {
      for (const r of rows) stmt.run(...cols.map((c): SqlValue => r[c] ?? null));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.batches.push({ table, rows: rows.length });
    return rows.length;
  }

  all(sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params);
  }

  close(): void {
    this.db.close();
  }
}
