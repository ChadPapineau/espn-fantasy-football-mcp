// recovery.test.ts — how a drift_state row ENDS (Stage C findings drift-red-never-clears and
// drift-host-override-never-recovers; plan 01 §7, ADV OBJ-06; plan 03 §7; T-14): drift is a fact
// about the latest answer, so a later complete answer for a view clears that view's removed keys
// (every one after an in-call answer that passed the view schema, the required-key seed after a
// probe) and scoring is refused only while the drift is present; a good JSON answer from the
// CONFIGURED read host ends a host move whichever host moved — the operator override's recovery —
// in process and through the real provider pipeline; a newer manifest re-baselines the row and
// says so. No network, no cookie: injected fetches over the committed anonymised fixtures.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import {
  applyManifest,
  applyRecovered,
  applySignals,
  driftMetaFor,
  DriftStateWriter,
  parseDiffs,
  scoringRefusal,
  settingsDriftPath,
  statusOf,
  type Verification,
} from "../../src/drift/state.js";
import {
  REQUIRED_PATHS_BY_VIEW,
  type DriftSignal,
  type DriftStateRepository,
  type DriftStateRow,
  type ManifestIdentity,
} from "../../src/drift/types.js";
import type { EspnView } from "../../src/providers/espn/types.js";
import {
  jsonResponse,
  loadFixture,
  makeWorld,
  MemoryDrift,
  SEASON,
} from "../providers/espn/helpers.js";

const H = "lm-api-reads.fantasy.espn.com";
/** The operator override (plan 03 §3: `^[a-z0-9-]+\.fantasy\.espn\.com$`). */
const OVERRIDE = "lm-api-reads2.fantasy.espn.com";
const T0 = "2026-10-06T12:00:00.000Z";
const T1 = "2026-10-06T13:00:00.000Z";
const T2 = "2026-10-13T13:00:00.000Z";
const ACQ = "$.settings.acquisitionSettings";
/** A schema-level path (outside the required-key seed) a view schema reports. */
const DEEP = "$.settings.scoringSettings.scoringItems[].points";

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

describe("a later complete answer clears the drift (drift-red-never-clears)", () => {
  it("one incomplete mSettings&mNav answer, then a complete one: the refusal and meta.drift end", () => {
    const repo = new Repo();
    const w = new DriftStateWriter(repo, fixedClock(T0), H);
    const red = w.record([missing("mSettings", ACQ)]);
    expect(red?.status).toBe("red");
    expect(scoringRefusal(red)).toBe("settings_drift");
    expect(driftMetaFor(red, ["kona_player_info"])?.views).toEqual(["mSettings"]);
    // the provider's next answer for the same read passed the required keys and both schemas
    const back = w.recovered(["mSettings", "mNav"]);
    expect(back).toMatchObject({ status: "green", since: null, diff_json: "[]", host: H });
    expect(scoringRefusal(back)).toBeNull();
    expect(driftMetaFor(back, ["mSettings", "mNav"])).toBeNull();
    expect(driftMetaFor(back, ["kona_player_info"])).toBeNull();
    expect(repo.row).toBe(back);
    // the refusal names the key that was missing, and ends with it
    expect(settingsDriftPath(red)).toBe("settings.acquisitionSettings");
    expect(settingsDriftPath(back)).toBeNull();
  });
  it("only the verified views clear: another view's drift, its `since` and the additive list stay", () => {
    const r1 = applySignals(
      null,
      [missing("mRoster", "$.teams[].roster.entries"), additive("mTeam", "$.teams[].newKey")],
      H,
      T0,
    );
    const r2 = applySignals(r1, [missing("mSettings", ACQ)], H, T1);
    const back = applyRecovered(r2, H, T2, ["mSettings", "mNav"]);
    expect(back).toMatchObject({ status: "red", since: T0, updated_at: T2 });
    expect(parseDiffs(back.diff_json)).toEqual([
      { view: "mRoster", removed: ["$.teams[].roster.entries"], added: [], enums: [] },
    ]);
    expect(back.additive_json).toBe(r2.additive_json);
    expect(scoringRefusal(back)).toBeNull();
    expect(driftMetaFor(back, ["mRoster"])?.views).toEqual(["mRoster"]);
    expect(driftMetaFor(back, ["kona_player_info"])).toBeNull();
    // the additive list alone leaves the row `additive` once the last removed key clears
    expect(applyRecovered(back, H, T2, ["mRoster"])).toMatchObject({
      status: "additive",
      since: null,
      diff_json: "[]",
    });
  });
  it("a probe answer clears the required-key seed only; a schema-level key waits for an in-call answer", () => {
    const r = applySignals(null, [missing("mSettings", ACQ), missing("mSettings", DEEP)], H, T0);
    const probed = applyRecovered(r, H, T1, ["mSettings", "mNav", "mTeam"], "required_paths");
    expect(parseDiffs(probed.diff_json)).toEqual([
      { view: "mSettings", removed: [DEEP], added: [], enums: [] },
    ]);
    expect(probed).toMatchObject({ status: "red", since: T0 });
    expect(settingsDriftPath(probed)).toBe("settings.scoringSettings.scoringItems[].points");
    const parsed = applyRecovered(probed, H, T2, ["mSettings"], "schema");
    expect(parsed).toMatchObject({ status: "green", since: null, diff_json: "[]" });
    expect(scoringRefusal(parsed)).toBeNull();
  });
  it("a skeleton the probe recorded is cleared by the next green probe of that view", () => {
    const skeleton = REQUIRED_PATHS_BY_VIEW.mSettings.map((path): DriftSignal => ({
      kind: "skeleton",
      view: "mSettings",
      path,
      value: null,
    }));
    const r = applySignals(null, skeleton, H, T0);
    expect(parseDiffs(r.diff_json)[0]?.removed).toHaveLength(4);
    expect(applyRecovered(r, H, T1, ["mSettings"], "required_paths").status).toBe("green");
  });
  it("one answer that ends a host move and verifies the drifted view clears both", () => {
    const r = applySignals(null, [moved("mSettings"), missing("mSettings", ACQ)], H, T0);
    expect(r.status).toBe("host_moved");
    expect(applyRecovered(r, H, T1, ["mSettings"])).toMatchObject({
      status: "green",
      since: null,
      host_moved_at: null,
      diff_json: "[]",
    });
  });
  it("a red row that lost its `since` gets one when it stays red after a partial clear", () => {
    const r = applySignals(
      null,
      [missing("mSettings", ACQ), missing("mRoster", "$.teams[].roster.entries")],
      H,
      T0,
    );
    expect(applyRecovered({ ...r, since: null }, H, T1, ["mSettings"]).since).toBe(T1);
  });
  it("nothing to clear writes nothing: the same row comes back and the repository is not touched", () => {
    const repo = new Repo();
    const w = new DriftStateWriter(repo, fixedClock(T0), H);
    w.record([missing("mRoster", "$.teams[].roster.entries"), additive("mTeam", "$.teams[].x")]);
    const before = repo.row;
    const puts = repo.puts;
    expect(w.recovered(["mSettings", "mNav"])).toBe(before);
    expect(w.recovered()).toBe(before);
    expect(repo.puts).toBe(puts);
    // a schema-level key is not the probe's to clear: no write either
    w.record([missing("mSettings", DEEP)]);
    const p2 = repo.puts;
    expect(w.recovered(["mSettings"], "required_paths")).toBe(repo.row);
    expect(repo.puts).toBe(p2);
  });

  const VIEWS: readonly EspnView[] = ["mSettings", "mNav", "mTeam", "mRoster", "kona_player_info"];
  const signalArb: fc.Arbitrary<DriftSignal> = fc
    .record({
      view: fc.constantFrom(...VIEWS),
      kind: fc.constantFrom<DriftSignal["kind"]>(
        "missing_required_key",
        "skeleton",
        "additive_key",
        "unknown_enum_value",
        "host_moved",
      ),
      deep: fc.boolean(),
      pick: fc.nat(),
    })
    .map(({ view, kind, deep, pick }) => {
      const seed = REQUIRED_PATHS_BY_VIEW[view];
      const path = deep ? `$.deep${String(pick % 3)}.key` : (seed[pick % seed.length] ?? "$");
      return { kind, view, path, value: kind === "unknown_enum_value" ? "NEW" : null };
    });
  it("property: after a verified answer no clearable removed key of a verified view remains; every other list is untouched; the status is what remains", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(signalArb, { maxLength: 6 }), { minLength: 1, maxLength: 5 }),
        fc.subarray([...VIEWS]),
        fc.constantFrom<Verification>("schema", "required_paths"),
        (batches, verified, verification) => {
          let row: DriftStateRow | null = null;
          for (const b of batches) row = applySignals(row, b, H, T0);
          if (row === null) return;
          const after = applyRecovered(row, OVERRIDE, T1, verified, verification);
          const before = parseDiffs(row.diff_json);
          const now = parseDiffs(after.diff_json);
          for (const d of before) {
            const kept = now.find((x) => x.view === d.view)?.removed ?? [];
            const expected = verified.includes(d.view)
              ? verification === "schema"
                ? []
                : d.removed.filter((p) => !REQUIRED_PATHS_BY_VIEW[d.view].includes(p))
              : d.removed;
            expect(kept).toEqual(expected);
          }
          expect(after.additive_json).toBe(row.additive_json);
          expect(after.status).toBe(statusOf(false, now, parseDiffs(after.additive_json)));
          expect(after.host_moved_at).toBeNull();
          expect(scoringRefusal(after) === null).toBe(
            !now.some((d) => d.view === "mSettings" && d.removed.length > 0),
          );
          if (after === row) expect(row.status).not.toBe("host_moved");
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("the configured read host ends a host move (drift-host-override-never-recovers)", () => {
  it("a good answer from the override host clears a move recorded under the default host", () => {
    const m = applySignals(null, [moved("proTeamSchedules_wl")], H, T0);
    expect(m).toMatchObject({ status: "host_moved", host: H, host_moved_at: T0 });
    const back = applyRecovered(m, OVERRIDE, T1);
    expect(back).toMatchObject({
      status: "green",
      since: null,
      host: OVERRIDE,
      host_moved_at: null,
      updated_at: T1,
    });
    expect(driftMetaFor(back, ["mRoster"])).toBeNull();
  });
  it("the row names the host whose answer moved; other signals keep the recorded host", () => {
    const r = applySignals(null, [missing("mRoster", "$.teams[].roster.entries")], H, T0);
    const m = applySignals(r, [moved("mSettings")], OVERRIDE, T1);
    expect(m).toMatchObject({ status: "host_moved", host: OVERRIDE, host_moved_at: T1 });
    expect(applySignals(m, [missing("mTeam", "$.teams[].record")], H, T2).host).toBe(OVERRIDE);
    // a red row (no move) keeps its host when a view clears
    expect(applyRecovered(r, OVERRIDE, T1, ["mRoster"]).host).toBe(H);
  });
  it("writers of two processes share the row: the override process's good answer ends the move", () => {
    const repo = new Repo();
    const clock = fixedClock(T0);
    new DriftStateWriter(repo, clock, H).record([moved("mSettings")]);
    expect(repo.row?.status).toBe("host_moved");
    const back = new DriftStateWriter(repo, clock, OVERRIDE).recovered();
    expect(back).toMatchObject({ status: "green", host: OVERRIDE, host_moved_at: null });
    expect(repo.row).toBe(back);
  });
  it("through the provider: the default host's 302 sets host_moved; the override host's good JSON ends it", async () => {
    const drift = new MemoryDrift();
    const a = makeWorld({
      drift,
      fetch: () =>
        Promise.resolve(
          new Response("", { status: 302, headers: { location: "https://www.espn.com/fantasy/" } }),
        ),
    });
    await expect(a.provider.getProSchedule(SEASON)).rejects.toMatchObject({
      effCode: "ESPN_HOST_MOVED",
    });
    expect(drift.row).toMatchObject({ status: "host_moved", host: H });
    const hosts: string[] = [];
    const b = makeWorld({
      drift,
      clock: a.clock,
      fetch: (url) => {
        hosts.push(new URL(url).hostname);
        return Promise.resolve(
          jsonResponse(loadFixture("recorded/season/proTeamSchedules_wl.json")),
        );
      },
      over: {
        config: {
          leagueId: "0",
          season: SEASON,
          teamId: null,
          espnReadHost: OVERRIDE,
          fixtureRecord: false,
        },
      },
    });
    b.clock.advance(6 * 60_000);
    const r = await b.provider.getProSchedule(SEASON);
    expect(hosts).toEqual([OVERRIDE]);
    expect(r.stamp.drift).toBeNull();
    expect(drift.row).toMatchObject({ status: "green", host: OVERRIDE, host_moved_at: null });
  });
});

describe("a newer manifest re-baselines the row (plan 03 §7)", () => {
  const A: ManifestIdentity = { hash: "a".repeat(64), version: 1 };
  const B: ManifestIdentity = { hash: "b".repeat(64), version: 1 };
  const red = applySignals(
    null,
    [missing("mSettings", ACQ), additive("mTeam", "$.teams[].newKey")],
    H,
    T0,
  );
  it("no row yet: a green row that records the manifest, nothing to discard", () => {
    expect(applyManifest(null, A, H, T0)).toEqual({
      row: expect.objectContaining({
        status: "green",
        manifest_hash: A.hash,
        manifest_version: 1,
        host: H,
        diff_json: "[]",
      }) as unknown,
      rebaselined: false,
    });
  });
  it("a row written before any probe records the manifest and keeps its drift (never dropped on doubt)", () => {
    const out = applyManifest(red, A, H, T1);
    expect(out.rebaselined).toBe(false);
    expect(out.row).toMatchObject({
      status: "red",
      since: T0,
      manifest_hash: A.hash,
      manifest_version: 1,
      diff_json: red.diff_json,
      additive_json: red.additive_json,
      updated_at: T1,
    });
    // the same manifest again: the same row, no change
    expect(applyManifest(out.row, A, H, T2).row).toBe(out.row);
  });
  it("another manifest (hash or version) discards the diff computed against the old one and says so", () => {
    const stamped = applyManifest(red, A, H, T1).row;
    const out = applyManifest(stamped, B, H, T2);
    expect(out.rebaselined).toBe(true);
    expect(out.row).toMatchObject({
      status: "green",
      since: null,
      manifest_hash: B.hash,
      diff_json: "[]",
      additive_json: "[]",
      updated_at: T2,
    });
    expect(scoringRefusal(out.row)).toBeNull();
    expect(applyManifest(stamped, { hash: A.hash, version: 2 }, H, T2)).toMatchObject({
      rebaselined: true,
      row: { manifest_version: 2, status: "green" },
    });
  });
  it("a host move is not a manifest fact: it survives the re-baseline (a good answer ends it)", () => {
    const m = applyManifest(applySignals(red, [moved("mSettings")], H, T1), A, H, T1).row;
    const out = applyManifest(m, B, H, T2);
    expect(out.rebaselined).toBe(true);
    expect(out.row).toMatchObject({
      status: "host_moved",
      since: T0,
      host_moved_at: T1,
      diff_json: "[]",
    });
  });
  it("the writer stores the outcome only when it changed", () => {
    const repo = new Repo();
    const w = new DriftStateWriter(repo, fixedClock(T0), H);
    expect(w.rebaseline(A)).toMatchObject({ rebaselined: false, row: { manifest_hash: A.hash } });
    expect(repo.puts).toBe(1);
    expect(w.rebaseline(A).row).toBe(repo.row);
    expect(repo.puts).toBe(1);
    w.record([missing("mSettings", ACQ)]);
    expect(w.rebaseline(B)).toMatchObject({ rebaselined: true, row: { status: "green" } });
    expect(repo.row?.manifest_hash).toBe(B.hash);
  });
});
