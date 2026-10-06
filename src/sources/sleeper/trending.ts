// trending.ts — the SleeperTrending DataSource `sleeper:trending` (plan 10 §3.2 "Sleeper trending
// (secondary)"; plan 06 §1.3 `refresh sleeper:trending` "every 30 min in season · trending/add|drop ·
// ds_trending · warn-only"; research 04 #13 — SECONDARY: ESPN's own `ownership.percentChange` is the
// primary market signal, Sleeper is an independent, differently-populated one; research 04 §E —
// Sleeper's API is "free to use for non-commercial purposes", so the source carries
// `license: "non-commercial"` from SOURCE_REGISTRY and `eff status` shows it; tables.ts DS_TRENDING
// for the stored columns). Keyless, public, documented (docs.sleeper.com); ≤ 10 requests/min
// (SOURCE_RATE_LIMITS.sleeper — the runner spaces the two requests 6 s apart).
//
// Shape (fetched once on 2026-10-06, fixtures/sleeper/README.md): `[{ "count": 2699676,
// "player_id": "11637" }, …]`, 50 entries, count descending; a defence is its team code ("JAX").
// `version()` is the 30-minute UTC bucket. `fetch` GETs the add list then the drop list into one JSON
// temp file; an outage before either answered fails the attempt (the runner retries), a later failure
// leaves that list null with a warning. Ported in shape from the weather sources (sibling @cf3b015).
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_REGISTRY } from "../../config/freshness.js";
import { HttpError, POLICY_KINDS } from "../../http/errors.js";
import { nonNegativeInt, sleeperPlayerId } from "../../store/datasets/derive.js";
import {
  contractColumnsHash,
  DS_TRENDING,
  SLEEPER_TRENDING_REQUEST,
} from "../../store/datasets/tables.js";
import type { DatasetRow, DatasetWriter } from "../../store/types.js";
import {
  SOURCE_RATE_LIMITS,
  type DataSource,
  type PublishStats,
  type ReleaseVersion,
  type SchemaReport,
  type SourceContext,
  type TempFile,
} from "../source.js";

/** The Sleeper API host (for src/http's data-source allow-list; answered 200 without a redirect). */
export const SLEEPER_HOST = "api.sleeper.app";
/** The temp-file format marker. */
export const TRENDING_FILE_FORMAT = "eff-sleeper-trending-v1";
/** Largest response accepted per list (a 50-entry list is ~1.8 kB). */
export const MAX_TRENDING_BYTES = 512 * 1024;
/** At most this many entries are read per list (the request asks for 50). */
export const MAX_TRENDING_ENTRIES = 500;
/** The two lists, in request order. */
export const TRENDING_KINDS = ["add", "drop"] as const;
export type TrendingKind = (typeof TRENDING_KINDS)[number];

/** The request of one list (Sleeper's documented `lookback_hours` and `limit`). */
export function sleeperTrendingUrl(
  kind: TrendingKind,
  req: { readonly lookback_hours: number; readonly limit: number } = SLEEPER_TRENDING_REQUEST,
): string {
  if (!(TRENDING_KINDS as readonly string[]).includes(kind))
    throw new RangeError("sleeper: unknown trending kind");
  const ok = (n: number, max: number): boolean => Number.isInteger(n) && n >= 1 && n <= max;
  if (!ok(req.lookback_hours, 168) || !ok(req.limit, 200))
    throw new RangeError("sleeper: lookback_hours must be 1..168 and limit 1..200");
  return `https://${SLEEPER_HOST}/v1/players/nfl/trending/${kind}?lookback_hours=${String(req.lookback_hours)}&limit=${String(req.limit)}`;
}

/** The 30-minute UTC bucket `YYYY-MM-DDTHH:MM` of an instant — the source's version. */
export function halfHourBucket(nowMs: number): string {
  const h = 30 * 60 * 1000;
  return new Date(Math.floor(nowMs / h) * h).toISOString().slice(0, 16);
}

/** The per-run temp file (JSON). */
export interface TrendingFile {
  readonly format: typeof TRENDING_FILE_FORMAT;
  readonly fetched_at: string;
  readonly lookback_hours: number;
  readonly lists: Readonly<Record<TrendingKind, unknown>>;
  readonly warnings: readonly string[];
}

const own = (o: unknown, k: string): unknown =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.prototype.hasOwnProperty.call(o, k)
    ? (o as Record<string, unknown>)[k]
    : undefined;

/** UTF-8 JSON of a body, or undefined. */
export function decodeTrendingJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads and validates a trending temp file; throws on anything malformed. */
export async function readTrendingFile(path: string): Promise<TrendingFile> {
  const st = await stat(path);
  if (!st.isFile() || st.size > 8 * MAX_TRENDING_BYTES)
    throw new Error("sleeper: temp file missing or too large");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const fetched = own(parsed, "fetched_at");
  const lookback = own(parsed, "lookback_hours");
  const lists = own(parsed, "lists");
  const warnings = own(parsed, "warnings");
  if (own(parsed, "format") !== TRENDING_FILE_FORMAT) throw new Error("sleeper: wrong temp format");
  if (typeof fetched !== "string" || !Number.isFinite(Date.parse(fetched)))
    throw new Error("sleeper: temp file is incomplete");
  if (typeof lookback !== "number" || !Number.isInteger(lookback) || lookback < 1)
    throw new Error("sleeper: temp file is incomplete");
  return {
    format: TRENDING_FILE_FORMAT,
    fetched_at: new Date(Date.parse(fetched)).toISOString(),
    lookback_hours: lookback,
    lists: { add: own(lists, "add") ?? null, drop: own(lists, "drop") ?? null },
    warnings: Array.isArray(warnings)
      ? warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}

/** The rows of one list, plus what was refused (counts only — never a value from the body). */
export function trendingRowsOf(
  body: unknown,
  kind: TrendingKind,
  lookbackHours: number,
  asOf: string,
): {
  readonly rows: DatasetRow[];
  readonly refused: number;
  readonly duplicates: number;
  readonly over_cap: number;
} {
  const rows: DatasetRow[] = [];
  let refused = 0;
  let duplicates = 0;
  if (!Array.isArray(body)) return { rows, refused: 0, duplicates: 0, over_cap: 0 };
  const seen = new Set<string>();
  const entries = body.slice(0, MAX_TRENDING_ENTRIES);
  entries.forEach((e: unknown, i) => {
    const id = sleeperPlayerId(own(e, "player_id"));
    const count = nonNegativeInt(own(e, "count"));
    if (id === null || count === null) {
      refused++;
      return;
    }
    if (seen.has(id)) {
      duplicates++;
      return;
    }
    seen.add(id);
    rows.push(
      Object.freeze({
        kind,
        sleeper_id: id,
        rank: i + 1,
        count,
        lookback_hours: lookbackHours,
        as_of: asOf,
      }),
    );
  });
  return { rows, refused, duplicates, over_cap: Math.max(0, body.length - MAX_TRENDING_ENTRIES) };
}

/** Every row of a temp file, plus warnings. */
export function buildTrendingRows(file: TrendingFile): { rows: DatasetRow[]; warnings: string[] } {
  const rows: DatasetRow[] = [];
  const warnings = [...file.warnings];
  for (const kind of TRENDING_KINDS) {
    const r = trendingRowsOf(file.lists[kind], kind, file.lookback_hours, file.fetched_at);
    rows.push(...r.rows);
    if (r.refused > 0)
      warnings.push(
        `${kind}: ${String(r.refused)} entr(y/ies) without a valid player_id or count were refused`,
      );
    if (r.duplicates > 0)
      warnings.push(`${kind}: ${String(r.duplicates)} repeated player_id(s) kept once`);
    if (r.over_cap > 0)
      warnings.push(`${kind}: ${String(r.over_cap)} entr(y/ies) beyond the ceiling were not read`);
  }
  return { rows, warnings };
}

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The schema assertion (plan 01 §5.5; plan 10 B1): a renamed field is named in missing_columns. */
export function assertTrendingShape(file: TrendingFile): SchemaReport {
  const bad = (w: string): SchemaReport => ({
    ok: false,
    missing_columns: [],
    extra_columns: [],
    bad_codecs: [],
    rows: 0,
    warnings: [...file.warnings, w],
  });
  const present = TRENDING_KINDS.filter((k) => file.lists[k] !== null);
  if (present.length === 0) return bad("neither trending list was fetched");
  const entries: unknown[] = [];
  for (const k of present) {
    const v = file.lists[k];
    if (!Array.isArray(v)) return bad(`the ${k} list is not a JSON array`);
    entries.push(...(v as unknown[]).slice(0, MAX_TRENDING_ENTRIES));
  }
  const missing: string[] = [];
  if (entries.length > 0) {
    if (!entries.some((e) => own(e, "player_id") !== undefined)) missing.push("player_id");
    if (!entries.some((e) => own(e, "count") !== undefined)) missing.push("count");
  }
  const extra = [
    ...new Set(
      entries.flatMap((e) =>
        e !== null && typeof e === "object" && !Array.isArray(e)
          ? Object.keys(e).filter((k) => k !== "player_id" && k !== "count" && SAFE_KEY.test(k))
          : [],
      ),
    ),
  ].sort();
  const built = buildTrendingRows(file);
  const warnings = [...built.warnings];
  for (const c of extra) warnings.push(`extra field ${c}`);
  if (entries.length === 0) warnings.push("both trending lists are empty");
  return {
    ok: missing.length === 0,
    missing_columns: missing,
    extra_columns: extra,
    bad_codecs: [],
    rows: built.rows.length,
    warnings,
  };
}

/** Whether a failure is an upstream outage (the attempt fails and the runner retries). */
function isOutage(e: unknown): boolean {
  return e instanceof HttpError && !POLICY_KINDS.has(e.kind) && e.kind !== "aborted";
}

/** Builds the `sleeper:trending` DataSource. */
export function createSleeperTrendingSource(): DataSource {
  const info = SOURCE_REGISTRY["sleeper:trending"];
  return Object.freeze({
    id: "sleeper:trending",
    license: info.license,
    attribution: info.attribution,
    freshness: info.freshness,
    job: info.job,
    limiter: SOURCE_RATE_LIMITS.sleeper,
    versioning: "time_bucket",
    seasonGate: "in_season",
    tables: Object.freeze([DS_TRENDING]),

    version(ctx: SourceContext): Promise<ReleaseVersion | null> {
      return Promise.resolve({ version: halfHourBucket(ctx.clock.nowMs()), released_at: null });
    },

    async fetch(_version: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> {
      const lists: Record<TrendingKind, unknown> = { add: null, drop: null };
      const warnings: string[] = [];
      let successes = 0;
      for (const kind of TRENDING_KINDS) {
        if (ctx.signal.aborted) throw new HttpError({ kind: "aborted" });
        try {
          const res = await ctx.http(sleeperTrendingUrl(kind), {
            signal: ctx.signal,
            maxBytes: MAX_TRENDING_BYTES,
            accept: "application/json",
          });
          const body = decodeTrendingJson(res.body);
          if (body === undefined) {
            warnings.push(`${kind}: the response is not valid JSON`);
            continue;
          }
          lists[kind] = body;
          successes++;
        } catch (e) {
          if (e instanceof HttpError && e.kind === "aborted") throw e;
          if (successes === 0 && kind === TRENDING_KINDS[TRENDING_KINDS.length - 1]) throw e;
          if (successes === 0 && isOutage(e)) throw e;
          warnings.push(`${kind}: ${e instanceof HttpError ? e.kind : "request failed"}`);
        }
      }
      const file: TrendingFile = {
        format: TRENDING_FILE_FORMAT,
        fetched_at: ctx.clock.nowIso(),
        lookback_hours: SLEEPER_TRENDING_REQUEST.lookback_hours,
        lists,
        warnings,
      };
      const path = join(ctx.tempDir, "sleeper.trending.json");
      const text = JSON.stringify(file);
      await writeFile(path, text, { mode: 0o600, flag: "wx" });
      return [{ path, bytes: Buffer.byteLength(text), season: null }];
    },

    async assertSchema(files: readonly TempFile[]): Promise<SchemaReport> {
      const first = files[0];
      const fail = (w: string): SchemaReport => ({
        ok: false,
        missing_columns: [],
        extra_columns: [],
        bad_codecs: [],
        rows: 0,
        warnings: [w],
      });
      if (files.length !== 1 || first === undefined)
        return fail("expected exactly one trending file");
      try {
        return assertTrendingShape(await readTrendingFile(first.path));
      } catch {
        return fail("the trending file is unreadable");
      }
    },

    async publish(files: readonly TempFile[], into: DatasetWriter): Promise<PublishStats> {
      const first = files[0];
      if (first === undefined) throw new Error("sleeper: nothing to publish");
      const { rows } = buildTrendingRows(await readTrendingFile(first.path));
      into.createTable(DS_TRENDING);
      const n = rows.length === 0 ? 0 : into.insert(DS_TRENDING.name, rows);
      return {
        rows: n,
        tables: [{ name: DS_TRENDING.name, rows: n }],
        seasons: [],
        columns_hash: contractColumnsHash("sleeper:trending"),
      };
    },
  });
}
