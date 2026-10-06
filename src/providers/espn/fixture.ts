// fixture.ts — fixture mode's transport (plan 05 §3.1 step 5): a `fetch` that serves the recorded,
// scrubbed fixtures (fixtures/espn/recorded, indexed by fixtures/espn/manifest.json) keyed by route
// path + views + scoringPeriodId + canonical filter, with the recorded status and headers; a split
// response is re-assembled (its array concatenated in part order). A request with no fixture is a
// distinct error naming the request path (league id 0 in this mode — no identifier); a request that
// carries a Cookie header is refused: fixture mode and real cookies never coexist in one process.
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./filter.js";
import { HEADER_FILTER } from "./types.js";
import type { FetchLike } from "./transport.js";

/** One manifest file entry, as far as fixture mode reads it. */
interface ManifestFile {
  readonly path: string;
  readonly league: string | null;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly request: {
    readonly route: string;
    readonly path: string;
    readonly query: string;
    readonly filter: unknown;
  };
  readonly part: { readonly index: number; readonly of: number; readonly array: string } | null;
}

/** Fixture mode refused or could not serve a request (never retried; INTERNAL to a tool). */
export class FixtureError extends Error {
  readonly effCode = "INTERNAL" as const;
  readonly effDetails: { readonly reason: string };
  constructor(reason: "fixture_missing" | "fixture_cookie_refused", detail: string) {
    super(`fixture mode: ${reason} (${detail})`);
    this.name = "FixtureError";
    this.effDetails = Object.freeze({ reason });
  }
}

function queryKey(query: string): string {
  const params = new URLSearchParams(query);
  const views = params.getAll("view").sort();
  const sp = params.get("scoringPeriodId");
  return `${views.join(",")}|${sp ?? "-"}`;
}

function filterKey(filter: unknown): string {
  return filter === null || filter === undefined ? "-" : canonicalJson(filter);
}

/**
 * Composes view bodies the way ESPN does (research 03 §A.2: views compose additively into one
 * object): objects merge key by key, arrays of `id`-keyed objects merge by id (first body's order),
 * anything else keeps the first body's value.
 */
export function composeBodies(a: unknown, b: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? composeBodies(a[k], v) : v;
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const all: unknown[] = [...(a as unknown[]), ...(b as unknown[])];
    if (!all.every((x) => isObj(x) && "id" in x)) return a;
    const byId = new Map<unknown, unknown>();
    for (const x of a as Record<string, unknown>[]) byId.set(x.id, x);
    for (const x of b as Record<string, unknown>[])
      byId.set(x.id, byId.has(x.id) ? composeBodies(byId.get(x.id), x) : x);
    return [...byId.values()];
  }
  return a;
}

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

/** Options: the `fixtures/espn` directory (absolute) and the recorded league slot to serve. */
export interface FixtureFetchOptions {
  readonly dir: string;
  readonly league: string;
  /** The manifest file name inside `dir` (default `manifest.json`). */
  readonly manifest?: string;
}

/** Builds fixture mode's `fetch` over the recorded fixtures of one league slot. */
export function createFixtureFetch(opts: FixtureFetchOptions): FetchLike {
  if (!path.isAbsolute(opts.dir)) throw new RangeError("fixture mode: dir must be absolute");
  const manifest = JSON.parse(
    readFileSync(path.join(opts.dir, opts.manifest ?? "manifest.json"), "utf8"),
  ) as { files: ManifestFile[] };
  const groups = new Map<string, ManifestFile[]>();
  for (const f of manifest.files) {
    if (f.request.route === "league" || f.request.route === "communication") {
      if (f.league !== opts.league) continue;
    } else if (f.league !== null) continue;
    if (f.path.startsWith("recorded/errors/")) continue;
    const key = `${f.request.path}|${queryKey(f.request.query)}|${filterKey(f.request.filter)}`;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const bodies = new Map<string, string>();
  const bodyOf = (files: readonly ManifestFile[]): string => {
    const id = files[0]?.path ?? "";
    const cached = bodies.get(id);
    if (cached !== undefined) return cached;
    const sorted = [...files].sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
    const parts = sorted.map(
      (f) => JSON.parse(readFileSync(path.join(opts.dir, f.path), "utf8")) as unknown,
    );
    let body: unknown = parts[0];
    const arr = sorted[0]?.part?.array;
    if (arr !== undefined && parts.length > 1) {
      if (arr === "$") body = parts.flatMap((p) => p as unknown[]);
      else {
        const base = { ...(parts[0] as Record<string, unknown>) };
        base[arr] = parts.flatMap((p) => (p as Record<string, unknown[]>)[arr] ?? []);
        body = base;
      }
    }
    const text = JSON.stringify(body);
    bodies.set(id, text);
    return text;
  };
  return (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (headerOf(init, "cookie") !== null)
      return Promise.reject(new FixtureError("fixture_cookie_refused", u.pathname));
    const rawFilter = headerOf(init, HEADER_FILTER.toLowerCase());
    let filter: unknown = null;
    try {
      filter = rawFilter === null ? null : (JSON.parse(rawFilter) as unknown);
    } catch {
      filter = rawFilter;
    }
    const query = u.search.slice(1);
    const missing = (): Promise<Response> =>
      Promise.reject(new FixtureError("fixture_missing", `${u.pathname}?${query}`));
    const files = groups.get(`${u.pathname}|${queryKey(query)}|${filterKey(filter)}`);
    const first = files?.[0];
    if (files !== undefined && first !== undefined) {
      return Promise.resolve(
        new Response(bodyOf(files), { status: first.status, headers: { ...first.headers } }),
      );
    }
    // a composite request with no composite recording: compose the solo recordings of its views
    const params = new URLSearchParams(query);
    const views = params.getAll("view");
    if (views.length < 2 || filter !== null) return missing();
    const sp = params.get("scoringPeriodId");
    const solos = views.map((v) => groups.get(`${u.pathname}|${v}|${sp ?? "-"}|-`));
    if (solos.some((f) => f === undefined || f.length === 0 || f[0]?.status !== 200))
      return missing();
    const present = solos as ManifestFile[][];
    const body = present
      .map((f) => JSON.parse(bodyOf(f)) as unknown)
      .reduce((acc, b) => composeBodies(acc, b));
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { ...present[0]?.[0]?.headers } }),
    );
  };
}
