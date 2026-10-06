// helpers.ts — news-source test plumbing: the committed feed captures (fixtures/news/captured, real
// titles/links/guids/dates of 2026-10-06 with descriptions replaced), the hand-labelled set, the
// fixture-roster universe, a synthetic RSS builder for hostile feeds, and a fake HttpGet that serves
// bytes by URL (no network: the real src/http client is not used here — its allow-list belongs to
// the http module). The publisher writes into a real in-memory STRICT sqlite (tests/sources/weather).
import { readFileSync } from "node:fs";
import { isNflTeam } from "../../../src/config/schema.js";
import { HttpError } from "../../../src/http/errors.js";
import type { NewsUniversePlayer } from "../../../src/sources/news/match.js";
import type { HttpGet } from "../../../src/sources/source.js";

const ROOT = new URL("../../../", import.meta.url);

/** A committed fixture's text. */
export function fixtureText(rel: string): string {
  return readFileSync(new URL(rel, ROOT), "utf8");
}

/** The three captured feeds, as committed. */
export const CAPTURED = {
  rotowire: (): string => fixtureText("fixtures/news/captured/rotowire.xml"),
  espn: (): string => fixtureText("fixtures/news/captured/espn.xml"),
  cbs: (): string => fixtureText("fixtures/news/captured/cbs.xml"),
} as const;

/** "Now" of the capture (2026-10-06 ~19:53Z) plus a little. */
export const NEWS_NOW = "2026-10-06T20:00:00.000Z";
export const NEWS_NOW_MS = Date.parse(NEWS_NOW);

/** One labelled item (fixtures/news/labelled/items.json). */
export interface LabelledItem {
  readonly n: number;
  readonly feed: "rotowire" | "espn" | "cbs";
  readonly guid: string;
  readonly title: string;
  readonly claim: { readonly type: string; readonly direction: string } | null;
  readonly players: readonly number[];
  readonly why: string;
}

/** The labelled set. */
export function labelledItems(file = "fixtures/news/labelled/items.json"): readonly LabelledItem[] {
  const doc = JSON.parse(fixtureText(file)) as { items: LabelledItem[] };
  return doc.items;
}

interface RosterPlayer {
  readonly kind: string;
  readonly espn_id: number;
  readonly espn_name: string;
  readonly team: string;
  readonly espn_team: string;
  readonly gsis_id: string | null;
}

/** The fixture roster's players as a matcher universe (nflverse team; FA → null). */
export function rosterUniverse(): NewsUniversePlayer[] {
  const doc = JSON.parse(fixtureText("fixtures/players/fixture-roster.json")) as {
    players: RosterPlayer[];
  };
  return doc.players
    .filter((p) => p.kind === "player")
    .map((p) => ({
      espn_id: p.espn_id,
      full_name: p.espn_name,
      team: p.espn_team !== "FA" && isNflTeam(p.team) ? p.team : null,
      gsis_id: p.gsis_id,
    }));
}

/** One synthetic item. */
export interface SynthItem {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly link?: string | null;
  readonly guid?: string | null;
  readonly pubDate?: string | null;
  /** Raw XML appended inside the item. */
  readonly extra?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A synthetic RSS 2.0 document (text XML-escaped unless `raw` is set). */
export function rss(
  items: readonly SynthItem[],
  opts: { raw?: boolean; head?: string } = {},
): string {
  const f = (tag: string, v: string | null | undefined): string =>
    v === undefined || v === null ? "" : `<${tag}>${opts.raw === true ? v : esc(v)}</${tag}>`;
  const body = items
    .map(
      (it, i) =>
        `<item>${f("title", it.title === undefined ? `Item ${String(i)}` : it.title)}${f(
          "link",
          it.link === undefined
            ? `https://www.rotowire.com/football/player/x-${String(i)}`
            : it.link,
        )}${f("description", it.description)}${f("guid", it.guid === undefined ? `g${String(i)}` : it.guid)}${f(
          "pubDate",
          it.pubDate === undefined ? "Tue, 06 Oct 2026 18:00:00 GMT" : it.pubDate,
        )}${it.extra ?? ""}</item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>${opts.head ?? ""}<rss version="2.0"><channel><title>T</title>${body}</channel></rss>`;
}

/** A fake HttpGet serving each URL's body (a function may throw an HttpError). */
export function fakeGet(
  routes: Readonly<Record<string, string | Uint8Array | (() => string | Uint8Array)>>,
): HttpGet & { readonly calls: string[]; readonly accepts: (string | undefined)[] } {
  const calls: string[] = [];
  const accepts: (string | undefined)[] = [];
  const get = (url: string, opts: { readonly maxBytes: number; readonly accept?: string }) => {
    calls.push(url);
    accepts.push(opts.accept);
    const r = routes[url];
    if (r === undefined) return Promise.reject(new HttpError({ kind: "http_4xx", status: 404 }));
    let v: string | Uint8Array;
    try {
      v = typeof r === "function" ? r() : r;
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error("route failed"));
    }
    const body = typeof v === "string" ? new TextEncoder().encode(v) : v;
    if (body.byteLength > opts.maxBytes)
      return Promise.reject(new HttpError({ kind: "too_large" }));
    return Promise.resolve({ status: 200, body, headers: {}, final_url: url });
  };
  return Object.assign(get, { calls, accepts });
}

/** Every string leaf of a value outside an `untrusted_text.value`, with its path. */
export function bareStrings(
  v: unknown,
  path = "$",
  out: [string, string][] = [],
): [string, string][] {
  if (typeof v === "string") {
    out.push([path, v]);
    return out;
  }
  if (typeof v !== "object" || v === null) return out;
  if (Array.isArray(v)) {
    v.forEach((x, i) => bareStrings(x, `${path}[${String(i)}]`, out));
    return out;
  }
  const o = v as Record<string, unknown>;
  const inner = o.untrusted_text;
  if (Object.keys(o).length === 1 && typeof inner === "object" && inner !== null) {
    const i = inner as Record<string, unknown>;
    // the wrapper's own metadata (source tag, flags) is a closed vocabulary; the value is the text
    if (typeof i.source === "string") out.push([`${path}.untrusted_text.source`, i.source]);
    return out;
  }
  for (const [k, x] of Object.entries(o)) bareStrings(x, `${path}.${k}`, out);
  return out;
}
