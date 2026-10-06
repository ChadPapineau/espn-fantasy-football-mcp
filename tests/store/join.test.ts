// join.test.ts — the on-demand join connection (plan 01 §5.5, ADV OBJ-22): read-only attachments of
// published dataset files on a short-lived connection, the ceiling of 8 asserted in code — a 9th
// attachment is refused, both through the API and from inside `fn` — writes refused, unservable files
// skipped, the connection always closed; plus the read-only URI encoding.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATASET_SOURCE_IDS } from "../../src/config/freshness.js";
import {
  JoinCeilingError,
  joinSchemaName,
  readOnlyUri,
  withDatasetJoin,
} from "../../src/store/datasets/join.js";
import {
  MAX_ON_DEMAND_ATTACHMENTS,
  SQLITE_ATTACH_LIMIT,
  type DatasetPublisher,
} from "../../src/store/types.js";
import {
  emptyTables,
  injuriesTables,
  publishTables,
  rosterWeeklyTables,
} from "./helpers/datasets.js";
import { openPublisher, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let pub: DatasetPublisher;
beforeEach(() => {
  t = tempCache();
  pub = openPublisher(t);
});
afterEach(() => {
  pub.close();
  t.cleanup();
});

describe("withDatasetJoin", () => {
  it("joins two files in one statement on a read-only, short-lived connection", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    await publishTables(pub, "nflverse:roster_weekly", "v1", rosterWeeklyTables());
    const out = withDatasetJoin(
      t.datasetDir,
      ["nflverse:injuries", "nflverse:roster_weekly"],
      (db) =>
        db
          .prepare(
            `SELECT DISTINCT i.gsis_id, r.full_name FROM "${joinSchemaName("nflverse:injuries")}".ds_injuries AS i
           JOIN "${joinSchemaName("nflverse:roster_weekly")}".ds_roster_weekly AS r ON r.gsis_id = i.gsis_id
           ORDER BY i.gsis_id`,
          )
          .all(),
    );
    expect(out.attached).toEqual(["nflverse:injuries", "nflverse:roster_weekly"]);
    expect(out.skipped).toEqual([]);
    expect(out.value).toHaveLength(3);
  });

  it("refuses writes and further ATTACH from inside fn; the connection is closed afterwards", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    let leaked: { prepare(sql: string): unknown } | null = null;
    withDatasetJoin(t.datasetDir, ["nflverse:injuries"], (db) => {
      leaked = db;
      const schema = joinSchemaName("nflverse:injuries");
      expect(() => {
        db.exec(`DELETE FROM "${schema}".ds_injuries`);
      }).toThrow();
      expect(() => {
        db.exec("CREATE TABLE scratch (x INTEGER)");
      }).toThrow();
      expect(() => {
        db.exec("ATTACH DATABASE ':memory:' AS ninth");
      }).toThrow(/not authorized/);
      expect(() => {
        db.exec(`DETACH DATABASE "${schema}"`);
      }).toThrow(/not authorized/);
    });
    expect(() => leaked?.prepare("SELECT 1")).toThrow();
  });

  it("the ceiling: 8 attach; a 9th source is refused before anything is attached", async () => {
    expect(MAX_ON_DEMAND_ATTACHMENTS).toBe(8);
    expect(MAX_ON_DEMAND_ATTACHMENTS).toBeLessThan(SQLITE_ATTACH_LIMIT);
    const nine = DATASET_SOURCE_IDS.slice(0, 9);
    for (const s of nine) await publishTables(pub, s, "v1", emptyTables(s));
    const eight = withDatasetJoin(
      t.datasetDir,
      nine.slice(0, 8),
      (db) => (db.prepare("PRAGMA database_list").all() as { name: string }[]).length,
    );
    expect(eight.attached).toHaveLength(8);
    expect(eight.value).toBe(9); // main + 8
    let called = false;
    expect(() =>
      withDatasetJoin(t.datasetDir, nine, () => {
        called = true;
      }),
    ).toThrow(JoinCeilingError);
    expect(called).toBe(false);
    // duplicates count once
    expect(
      withDatasetJoin(t.datasetDir, [...nine.slice(0, 8), nine[0]!], () => 1).attached,
    ).toHaveLength(8);
  });

  it("skips sources with no file or an unservable file; refuses unknown sources", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${t.datasetDir}/nflverse__players.sqlite`, "not sqlite at all".repeat(100));
    const out = withDatasetJoin(t.datasetDir, ["nflverse:injuries", "nflverse:schedules"], () => 0);
    expect(out).toMatchObject({ attached: ["nflverse:injuries"], skipped: ["nflverse:schedules"] });
    expect(withDatasetJoin(t.datasetDir, ["nflverse:players"], () => 0)).toMatchObject({
      attached: [],
      skipped: ["nflverse:players"],
    });
    expect(() => withDatasetJoin(t.datasetDir, ["nope:x" as never], () => 0)).toThrow(
      /unknown dataset source/,
    );
  });
});

describe("readOnlyUri", () => {
  it("percent-encodes every path segment so ?, # and % cannot change the URI", () => {
    expect(readOnlyUri("/a b/c?d#e%f/ü.sqlite")).toBe(
      "file:/a%20b/c%3Fd%23e%25f/%C3%BC.sqlite?mode=ro",
    );
  });
});
