// read-only.test.ts — the model-driven evaluation set (plan 05 §6 and T7; plan 10 A10b; the record:
// docs/evals/model-driven-evals.md). tests/evals/read-only.xml holds the ten read-only questions in
// the mcp-builder evaluation.md format (`<evaluation><qa_pair><question/><answer/></qa_pair>`) over
// the derived league fixtures/espn/fx-10h (league id 0, weeks 1–4 final, week 5 not yet played). The
// model-driven RUN stays manual and pre-release because it spends model tokens. This test spends none.
// It holds what the run depends on:
//   - the file parses exactly as the runner's ElementTree reads it (each element one text node,
//     entities only, ten pairs);
//   - every question names its weeks and its answer format and uses no "current state" wording
//     (evaluation.md's stability rule), and every answer is one short value for direct string
//     comparison;
//   - every answer is re-derived here from the tools' own outputs, through the real composition root
//     in fixture mode on a fresh state (no dataset refresh), as the documented run starts the server.
//     The solver uses only read-only tools that report ESPN facts (readOnlyHint, meta.estimate false).
//     It refuses a question whose answer is not unique: a tie, a threshold within rounding distance,
//     or an unobserved week that could change the answer.
// The answers are re-derived under both toolsets, so the key holds whichever one the run uses, and the
// record's answer-key section is kept equal to this run (UPDATE_EVALS=1 rewrites it).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evalsSection, writeEvalsSection } from "../golden/evals-doc.js";
import { ESPN_FIXTURES, ROOT, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";

/** The evaluation file plan 05 §6 names (the runner's positional argument). */
const EVAL_XML = path.join(ROOT, "tests", "evals", "read-only.xml");
/** The record of the set (docs/evals/), with the answer-key section this test keeps equal. */
const RECORD_PAGE = "model-driven-evals.md";
/** The fixture league the run serves (plan 05 §6: the frozen fixture league, id 0). */
const FX = path.join(ESPN_FIXTURES, "fx-10h");
const MANIFEST = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
  current_week: number;
  final_weeks: number[];
};
/** Plan 05 §6: ten questions; pass bar ≥ 8/10 [A-1]. */
const QUESTIONS = 10;

// ── the evaluation.md file format, read as the runner reads it ──────────────────────────────────

interface QaPair {
  readonly question: string;
  readonly answer: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** One element's text as ElementTree's `.text` reads it: the five entities decoded, no markup. */
function textOf(raw: string, where: string): string {
  if (raw.includes("<") || raw.includes("]]>")) throw new Error(`${where}: markup inside the text`);
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(raw))
    throw new Error(`${where}: a bare '&' or an entity ElementTree does not define`);
  return raw.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ENTITIES[e] ?? "");
}

/**
 * The evaluation file read the way evaluation.py reads it (`ET.parse`, `findall(".//qa_pair")`, each
 * pair's `question` / `answer` `.text.strip()`), but strict. The grammar is evaluation.md's alone: an
 * optional XML declaration, comments only outside the pairs, and `<evaluation>` holding `<qa_pair>`s
 * of exactly `<question>` then `<answer>`, each a single text node. A comment or child element inside
 * a question would make `.text` stop short, so nothing the runner would read differently can pass.
 */
function parseEvaluation(xml: string): QaPair[] {
  let s = xml.startsWith("﻿") ? xml.slice(1) : xml;
  const decl = /^<\?xml[^?]*\?>/.exec(s);
  if (decl !== null) s = s.slice(decl[0].length);
  /** Skips whitespace and comments (outside the pairs only). */
  const skip = (): void => {
    for (;;) {
      s = s.trimStart();
      if (!s.startsWith("<!--")) return;
      const end = s.indexOf("-->");
      if (end === -1) throw new Error("an unterminated comment");
      if (s.slice(4, end).includes("--")) throw new Error("'--' inside a comment");
      s = s.slice(end + 3);
    }
  };
  const tag = (t: string): void => {
    if (!s.startsWith(t)) throw new Error(`expected ${t} at: ${JSON.stringify(s.slice(0, 40))}`);
    s = s.slice(t.length);
  };
  const element = (name: string, where: string): string => {
    s = s.trimStart();
    tag(`<${name}>`);
    const end = s.indexOf(`</${name}>`);
    if (end === -1) throw new Error(`${where}: no </${name}>`);
    const text = textOf(s.slice(0, end), `${where} <${name}>`).trim();
    s = s.slice(end + name.length + 3);
    return text;
  };
  skip();
  tag("<evaluation>");
  const pairs: QaPair[] = [];
  for (;;) {
    skip();
    if (s.startsWith("</evaluation>")) break;
    const where = `qa_pair ${String(pairs.length + 1)}`;
    tag("<qa_pair>");
    const question = element("question", where);
    const answer = element("answer", where);
    s = s.trimStart();
    tag("</qa_pair>");
    pairs.push({ question, answer });
  }
  tag("</evaluation>");
  skip();
  if (s !== "") throw new Error(`content after </evaluation>: ${JSON.stringify(s.slice(0, 40))}`);
  return pairs;
}

let cached: QaPair[] | null = null;
/** The committed set (read lazily: a missing file fails the tests that need it, by name). */
function committed(): QaPair[] {
  cached ??= parseEvaluation(readFileSync(EVAL_XML, "utf8"));
  return cached;
}
function pair(n: number): QaPair {
  const p = committed()[n - 1];
  if (p === undefined) throw new Error(`no qa_pair ${String(n)}`);
  return p;
}

// ── reading tool results ─────────────────────────────────────────────────────────────────────────

type J = Record<string, unknown>;
const isRec = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
function obj(v: unknown, what: string): J {
  if (!isRec(v)) throw new Error(`${what}: not an object`);
  return v;
}
function list(v: unknown, what: string): J[] {
  if (!Array.isArray(v)) throw new Error(`${what}: not an array`);
  return v.map((x, i) => obj(x, `${what}[${String(i)}]`));
}
function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what}: not a number`);
  return v;
}
function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what}: not a string`);
  return v;
}
function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${what}: not an array`);
  return v.map((x, i) => str(x, `${what}[${String(i)}]`));
}
/** A team name: it arrives wrapped as untrusted_text (plan 01 §4.4). */
function wrapped(v: unknown, what: string): string {
  return str(obj(obj(v, what).untrusted_text, `${what}.untrusted_text`).value, `${what}.value`);
}
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * The single best item by `score`, refusing a near-tie. A tie means the question has no single
 * verifiable answer (evaluation.md, Answer Guidelines §4).
 */
function best<T>(items: readonly T[], score: (t: T) => number, what: string, margin = 0.01): T {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const [first, second] = sorted;
  if (first === undefined) throw new Error(`${what}: nothing to choose from`);
  if (second !== undefined && score(first) - score(second) < margin)
    throw new Error(`${what}: a tie within ${String(margin)} — not a single answer`);
  return first;
}

/** What a solver may do: read ESPN facts through the tools, nothing else. */
interface Reader {
  /** The whole envelope of a successful tool result that reports facts (`meta.estimate: false`). */
  envelope(tool: string, args?: J): Promise<J>;
  /** Its `data`. */
  data(tool: string, args?: J): Promise<J>;
  /** Every row of a paged list, following `page.next_offset` to the end. */
  rows(tool: string, args: J, key: string): Promise<J[]>;
}

function reader(client: Client, used: Set<string>): Reader {
  const envelope = async (tool: string, args: J = {}): Promise<J> => {
    used.add(tool);
    const r = await call(client, tool, args);
    if (r.isError) throw new Error(`${tool}: ${JSON.stringify(r.body).slice(0, 300)}`);
    if (obj(r.body.meta, `${tool}.meta`).estimate !== false)
      throw new Error(`${tool}: an estimate, not an ESPN fact — an answer key never rests on one`);
    return r.body;
  };
  return {
    envelope,
    data: async (tool, args = {}) => obj((await envelope(tool, args)).data, `${tool}.data`),
    rows: async (tool, args, key) => {
      const out: J[] = [];
      let offset = 0;
      for (let n = 0; n < 60; n++) {
        const env = await envelope(tool, { ...args, offset });
        out.push(...list(obj(env.data, `${tool}.data`)[key], `${tool}.data.${key}`));
        const page = obj(env.page, `${tool}.page`);
        if (page.has_more !== true) {
          expect(out.length, `${tool}: every row of page.total`).toBe(num(page.total, "total"));
          return out;
        }
        offset = num(page.next_offset, `${tool}.page.next_offset`);
      }
      throw new Error(`${tool}: more than 60 pages`);
    },
  };
}

// ── the solvers: each question answered from the tools, the way a careful reader would ───────────

interface Side {
  readonly name: string;
  readonly points: number;
}

/** Q1: in the week (1–4) with the highest league-wide total, the loser by the widest margin. */
async function q1(r: Reader): Promise<string> {
  const weeks: { week: number; total: number; games: [Side, Side | null][] }[] = [];
  for (const week of [1, 2, 3, 4]) {
    const d = await r.data("espn_get_scoreboard", { week });
    const games = list(d.matchups, "matchups").map((m): [Side, Side | null] => {
      const side = (v: unknown, what: string): Side => {
        const s = obj(v, what);
        return { name: wrapped(s.name, `${what}.name`), points: num(s.points, `${what}.points`) };
      };
      return [side(m.home, "home"), isRec(m.away) ? side(m.away, "away") : null];
    });
    const total = sum(games.flatMap(([h, a]) => [h.points, a?.points ?? 0]));
    weeks.push({ week, total, games });
  }
  const top = best(weeks, (w) => w.total, "the week with the highest league total");
  const losses = top.games.flatMap(([h, a]) =>
    a === null || h.points === a.points
      ? []
      : [
          h.points < a.points
            ? { ...h, margin: a.points - h.points }
            : { ...a, margin: h.points - a.points },
        ],
  );
  return best(losses, (l) => l.margin, "the widest losing margin").name;
}

/**
 * Q2: available FLEX-eligible players (free agents or on waivers) projected above Team 03's
 * lowest-projected RB/WR/TE/FLEX starter for week 5.
 */
async function q2(r: Reader): Promise<string> {
  const roster = await r.data("espn_get_roster", { team_id: 3, week: 5 });
  expect(roster.week).toBe(5);
  const starters = list(roster.players, "players").filter((p) =>
    ["RB", "WR", "TE", "FLEX"].includes(str(p.slot, "slot")),
  );
  expect(starters).toHaveLength(6); // RB, RB, WR, WR, TE, FLEX
  const proj = (p: J): number => num(p.projection_week_espn, "projection_week_espn");
  const bar = proj(best(starters, (p) => -proj(p), "the lowest-projected starter"));
  const pool = await r.rows(
    "espn_list_players",
    { status: "AVAILABLE", sort: "projection_week", week: 5, limit: 100 },
    "players",
  );
  const flex = pool.filter((p) => strings(p.eligible_slots, "eligible_slots").includes("FLEX"));
  for (const p of flex) expect(["FREEAGENT", "WAIVERS"]).toContain(p.status);
  const above = (round: (x: number) => number): number =>
    flex
      .filter((p) => typeof p.projection_week_espn === "number")
      .filter((p) => round(proj(p)) > round(bar)).length;
  const exact = above((x) => x);
  // a reader who rounds the projections to one or two decimals counts the same players
  expect(above((x) => Math.round(x * 100) / 100)).toBe(exact);
  expect(above((x) => Math.round(x * 10) / 10)).toBe(exact);
  return String(exact);
}

/** Q3: the points of one made 45-yard field goal (the fg_distance family's member, its item). */
async function q3(r: Reader): Promise<string> {
  const scoring = obj(
    (await r.data("espn_get_league", { include: ["scoring"] })).scoring,
    "scoring",
  );
  const fg = list(scoring.families, "families").filter((f) => f.family === "fg_distance");
  expect(fg).toHaveLength(1);
  const members = list(fg[0]?.members, "members").filter(
    (m) => num(m.lower, "lower") <= 45 && (m.upper === null || 45 <= num(m.upper, "upper")),
  );
  expect(members).toHaveLength(1);
  const id = str(members[0]?.stat_id, "stat_id");
  const items = list(scoring.items, "items").filter((i) => i.stat_id === id);
  expect(items).toHaveLength(1);
  const item = obj(items[0], "item");
  const overrides = obj(item.overrides, "overrides");
  const points = typeof overrides.K === "number" ? overrides.K : num(item.points, "points");
  return String(points);
}

/** Q4: the player in Team 03's FLEX slot in week 4. */
async function q4(r: Reader): Promise<string> {
  const roster = await r.data("espn_get_roster", { team_id: 3, week: 4 });
  expect(roster.week).toBe(4);
  const flex = list(roster.players, "players").filter((p) => p.slot === "FLEX");
  expect(flex).toHaveLength(1);
  return str(flex[0]?.name, "name");
}

/**
 * Q5: would the first seed still be first if ties were broken head to head instead of by points
 * for? Only a tie at the top could move him. With an outright best record no tiebreak applies, so
 * the answer is True under every reading — he leads on points too, the points-only reading. A tie at
 * the top would need the head-to-head results, and the question would need revisiting.
 */
async function q5(r: Reader): Promise<string> {
  const d = await r.data("espn_get_standings");
  const teams = list(d.teams, "teams").map((t) => ({
    id: num(t.team_id, "team_id"),
    seed: num(t.playoff_seed, "playoff_seed"),
    pct: num(t.pct, "pct"),
    pf: num(t.points_for, "points_for"),
  }));
  const first = teams.filter((t) => t.seed === 1);
  expect(first).toHaveLength(1);
  const leader = best(teams, (t) => t.pct, "the best record (an outright leader)", 1e-9);
  expect(leader.id).toBe(first[0]?.id);
  expect(best(teams, (t) => t.pf, "the most points for").id).toBe(leader.id);
  return "True";
}

/** Q6: the other NFL teams on bye in the week Team 01's week-4 starting quarterback's team is. */
async function q6(r: Reader): Promise<string> {
  const roster = await r.data("espn_get_roster", { team_id: 1, week: 4 });
  const qbs = list(roster.players, "players").filter((p) => p.slot === "QB");
  expect(qbs).toHaveLength(1);
  const qb = obj(qbs[0], "qb");
  const team = str(qb.pro_team, "pro_team");
  const bye = num(qb.bye_week, "bye_week");
  const sched = await r.data("espn_get_schedule", { weeks: [bye] });
  const byes = strings(obj(sched.byes, "byes")[String(bye)], `byes.${String(bye)}`);
  expect(byes).toContain(team);
  expect(new Set(byes).size).toBe(byes.length);
  // a team on bye plays no game that week
  for (const g of list(sched.games, "games")) {
    expect(byes).not.toContain(g.home);
    expect(byes).not.toContain(g.away);
  }
  return String(byes.length - 1);
}

/**
 * Q7: of the players added by the waiver claims executed in week 2, how many are no longer on the
 * claiming team's week-5 roster.
 */
async function q7(r: Reader): Promise<string> {
  const env = await r.envelope("espn_list_transactions", { week: 2, count: 200 });
  expect(obj(env.page, "page").has_more).toBe(false);
  const tx = list(obj(env.data, "data").transactions, "transactions");
  expect(tx.length).toBeGreaterThan(0);
  for (const t of tx) expect(t.scoring_period).toBe(2);
  const claims = tx
    .filter((t) => t.type === "WAIVER" && t.status === "EXECUTED")
    .flatMap((t) =>
      list(t.items, "items")
        .filter((i) => i.type === "ADD")
        .map((i) => ({ team: num(t.team_id, "team_id"), player: num(i.player_id, "player_id") })),
    );
  expect(claims.length).toBeGreaterThan(0);
  let gone = 0;
  for (const team of new Set(claims.map((c) => c.team))) {
    const roster = await r.data("espn_get_roster", { team_id: team, week: 5 });
    const ids = new Set(list(roster.players, "players").map((p) => num(p.player_id, "player_id")));
    gone += claims.filter((c) => c.team === team && !ids.has(c.player)).length;
  }
  return String(gone);
}

/**
 * Q8: on Team 02's week-5 roster, the largest gap between ESPN's rest-of-season projection and the
 * points actually scored in weeks 1–4. A week's points are read from Team 02's roster of that week.
 * A week a player spent elsewhere is unobserved here and counts 0. That week could be on another
 * roster, or unrostered, where no tool shows a free agent's line. So his gap can only be overstated,
 * unless that week scored below zero; the margin covers that. The winner must have all four weeks
 * on Team 02, so his gap is exact, and he must lead every other gap by at least 20 points.
 */
async function q8(r: Reader): Promise<string> {
  const roster = await r.data("espn_get_roster", { team_id: 2, week: 5 });
  const mine = list(roster.players, "players").map((p) => ({
    id: num(p.player_id, "player_id"),
    name: str(p.name, "name"),
  }));
  const rostered = await r.rows(
    "espn_list_players",
    { status: "ONTEAM", sort: "projection_ros", limit: 100 },
    "players",
  );
  const ros = new Map(rostered.map((p) => [num(p.player_id, "player_id"), p.projection_ros_espn]));
  const actual = new Map<number, { points: number; weeks: number }>();
  for (const week of [1, 2, 3, 4]) {
    const d = await r.data("espn_get_roster", { team_id: 2, week });
    expect(d.week).toBe(week);
    for (const p of list(d.players, "players")) {
      const id = num(p.player_id, "player_id");
      const a = actual.get(id) ?? { points: 0, weeks: 0 };
      const pts = p.points_week_espn;
      actual.set(id, {
        points: a.points + (typeof pts === "number" ? pts : 0),
        weeks: a.weeks + 1,
      });
    }
  }
  const rows = mine.map((p) => {
    const projected = ros.get(p.id);
    const a = actual.get(p.id) ?? { points: 0, weeks: 0 };
    return {
      ...p,
      gap: (typeof projected === "number" ? projected : 0) - a.points,
      complete: a.weeks === 4,
    };
  });
  expect(rows.every((p) => ros.has(p.id))).toBe(true);
  const top = best(rows, (p) => p.gap, "the largest projection-minus-actual gap", 20);
  expect(top.complete).toBe(true);
  return top.name;
}

/** Q9: the reception stat id, and whether it scores exactly 0.5. */
async function q9(r: Reader): Promise<string> {
  const scoring = obj(
    (await r.data("espn_get_league", { include: ["scoring"] })).scoring,
    "scoring",
  );
  const rec = list(scoring.items, "items").filter((i) => i.canonical === "rec");
  expect(rec).toHaveLength(1);
  const item = obj(rec[0], "rec");
  return `${str(item.stat_id, "stat_id")},${String(num(item.points, "points") === 0.5)}`;
}

/** Q10: Team 02's week-3 actual total minus the sum of its nine starters' ESPN projections. */
async function q10(r: Reader): Promise<string> {
  const d = await r.data("espn_get_box_score", { week: 3, team_id: 2 });
  expect(d.final).toBe(true);
  const sides = list(d.matchups, "matchups")
    .flatMap((m) => [m.home, m.away])
    .filter(isRec)
    .filter((s) => s.team_id === 2);
  expect(sides).toHaveLength(1);
  const side = obj(sides[0], "side");
  const started = list(side.players, "players").filter(
    (p) => p.slot_class === "starter" || p.slot_class === "flex",
  );
  expect(started).toHaveLength(9);
  const actual = num(side.total_points, "total_points");
  // the actual total is the starters' points (what "actual total" means here)
  expect(sum(started.map((p) => num(p.points_espn, "points_espn")))).toBeCloseTo(actual, 6);
  const projections = started.map((p) => num(p.projected_espn, "projected_espn"));
  const diff = actual - sum(projections);
  // not within rounding distance of a one-decimal boundary, and the same answer when a reader
  // rounds each projection to one decimal first
  expect(Math.abs(((diff * 10) % 1) - 0.5)).toBeGreaterThan(0.05);
  expect((actual - sum(projections.map((x) => Math.round(x * 10) / 10))).toFixed(1)).toBe(
    diff.toFixed(1),
  );
  return diff.toFixed(1);
}

const SOLVERS: readonly ((r: Reader) => Promise<string>)[] = [
  q1,
  q2,
  q3,
  q4,
  q5,
  q6,
  q7,
  q8,
  q9,
  q10,
];

// ── the tests ────────────────────────────────────────────────────────────────────────────────────

describe("tests/evals/read-only.xml — the evaluation.md format (plan 05 §6)", () => {
  it("parses as the runner reads it: ten qa_pairs, each one question and one answer", () => {
    const pairs = committed();
    expect(pairs).toHaveLength(QUESTIONS);
    expect(SOLVERS).toHaveLength(QUESTIONS);
    for (const p of pairs) {
      expect(p.question.length).toBeGreaterThan(40);
      expect(p.answer.length).toBeGreaterThan(0);
    }
    expect(new Set(pairs.map((p) => p.question)).size).toBe(QUESTIONS);
  });

  it("every answer is one short value for direct string comparison", () => {
    for (const p of committed()) {
      expect(p.answer, p.question).toMatch(/^[^\s"'`<>].{0,38}[^\s"'`<>.]$|^[^\s"'`<>.]$/);
      expect(p.answer).not.toMatch(/\n/);
    }
  });

  it("every question is stable and states its answer format (evaluation.md's stability rule)", () => {
    for (const p of committed()) {
      expect(p.question).not.toMatch(
        /\b(this week|current(ly)?|today|right now|so far|latest|this season)\b/i,
      );
      expect(p.question).toMatch(/\bAnswer (with|as)\b/);
    }
    // every question that is about results or rosters names its weeks; Q3 and Q9 read the settings
    for (const n of [1, 2, 4, 5, 6, 7, 8, 10]) expect(pair(n).question).toMatch(/\bweeks? \d/);
  });

  it("the strict reader refuses what ElementTree would read differently", () => {
    const one = "<qa_pair><question>Q?</question><answer>A</answer></qa_pair>";
    expect(parseEvaluation(`<evaluation>${one}</evaluation>`)).toEqual([
      { question: "Q?", answer: "A" },
    ]);
    expect(
      parseEvaluation(`<?xml version="1.0"?>\n<!-- c -->\n<evaluation>\n  ${one}\n</evaluation>\n`),
    ).toHaveLength(1);
    expect(
      parseEvaluation(
        "<evaluation><qa_pair><question>a &amp; b</question><answer>x &lt; y</answer></qa_pair></evaluation>",
      ),
    ).toEqual([{ question: "a & b", answer: "x < y" }]);
    for (const bad of [
      "<evaluation><qa_pair><question>a <!-- c --> b</question><answer>A</answer></qa_pair></evaluation>",
      "<evaluation><qa_pair><question>a & b</question><answer>A</answer></qa_pair></evaluation>",
      "<evaluation><qa_pair><question>Q<b>x</b></question><answer>A</answer></qa_pair></evaluation>",
      "<evaluation><qa_pair><answer>A</answer><question>Q</question></qa_pair></evaluation>",
      `<evaluation>${one}</evaluation><evaluation></evaluation>`,
      `<evaluation>${one}`,
      `<evaluation><qa_pair><question><![CDATA[Q]]></question><answer>A</answer></qa_pair></evaluation>`,
    ])
      expect(() => parseEvaluation(bad), bad).toThrow();
  });

  it("the plan and the record name this file, the fixture league and the pass bar", () => {
    const plan = readFileSync(path.join(ROOT, "docs/plan/05-testing-strategy.md"), "utf8");
    expect(plan).toContain("`tests/evals/read-only.xml`");
    const record = readFileSync(path.join(ROOT, "docs/evals", RECORD_PAGE), "utf8");
    expect(record).toContain("tests/evals/read-only.xml");
    expect(record).toContain("fixtures/espn/fx-10h");
    expect(record).toMatch(/≥ 8\/10/);
    // the fixture state every question assumes: weeks 1–4 final, week 5 not yet played
    expect(MANIFEST.final_weeks).toEqual([1, 2, 3, 4]);
    expect(MANIFEST.current_week).toBe(5);
  });
});

/** The answer-key section of the record: each answer and the tools its solver read. */
function keySection(rows: readonly { n: number; answer: string; tools: string[] }[]): string {
  const lines = ["| # | answer | tools the solver read |", "|---|---|---|"];
  for (const r of rows)
    lines.push(
      `| ${String(r.n)} | \`${r.answer}\` | ${r.tools.map((t) => `\`${t}\``).join(", ")} |`,
    );
  return lines.join("\n");
}

describe.each(["core", "full"] as const)(
  "the answer key, re-derived from the tools in fixture mode (EFF_TOOLSET=%s)",
  (toolset) => {
    let world: World;
    let client: Client;
    let close: () => Promise<void>;
    let readOnly: Map<string, boolean>;
    const derived: { n: number; answer: string; tools: string[] }[] = [];

    beforeAll(async () => {
      world = await makeWorld({
        env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: toolset },
        teamId: MANIFEST.my_team_id,
        clock: MANIFEST.clock,
        // a fresh state: the documented run starts the server with no dataset refreshed
        publishEspn: false,
      });
      const c = await connect(world, { options: { toolset } });
      client = c.client;
      close = c.close;
      const tools = (await client.listTools()).tools;
      readOnly = new Map(tools.map((t) => [t.name, t.annotations?.readOnlyHint === true]));
    }, 120_000);

    afterAll(async () => {
      await close();
      world.cleanup();
    });

    it.each(Array.from({ length: QUESTIONS }, (_v, i) => i + 1))(
      "question %i: the committed answer is what the tools show",
      async (n) => {
        const solve = SOLVERS[n - 1];
        if (solve === undefined) throw new Error(`no solver for question ${String(n)}`);
        const used = new Set<string>();
        const answer = await solve(reader(client, used));
        expect(answer, pair(n).question).toBe(pair(n).answer);
        // read-only, independent of any write: every tool the solver needed is annotated read-only
        for (const t of used) expect(readOnly.get(t), t).toBe(true);
        derived.push({ n, answer, tools: [...used].sort() });
      },
      120_000,
    );

    if (toolset === "core")
      it("the record's answer key is this run's (docs/evals/model-driven-evals.md)", () => {
        expect(derived.map((d) => d.n)).toEqual(
          Array.from({ length: QUESTIONS }, (_v, i) => i + 1),
        );
        const section = keySection(derived);
        if (process.env.UPDATE_EVALS === "1") writeEvalsSection(RECORD_PAGE, "answer-key", section);
        expect(evalsSection(RECORD_PAGE, "answer-key")).toBe(section);
      });
  },
);
