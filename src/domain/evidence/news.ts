// news.ts — a stored RSS row as the analytics `NewsItem`, and the D6 claim fields of an item (plan 07
// D6 `espn_get_news`: "RSS headlines matched to players with a deterministic claim extract; all text
// `UT`"; plan 02 §6.2 the envelope — every third-party string is wrapped with its `rss.<feed>.*`
// tag, the URL included: "URLs left as text, never marked clickable, never fetched"; plan 02 §6.4).
// Pure: the store's NewsReader maps each `ds_news` row through `newsItemFromRow` (so no bare RSS
// string can leave the reader), and D6 calls `newsClaim` on each item. The claim, the prior and the
// flags are a closed vocabulary — the text itself only ever travels inside its wrapper.
import { GSIS_ID_RE } from "../../config/schema.js";
import type { NewsItem } from "../analytics/types.js";
import {
  INJECTION_FLAGS,
  wrapUntrusted,
  type ClaimExtract,
  type InjectionFlag,
  type UntrustedText,
} from "../league/types.js";
import { extractItemClaim, toClaimExtract, type RulesV1Claim } from "./claims.js";
import { newsReliabilitySource, reliabilityOf } from "./reliability.js";

/** The feeds a `NewsItem` may come from (plan 07 D6 `sources`). */
export const NEWS_FEED_KEYS = Object.freeze(["rotowire", "espn", "cbs"] as const);
export type NewsFeed = NewsItem["source"];

/** Whether a value is a feed key. */
export function isNewsFeed(v: unknown): v is NewsFeed {
  return typeof v === "string" && (NEWS_FEED_KEYS as readonly string[]).includes(v);
}

/** One `ds_news` row as stored (tables.ts NEWS_TABLES: raw third-party text, storage-capped). */
export interface StoredNewsRow {
  readonly item_id: string;
  readonly source: NewsFeed;
  readonly published_ms: number;
  readonly first_seen_ms: number;
  readonly title: string;
  readonly blurb: string | null;
  readonly link: string | null;
}

const ITEM_ID_RE = /^[0-9a-f]{32}$/;
const own = (o: object, k: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;
const msOk = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 32_503_680_000_000;
const textOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

/**
 * A stored row read back defensively (a forged or corrupt dataset file is data too): a 32-hex id,
 * a known feed, epoch-ms instants, a non-empty title, nullable blurb and link. Anything else → null.
 */
export function readStoredNewsRow(row: unknown): StoredNewsRow | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const item_id = own(row, "item_id");
  const source = own(row, "source");
  const published_ms = own(row, "published_ms");
  const first_seen_ms = own(row, "first_seen_ms");
  const title = own(row, "title");
  const blurb = textOrNull(own(row, "blurb") ?? null);
  const link = textOrNull(own(row, "link") ?? null);
  if (typeof item_id !== "string" || !ITEM_ID_RE.test(item_id)) return null;
  if (!isNewsFeed(source) || !msOk(published_ms) || !msOk(first_seen_ms)) return null;
  if (typeof title !== "string" || title.trim() === "" || blurb === undefined || link === undefined)
    return null;
  return { item_id, source, published_ms, first_seen_ms, title, blurb, link };
}

/**
 * The analytics `NewsItem` of a stored row: title, blurb and URL wrapped with the feed's tags (an
 * absent blurb or link becomes an empty wrapper, never a bare string); `gsis_ids` filtered to the
 * gsis grammar, deduplicated and sorted. Null when the row does not read back.
 */
export function newsItemFromRow(row: unknown, gsisIds: readonly unknown[] = []): NewsItem | null {
  const r = readStoredNewsRow(row);
  if (r === null) return null;
  const ids = [
    ...new Set(gsisIds.filter((g): g is string => typeof g === "string" && GSIS_ID_RE.test(g))),
  ];
  ids.sort();
  return {
    id: r.item_id,
    source: r.source,
    published_at: new Date(r.published_ms).toISOString(),
    title: wrapUntrusted(r.title, `rss.${r.source}.title`),
    blurb: wrapUntrusted(r.blurb ?? "", `rss.${r.source}.blurb`),
    url: wrapUntrusted(r.link ?? "", `rss.${r.source}.url`),
    gsis_ids: ids,
  };
}

/** The D6 fields derived from one item's text. */
export interface NewsClaimFields {
  /** plan 07 D6 `claim` (type, direction, extractor) or null. */
  readonly claim: ClaimExtract | null;
  /** The source × type prior with the injection cap applied; null without a claim. */
  readonly reliability_prior: number | null;
  /** The union of the title, blurb and URL wrappers' injection flags, in INJECTION_FLAGS order. */
  readonly flags: readonly InjectionFlag[];
  /** The extractor's full output (rule id, designation) for E10; never a text field. */
  readonly extract: RulesV1Claim | null;
}

const flagsOf = (t: UntrustedText): readonly InjectionFlag[] => t.untrusted_text.flags ?? [];

/**
 * The claim, prior and flags of an item, read from its WRAPPED (sanitised) title and blurb — the
 * same text the model is shown, so nothing hidden by the sanitiser can steer the extractor.
 */
export function newsClaim(
  item: Pick<NewsItem, "source" | "title" | "blurb" | "url">,
): NewsClaimFields {
  const seen = new Set<InjectionFlag>([
    ...flagsOf(item.title),
    ...flagsOf(item.blurb),
    ...flagsOf(item.url),
  ]);
  const flags = INJECTION_FLAGS.filter((f) => seen.has(f));
  const extract = extractItemClaim({
    title: item.title.untrusted_text.value,
    blurb: item.blurb.untrusted_text.value,
  });
  const reliability =
    extract === null
      ? null
      : reliabilityOf(newsReliabilitySource(item.source), extract.type, { flags }).reliability;
  return { claim: toClaimExtract(extract), reliability_prior: reliability, flags, extract };
}
