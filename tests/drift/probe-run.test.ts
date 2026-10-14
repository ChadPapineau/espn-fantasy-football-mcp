// probe-run.test.ts — the drift_state side of one probe run (Stage C finding drift-red-never-clears,
// the probe half; plan 01 §7 "The daily probe", plan 06 §1.2, plan 03 §7): `applyProbe` /
// `DriftStateWriter.probed`. A probe answer that verified a view clears that view's required-key
// drift — each view of a composite answer on its own — a schema-level key waits for an in-call
// answer, a key the run itself found missing stands with its `since`, a host move ends only on a
// good answer of a run that saw no move, a newer manifest re-baselines first and says so, and
// `last_probe_at` moves on every run. Driven by hand-built answers, by the CLI's own probe checks
// over the committed anonymised bodies (an injected fetch — no network, no cookie) and by a
// fast-check property with an independent oracle.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hostProbe, shapeProbe, type ProbeCheck } from "../../src/cli/probe.js";
import { fixedClock } from "../../src/domain/clock.js";
import {
  applyManifest,
  applyProbe,
  applySignals,
  driftMetaFor,
  DriftStateWriter,
  parseDiffs,
  probeVerifiedViews,
  scoringRefusal,
  settingsDriftPath,
  type ProbeAnswer,
} from "../../src/drift/state.js";
import {
  REQUIRED_PATHS_BY_VIEW,
  type DriftSignal,
  type DriftStateRepository,
  type DriftStateRow,
  type ManifestIdentity,
} from "../../src/drift/types.js";
import { createHttpClient } from "../../src/http/client.js";
import type { EspnView } from "../../src/providers/espn/types.js";
import { jsonResponse, loadFixture, MemoryLimiterRepo, SEASON } from "../providers/espn/helpers.js";

const H = "lm-api-reads.fantasy.espn.com";
/** The operator override (plan 03 §3: `^[a-z0-9-]+\.fantasy\.espn\.com$`). */
const OVERRIDE = "lm-api-reads2.fantasy.espn.com";
const T0 = "2026-10-06T12:00:00.000Z";
const T1 = "2026-10-07T06:00:00.000Z";
const T2 = "2026-10-08T06:00:00.000Z";
const ACQ = "$.settings.acquisitionSettings";
const NAV = "$.members[].isLeagueCreator";
const RANK = "$.teams[].waiverRank";
/** A schema-level path (outside the required-key seed) a view schema reports. */
const DEEP = "$.settings.scoringSettings.scoringItems[].points";
const SHAPE: readonly EspnView[] = ["mSettings", "mNav", "mTeam"];
const SEASON_VIEWS: readonly EspnView[] = ["proTeamSchedules_wl"];
const A: ManifestIdentity = { hash: "a".repeat(64), version: 1 };
const B: ManifestIdentity = { hash: "b".repeat(64), version: 1 };

const missing = (view: EspnView, path: string): DriftSignal => ({
  kind: "missing_required_key",
  view,
  path,
  value: null,
});
const moved = (view: EspnView): DriftSignal => ({
  kind: "host_moved",
  view,
  path: "$",
  value: null,
});
const additive = (view: EspnView, path: string): DriftSignal => ({
  kind: "additive_key",
  view,
  path,
  value: null,
});
const answer = (
  views: readonly EspnView[],
  status: ProbeAnswer["status"],
  signals: readonly DriftSignal[] = [],
): ProbeAnswer => ({ views, status, signals });
const hostGreen = answer(SEASON_VIEWS, "green");
const shapeGreen = answer(SHAPE, "green");

class Repo implements DriftStateRepository {
  row: DriftStateRow | null = null;
  puts = 0;
  get() {
    return this.row;
  }
  put(r: DriftStateRow) {
    this.puts++;
    this.row = r;
  }
}

const removedOf = (row: DriftStateRow, view: EspnView): readonly string[] =>
  parseDiffs(row.diff_json).find((d) => d.view === view)?.removed ?? [];

describe("a green probe ends the drift it verified (drift-red-never-clears, the probe half)", () => {
  it("one incomplete in-call mSettings answer, then a green host + shape probe: green, the refusal and meta.drift end, the run is stamped", () => {
    const clock = fixedClock(T0);
    const repo = new Repo();
    const w = new DriftStateWriter(repo, clock, H);
    const red = w.record([missing("mSettings", ACQ)]);
    expect(scoringRefusal(red)).toBe("settings_drift");
    // what `eff probe` did with this run before (record its signals, then `recovered()` — which
    // knows no view): the row stays red, the refusal stands, nothing ends it but an in-call answer
    const legacy = new DriftStateWriter(new Repo(), clock, H);
    legacy.record([missing("mSettings", ACQ)]);
    expect(legacy.recovered()?.status).toBe("red");
    clock.advance(Date.parse(T1) - Date.parse(T0));
    const out = w.probed([hostGreen, shapeGreen]);
    expect(out.rebaselined).toBe(false);
    expect(out.row).toMatchObject({
      status: "green",
      since: null,
      diff_json: "[]",
      last_probe_at: T1,
      updated_at: T1,
      host: H,
    });
    expect(repo.row).toBe(out.row);
    expect(scoringRefusal(out.row)).toBeNull();
    expect(settingsDriftPath(out.row)).toBeNull();
    expect(driftMetaFor(out.row, ["kona_player_info"])).toBeNull();
    expect(driftMetaFor(out.row, ["mSettings", "mNav"])).toBeNull();
  });

  it("the CLI's own checks drive it: hostProbe + shapeProbe over the recorded bodies clear an in-call red row; a drifted shape body records its key", async () => {
    const clock = fixedClock(T0);
    const shapeBody = (): Record<string, unknown> =>
      structuredClone(loadFixture("recorded/league-a/probe-shape.json")) as Record<string, unknown>;
    let shape = shapeBody;
    const urls: string[] = [];
    const fetch = (url: string): Promise<Response> => {
      urls.push(url);
      return Promise.resolve(
        jsonResponse(
          url.includes("/leagues/")
            ? shape()
            : loadFixture("recorded/season/proTeamSchedules_wl.json"),
        ),
      );
    };
    const deps = {
      http: createHttpClient({ fetch }),
      limiter: new MemoryLimiterRepo(),
      clock,
      host: H,
      observations: undefined,
      origin: "server" as const,
    };
    // one run = the two keyless requests `eff probe` sends, past the 1-per-second window
    const run = async (): Promise<ProbeCheck[]> => {
      const host = await hostProbe(deps, SEASON);
      clock.advance(2_000);
      const league = await shapeProbe(deps, SEASON, "0", true);
      clock.advance(2_000);
      return [host, league];
    };
    const repo = new Repo();
    const w = new DriftStateWriter(repo, clock, H);
    w.record([missing("mSettings", ACQ), missing("mTeam", RANK)]);
    const checks = await run();
    expect(checks.map((c) => c.status)).toEqual(["green", "green"]);
    expect(w.probed(checks).row).toMatchObject({ status: "green", since: null, diff_json: "[]" });
    // ESPN answers the shape probe without acquisitionSettings: that key is recorded, nothing else
    shape = () => {
      const b = shapeBody() as { settings: Record<string, unknown> };
      delete b.settings.acquisitionSettings;
      return b;
    };
    const drifted = await run();
    expect(drifted.map((c) => c.status)).toEqual(["green", "red"]);
    const out = w.probed(drifted);
    expect(parseDiffs(out.row.diff_json)).toEqual([
      { view: "mSettings", removed: [ACQ], added: [], enums: [] },
    ]);
    expect(settingsDriftPath(out.row)).toBe("settings.acquisitionSettings");
    // and the next healthy run ends it
    shape = shapeBody;
    expect(w.probed(await run()).row.status).toBe("green");
    expect(urls.every((u) => new URL(u).hostname === H)).toBe(true);
  });

  it("one composite answer verifies each view on its own: a key missing under mTeam leaves mSettings and mNav verified", () => {
    const pre = applySignals(null, [missing("mSettings", ACQ), missing("mNav", NAV)], H, T0);
    expect(probeVerifiedViews(answer(SHAPE, "red", [missing("mTeam", RANK)]))).toEqual([
      "mSettings",
      "mNav",
    ]);
    const { row } = applyProbe(
      pre,
      [hostGreen, answer(SHAPE, "red", [missing("mTeam", RANK)])],
      null,
      H,
      T1,
    );
    expect(parseDiffs(row.diff_json)).toEqual([
      { view: "mTeam", removed: [RANK], added: [], enums: [] },
    ]);
    // the drift that is left began with this run
    expect(row).toMatchObject({ status: "red", since: T1 });
    expect(scoringRefusal(row)).toBeNull();
    expect(driftMetaFor(row, ["mTeam"])?.views).toEqual(["mTeam"]);
    expect(driftMetaFor(row, ["mRoster"])).toBeNull();
  });

  it("a schema-level key waits for an in-call answer of its view; the refusal names it", () => {
    const pre = applySignals(null, [missing("mSettings", ACQ), missing("mSettings", DEEP)], H, T0);
    const { row } = applyProbe(pre, [hostGreen, shapeGreen], null, H, T1);
    expect(removedOf(row, "mSettings")).toEqual([DEEP]);
    expect(row).toMatchObject({ status: "red", since: T0 });
    expect(settingsDriftPath(row)).toBe("settings.scoringSettings.scoringItems[].points");
    expect(scoringRefusal(row)).toBe("settings_drift");
  });

  it("a key the run itself found missing stands with its since, even when another of its answers verified the view", () => {
    const pre = applySignals(null, [missing("mSettings", ACQ)], H, T0);
    const { row } = applyProbe(
      pre,
      [answer(["mSettings"], "red", [missing("mSettings", ACQ)]), shapeGreen],
      null,
      H,
      T1,
    );
    expect(removedOf(row, "mSettings")).toEqual([ACQ]);
    expect(row).toMatchObject({ status: "red", since: T0 });
    // the same key still missing in the shape answer itself: never cleared, still since T0
    const again = applyProbe(row, [answer(SHAPE, "red", [missing("mSettings", ACQ)])], null, H, T2);
    expect(again.row).toMatchObject({ status: "red", since: T0, last_probe_at: T2 });
    expect(removedOf(again.row, "mSettings")).toEqual([ACQ]);
  });

  it("answers that verify nothing clear nothing: moved, unreachable, refused, skipped — and an answer that says green but carries a move", () => {
    const pre = applySignals(null, [missing("mSettings", ACQ)], H, T0);
    const none: readonly ProbeAnswer[] = [
      answer(SHAPE, "unreachable"),
      answer(SHAPE, "config"),
      answer(SHAPE, "skipped"),
      answer(SHAPE, "host_moved", [moved("mSettings")]),
      answer(SHAPE, "green", [moved("mSettings")]),
      answer(SHAPE, "host_moved"),
    ];
    for (const a of none) expect(probeVerifiedViews(a)).toEqual([]);
    for (const a of none.slice(0, 3)) {
      const { row } = applyProbe(pre, [a], null, H, T1);
      expect(row).toMatchObject({ status: "red", since: T0, last_probe_at: T1 });
      expect(removedOf(row, "mSettings")).toEqual([ACQ]);
    }
    for (const a of none.slice(3, 5)) {
      const { row } = applyProbe(pre, [a], null, H, T1);
      expect(row).toMatchObject({ status: "host_moved", since: T0, host_moved_at: T1 });
      expect(removedOf(row, "mSettings")).toEqual([ACQ]);
    }
    // a verdict of `host_moved` without its signal records no move — and verifies nothing either
    expect(applyProbe(pre, [none[5]!], null, H, T1).row).toMatchObject({ status: "red" });
  });

  it("additive signals and new enum values are counted and leave the answer's views verified", () => {
    const pre = applySignals(null, [missing("mTeam", RANK)], H, T0);
    const enumSignal: DriftSignal = {
      kind: "unknown_enum_value",
      view: "mTeam",
      path: "$.teams[].playoffSeed",
      value: "NEW",
    };
    const meaning: DriftSignal = {
      kind: "meaning_changing_enum",
      view: "mSettings",
      path: "$.settings.scoringSettings.scoringItems[].statSourceId",
      value: "9",
    };
    const shape = answer(SHAPE, "additive", [
      additive("mTeam", "$.teams[].newKey"),
      enumSignal,
      meaning,
    ]);
    expect(probeVerifiedViews(shape)).toEqual(SHAPE);
    const { row } = applyProbe(pre, [shape], null, H, T1);
    expect(row.status).toBe("additive");
    expect(row.since).toBeNull();
    expect(parseDiffs(row.additive_json)).toEqual([
      {
        view: "mTeam",
        removed: [],
        added: ["$.teams[].newKey"],
        enums: ["$.teams[].playoffSeed=NEW"],
      },
      {
        view: "mSettings",
        removed: [],
        added: [],
        enums: ["$.settings.scoringSettings.scoringItems[].statSourceId=9"],
      },
    ]);
  });
});

describe("a probe run and the host move (plan 01 §7, ADV OBJ-06)", () => {
  const pre = applySignals(
    applySignals(null, [moved("mSettings")], H, T0),
    [missing("mSettings", ACQ)],
    H,
    T0,
  );
  it("a good answer of a run that saw no move ends it; the row names the configured host", () => {
    expect(pre).toMatchObject({ status: "host_moved", host_moved_at: T0 });
    const { row } = applyProbe(pre, [hostGreen, shapeGreen], null, OVERRIDE, T1);
    expect(row).toMatchObject({
      status: "green",
      since: null,
      host: OVERRIDE,
      host_moved_at: null,
      diff_json: "[]",
    });
    // one good answer is enough — the host probe unreachable, the shape answered JSON
    expect(
      applyProbe(pre, [answer(SEASON_VIEWS, "unreachable"), shapeGreen], null, H, T1).row,
    ).toMatchObject({ status: "green", host_moved_at: null });
  });
  it("a run that saw a move keeps it — its first time — while its good answers still clear their views' keys", () => {
    const { row } = applyProbe(
      pre,
      [answer(SEASON_VIEWS, "host_moved", [moved("proTeamSchedules_wl")]), shapeGreen],
      null,
      H,
      T1,
    );
    expect(row).toMatchObject({ status: "host_moved", since: T0, host_moved_at: T0 });
    expect(removedOf(row, "mSettings")).toEqual([]);
    // while the move stands every result carries meta.drift; the refusal ended with the key
    expect(driftMetaFor(row, ["mRoster"])?.views).toEqual(["mRoster"]);
    expect(scoringRefusal(row)).toBeNull();
  });
  it("a run with no good answer keeps it: unreachable, skipped, or JSON that is itself red", () => {
    for (const run of [
      [answer(SEASON_VIEWS, "unreachable"), answer(SHAPE, "skipped")],
      [answer(SEASON_VIEWS, "red", [missing("proTeamSchedules_wl", "$.settings.proTeams")])],
      // a verdict of green that carries a failing signal is not a good answer
      [answer(SEASON_VIEWS, "green", [missing("proTeamSchedules_wl", "$.settings.proTeams")])],
      [],
    ] satisfies ProbeAnswer[][]) {
      const { row } = applyProbe(pre, run, null, H, T1);
      expect(row).toMatchObject({ status: "host_moved", since: T0, host_moved_at: T0 });
    }
  });
  it("a green row that a run sees move: host_moved from the run's time, naming the host that answered", () => {
    const { row } = applyProbe(
      null,
      [answer(SEASON_VIEWS, "host_moved", [moved("proTeamSchedules_wl")])],
      null,
      OVERRIDE,
      T1,
    );
    expect(row).toMatchObject({
      status: "host_moved",
      since: T1,
      host: OVERRIDE,
      host_moved_at: T1,
      last_probe_at: T1,
    });
  });
});

describe("a probe run and the manifest (plan 03 §7: a newer manifest re-baselines on its first probe and says so)", () => {
  const stamped = applyManifest(
    applySignals(null, [missing("mSettings", ACQ), additive("mTeam", "$.teams[].newKey")], H, T0),
    A,
    H,
    T0,
  ).row;
  it("a newer manifest discards the old diff first; this run's findings are recorded against the new one", () => {
    const out = applyProbe(
      stamped,
      [hostGreen, answer(SHAPE, "red", [missing("mTeam", RANK)])],
      B,
      H,
      T1,
    );
    expect(out.rebaselined).toBe(true);
    expect(out.row).toMatchObject({
      manifest_hash: B.hash,
      manifest_version: 1,
      status: "red",
      since: T1,
      additive_json: "[]",
      last_probe_at: T1,
    });
    expect(parseDiffs(out.row.diff_json)).toEqual([
      { view: "mTeam", removed: [RANK], added: [], enums: [] },
    ]);
  });
  it("the same manifest re-baselines nothing; no manifest leaves the stamp alone; either way the run's clears apply", () => {
    const same = applyProbe(stamped, [shapeGreen], A, H, T1);
    expect(same.rebaselined).toBe(false);
    expect(same.row).toMatchObject({ manifest_hash: A.hash, status: "additive", diff_json: "[]" });
    expect(same.row.additive_json).toBe(stamped.additive_json);
    const none = applyProbe(stamped, [answer(SHAPE, "unreachable")], null, H, T1);
    expect(none).toMatchObject({
      rebaselined: false,
      row: { manifest_hash: A.hash, status: "red" },
    });
  });
  it("a row written before any probe records the manifest and keeps its drift (never dropped on doubt) unless the run verified it", () => {
    const unstamped = applySignals(
      null,
      [missing("mSettings", ACQ), missing("mRoster", "$.teams[].roster.entries")],
      H,
      T0,
    );
    const out = applyProbe(unstamped, [hostGreen, shapeGreen], A, H, T1);
    expect(out.rebaselined).toBe(false);
    expect(out.row).toMatchObject({ manifest_hash: A.hash, status: "red", since: T0 });
    expect(parseDiffs(out.row.diff_json).map((d) => d.view)).toEqual(["mRoster"]);
  });
  it("no row yet: the run creates one — green and stamped, or as the run found it", () => {
    expect(applyProbe(null, [answer(SHAPE, "skipped")], null, H, T1)).toEqual({
      rebaselined: false,
      row: {
        status: "green",
        since: null,
        last_probe_at: T1,
        manifest_hash: null,
        manifest_version: null,
        host: H,
        host_moved_at: null,
        diff_json: "[]",
        additive_json: "[]",
        updated_at: T1,
      },
    });
    expect(applyProbe(null, [hostGreen, shapeGreen], A, H, T1).row).toMatchObject({
      status: "green",
      manifest_hash: A.hash,
      last_probe_at: T1,
    });
  });
});

describe("DriftStateWriter.probed", () => {
  it("stores every run (last_probe_at moves) and returns what it stored; the manifest is optional", () => {
    const clock = fixedClock(T0);
    const repo = new Repo();
    const w = new DriftStateWriter(repo, clock, H);
    const first = w.probed([answer(SHAPE, "skipped")]);
    expect(repo.puts).toBe(1);
    expect(repo.row).toBe(first.row);
    expect(first.row).toMatchObject({ status: "green", last_probe_at: T0, manifest_hash: null });
    clock.advance(86_400_000);
    const second = w.probed([hostGreen], A);
    expect(repo.puts).toBe(2);
    expect(second).toMatchObject({
      rebaselined: false,
      row: { last_probe_at: "2026-10-07T12:00:00.000Z", manifest_hash: A.hash },
    });
    clock.advance(86_400_000);
    w.record([missing("mSettings", ACQ)]);
    expect(w.probed([hostGreen, shapeGreen], B)).toMatchObject({
      rebaselined: true,
      row: { status: "green", manifest_hash: B.hash, last_probe_at: "2026-10-08T12:00:00.000Z" },
    });
  });
});

describe("property: a probe run against an independent oracle", () => {
  const VIEWS: readonly EspnView[] = [
    "mSettings",
    "mNav",
    "mTeam",
    "mRoster",
    "proTeamSchedules_wl",
  ];
  const FAILING = new Set<DriftSignal["kind"]>(["missing_required_key", "skeleton", "host_moved"]);
  const signalArb: fc.Arbitrary<DriftSignal> = fc
    .record({
      view: fc.constantFrom(...VIEWS),
      kind: fc.constantFrom<DriftSignal["kind"]>(
        "missing_required_key",
        "skeleton",
        "additive_key",
        "unknown_enum_value",
        "meaning_changing_enum",
        "host_moved",
      ),
      deep: fc.boolean(),
      pick: fc.nat(),
    })
    .map(({ view, kind, deep, pick }): DriftSignal => {
      if (kind === "host_moved") return moved(view);
      const seed = REQUIRED_PATHS_BY_VIEW[view];
      const path = deep ? `$.deep${String(pick % 3)}.key` : (seed[pick % seed.length] ?? "$");
      const enumKind = kind === "unknown_enum_value" || kind === "meaning_changing_enum";
      return { kind, view, path, value: enumKind ? "NEW" : null };
    });
  const answerArb: fc.Arbitrary<ProbeAnswer> = fc.record({
    views: fc.subarray([...VIEWS]),
    status: fc.constantFrom<ProbeAnswer["status"]>(
      "green",
      "additive",
      "red",
      "host_moved",
      "unreachable",
      "config",
      "skipped",
    ),
    signals: fc.array(signalArb, { maxLength: 4 }),
  });
  const failing = (s: DriftSignal) => FAILING.has(s.kind);
  const isBad = (s: string) => s === "red" || s === "host_moved";

  it("clears exactly the seed keys a judged answer verified and the run did not find missing; records what it found; the move, the status, since and the stamps follow", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(signalArb, { maxLength: 5 }), { maxLength: 4 }),
        fc.boolean(),
        fc.array(answerArb, { maxLength: 3 }),
        fc.constantFrom<ManifestIdentity | null>(null, A, B),
        (batches, stamp, answers, manifest) => {
          let pre: DriftStateRow | null = null;
          for (const b of batches) pre = applySignals(pre, b, H, T0);
          if (pre !== null && stamp) pre = applyManifest(pre, A, H, T0).row;
          const out = applyProbe(pre, answers, manifest, OVERRIDE, T1);
          const row = out.row;

          // the oracle — built from the rules, not from the transforms under test
          const rebaselined = manifest === B && pre !== null && stamp;
          expect(out.rebaselined).toBe(rebaselined);
          const baseDiffs = pre === null || rebaselined ? [] : parseDiffs(pre.diff_json);
          const baseAdditive = pre === null || rebaselined ? [] : parseDiffs(pre.additive_json);
          const baseMoved = pre?.status === "host_moved";
          const signals = answers.flatMap((a) => a.signals);
          const found = new Set(signals.filter(failing).map((s) => `${s.view}|${s.path}`));
          const verified = new Set<EspnView>();
          for (const a of answers) {
            // judged JSON only (a `host_moved` verdict is not one); a move signal unverifies it
            const judged = a.status === "green" || a.status === "additive" || a.status === "red";
            if (!judged || a.signals.some((s) => s.kind === "host_moved")) continue;
            const bad = new Set(a.signals.filter(failing).map((s) => s.view));
            for (const v of a.views) if (!bad.has(v)) verified.add(v);
          }
          let keptAny = false;
          for (const v of VIEWS) {
            const before = baseDiffs.find((d) => d.view === v)?.removed ?? [];
            const kept = before.filter(
              (p) =>
                !(
                  verified.has(v) &&
                  REQUIRED_PATHS_BY_VIEW[v].includes(p) &&
                  !found.has(`${v}|${p}`)
                ),
            );
            if (kept.length > 0) keptAny = true;
            const added = [
              ...new Set(
                signals
                  .filter((s) => s.view === v && s.kind !== "host_moved" && failing(s))
                  .map((s) => s.path),
              ),
            ].filter((p) => !kept.includes(p));
            expect(removedOf(row, v)).toEqual([...kept, ...added]);
            const softAdded = [
              ...new Set([
                ...(baseAdditive.find((d) => d.view === v)?.added ?? []),
                ...signals
                  .filter((s) => s.view === v && s.kind === "additive_key")
                  .map((s) => s.path),
              ]),
            ];
            const softEnums = [
              ...new Set([
                ...(baseAdditive.find((d) => d.view === v)?.enums ?? []),
                ...signals
                  .filter(
                    (s) =>
                      s.view === v &&
                      (s.kind === "unknown_enum_value" || s.kind === "meaning_changing_enum"),
                  )
                  .map((s) => `${s.path}=NEW`),
              ]),
            ];
            const soft = parseDiffs(row.additive_json).find((d) => d.view === v);
            expect(soft?.added ?? []).toEqual(softAdded);
            expect(soft?.enums ?? []).toEqual(softEnums);
          }
          const movedRun = answers.some(
            (a) => a.status === "host_moved" || a.signals.some((s) => s.kind === "host_moved"),
          );
          const goodRun = answers.some(
            (a) => (a.status === "green" || a.status === "additive") && !a.signals.some(failing),
          );
          const signalMoved = signals.some((s) => s.kind === "host_moved");
          const postMoved = signalMoved || (baseMoved && !(!movedRun && goodRun));
          const anyRemoved = parseDiffs(row.diff_json).some((d) => d.removed.length > 0);
          const anySoft = parseDiffs(row.additive_json).some(
            (d) => d.added.length > 0 || d.enums.length > 0,
          );
          const status = postMoved
            ? "host_moved"
            : anyRemoved
              ? "red"
              : anySoft
                ? "additive"
                : "green";
          expect(row.status).toBe(status);
          expect(row.host_moved_at === null).toBe(!postMoved);
          if (postMoved && baseMoved && !signalMoved)
            expect(row.host_moved_at).toBe(pre?.host_moved_at);
          // since: set exactly while the row is bad; kept across a run the drift outlived
          if (!isBad(status)) expect(row.since).toBeNull();
          else expect([pre?.since ?? null, T1]).toContain(row.since);
          if (pre !== null && isBad(pre.status) && keptAny) expect(row.since).toBe(pre.since);
          expect(row.last_probe_at).toBe(T1);
          expect(row.updated_at).toBe(T1);
          expect(row.manifest_hash).toBe(manifest?.hash ?? pre?.manifest_hash ?? null);
          const settingsLeft = removedOf(row, "mSettings").length > 0;
          expect(scoringRefusal(row) === null).toBe(!(isBad(status) && settingsLeft));
        },
      ),
      { numRuns: 400 },
    );
  });
});
