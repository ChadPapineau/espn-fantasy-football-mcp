// markup.ts — the markup and entity scans of the untrusted-text sanitiser in ./types.ts (plan 02
// §6.2 "Stripping": HTML tags and entities decoded then removed; plan 01 §4.4 step 2; plan 07 C14).
// Stage C finding untrusted-sanitizer-quadratic: as regexes, the block rule
// `<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>` and the comment rule `<!--[\s\S]*?-->` scanned to the
// end of the text again from every opener whose closer never came (`<style` or `<!--` repeated:
// quadratic, up to 0.9 s for one hostile field, paid again on every standings, lineup, waivers or
// news read), and the two tag rules removed one nesting level or one unclosed opener per call, so a
// run of openers held the sanitiser's fixed-point loops at their caps. Each scan here keeps its
// regex's meaning and reads its input left to right, so its work is linear in its input;
// tests/domain/league/markup.test.ts holds each to the regex it replaces. Code units only, as the
// regexes (no `u` flag) read them: the Unicode clean stays in types.ts. Pure: no I/O.

/** An entity: `&`, then a decimal or hexadecimal number or a name, then `;`. */
export const ENTITY_SOURCE =
  "&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));";
/** The longest entity `ENTITY_SOURCE` matches: `&`, a 32-character name, `;`. */
const ENTITY_MAX = 34;

/** What one entity decodes to, from its decimal number, its hexadecimal number or its name. */
export type EntityText = (
  dec: string | undefined,
  hex: string | undefined,
  name: string | undefined,
) => string;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isHexDigit = (c: number): boolean =>
  isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/**
 * What `s[from, to)` decodes to as the body of an entity (what lies between its `&` and its `;`), or
 * null when it is no body `ENTITY_SOURCE` matches: `#` and one to seven digits, `#x` or `#X` and one
 * to six hexadecimal digits, or a letter and one to 31 letters or digits.
 */
function decodeBody(s: string, from: number, to: number, text: EntityText): string | null {
  if (s.charCodeAt(from) === 0x23) {
    const hex = to - from > 1 && (s.charCodeAt(from + 1) | 0x20) === 0x78;
    const digits = from + (hex ? 2 : 1);
    if (to - digits < 1 || to - digits > (hex ? 6 : 7)) return null;
    for (let k = digits; k < to; k++)
      if (!(hex ? isHexDigit(s.charCodeAt(k)) : isDigit(s.charCodeAt(k)))) return null;
    const n = s.slice(digits, to);
    return hex ? text(undefined, n, undefined) : text(n, undefined, undefined);
  }
  if (to - from < 2 || to - from > 32 || !isLetter(s.charCodeAt(from))) return null;
  for (let k = from + 1; k < to; k++) {
    const c = s.charCodeAt(k);
    if (!isLetter(c) && !isDigit(c)) return null;
  }
  return text(undefined, undefined, s.slice(from, to));
}

/**
 * Decodes one level of entities (`&amp;lt;` reads `&lt;`): `s.replace(new RegExp(ENTITY_SOURCE,
 * "g"), …)` in one scan, with no callback per entity. An entity's body holds no `&` and no `;`, so a
 * `;` can close only the nearest `&` before it: each `&` is looked at once, and the next `;` is looked
 * for again only once an `&` lies past it.
 */
export function decodeLevel(s: string, text: EntityText): string {
  let out = "";
  let kept = 0;
  let semi = -1; // the first `;` after the latest `&` looked at, once looked for
  for (let amp = s.indexOf("&"); amp >= 0;) {
    if (semi <= amp) semi = s.indexOf(";", amp + 1);
    if (semi < 0) break;
    const next = s.indexOf("&", amp + 1);
    if (next < 0 || next > semi) {
      const t = semi - amp < ENTITY_MAX ? decodeBody(s, amp + 1, semi, text) : null;
      if (t !== null) {
        out += s.slice(kept, amp) + t;
        kept = semi + 1;
      }
    }
    amp = next;
  }
  return kept === 0 ? s : out + s.slice(kept);
}

/**
 * Where the entity that a `;` written at `units[w]` would close starts: the nearest `&` before it,
 * if no `;` lies between them and the entity fits in `ENTITY_MAX` (an entity holds no `&` or `;`
 * inside, so no other `&` can start it) — else −1.
 */
function entityStart(units: Uint16Array, w: number): number {
  for (let k = w - 1; k >= 0 && k > w - ENTITY_MAX; k--) {
    const c = units[k];
    if (c === 0x26) return k;
    if (c === 0x3b) return -1;
  }
  return -1;
}

/** `units[from, to)` as a string, unit by unit (for an entity's few units, cheaper than a view). */
function shortText(units: Uint16Array, from: number, to: number): string {
  let t = "";
  for (let k = from; k < to; k++) t += String.fromCharCode(units[k] ?? 0);
  return t;
}

/**
 * Decodes every level of entities in one left-to-right scan (`&amp;amp;lt;` is `<`): what
 * `decodeLevel` reaches when repeated until nothing changes. Entities never overlap and every decode
 * shortens the text, so that result does not depend on the order the entities are decoded in, and
 * this scan reaches it: the text written so far never holds an entity, a `;` that closes one replaces
 * it with its decoded text, and the decoded text is read again as input, so a decoded `;` can close
 * the entity before it (`&lt&#59;` is `<`) and a decoded `&` can open one (`&#38;lt;` is `<`). A
 * decode `text` returns that is not shorter than its entity leaves the entity as it is. Linear: the
 * text read, written and still to read never grows, and each decode shrinks it while queuing fewer
 * than `ENTITY_MAX` units — one `decodeLevel` per level would be quadratic, since a text can nest as
 * deep as its length allows.
 */
export function decodeNested(s: string, text: EntityText): string {
  const units = new Uint16Array(s.length);
  let w = 0;
  const queued: number[] = []; // decoded text still to read, its last unit first
  for (let i = 0; i < s.length || queued.length > 0;) {
    const c = queued.pop() ?? s.charCodeAt(i++);
    if (c === 0x3b) {
      const amp = entityStart(units, w);
      const body = amp < 0 ? "" : shortText(units, amp + 1, w);
      const t = body === "" ? null : decodeBody(body, 0, body.length, text);
      if (t !== null && t.length <= w - amp) {
        w = amp;
        for (let k = t.length - 1; k >= 0; k--) queued.push(t.charCodeAt(k));
        continue;
      }
    }
    units[w++] = c;
  }
  let out = "";
  for (let i = 0; i < w; i += 4096)
    out += String.fromCharCode.apply(
      null,
      units.subarray(i, Math.min(w, i + 4096)) as unknown as number[],
    );
  return out;
}

// --- markup removal --------------------------------------------------------------------------

/** `s` holds the lower-case ASCII word `word` at `at`, ASCII case folded (as the `i` flag does). */
function hasWordAt(s: string, at: number, word: string): boolean {
  if (at + word.length > s.length) return false;
  for (let k = 0; k < word.length; k++) {
    const c = s.charCodeAt(at + k);
    if ((c >= 0x41 && c <= 0x5a ? c + 0x20 : c) !== word.charCodeAt(k)) return false;
  }
  return true;
}

/** A `\w` code unit: what `\b` tests without the `u` flag. */
function isWordUnit(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f
  );
}

/** A `\s` code unit: white space (Zs, tab, vertical tab, form feed, BOM) or a line terminator. */
function isSpaceUnit(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** A tag's character after `<`: a letter, `/`, `!` or `?` (`<3`, `< b` and `<=` stay prose). */
function isTagStart(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2f || c === 0x21 || c === 0x3f
  );
}

/** Every block opener holds this; text without it has no block to remove. */
const BLOCK_OPENER_HINT_RE = /<(?:script|style)/i;

/** The end of the first `</name\s*>` at or after `from` (`name` ASCII case folded), or −1. */
function blockCloserEnd(s: string, from: number, name: "script" | "style"): number {
  for (let j = s.indexOf("</", from); j >= 0; j = s.indexOf("</", j + 2)) {
    if (!hasWordAt(s, j + 2, name)) continue;
    let k = j + 2 + name.length;
    while (k < s.length && isSpaceUnit(s.charCodeAt(k))) k++;
    if (s.charCodeAt(k) === 0x3e) return k + 1;
  }
  return -1;
}

/**
 * `s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")` in one scan: each block — its
 * opener up to the first `>`, then everything up to the first closer of the same name — becomes a
 * space. The first `>` after an opener is the first after every opener up to it, so it is looked for
 * again only once an opener lies past it; and a closer search that finds nothing from a point finds
 * nothing from any later one, so a name whose search failed is never searched for again (the regex
 * searched again from every opener).
 */
export function removeBlocks(s: string): string {
  if (!BLOCK_OPENER_HINT_RE.test(s)) return s;
  const noCloserFrom = { script: Infinity, style: Infinity };
  let out = "";
  let kept = 0;
  let gt = -1; // the first `>` at or after the latest opener's name, once looked for
  for (let lt = s.indexOf("<"); lt >= 0; lt = s.indexOf("<", lt + 1)) {
    const name = hasWordAt(s, lt + 1, "script")
      ? "script"
      : hasWordAt(s, lt + 1, "style")
        ? "style"
        : null;
    if (name === null) continue;
    const end = lt + 1 + name.length;
    if (end < s.length && isWordUnit(s.charCodeAt(end))) continue; // `\b`: `<scripts>` opens none
    if (gt < end) gt = s.indexOf(">", end);
    if (gt < 0) break; // no `>` left: neither this opener nor a later one completes its tag
    const close = gt + 1 < noCloserFrom[name] ? blockCloserEnd(s, gt + 1, name) : -1;
    if (close < 0) {
      noCloserFrom[name] = Math.min(noCloserFrom[name], gt + 1);
      continue;
    }
    out += `${s.slice(kept, lt)} `;
    kept = close;
    lt = close - 1; // the next opener is looked for from the end of this block
  }
  return kept === 0 ? s : out + s.slice(kept);
}

/**
 * `s.replace(/<!--[\s\S]*?-->/g, " ")` in one scan: each comment, up to the first `-->` after its
 * opener, becomes a space; the first opener with no `-->` after it ends the scan, since no later
 * opener has one either.
 */
export function removeComments(s: string): string {
  let out = "";
  let kept = 0;
  for (let open = s.indexOf("<!--"); open >= 0; open = s.indexOf("<!--", kept)) {
    const close = s.indexOf("-->", open + 4);
    if (close < 0) break;
    out += `${s.slice(kept, open)} `;
    kept = close + 3;
  }
  return kept === 0 ? s : out + s.slice(kept);
}

/** A tag, and an unclosed tag at the end of the text: the two tag rules as regexes. */
const TAG_RE = /<[A-Za-z/!?][^<>]*>/;
const TRAILING_TAG_RE = /<[A-Za-z/!?][^<>]*$/;

/**
 * The two tag rules at their fixed point, in one scan: each `<x…>` (a tag character after the `<`,
 * no `<` or `>` inside) becomes a space, and so does every tag that exposes (`<a<b>>` → `<a >` →
 * ` `); then an unclosed `<x…` at the end does, and every one that exposes (`a<b<c` → `a<b ` →
 * `a `). That is what `/<[A-Za-z/!?][^<>]*>/g` and `/<[A-Za-z/!?][^<>]*$/` reach when applied until
 * nothing changes. An open `<` waits on a stack until a `>` closes the newest one, and the tag it
 * closes takes in every tag removed inside it; any other `<` (prose such as `3 < 4`) stays as text,
 * no later `>` reaches past it, and it empties the stack; a `>` with no `<` waiting (`a > b`) stays.
 * The removed spans are recorded first and the text is built once, at the end.
 */
export function removeTags(s: string): string {
  if (!TAG_RE.test(s) && !TRAILING_TAG_RE.test(s)) return s;
  // the outermost spans removed so far, in order, as [start, end) pairs
  const spans: number[] = [];
  // per waiting `<`: its index, and how many span bounds were recorded when it was met
  const waiting: number[] = [];
  let lt = s.indexOf("<");
  let gt = s.indexOf(">");
  while (lt >= 0 || gt >= 0) {
    if (gt < 0 || (lt >= 0 && lt < gt)) {
      if (isTagStart(s.charCodeAt(lt + 1))) waiting.push(lt, spans.length);
      else waiting.length = 0;
      lt = s.indexOf("<", lt + 1);
    } else {
      const inner = waiting.pop();
      const open = waiting.pop();
      if (inner !== undefined && open !== undefined) {
        spans.length = inner; // the spans inside this tag are part of it
        spans.push(open, gt + 1);
      }
      gt = s.indexOf(">", gt + 1);
    }
  }
  // an unclosed run at the end goes from its first `<` (each removal exposes the one before)
  const [open, inner] = waiting;
  if (open !== undefined && inner !== undefined) {
    spans.length = inner;
    spans.push(open, s.length);
  }
  let out = "";
  let kept = 0;
  for (let k = 0; k + 1 < spans.length; k += 2) {
    out += `${s.slice(kept, spans[k])} `;
    kept = spans[k + 1] ?? s.length;
  }
  return out + s.slice(kept);
}

/**
 * What every rule needs: a comment opener, or a tag or an unclosed tag at the end (a block's closer
 * is itself a tag). Text without one is left as it is after this one scan.
 */
const MARKUP_RE = /<!--|<[A-Za-z/!?][^<>]*(?:>|$)/;

/**
 * Removes script/style blocks, comments, and every tag (each becomes a space); prose such as "3 < 4"
 * survives. The fixed point of the four rules applied in that order, reached in one call: what it
 * returns holds no block, comment or tag for a second call (a removal leaves a space, which no
 * comment opener or closer, and no block closer, can hold).
 */
export function stripTags(s: string): string {
  return MARKUP_RE.test(s) ? removeTags(removeComments(removeBlocks(s))) : s;
}
