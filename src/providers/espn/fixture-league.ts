// fixture-league.ts — fixture mode over a DERIVED fixture league (plan 05 §3 fixture law class 2;
// plan 09 §4 `fx-10h`; plan 10 §3.1a *Fixtures*, A3a): a directory whose manifest.json has
// `kind: "derived_league"` (written by scripts/gen-fixtures.ts) is served by view, scoring period
// and season rather than by exact recorded request, so every tool argument the Skills and the
// end-to-end suite use is answerable: `kona_player_info` is filtered, sorted and paged from one pool
// file (filterIds / filterStatus / filterSlotIds; the sorts the provider's filter builder emits),
// `mBoxscore` honours its matchup-period filter, `mTransactions2` its type filter and period, and a
// composite request composes its views. A variant's bodies are the base bodies plus a JSON patch
// (RFC 6902 add / remove / replace; paths as pointers or segment arrays). The manifest's `clock` is
// the league's frozen instant (`derivedLeagueClock`; serve starts a running clock there in fixture
// mode only).
//
// Same guarantees as the recorded fixture fetch: no network, a Cookie header is refused, an
// unanswerable request is a FixtureError naming the path (league id 0), every file path stays inside
// the manifest's root, and patch pointers can never reach a prototype.
import { readFileSync } from "node:fs";
import path from "node:path";
import { FixtureError, composeBodies } from "./fixture.js";
import { HEADER_FILTER, HEADER_PLAYER_COUNT, HEADER_TRANSACTION_COUNT } from "./types.js";
import type { FetchLike } from "./transport.js";

/** The manifest `kind` of a derived league. */
export const DERIVED_LEAGUE_KIND = "derived_league";
/** Largest body or patch file read (the fx-10h pool is ~3 MB). */
export const DERIVED_FILE_MAX_BYTES = 32 * 1024 * 1024;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = Record<string, Json>;

/** One view a derived manifest serves. */
export interface DerivedView {
  readonly route: "league" | "season" | "players";
  readonly season: number;
  readonly views: readonly string[];
  readonly scoringPeriodId: number | null;
  readonly path: string;
  readonly patch?: string;
  readonly pool?: boolean;
}

/** The parts of a derived manifest fixture mode reads. */
export interface DerivedManifest {
  readonly kind: typeof DERIVED_LEAGUE_KIND;
  readonly league: string;
  readonly season: number;
  readonly clock: string | null;
  readonly root: string;
  readonly views: readonly DerivedView[];
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads `dir/manifest.json`; null when absent, unreadable or not a derived league. */
export function readDerivedManifest(dir: string): DerivedManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.kind !== DERIVED_LEAGUE_KIND) return null;
  const views = Array.isArray(raw.views) ? raw.views.filter(isObject) : [];
  return {
    kind: DERIVED_LEAGUE_KIND,
    league: typeof raw.league === "string" ? raw.league : "derived",
    season: typeof raw.season === "number" ? raw.season : 0,
    clock: typeof raw.clock === "string" ? raw.clock : null,
    root: typeof raw.root === "string" ? raw.root : ".",
    views: views.map((v) => ({
      route: v.route === "season" || v.route === "players" ? v.route : "league",
      season: typeof v.season === "number" ? v.season : 0,
      views: Array.isArray(v.views)
        ? v.views.filter((x): x is string => typeof x === "string")
        : [],
      scoringPeriodId: typeof v.scoringPeriodId === "number" ? v.scoringPeriodId : null,
      path: typeof v.path === "string" ? v.path : "",
      ...(typeof v.patch === "string" ? { patch: v.patch } : {}),
      ...(v.pool === true ? { pool: true } : {}),
    })),
  };
}

/** The derived league's frozen instant (epoch ms), or null (not derived, or no valid clock). */
export function derivedLeagueClock(dir: string): number | null {
  const clock = readDerivedManifest(dir)?.clock ?? null;
  if (clock === null) return null;
  const t = Date.parse(clock);
  return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}T/.test(clock) ? t : null;
}

// --- JSON patch (RFC 6902 subset) ---------------------------------------------------------------------

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A path's segments: an RFC 6901 pointer string, or (the generator's form) an array of keys and
 * array indices — a `/…/home/…` pointer through a matchup's home side reads like a home directory
 * to the repository's secret scanner. Prototype keys are refused either way.
 */
function segments(path: unknown): string[] {
  let segs: string[];
  if (typeof path === "string") {
    if (path === "") return [];
    if (!path.startsWith("/")) throw new RangeError("patch: a pointer starts with /");
    segs = path
      .slice(1)
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  } else if (Array.isArray(path)) {
    segs = path.map((s) => {
      if (typeof s === "number" && Number.isSafeInteger(s) && s >= 0) return String(s);
      if (typeof s === "string") return s;
      throw new RangeError("patch: a path segment is a key or an index");
    });
  } else throw new RangeError("patch: bad op");
  for (const seg of segs)
    if (FORBIDDEN_SEGMENTS.has(seg)) throw new RangeError("patch: forbidden pointer segment");
  return segs;
}

function indexOf(seg: string, length: number, allowEnd: boolean): number {
  if (allowEnd && seg === "-") return length;
  if (!/^(0|[1-9][0-9]{0,6})$/.test(seg)) throw new RangeError("patch: bad array index");
  const i = Number(seg);
  if (i > (allowEnd ? length : length - 1)) throw new RangeError("patch: array index out of range");
  return i;
}

/** Applies add / remove / replace ops to a copy of `doc`; anything else (or a bad pointer) throws. */
export function applyJsonPatch(doc: unknown, ops: unknown): unknown {
  if (!Array.isArray(ops)) throw new RangeError("patch: ops must be an array");
  let root = structuredClone(doc) as Json;
  for (const raw of ops) {
    if (!isObject(raw)) throw new RangeError("patch: bad op");
    const op = raw.op;
    if (op !== "add" && op !== "remove" && op !== "replace")
      throw new RangeError("patch: unsupported op");
    const segs = segments(raw.path);
    if ((op === "add" || op === "replace") && !Object.hasOwn(raw, "value"))
      throw new RangeError("patch: op needs a value");
    const value = raw.value ?? null;
    if (segs.length === 0) {
      if (op === "remove") throw new RangeError("patch: cannot remove the root");
      root = structuredClone(value);
      continue;
    }
    let parent: Json = root;
    for (const seg of segs.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[indexOf(seg, parent.length, false)] ?? null;
      else if (isObject(parent) && Object.hasOwn(parent, seg)) parent = parent[seg] ?? null;
      else throw new RangeError("patch: path not found");
    }
    const last = segs[segs.length - 1] ?? "";
    if (Array.isArray(parent)) {
      const i = indexOf(last, parent.length, op === "add");
      if (op === "add") parent.splice(i, 0, structuredClone(value));
      else if (op === "remove") parent.splice(i, 1);
      else parent[i] = structuredClone(value);
    } else if (isObject(parent)) {
      if (op !== "add" && !Object.hasOwn(parent, last))
        throw new RangeError("patch: path not found");
      if (op === "remove") Reflect.deleteProperty(parent, last);
      else
        Object.defineProperty(parent, last, {
          value: structuredClone(value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    } else throw new RangeError("patch: path not found");
  }
  return root;
}

// --- the pool --------------------------------------------------------------------------------------

interface PoolFile {
  readonly response: JsonObject;
  readonly entries: readonly JsonObject[];
}

const playerOf = (e: JsonObject): JsonObject => (isObject(e.player) ? e.player : {});
const numberOr = (v: Json | undefined, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

function statTotal(e: JsonObject, source: number, split: number, sp: number): number | null {
  const stats = playerOf(e).stats;
  if (!Array.isArray(stats)) return null;
  for (const s of stats) {
    if (!isObject(s)) continue;
    if (s.statSourceId === source && s.statSplitTypeId === split && s.scoringPeriodId === sp)
      return numberOr(s.appliedTotal, 0);
  }
  return null;
}

/** The sort key value of an entry (the provider's PLAYER_SORT_MAP keys; research 03 §A.3). */
function sortValue(e: JsonObject, key: string, value: Json | undefined, season: number): number {
  const p = playerOf(e);
  const own = isObject(p.ownership) ? p.ownership : {};
  switch (key) {
    case "sortPercOwned":
      return numberOr(own.percentOwned, 0);
    case "sortPercChanged":
      return numberOr(own.percentChange, 0);
    case "sortDraftRanks": {
      const ranks = isObject(p.draftRanksByRankType) ? p.draftRanksByRankType : {};
      const r = isObject(ranks[typeof value === "string" ? value : "STANDARD"])
        ? (ranks[typeof value === "string" ? value : "STANDARD"] as JsonObject)
        : {};
      return numberOr(r.rank, Number.MAX_SAFE_INTEGER);
    }
    case "sortAppliedStatTotal": {
      const v = typeof value === "string" ? value : "";
      const s = String(season);
      if (v.startsWith(`11${s}`) && v.length > 2 + s.length)
        return statTotal(e, 1, 1, Number(v.slice(2 + s.length))) ?? 0;
      if (v === `10${s}`) return statTotal(e, 1, 0, 0) ?? 0;
      if (v === `00${s}`) return statTotal(e, 0, 0, 0) ?? 0;
      throw new FixtureError("fixture_missing", `unsupported sortAppliedStatTotal ${v}`);
    }
    default:
      throw new FixtureError("fixture_missing", `unsupported pool sort ${key}`);
  }
}

const listOf = (v: Json | undefined): Json[] =>
  isObject(v) && Array.isArray(v.value) ? v.value : [];

/** Answers one kona_player_info filter over the pool (filtered, sorted, paged; splits trimmed). */
export function poolQuery(
  pool: PoolFile,
  filter: unknown,
  sp: number | null,
  season: number,
): { body: JsonObject; total: number } {
  const f = isObject(filter) && isObject(filter.players) ? filter.players : {};
  let list = [...pool.entries];
  if (f.filterIds !== undefined) {
    const ids = new Set(listOf(f.filterIds));
    list = list.filter((e) => ids.has(e.id ?? null));
  }
  if (f.filterStatus !== undefined) {
    const st = new Set(listOf(f.filterStatus));
    list = list.filter((e) => st.has(e.status ?? null));
  }
  if (f.filterSlotIds !== undefined) {
    const slots = new Set(listOf(f.filterSlotIds));
    list = list.filter((e) => {
      const el = playerOf(e).eligibleSlots;
      return Array.isArray(el) && el.some((x) => slots.has(x));
    });
  }
  if (isObject(f.filterActive) && f.filterActive.value === true)
    list = list.filter((e) => playerOf(e).active !== false);
  const sorts = Object.entries(f)
    .filter(([k, v]) => k.startsWith("sort") && isObject(v))
    .map(([k, v]) => {
      const o = v as JsonObject;
      return {
        key: k,
        asc: o.sortAsc === true,
        priority: numberOr(o.sortPriority, 1000),
        value: o.value,
      };
    })
    .sort((a, b) => a.priority - b.priority);
  const keyed = list.map((e) => ({ e, k: sorts.map((s) => sortValue(e, s.key, s.value, season)) }));
  keyed.sort((a, b) => {
    for (const [i, s] of sorts.entries()) {
      const d = (a.k[i] ?? 0) - (b.k[i] ?? 0);
      if (d !== 0) return s.asc ? d : -d;
    }
    return numberOr(a.e.id, 0) - numberOr(b.e.id, 0);
  });
  const total = keyed.length;
  const offset = numberOr(f.offset, 0);
  const limit = f.limit === undefined ? total : numberOr(f.limit, total);
  const page = keyed.slice(offset, offset + limit).map(({ e }) => trimSplits(e, sp));
  return { body: { ...structuredClone(pool.response), players: page }, total };
}

/** Keeps the season splits and weeks sp−1 and sp (the recorded views' rhythm); all when sp is null. */
function trimSplits(e: JsonObject, sp: number | null): JsonObject {
  const out = structuredClone(e);
  if (sp === null) return out;
  const p = isObject(out.player) ? out.player : null;
  if (p !== null && Array.isArray(p.stats))
    p.stats = p.stats.filter(
      (s) =>
        isObject(s) &&
        (s.scoringPeriodId === 0 || s.scoringPeriodId === sp || s.scoringPeriodId === sp - 1),
    );
  return out;
}

// --- the fetch -------------------------------------------------------------------------------------

const LEAGUE_RE = /^\/apis\/v3\/games\/ffl\/seasons\/([0-9]{4})\/segments\/0\/leagues\/[0-9]+$/;
const SEASON_RE = /^\/apis\/v3\/games\/ffl\/seasons\/([0-9]{4})$/;
const PLAYERS_RE = /^\/apis\/v3\/games\/ffl\/seasons\/([0-9]{4})\/players$/;

function headerOf(init: RequestInit, name: string): string | null {
  const h = init.headers;
  if (h === undefined) return null;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) {
    const hit = (h as readonly (readonly string[])[]).find(
      (pair) => pair[0]?.toLowerCase() === name,
    );
    return hit?.[1] ?? null;
  }
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v ?? null;
  return null;
}

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json;charset=utf-8",
  "cache-control": "max-age=300",
});

/** Builds fixture mode's `fetch` over a derived fixture league directory. */
export function createDerivedLeagueFetch(opts: { readonly dir: string }): FetchLike {
  if (!path.isAbsolute(opts.dir)) throw new RangeError("fixture mode: dir must be absolute");
  const manifest = readDerivedManifest(opts.dir);
  if (manifest === null) throw new RangeError("fixture mode: not a derived fixture league");
  const root = path.resolve(opts.dir, manifest.root);
  const read = (rel: string): unknown => {
    if (rel === "" || path.isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
      throw new FixtureError("fixture_missing", "manifest path refused");
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep))
      throw new FixtureError("fixture_missing", "manifest path refused");
    const text = readFileSync(abs, "utf8");
    if (text.length > DERIVED_FILE_MAX_BYTES)
      throw new FixtureError("fixture_missing", "fixture file too large");
    return JSON.parse(text) as unknown;
  };
  const cache = new Map<DerivedView, unknown>();
  const bodyOf = (v: DerivedView): unknown => {
    const hit = cache.get(v);
    if (hit !== undefined) return hit;
    let body = read(v.path);
    if (v.patch !== undefined) body = applyJsonPatch(body, read(v.patch));
    cache.set(v, body);
    return body;
  };
  const viewKey = (views: readonly string[]): string => [...views].sort().join(",");
  const find = (route: string, season: number, views: readonly string[], sp: number | null) =>
    manifest.views.find(
      (v) =>
        v.route === route &&
        v.season === season &&
        viewKey(v.views) === viewKey(views) &&
        v.scoringPeriodId === sp,
    );
  const containing = (season: number, view: string, sp: number | null) =>
    manifest.views.find(
      (v) =>
        v.route === "league" &&
        v.season === season &&
        v.views.includes(view) &&
        v.scoringPeriodId === sp,
    ) ??
    manifest.views.find(
      (v) =>
        v.route === "league" &&
        v.season === season &&
        v.views.includes(view) &&
        v.scoringPeriodId === null,
    );
  const respond = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { ...JSON_HEADERS, ...headers } }),
    );

  return (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (headerOf(init, "cookie") !== null)
      return Promise.reject(new FixtureError("fixture_cookie_refused", u.pathname));
    const query = u.search.slice(1);
    const missing = (): Promise<Response> =>
      Promise.reject(new FixtureError("fixture_missing", `${u.pathname}?${query}`));
    const rawFilter = headerOf(init, HEADER_FILTER.toLowerCase());
    let filter: unknown = null;
    if (rawFilter !== null) {
      try {
        filter = JSON.parse(rawFilter) as unknown;
      } catch {
        return missing();
      }
    }
    const params = new URLSearchParams(query);
    const views = params.getAll("view");
    const spRaw = params.get("scoringPeriodId");
    const sp = spRaw !== null && /^[0-9]{1,2}$/.test(spRaw) ? Number(spRaw) : null;
    try {
      const season = (re: RegExp): number | null => {
        const m = re.exec(u.pathname);
        return m === null ? null : Number(m[1]);
      };
      const seasonRoute = season(SEASON_RE);
      if (seasonRoute !== null) {
        const v = find("season", seasonRoute, views, null);
        return v === undefined ? missing() : respond(bodyOf(v));
      }
      const playersRoute = season(PLAYERS_RE);
      if (playersRoute !== null) {
        const v = find("players", playersRoute, views, null);
        return v === undefined ? missing() : respond(bodyOf(v));
      }
      const leagueSeason = season(LEAGUE_RE);
      if (leagueSeason === null || views.length === 0) return missing();
      if (views.length === 1 && views[0] === "kona_player_info") {
        const v = manifest.views.find((x) => x.pool === true && x.season === leagueSeason);
        if (v === undefined) return missing();
        const pool = bodyOf(v) as { response?: unknown; entries?: unknown };
        const entries = Array.isArray(pool.entries) ? pool.entries.filter(isObject) : [];
        const { body, total } = poolQuery(
          { response: isObject(pool.response) ? pool.response : {}, entries },
          filter,
          sp,
          leagueSeason,
        );
        return respond(body, { [HEADER_PLAYER_COUNT]: String(total) });
      }
      let v =
        find("league", leagueSeason, views, sp) ??
        (sp === null ? undefined : find("league", leagueSeason, views, null));
      let body: unknown;
      if (v !== undefined) body = structuredClone(bodyOf(v));
      else {
        const parts = views.map((x) => containing(leagueSeason, x, sp));
        if (parts.some((p) => p === undefined)) return missing();
        body = (parts as DerivedView[])
          .map((p) => structuredClone(bodyOf(p)))
          .reduce((acc, b) => composeBodies(acc, b));
        v = parts[0];
      }
      const headers: Record<string, string> = {};
      if (
        isObject(body) &&
        views.includes("mBoxscore") &&
        isObject(filter) &&
        isObject(filter.schedule)
      ) {
        const ids = new Set(listOf(filter.schedule.filterMatchupPeriodIds));
        if (Array.isArray(body.schedule))
          body.schedule = body.schedule.filter(
            (m) => isObject(m) && ids.has(m.matchupPeriodId ?? null),
          );
      }
      if (isObject(body) && views.includes("mTransactions2") && Array.isArray(body.transactions)) {
        const types =
          isObject(filter) && isObject(filter.transactions)
            ? new Set(listOf(filter.transactions.filterType))
            : null;
        body.transactions = body.transactions.filter(
          (t) =>
            isObject(t) &&
            (types === null || types.has(t.type ?? null)) &&
            (sp === null || t.scoringPeriodId === sp),
        );
        headers[HEADER_TRANSACTION_COUNT] = String(body.transactions.length);
      }
      return respond(body, headers);
    } catch (e) {
      if (e instanceof FixtureError) return Promise.reject(e);
      return Promise.reject(new FixtureError("fixture_missing", `${u.pathname}?${query}`));
    }
  };
}
