// probe.test.ts — the standalone drift probe replayed through an injected fetch over the RECORDED,
// scrubbed fixtures: plan 10 §3.0 Z4 (a renamed settings.proTeams[].byeWeek → exit 4 with the JSON
// path), plan 05 §3.3 (skeleton detection, probe diff severities, host moved), plan 06 §1.2 (exit
// codes, keyless, nothing secret printed), plan 01 §7. No test touches the network.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANIFEST,
  EXIT,
  RECORDING_MANIFEST,
  loadManifest,
  rebaseline,
  rebaselineSources,
  runProbe,
  summarize,
  viewSources,
} from "../../scripts/probe.js";
import {
  MAX_ENUM_VALUES,
  observeBodies,
  observeKeys,
  requiredPathStatus,
  type DriftManifest,
} from "../../scripts/espn-fixture/drift.js";
import { READ_HOST, WRITE_HOST } from "../../scripts/espn-fixture/http.js";
import { REMOVE_KEYS } from "../../scripts/espn-fixture/scrub.js";
import { ROOT } from "../lint/helpers.js";

const REC = path.join(ROOT, "fixtures", "espn", "recorded");
const load = (rel: string): unknown => JSON.parse(readFileSync(path.join(REC, rel), "utf8"));
const HOST_BODY = () =>
  load("season/proTeamSchedules_wl.json") as { settings: { proTeams: Record<string, unknown>[] } };
const SHAPE_BODY = () => load("league-a/probe-shape.json") as Record<string, unknown>;
const LEAGUE_SKELETON = () => load("league-a/skeleton.json");
const SEASON_SKELETON = () => load("season/skeleton.json");

/** A league id that exists only at run time (never a literal in this file). */
const LEAGUE = String(600_000 + (Date.now() % 1000) * 7 + 13);

type Reply = { status: number; body: string; headers?: Record<string, string> } | Error;
const json = (body: unknown, status = 200): Reply => ({
  status,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json;charset=utf-8" },
});

/** A fake fetch: `host` answers the season route, `shape` the league route. Records every call. */
function fakeFetch(host: Reply, shape: Reply = json(SHAPE_BODY())) {
  const calls: { url: string; init: RequestInit; headers: Record<string, string> }[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url, init, headers });
    const reply = new URL(url).pathname.includes("/leagues/") ? shape : host;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(
      new Response(reply.body, { status: reply.status, headers: reply.headers ?? {} }),
    );
  };
  return { fetch, calls };
}

const waits: number[] = [];
let fakeMs = 0;
const deps = (
  f: ReturnType<typeof fakeFetch>,
  env: NodeJS.ProcessEnv = { EFF_PROBE_LEAGUE_ID: LEAGUE },
) => ({
  fetch: f.fetch,
  env,
  now: () => new Date("2026-10-05T05:00:00Z"),
  clock: () => fakeMs,
  sleep: (ms: number) => {
    waits.push(ms);
    fakeMs += ms;
    return Promise.resolve();
  },
});

async function probe(host: Reply, shape?: Reply, env?: NodeJS.ProcessEnv, argv: string[] = []) {
  const f = fakeFetch(host, shape);
  const r = await runProbe(argv, deps(f, env));
  return { ...r, calls: f.calls, line: r.line! };
}

describe("the checked-in drift manifest", () => {
  const { manifest } = loadManifest(DEFAULT_MANIFEST);

  it("is valid, keyless, and points at the read host", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.host).toBe(READ_HOST);
    expect(manifest.probes.host.views).toEqual(["proTeamSchedules_wl"]);
    expect(manifest.probes.shape.views).toEqual(["mSettings", "mNav", "mTeam"]);
  });

  it("required ⊆ observed for every entity path (a schema never demands a key ESPN never sent)", () => {
    for (const p of [manifest.probes.host, manifest.probes.shape]) {
      for (const [pattern, keys] of Object.entries(p.required)) {
        const seen = new Set(p.observed[pattern] ?? []);
        for (const k of Object.keys(keys)) expect(seen.has(k), `${pattern}.${k}`).toBe(true);
      }
    }
  });

  it("`observed` is current: re-derived from the recorded fixtures named in $sources", () => {
    const src = rebaselineSources(DEFAULT_MANIFEST);
    for (const name of ["host", "shape"] as const) {
      const spec = manifest.probes[name];
      const bodies = src[name].map((f) => JSON.parse(readFileSync(f, "utf8")) as never);
      const patterns = [
        ...new Set([...Object.keys(spec.required), ...Object.keys(spec.observed)]),
      ].sort();
      expect(observeKeys(patterns, bodies)).toEqual(spec.observed);
    }
  });

  it("`views` is current: regenerated from every recorded view (B1/CAT-08)", () => {
    const src = viewSources(RECORDING_MANIFEST);
    expect(Object.keys(manifest.views).sort()).toEqual(Object.keys(src).sort());
    for (const [view, rels] of Object.entries(src)) {
      const bodies = rels.map(
        (rel) => JSON.parse(readFileSync(path.join(ROOT, "fixtures", rel), "utf8")) as never,
      );
      expect(manifest.views[view as keyof typeof manifest.views], view).toEqual({
        sources: rels,
        ...observeBodies(bodies),
      });
    }
  });

  it("every recorded view has a manifest entry with key sets, enums and array lengths", () => {
    for (const v of [
      "mSettings",
      "mTeam",
      "mRoster",
      "mMatchup",
      "mBoxscore",
      "kona_player_info",
      "proTeamSchedules_wl",
      "mNav",
    ]) {
      const vm = manifest.views[v as keyof typeof manifest.views];
      expect(vm, v).toBeDefined();
      expect(Object.keys(vm?.observed ?? {}).length, v).toBeGreaterThan(0);
      expect(Object.keys(vm?.array_lengths ?? {}).length, v).toBeGreaterThan(0);
    }
    // the meaning-changing split ids and the recorded acquisition types are enumerated
    const roster = manifest.views.mRoster;
    expect(
      roster?.enums["$.teams[].roster.entries[].playerPoolEntry.player.stats[].statSourceId"],
    ).toEqual([0, 1]);
    expect(
      manifest.views.mSettings?.enums["$.settings.acquisitionSettings.acquisitionType"],
    ).toEqual(["WAIVERS_CONTINUOUS", "WAIVERS_TRADITIONAL"]);
    // no member text and no identifier is ever an enum or a key
    const text = JSON.stringify(manifest.views);
    expect(text).not.toMatch(/Team [A-Z]\b|Example League|00000000-0000-4000-8000/);
  });

  it("`scrubbed` keys are exactly keys the scrubber removes", () => {
    for (const p of [manifest.probes.host, manifest.probes.shape])
      for (const keys of Object.values(p.scrubbed ?? {}))
        for (const k of keys) expect(REMOVE_KEYS.has(k)).toBe(true);
  });

  it("the recorded fixtures themselves enumerate inside the enum sets", async () => {
    const r = await probe(json(HOST_BODY()));
    expect(r.line.checks.flatMap((c) => c.findings).filter((f) => f.kind === "enum")).toEqual([]);
  });
});

describe("replay: healthy bodies", () => {
  it("the recorded host and shape bodies are green (exit 0), two keyless GETs to the read host", async () => {
    waits.length = 0;
    const r = await probe(json(HOST_BODY()));
    expect(r.exit).toBe(EXIT.ok);
    expect(r.line.status).toBe("green");
    expect(r.line.checks.map((c) => c.status)).toEqual(["green", "green"]);
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      const u = new URL(c.url);
      expect(u.protocol).toBe("https:");
      expect(u.hostname).toBe(READ_HOST);
      expect(u.hostname).not.toBe(WRITE_HOST);
      expect(c.init.method).toBe("GET");
      expect(c.init.redirect).toBe("manual");
      expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]);
      expect(c.headers["user-agent"]).toMatch(
        /^espn-fantasy-football-mcp\/\d+\.\d+\.\d+ \(drift probe; \+https:\/\/github\.com\//,
      );
    }
    expect(r.calls[0]?.url).toContain("/seasons/2026?view=proTeamSchedules_wl");
    expect(new URL(r.calls[1]?.url ?? "").searchParams.getAll("view")).toEqual([
      "mSettings",
      "mNav",
      "mTeam",
    ]);
    expect(waits).toEqual([1200]); // ≥ 1.2 s between the two requests (research 03 §D.3)
  });

  it("without EFF_PROBE_LEAGUE_ID only the host probe runs (one request); the shape check is skipped", async () => {
    const r = await probe(json(HOST_BODY()), undefined, {});
    expect(r.exit).toBe(EXIT.ok);
    expect(r.calls).toHaveLength(1);
    expect(r.line.checks[1]).toMatchObject({ name: "shape", status: "skipped" });
  });

  it("--host-only skips the shape probe even with a league configured", async () => {
    const r = await probe(json(HOST_BODY()), undefined, undefined, ["--host-only"]);
    expect(r.calls).toHaveLength(1);
    expect(r.line.checks[1]?.status).toBe("skipped");
  });

  it("a new key is additive drift: reported, exit 0", async () => {
    const shape = SHAPE_BODY();
    (shape.status as Record<string, unknown>).brandNewFlag = true;
    const r = await probe(json(HOST_BODY()), json(shape));
    expect(r.exit).toBe(EXIT.ok);
    expect(r.line.status).toBe("additive");
    expect(r.line.checks[1]?.findings).toEqual([
      { severity: "additive", kind: "added", path: "$.status.brandNewFlag", count: 1 },
    ]);
  });

  it("a scrubbed-away key ESPN really sends (members[].notificationSettings) is not additive", async () => {
    const shape = SHAPE_BODY();
    for (const m of shape.members as Record<string, unknown>[]) m.notificationSettings = [];
    const r = await probe(json(HOST_BODY()), json(shape));
    expect(r.line.status).toBe("green");
  });
});

describe("replay: drift (exit 4, the JSON path in the diff)", () => {
  it("Z4: settings.proTeams[].byeWeek renamed → exit 4, removed at the path, the new name additive", async () => {
    const host = HOST_BODY();
    for (const t of host.settings.proTeams) {
      t.byeWeekNumber = t.byeWeek;
      delete t.byeWeek;
    }
    const r = await probe(json(host));
    expect(r.exit).toBe(EXIT.drift);
    expect(r.line.status).toBe("red");
    const findings = r.line.checks[0]?.findings ?? [];
    expect(findings[0]).toEqual({
      severity: "red",
      kind: "removed",
      path: "$.settings.proTeams[0].byeWeek",
      count: host.settings.proTeams.length,
    });
    expect(findings).toContainEqual({
      severity: "additive",
      kind: "added",
      path: "$.settings.proTeams[0].byeWeekNumber",
      count: host.settings.proTeams.length,
    });
    expect(summarize(r.line)).toBe(
      "ESPN drift: proTeamSchedules_wl: removed $.settings.proTeams[0].byeWeek",
    );
  });

  it("the recorded league skeleton (an unknown view answers 200) as the shape probe → red, exit 4", async () => {
    const r = await probe(json(HOST_BODY()), json(LEAGUE_SKELETON()));
    expect(r.exit).toBe(EXIT.drift);
    const removed = (r.line.checks[1]?.findings ?? [])
      .filter((f) => f.kind === "removed")
      .map((f) => f.path);
    expect(removed).toEqual(
      expect.arrayContaining([
        "$.settings.scoringSettings",
        "$.settings.size",
        "$.status.finalScoringPeriod",
      ]),
    );
  });

  it("the recorded season skeleton as the host probe → red, $.settings removed", async () => {
    const r = await probe(json(SEASON_SKELETON()));
    expect(r.exit).toBe(EXIT.drift);
    expect(r.line.checks[0]?.findings[0]).toMatchObject({
      severity: "red",
      kind: "removed",
      path: "$.settings",
    });
  });

  it("a changed type is red (byeWeek as a string)", async () => {
    const host = HOST_BODY();
    const first = host.settings.proTeams[1]!;
    first.byeWeek = String(first.byeWeek);
    const r = await probe(json(host));
    expect(r.exit).toBe(EXIT.drift);
    expect(r.line.checks[0]?.findings[0]).toMatchObject({
      kind: "type",
      path: "$.settings.proTeams[1].byeWeek",
      count: 1,
    });
  });

  it("an unknown pro-team id is red (enum), an emptied pro-team list is red (short)", async () => {
    const host = HOST_BODY();
    host.settings.proTeams[2]!.id = 99;
    let r = await probe(json(host));
    expect(r.exit).toBe(EXIT.drift);
    expect(
      r.line.checks[0]?.findings.some(
        (f) => f.kind === "enum" && f.path === "$.settings.proTeams[2].id",
      ),
    ).toBe(true);
    const empty = HOST_BODY();
    empty.settings.proTeams = [];
    r = await probe(json(empty));
    expect(r.line.checks[0]?.findings).toEqual([
      expect.objectContaining({ kind: "short", path: "$.settings.proTeams", severity: "red" }),
    ]);
  });

  it("a new lineup slot id (meaning-changing enum) is red", async () => {
    const shape = SHAPE_BODY();
    const counts = (
      (shape.settings as Record<string, unknown>).rosterSettings as Record<
        string,
        Record<string, number>
      >
    ).lineupSlotCounts;
    if (counts) counts["26"] = 1;
    const r = await probe(json(HOST_BODY()), json(shape));
    expect(r.exit).toBe(EXIT.drift);
  });

  it("a body that is an array, or an entity that is not an object, is red", async () => {
    let r = await probe(json([1, 2, 3]));
    expect(r.exit).toBe(EXIT.drift);
    const host = HOST_BODY();
    (host.settings.proTeams as unknown[])[3] = "not an object";
    r = await probe(json(host));
    expect(
      r.line.checks[0]?.findings.some(
        (f) => f.kind === "not_object" && f.path === "$.settings.proTeams[3]",
      ),
    ).toBe(true);
  });

  it("property: removing any one required key from any one entity is red with that exact path", async () => {
    const { manifest } = loadManifest(DEFAULT_MANIFEST);
    const host = HOST_BODY();
    const keys = Object.keys(manifest.probes.host.required["$.settings.proTeams[]"] ?? {});
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: host.settings.proTeams.length - 1 }),
        fc.constantFrom(...keys),
        async (i, k) => {
          const b = HOST_BODY();
          const team = { ...b.settings.proTeams[i] };
          Reflect.deleteProperty(team, k);
          b.settings.proTeams[i] = team;
          const r = await probe(json(b));
          expect(r.exit).toBe(EXIT.drift);
          expect(r.line.checks[0]?.findings[0]).toMatchObject({
            kind: "removed",
            path: `$.settings.proTeams[${String(i)}].${k}`,
            count: 1,
          });
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("replay: host moved (exit 6), unreachable (exit 7), config (exit 2)", () => {
  it("a 302 to www.espn.com with a text body → host moved, not followed", async () => {
    const r = await probe({
      status: 302,
      body: "Redirecting",
      headers: { location: "https://www.espn.com/fantasy/", "content-type": "text/plain" },
    });
    expect(r.exit).toBe(EXIT.hostMoved);
    expect(r.line.checks[0]).toMatchObject({ status: "host_moved", http: 302 });
    expect(r.line.checks[0]?.reason).toContain("www.espn.com");
    expect(r.calls.every((c) => c.init.redirect === "manual")).toBe(true);
    expect(summarize(r.line)).toMatch(
      /^ESPN host moved: proTeamSchedules_wl: HTTP 302 redirect to www\.espn\.com/,
    );
  });

  it("a 200 that is HTML, or JSON-typed but unparseable, → host moved", async () => {
    let r = await probe({
      status: 200,
      body: "<html>marketing</html>",
      headers: { "content-type": "text/html" },
    });
    expect(r.exit).toBe(EXIT.hostMoved);
    r = await probe({
      status: 200,
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(r.exit).toBe(EXIT.hostMoved);
    r = await probe({
      status: 403,
      body: "<html>Access Denied</html>",
      headers: { "content-type": "text/html" },
    });
    expect(r.exit).toBe(EXIT.hostMoved);
  });

  it("a fetch that reports a different final host (a follower) → host moved", async () => {
    const fetch = (url: string): Promise<Response> => {
      const res = new Response(JSON.stringify(HOST_BODY()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(res, "url", { value: url.replace(READ_HOST, "www.espn.com") });
      return Promise.resolve(res);
    };
    const r = await runProbe([], { fetch, env: {}, sleep: () => Promise.resolve() });
    expect(r.exit).toBe(EXIT.hostMoved);
  });

  it("5xx, 429, a network error and a timeout → unreachable", async () => {
    for (const reply of [
      { status: 503, body: "busy" },
      { status: 429, body: "" },
      new TypeError("fetch failed"),
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      }),
    ] as Reply[]) {
      const r = await probe(reply, undefined, {});
      expect(r.exit, String(reply instanceof Error ? reply.name : reply.status)).toBe(
        EXIT.unreachable,
      );
      expect(r.line.status).toBe("unreachable");
    }
  });

  it("the shape league answering 401 (not public) or 404 → config, exit 2; a 404 season → config", async () => {
    const err = (status: number, type: string) =>
      json({ messages: ["x"], details: [{ type }] }, status);
    let r = await probe(json(HOST_BODY()), err(401, "AUTH_LEAGUE_NOT_VISIBLE"));
    expect(r.exit).toBe(EXIT.config);
    expect(r.line.checks[1]?.reason).toMatch(
      /AUTH_LEAGUE_NOT_VISIBLE.*not public.*never sends cookies/,
    );
    r = await probe(json(HOST_BODY()), err(404, "GENERAL_NOT_FOUND"));
    expect(r.exit).toBe(EXIT.config);
    r = await probe(err(404, "GENERAL_NOT_FOUND"), undefined, {});
    expect(r.exit).toBe(EXIT.config);
    r = await probe(err(400, "FILTER_LIMIT_MISSING_SORT"), undefined, {});
    expect(r.exit).toBe(EXIT.error);
  });

  it("precedence: host moved beats red drift beats unreachable", async () => {
    let r = await probe(
      { status: 302, body: "", headers: { location: "https://www.espn.com/" } },
      json(LEAGUE_SKELETON()),
    );
    expect(r.exit).toBe(EXIT.hostMoved);
    r = await probe({ status: 503, body: "" }, json(LEAGUE_SKELETON()));
    expect(r.exit).toBe(EXIT.drift);
  });
});

describe("nothing secret leaves the probe", () => {
  it("the JSON line never carries the configured league id, even from an error message that does", async () => {
    const r = await probe(
      json(HOST_BODY()),
      new Error(`connect ECONNREFUSED for leagues/${LEAGUE}?view=mSettings`),
    );
    const text = JSON.stringify(r.line);
    expect(text).not.toContain(LEAGUE);
    expect(r.line.checks[1]?.status).toBe("unreachable");
    expect(r.line.checks[1]?.reason).toContain("<league>");
  });

  it("the JSON line has a fixed shape (schema 1) and no URL", async () => {
    const r = await probe(json(HOST_BODY()));
    expect(Object.keys(r.line).sort()).toEqual([
      "at",
      "checks",
      "exit",
      "host",
      "manifest_sha256",
      "probe",
      "schema",
      "season",
      "status",
    ]);
    expect(JSON.stringify(r.line)).not.toMatch(/https?:\/\//);
  });
});

describe("usage and configuration (exit 2, before any request)", () => {
  const cases: [string[], NodeJS.ProcessEnv, RegExp][] = [
    [["--league", "12345"], {}, /EFF_PROBE_LEAGUE_ID only/],
    [["--season", "1999"], {}, /--season/],
    [["--season"], {}, /--season/],
    [["--manifest"], {}, /--manifest/],
    [[], { EFF_PROBE_LEAGUE_ID: "12a" }, /positive integer/],
    [[], { EFF_PROBE_LEAGUE_ID: "0" }, /positive integer/],
    [[], { EFF_PROBE_LEAGUE_ID: "1".repeat(13) }, /positive integer/],
    [[], { ESPN_SEASON: "twenty" }, /ESPN_SEASON/],
  ];
  it.each(cases)("%j with %j is refused", async (argv, env, msg) => {
    const f = fakeFetch(json(HOST_BODY()));
    const r = await runProbe(argv, deps(f, env));
    expect(r.exit).toBe(EXIT.config);
    expect(r.line).toBeNull();
    expect(r.usage).toMatch(msg);
    expect(f.calls).toHaveLength(0);
  });

  it("a malformed manifest is an error, never a silent pass", async () => {
    const f = fakeFetch(json(HOST_BODY()));
    const r = await runProbe(["--manifest", path.join(ROOT, "package.json")], deps(f, {}));
    expect(r.exit).toBe(EXIT.error);
    expect(f.calls).toHaveLength(0);
  });

  it("ESPN_SEASON picks the season; the default follows the calendar (June rollover)", async () => {
    const f = fakeFetch(json(HOST_BODY()));
    await runProbe([], { ...deps(f, { ESPN_SEASON: "2025" }) });
    expect(f.calls[0]?.url).toContain("/seasons/2025?");
    const g = fakeFetch(json(HOST_BODY()));
    await runProbe([], { ...deps(g, {}), now: () => new Date("2027-02-01T00:00:00Z") });
    expect(g.calls[0]?.url).toContain("/seasons/2026?");
  });
});

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
describe("manifest validation rejects malformed specs", () => {
  const good = (): Mutable<DriftManifest> =>
    JSON.parse(readFileSync(DEFAULT_MANIFEST, "utf8")) as Mutable<DriftManifest>;
  const anyView = (m: Mutable<DriftManifest>) =>
    m.views.mSettings as unknown as Record<string, unknown> & { observed: Record<string, unknown> };
  const mutations: [string, (m: Mutable<DriftManifest>) => void][] = [
    ["version", (m) => (m.version = 2)],
    ["host", (m) => (m.host = "")],
    ["views", (m) => (m.probes.host.views = [])],
    ["view name", (m) => (m.probes.host.views = ["mSettings&x"])],
    ["required empty", (m) => (m.probes.shape.required = {})],
    ["bad type", (m) => (m.probes.host.required.$ = { settings: "objekt" })],
    ["bad pattern", (m) => (m.probes.host.required["$..x"] = { a: "string" })],
    [
      "observed not list",
      (m) => ((m.probes.host.observed as Record<string, unknown>).$ = "settings"),
    ],
    ["enums pattern", (m) => (m.probes.host.enums = { "settings.x": [1] })],
    ["$sources missing", (m) => delete (m as Partial<typeof m>).$sources],
    [
      "$sources not strings",
      (m) => ((m.$sources as unknown as Record<string, unknown>).host = [1]),
    ],
    ["views missing", (m) => delete (m as Partial<typeof m>).views],
    ["view entry name", (m) => ((m.views as Record<string, unknown>)["m&x"] = m.views.mSettings)],
    ["view sources empty", (m) => (anyView(m).sources = [])],
    ["view observed pattern", (m) => (anyView(m).observed.settings = ["x"])],
    ["view enums value", (m) => (anyView(m).enums = { $: [{}] })],
    ["view lengths inverted", (m) => (anyView(m).array_lengths = { "$.x": { min: 3, max: 1 } })],
    ["view lengths fraction", (m) => (anyView(m).array_lengths = { "$.x": { min: 0.5, max: 1 } })],
    ["view not object", (m) => ((m.views as Record<string, unknown>).mTeam = 7)],
  ];
  it.each(mutations)("%s", async (_name, mutate) => {
    const m = good();
    mutate(m);
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "eff-drift-"));
    try {
      const file = path.join(dir, "m.json");
      writeFileSync(file, JSON.stringify(m));
      expect(() => loadManifest(file)).toThrow(/drift manifest|pattern|bad key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("observeBodies / requiredPathStatus (the per-view manifest generator)", () => {
  it("records key sets, array lengths, enums; numeric-keyed objects are maps (values under {})", () => {
    const o = observeBodies([
      {
        teams: [
          { id: 1, abbrev: "ABC", status: "ACTIVE", stats: { "53": 1, "0": 2 }, lineupSlotId: 20 },
          { id: 2, abbrev: "XYZ", status: "OUT", stats: {}, lineupSlotId: 4 },
        ],
      },
      { teams: [] },
    ] as never);
    // an EMPTY object is an entity with no keys; a numeric-keyed one is a map (no key recorded)
    expect(o.observed).toEqual({
      $: ["teams"],
      "$.teams[]": ["abbrev", "id", "lineupSlotId", "stats", "status"],
      "$.teams[].stats": [],
    });
    expect(o.array_lengths).toEqual({ "$.teams": { min: 0, max: 2 } });
    expect(o.enums).toEqual({
      "$.teams[].lineupSlotId": [4, 20],
      "$.teams[].status": ["ACTIVE", "OUT"],
    });
  });
  it("member text is never an enum; GUID-keyed objects never leak keys; huge value sets are dropped", () => {
    const o = observeBodies([
      {
        members: [{ displayName: "ABC", firstName: "XYZ", name: "QQQ" }],
        byGuid: { "{00000000-0000-4000-8000-000000000001}": { x: 1 } },
        codes: Array.from({ length: MAX_ENUM_VALUES + 1 }, (_, i) => ({ code: `C_${String(i)}` })),
      },
    ] as never);
    expect(o.enums["$.members[].displayName"]).toBeUndefined();
    expect(o.enums["$.codes[].code"]).toBeUndefined();
    expect(JSON.stringify(o)).not.toContain("00000000-0000-4000-8000");
    expect(o.observed["$.byGuid{}"]).toEqual(["x"]);
  });
  it("is deterministic and order-independent", () => {
    const a = { teams: [{ b: 1, a: "X_Y" }, { c: true }] };
    const b = { teams: [{ c: true }, { a: "X_Y", b: 1 }] };
    expect(observeBodies([a, b] as never)).toEqual(observeBodies([b, a] as never));
  });
  it("requiredPathStatus: present / absent / partial, and `$[]` for a root array", () => {
    const body = { teams: [{ roster: { entries: [] } }, { roster: {} }], players: [] } as never;
    expect(requiredPathStatus(body, "$.teams[].roster")).toBe("present");
    expect(requiredPathStatus(body, "$.teams[].roster.entries")).toBe("partial");
    expect(requiredPathStatus(body, "$.teams[].record")).toBe("absent");
    expect(requiredPathStatus(body, "$.schedule[].home")).toBe("absent");
    expect(requiredPathStatus([1, 2] as never, "$[]")).toBe("present");
    expect(requiredPathStatus([] as never, "$[]")).toBe("absent");
    expect(requiredPathStatus(body, "$[]")).toBe("absent");
    expect(() => requiredPathStatus(body, "teams")).toThrow();
  });
  it("rebaseline is idempotent: rewriting a copy of the committed manifest changes nothing", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "eff-drift-"));
    try {
      const file = path.join(dir, "m.json");
      const before = readFileSync(DEFAULT_MANIFEST, "utf8");
      writeFileSync(file, before);
      await rebaseline(file, rebaselineSources(DEFAULT_MANIFEST));
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
