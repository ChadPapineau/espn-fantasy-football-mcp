// xml.ts — a small, hostile-input-safe RSS 2.0 reader for the news sources (plan 01 §5.5 "assert the
// shape before publishing"; plan 02 §6.1 #3 "news RSS" is an injection surface; plan 02 §7: no new
// runtime dependency — plan 04 §2's four packages carry no XML parser, so this is written here).
//
// What it reads: `rss > channel > item` and, per item, the text of its direct children (title, link,
// description, guid, pubDate; the names of the others are reported as extra columns). What it never
// does: process a DOCTYPE (it is skipped whole — no entity is ever declared, so `&lol9;` stays the
// literal text "&lol9;" and no expansion can amplify), resolve an external reference, follow a
// processing instruction, or interpret a field's text — markup inside a field (escaped or not) is
// kept as text and stripped by the plan 02 §6.2 sanitiser at output. Only the five XML entities and
// numeric references are decoded, in one pass (so `&amp;lt;` reads `&lt;`). Bounded work: one
// left-to-right scan with indexOf, a depth ceiling, an item ceiling and a per-field character
// ceiling (the excess is dropped and counted). Malformed input never throws; it yields what was
// read plus warnings, and `assertSchema` decides.

/** The ceilings of one parse. */
export interface RssLimits {
  readonly maxItems: number;
  /** Characters kept per field (the excess is dropped; the storage cap is lower still). */
  readonly maxFieldChars: number;
  readonly maxDepth: number;
}

/** Defaults: far above the real feeds (5–40 items, fields < 1 kB) and far below the 2 MiB body cap. */
export const RSS_LIMITS: RssLimits = Object.freeze({
  maxItems: 500,
  maxFieldChars: 16_384,
  maxDepth: 64,
});

/** The item children whose text is captured. */
export const RSS_ITEM_FIELDS = ["title", "link", "description", "guid", "pubDate"] as const;
export type RssItemField = (typeof RSS_ITEM_FIELDS)[number];

/** Item children that are expected and ignored (never reported as extra columns). */
export const RSS_IGNORED_CHILDREN: readonly string[] = Object.freeze([
  "dc:creator",
  "author",
  "enclosure",
  "category",
  "comments",
  "source",
  "content:encoded",
  "dc:date",
  "media:content",
  "media:thumbnail",
  "media:credit",
  "media:description",
  "media:title",
  "media:keywords",
  "atom:link",
]);

/** One item's captured fields (raw text after XML decoding; null when the child is absent). */
export type RssItem = Readonly<Record<RssItemField, string | null>> & {
  /** The names of the item's direct children, in order of first appearance. */
  readonly children: readonly string[];
};

/** The result of a parse. */
export interface RssDocument {
  /** The root element's name, or null when the document has no element. */
  readonly root: string | null;
  /** Whether `rss > channel` was seen. */
  readonly channel: boolean;
  readonly items: readonly RssItem[];
  /** Whether a DOCTYPE was present (and skipped). */
  readonly doctype: boolean;
  /** Fields cut at `maxFieldChars`. */
  readonly truncated_fields: number;
  /** Items beyond `maxItems` (not read). */
  readonly dropped_items: number;
  readonly warnings: readonly string[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}/;

/** Decodes the five XML entities and numeric references (one pass); anything else stays literal. */
export function decodeXmlText(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g,
    (_m, dec?: string, hex?: string, named?: string) => {
      if (named !== undefined)
        return named === "lt"
          ? "<"
          : named === "gt"
            ? ">"
            : named === "amp"
              ? "&"
              : named === "quot"
                ? '"'
                : "'";
      const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      const ok =
        cp === 0x9 ||
        cp === 0xa ||
        cp === 0xd ||
        (cp >= 0x20 &&
          cp <= 0x10ffff &&
          (cp < 0xd800 || cp > 0xdfff) &&
          cp !== 0xfffe &&
          cp !== 0xffff);
      return ok ? String.fromCodePoint(cp) : "";
    },
  );
}

/** The index of the `>` closing a tag that starts at `from` (quotes respected), or -1. */
function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** The end of a `<!DOCTYPE …>` (or other `<!…>` declaration) with its internal subset, or -1. */
function declarationEnd(xml: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

interface Capture {
  field: RssItemField;
  depth: number;
  parts: string[];
  chars: number;
  cut: boolean;
}

interface OpenItem {
  depth: number;
  fields: Partial<Record<RssItemField, string>>;
  children: string[];
}

/** Parses an RSS document (never throws; see the header for what it refuses to do). */
export function parseRss(xml: string, limits: RssLimits = RSS_LIMITS): RssDocument {
  const warnings: string[] = [];
  const items: RssItem[] = [];
  const stack: string[] = [];
  let root: string | null = null;
  let channel = false;
  let doctype = false;
  let truncated = 0;
  let dropped = 0;
  let item: OpenItem | null = null;
  let cap: Capture | null = null;

  const text = (raw: string, decode: boolean): void => {
    if (cap === null || raw.length === 0) return;
    const t = decode ? decodeXmlText(raw) : raw;
    const room = limits.maxFieldChars - cap.chars;
    if (room <= 0) {
      cap.cut = true;
      return;
    }
    const kept = t.length > room ? t.slice(0, room) : t;
    if (kept.length < t.length) cap.cut = true;
    cap.parts.push(kept);
    cap.chars += kept.length;
  };

  const closeTo = (depth: number): void => {
    while (stack.length > depth) {
      stack.pop();
      if (cap !== null && stack.length < cap.depth) {
        if (item !== null && item.fields[cap.field] === undefined)
          item.fields[cap.field] = cap.parts.join("");
        if (cap.cut) truncated++;
        cap = null;
      }
      if (item !== null && stack.length < item.depth) {
        const f = item.fields;
        items.push(
          Object.freeze({
            title: f.title ?? null,
            link: f.link ?? null,
            description: f.description ?? null,
            guid: f.guid ?? null,
            pubDate: f.pubDate ?? null,
            children: Object.freeze([...item.children]),
          }),
        );
        item = null;
      }
    }
  };

  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      text(xml.slice(i), true);
      break;
    }
    if (lt > i) text(xml.slice(i, lt), true);
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      text(xml.slice(lt + 9, e < 0 ? n : e), false);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const e = xml.indexOf("?>", lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      if (/^<!DOCTYPE/i.test(xml.slice(lt, lt + 9))) doctype = true;
      const e = declarationEnd(xml, lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (!/[A-Za-z_/]/.test(xml[lt + 1] ?? "")) {
      text("<", false); // a bare "<" in text ("3 < 4") is text, never the start of a tag
      i = lt + 1;
      continue;
    }
    const e = tagEnd(xml, lt + 1);
    if (e < 0) {
      warnings.push("an unterminated tag ends the document");
      break;
    }
    const body = xml.slice(lt + 1, e);
    i = e + 1;
    if (body.startsWith("/")) {
      const name = NAME_RE.exec(body.slice(1).trim())?.[0];
      if (name === undefined) continue;
      const at = stack.lastIndexOf(name);
      if (at >= 0) closeTo(at);
      continue;
    }
    const name = NAME_RE.exec(body)?.[0];
    if (name === undefined) {
      text(`<${body}>`, true); // not an element name — keep it as text
      continue;
    }
    const selfClosing = body.endsWith("/");
    const depth = stack.length; // the new element's depth (root = 0)
    if (depth === 0) {
      if (root !== null) {
        warnings.push("content after the root element is ignored");
        break;
      }
      root = name;
    }
    const parentIsChannel = depth === 2 && stack[0] === "rss" && stack[1] === "channel";
    if (depth === 1 && stack[0] === "rss" && name === "channel") channel = true;
    if (item !== null && depth === item.depth && !item.children.includes(name))
      item.children.push(name);
    if (selfClosing) continue;
    if (depth + 1 > limits.maxDepth) {
      warnings.push("the document nests deeper than the depth ceiling; the rest is not read");
      break;
    }
    stack.push(name);
    if (parentIsChannel && name === "item" && item === null) {
      if (items.length >= limits.maxItems) {
        dropped++;
      } else {
        item = { depth: depth + 1, fields: {}, children: [] };
      }
    } else if (
      item !== null &&
      cap === null &&
      depth === item.depth &&
      (RSS_ITEM_FIELDS as readonly string[]).includes(name)
    ) {
      cap = { field: name as RssItemField, depth: depth + 1, parts: [], chars: 0, cut: false };
    }
  }
  closeTo(0);
  if (truncated > 0)
    warnings.push(`${String(truncated)} field(s) longer than the field ceiling were cut`);
  if (dropped > 0)
    warnings.push(`${String(dropped)} item(s) beyond the item ceiling were not read`);
  if (doctype) warnings.push("a DOCTYPE was present and skipped (no entity is ever expanded)");
  return {
    root,
    channel,
    items,
    doctype,
    truncated_fields: truncated,
    dropped_items: dropped,
    warnings,
  };
}

/** UTF-8 text of a body (a BOM dropped); invalid sequences become U+FFFD (removed at output). */
export function decodeBody(body: Uint8Array): { readonly text: string; readonly lossy: boolean } {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
      lossy: false,
    };
  } catch {
    return {
      text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(body),
      lossy: true,
    };
  }
}
