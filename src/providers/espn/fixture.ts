// fixture.ts — fixture mode's transport (plan 05 §3.1 step 5): a `fetch` that serves the recorded,
// scrubbed fixtures (fixtures/espn/recorded, indexed by fixtures/espn/manifest.json) keyed by route
// path + views + scoringPeriodId + canonical filter, with the recorded status and headers; a split
// response is re-assembled (its array concatenated in part order). A request with no fixture is a
// distinct error naming the request path (league id 0 in this mode — no identifier); a request that
// carries a Cookie header is refused: fixture mode and real cookies never coexist in one process.
// Every manifest file path is read through derivedFileText, the one resolver both fixture fetches
// share (the round-4d verifier's F1: the recorded fetch had no path check): a manifest with an
// empty, absolute or `..` path fails at load, and a symlink out of the tree or an oversized file is
// a fixture_missing read, never its contents.
import { readFileSync, realpathSync, statSync } from "node:fs";
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

/** Largest fixture body or patch file read (the fx-10h pool is ~3 MB). */
export const DERIVED_FILE_MAX_BYTES = 32 * 1024 * 1024;

/** A manifest file the path rules or the size bound refuse (derivedFileText, derivedRootDir). */
export class DerivedFileRefused extends RangeError {}

/** A manifest path no fixture fetch reads: empty, absolute (POSIX or Windows form) or with `..`. */
function lexicallyRefused(rel: unknown): boolean {
  return (
    typeof rel !== "string" ||
    rel === "" ||
    path.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    rel.split(/[\\/]/).includes("..")
  );
}

/**
 * The text of `rel` under a manifest's `root` — the ONE path resolver the recorded fixture fetch,
 * the derived fixture fetch and the derived publicity read share, so their rules cannot drift apart
 * (the round-4b review's F3; the recorded fetch since round 4d, F1): never an empty, absolute or
 * `..` path, never a path that resolves to `root` itself or outside it — also after symlinks are
 * resolved, so a link inside `root` cannot point out of it (the round-4c verifier's CR-3) — never a
 * file over DERIVED_FILE_MAX_BYTES (its size is read before its bytes are). A refusal throws
 * DerivedFileRefused; a file that cannot be read throws the read's own error.
 */
export function derivedFileText(root: string, rel: string): string {
  if (lexicallyRefused(rel)) throw new DerivedFileRefused("manifest path refused");
  const lexical = path.resolve(root, rel);
  if (!lexical.startsWith(root + path.sep)) throw new DerivedFileRefused("manifest path refused");
  const abs = realpathSync(lexical);
  if (!abs.startsWith(realpathSync(root) + path.sep))
    throw new DerivedFileRefused("manifest path refused");
  if (statSync(abs).size > DERIVED_FILE_MAX_BYTES)
    throw new DerivedFileRefused("fixture file too large");
  const text = readFileSync(abs, "utf8");
  if (text.length > DERIVED_FILE_MAX_BYTES) throw new DerivedFileRefused("fixture file too large");
  return text;
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
  const dir = path.resolve(opts.dir);
  const manifest = JSON.parse(
    readFileSync(path.join(dir, opts.manifest ?? "manifest.json"), "utf8"),
  ) as { files: ManifestFile[] };
  // a bad manifest fails at load, before any request (every entry, served or not)
  if (manifest.files.some((f) => lexicallyRefused(f.path)))
    throw new RangeError("fixture mode: manifest path refused");
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
    const parts = sorted.map((f) => {
      let text: string;
      try {
        text = derivedFileText(dir, f.path);
      } catch (e) {
        if (e instanceof DerivedFileRefused) throw new FixtureError("fixture_missing", e.message);
        throw e;
      }
      return JSON.parse(text) as unknown;
    });
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
  const handle = (url: string, init: RequestInit): Promise<Response> => {
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
  // a refused or unreadable file is a rejected answer, never a throw out of `fetch`
  return (url: string, init: RequestInit): Promise<Response> => {
    try {
      return handle(url, init);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
}
