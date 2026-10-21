// status-docs.test.ts — the root documents' status prose follows the build (Stage C round 2, finding
// docs-planned-status-stale; area repo-root). The README's banner, its Status table and its
// generated tables were brought up to the build (built and in QA; the write module not built), and
// docs-current holds the catalog's Status cells to the registry (scripts/gen-tool-docs.ts
// statusProblems), but the prose had been written before the build and nothing held it: the footer
// said "Nothing on this page is implemented yet.", the opening "A planned … server, to be written …"
// and "Thirteen Skills are planned", the diagrams "Everything drawn here is planned, not built.", the
// Roadmap forecast the P0 tools for mid-to-late November and the trade Skill past the deadline,
// quoted a plan 10 §0 sentence that paragraph's 2026-10-05 rewrite removed and gave the effort scale
// plan 10 withdrew, the owner decisions stood as still open — and the plan index, where the README
// and CLAUDE.md send a reader first, opened with "Nothing in this plan is built."
// What holds now:
// 1. a sentence, table row or diagram line that calls something planned, unbuilt or not implemented
//    also names something that is not built: the write module and its parts (Phase W), Phase 4, or
//    an item the README marks 📋;
// 2. every quotation the README presents as the plan's is in the plan or the research, verbatim;
// 3. the README states plan 10's effort scale, never the one plan 10 withdrew;
// 4. the README's owner-decisions section dates every decision docs/HANDOFF.md records as made;
// 5. the plan index calls the plan the record of the design and links the build state.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WRITE_TOOL_NAMES } from "../../src/domain/gate/types.js";
import { readDoc, section, tableRows } from "./docs-helpers.js";
import { ROOT } from "./helpers.js";

/** One unit of status prose — a sentence, a table row, a heading or a diagram line — and its line. */
interface Unit {
  readonly line: number;
  readonly text: string;
}

const FENCE = /^```(\S*)\s*$/;
/** The first line of a list item: it starts a new paragraph. */
const ITEM = /^\s*(?:[-*+]|\d+\.)\s/;
/** Where a sentence ends: after `.`, `!` or `?`, before what can start the next one. */
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"(`[📋✅⛔🚧])/gu;

/** HTML tags and emphasis markers dropped, whitespace collapsed. */
const clean = (s: string): string =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The sentences of one paragraph or list item (its lines joined), each with the line it starts on. */
function sentences(pieces: readonly Unit[]): Unit[] {
  const starts: { off: number; line: number }[] = [];
  let text = "";
  for (const p of pieces) {
    const t = clean(p.text);
    if (t === "") continue;
    if (text !== "") text += " ";
    starts.push({ off: text.length, line: p.line });
    text += t;
  }
  const lineAt = (off: number): number =>
    starts.reduce((line, s) => (s.off <= off ? s.line : line), starts[0]?.line ?? 0);
  const out: Unit[] = [];
  let from = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    out.push({ line: lineAt(from), text: text.slice(from, m.index) });
    from = m.index + m[0].length;
  }
  if (from < text.length) out.push({ line: lineAt(from), text: text.slice(from) });
  return out;
}

/**
 * The status-bearing units of a Markdown document: every sentence of its prose (a paragraph or a
 * list item, joined across its wrapped lines; a blockquote marker dropped), every table row whole (a
 * row's verdict is about the subject in its first cell), every heading, and every line of a mermaid
 * diagram. Other fenced blocks — commands, JSON — carry no status prose and are skipped.
 */
function statusUnits(md: string): Unit[] {
  const out: Unit[] = [];
  let para: Unit[] = [];
  const flush = (): void => {
    out.push(...sentences(para));
    para = [];
  };
  let fence: string | null = null;
  md.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const f = FENCE.exec(raw);
    if (fence !== null) {
      if (f !== null && f[1] === "") fence = null;
      else if (fence === "mermaid" && raw.trim() !== "") out.push({ line, text: clean(raw) });
      return;
    }
    if (f !== null) {
      flush();
      fence = f[1] ?? "";
      return;
    }
    const l = raw.replace(/^\s*>\s?/, "");
    if (l.trim() === "") flush();
    else if (l.startsWith("|")) {
      flush();
      if (!/^\|\s*:?-{3,}/.test(l)) out.push({ line, text: clean(l) });
    } else if (/^#{1,6}\s/.test(l)) {
      flush();
      out.push({ line, text: clean(l) });
    } else {
      if (ITEM.test(l)) flush();
      para.push({ line, text: l });
    }
  });
  flush();
  return out;
}

/** Words that say something is not built (yet). */
const DENIAL: readonly RegExp[] = [
  /\bplanned\b/i,
  /\bunbuilt\b/i,
  /\bnot (?:yet )?(?:been )?(?:built|implemented)\b(?! from\b)/i,
  /\b(?:built|implemented) yet\b/i,
  /\bto be (?:written|built|implemented)\b/i,
  /\bnothing\b[^.;]*\b(?:is|are|has been|have been) (?:yet )?(?:built|implemented)\b/i,
];

/**
 * What is not built: the write module and its parts — Phase W, its seven tools, the confirmation gate
 * and `eff confirm`, the write host — Phase 4, and whatever the README marks 📋 (docs-current holds
 * a tool row's 📋 to the registry).
 */
const UNBUILT: readonly RegExp[] = [
  /\bwrite module\b/i,
  /\bwrite (?:tools?|path|host|phase|surface)\b/i,
  /\bconditional writes?\b/i,
  /\bphase w\b/i,
  /\bconfirmation gate\b/i,
  /\beff confirm\b/,
  /\bphase 4\b/i,
  /📋/u,
  new RegExp(`\\b(?:${WRITE_TOOL_NAMES.join("|")})\\b`),
];

/** The units that say something is not built without naming anything that is not built. */
function unsupportedDenials(units: readonly Unit[]): string[] {
  return units
    .filter((u) => DENIAL.some((re) => re.test(u.text)) && !UNBUILT.some((re) => re.test(u.text)))
    .map((u) => `${String(u.line)}: ${u.text}`);
}

/** The documents a reader meets first: the root documents and the two indexes the README links. */
const STATUS_DOCS = [
  "README.md",
  "SECURITY.md",
  "CHANGELOG.md",
  ".env.example",
  "docs/README.md",
  "docs/plan/00-index.md",
] as const;

/** A document's units; `.env.example`'s comment markers are dropped first, so it reads as prose. */
const unitsOf = (doc: string): Unit[] =>
  statusUnits(doc === ".env.example" ? readDoc(doc).replace(/^#[ \t]?/gm, "") : readDoc(doc));

const README = readDoc("README.md");

describe("the status check can fail (positive controls)", () => {
  it.each([
    "Nothing on this page is implemented yet.",
    "A planned local server, to be written in Node/TypeScript on the official MCP SDK.",
    "Thirteen Skills are planned alongside the server.",
    "Everything drawn here is planned, not built.",
    "The planned server makes no telemetry, error-reporting or third-party LLM calls.",
    "The plan is unbuilt.",
    "| Provider | Planned use | Licence / terms |",
    "SDK. **Nothing in this plan is built.** Every feature is planned.",
  ])("flags %j", (text) => {
    expect(unsupportedDenials(statusUnits(text)).length).toBeGreaterThan(0);
  });

  it.each([
    "The write module is not built.",
    "**Status legend used throughout:** ✅ implemented · 🚧 in progress · 📋 planned",
    "| `eff confirm <id>` | The terminal confirmation channel for a prepared write | Phase W | 📋 |",
    "| Write module | ⛔ not built — the owner's decision D11 | plan 10 §3.W |",
    "This design was informed by research, not built from anyone else's code.",
    "| ESPN's fantasy **write** host | Nothing, unless the write module is built and enabled | — |",
    "No write tool exists: Phase W is not built; seams carry a `PHASE W SEAM — NOT IMPLEMENTED` marker.",
  ])("passes %j", (text) => {
    expect(unsupportedDenials(statusUnits(text))).toEqual([]);
  });

  it("judges each sentence alone: a write-module sentence beside it excuses nothing", () => {
    const md = "The write module is not built. Thirteen Skills are\nplanned alongside the server.";
    expect(unsupportedDenials(statusUnits(md))).toEqual([
      "1: Thirteen Skills are planned alongside the server.",
    ]);
  });

  it("reads mermaid lines and skips command blocks", () => {
    const md = ["```mermaid", 'G["a planned thing"]', "```", "```sh", "# planned", "```"].join(
      "\n",
    );
    expect(unsupportedDenials(statusUnits(md))).toEqual(['2: G["a planned thing"]']);
  });
});

describe("a status word names something that is not built", () => {
  it.each(STATUS_DOCS)("%s", (doc) => {
    expect(unsupportedDenials(unitsOf(doc))).toEqual([]);
  });
});

/** Emphasis, code marks and typographic quotes dropped, whitespace collapsed: how quotes compare. */
const plain = (s: string): string =>
  s.replace(/[*`]/g, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** The plan and the research, each in `plain` form: what the README may quote. */
const SOURCES = ["docs/plan", "docs/research"]
  .flatMap((dir) =>
    readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => plain(readDoc(`${dir}/${f}`))),
  )
  .join("\n");

/**
 * The quotations a document presents as the plan's: an emphasised one (*"…"* or **"…"**), a
 * block-quoted one (> "…"), and one introduced as the plan's words.
 */
function quotations(md: string): string[] {
  const found = [
    ...[...md.matchAll(/\*{1,2}"([^"\n]+)"\*{1,2}/g)].map((m) => m[1]),
    ...[...md.matchAll(/^> "(.+)"\s*$/gm)].map((m) => m[1]),
    ...[...md.matchAll(/\b(?:the plan says|in the plan's own words:?)\s*\*{0,2}"([^"\n]+)"/gi)].map(
      (m) => m[1],
    ),
  ];
  return [...new Set(found.map((q) => plain(q ?? "")))];
}

describe("every quotation the README presents as the plan's is the plan's, verbatim", () => {
  it("the check can fail: plan 10 §0's 2026-10-05 rewrite removed the sentence the Roadmap quoted", () => {
    const old = `In the plan's own words: *"Under no branch does a week-4 start yield a week-4 product."*`;
    expect(quotations(old)).toEqual([
      "Under no branch does a week-4 start yield a week-4 product.",
    ]);
    expect(SOURCES).not.toContain("Under no branch");
  });

  it("finds the README's quotations, and each is in docs/plan or docs/research", () => {
    const quotes = quotations(README);
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    expect(quotes.filter((q) => !SOURCES.includes(q))).toEqual([]);
  });
});

type Size = "S" | "M" | "L";
const SIZES: readonly Size[] = ["S", "M", "L"];
const PLAN10 = readDoc("docs/plan/10-phasing-and-acceptance.md");
/** A scale as compared: plain, with an en-dash range spelled "1 to 3". */
const scaleText = (s: string): string => plain(s).replace(/(\d)\s*[–-]\s*(\d)/g, "$1 to $2");
const scaleIn = (re: RegExp): Record<Size, string> => {
  const m = re.exec(PLAN10);
  return { S: scaleText(m?.[1] ?? ""), M: scaleText(m?.[2] ?? ""), L: scaleText(m?.[3] ?? "") };
};
/** Plan 10's effort scale since its recalibration (2026-10-05), and the scale it withdrew. */
const CURRENT = scaleIn(/\bRead S ≈ ([^,]+), M ≈ ([^,]+), L ≈ ([^;]+);/);
const WITHDRAWN = scaleIn(
  /\bThe original scale \(S ≈ ([^,]+), M ≈ ([^,]+), L ≈ (.+?) of a human engineer\)/,
);
/** Whether `line` states `size` as `value` ("S ≈ hours", "S is hours", "**S** ≈ hours"). */
const states = (line: string, size: Size, value: string): boolean =>
  new RegExp(`\\b${size} (?:≈ |is )?${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line);
/** The README's lines that state an effort scale. */
const scaleLines = (md: string): string[] =>
  md
    .split("\n")
    .map(scaleText)
    .filter((l) => /\bS (?:≈|is) /.test(l));

describe("the README's effort scale is plan 10's, never the one plan 10 withdrew", () => {
  it("plan 10 states both scales, and they differ (the reader works)", () => {
    for (const s of SIZES) {
      expect(CURRENT[s], s).not.toBe("");
      expect(WITHDRAWN[s], s).not.toBe("");
      expect(CURRENT[s], s).not.toBe(WITHDRAWN[s]);
    }
  });

  it("the check can fail: the Roadmap's former line states the withdrawn scale", () => {
    const old =
      "Effort scale from the plan: **S** ≈ days · **M** ≈ 1–3 weeks · **L** ≈ 4–8 weeks of one senior engineer.";
    const [line = ""] = scaleLines(old);
    expect(SIZES.every((s) => states(line, s, WITHDRAWN[s]))).toBe(true);
    expect(SIZES.some((s) => states(line, s, CURRENT[s]))).toBe(false);
  });

  it("every line of the README that states a scale states plan 10's current one", () => {
    const lines = scaleLines(README);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines)
      for (const s of SIZES) {
        expect(states(l, s, CURRENT[s]), `${s} in: ${l}`).toBe(true);
        expect(states(l, s, WITHDRAWN[s]), `${s} in: ${l}`).toBe(false);
      }
  });
});

/** The plan 10 decisions docs/HANDOFF.md records as made ("Decisions made"), each with its date. */
function decisionsMade(handoff: string): { id: string; date: string }[] {
  return tableRows(section(handoff, "## Decisions made"))
    .slice(1)
    .flatMap((cells) =>
      [...new Set([...cells.join(" ").matchAll(/\bD\d+\b/g)].map((m) => m[0]))].map((id) => ({
        id,
        date: cells[0] ?? "",
      })),
    );
}

describe("the README's owner decisions are the ones docs/HANDOFF.md records as made", () => {
  const made = decisionsMade(readDoc("docs/HANDOFF.md"));

  it("HANDOFF records D0, D1, D2 and D11 as made, each dated (the reader works)", () => {
    const ids = made.map((d) => d.id);
    for (const id of ["D0", "D1", "D2", "D11"]) expect(ids).toContain(id);
    for (const d of made) expect(d.date, d.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the decisions section names each one in a sentence that carries its date, and cites HANDOFF", () => {
    const sec = section(README, "### Decisions that belong to the owner");
    expect(sec).toContain("](docs/HANDOFF.md");
    const units = statusUnits(sec);
    const undated = made.filter(({ id, date }) => {
      // a range ("D0–D15") names no decision
      const named = new RegExp(`(?<![–-])\\b${id}\\b(?!\\s*[–-]\\s*D\\d)`);
      return !units.some((u) => named.test(u.text) && u.text.includes(date));
    });
    expect(undated).toEqual([]);
  });
});

describe("the plan index — where the README and CLAUDE.md send a reader first — is the design's record", () => {
  const index = readDoc("docs/plan/00-index.md");
  const end = index.search(/^## /m);

  it("its lead calls the plan the record of the design and links the build state and the rulings", () => {
    expect(end).toBeGreaterThan(0);
    const lead = index.slice(0, end);
    expect(lead).toMatch(/\brecord of the design\b/);
    expect(lead).toContain("](../../README.md#status)");
    expect(lead).toContain("](../HANDOFF.md)");
    expect(lead).toContain("](changelog.md)");
  });
});
