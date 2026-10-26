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
// Stage C round 3, finding docs-prebuild-markers-remain (area repo-root): the check's words missed
// the pre-build phrasings, and it did not read docs/HANDOFF.md. SECURITY.md scoped the server, the
// CLI, the Skills, the scripts, the CI workflows and the pins "once they exist"; docs/README.md said
// the plan was "awaiting the owner's approval" ("approval … is what starts the build"), called the
// code "(future)" and did not index docs/evals/; HANDOFF headed Program status "pre-build" with the
// build "blocked on Chad's plan approval", called the working directory iCloud-managed, sent a fresh
// context to the pre-build program's roster instead of the files CLAUDE.md names, and stated plan 10
// §0's withdrawn November expectation as the 2026 expectation. What holds now, in addition:
// 6. the denial words include those phrasings, and HANDOFF's sections that describe the state — the
//    intro, the findings, Program status, Open items — are read like the documents above;
// 7. HANDOFF places the working copy outside iCloud, as its "Decisions made" and CLAUDE.md do, and
//    sends a fresh context to the files CLAUDE.md names;
// 8. HANDOFF's Program status has a row for every stage of docs/scratch/build-program.md;
// 9. no document states plan 10 §0's withdrawn expectation as the expectation;
// 10. docs/README.md indexes every entry of docs/.
import { readdirSync, statSync } from "node:fs";
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
  // the pre-build phrasings (docs-prebuild-markers-remain): a part that exists only "once it
  // exists", a build that awaits or is blocked on an approval, a "pre-build" state, "(future)" code
  /\bonce (?:they|it|these) (?:exists?|(?:is|are) built)\b/i,
  /\b(?:await(?:s|ing)?|pending|blocked (?:on|by))\b[^.;]*\bapproval\b/i,
  /\bstarts the build\b/i,
  /\bpre-?build\b/i,
  /\(future\)/i,
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

/**
 * HANDOFF's sections that describe the state and are not rewritten at every pause: the intro (its
 * rules and its reading order) and these. ▶ NEXT STEP is rewritten at every pause and is about the
 * work ahead by design; the Build facts, the decision lists, the accumulated notes and the Log are
 * dated records.
 */
const HANDOFF_STATE_SECTIONS = [
  "## The findings that shape the product",
  "## Program status",
  "## Open items",
] as const;

/** The status units of HANDOFF's intro and state sections, each with its line in the file. */
function handoffStateUnits(md: string): Unit[] {
  const firstSection = md.split("\n").findIndex((l) => l.startsWith("## "));
  const ranges: (readonly [number, number])[] = [[1, firstSection + 1]];
  for (const heading of HANDOFF_STATE_SECTIONS) {
    const text = section(md, heading);
    const start = md.slice(0, md.indexOf(text)).split("\n").length;
    ranges.push([start, start + text.split("\n").length]);
  }
  return statusUnits(md).filter((u) => ranges.some(([from, to]) => u.line >= from && u.line < to));
}

const README = readDoc("README.md");
const HANDOFF = readDoc("docs/HANDOFF.md");

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
    // the pre-build phrasings, each as SECURITY.md, docs/README.md or HANDOFF carried it
    "- The server, the `eff` CLI, the Skills bundle and the scripts in this repository, once they exist.",
    "- The CI workflows, the secret-scanning rules and the dependency pins, once they exist — anything\n  that gates what reaches `main` or a release.",
    "The plan is final and **awaiting the owner's approval**; approval, not the review, is what starts the build.",
    "Approval, not the review, is what starts the build.",
    "| build | ⛔ blocked on Chad's plan approval | — |",
    "## Program status (pre-build: research → plan → adversarial review → docs)",
    "The licence covers this repository's own text and (future) code only.",
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
    "The write module, once it exists, registers its tools only at a restart.",
    "The owner approved the plan on 2026-10-05, and the build follows it.",
    "| build — Stage D (the final gate, the merge to `main`, the owner's install) | next | — |",
    "Players split into final, live and pending players.",
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

  it("docs/HANDOFF.md: the intro and the state sections", () => {
    expect(unsupportedDenials(handoffStateUnits(HANDOFF))).toEqual([]);
  });
});

/** The `docs/…` files a sentence sends the reader to after the one it names first (`lead` ends at "then"). */
function readsNext(md: string, lead: RegExp): string[] {
  const flat = md.replace(/\s+/g, " ");
  const m = lead.exec(flat);
  if (m === null) return [];
  const rest = flat.slice(m.index + m[0].length);
  const end = rest.search(/\.(?=\s|$)/);
  return [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/`(docs\/[^`\s]+\.md)`/g)].map(
    (x) => x[1] ?? "",
  );
}

/** The units that put the working copy in iCloud: they name iCloud, and not as where it is not. */
const inICloud = (units: readonly Unit[]): string[] =>
  units
    .filter((u) => /\biCloud\b/.test(u.text) && !/\boutside iCloud\b/.test(u.text))
    .map((u) => `${String(u.line)}: ${u.text}`);

describe("HANDOFF's intro and state sections describe the build (docs-prebuild-markers-remain)", () => {
  const units = handoffStateUnits(HANDOFF);

  it("reads the title, the intro and every state section (the reader works)", () => {
    expect(units[0]?.text).toMatch(/^# HANDOFF\b/);
    expect(units.some((u) => /\breads this first\b/.test(u.text))).toBe(true);
    for (const heading of HANDOFF_STATE_SECTIONS)
      expect(units.some((u) => u.text.startsWith(heading))).toBe(true);
  });

  it("places the working copy outside iCloud, where Decisions made and CLAUDE.md put it", () => {
    const moved = tableRows(section(HANDOFF, "## Decisions made"))
      .slice(1)
      .filter((cells) => /\boutside iCloud\b/.test(cells.join(" ")));
    expect(moved.length).toBeGreaterThan(0);
    expect(readDoc("CLAUDE.md")).toMatch(/\boutside iCloud\b/);
    const old = "The working directory is iCloud-managed, so nothing secret ever lives in it.";
    expect(inICloud(statusUnits(old))).toHaveLength(1);
    expect(inICloud(units)).toEqual([]);
  });

  it("sends a fresh context to the files CLAUDE.md names, after itself", () => {
    const claude = readsNext(
      readDoc("CLAUDE.md"),
      /\bRead `docs\/HANDOFF\.md` first\b[^.]*?\bthen\b/,
    );
    expect(claude.length).toBeGreaterThan(0);
    for (const f of claude) expect(statSync(path.join(ROOT, f)).isFile(), f).toBe(true);
    const lead = /\breads this first\b[^.]*?\bthen\b/;
    const old = [
      "A fresh context window reads this first, then",
      "`docs/scratch/roster.md` (agent state) and `docs/scratch/program.md`",
      "(waves and file ownership). Update it after every meaningful step.",
    ].join("\n");
    expect(readsNext(old, lead)).toEqual(["docs/scratch/roster.md", "docs/scratch/program.md"]);
    expect(readsNext(HANDOFF, lead)).toEqual(claude);
  });

  it("Program status has a row for every stage of docs/scratch/build-program.md", () => {
    const stages = tableRows(readDoc("docs/scratch/build-program.md"))
      .map((cells) => cells[0] ?? "")
      .filter((c) => /^[A-Z][0-9]*$/.test(c));
    expect(stages).toEqual(expect.arrayContaining(["A", "C", "D"]));
    const rows = tableRows(section(HANDOFF, "## Program status"))
      .slice(1)
      .map((cells) => cells[0] ?? "");
    const missing = stages.filter(
      (id) => !rows.some((c) => new RegExp(`\\bStage ${id}(?![0-9])`).test(c)),
    );
    expect(missing).toEqual([]);
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

describe("no document states plan 10 §0's withdrawn expectation as the expectation", () => {
  /** What plan 10 §0's rewritten paragraph says the original paragraph estimated. */
  const withdrawn =
    /\bThe original paragraph here estimated the first usable version in ([^;.]+?)[;.]/
      .exec(PLAN10)?.[1]
      ?.trim() ?? "";
  /** The units that state that estimate without saying it was withdrawn. */
  const stated = (units: readonly Unit[]): string[] =>
    units
      .filter(
        (u) =>
          u.text.includes(withdrawn) && !/\b(?:withdrawn|wrong|first estimate)\b/i.test(u.text),
      )
      .map((u) => `${String(u.line)}: ${u.text}`);

  it("plan 10 §0 names the estimate it withdrew (the reader works)", () => {
    expect(withdrawn).toBe("mid-to-late November");
  });

  it("the check can fail: HANDOFF's finding 10 stated it as the 2026 expectation", () => {
    const old =
      "Honest 2026 expectation: P0 tools mid-to-late November; `trade` misses the 2026-12-02 deadline.";
    expect(stated(statusUnits(old))).toHaveLength(1);
  });

  it("the README and HANDOFF's state sections state it only as withdrawn", () => {
    expect(stated(statusUnits(README))).toEqual([]);
    expect(stated(handoffStateUnits(HANDOFF))).toEqual([]);
  });
});

describe("docs/README.md indexes every entry of docs/", () => {
  it("names each file and directory of docs/ in a table row (a directory with its slash)", () => {
    const listed = tableRows(readDoc("docs/README.md")).map((cells) => cells[0] ?? "");
    const entries = readdirSync(path.join(ROOT, "docs"))
      .filter((e) => !e.startsWith(".") && e !== "README.md")
      .map((e) => (statSync(path.join(ROOT, "docs", e)).isDirectory() ? `${e}/` : e));
    expect(entries).toEqual(expect.arrayContaining(["HANDOFF.md", "plan/", "research/"]));
    expect(entries.filter((e) => !listed.some((c) => c.includes(`\`${e}\``)))).toEqual([]);
  });
});
