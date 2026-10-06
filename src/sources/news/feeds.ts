// feeds.ts — the three RSS feeds and the per-item field rules of the news sources (plan 07 D6
// `sources: rotowire | espn | cbs`; research 04 #15 / §B.10: RotoWire + ESPN RSS for breaking
// headlines, CBS as the fallback "with promo filter" (sibling plan 07 D6); tables.ts NEWS_TABLES for
// the stored columns and their derivations). Shapes observed by fetching each feed once on
// 2026-10-06 (fixtures/news/README.md): RotoWire writes `pubDate` on a 12-hour clock
// ("Tue, 06 Oct 2026 6:12:00 AM PDT"), which `rssDateMs` (RFC 822, 24-hour) refuses — so it is
// rewritten to the 24-hour form first; CBS pads every field with whitespace; ESPN wraps text in
// CDATA. Links lose their tracking parameters before they are stored or hashed into an item id.
import type { NewsSource } from "../../store/datasets/derive.js";
import { httpUrlOrNull, rssDateMs } from "../../store/datasets/derive.js";

/** One RSS feed the news job reads. */
export interface NewsFeedSpec {
  readonly key: NewsSource;
  readonly id: "news:rotowire" | "news:espn" | "news:cbs";
  readonly url: string;
  readonly host: string;
}

/** The feeds (the same URLs as tables.ts NEWS_TABLES `upstream`; a test holds them equal). */
export const NEWS_FEEDS: Readonly<Record<NewsSource, NewsFeedSpec>> = Object.freeze({
  rotowire: Object.freeze({
    key: "rotowire",
    id: "news:rotowire",
    url: "https://www.rotowire.com/rss/news.php?sport=NFL",
    host: "www.rotowire.com",
  }),
  espn: Object.freeze({
    key: "espn",
    id: "news:espn",
    url: "https://www.espn.com/espn/rss/nfl/news",
    host: "www.espn.com",
  }),
  cbs: Object.freeze({
    key: "cbs",
    id: "news:cbs",
    url: "https://www.cbssports.com/rss/headlines/nfl/",
    host: "www.cbssports.com",
  }),
});

/**
 * The hosts the news job requests (for src/http's data-source allow-list — plan 02 S12: a host is
 * allowed exactly, never by suffix). The feeds were seen answering 200 without a redirect.
 */
export const NEWS_FEED_HOSTS: readonly string[] = Object.freeze(
  Object.values(NEWS_FEEDS).map((f) => f.host),
);

const TWELVE_HOUR_RE = /^(.*?\d{4}\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?\s+(\S+)$/;

/**
 * An RSS `pubDate` → epoch ms: a 12-hour time ("6:12:00 AM PDT", RotoWire) is rewritten to the
 * 24-hour RFC 822 form, then `rssDateMs` decides. An hour outside 1–12 on a 12-hour clock → null.
 */
export function pubDateMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const t = raw.trim().replace(/\s+/g, " "); // CBS pads the field with layout whitespace
  if (t.length > 64) return null;
  const m = TWELVE_HOUR_RE.exec(t);
  if (m === null) return rssDateMs(t);
  const hour12 = Number(m[2]);
  if (hour12 < 1 || hour12 > 12) return null;
  const pm = (m[5] ?? "").toLowerCase() === "p";
  const hour = (hour12 % 12) + (pm ? 12 : 0);
  const hh = String(hour).padStart(2, "0");
  return rssDateMs(`${m[1] ?? ""}${hh}:${m[3] ?? "00"}:${m[4] ?? "00"} ${m[6] ?? ""}`);
}

/** Query parameters that only track a click (dropped from a stored link and from the item key). */
const TRACKING_PARAM_RE =
  /^(?:utm_[a-z0-9_]*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|ex_cid|cmpid|icid|ftag|ocid|igshid|s_cid|_ga|_gl|yclid|twclid|ttclid|li_fat_id|xtor|cmp|campaign_id|partner|affiliate)$/i;

/**
 * A stored link: whitespace trimmed, tracking parameters and the fragment removed, then
 * `httpUrlOrNull` (absolute http(s), ≤ 2 048 chars, no quote/space/angle bracket/control). The link
 * is text — never fetched, never rendered as a link (plan 02 §6.2).
 */
export function cleanLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  const first = httpUrlOrNull(t);
  if (first === null) return null;
  let u: URL;
  try {
    u = new URL(first);
  } catch {
    return null;
  }
  const tracking = [...u.searchParams.keys()].filter((k) => TRACKING_PARAM_RE.test(k));
  if (tracking.length === 0 && u.hash === "") return first; // untouched: the item key stays stable
  for (const k of tracking) u.searchParams.delete(k);
  u.hash = "";
  const kept = [...u.searchParams.keys()].length > 0 ? u.toString() : `${u.origin}${u.pathname}`;
  return httpUrlOrNull(kept);
}

/** Collapses XML layout whitespace (CBS indents every field) to single spaces; empty → null. */
export function collapse(raw: string | null): string | null {
  if (raw === null) return null;
  const t = raw.replace(/\s+/gu, " ").trim();
  return t === "" ? null : t;
}

/**
 * A promotional item (sportsbook sign-up offers — the CBS "promo filter", sibling plan 07 D6): never
 * news, dropped at load. Matched on the folded title only; deterministic.
 */
export function isPromo(title: string): boolean {
  const t = title.normalize("NFKC").toLowerCase();
  const promo = /\bpromo(?:s|tion|tional)?\b/.test(t);
  const gambling = /\b(?:bet|bets|betting|sportsbooks?|bonus|bonuses|deposit|casino)\b/.test(t);
  return (
    (promo && gambling) ||
    /\bbonus bets\b/.test(t) ||
    /\b(?:sign-?up|deposit) (?:bonus|offer)\b/.test(t)
  );
}
