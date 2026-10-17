// drift-diff.test.ts — the drift diff G1 and the status resources show (plan 07 G1, §4.1
// espn-ff://status/drift: "the current manifest diff, the additive-drift list"; plan 10 A6: every
// string in `data` is wrapped, listed, a code or server prose). Stage C finding
// `status-drift-diff-unwrapped-strings`: once drift had a diff, `drift.diff[].removed[]`/`added[]`
// (ESPN's own key names) failed the A6 walk, and an `additive` status showed `diff: []` while the
// paths sat in the store. Now every path is checked against the detector's grammar before it leaves
// (DRIFT_PATH_RE / DRIFT_ENUM_RE — `$`, identifier keys or `<key>`, `[]`, an enum token), anything
// else is dropped and counted in a warning, the output schema enforces the grammar, and the
// additive list is merged into the shown diff whenever the status port hands it over.
// Attempt 2: the grammar is the detector's whole path language — `{}` (every value of an object,
// the manifest's map-like patterns: `scoreByStat{}`, `rankings{}[]`, `positionalRatings{}`, …) and a
// negative integer enum token included. Fifteen paths the detector writes from the shipped manifest
// (additive keys and new enum values under a `{}` step) were dropped as "outside the grammar", so an
// additive status under those views still named nothing; the chain test below drives the REAL
// detector over recorded answers through the drift_state transform into the shown diff.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MANIFEST_PATH,
  REQUIRED_PATHS_BY_VIEW,
  applySignals,
  checkResponse,
  isJsonObject,
  isMapLike,
  loadObservations,
  parseDiffs,
  select,
  type DriftSignal,
} from "../../src/drift/index.js";
import type { DriftView } from "../../src/mcp/services.js";
import {
  DRIFT_ENUM_RE,
  DRIFT_PATH_MAX_STEPS,
  DRIFT_PATH_RE,
  droppedDriftWarning,
  shownDriftDiff,
} from "../../src/mcp/tools/ops.js";
import type { EspnView } from "../../src/providers/espn/types.js";
import { envelopeViolations } from "./helpers/walk.js";
import { ROOT, call, connect, makeWorld, type World } from "./helpers/world.js";

interface Env {
  data: Record<string, unknown>;
  warnings: string[];
  meta: never;
}

let world: World;
beforeAll(async () => {
  world = await makeWorld({ publishEspn: false });
}, 120_000);
afterAll(() => {
  world.cleanup();
});

function putRow(diff: unknown[], additive: unknown[] = [], status = "red"): void {
  world.store.repos.driftState.put({
    status: status as "red",
    since: "2026-10-06T11:00:00.000Z",
    last_probe_at: "2026-10-06T11:00:00.000Z",
    manifest_hash: "sha256:0",
    manifest_version: 1,
    host: "lm-api-reads.fantasy.espn.com",
    host_moved_at: null,
    diff_json: JSON.stringify(diff),
    additive_json: JSON.stringify(additive),
    updated_at: "2026-10-06T11:00:00.000Z",
  });
}

async function readEnv(client: Awaited<ReturnType<typeof connect>>["client"], uri: string) {
  const raw = (await client.readResource({ uri })) as { contents: { text: string }[] };
  return JSON.parse(raw.contents[0]?.text ?? "{}") as Env;
}

describe("a red drift diff passes the A6 walk on every surface", () => {
  it("espn_get_status, espn-ff://status and espn-ff://status/drift show the path, walk-clean", async () => {
    putRow([
      { view: "mPendingTransactions", removed: ["$.pendingTransactions"], added: [], enums: [] },
    ]);
    const c = await connect(world);
    const st = (await call(c.client, "espn_get_status")).body as unknown as Env;
    const status = await readEnv(c.client, "espn-ff://status");
    const drift = await readEnv(c.client, "espn-ff://status/drift");
    await c.close();
    for (const env of [st, status, drift]) expect(envelopeViolations(env)).toEqual([]);
    const d = st.data.drift as { diff: { removed: string[] }[]; affected_tools: string[] };
    expect(d.diff[0]?.removed).toEqual(["$.pendingTransactions"]);
    expect(d.affected_tools).toContain("espn_list_transactions");
    expect((drift.data as { diff: unknown[] }).diff).toEqual(d.diff);
  });

  it("a path outside the grammar is dropped and counted, never shown", async () => {
    // the store's own cleaning (src/drift/state.ts) already drops whitespace and unknown views;
    // these pass it and still fail the detector's grammar the server enforces
    putRow([
      {
        view: "mTeam",
        removed: ["$.teams[].roster", "teams.noRoot"],
        added: ["$.{curly}", "$.teams[].ok"],
        enums: ["$.teams[].x=NEW_VALUE", "$.teams[].x=lowercase"],
      },
      { view: "not a view!", removed: ["$.a"], added: [], enums: [] },
    ]);
    const c = await connect(world);
    const st = (await call(c.client, "espn_get_status")).body as unknown as Env;
    const drift = await readEnv(c.client, "espn-ff://status/drift");
    await c.close();
    const text = JSON.stringify(st) + JSON.stringify(drift);
    expect(text).not.toContain("noRoot");
    expect(text).not.toContain("curly");
    expect(text).not.toContain("lowercase");
    expect(text).not.toContain("not a view");
    expect(st.warnings).toContain(droppedDriftWarning(3));
    expect(drift.warnings).toContain(droppedDriftWarning(3));
    expect(envelopeViolations(st)).toEqual([]);
    expect((st.data.drift as { diff: unknown[] }).diff).toEqual([
      {
        view: "mTeam",
        removed: ["$.teams[].roster"],
        added: ["$.teams[].ok"],
        enums: ["$.teams[].x=NEW_VALUE"],
      },
    ]);
  });
});

describe("an additive status names its paths when the status port hands them over", () => {
  it("G1 and the drift resource merge the additive list into the shown diff", async () => {
    putRow([], [], "additive");
    const real = world.services.status;
    const view: DriftView = {
      ...real.drift(),
      status: "additive",
      additive: [
        { view: "mTeam", removed: [], added: ["$.teams[].newKey"], enums: ["$.teams[].x=NEW"] },
      ],
    };
    const c = await connect(world, {
      services: { status: { ...real, drift: () => view } },
    });
    const st = (await call(c.client, "espn_get_status")).body as unknown as Env;
    const drift = await readEnv(c.client, "espn-ff://status/drift");
    await c.close();
    const shown = st.data.drift as { status: string; diff: unknown[] };
    expect(shown.status).toBe("additive");
    expect(shown.diff).toEqual([
      { view: "mTeam", removed: [], added: ["$.teams[].newKey"], enums: ["$.teams[].x=NEW"] },
    ]);
    expect((drift.data as { diff: unknown[] }).diff).toEqual(shown.diff);
    expect(envelopeViolations(st)).toEqual([]);
    expect(envelopeViolations(drift)).toEqual([]);
  });
});

describe("shownDriftDiff", () => {
  it("merges per view, deduplicates, keeps the grammar, counts the rest", () => {
    const out = shownDriftDiff({
      status: "red",
      since: null,
      last_probe_at: null,
      manifest_hash: null,
      diff: [
        {
          view: "mRoster",
          removed: ["$.teams[].roster", "$.teams[].roster"],
          added: [],
          enums: [],
        },
      ],
      additive: [
        { view: "mRoster", removed: [], added: ["$.teams[].<key>", "x y"], enums: ["$.a=?"] },
      ],
    });
    expect(out.diff).toEqual([
      {
        view: "mRoster",
        removed: ["$.teams[].roster"],
        added: ["$.teams[].<key>"],
        enums: ["$.a=?"],
      },
    ]);
    expect(out.dropped).toBe(1);
  });
  it("the grammar admits what the detector writes and nothing with whitespace", () => {
    for (const p of [
      "$",
      "$.pendingTransactions",
      "$.teams[].roster.entries[]",
      "$.x.<key>",
      "$.schedule[].home.cumulativeScore.scoreByStat{}.newKey",
      "$.players[].player.rankings{}[].<key>",
      `$${".a".repeat(DRIFT_PATH_MAX_STEPS)}`,
    ])
      expect(DRIFT_PATH_RE.test(p), p).toBe(true);
    for (const p of [
      "",
      "teams",
      "$.a b",
      "$.a\n",
      "$..a",
      "$.1a",
      `$.${"a".repeat(65)}`,
      "$.a{x}",
      "$.a{}b",
      "$.a{ }",
      "$.a[0]",
      `$${".a".repeat(DRIFT_PATH_MAX_STEPS + 1)}`,
    ])
      expect(DRIFT_PATH_RE.test(p), p).toBe(false);
    expect(DRIFT_ENUM_RE.test("$.a[].b=WAIVERS_TRADITIONAL")).toBe(true);
    expect(DRIFT_ENUM_RE.test("$.players[].player.rankings{}[].rankType=NEW_TYPE")).toBe(true);
    expect(DRIFT_ENUM_RE.test("$.a.lineupSlotId=-1")).toBe(true);
    expect(DRIFT_ENUM_RE.test("$.a.lineupSlotId=17")).toBe(true);
    for (const e of ["$.a=lower", "$.a=-", "$.a=--1", "$.a=1e+21", "$.a=-1.5", "$.a= X", "$.a=X Y"])
      expect(DRIFT_ENUM_RE.test(e), e).toBe(false);
  });
});

// --- the whole chain: detector → drift_state → the shown diff -----------------------------------

const RECORDED = path.join(ROOT, "fixtures", "espn", "recorded");
/** The recorded answer directories: the three public leagues and the season views. */
const ANSWER_DIRS = ["league-a", "league-b", "league-c", "season"] as const;
/** A view recorded inside another view's answers (mStandings rides mTeam). */
const RECORDED_AS: Readonly<Record<string, string>> = { mStandings: "mTeam" };

/**
 * Every recorded answer of a view (scrubbed keyless captures): each `<view>.json` and
 * `<view>.<split>….json` (`mRoster.sp1.p1.json`, `kona_player_info.ids.json`) in the answer
 * directories, so the test follows the fixtures as they are re-recorded.
 */
function recordedAnswers(view: string): string[] {
  const name = RECORDED_AS[view] ?? view;
  return ANSWER_DIRS.flatMap((d) =>
    readdirSync(path.join(RECORDED, d))
      .filter((f) => f.endsWith(".json") && (f === `${name}.json` || f.startsWith(`${name}.`)))
      .sort()
      .map((f) => path.join(d, f)),
  );
}

const T_ISO = "2026-10-06T11:00:00.000Z";
const READ_HOST = "lm-api-reads.fantasy.espn.com";

/** What the detector must report for one planted change: its pattern and the stored path. */
interface Planting {
  readonly kind: "added" | "enum";
  readonly pattern: string;
  readonly path: string;
}

/** One recorded answer (by index) with the changes planted in it. */
interface PlantedAnswer {
  readonly bi: number;
  readonly kind: Planting["kind"];
  readonly body: unknown;
  readonly plantings: Planting[];
}

/**
 * Patterns planted per answer: 8 additive patterns (16 signals) or 16 enum patterns — well under
 * the detector's 32 signals per kind per answer (detect.ts MAX_SIGNALS_PER_KIND), so none is capped.
 */
const PER_ANSWER: Readonly<Record<Planting["kind"], number>> = { added: 8, enum: 16 };

/** The parent object/array and the key of a selected node (to replace its value). */
function parentOf(
  body: unknown,
  segs: readonly (string | number)[],
): [Record<string, unknown>, string] {
  let cur: unknown = body;
  for (const s of segs.slice(0, -1)) cur = (cur as Record<string | number, unknown>)[s];
  return [cur as Record<string, unknown>, String(segs[segs.length - 1])];
}

const plantableObject = (v: unknown): boolean => isJsonObject(v) && !isMapLike(v);
const plantableScalar = (v: unknown): boolean => typeof v === "string" || typeof v === "number";

/**
 * Plants one new key (identifier-form, and one outside it) at every observed pattern and one
 * unknown value at every enum pattern the manifest records for `view`, each in the first recorded
 * answer with a node for it, and returns the answers with what the detector must report. Only
 * answers the detector passes as they were recorded are used (a clean baseline: every signal after
 * planting is the planting's).
 */
function plantedAnswers(view: EspnView, obs: ReturnType<typeof loadObservations>): PlantedAnswer[] {
  const o = obs[view];
  if (o === undefined) return [];
  const bodies = recordedAnswers(view)
    .map((f) => JSON.parse(readFileSync(path.join(RECORDED, f), "utf8")) as unknown)
    .filter((b) => checkResponse([view], b, obs).signals.length === 0);
  const out: PlantedAnswer[] = [];
  const slot = (bi: number, kind: Planting["kind"]): PlantedAnswer => {
    let s = out.find(
      (x) => x.bi === bi && x.kind === kind && x.plantings.length < PER_ANSWER[kind],
    );
    if (s === undefined) {
      s = { bi, kind, body: structuredClone(bodies[bi]), plantings: [] };
      out.push(s);
    }
    return s;
  };
  for (const pattern of Object.keys(o.observed)) {
    const bi = bodies.findIndex((b) => select(b, pattern).some((n) => plantableObject(n.value)));
    if (bi < 0) continue;
    const s = slot(bi, "added");
    const node = select(s.body, pattern).find((n) => plantableObject(n.value));
    if (node === undefined) continue;
    const obj = node.value as Record<string, unknown>;
    obj.zzDriftProbe = 1;
    obj["zz-probe key"] = 1;
    s.plantings.push({ kind: "added", pattern, path: `${pattern}.zzDriftProbe` });
    s.plantings.push({ kind: "added", pattern, path: `${pattern}.<key>` });
  }
  for (const [pattern, allowed] of Object.entries(o.enums)) {
    const bi = bodies.findIndex((b) => select(b, pattern).some((n) => plantableScalar(n.value)));
    if (bi < 0) continue;
    const s = slot(bi, "enum");
    const node = select(s.body, pattern).find((n) => plantableScalar(n.value));
    if (node === undefined) continue;
    // a new string token, or a NEGATIVE integer where the enum is numeric (detect.ts enumToken
    // writes any integer as String(v); the drift_state row keeps the `-`)
    const fresh = typeof node.value === "number" ? -7 : "ZZ_PROBE_TOKEN";
    expect(allowed.map((a) => JSON.stringify(a))).not.toContain(JSON.stringify(fresh));
    const [parent, key] = parentOf(s.body, node.segs);
    parent[key] = fresh;
    s.plantings.push({ kind: "enum", pattern, path: `${pattern}=${String(fresh)}` });
  }
  return out;
}

describe("every path the detector writes from the shipped manifest is shown (attempt 2)", () => {
  const obs = loadObservations(path.join(ROOT, MANIFEST_PATH));
  const views = Object.keys(obs) as EspnView[];

  it("additive keys and new enum values at every manifest pattern: detected, stored, shown — none dropped", () => {
    const planted = new Set<string>();
    for (const view of views) {
      for (const { body, plantings } of plantedAnswers(view, obs)) {
        const check = checkResponse([view], body, obs);
        // the planted answer is complete: only the observation checks speak
        expect(check.drifted, view).toBe(false);
        const signalPaths = new Set(
          check.signals.map((s: DriftSignal) =>
            s.kind === "additive_key" ? s.path : `${s.path}=${s.value ?? "?"}`,
          ),
        );
        for (const p of plantings) expect(signalPaths, `${view} ${p.path}`).toContain(p.path);
        // the drift module's own transform and parse (what the composition root reads)
        const row = applySignals(null, check.signals, READ_HOST, T_ISO);
        const shown = shownDriftDiff({
          status: row.status,
          since: row.since,
          last_probe_at: null,
          manifest_hash: null,
          diff: parseDiffs(row.diff_json),
          additive: parseDiffs(row.additive_json),
        });
        expect(shown.dropped, `${view}: dropped`).toBe(0);
        const d = shown.diff.find((x) => x.view === view);
        for (const p of plantings) {
          expect(p.kind === "added" ? d?.added : d?.enums, `${view} ${p.path}`).toContain(p.path);
          planted.add(`${view}|${p.pattern}`);
        }
      }
    }
    const patterns = views.flatMap((v) =>
      [...Object.keys(obs[v]?.observed ?? {}), ...Object.keys(obs[v]?.enums ?? {})].map(
        (p) => `${v}|${p}`,
      ),
    );
    // the defect's patterns — under an object-values step — are all exercised, and nearly every
    // other one (the rest are mTeam's settings patterns, which its recorded answers do not carry;
    // mSettings' answers exercise the same patterns)
    const curly = patterns.filter((p) => p.includes("{}"));
    expect(curly.length).toBeGreaterThan(0);
    for (const p of curly) expect(planted, p).toContain(p);
    expect(planted.size / patterns.length).toBeGreaterThan(0.9);
  });

  it("every required key the detector can report missing is shown in removed[]", () => {
    const signals: DriftSignal[] = Object.entries(REQUIRED_PATHS_BY_VIEW).flatMap(([view, ps]) =>
      ps.map((p) => ({
        kind: "missing_required_key" as const,
        view: view as EspnView,
        path: p,
        value: null,
      })),
    );
    expect(signals.length).toBeGreaterThan(10);
    const row = applySignals(null, signals, READ_HOST, T_ISO);
    const shown = shownDriftDiff({
      status: row.status,
      since: row.since,
      last_probe_at: null,
      manifest_hash: null,
      diff: parseDiffs(row.diff_json),
    });
    expect(shown.dropped).toBe(0);
    for (const [view, ps] of Object.entries(REQUIRED_PATHS_BY_VIEW))
      expect(shown.diff.find((d) => d.view === view)?.removed ?? [], view).toEqual([...ps]);
  });

  it("G1 and the drift resource show `{}` paths and negative tokens, walk- and schema-clean", async () => {
    putRow(
      [
        {
          view: "mBoxscore",
          removed: ["$.schedule[].home.cumulativeScore.scoreByStat{}"],
          added: [],
          enums: [],
        },
      ],
      [],
      "red",
    );
    const real = world.services.status;
    const additive = [
      {
        view: "kona_player_info",
        removed: [],
        added: ["$.players[].player.rankings{}[].zzDriftProbe"],
        enums: ["$.players[].player.rankings{}[].rankType=ZZ_PROBE_TOKEN", "$.players[].x=-7"],
      },
    ];
    const c = await connect(world, {
      services: { status: { ...real, drift: () => ({ ...real.drift(), additive }) } },
    });
    const st = await call(c.client, "espn_get_status");
    const drift = await readEnv(c.client, "espn-ff://status/drift");
    await c.close();
    expect(st.isError).toBe(false);
    const env = st.body as unknown as Env;
    for (const e of [env, drift]) {
      expect(envelopeViolations(e)).toEqual([]);
      expect(e.warnings.some((w) => w.startsWith("drift diff:"))).toBe(false);
    }
    expect((env.data.drift as { diff: unknown[] }).diff).toEqual([
      {
        view: "mBoxscore",
        removed: ["$.schedule[].home.cumulativeScore.scoreByStat{}"],
        added: [],
        enums: [],
      },
      { ...additive[0] },
    ]);
    expect((drift.data as { diff: unknown[] }).diff).toEqual(
      (env.data.drift as { diff: unknown[] }).diff,
    );
  });
});
