// reader-warnings.test.ts — one warning per code per dataset read (src/store/datasets/readers.ts
// createWarningTally; StoreOpenOptions.onWarning). Stage C, store-dataset-row-skip-log-flood: a P1
// call that read the whole player universe wrote one `store.warning dataset_row_skipped_position`
// line per skipped row — 835 warn lines in one session. A read now reports each code once, with the
// count of rows it covers; nested reads report with the outermost; a throwing read still reports
// and leaves the tally balanced; a warning raised outside a read passes through with count 1.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWarningTally } from "../../src/store/datasets/readers.js";
import { DS_STATS_PLAYER_WEEK } from "../../src/store/datasets/tables.js";
import type { DatasetPublisher, Store, StoreWarningDetail } from "../../src/store/types.js";
import { publishTables, row, SEASON, statsTables } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

type Call = readonly [code: string, count: number | undefined];

describe("createWarningTally", () => {
  it("inside a read: one sink call per code, with its count, when the outermost read returns", () => {
    const calls: Call[] = [];
    const tally = createWarningTally((c, d) => calls.push([c, d.count]));
    const inner = tally.scoped((n: number) => {
      for (let i = 0; i < n; i++) tally.warn("b");
      return n;
    });
    const outer = tally.scoped((n: number) => {
      const before = calls.length;
      for (let i = 0; i < n; i++) tally.warn("a");
      const got = inner(2) + n;
      expect(calls.length).toBe(before); // nothing reaches the sink mid-read, nested reads included
      return got;
    });
    expect(outer(300)).toBe(302);
    expect(calls).toEqual([
      ["a", 300],
      ["b", 2],
    ]);
    // the next read starts from zero
    outer(1);
    expect(calls.slice(2)).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("outside a read a warning passes straight through with count 1", () => {
    const calls: Call[] = [];
    const tally = createWarningTally((c, d) => calls.push([c, d.count]));
    tally.warn("x");
    tally.warn("x");
    expect(calls).toEqual([
      ["x", 1],
      ["x", 1],
    ]);
  });

  it("a read that throws still reports what it counted, rethrows, and leaves the tally balanced", () => {
    const calls: Call[] = [];
    const tally = createWarningTally((c, d) => calls.push([c, d.count]));
    const bad = tally.scoped(() => {
      tally.warn("a");
      tally.warn("a");
      throw new RangeError("store: bad season");
    });
    expect(() => bad()).toThrow(RangeError);
    expect(calls).toEqual([["a", 2]]);
    tally.warn("after"); // depth back to 0: passes through at once
    expect(calls).toEqual([
      ["a", 2],
      ["after", 1],
    ]);
  });

  it("a throwing sink never breaks a read, and every other code is still reported", () => {
    const seen: string[] = [];
    const tally = createWarningTally((c) => {
      seen.push(c);
      throw new Error("sink down");
    });
    const read = tally.scoped(() => {
      tally.warn("a");
      tally.warn("b");
      return "rows";
    });
    expect(read()).toBe("rows");
    expect(seen).toEqual(["a", "b"]);
    expect(() => {
      tally.warn("c");
    }).not.toThrow();
  });
});

describe("the store's dataset reads (onWarning)", () => {
  /** Offensive-line players: rows the scoring translator has no fantasy position for. */
  const OL_ROWS = 300;
  const olIds = Array.from({ length: OL_ROWS }, (_, i) => `00-98${String(i).padStart(5, "0")}`);
  let t: TempCache;
  let pub: DatasetPublisher;
  let s: Store;
  let calls: { code: string; detail: StoreWarningDetail | undefined }[];

  beforeEach(async () => {
    t = tempCache();
    pub = openPublisher(t);
    const [players, defense] = statsTables();
    const ol = olIds.map((id) =>
      row(DS_STATS_PLAYER_WEEK, {
        player_id: id,
        position: "T",
        position_group: "OL",
        season: SEASON,
        week: 1,
        season_type: "REG",
        team: "BUF",
      }),
    );
    await publishTables(pub, "nflverse:stats_player_week", "st-ol", [
      { spec: players!.spec, rows: [...players!.rows, ...ol] },
      defense!,
    ]);
    calls = [];
    s = openStore(t, { onWarning: (code, detail) => calls.push({ code, detail }) });
  });
  afterEach(() => {
    s.close();
    pub.close();
    t.cleanup();
  });

  it("a read that skips 300 rows writes ONE warning with count 300, not 300 warnings", () => {
    const res = s.datasets.playerWeeks.lines(olIds, SEASON, [1], { usage: false });
    expect(res.rows).toEqual([]);
    expect(res.stamp?.file_version).toBe("st-ol");
    expect(calls).toEqual([{ code: "dataset_row_skipped_position", detail: { count: OL_ROWS } }]);
  });

  it("each read is its own summary; a read with nothing skipped writes none", () => {
    s.datasets.playerWeeks.lines(olIds.slice(0, 10), SEASON, [1], { usage: false });
    s.datasets.playerWeeks.lines(olIds.slice(10, 15), SEASON, [1]);
    expect(calls).toEqual([
      { code: "dataset_row_skipped_position", detail: { count: 10 } },
      { code: "dataset_row_skipped_position", detail: { count: 5 } },
    ]);
    calls.length = 0;
    s.datasets.playerWeeks.lines(["00-9000001"], SEASON, [1]);
    expect(calls).toEqual([]);
  });

  it("a read refused for its arguments leaves the next read's summary intact", () => {
    expect(() => s.datasets.playerWeeks.lines(olIds, 1800, [1])).toThrow(RangeError);
    s.datasets.playerWeeks.lines(olIds.slice(0, 3), SEASON, [1]);
    expect(calls).toEqual([{ code: "dataset_row_skipped_position", detail: { count: 3 } }]);
  });
});
