// probe-spec.test.ts — the daily probe judges an answer against the manifest's probe specs (plan 01
// §7 "Diff against the manifest; any removed key, changed enum set, or host anomaly → drift_state
// red, a macOS notification"; plan 06 §1.2 "ESPN drift: <view>: removed <key>"; plan 05 §3.3 probe
// diff). Stage C finding probe-manifest-specs-unevaluated: `eff probe`, doctor #15 and `eff smoke`
// checked only src/drift's seed paths, so a removed playoffSeedingRule / playoffTeamCount /
// acquisitionType / waiverOrderReset / game `date`, an emptied proTeams list, a new team id and a
// retyped deadlineDate all stayed green, and a renamed scoringItems was only additive. Every answer
// here is a recorded, anonymised fixture mutated in memory, served by an injected fetch.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { Json } from "../../scripts/espn-fixture/canonical.js";
import { diffBody } from "../../scripts/espn-fixture/drift.js";
import { createHttpClient } from "../../src/http/client.js";
import { hostRow } from "../../src/cli/doctor-online.js";
import { driftProbeSpecs } from "../../src/cli/espn-stack.js";
import { readJobState } from "../../src/cli/job-state.js";
import {
  alarmText,
  clearSpecVerified,
  hostProbe,
  probe,
  probeErrorToken,
  recordProbe,
  shapeProbe,
  type ProbeCheck,
} from "../../src/cli/probe.js";
import {
  findingPhrase,
  judgeSpec,
  MAX_FINDINGS_PER_KIND,
  parseProbeSpec,
  parseProbeSpecs,
  specSignals,
  viewOfPath,
  type ProbeSpecs,
} from "../../src/cli/probe-spec.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import { DriftStateWriter, scoringRefusal } from "../../src/drift/index.js";
import type { DriftStateRow } from "../../src/drift/types.js";
import {
  fakeExec,
  fakeFetch,
  json,
  makeIo,
  movingClock,
  ROOT,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox | null = null;
afterEach(() => {
  sb?.cleanup();
  sb = null;
});

const load = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(ROOT, "fixtures", rel), "utf8")) as Record<string, unknown>;
const MANIFEST = load("drift/manifest.json");
const SPECS: ProbeSpecs = parseProbeSpecs(MANIFEST);
const HOST = (): Record<string, unknown> => load("espn/recorded/season/proTeamSchedules_wl.json");
const SHAPE = (): Record<string, unknown> => load("espn/recorded/league-a/probe-shape.json");

type O = Record<string, unknown>;
const at = (o: unknown, ...keys: string[]): O => {
  let cur = o as O;
  for (const k of keys) cur = cur[k] as O;
  return cur;
};

/** The mutations of the finding, each with the alarm a red answer must raise. */
const HOST_CASES: readonly {
  readonly name: string;
  readonly mutate: (b: O) => void;
  readonly alarm: string;
}[] = [
  {
    name: "every game loses `date`",
    mutate: (b) => {
      for (const t of at(b, "settings").proTeams as O[])
        for (const games of Object.values(t.proGamesByScoringPeriod as Record<string, O[]>))
          for (const g of games) delete g.date;
    },
    alarm:
      "ESPN drift: proTeamSchedules_wl: removed $.settings.proTeams[].proGamesByScoringPeriod{}[].date",
  },
  {
    name: "proTeams cut to one team",
    mutate: (b) => {
      const s = at(b, "settings");
      s.proTeams = (s.proTeams as O[]).slice(0, 1);
    },
    alarm: "ESPN drift: proTeamSchedules_wl: shortened $.settings.proTeams to 1 item(s)",
  },
  {
    name: "a team id outside the known set",
    mutate: (b) => {
      (at(b, "settings").proTeams as O[])[3]!.id = 99;
    },
    alarm: "ESPN drift: proTeamSchedules_wl: unknown value 99 at $.settings.proTeams[].id",
  },
];

const SHAPE_CASES: readonly {
  readonly name: string;
  readonly mutate: (b: O) => void;
  readonly alarm: string;
}[] = [
  {
    name: "playoffSeedingRule deleted",
    mutate: (b) => {
      delete at(b, "settings", "scheduleSettings").playoffSeedingRule;
    },
    alarm: "ESPN drift: mSettings: removed $.settings.scheduleSettings.playoffSeedingRule",
  },
  {
    name: "playoffTeamCount deleted",
    mutate: (b) => {
      delete at(b, "settings", "scheduleSettings").playoffTeamCount;
    },
    alarm: "ESPN drift: mSettings: removed $.settings.scheduleSettings.playoffTeamCount",
  },
  {
    name: "acquisitionType and waiverOrderReset deleted (the move-to-last league's waiver system)",
    mutate: (b) => {
      const a = at(b, "settings", "acquisitionSettings");
      delete a.acquisitionType;
      delete a.waiverOrderReset;
    },
    alarm: "ESPN drift: mSettings: removed $.settings.acquisitionSettings.acquisitionType",
  },
  {
    name: "scoringItems renamed scoringRules (a rename is red, never only additive)",
    mutate: (b) => {
      const s = at(b, "settings", "scoringSettings");
      s.scoringRules = s.scoringItems;
      delete s.scoringItems;
    },
    alarm: "ESPN drift: mSettings: removed $.settings.scoringSettings.scoringItems",
  },
  {
    name: "tradeSettings.deadlineDate retyped to a string",
    mutate: (b) => {
      const t = at(b, "settings", "tradeSettings");
      t.deadlineDate = String(t.deadlineDate);
    },
    alarm: "ESPN drift: mSettings: changed the type of $.settings.tradeSettings.deadlineDate",
  },
  {
    name: "a lineup slot id outside the known set",
    mutate: (b) => {
      at(b, "settings", "rosterSettings", "lineupSlotCounts")["77"] = 1;
    },
    alarm: "ESPN drift: mSettings: unknown key 77 in $.settings.rosterSettings.lineupSlotCounts",
  },
  {
    name: "a team loses waiverRank",
    mutate: (b) => {
      delete (b.teams as O[])[2]!.waiverRank;
    },
    alarm: "ESPN drift: mTeam: removed $.teams[].waiverRank",
  },
  {
    name: "a member loses isLeagueCreator",
    mutate: (b) => {
      delete (b.members as O[])[0]!.isLeagueCreator;
    },
    alarm: "ESPN drift: mNav: removed $.members[].isLeagueCreator",
  },
];

/** The comparable shape of a finding (the Phase 0 script's `Finding`, value-free). */
const comparable = (f: {
  severity: string;
  kind: string;
  first?: string;
  path: string;
  count: number;
}) => `${f.severity}|${f.kind}|${f.first ?? f.path}|${String(f.count)}`;

describe("judgeSpec is scripts/espn-fixture/drift.ts diffBody, finding for finding", () => {
  it("the recorded host and shape fixtures pass their specs with no finding at all", () => {
    expect(judgeSpec(SPECS.host, ["proTeamSchedules_wl"], HOST()).findings).toEqual([]);
    expect(judgeSpec(SPECS.shape, ["mSettings", "mNav", "mTeam"], SHAPE()).findings).toEqual([]);
  });

  it("every mutation of the finding: the same findings, kinds, first paths and counts", () => {
    for (const c of HOST_CASES) {
      const b = HOST();
      c.mutate(b);
      const ours = judgeSpec(SPECS.host, ["proTeamSchedules_wl"], b).findings.map(comparable);
      const theirs = diffBody(SPECS.host, b as Json).map((f) =>
        comparable({ ...f, first: f.path }),
      );
      expect(ours.sort(), c.name).toEqual(theirs.sort());
      expect(ours.length, c.name).toBeGreaterThan(0);
    }
    for (const c of SHAPE_CASES) {
      const b = SHAPE();
      c.mutate(b);
      const ours = judgeSpec(SPECS.shape, ["mSettings", "mNav", "mTeam"], b).findings.map(
        comparable,
      );
      const theirs = diffBody(SPECS.shape, b as Json).map((f) =>
        comparable({ ...f, first: f.path }),
      );
      expect(ours.sort(), c.name).toEqual(theirs.sort());
    }
  });

  it("property: on random deletions and retypings of the shape fixture both agree", () => {
    const paths: string[][] = [];
    const walk = (v: unknown, p: string[], depth: number): void => {
      if (depth > 4 || typeof v !== "object" || v === null || Array.isArray(v)) return;
      for (const [k, x] of Object.entries(v as O)) {
        paths.push([...p, k]);
        walk(x, [...p, k], depth + 1);
      }
    };
    walk(SHAPE(), [], 0);
    fc.assert(
      fc.property(
        fc.constantFrom(...paths),
        fc.constantFrom<"delete" | "string" | "null" | "array">(
          "delete",
          "string",
          "null",
          "array",
        ),
        (p, how) => {
          const b = SHAPE();
          const parent = at(b, ...p.slice(0, -1));
          const k = p[p.length - 1] ?? "";
          if (how === "delete") Reflect.deleteProperty(parent, k);
          else parent[k] = how === "string" ? "x" : how === "null" ? null : [];
          const ours = judgeSpec(SPECS.shape, ["mSettings", "mNav", "mTeam"], b).findings.map(
            comparable,
          );
          const theirs = diffBody(SPECS.shape, b as Json).map((f) =>
            comparable({ ...f, first: f.path }),
          );
          expect(ours.sort()).toEqual(theirs.sort());
        },
      ),
      { numRuns: 150 },
    );
  });

  it("bounded on hostile bodies: a deep value at an enum path, 50 000 new slot keys, never a throw", () => {
    const deep: unknown[] = [];
    let cur = deep;
    for (let i = 0; i < 20_000; i++) {
      const next: unknown[] = [];
      cur.push(next);
      cur = next;
    }
    const b = HOST();
    (at(b, "settings").proTeams as O[])[1]!.id = deep;
    const v = judgeSpec(SPECS.host, ["proTeamSchedules_wl"], b);
    expect(v.findings.some((f) => f.kind === "enum" && f.value === null)).toBe(true);
    const s = SHAPE();
    const slots = at(s, "settings", "rosterSettings", "lineupSlotCounts");
    for (let i = 100; i < 50_100; i++) slots[String(i)] = 0;
    const many = judgeSpec(SPECS.shape, ["mSettings", "mNav", "mTeam"], s);
    expect(many.findings.filter((f) => f.kind === "enum")).toHaveLength(MAX_FINDINGS_PER_KIND);
    for (const odd of [null, 5, "x", [], [1, 2], { settings: null }])
      expect(() => judgeSpec(SPECS.shape, ["mSettings"], odd)).not.toThrow();
  });

  it("views: a path belongs to the view whose seed shares its top-level key, else the first", () => {
    const shape = ["mSettings", "mNav", "mTeam"] as const;
    expect(viewOfPath("$.settings.scheduleSettings.playoffSeedingRule", shape)).toBe("mSettings");
    expect(viewOfPath("$.teams[].record", shape)).toBe("mTeam");
    expect(viewOfPath("$.members[].isLeagueCreator", shape)).toBe("mNav");
    expect(viewOfPath("$.status.previousSeasons", shape)).toBe("mSettings");
    expect(viewOfPath("$.seasonId", shape)).toBe("mSettings");
    expect(viewOfPath("$", shape)).toBe("mSettings");
    expect(viewOfPath("$.settings.proTeams", ["proTeamSchedules_wl"])).toBe("proTeamSchedules_wl");
  });

  it("signals: red findings fail the response, additive ones are counted; phrases are fixed vocabulary", () => {
    const b = SHAPE();
    delete at(b, "settings", "scheduleSettings").playoffSeedingRule;
    at(b, "settings").brandNew = 1;
    const v = judgeSpec(SPECS.shape, ["mSettings", "mNav", "mTeam"], b);
    expect(specSignals(v.findings)).toEqual([
      {
        kind: "missing_required_key",
        view: "mSettings",
        path: "$.settings.scheduleSettings.playoffSeedingRule",
        value: null,
      },
      { kind: "additive_key", view: "mSettings", path: "$.settings.brandNew", value: null },
    ]);
    expect(findingPhrase({ kind: "short", path: "$.x", value: null })).toBe("shortened $.x");
    expect(findingPhrase({ kind: "enum", path: "$.x", value: null })).toBe("unknown value at $.x");
    expect(findingPhrase({ kind: "oversize", path: "$.x", value: null })).toBe("oversized $.x");
    expect(findingPhrase({ kind: "not_object", path: "$.x", value: null })).toBe(
      "changed the type of $.x",
    );
    expect(findingPhrase({ kind: "added", path: "$.x", value: null })).toBe("added $.x");
    // a verified path is never one a finding names
    expect(v.verified.get("mSettings")?.has("$.settings.scheduleSettings.playoffSeedingRule")).toBe(
      false,
    );
    expect(v.verified.get("mSettings")?.has("$.settings.scheduleSettings.playoffTeamCount")).toBe(
      true,
    );
  });
});

describe("parseProbeSpecs: a malformed spec is never read as 'no drift'", () => {
  it("the checkout's manifest parses; every malformed variant throws", () => {
    expect(SPECS.host.views).toEqual(["proTeamSchedules_wl"]);
    expect(SPECS.shape.minItems?.["$.teams"]).toBe(2);
    const host = (MANIFEST.probes as O).host as O;
    const bad: unknown[] = [
      null,
      { ...host, views: [] },
      { ...host, views: ["notAView"] },
      { ...host, required: {} },
      { ...host, required: { $: {} } },
      { ...host, required: { $: { settings: "objekt" } } },
      { ...host, required: { "settings.x": { a: "string" } } },
      { ...host, observed: { $: [1] } },
      { ...host, minItems: { "$.settings.proTeams": -1 } },
      { ...host, minItems: { "$.settings.proTeams": "32" } },
      { ...host, enums: { "$.settings.proTeams[].id": [] } },
      { ...host, enums: { "$.settings.proTeams[].id": [{ a: 1 }] } },
      { ...host, scrubbed: { $: "x" } },
    ];
    for (const b of bad) expect(() => parseProbeSpec(b, "host")).toThrow();
    expect(() => parseProbeSpecs({ probes: null })).toThrow();
    expect(() => parseProbeSpecs({ probes: { host } })).toThrow();
  });

  it("driftProbeSpecs: absent without a manifest; undefined (warned) for a malformed probes section", () => {
    sb = sandbox();
    const io = makeIo(sb, { packageRoot: sb.dir });
    const warned: string[] = [];
    const log = { warn: (e: string) => warned.push(e) } as unknown as Parameters<
      typeof driftProbeSpecs
    >[1];
    expect(driftProbeSpecs(io, log)).toBeUndefined();
    expect(warned).toEqual([]);
    expect(driftProbeSpecs(makeIo(sb), log)?.shape.views).toEqual(["mSettings", "mNav", "mTeam"]);
  });
});

/** The ProbeDeps of a fake fetch answering every probe with `body()`. */
async function depsOf(answer: () => unknown) {
  sb = sandbox();
  const f = fakeFetch(() => json(answer()));
  const io = makeIo(sb, { fetch: f.fetch, clock: movingClock() });
  const { config, log } = await loadLenientRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  return {
    io,
    store,
    deps: {
      http: createHttpClient({ fetch: f.fetch }),
      limiter: store.repos.limiter,
      clock: io.clock,
      host: "lm-api-reads.fantasy.espn.com",
      observations: undefined,
      specs: SPECS,
    },
  };
}

describe("hostProbe and shapeProbe judge the probe specs (the finding's repro, case by case)", () => {
  it("every host mutation is red with its alarm; the fixture itself is green", async () => {
    let body: () => unknown = HOST;
    const { deps, store } = await depsOf(() => body());
    try {
      expect((await hostProbe(deps, 2026)).status).toBe("green");
      for (const c of HOST_CASES) {
        body = () => {
          const b = HOST();
          c.mutate(b);
          return b;
        };
        const r = await hostProbe(deps, 2026);
        expect(r.status, c.name).toBe("red");
        expect(alarmText([r]), c.name).toBe(c.alarm);
        expect(probeErrorToken(r), c.name).toMatch(/^spec_(removed|short|enum)$/);
      }
    } finally {
      store.close();
    }
  });

  it("every shape mutation is red with its alarm (the rename red too, its new key additive)", async () => {
    let body: () => unknown = SHAPE;
    const { deps, store } = await depsOf(() => body());
    try {
      expect((await shapeProbe(deps, 2026, "1", true)).status).toBe("green");
      for (const c of SHAPE_CASES) {
        body = () => {
          const b = SHAPE();
          c.mutate(b);
          return b;
        };
        const r = await shapeProbe(deps, 2026, "1", true);
        expect(r.status, c.name).toBe("red");
        expect(alarmText([r]), c.name).toBe(c.alarm);
      }
      body = () => {
        const b = SHAPE();
        const s = at(b, "settings", "scoringSettings");
        s.scoringRules = s.scoringItems;
        delete s.scoringItems;
        return b;
      };
      const rename = await shapeProbe(deps, 2026, "1", true);
      expect(rename.findings?.map((f) => `${f.severity} ${f.kind} ${f.path}`)).toEqual(
        expect.arrayContaining([
          "red removed $.settings.scoringSettings.scoringItems",
          "additive added $.settings.scoringSettings.scoringRules",
        ]),
      );
      // doctor #15 names the same finding
      expect(hostRow(rename, false).details).toContain(
        "mSettings: removed $.settings.scoringSettings.scoringItems",
      );
      expect(hostRow(rename, false).status).toBe("drift");
    } finally {
      store.close();
    }
  });
});

describe("every red finding reaches drift_state (its path is one drift_state records)", () => {
  it("each mutation of the finding, recorded, leaves the row red naming the finding's path", async () => {
    let body: () => unknown = SHAPE;
    const { deps, store, io } = await depsOf(() => body());
    try {
      for (const [cases, probeOf] of [
        [HOST_CASES, () => hostProbe(deps, 2026)],
        [SHAPE_CASES, () => shapeProbe(deps, 2026, "1", true)],
      ] as const) {
        for (const c of cases) {
          store.repos.driftState.put({
            status: "green",
            since: null,
            last_probe_at: null,
            manifest_hash: null,
            manifest_version: null,
            host: deps.host,
            host_moved_at: null,
            diff_json: "[]",
            additive_json: "[]",
            updated_at: io.clock.nowIso(),
          });
          body = () => {
            const b = cases === HOST_CASES ? HOST() : SHAPE();
            c.mutate(b);
            return b;
          };
          const check = await probeOf();
          const red = check.findings?.find((f) => f.severity === "red");
          expect(red, c.name).toBeDefined();
          const recorded = recordProbe(store, io.clock, deps.host, [check]);
          expect(recorded.status, c.name).toBe("red");
          expect(store.repos.driftState.get()?.diff_json, c.name).toContain(red?.path ?? "?");
        }
      }
    } finally {
      store.close();
    }
  });
});

describe("eff probe end to end with the checkout's manifest", () => {
  it("a removed waiverOrderReset: drift_state red, exit 4, ONE notification naming the key; ESPN serves it again → green", async () => {
    sb = sandbox();
    let shape: () => unknown = () => {
      const b = SHAPE();
      delete at(b, "settings", "acquisitionSettings").waiverOrderReset;
      return b;
    };
    const f = fakeFetch((url) => json(url.includes("/leagues/") ? shape() : HOST()));
    const { exec, calls } = fakeExec();
    const io = (iso: string) =>
      makeIo(sb!, {
        fetch: f.fetch,
        clock: movingClock(iso),
        platform: "darwin",
        exec,
        packageRoot: ROOT,
        env: { ESPN_LEAGUE_ID: "0", EFF_PROBE_LEAGUE_ID: "1" },
      });
    const day1 = io("2026-10-06T09:00:00.000Z");
    const { config, log } = await loadLenientRuntime(day1);
    expect(await probe(day1, config, log, { hostOnly: false, notify: true, json: false })).toBe(4);
    expect(day1.out.text).toContain("drift_state: red");
    expect(day1.out.text).toContain(
      "red: mSettings: removed $.settings.acquisitionSettings.waiverOrderReset",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toContain(
      "ESPN drift: mSettings: removed $.settings.acquisitionSettings.waiverOrderReset",
    );
    expect(readJobState(config.cacheDir)["alarm.drift"]).toBeDefined();
    let store = openStore(config, day1.clock, log, { migrate: false });
    try {
      const row = store.repos.driftState.get();
      expect(row?.status).toBe("red");
      expect(row?.diff_json).toContain("$.settings.acquisitionSettings.waiverOrderReset");
      expect(store.repos.probeLog.lastSuccess("shape")).toBeNull();
    } finally {
      store.close();
    }
    // the same drift the next day: still red, no second notification
    const day2 = io("2026-10-07T09:00:00.000Z");
    expect(await probe(day2, config, log, { hostOnly: false, notify: true, json: true })).toBe(4);
    const doc = JSON.parse(day2.out.text) as {
      probe_specs: string;
      checks: { name: string; findings: { kind: string; path: string }[] }[];
    };
    expect(doc.probe_specs).toBe("present");
    expect(doc.checks.find((c) => c.name === "shape")?.findings).toEqual([
      expect.objectContaining({
        kind: "removed",
        path: "$.settings.acquisitionSettings.waiverOrderReset",
      }),
    ]);
    expect(calls).toHaveLength(1);
    // ESPN serves the key again: the probe that verified it clears it (a seed-only clear would have
    // left the row red until some in-call answer of mSettings)
    shape = SHAPE;
    const day3 = io("2026-10-08T09:00:00.000Z");
    expect(await probe(day3, config, log, { hostOnly: false, notify: true, json: false })).toBe(0);
    store = openStore(config, day3.clock, log, { migrate: false });
    try {
      const row = store.repos.driftState.get();
      expect([row?.status, row?.diff_json]).toEqual(["green", "[]"]);
      expect(scoringRefusal(row ?? null)).toBeNull();
    } finally {
      store.close();
    }
    expect(readJobState(config.cacheDir)["alarm.drift"]).toBeUndefined();
  });

  it("an emptied proTeams list on the host probe is red too (exit 4, the alarm says shortened)", async () => {
    sb = sandbox();
    const f = fakeFetch(() => {
      const b = HOST();
      const s = at(b, "settings");
      s.proTeams = (s.proTeams as O[]).slice(0, 1);
      return json(b);
    });
    const io = makeIo(sb, { fetch: f.fetch, clock: movingClock(), packageRoot: ROOT });
    const { config, log } = await loadLenientRuntime(io);
    expect(await probe(io, config, log, { hostOnly: true, notify: false, json: false })).toBe(4);
    expect(io.err.text).toContain(
      "ESPN drift: proTeamSchedules_wl: shortened $.settings.proTeams to 1 item(s)",
    );
  });
});

describe("clearSpecVerified: a path a probe answer verified is cleared, nothing else", () => {
  const row = (
    removed: Record<string, string[]>,
    status: DriftStateRow["status"] = "red",
  ): DriftStateRow => ({
    status,
    since: "2026-10-01T00:00:00.000Z",
    last_probe_at: null,
    manifest_hash: null,
    manifest_version: null,
    host: "lm-api-reads.fantasy.espn.com",
    host_moved_at: status === "host_moved" ? "2026-10-01T00:00:00.000Z" : null,
    diff_json: JSON.stringify(
      Object.entries(removed).map(([view, r]) => ({ view, removed: r, added: [], enums: [] })),
    ),
    additive_json: "[]",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  const check = (over: Partial<ProbeCheck>): ProbeCheck => ({
    name: "shape",
    views: ["mSettings", "mNav", "mTeam"],
    status: "green",
    upstream_status: 200,
    reason: null,
    signals: [],
    server_time_ms: null,
    ...over,
  });
  const NOW = "2026-10-06T09:00:00.000Z";

  it("clears a verified spec path; keeps an unverified one, a path this run found failing, and a host move", () => {
    const verified = new Map([
      ["mSettings", new Set(["$.settings.scheduleSettings.playoffSeedingRule", "$.settings.x"])],
    ] as const);
    const r = row({
      mSettings: ["$.settings.scheduleSettings.playoffSeedingRule"],
      mTeam: ["$.teams[].logo"],
    });
    const out = clearSpecVerified(r, [check({ verified })], NOW);
    expect(JSON.parse(out.diff_json)).toEqual([
      { view: "mTeam", removed: ["$.teams[].logo"], added: [], enums: [] },
    ]);
    expect([out.status, out.since]).toEqual(["red", "2026-10-01T00:00:00.000Z"]);
    // everything cleared → green, since gone
    const one = clearSpecVerified(
      row({ mSettings: ["$.settings.scheduleSettings.playoffSeedingRule"] }),
      [check({ verified })],
      NOW,
    );
    expect([one.status, one.since, one.diff_json]).toEqual(["green", null, "[]"]);
    // a path another answer of the run found failing is never cleared
    const failing = check({
      name: "host",
      views: ["proTeamSchedules_wl"],
      status: "red",
      signals: [
        {
          kind: "missing_required_key",
          view: "mSettings",
          path: "$.settings.scheduleSettings.playoffSeedingRule",
          value: null,
        },
      ],
    });
    const kept = row({ mSettings: ["$.settings.scheduleSettings.playoffSeedingRule"] });
    expect(clearSpecVerified(kept, [check({ verified }), failing], NOW)).toBe(kept);
    // a host move stays moved (the transform ends it on a good answer)
    const moved = clearSpecVerified(
      row({ mSettings: ["$.settings.scheduleSettings.playoffSeedingRule"] }, "host_moved"),
      [check({ verified })],
      NOW,
    );
    expect([moved.status, moved.diff_json]).toEqual(["host_moved", "[]"]);
    // an answer that was never judged verifies nothing; a green row is returned as is
    const g = row({}, "green");
    expect(clearSpecVerified(g, [check({ verified })], NOW)).toBe(g);
    const unjudged = row({ mSettings: ["$.settings.scheduleSettings.playoffSeedingRule"] });
    expect(clearSpecVerified(unjudged, [check({ status: "unreachable", verified })], NOW)).toBe(
      unjudged,
    );
    expect(clearSpecVerified(unjudged, [check({})], NOW)).toBe(unjudged);
  });

  it("recordProbe: a recorded spec key cleared by the probe that verified it; an in-call key outside the spec stays", async () => {
    let body: () => unknown = SHAPE;
    const { deps, store, io } = await depsOf(() => body());
    try {
      const w = new DriftStateWriter(store.repos.driftState, io.clock, deps.host);
      w.record([
        {
          kind: "missing_required_key",
          view: "mSettings",
          path: "$.settings.scheduleSettings.playoffSeedingRule",
          value: null,
        },
        {
          kind: "missing_required_key",
          view: "mSettings",
          path: "$.settings.scheduleSettings.matchupPeriods{}",
          value: null,
        },
      ]);
      recordProbe(store, io.clock, deps.host, [await shapeProbe(deps, 2026, "1", true)]);
      const after = store.repos.driftState.get();
      expect(after?.status).toBe("red");
      expect(after?.diff_json).not.toContain("playoffSeedingRule");
      expect(after?.diff_json).toContain("matchupPeriods{}");
      body = () => {
        const b = SHAPE();
        delete at(b, "settings", "scheduleSettings").playoffSeedingRule;
        return b;
      };
      recordProbe(store, io.clock, deps.host, [await shapeProbe(deps, 2026, "1", true)]);
      expect(store.repos.driftState.get()?.diff_json).toContain("playoffSeedingRule");
    } finally {
      store.close();
    }
  });
});
