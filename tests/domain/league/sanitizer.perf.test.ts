// sanitizer.perf.test.ts — what hostile text costs the untrusted-text sanitiser (src/domain/league/
// types.ts `sanitizeText`, `wrapUntrusted`; plan 02 §6.1–§6.2; plan 03 §1.2 and plan 10 A16a: no
// main-loop stall over 50 ms). Wall-clock budgets run in the process project, never under coverage
// (plan 05 §4.2). Stage C finding untrusted-sanitizer-quadratic: a field of unclosed `<!--`,
// `<style` or `<script` openers cost 20–30 ms at 2 048 code units and 0.5–0.9 s at 9 600, on every
// read: a standings call on a league whose members wrote them stalled 0.6–1.5 s, a news call with
// such blurbs 0.9 s. Each family here, at every text class's pre-cut, now costs a few milliseconds at
// most, what one standings or news read wraps stays under the stall bound, and the cost grows
// linearly with the text.
import { describe, expect, it } from "vitest";
import {
  sanitizeText,
  TEXT_CAPS,
  UNTRUSTED_SOURCE_CLASS,
  wrapUntrusted,
  type UntrustedSource,
} from "../../../src/domain/league/types.js";

/** One hostile field's budget: a few times the worst cost measured on the development machine. */
const FIELD_MS = 10;
/** The main-loop stall bound (plan 03 §1.2, plan 10 A16a). */
const STALL_MS = 50;

/** `unit` repeated to exactly `n` code units. */
const fill = (unit: string, n: number): string =>
  unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

/** How much of a raw text the sanitiser reads for a cap (`sanitizeUncapped`'s pre-cut). */
const precut = (cap: number): number => Math.max(cap * 8, 2048);

/** The finding's families first, then the other runs that held the old fixed-point loops longest. */
const HOSTILE: readonly (readonly [string, (n: number) => string])[] = [
  ["unclosed `<!--` openers", (n) => fill("<!--", n)],
  ["unclosed `<style` openers", (n) => fill("<style", n)],
  ["`<script` openers and one `>` at the end", (n) => `${fill("<script", n - 1)}>`],
  ["`<style` openers and one `>` at the end", (n) => `${fill("<style", n - 1)}>`],
  ["encoded `<!--` openers", (n) => fill("&lt;!--", n)],
  ["twice-encoded `<!--` openers", (n) => fill("&amp;lt;!--", n)],
  ["`<style>` openers", (n) => fill("<style>", n)],
  ["closer look-alikes after a `<script>`", (n) => `<script>${fill("</scrip", n - 8)}`],
  ["nested tags", (n) => `${fill("<a", n / 2)}${fill(">", n / 2)}`],
  ["a trailing run of openers", (n) => `x${fill("<b", n - 1)}`],
  ["entities nested to the end", (n) => `&${fill("amp;", n - 4)}lt;`],
  ["entities split by zero-width spaces", (n) => fill("&l&#x200b;t;b&g&#x200b;t;", n)],
  ["openers, comments and encodings mixed", (n) => fill("<style<!--<a<b&lt;script&gt;<!--", n)],
];
/** The families the finding measured end to end. */
const FINDING = HOSTILE.slice(0, 5);

/** The fastest of `runs` timings in ms: a JIT warm-up or a GC pause is not the sanitiser's cost. */
function fastest(fn: () => void, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("one hostile field costs a few milliseconds at most", () => {
  const caps = [...new Set(Object.values(TEXT_CAPS))].sort((a, b) => a - b);

  it.each(HOSTILE)(`%s: every text class at its pre-cut in < ${String(FIELD_MS)} ms`, (_, run) => {
    for (const cap of caps) {
      const raw = run(precut(cap));
      expect(
        fastest(() => sanitizeText(raw, cap)),
        `cap ${String(cap)}`,
      ).toBeLessThan(FIELD_MS);
    }
  });
});

describe(`what one read wraps stays under the ${String(STALL_MS)} ms stall bound`, () => {
  /** A standings read wraps each of ten teams' name, abbreviation and trade-block note. */
  const STANDINGS: readonly UntrustedSource[] = [
    "espn.team.name",
    "espn.team.abbrev",
    "espn.team.trade_block",
  ];

  it.each(FINDING)("ten teams' standings text, all %s", (_, run) => {
    const fields = STANDINGS.map(
      (source) => [run(precut(TEXT_CAPS[UNTRUSTED_SOURCE_CLASS[source]])), source] as const,
    );
    const ms = fastest(() => {
      for (let team = 0; team < 10; team++)
        for (const [raw, source] of fields) wrapUntrusted(raw, source);
    });
    expect(ms).toBeLessThan(STALL_MS);
  });

  it.each(FINDING)("fifty news rows whose blurbs are all %s", (_, run) => {
    // E10 re-wraps every row it reads (title, blurb, link); a stored blurb holds up to 4 000 units
    const blurb = run(4000);
    const ms = fastest(() => {
      for (let row = 0; row < 50; row++) {
        wrapUntrusted(`Player ${String(row)} questionable for Sunday`, "rss.espn.title");
        wrapUntrusted(`${String(row)} ${blurb}`, "rss.espn.blurb");
        wrapUntrusted(`https://example.invalid/news/${String(row)}`, "rss.espn.url");
      }
    });
    expect(ms).toBeLessThan(STALL_MS);
  });
});

describe("the cost grows linearly with the text", () => {
  it.each(HOSTILE)("%s: sixteen times the text costs nowhere near 256 times as much", (_, run) => {
    // the cap sets the pre-cut (eight times the cap), so each call reads the whole text
    const small = run(4000);
    const large = run(64_000);
    const t1 = fastest(() => sanitizeText(small, 500));
    const t16 = fastest(() => sanitizeText(large, 8000));
    // linear work costs about 16 times as much (more allocation, more collection), quadratic work
    // about 256 times; the bound sits between them and its constant absorbs timer noise
    expect(t16).toBeLessThan(64 * t1 + 10);
  });
});
