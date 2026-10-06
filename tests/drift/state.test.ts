// state.test.ts — src/drift/state.ts (plan 01 §7: in-call drift writes drift_state, never the cache;
// a host move sets host_moved_at and the host_moved status; meta.drift on results from affected
// views — every view when mSettings drifts or the host moved; T-14: settings drift refuses to score,
// a golden mismatch is never recorded here). 100 % (plan 05 §7).
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import {
  applyHostRecovered,
  applySignals,
  driftMetaFor,
  DriftStateWriter,
  LEAGUE_WIDE_DRIFT_VIEWS,
  MAX_DIFF_PATHS,
  parseDiffs,
  scoringRefusal,
  statusOf,
} from "../../src/drift/state.js";
import type { DriftSignal, DriftStateRepository, DriftStateRow } from "../../src/drift/types.js";

const H = "lm-api-reads.fantasy.espn.com";
const T0 = "2026-10-06T12:00:00.000Z";
const T1 = "2026-10-06T13:00:00.000Z";
const missing = (view: DriftSignal["view"], path: string): DriftSignal => ({
  kind: "missing_required_key",
  view,
  path,
  value: null,
});

class Repo implements DriftStateRepository {
  row: DriftStateRow | null = null;
  get() {
    return this.row;
  }
  put(r: DriftStateRow) {
    this.row = r;
  }
}

describe("parseDiffs", () => {
  it("keeps well-formed ViewDiffs; drops malformed entries and bad paths; never throws", () => {
    expect(parseDiffs("not json")).toEqual([]);
    expect(parseDiffs('{"a":1}')).toEqual([]);
    expect(
      parseDiffs(
        JSON.stringify([
          null,
          { view: "nope", removed: [] },
          {
            view: "mRoster",
            removed: ["$.teams[].roster", "$.teams[].roster", "bad path!", 5],
            added: "x",
            enums: [],
          },
        ]),
      ),
    ).toEqual([{ view: "mRoster", removed: ["$.teams[].roster"], added: [], enums: [] }]);
    const many = Array.from({ length: MAX_DIFF_PATHS + 5 }, (_, i) => `$.k${String(i)}`);
    expect(
      parseDiffs(JSON.stringify([{ view: "mTeam", removed: many, added: [], enums: [] }]))[0]
        ?.removed,
    ).toHaveLength(MAX_DIFF_PATHS);
  });
});

describe("statusOf / applySignals", () => {
  it("status precedence: host moved > removed > added or enum > green", () => {
    const d = (o: object) => ({ view: "mTeam" as const, removed: [], added: [], enums: [], ...o });
    expect(statusOf(true, [], [])).toBe("host_moved");
    expect(statusOf(false, [d({ removed: ["x"] })], [])).toBe("red");
    expect(statusOf(false, [], [d({ added: ["x"] })])).toBe("additive");
    expect(statusOf(false, [], [d({ enums: ["x=Y"] })])).toBe("additive");
    expect(statusOf(false, [d({})], [d({})])).toBe("green");
  });
  it("a failing signal turns a fresh row red with `since`; the diff names view and path; merges dedupe", () => {
    const r1 = applySignals(null, [missing("mRoster", "$.teams[].roster.entries")], H, T0);
    expect(r1).toMatchObject({
      status: "red",
      since: T0,
      host: H,
      host_moved_at: null,
      updated_at: T0,
    });
    expect(parseDiffs(r1.diff_json)).toEqual([
      { view: "mRoster", removed: ["$.teams[].roster.entries"], added: [], enums: [] },
    ]);
    const r2 = applySignals(
      r1,
      [missing("mRoster", "$.teams[].roster.entries"), missing("mTeam", "$.teams[].waiverRank")],
      H,
      T1,
    );
    expect(r2.since).toBe(T0);
    expect(parseDiffs(r2.diff_json).map((d) => d.view)).toEqual(["mRoster", "mTeam"]);
  });
  it("a red row without `since` gets one on the next failing signal", () => {
    const r1 = applySignals(null, [missing("mRoster", "$.teams[].roster.entries")], H, T0);
    const r2 = applySignals(
      { ...r1, since: null },
      [missing("mTeam", "$.teams[].waiverRank")],
      H,
      T1,
    );
    expect(r2.since).toBe(T1);
  });
  it("soft signals go to additive (enum as path=value; unknown value as ?); status additive", () => {
    const r = applySignals(
      null,
      [
        { kind: "additive_key", view: "mTeam", path: "$.teams[].newKey", value: null },
        {
          kind: "unknown_enum_value",
          view: "mTeam",
          path: "$.teams[].playoffClinchType",
          value: "NEW",
        },
        { kind: "meaning_changing_enum", view: "mBoxscore", path: "$.x.statSourceId", value: null },
      ],
      H,
      T0,
    );
    expect(r.status).toBe("additive");
    expect(r.since).toBeNull();
    expect(parseDiffs(r.additive_json)).toEqual([
      {
        view: "mTeam",
        removed: [],
        added: ["$.teams[].newKey"],
        enums: ["$.teams[].playoffClinchType=NEW"],
      },
      { view: "mBoxscore", removed: [], added: [], enums: ["$.x.statSourceId=?"] },
    ]);
  });
  it("a host move sets host_moved and keeps the first host_moved_at; recovery restores the diff status", () => {
    const moved = applySignals(
      null,
      [{ kind: "host_moved", view: "mSettings", path: "$", value: null }],
      H,
      T0,
    );
    expect(moved).toMatchObject({ status: "host_moved", host_moved_at: T0, since: T0 });
    const again = applySignals(moved, [missing("mRoster", "$.teams[].roster.entries")], H, T1);
    expect(again).toMatchObject({ status: "host_moved", host_moved_at: T0, since: T0 });
    const back = applyHostRecovered(again, H, T1);
    expect(back).toMatchObject({ status: "red", host_moved_at: null, since: T0 });
    const clean = applyHostRecovered(moved, H, T1);
    expect(clean).toMatchObject({ status: "green", since: null, host_moved_at: null });
    expect(applyHostRecovered(moved, "other.fantasy.espn.com", T1)).toBe(moved);
    expect(applyHostRecovered(back, H, T1)).toBe(back);
  });
});

describe("DriftStateWriter", () => {
  it("records, skips empty lists, recovers, and reads the row", () => {
    const repo = new Repo();
    const w = new DriftStateWriter(repo, fixedClock(T0), H);
    expect(w.record([])).toBeNull();
    expect(w.recovered()).toBeNull();
    const r = w.record([{ kind: "host_moved", view: "mRoster", path: "$", value: null }]);
    expect(r?.status).toBe("host_moved");
    expect(w.current()).toBe(repo.row);
    expect(w.recovered()?.status).toBe("green");
    const same = w.recovered();
    expect(same).toBe(repo.row);
  });
});

describe("meta.drift and the scoring refusal", () => {
  const red = applySignals(null, [missing("mRoster", "$.teams[].roster.entries")], H, T0);
  const settingsRed = applySignals(
    null,
    [missing("mSettings", "$.settings.scoringSettings")],
    H,
    T0,
  );
  it("names the affected views only while red or host-moved", () => {
    expect(driftMetaFor(null, ["mRoster"])).toBeNull();
    expect(driftMetaFor(red, ["mRoster"])).toEqual({
      views: ["mRoster"],
      since: T0,
      detail: "espn_get_status",
    });
    expect(driftMetaFor(red, ["mTeam"])).toBeNull();
    expect(driftMetaFor({ ...red, status: "additive" }, ["mRoster"])).toBeNull();
    expect(driftMetaFor({ ...red, since: null }, ["mRoster"])?.since).toBe(red.updated_at);
  });
  it("mSettings drift is league-wide; a host move affects every view", () => {
    expect(LEAGUE_WIDE_DRIFT_VIEWS).toEqual(["mSettings"]);
    expect(driftMetaFor(settingsRed, ["kona_player_info"])?.views).toEqual(["mSettings"]);
    const moved = applySignals(
      null,
      [{ kind: "host_moved", view: "mSettings", path: "$", value: null }],
      H,
      T0,
    );
    expect(driftMetaFor(moved, ["mTeam", "mStandings"])?.views).toEqual(["mTeam", "mStandings"]);
  });
  it("scoringRefusal: settings drift refuses; other drift, additive, a mismatch-free row do not", () => {
    expect(scoringRefusal(settingsRed)).toBe("settings_drift");
    expect(scoringRefusal({ ...settingsRed, status: "host_moved" })).toBe("settings_drift");
    expect(scoringRefusal(red)).toBeNull();
    expect(scoringRefusal({ ...settingsRed, status: "additive" })).toBeNull();
    expect(scoringRefusal(null)).toBeNull();
  });
});
