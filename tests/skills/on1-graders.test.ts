// on1-graders.test.ts — the free graders of onboard's ON-1 Lane 2 case (plan 09 §3.1 onboard; §5.2:
// "every free grader passes") accept every correct restatement of what ON-1 grades — half a point per
// reception, five points per passing TD, move-to-last (rolling) waivers, a match or mismatch per
// sampled player, the IR slots — and still reject every other format (Stage C finding
// eval-on1-regex-too-narrow). The correct wordings are not a guessed list. They are generated from
// what a reply is built from: (1) the onboard Skill's own instructions (step 2 asks for "points per
// reception (stat 53)" and "points per passing TD (stat 4)"; the output asks for the settings digest
// as one table), (2) its references (espn-vocabulary: a successful claim "sends the team to the back
// of the order"; priority-waivers: "move-to-last", "drop to last"), (3) what espn_get_league returns
// on fx-10h through the composition root an eval plugin's server runs (fixture mode, the case's
// toolset): stat ids, ESPN's abbreviations, canonical names, points, `waiver_system`,
// `predicates.is_move_to_last`, `rules.waiver.order_reset`, the IR slot — and (4) plain English, each
// in prose and in every table layout. The wrong formats are the same layouts with every other value,
// the other stats' values beside them, and whole digests of other leagues. No network, no cookie.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { gradersFor, serverEnv } from "../../scripts/skills/build-plugin-evals.mjs";
import { graderOf } from "../../scripts/skills/check-skills.mjs";
import { readManifest } from "../../scripts/skills/_lib.mjs";
import { createLogger } from "../../src/cli/log.js";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { loadConfig } from "../../src/config/schema.js";
import { parseIso, toIso, type Clock } from "../../src/domain/clock.js";
import { createServer } from "../../src/mcp/server.js";
import { buildServices } from "../../src/services/index.js";
import { storeFactory } from "../../src/store/index.js";
import { ROOT } from "./helpers.js";

type Json = Record<string, unknown>;
const manifest = readManifest(ROOT);
const ctx = {
  plugin: manifest.plugin,
  inputs: manifest.inputs,
  prompt: "Set up my league",
  expected: "the expected reply",
  reference: null,
};
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
/** `{K}` placeholders filled from `m`. */
const fill = (t: string, m: Readonly<Record<string, string>>): string =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => m[k] ?? `{${k}}`);
const cross = <A, B>(as: readonly A[], bs: readonly B[]): [A, B][] =>
  as.flatMap((a) => bs.map((b): [A, B] => [a, b]));

// --- the graders, exactly as the plugin-eval build writes them ------------------------------------

const on1 = (
  JSON.parse(read("skills/onboard/evals/evals.json")) as {
    evals: { name: string; toolset: string; expectations: string[] }[];
  }
).evals.find((c) => c.name === "ON-1");
if (on1 === undefined) throw new Error("onboard has no ON-1 case");
const ON1 = on1;

const SENTENCES = {
  reception: /^The reply states the half-point reception value/,
  passing: /^The reply states five points per passing touchdown/,
  waiver: /^The reply names the waiver system as move-to-last or rolling priority/,
  match: /^The reply reports match or mismatch for the sampled players/,
  ir: /^The reply mentions the IR slots/,
} as const;
type GraderName = keyof typeof SENTENCES;

/** The ON-1 regex grader one sentence becomes (gradersFor: the plugin-eval build's own mapping). */
function graderFor(name: GraderName): RegExp {
  const sentence = ON1.expectations.find((e) => SENTENCES[name].test(e));
  if (sentence === undefined) throw new Error(`ON-1 has no ${name} expectation`);
  const r = gradersFor(sentence, ctx);
  const fm = r.graders[0]?.frontmatter;
  if (r.errors.length > 0 || r.graders.length !== 1 || fm?.type !== "regex")
    throw new Error(`${name}: not one regex grader (${r.errors.join("; ")})`);
  return new RegExp(String(fm.pattern), String(fm.flags));
}
const G: Record<GraderName, RegExp> = {
  reception: graderFor("reception"),
  passing: graderFor("passing"),
  waiver: graderFor("waiver"),
  match: graderFor("match"),
  ir: graderFor("ir"),
};

/** The patterns ON-1 carried before this fix (e33ee16) — the regression the corpus must expose. */
const PREVIOUS: Record<GraderName, RegExp> = {
  reception:
    /half[- ]?(?:a[- ])?(?:point[- ]|pt[- ])?(?:PPR|per reception|per catch)|(?<![\d.])0?\.5[- ]?(?:pts?|points?)?[- ]?(?:PPR|per reception|per catch|per rec\b)|\brec(?:eption)?s?\b[^\n\d]{0,24}(?<![\d.])0?\.5(?!\d)/i,
  passing:
    /(?<![\d.])5[- ]?(?:pts?|points?)?[- ]?(?:per|for an?|for each|for every|a)? ?pass(?:ing)?[- ]?(?:TDs?|touchdowns?)\b|(?<![\d.])5 ?(?:pts?|points?) per pass(?:ing)?\b|\bpass(?:ing)?[- ]?(?:TDs?|touchdowns?)\b[^\n\d]{0,30}(?<![\d.])5(?![\d.])|\bTD pass(?:es)?\b[^\n\d]{0,30}(?<![\d.])5(?![\d.])/i,
  waiver: /move-to-last|rolling/i,
  match: /\bmatch\b|mismatch/i,
  ir: /\bIR\b/i,
};

// --- what a reply is built from: the Skill, its references, the tool's own output ----------------

const skill = read("skills/onboard/SKILL.md");
const step2 = /### 2\. Read and restate the format\n([\s\S]*?)\n### /.exec(skill)?.[1] ?? "";
/** Step 2's "points per <stat> (stat <id>)" phrases — the labels the Skill itself puts in a reply. */
const INVITED = [...step2.matchAll(/points per ([a-zA-Z ]+?) \(stat (\d+)\)/g)].map((m) => ({
  phrase: m[0],
  stat: m[1] ?? "",
  id: m[2] ?? "",
}));
const invited = (id: string): { phrase: string; stat: string } => {
  const i = INVITED.find((x) => x.id === id);
  if (i === undefined) throw new Error(`onboard step 2 no longer names stat ${id}`);
  return i;
};
/** A sentence of a shared reference that holds `needle` (the reference's own words). */
function referenceSentence(file: string, needle: RegExp): string {
  const text = read(`skills/_shared/references/${file}`).replace(/\s+/g, " ");
  const s = text.split(/(?<=[.!?])\s+/).find((x) => needle.test(x));
  if (s === undefined) throw new Error(`${file} no longer says ${String(needle)}`);
  return s;
}

/** espn_get_league's own vocabulary on fx-10h, read through the eval server's composition root. */
interface ToolVocab {
  readonly items: ReadonlyMap<string, { abbr: string; canonical: string; points: number }>;
  readonly waiverSystem: string;
  readonly isMoveToLast: boolean;
  readonly orderReset: boolean;
  readonly irSlot: { readonly name: string; readonly count: number };
}
let tool: ToolVocab;

/** A clock that starts at `start` and runs with real time (the ESPN limiter must see time pass). */
function runningClock(start: string): Clock {
  const base = parseIso(start);
  const origin = performance.now();
  const nowMs = (): number => Math.floor(base + (performance.now() - origin));
  return { nowMs, nowIso: () => toIso(nowMs()) };
}

beforeAll(async () => {
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-on1-graders-")));
  for (const d of ["home", "config", "cache"]) mkdirSync(path.join(state, d), { mode: 0o700 });
  const clock = runningClock("2026-10-07T01:00:00.000Z");
  const env = serverEnv({ root: ROOT, variant: null, toolset: ON1.toolset, state });
  const cache = path.join(state, "cache");
  const store = storeFactory.open({
    path: storePath(cache),
    datasetDir: datasetDir(cache),
    backupDir: backupDir(cache),
    clock,
    migrate: true,
  });
  const home = path.join(state, "home");
  const wiring = buildServices({
    config: loadConfig({ env, file: undefined, home, repoRoot: ROOT, nowMs: clock.nowMs() }),
    store,
    clock,
    logger: createLogger({ level: "error", sink: () => undefined }),
    packageRoot: ROOT,
    home,
    fetch: () => Promise.reject(new Error("no network in tests")),
    loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(wiring.services, wiring.options);
  const client = new Client({ name: "on1-graders", version: "0.0.0" });
  try {
    expect(wiring.options.fixtureMode).toBe(true);
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: "espn_get_league", arguments: {} });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
    const data = (JSON.parse(text) as { data: Json }).data;
    const scoring = data.scoring as { items: Json[] };
    const rules = data.rules as {
      waiver: { order_reset: boolean };
      waiver_system: string;
      predicates: { is_move_to_last: boolean };
    };
    const slots = (data.roster as { slots: { name: string; count: number }[] }).slots;
    const ir = slots.find((s) => s.name === "IR");
    if (ir === undefined) throw new Error("fx-10h has no IR slot");
    tool = {
      items: new Map(
        scoring.items.map((i) => [
          String(i.stat_id),
          {
            abbr: String(i.abbr),
            canonical: String(i.canonical),
            points: Number(i.points),
          },
        ]),
      ),
      waiverSystem: rules.waiver_system,
      isMoveToLast: rules.predicates.is_move_to_last,
      orderReset: rules.waiver.order_reset,
      irSlot: ir,
    };
  } finally {
    await client.close();
    await server.close();
    wiring.close();
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);

const item = (id: string): { abbr: string; canonical: string; points: number } => {
  const i = tool.items.get(id);
  if (i === undefined) throw new Error(`espn_get_league on fx-10h has no stat ${id}`);
  return i;
};

// --- the corpora ---------------------------------------------------------------------------------

/** Every way a digest row or a format sentence puts a label before its value. */
const LABEL_FIRST = [
  "{L}: {V}",
  "{L} = {V}",
  "{L} — {V}",
  "{L} – {V}",
  "{L} → {V}",
  "| {L} | {V} |",
  "| {L} | {ID} | {V} |",
  "| {ID} | {L} | {V} |",
  "**{L}:** {V}",
  "- {L}: **{V}**",
  "{L}: `{V}`",
  "{L} are worth {V}",
  "{L} score {V} each",
  "{L} is set to {V}",
];
/** Every way a sentence puts the value before the stat. */
const VALUE_FIRST = [
  "{V} per {T}",
  "{V} for each {T}",
  "{V} for every {T}",
  "{V}/{T}",
  "{V} a {T}",
  "{V} awarded per {T}",
  "{V} for all {TT}",
  "{V} apiece for {TT}",
  "{V} each for {TT}",
  "**{V}** per {T}",
  "{V} per {T} (stat {ID})",
];
const labelFirst = (labels: readonly string[], values: readonly string[], id: string): string[] =>
  cross(cross(labels, values), LABEL_FIRST).map(([[L, V], t]) => fill(t, { L, V, ID: id }));
const valueFirst = (
  values: readonly string[],
  terms: readonly (readonly [string, string])[],
  id: string,
): string[] =>
  cross(cross(values, terms), VALUE_FIRST).map(([[V, [T, TT]], t]) =>
    fill(t, { V, T, TT, ID: id }),
  );

function receptionCorpus(): { right: string[]; wrong: string[] } {
  const { abbr, canonical, points } = item("53");
  const { phrase, stat } = invited("53");
  const labels = [
    phrase,
    phrase.replace(/^p/, "P"),
    `Points per ${stat}`,
    `${stat[0]?.toUpperCase() ?? ""}${stat.slice(1)} (stat 53)`,
    abbr,
    `${abbr} (stat 53)`,
    `${abbr} (53)`,
    canonical,
    "Reception",
    "Receptions",
    "Each reception",
    "Catches",
    "PPR",
    "Reception (REC)",
    "Reception, stat 53",
    "Receptions (ESPN stat 53)",
    "Receptions [stat 53]",
    "Reception (ID 53)",
    "rec (#53)",
  ];
  const values = [
    String(points),
    "0.50",
    ".5",
    "+0.5",
    `${String(points)} pts`,
    `${String(points)} points`,
    "0.5 fantasy points",
    "½",
    "1/2",
    "half a point",
    "half-point",
    "half",
    "½ point",
    "one half point",
  ];
  const terms = [
    ["reception", "receptions"],
    ["catch", "catches"],
    ["rec", "recs"],
    [canonical, canonical],
  ] as const;
  const firstValues = [
    "0.5",
    "0.5 points",
    "0.5 pts",
    "half a point",
    "half-point",
    "½ point",
    ".5",
    "1/2 point",
    "0.50 points",
    "+0.5",
    "0.5 fantasy points",
    "half a pt",
  ];
  const wrongValues = [
    "1",
    "1.0",
    "0",
    "0.25",
    "0.75",
    "1.5",
    "10.5",
    "0.55",
    "2",
    "-0.5",
    "−0.5",
    "a full point",
    "one point",
    "none",
    "5",
    "0.05",
  ];
  const right = [
    ...labelFirst(labels, values, "53"),
    ...valueFirst(firstValues, terms, "53"),
    // the format's names
    "half-PPR",
    "Half PPR",
    "Half‑PPR",
    "half-point PPR",
    "half‐point PPR",
    "0.5 PPR",
    "0.5-PPR",
    "½-PPR",
    ".5 PPR",
    "1/2 PPR",
    "0.5PPR",
    "Half-point-PPR",
    "a half point PPR league",
    // the tool's own words, as a reply can carry them
    `| ${abbr} | 53 | ${String(points)} |`,
    `| 53 | ${abbr} | ${String(points)} |`,
    `stat 53 (${abbr}): ${String(points)}`,
    `"${canonical}": ${String(points)}`,
    `${canonical}: ${String(points)}`,
    // plain English
    "Half PPR (0.5 pts per catch); passing TDs are worth 5 points",
    "Scoring: half-point PPR, 5-point passing TDs",
    "Receptions 0.5, Pass TD 5",
    "| Reception | 0.5 pts |\n| Passing TD | 5 pts |",
    "0.5 points per reception and 5 pts per passing touchdown",
    "half a point per reception; 5 points for a passing TD",
    "Each catch is worth half a point",
    "receptions earn you half a point",
    "Receptions earn half a point (half-PPR).",
    "Receptions are worth a half point",
    "Receptions score 0.5 points apiece",
    "a reception is worth 0.5",
    "a catch is worth 0.5 points",
    "points per reception is 0.5",
    "Points per reception: half",
    "Reception points are halved (0.5)",
    "Reception points: 0.5",
    "The league awards 0.5 points per reception",
    "Receiving: 0.1 per yard, 0.5 per catch",
    "Receptions are worth 0.5 and rushing yards 0.1",
    "Receptions and receiving yards: 0.5 and 0.1",
    "Receptions and passing TDs: 0.5 and 5",
    "half-point-per-reception scoring",
    "half per reception",
    "Receptions: half per catch",
    "Half-point per reception (PPR 0.5)",
    "| Scoring | Half-PPR (0.5 per reception) |",
    "| Reception | 0.5 per catch |",
    "| Receptions | ½ pt |",
  ];
  const wrong = [
    ...labelFirst(labels, wrongValues, "53"),
    ...valueFirst(
      [
        "1 point",
        "1 pt",
        "a full point",
        "one point",
        "0.25 points",
        "0 points",
        "10.5",
        "1.5 points",
        "2 points",
      ],
      terms,
      "53",
    ),
    `| ${abbr} | 53 | 1 |`,
    `"${canonical}": 1`,
    "full PPR (1 point per reception)",
    "Receptions | 1 pt",
    "Standard scoring, no points per reception",
    "1 point per reception (not half-PPR)",
    "Full PPR, not half PPR",
    "This isn't half-PPR: 1 per catch",
    "PPR: full",
    "1 PPR",
    "full-point PPR",
    "| Reception | 53 |",
    "Receptions: 0",
    "PPR leagues give 1 point per catch",
    // the right value on another stat
    "0.5 per rushing yard",
    "Rushing yards: 0.5",
    "Completions: 0.5",
    "Rec yards: 0.5",
    "Rec yds 0.5",
    "Rec TD: 0.5",
    "Receiving yards (stat 42): 0.5",
    "0.5 per completion, receptions are worth 1",
    "Completions: 0.5. Receptions: 1.",
    "0.5 per first down; 1 per reception",
    "Receptions and 0.5 per rushing yard",
    "full PPR and 0.5 points per completion",
    "PPR: full; 0.5 points per completion",
    "full PPR and bench: 0.5",
    "PPR and the FLEX: 0.5",
  ];
  return { right, wrong };
}

function passingCorpus(): { right: string[]; wrong: string[] } {
  const { abbr, canonical, points } = item("4");
  const { phrase, stat } = invited("4");
  const labels = [
    phrase,
    phrase.replace(/^p/, "P"),
    `Points per ${stat}`,
    `${stat[0]?.toUpperCase() ?? ""}${stat.slice(1)} (stat 4)`,
    abbr,
    `${abbr} (stat 4)`,
    canonical,
    "Passing TD",
    "Passing TDs",
    "Pass TD",
    "Passing touchdowns",
    "TD passes",
    "Passing TD (PTD)",
    "Passing touchdown, stat 4",
    "Passing TDs (ESPN stat 4)",
    "TD pass",
    "Touchdown passes",
    "Passing TD (ID 4)",
    "PTD (#4)",
  ];
  const values = [
    String(points),
    "5.0",
    "+5",
    `${String(points)} pts`,
    `${String(points)} points`,
    "five",
    "five points",
    "5 fantasy points",
  ];
  const terms = [
    ["passing TD", "passing TDs"],
    ["passing touchdown", "passing touchdowns"],
    ["pass TD", "pass TDs"],
    ["TD pass", "TD passes"],
    ["touchdown pass", "touchdown passes"],
    [abbr, `${abbr}s`],
    ["touchdown thrown", "touchdowns thrown"],
    ["passing-TD", "passing-TDs"],
  ] as const;
  const firstValues = [
    "5",
    "5 points",
    "5 pts",
    "five points",
    "5-point",
    "5-pt",
    "five-point",
    "5 fantasy points",
    "**5**",
  ];
  const wrongValues = [
    "4",
    "6",
    "4.0",
    "5.5",
    "50",
    "15",
    "0.5",
    "-5",
    "−5",
    "four",
    "six",
    "4 pts",
    "6 points",
    "25",
    "0.05",
  ];
  const right = [
    ...labelFirst(labels, values, "4"),
    ...valueFirst(firstValues, terms, "4"),
    // the tool's own words
    `| ${abbr} | 4 | ${String(points)} |`,
    `| 4 | ${abbr} | ${String(points)} |`,
    `| Passing TD (4) | ${String(points)} |`,
    `stat 4 (${abbr}) = ${String(points)}`,
    `"${canonical}": ${String(points)}`,
    // plain English, prose and rows
    "Passing: 5 per TD",
    "Passing: 0.04 per yard, 5 per TD",
    "Passing: 1 per 25 yards, 5 per TD, -2 per INT",
    "Passing: 0.04/yd; 5/TD; -2/INT",
    "Passing: 5/TD, 1/25 yd, −2/INT",
    "TDs: 5 passing, 6 rushing",
    "TDs: 6 rushing/receiving, 5 passing",
    "TDs: 6 rushing/receiving; 5 passing",
    "Touchdowns: 5 for passing, 6 otherwise",
    "QBs get 5 points per TD pass",
    "QBs score 5 per passing TD and lose 2 per interception.",
    "Throwing a TD: 5 points",
    "Throwing TDs: 5 pts",
    "5 pts per TD thrown",
    "Passing touchdowns are worth 5 points (rather than the usual 4)",
    "Passing touchdowns count for five points instead of four.",
    "Pass TDs are worth an extra point (5 instead of 4)",
    "Your league awards five points for a touchdown pass.",
    "Passing TD: 5 (vs 4 standard)",
    "6-pt rush/rec TD, 5-pt pass TD",
    "passing TDs score 5 instead of the usual 4",
    "Passing TDs score 5 and rushing TDs 6",
    "Passing TDs and passing yards: 5 and 0.04",
    "4-point passing TDs are bumped to 5",
    "| Scoring | Half PPR · Pass TD 5 · Rush/Rec TD 6 · INT −2 · Fumble lost −2 |",
    "| Points per passing TD | 5 (stat 4) |",
    "Passing TDs | 5 points | (stat 4)",
    "| Stat | ID | Points |\n|---|---|---|\n| Passing TD | 4 | 5 |",
    "5-point passing TDs and 6-point rushing/receiving TDs",
    "five points for every passing touchdown",
    "Five-point passing touchdowns",
    "passing touchdowns score five",
  ];
  const wrong = [
    ...labelFirst(labels, wrongValues, "4"),
    ...valueFirst(
      ["4", "4 points", "6 pts", "four points", "6-point", "4-pt", "15 points", "5.5", "0.5"],
      terms,
      "4",
    ),
    `| ${abbr} | 4 | 4 |`,
    `| ${abbr} | 4 |`,
    `"${canonical}": 4`,
    "Passing TD (stat 4): 4",
    "Passing TD (stat 4): 6",
    "Passing TDs are worth 4 points; 5 bench slots",
    "5 bench slots and passing TDs worth 4",
    "Passing TDs (4), 5 bench",
    "Passing TDs: 4; rushing TDs: 6; 5 bench",
    "Passing: 4 per TD",
    "Passing: 4/TD; Rushing: 5/TD",
    "Passing: 4/TD; Receiving: 5/TD",
    "Passing: 4/TD; D/ST: 5/TD",
    "Passing: 4/TD; Returns: 5/TD",
    "Passing: 4 per TD; bonus 5 per TD over 40 yards",
    "Passing: 1 per 25 yards, 4 per TD; 5 bench",
    "TDs: 4 passing, 6 rushing",
    "TDs: 4 passing, 5 rushing",
    "TDs: 6 rushing; 5 passing yards",
    "passing TDs score four and week 5 is current",
    "4-point passing TDs and bench: 5, a 50+ yard field goal is worth 5, half-PPR",
    "passing TDs and FG 50+: 5",
    "passing TDs and the FLEX: 5",
    "Passing TDs and kicking: 5",
    "passing TDs score four points and seed 5 gets a bye",
    "Passing TDs are worth 0.5",
    // the right value on another stat
    "5 points per rushing TD",
    "Rushing TD: 5",
    "5 points per receiving TD",
    "Passing yards (stat 3): 5",
    "6-point passing TDs and 5-point rushing TDs",
  ];
  return { right, wrong };
}

function waiverCorpus(): { right: string[]; wrong: string[] } {
  const right = [
    // the Skill's references, verbatim
    referenceSentence(
      "espn-vocabulary.md",
      /successful claim sends the team to the back of the order/,
    ),
    referenceSentence("priority-waivers.md", /\bmove-to-last league\b/),
    referenceSentence("priority-waivers.md", /\bdrop to last\b/),
    // the tool's own field values
    `waiver_system: ${tool.waiverSystem}`,
    `Waivers: ${tool.waiverSystem}`,
    `is_move_to_last: ${String(tool.isMoveToLast)}`,
    `order_reset: ${String(tool.orderReset)}`,
    // plain English
    "move-to-last",
    "Move to last",
    "moves to last",
    "rolling waivers",
    "Rolling priority",
    "1-day waivers with move-to-last priority",
    "Waiver priority: traditional, move-to-last after each successful claim",
    "Waivers: WAIVERS_TRADITIONAL — order moves the claimant to last",
    "Waiver priority is rolling: a successful claim drops you to the bottom",
    "Priority waivers (24 h); a successful claim drops you to the back.",
    "1-day waivers; successful claims send you to the bottom of the order",
    "the claiming team goes to the end of the line",
    "Each successful claim costs your spot — you go to the back of the line",
    "a successful claim moves you to the bottom of the waiver order",
    "you fall to last in the order",
    "you become last in the order",
    "priority list, last after each claim",
    "waivers: reverse order of standings at the start, then a claim puts you last",
    "Waivers run daily; the order is traditional and doesn't reset weekly — claiming puts you at the end",
    "the waiver order does not reset",
    "your priority never resets",
    "| Waivers | Traditional, move to the last spot after a claim |",
  ];
  const wrong = [
    "FAAB, $100 budget",
    "Waivers: FAAB with a $100 budget; ties by reverse standings",
    "waiver_system: faab",
    "waiver_system: continuous",
    "is_move_to_last: false",
    "not move-to-last",
    "This is not a move-to-last league",
    "not rolling: the order resets weekly",
    "the waiver order resets weekly to reverse standings",
    "continuous waivers (WAIVERS_CONTINUOUS)",
    "first come, first served",
    "Free agency only — no waiver period",
    "Waiver order: inverse of the standings, reset each Tuesday",
    "FAAB budget never resets",
    "Players dropped go back to waivers",
    "Dropped players go to waivers until the end of the period",
    "The order resets weekly; the worst team picks first",
  ];
  return { right, wrong };
}

function irAndMatchCorpus(): Record<"ir" | "match", { right: string[]; wrong: string[] }> {
  const { name, count } = tool.irSlot;
  return {
    ir: {
      right: [
        `${String(count)} ${name} slots`,
        `${name}: ${String(count)}`,
        `| ${name} | ${String(count)} |`,
        `BE ×5, ${name} ×${String(count)}`,
        "two injured reserve slots",
        "injured-reserve spots: 2",
      ],
      wrong: ["5 bench slots", "their roster", "irrelevant", "QB, 2 RB, 2 WR"],
    },
    match: {
      right: [
        "match",
        "matches",
        "matched",
        "Every sampled player matches ESPN's points",
        "all 14 matched",
        "matching ESPN on every stat",
        "mismatch on stat 53",
        "mismatches: 0",
        "| Player 1 | match |",
      ],
      wrong: ["matchup", "14 regular-season matchups", "rematch", "the engine agrees"],
    },
  };
}

// --- the tests -----------------------------------------------------------------------------------

describe("ON-1's free graders accept every correct restatement and reject every other format (eval-on1-regex-too-narrow)", () => {
  it("the five graders tested here are every regex grader ON-1 has", () => {
    const regex = ON1.expectations.filter((e) => graderOf(e) === "regex");
    expect(regex).toHaveLength(Object.keys(SENTENCES).length);
    for (const e of regex)
      expect(
        Object.values(SENTENCES).some((re) => re.test(e)),
        e,
      ).toBe(true);
  });

  it("is built from the Skill's own words and the tool's own output (the owner's format on fx-10h)", () => {
    expect(INVITED.map((i) => i.id).sort()).toEqual(expect.arrayContaining(["4", "53"]));
    expect(item("53")).toMatchObject({ abbr: "REC", canonical: "rec", points: 0.5 });
    expect(item("4")).toMatchObject({ abbr: "PTD", canonical: "pass_td", points: 5 });
    expect(tool).toMatchObject({
      waiverSystem: "priority_move_to_last",
      isMoveToLast: true,
      orderReset: false,
      irSlot: { name: "IR", count: 2 },
    });
  });

  const corpora = (): Record<GraderName, { right: string[]; wrong: string[] }> => ({
    reception: receptionCorpus(),
    passing: passingCorpus(),
    waiver: waiverCorpus(),
    ...irAndMatchCorpus(),
  });

  it.each(Object.keys(SENTENCES) as GraderName[])("%s: every correct wording passes", (name) => {
    const { right } = corpora()[name];
    expect(right.length).toBeGreaterThan(name === "reception" || name === "passing" ? 500 : 5);
    expect(right.filter((s) => !G[name].test(s))).toEqual([]);
  });

  it.each(Object.keys(SENTENCES) as GraderName[])("%s: every wrong format fails", (name) => {
    const { wrong } = corpora()[name];
    expect(wrong.length).toBeGreaterThan(3);
    expect(wrong.filter((s) => G[name].test(s))).toEqual([]);
  });

  it("the patterns before this fix rejected wordings the Skill and the tool invite (the regression)", () => {
    const rejected = (name: GraderName, s: string): boolean => !PREVIOUS[name].test(s);
    expect(rejected("reception", `${invited("53").phrase.replace(/^p/, "P")}: 0.5`)).toBe(true);
    expect(rejected("reception", `| ${item("53").abbr} (stat 53) | 0.5 |`)).toBe(true);
    expect(rejected("passing", `${invited("4").phrase.replace(/^p/, "P")}: 5`)).toBe(true);
    expect(rejected("passing", `${item("4").abbr} (stat 4): 5`)).toBe(true);
    expect(rejected("passing", "Passing touchdowns are worth five points")).toBe(true);
    expect(rejected("waiver", `waiver_system: ${tool.waiverSystem}`)).toBe(true);
    expect(
      rejected(
        "waiver",
        referenceSentence("espn-vocabulary.md", /successful claim sends the team to the back/),
      ),
    ).toBe(true);
    expect(rejected("ir", "two injured reserve slots")).toBe(true);
    expect(rejected("match", "Every sampled player matches ESPN's points")).toBe(true);
  });

  // whole digests: the right rows among a league's other rows and clauses pass; the same digest with
  // the reception or the passing row of another format fails — the other rows' numbers (5 bench, a
  // 50+ yard field goal worth 5, week 5, 6 playoff teams, 0.5 per completion …) never stand in
  const OTHER = [
    "rushing and receiving TDs are worth 6",
    "Rushing TD | 6",
    "5 bench spots",
    "bench: 5",
    "two IR slots",
    "a 50+ yard field goal is worth 5",
    "FG 50+: 5",
    "6 teams make the playoffs",
    "week 5 is the current week",
    "passing yards: 1 point per 25",
    "receiving yards: 1 point per 10",
    "interceptions cost 2",
    "a fumble lost costs 2",
    "the trade deadline is December 2",
    "14 regular-season matchups",
    "QB, 2 RB, 2 WR, TE, FLEX, D/ST, K",
    "the next waiver run is Wednesday at 3:30 AM ET",
    "D/ST: 6 points for a defensive TD",
    "a 2-point conversion is worth 2",
    "0.5 points per completion",
  ];
  const RIGHT_REC = [
    "half-PPR",
    "receptions are worth 0.5",
    "Points per reception (stat 53): 0.5",
    "half a point per catch",
    "| REC | 53 | 0.5 |",
  ];
  const WRONG_REC = [
    "full PPR",
    "receptions are worth 1",
    "Points per reception (stat 53): 1",
    "a point per catch",
    "| REC | 53 | 1 |",
    "no PPR",
  ];
  const RIGHT_PASS = [
    "5-point passing TDs",
    "passing TDs are worth 5",
    "Points per passing TD (stat 4): 5",
    "five points per TD pass",
    "| PTD | 4 | 5 |",
  ];
  const WRONG_PASS = [
    "4-point passing TDs",
    "passing TDs are worth 4",
    "Points per passing TD (stat 4): 4",
    "four points per TD pass",
    "| PTD | 4 | 4 |",
    "6-point passing TDs",
  ];
  const JOIN = [", ", "; ", ". ", "\n", " and "];
  const digest = (rows: readonly string[], joins: readonly number[]): string =>
    rows.reduce(
      (acc, r, i) => (i === 0 ? r : acc + (JOIN[(joins[i] ?? 0) % JOIN.length] ?? ", ") + r),
      "",
    );
  const digestArb = fc.record({
    others: fc.subarray(OTHER, { minLength: 3 }),
    rec: fc.nat(),
    pass: fc.nat(),
    order: fc.array(fc.nat(), { minLength: 30, maxLength: 30 }),
    joins: fc.array(fc.nat(), { minLength: 30, maxLength: 30 }),
  });
  const assemble = (
    o: { others: string[]; order: number[] },
    rec: string,
    pass: string,
  ): string[] => {
    const rows = [...o.others, rec, pass];
    // a deterministic shuffle from the drawn keys
    return rows
      .map((r, i) => ({ r, k: o.order[i] ?? i }))
      .sort((x, y) => x.k - y.k)
      .map((x) => x.r);
  };

  it("a whole digest with the owner's rows passes, wherever the rows sit among the others", () => {
    fc.assert(
      fc.property(digestArb, (o) => {
        const d = digest(
          assemble(
            o,
            RIGHT_REC[o.rec % RIGHT_REC.length] ?? "",
            RIGHT_PASS[o.pass % RIGHT_PASS.length] ?? "",
          ),
          o.joins,
        );
        expect(G.reception.test(d), d).toBe(true);
        expect(G.passing.test(d), d).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("the same digest with another format's reception or passing row fails that grader", () => {
    fc.assert(
      fc.property(digestArb, (o) => {
        const wrongRec = digest(
          assemble(
            o,
            WRONG_REC[o.rec % WRONG_REC.length] ?? "",
            RIGHT_PASS[o.pass % RIGHT_PASS.length] ?? "",
          ),
          o.joins,
        );
        expect(G.reception.test(wrongRec), wrongRec).toBe(false);
        const wrongPass = digest(
          assemble(
            o,
            RIGHT_REC[o.rec % RIGHT_REC.length] ?? "",
            WRONG_PASS[o.pass % WRONG_PASS.length] ?? "",
          ),
          o.joins,
        );
        expect(G.passing.test(wrongPass), wrongPass).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it("another league's whole digest fails all three format graders; the owner's passes all three", () => {
    const standard = [
      "| Setting | Value |",
      "|---|---|",
      "| Scoring | Full PPR (1 per reception) |",
      "| Passing TD | 4 pts |",
      "| Rushing/receiving TD | 6 |",
      "| INT thrown | −2 |",
      "| Roster | QB, 2 RB, 2 WR, TE, FLEX, D/ST, K; 5 bench, 2 IR |",
      "| Waivers | FAAB, $100 budget, Wednesday runs |",
      "| Playoffs | 6 teams, weeks 15–17 |",
      "",
      "This 10-team league uses full PPR, 4-point passing touchdowns, 6-point rushing and receiving TDs, and FAAB waivers with a $100 budget; 5 bench and 2 IR spots.",
    ].join("\n");
    for (const g of [G.reception, G.passing, G.waiver]) expect(g.test(standard)).toBe(false);
    const owner =
      "This is a 10-team head-to-head league scored half-PPR: every catch is worth half a point, passing touchdowns are worth five points instead of the usual four, rushing and receiving touchdowns six, and both an interception and a lost fumble cost two points. You start a QB, two RBs, two WRs, a TE, a FLEX, a D/ST and a K, with five bench spots and two IR slots. Waivers clear after one day and a successful claim sends you to the back of the priority order.";
    for (const g of [G.reception, G.passing, G.waiver, G.ir]) expect(g.test(owner)).toBe(true);
  });

  it("no grader backtracks catastrophically on a long hostile reply", () => {
    // linear-time patterns: a 20 000-character reply built from one fragment takes milliseconds once
    // the pattern is compiled (the warm-up); the bound is generous so a loaded machine cannot flake
    // it, while a catastrophic pattern would not finish at all
    const units = [
      "reception ",
      "passing TD ",
      "Passing: ",
      "TD ",
      "receptions (stat ",
      "| ",
      "move ",
      "half a ",
      "( stat 4 ",
      "PPR ",
      "pass ",
      "5 ",
      "0.5 ",
    ];
    for (const [name, re] of Object.entries(G)) {
      for (let i = 0; i < 3; i++)
        re.test(`warm-up ${String(i)}: Passing TD (stat 4): 5, half-PPR, move-to-last`);
      for (const u of units) {
        const s = u.repeat(Math.ceil(20_000 / u.length));
        let best = Number.POSITIVE_INFINITY;
        for (let k = 0; k < 3; k++) {
          const t = performance.now();
          re.test(s);
          best = Math.min(best, performance.now() - t);
        }
        expect(best, `${name} on ${JSON.stringify(u)}`).toBeLessThan(5_000);
      }
    }
  }, 120_000);
});
