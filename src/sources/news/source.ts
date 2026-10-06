// source.ts — the NewsHeadlines DataSources `news:rotowire`, `news:espn`, `news:cbs` (plan 10 §3.2
// "RotoWire/ESPN RSS"; plan 06 §1.3 `refresh news` "every 15 min in season · RSS · ds_news (append,
// dedup, 30-day retention) · warn-only"; plan 01 §5.5 the fetch → assertSchema → publish pipeline;
// tables.ts NEWS_TABLES for every stored column and its derivation; plan 02 §6 — every text field is
// stored only in a column carrying an `rss.<feed>.*` untrusted tag and leaves the store only through
// `newsItemFromRow`'s wrappers; plan 07 D6). Licence `api-terms` (research 04 §E; ESPN's RSS is a
// Disney product, 04 §B.10).
//
// Pipeline. `version()` is the 15-minute UTC bucket (the runner short-circuits a bucket already
// published, so a feed is asked at most once per bucket — plan 01 §6 "RSS every 15 min"). `fetch`
// makes ONE bounded GET, decodes the body, and writes one JSON temp file holding the XML, the fetch
// instant, the matcher universe and the previous file's rows (both read from injected ports — the
// source never opens a dataset file itself). `assertSchema` parses and checks the RSS shape (root,
// channel, item fields), `publish` builds the rows: new items get `first_seen_ms` = the fetch, items
// already in the previous file keep theirs (append + dedup by item id), anything published more than
// NEWS_RETENTION_MS before the fetch is not carried, promotional items and invalid items are dropped
// and counted. Player refs are recomputed for every kept item against the current universe.
// Nothing in an item is ever acted on: the text is stored, matched for ids, and nothing else.
import { writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { GSIS_ID_RE, isNflTeam } from "../../config/schema.js";
import { SOURCE_REGISTRY } from "../../config/freshness.js";
import {
  capText,
  newsItemId,
  NEWS_RETENTION_MS,
  type NewsSource,
} from "../../store/datasets/derive.js";
import {
  contractColumnsHash,
  NEWS_STORAGE_CAPS,
  NEWS_TABLES,
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
import { cleanLink, collapse, isPromo, NEWS_FEEDS, pubDateMs, type NewsFeedSpec } from "./feeds.js";
import { buildPlayerMatcher, type NewsUniversePlayer } from "./match.js";
import {
  decodeBody,
  parseRss,
  RSS_IGNORED_CHILDREN,
  RSS_ITEM_FIELDS,
  type RssItem,
} from "./xml.js";

/** The temp-file format marker (bumped if the shape changes). */
export const NEWS_FILE_FORMAT = "eff-news-v1";
/** Largest RSS body accepted (the real feeds are 3–40 kB). */
export const MAX_RSS_BYTES = 2 * 1024 * 1024;
/** Largest temp file read back (XML + universe + carried rows). */
export const MAX_NEWS_FILE_BYTES = 64 * 1024 * 1024;
/** An item dated further than this past the fetch is refused (a feed cannot pin itself on top). */
export const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
/** At most this many items per file (the newest are kept). */
export const MAX_NEWS_ITEMS = 5_000;
/** At most this many universe players are read (ESPN's active universe is ~2 700). */
export const MAX_UNIVERSE_PLAYERS = 20_000;
/** The statement the wiring reads the CURRENT file's rows with (`NewsSourceOptions.previous`). */
export const PREVIOUS_NEWS_SQL =
  "SELECT item_id, source, published_ms, first_seen_ms, title, blurb, link FROM ds_news";
/** The RSS media types the GET asks for. */
export const RSS_ACCEPT = "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1";

/** What a news source reads besides the feed (injected by the refresh wiring; both optional). */
export interface NewsSourceOptions {
  /** The ESPN player universe with crosswalk gsis ids (ds_players ⨝ crosswalk); absent → no refs. */
  readonly universe?: (ctx: SourceContext) => readonly NewsUniversePlayer[];
  /** The rows of this source's CURRENT `ds_news` (raw, as stored); absent → nothing is carried. */
  readonly previous?: (ctx: SourceContext) => readonly unknown[];
}

/** The per-run temp file (JSON). */
export interface NewsFile {
  readonly format: typeof NEWS_FILE_FORMAT;
  readonly source: NewsSource;
  readonly fetched_ms: number;
  readonly xml: string;
  readonly universe: readonly NewsUniversePlayer[];
  readonly previous: readonly unknown[];
  readonly warnings: readonly string[];
}

/** The 15-minute UTC bucket `YYYY-MM-DDTHH:MM` of an instant — the news sources' version. */
export function quarterHourBucket(nowMs: number): string {
  const q = 15 * 60 * 1000;
  return new Date(Math.floor(nowMs / q) * q).toISOString().slice(0, 16);
}

const own = (o: unknown, k: string): unknown =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.prototype.hasOwnProperty.call(o, k)
    ? (o as Record<string, unknown>)[k]
    : undefined;

/** A universe row read defensively (anything malformed is skipped by the caller). */
export function universePlayerOf(v: unknown): NewsUniversePlayer | null {
  const id = own(v, "espn_id");
  const name = own(v, "full_name");
  const team = own(v, "team");
  const gsis = own(v, "gsis_id");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof name !== "string" || name.length === 0 || name.length > 128) return null;
  return {
    espn_id: id,
    full_name: name,
    team: typeof team === "string" && isNflTeam(team) ? team : null,
    gsis_id: typeof gsis === "string" && GSIS_ID_RE.test(gsis) ? gsis : null,
  };
}

/** Reads and validates a news temp file; throws on anything malformed. */
export async function readNewsFile(path: string, expected: NewsSource): Promise<NewsFile> {
  const st = await stat(path);
  if (!st.isFile() || st.size > MAX_NEWS_FILE_BYTES)
    throw new Error("news: temp file missing or too large");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const fetched = own(parsed, "fetched_ms");
  const xml = own(parsed, "xml");
  const universe = own(parsed, "universe");
  const previous = own(parsed, "previous");
  const warnings = own(parsed, "warnings");
  if (own(parsed, "format") !== NEWS_FILE_FORMAT || own(parsed, "source") !== expected)
    throw new Error("news: temp file has the wrong format or source");
  if (typeof fetched !== "number" || !Number.isSafeInteger(fetched) || typeof xml !== "string")
    throw new Error("news: temp file is incomplete");
  return {
    format: NEWS_FILE_FORMAT,
    source: expected,
    fetched_ms: fetched,
    xml,
    universe: Array.isArray(universe)
      ? universe.map(universePlayerOf).filter((p): p is NewsUniversePlayer => p !== null)
      : [],
    previous: Array.isArray(previous) ? previous : [],
    warnings: Array.isArray(warnings)
      ? warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}

/** One kept item, before the refs. */
interface ItemRow {
  readonly item_id: string;
  readonly source: NewsSource;
  readonly published_ms: number;
  first_seen_ms: number;
  readonly title: string;
  readonly blurb: string | null;
  readonly link: string | null;
}

/** Why an item was not kept. */
type DropReason = "invalid" | "promo" | "expired" | "future";

/** An item of the feed as a row (or why not). */
export function itemRowOf(
  it: RssItem,
  source: NewsSource,
  fetchedMs: number,
): { readonly row: ItemRow } | { readonly drop: DropReason } {
  const title = capText(collapse(it.title), NEWS_STORAGE_CAPS.title);
  const link = cleanLink(it.link);
  const guid = collapse(it.guid);
  const published = pubDateMs(it.pubDate);
  const id = newsItemId(source, guid, link);
  if (title === null || id === null || published === null) return { drop: "invalid" };
  if (isPromo(title)) return { drop: "promo" };
  if (published < fetchedMs - NEWS_RETENTION_MS) return { drop: "expired" };
  if (published > fetchedMs + FUTURE_SKEW_MS) return { drop: "future" };
  return {
    row: {
      item_id: id,
      source,
      published_ms: published,
      first_seen_ms: fetchedMs,
      title,
      blurb: capText(collapse(it.description), NEWS_STORAGE_CAPS.blurb),
      link,
    },
  };
}

const ITEM_ID_RE = /^[0-9a-f]{32}$/;
const msOk = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 32_503_680_000_000;

/** A previous file's row re-validated and re-capped (a corrupt or forged file is data too). */
export function previousRowOf(v: unknown, source: NewsSource): ItemRow | null {
  const id = own(v, "item_id");
  const src = own(v, "source");
  const pub = own(v, "published_ms");
  const first = own(v, "first_seen_ms");
  const title = capText(own(v, "title"), NEWS_STORAGE_CAPS.title);
  const blurbRaw = own(v, "blurb");
  const linkRaw = own(v, "link");
  if (typeof id !== "string" || !ITEM_ID_RE.test(id) || src !== source) return null;
  if (!msOk(pub) || !msOk(first) || title === null) return null;
  if (blurbRaw !== null && blurbRaw !== undefined && typeof blurbRaw !== "string") return null;
  if (linkRaw !== null && linkRaw !== undefined && typeof linkRaw !== "string") return null;
  return {
    item_id: id,
    source,
    published_ms: pub,
    first_seen_ms: first,
    title,
    blurb: capText(blurbRaw, NEWS_STORAGE_CAPS.blurb),
    link: typeof linkRaw === "string" ? cleanLink(linkRaw) : null,
  };
}

/** The rows of one file, plus the counts behind its warnings. */
export interface NewsBuild {
  readonly news: readonly DatasetRow[];
  readonly refs: readonly DatasetRow[];
  readonly counts: Readonly<
    Record<DropReason | "carried" | "new" | "bad_previous" | "over_cap", number>
  >;
  readonly warnings: readonly string[];
}

/** Builds the `ds_news` and `ds_news_players` rows of a temp file (pure, deterministic). */
export function buildNewsRows(file: NewsFile, opts: { readonly refs?: boolean } = {}): NewsBuild {
  const doc = parseRss(file.xml);
  const counts = {
    invalid: 0,
    promo: 0,
    expired: 0,
    future: 0,
    carried: 0,
    new: 0,
    bad_previous: 0,
    over_cap: 0,
  };
  const kept = new Map<string, ItemRow>();
  for (const prev of file.previous) {
    const r = previousRowOf(prev, file.source);
    if (r === null) {
      counts.bad_previous++;
      continue;
    }
    if (r.published_ms < file.fetched_ms - NEWS_RETENTION_MS) {
      counts.expired++;
      continue;
    }
    if (r.published_ms > file.fetched_ms + FUTURE_SKEW_MS || isPromo(r.title)) {
      counts.bad_previous++;
      continue;
    }
    if (!kept.has(r.item_id)) kept.set(r.item_id, r);
  }
  const carriedIds = new Set(kept.keys());
  for (const it of doc.items) {
    const res = itemRowOf(it, file.source, file.fetched_ms);
    if ("drop" in res) {
      counts[res.drop]++;
      continue;
    }
    const prev = kept.get(res.row.item_id);
    if (prev !== undefined) {
      prev.first_seen_ms = Math.min(prev.first_seen_ms, res.row.first_seen_ms);
      continue; // the first sighting's text stays (append + dedup, plan 01 §5.2)
    }
    kept.set(res.row.item_id, res.row);
    counts.new++;
  }
  counts.carried = [...kept.keys()].filter((k) => carriedIds.has(k)).length;
  let rows = [...kept.values()].sort(
    (a, b) => b.published_ms - a.published_ms || (a.item_id < b.item_id ? -1 : 1),
  );
  if (rows.length > MAX_NEWS_ITEMS) {
    counts.over_cap = rows.length - MAX_NEWS_ITEMS;
    rows = rows.slice(0, MAX_NEWS_ITEMS);
  }
  // the schema assertion only counts rows: it skips the matcher (the publish step runs it)
  const matcher = buildPlayerMatcher(
    opts.refs === false ? [] : file.universe.slice(0, MAX_UNIVERSE_PLAYERS),
  );
  const refs: DatasetRow[] = [];
  if (matcher.size > 0) {
    for (const r of rows) {
      // " | " is a break: a name never spans the title's end and the blurb's start
      for (const ref of matcher.match(`${r.title} | ${r.blurb ?? ""}`))
        refs.push(Object.freeze({ item_id: r.item_id, ...ref }));
    }
  }
  refs.sort((a, b) =>
    a.item_id === b.item_id
      ? Number(a.espn_id) - Number(b.espn_id)
      : String(a.item_id) < String(b.item_id)
        ? -1
        : 1,
  );
  const warnings = [...doc.warnings];
  const say = (n: number, what: string): void => {
    if (n > 0) warnings.push(`${String(n)} ${what}`);
  };
  say(
    counts.invalid,
    "item(s) without a title, an id (guid or link) or a readable pubDate were dropped",
  );
  say(counts.promo, "promotional item(s) were dropped");
  say(counts.expired, "item(s) older than the 30-day retention were not kept");
  say(counts.future, "item(s) dated more than a day after the fetch were dropped");
  say(counts.bad_previous, "row(s) of the previous file did not read back and were not carried");
  say(counts.over_cap, "oldest item(s) beyond the per-file ceiling were not kept");
  if (matcher.size === 0 && opts.refs !== false)
    warnings.push("no player universe: items carry no player refs");
  return {
    news: rows.map((r) => Object.freeze({ ...r })),
    refs,
    counts,
    warnings,
  };
}

const bad = (warning: string, missing: readonly string[] = []): SchemaReport => ({
  ok: false,
  missing_columns: missing,
  extra_columns: [],
  bad_codecs: [],
  rows: 0,
  warnings: [warning],
});

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;

/** The schema assertion of one feed file (plan 01 §5.5; plan 10 B1: a renamed field is named). */
export function assertNewsShape(file: NewsFile): SchemaReport {
  const doc = parseRss(file.xml);
  if (doc.root !== "rss") return bad("the feed is not an RSS 2.0 document", ["rss"]);
  if (!doc.channel) return bad("the feed has no channel", ["channel"]);
  const missing: string[] = [];
  const has = (f: (typeof RSS_ITEM_FIELDS)[number]): boolean =>
    doc.items.some((i) => i[f] !== null);
  if (doc.items.length > 0) {
    if (!has("title")) missing.push("title");
    if (!has("pubDate")) missing.push("pubDate");
    if (!has("guid") && !has("link")) missing.push("guid|link");
  }
  const known = new Set<string>([...RSS_ITEM_FIELDS, ...RSS_IGNORED_CHILDREN]);
  const extra = [
    ...new Set(
      doc.items.flatMap((i) => i.children).filter((c) => !known.has(c) && SAFE_NAME.test(c)),
    ),
  ].sort();
  const built = buildNewsRows(file, { refs: false });
  const warnings = [...file.warnings, ...built.warnings];
  if (doc.items.length === 0) warnings.push("the feed has no items");
  for (const c of extra) warnings.push(`extra item field ${c}`);
  return {
    ok: missing.length === 0,
    missing_columns: missing,
    extra_columns: extra,
    bad_codecs: [],
    rows: built.news.length,
    warnings,
  };
}

/** Builds the DataSource of one feed. */
export function createNewsSource(feed: NewsSource, opts: NewsSourceOptions = {}): DataSource {
  const spec: NewsFeedSpec = NEWS_FEEDS[feed];
  const info = SOURCE_REGISTRY[spec.id];
  const tables = NEWS_TABLES[spec.id];
  const [itemsTable, refsTable] = tables;
  if (itemsTable === undefined || refsTable === undefined)
    throw new Error("news: the dataset contract lacks the news tables");
  return Object.freeze({
    id: spec.id,
    license: info.license,
    attribution: info.attribution,
    freshness: info.freshness,
    job: info.job,
    limiter: SOURCE_RATE_LIMITS.rss,
    versioning: "time_bucket",
    seasonGate: "in_season",
    tables,

    version(ctx: SourceContext): Promise<ReleaseVersion | null> {
      return Promise.resolve({ version: quarterHourBucket(ctx.clock.nowMs()), released_at: null });
    },

    async fetch(_version: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> {
      const res = await ctx.http(spec.url, {
        signal: ctx.signal,
        maxBytes: MAX_RSS_BYTES,
        accept: RSS_ACCEPT,
      });
      const { text, lossy } = decodeBody(res.body);
      const warnings: string[] = [];
      if (lossy) warnings.push("the feed is not valid UTF-8 (invalid bytes replaced)");
      let universe: readonly NewsUniversePlayer[] = [];
      let previous: readonly unknown[] = [];
      try {
        universe = opts.universe ? opts.universe(ctx).slice(0, MAX_UNIVERSE_PLAYERS) : [];
      } catch {
        warnings.push("the player universe is unreadable: items carry no player refs");
      }
      try {
        previous = opts.previous ? opts.previous(ctx).slice(0, MAX_NEWS_ITEMS * 2) : [];
      } catch {
        warnings.push("the previous news file is unreadable: nothing is carried over");
      }
      const file: NewsFile = {
        format: NEWS_FILE_FORMAT,
        source: feed,
        fetched_ms: ctx.clock.nowMs(),
        xml: text,
        universe,
        previous,
        warnings,
      };
      const path = join(ctx.tempDir, `news.${feed}.json`);
      const body = JSON.stringify(file);
      await writeFile(path, body, { mode: 0o600, flag: "wx" });
      return [{ path, bytes: Buffer.byteLength(body), season: null }];
    },

    async assertSchema(files: readonly TempFile[]): Promise<SchemaReport> {
      const first = files[0];
      if (files.length !== 1 || first === undefined) return bad("expected exactly one news file");
      let file: NewsFile;
      try {
        file = await readNewsFile(first.path, feed);
      } catch {
        return bad("the news file is unreadable");
      }
      return assertNewsShape(file);
    },

    async publish(files: readonly TempFile[], into: DatasetWriter): Promise<PublishStats> {
      const first = files[0];
      if (first === undefined) throw new Error("news: nothing to publish");
      const file = await readNewsFile(first.path, feed);
      const built = buildNewsRows(file);
      into.createTable(itemsTable);
      into.createTable(refsTable);
      const n = built.news.length === 0 ? 0 : into.insert(itemsTable.name, built.news);
      const r = built.refs.length === 0 ? 0 : into.insert(refsTable.name, built.refs);
      return {
        rows: n + r,
        tables: [
          { name: itemsTable.name, rows: n },
          { name: refsTable.name, rows: r },
        ],
        seasons: [],
        columns_hash: contractColumnsHash(spec.id),
      };
    },
  });
}

/** The three news sources (the `news` refresh job runs all three; plan 06 §1.3). */
export function newsSources(opts: NewsSourceOptions = {}): readonly DataSource[] {
  return Object.freeze([
    createNewsSource("rotowire", opts),
    createNewsSource("espn", opts),
    createNewsSource("cbs", opts),
  ]);
}
