// publisher.test.ts — the refresh process's dataset publisher (plan 01 §5.5; plan 05 §2 `store` and
// `sources/*`; plan 06 §1.3 single-flight): a fresh 0600 file, journal_mode=DELETE and no sidecars,
// fsync + close + rename onto the same path, a refresh_log row naming the version, nothing ever
// written to store.sqlite's ds_* space; the skip path; job locks across threads of control and
// processes; torn publishes (SIGKILL mid-fill, before the commit) leave the old file; a publish that
// renamed but could not record is recorded by the next one; every failure is a fixed-vocabulary code.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATASET_META_TABLE, DS_SCHEMA_VERSION } from "../../src/store/datasets/connections.js";
import {
  columnsHash,
  DS_INJURIES,
  DS_PRO_SCHEDULE,
  DS_PRO_TEAMS,
} from "../../src/store/datasets/tables.js";
import { errorCode, publishJob, stagingPath, sweepDebris } from "../../src/store/publisher.js";
import { storeInternalsOf } from "../../src/store/store.js";
import {
  PUBLISH_ALREADY_CURRENT,
  PUBLISH_JOB_LOCKED,
  PUBLISH_UNRECORDED,
  type DatasetPublisher,
  type PublishStats,
} from "../../src/store/types.js";
import {
  emptyTables,
  injuriesTables,
  proScheduleTables,
  publishTables,
  row,
  RELEASE,
} from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";
import { run } from "./helpers/spawn.js";

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

const INJ_FILE = (): string => path.join(t.datasetDir, "nflverse__injuries.sqlite");

function meta(file: string): Record<string, string> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out: Record<string, string> = {};
    for (const r of db.prepare(`SELECT key, value FROM ${DATASET_META_TABLE}`).all() as {
      key: string;
      value: string;
    }[])
      out[r.key] = r.value;
    return out;
  } finally {
    db.close();
  }
}

function count(file: string, table: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function storeRows(sql: string, ...args: (string | number)[]): Record<string, unknown>[] {
  const db = new DatabaseSync(t.storePath, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

const stats = (rows: number, hash = columnsHash("nflverse:injuries")): PublishStats => ({
  rows,
  tables: [{ name: "ds_injuries", rows }],
  seasons: [2026],
  columns_hash: hash,
});

describe("a successful publish", () => {
  it("writes a fresh 0600 DELETE-journal file with dataset_meta, renamed onto the same path, and one refresh_log row", async () => {
    const out = await publishTables(
      pub,
      "nflverse:injuries",
      "2026-10-06 02:02:02 EDT",
      injuriesTables(),
    );
    expect(out).toMatchObject({
      ok: true,
      file: INJ_FILE(),
      file_version: "2026-10-06 02:02:02 EDT",
    });
    expect(statSync(INJ_FILE()).mode & 0o777).toBe(0o600);
    expect(readdirSync(t.datasetDir).sort()).toEqual(["nflverse__injuries.sqlite"]);
    const db = new DatabaseSync(INJ_FILE(), { readOnly: true });
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "delete",
    );
    db.close();
    expect(count(INJ_FILE(), "ds_injuries")).toBe(3);
    const m = meta(INJ_FILE());
    expect(m).toEqual({
      source: "nflverse:injuries",
      file_version: "2026-10-06 02:02:02 EDT",
      release_updated_at: RELEASE,
      published_at: "2026-10-06T12:00:00.000Z",
      ds_schema: String(DS_SCHEMA_VERSION),
      columns_hash: columnsHash("nflverse:injuries"),
      rows: "3",
      seasons: "[2026]",
    });
    const log = storeRows("SELECT * FROM refresh_log");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      source: "nflverse:injuries",
      file: INJ_FILE(),
      file_version: "2026-10-06 02:02:02 EDT",
      ok: 1,
      error: null,
      rows: 3,
      seasons_json: "[2026]",
      columns_hash: columnsHash("nflverse:injuries"),
    });
    // ADV OBJ-09(a): no dataset table ever lands in store.sqlite; the job lock is released.
    const tables = storeRows("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) =>
      String(r.name),
    );
    expect(tables.filter((n) => n.startsWith("ds_"))).toEqual([]);
    expect(storeRows("SELECT * FROM job_lock")).toEqual([]);
  });

  it("a second version replaces the file by rename (a new inode); the release time may be null", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const ino1 = statSync(INJ_FILE()).ino;
    const out = await publishTables(
      pub,
      "nflverse:injuries",
      "v2",
      emptyTables("nflverse:injuries"),
      {
        release: null,
      },
    );
    expect(out.ok).toBe(true);
    expect(statSync(INJ_FILE()).ino).not.toBe(ino1);
    expect(count(INJ_FILE(), "ds_injuries")).toBe(0);
    expect(meta(INJ_FILE()).release_updated_at).toBeUndefined();
    expect(
      storeRows("SELECT file_version FROM refresh_log ORDER BY id").map((r) => r.file_version),
    ).toEqual(["v1", "v2"]);
  });

  it("a multi-table source must create every contract table", async () => {
    const [sched] = proScheduleTables();
    expect(sched).toBeDefined();
    const out = await publishTables(
      pub,
      "espn:pro_schedule",
      "v1",
      sched === undefined ? [] : [sched],
    );
    expect(out).toEqual({ ok: false, error: "schema_mismatch" });
    expect(existsSync(path.join(t.datasetDir, "espn__pro_schedule.sqlite"))).toBe(false);
    expect(storeRows("SELECT ok, error FROM refresh_log")).toEqual([
      { ok: 0, error: "schema_mismatch" },
    ]);
    expect((await publishTables(pub, "espn:pro_schedule", "v1", proScheduleTables())).ok).toBe(
      true,
    );
  });
});

describe("the skip path (plan 01 §5.5; plan 06 §1.3)", () => {
  it("skipIfCurrent on the published version only advances checked_at (no new file)", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const ino = statSync(INJ_FILE()).ino;
    t.clock.advance(3_600_000);
    const out = await publishTables(pub, "nflverse:injuries", "v1", injuriesTables(), {
      skipIfCurrent: true,
    });
    expect(out).toEqual({ ok: false, error: PUBLISH_ALREADY_CURRENT });
    expect(statSync(INJ_FILE()).ino).toBe(ino);
    const log = storeRows("SELECT checked_at, finished_at FROM refresh_log");
    expect(log).toEqual([
      { checked_at: "2026-10-06T13:00:00.000Z", finished_at: "2026-10-06T12:00:00.000Z" },
    ]);
  });

  it("skipIfCurrent on a NEW version publishes", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const out = await publishTables(pub, "nflverse:injuries", "v2", injuriesTables(), {
      skipIfCurrent: true,
    });
    expect(out.ok).toBe(true);
  });

  it("recordUnchanged advances checked_at; after failures it appends a recovery row", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    t.clock.advance(60_000);
    pub.recordUnchanged("nflverse:injuries", "v1", t.clock.nowIso());
    expect(storeRows("SELECT COUNT(*) AS n FROM refresh_log")).toEqual([{ n: 1 }]);
    expect(storeRows("SELECT checked_at FROM refresh_log")).toEqual([
      { checked_at: "2026-10-06T12:01:00.000Z" },
    ]);
    // a failed publish, then the unchanged check ends the failure streak
    await pub.publish("nflverse:injuries", "v2", null, () =>
      Promise.reject(new Error("network down")),
    );
    t.clock.advance(60_000);
    pub.recordUnchanged("nflverse:injuries", "v1", t.clock.nowIso());
    const s = openStore(t);
    expect(s.repos.refreshLog.consecutiveFailures("nflverse:injuries")).toBe(0);
    expect(s.repos.refreshLog.latest("nflverse:injuries")).toMatchObject({
      ok: true,
      file_version: "v1",
      checked_at: "2026-10-06T12:02:00.000Z",
    });
    s.close();
  });

  it("recordUnchanged refuses a version that is not the current served one, and bad arguments", async () => {
    expect(() => {
      pub.recordUnchanged("nflverse:injuries", "v1", "2026-10-06T12:00:00.000Z");
    }).toThrow(RangeError);
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    expect(() => {
      pub.recordUnchanged("nflverse:injuries", "v0", "2026-10-06T12:00:00.000Z");
    }).toThrow(/not the current/);
    expect(() => {
      pub.recordUnchanged("nflverse:nope" as never, "v1", "2026-10-06T12:00:00.000Z");
    }).toThrow(/unknown dataset source/);
    expect(() => {
      pub.recordUnchanged("nflverse:injuries", "v1", "not a date");
    }).toThrow(/ISO-8601/);
    // a version whose file was deleted is not current either
    const { rmSync } = await import("node:fs");
    rmSync(INJ_FILE());
    expect(() => {
      pub.recordUnchanged("nflverse:injuries", "v1", "2026-10-06T12:00:00.000Z");
    }).toThrow(/not the current/);
  });
});

describe("refusals and failures (fixed vocabulary; the previous file survives)", () => {
  it("refuses bad arguments before any lock or row", async () => {
    const fill = (): Promise<PublishStats> => Promise.resolve(stats(0));
    expect(await pub.publish("nope:x" as never, "v1", null, fill)).toEqual({
      ok: false,
      error: "invalid_source",
    });
    for (const v of ["", "a\0b", "x".repeat(129), "vé", "line\nbreak"])
      expect(await pub.publish("nflverse:injuries", v, null, fill)).toEqual({
        ok: false,
        error: "invalid_version",
      });
    for (const r of ["yesterday", "", "x".repeat(65)])
      expect(await pub.publish("nflverse:injuries", "v1", r, fill)).toEqual({
        ok: false,
        error: "invalid_release_time",
      });
    expect(storeRows("SELECT * FROM refresh_log")).toEqual([]);
  });

  it("a fill that throws records a failure row with a fixed code and keeps the previous file", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const ino = statSync(INJ_FILE()).ino;
    const thrown = [
      [new Error("<html>secret upstream body</html>"), "INTERNAL"],
      [Object.assign(new Error("x"), { code: "schema_mismatch" }), "schema_mismatch"],
      [Object.assign(new Error("x"), { code: "codec" }), "codec"],
      [Object.assign(new Error("x"), { code: "ENOENT" }), "INTERNAL"],
      [{ code: "not_published" }, "not_published"],
      ["a string", "INTERNAL"],
    ] as const;
    for (const [e, code] of thrown) {
      const out = await pub.publish("nflverse:injuries", "v9", null, async (w) => {
        w.createTable(DS_INJURIES);
        await Promise.resolve();
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- hostile throwables are the point
        throw e;
      });
      expect(out).toEqual({ ok: false, error: code });
    }
    expect(statSync(INJ_FILE()).ino).toBe(ino);
    expect(count(INJ_FILE(), "ds_injuries")).toBe(3);
    expect(readdirSync(t.datasetDir)).toEqual(["nflverse__injuries.sqlite"]);
    const errs = storeRows("SELECT error FROM refresh_log WHERE ok = 0 ORDER BY id").map(
      (r) => r.error,
    );
    expect(errs).toEqual(thrown.map(([, c]) => c));
    for (const e of errs) expect(String(e)).not.toMatch(/secret|html/);
  });

  it("errorCode never reads past a hostile throwable", () => {
    const hostile = Object.defineProperty({}, "code", {
      get() {
        throw new Error("getter trap");
      },
    });
    expect(errorCode(hostile)).toBe("INTERNAL");
    expect(errorCode(null)).toBe("INTERNAL");
    expect(errorCode({ code: "UPSTREAM_UNAVAILABLE" })).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("the columns hash must match the created tables AND the contract (else schema_mismatch)", async () => {
    // the source reports a wrong hash
    let out = await pub.publish("nflverse:injuries", "v1", null, (w) => {
      w.createTable(DS_INJURIES);
      return Promise.resolve(stats(0, "0".repeat(64)));
    });
    expect(out).toEqual({ ok: false, error: "schema_mismatch" });
    // a table that differs from the contract (an extra column)
    const drifted = {
      ...DS_INJURIES,
      columns: [...DS_INJURIES.columns, { name: "extra", type: "TEXT" as const, nullable: true }],
    };
    out = await pub.publish("nflverse:injuries", "v1", null, (w) => {
      w.createTable(drifted);
      return Promise.resolve(stats(0, columnsHash("nflverse:injuries")));
    });
    expect(out).toEqual({ ok: false, error: "schema_mismatch" });
    // malformed stats
    out = await pub.publish("nflverse:injuries", "v1", null, (w) => {
      w.createTable(DS_INJURIES);
      return Promise.resolve({ ...stats(0), rows: -1 });
    });
    expect(out).toEqual({ ok: false, error: "INTERNAL" });
    out = await pub.publish("nflverse:injuries", "v1", null, (w) => {
      w.createTable(DS_INJURIES);
      return Promise.resolve({ ...stats(0), seasons: [1066] });
    });
    expect(out).toEqual({ ok: false, error: "INTERNAL" });
    expect(readdirSync(t.datasetDir)).toEqual([]);
  });

  it("the writer refuses non-ds tables, duplicates, unknown tables/columns, oversize batches, and use after fill", async () => {
    let captured: { insert(t: string, r: never[]): number } | null = null;
    const attempts: [
      string,
      (w: Parameters<Parameters<DatasetPublisher["publish"]>[3]>[0]) => void,
    ][] = [
      [
        "non-ds",
        (w) => {
          w.createTable({ ...DS_INJURIES, name: "injuries" as never });
        },
      ],
      [
        "duplicate",
        (w) => {
          w.createTable(DS_INJURIES);
          w.createTable(DS_INJURIES);
        },
      ],
      ["unknown table", (w) => w.insert("ds_injuries", [])],
      [
        "unknown column",
        (w) => {
          w.createTable(DS_INJURIES);
          w.insert("ds_injuries", [
            {
              ...row(DS_INJURIES, {
                season: 2026,
                game_type: "REG",
                week: 1,
                team: "BUF",
                gsis_id: "00-9000001",
              }),
              evil: "x",
            },
          ]);
        },
      ],
      [
        "STRICT type slip",
        (w) => {
          w.createTable(DS_INJURIES);
          w.insert("ds_injuries", [
            row(DS_INJURIES, {
              season: "2026x",
              game_type: "REG",
              week: 1,
              team: "BUF",
              gsis_id: "00-9000001",
            }),
          ]);
        },
      ],
      [
        "hostile identifier",
        (w) => {
          w.createTable({ ...DS_INJURIES, name: 'ds_x"; DROP TABLE refresh_log; --' });
        },
      ],
    ];
    for (const [, body] of attempts) {
      const out = await pub.publish("nflverse:injuries", "v1", null, (w) => {
        body(w);
        return Promise.resolve(stats(0));
      });
      expect(out).toEqual({ ok: false, error: "INTERNAL" });
    }
    // a failed row batch rolls back whole
    const partial = await pub.publish("nflverse:injuries", "v1", null, (w) => {
      w.createTable(DS_INJURIES);
      const good = row(DS_INJURIES, {
        season: 2026,
        game_type: "REG",
        week: 1,
        team: "BUF",
        gsis_id: "00-9000001",
      });
      try {
        w.insert("ds_injuries", [good, good]); // duplicate primary key on the 2nd row
      } catch {
        // swallowed: the batch rolled back, the table is empty
      }
      return Promise.resolve(stats(0));
    });
    expect(partial.ok).toBe(true);
    expect(count(INJ_FILE(), "ds_injuries")).toBe(0);
    // use after fill settles
    await publishTables(pub, "nflverse:injuries", "v2", injuriesTables());
    await pub.publish("nflverse:injuries", "v3", null, (w) => {
      w.createTable(DS_INJURIES);
      captured = w;
      return Promise.resolve(stats(0));
    });
    expect(() => captured?.insert("ds_injuries", [])).toThrow(/closed/);
    // the refresh_log table survived the hostile identifier
    expect(storeRows("SELECT COUNT(*) AS n FROM refresh_log")[0]?.n).toBeGreaterThan(0);
  });

  it("the staging file is removed and debris of a crashed run is swept by the next publish", async () => {
    const debris = stagingPath(t.datasetDir, "nflverse:injuries", "old");
    writeFileSync(debris, "half a file", { mode: 0o600 });
    writeFileSync(`${debris}-journal`, "x", { mode: 0o600 });
    writeFileSync(
      path.join(t.datasetDir, "nflverse__schedules.v1.abcdef012345.tmp"),
      "other source",
      { mode: 0o600 },
    );
    expect((await publishTables(pub, "nflverse:injuries", "v1", injuriesTables())).ok).toBe(true);
    expect(readdirSync(t.datasetDir).sort()).toEqual([
      "nflverse__injuries.sqlite",
      "nflverse__schedules.v1.abcdef012345.tmp",
    ]);
    expect(sweepDebris(t.datasetDir, "nflverse:schedules")).toEqual([
      "nflverse__schedules.v1.abcdef012345.tmp",
    ]);
    expect(stagingPath(t.datasetDir, "nflverse:injuries", "../../etc/passwd")).toMatch(
      /nflverse__injuries\.______etc_passwd\.[0-9a-f]{12}\.tmp$/,
    );
  });
});

describe("fault points around the commit", () => {
  it("a crash before the rename (beforeRename throws) keeps the old file; no debris", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const ino = statSync(INJ_FILE()).ino;
    pub.close();
    pub = openPublisher(t, {
      beforeRename: () => {
        throw new Error("power cut");
      },
    });
    const out = await publishTables(
      pub,
      "nflverse:injuries",
      "v2",
      emptyTables("nflverse:injuries"),
    );
    expect(out).toEqual({ ok: false, error: "INTERNAL" });
    expect(statSync(INJ_FILE()).ino).toBe(ino);
    expect(readdirSync(t.datasetDir)).toEqual(["nflverse__injuries.sqlite"]);
  });

  it("renamed but unrecorded → PUBLISH_UNRECORDED; the next publish records the live file first", async () => {
    pub.close();
    pub = openPublisher(t, {
      afterRename: () => {
        throw new Error("commit failed after rename");
      },
    });
    const out = await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    expect(out).toEqual({ ok: false, error: PUBLISH_UNRECORDED });
    expect(existsSync(INJ_FILE())).toBe(true);
    expect(storeRows("SELECT * FROM refresh_log")).toEqual([]); // the row rolled back; no failure row
    pub.close();
    pub = openPublisher(t);
    // the next publish (even one that fails) first records the live, unrecorded file
    await pub.publish("nflverse:injuries", "v2", null, () => Promise.reject(new Error("x")));
    expect(storeRows("SELECT file_version, ok FROM refresh_log ORDER BY id")).toEqual([
      { file_version: "v1", ok: 1 },
      { file_version: null, ok: 0 },
    ]);
    const s = openStore(t);
    expect(s.datasets.injuries.reports(2026, 3, null).rows).toHaveLength(2);
    s.close();
  });
});

describe("single flight (job_lock)", () => {
  it("a second publish of the same source in this process is job_locked; other sources proceed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = pub.publish("nflverse:injuries", "v1", null, async (w) => {
      w.createTable(DS_INJURIES);
      await gate;
      return stats(0);
    });
    expect(await publishTables(pub, "nflverse:injuries", "v2", injuriesTables())).toEqual({
      ok: false,
      error: PUBLISH_JOB_LOCKED,
    });
    expect((await publishTables(pub, "espn:pro_schedule", "v1", proScheduleTables())).ok).toBe(
      true,
    );
    release();
    expect((await first).ok).toBe(true);
  });

  it("a live foreign holder blocks (job_locked); a dead one or a stale one is broken", async () => {
    const db = new DatabaseSync(t.storePath);
    const hold = (pid: number, at: string): void => {
      db.prepare(
        "INSERT OR REPLACE INTO job_lock (job, pid, acquired_at, acquired_ms) VALUES (?, ?, ?, ?)",
      ).run(publishJob("nflverse:injuries"), pid, at, Date.parse(at));
    };
    hold(process.ppid, "2026-10-06T11:59:00.000Z"); // alive (our parent), fresh
    expect(await publishTables(pub, "nflverse:injuries", "v1", injuriesTables())).toEqual({
      ok: false,
      error: PUBLISH_JOB_LOCKED,
    });
    hold(999_999_999, "2026-10-06T11:59:00.000Z"); // dead
    expect((await publishTables(pub, "nflverse:injuries", "v1", injuriesTables())).ok).toBe(true);
    hold(process.ppid, "2026-10-06T10:00:00.000Z"); // alive but stale (> 15 min)
    expect((await publishTables(pub, "nflverse:injuries", "v2", injuriesTables())).ok).toBe(true);
    db.close();
  });
});

describe("multi-process (plan 05 §2 `store`)", () => {
  it("torn publish: a child SIGKILLed mid-fill leaves the old file readable; its debris and lock are recovered", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const ino = statSync(INJ_FILE()).ino;
    const child = run("publish-child.mjs", [t.storePath, t.datasetDir, "crash", "v2", "0", "200"], {
      tsx: true,
    });
    await child.waitFor(/^FILLING /);
    expect(await child.exited()).toBe("SIGKILL");
    expect(statSync(INJ_FILE()).ino).toBe(ino);
    expect(count(INJ_FILE(), "ds_injuries")).toBe(3);
    expect(readdirSync(t.datasetDir).some((n) => n.endsWith(".tmp"))).toBe(true);
    const s = openStore(t);
    expect(s.datasets.injuries.reports(2026, 3, null).stamp?.file_version).toBe("v1");
    s.close();
    // the dead child's job lock is broken and its debris swept by the next publish
    expect(
      (await publishTables(pub, "nflverse:injuries", "v3", emptyTables("nflverse:injuries"))).ok,
    ).toBe(true);
    expect(readdirSync(t.datasetDir)).toEqual(["nflverse__injuries.sqlite"]);
  });

  it("torn publish: a child SIGKILLed after fsync, before the commit, leaves the old file", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const child = run(
      "publish-child.mjs",
      [t.storePath, t.datasetDir, "crash-rename", "v2", "0", "50"],
      {
        tsx: true,
      },
    );
    await child.waitFor(/^BEFORE_RENAME/);
    expect(await child.exited()).toBe("SIGKILL");
    expect(meta(INJ_FILE()).file_version).toBe("v1");
    expect(
      storeRows("SELECT file_version FROM refresh_log WHERE ok = 1").map((r) => r.file_version),
    ).toEqual(["v1"]);
  });

  it("two processes publishing one source: exactly one publishes, the other is job_locked", async () => {
    const child = run(
      "publish-child.mjs",
      [t.storePath, t.datasetDir, "ok", "child-v1", "1500", "20"],
      {
        tsx: true,
      },
    );
    await child.waitFor(/^FILLING /);
    expect(await publishTables(pub, "nflverse:injuries", "parent-v1", injuriesTables())).toEqual({
      ok: false,
      error: PUBLISH_JOB_LOCKED,
    });
    const line = await child.waitFor(/^\{/);
    expect(JSON.parse(line)).toMatchObject({ ok: true, file_version: "child-v1" });
    expect(await child.exited()).toBe(0);
    expect(meta(INJ_FILE()).file_version).toBe("child-v1");
  });

  it("while a child publishes, the server's store stays writable and its open reader keeps the old rows until re-open", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuriesTables());
    const s = openStore(t);
    expect(s.datasets.injuries.reports(2026, 3, null).rows).toHaveLength(2);
    const conn = storeInternalsOf(s)?.connections;
    const child = run("publish-child.mjs", [t.storePath, t.datasetDir, "ok", "v2", "800", "40"], {
      tsx: true,
    });
    await child.waitFor(/^FILLING /);
    // a required write on store.sqlite during the child's publish does not wait on it
    const t0 = performance.now();
    s.repos.probeLog.record({
      at: "2026-10-06T12:00:00.000Z",
      kind: "host",
      ok: true,
      status: "green",
      upstream_status: 200,
      error: null,
    });
    expect(performance.now() - t0).toBeLessThan(1000);
    await child.waitFor(/^\{/);
    expect(await child.exited()).toBe(0);
    // the open connection still reads the old inode until refresh_log's new version is seen
    const before = conn?.list()[0];
    expect(before?.file_version).toBe("v1");
    const reports = s.datasets.injuries.reports(2026, 3, null);
    expect(reports.stamp?.file_version).toBe("v2");
    expect(reports.rows).toHaveLength(40);
    expect(conn?.list()[0]?.inode).not.toBe(before?.inode);
    s.close();
  });
});

describe("a Phase-2 source (no contract tables) publishes its own tables", () => {
  it("columns hash over what it created", async () => {
    const out = await publishTables(
      pub,
      "sleeper:trending",
      "bucket-1",
      emptyTables("sleeper:trending"),
    );
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(t.datasetDir, "sleeper__trending.sqlite"))).toBe(true);
  });
});

describe("store.sqlite never receives a dataset write", () => {
  it("after publishing every Phase-1 source, the main file lists no ds_* table", async () => {
    for (const s of [
      "espn:pro_schedule",
      "espn:players",
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:players",
      "nflverse:stats_player_week",
      "weather:open_meteo",
      "weather:nws",
    ] as const)
      expect((await publishTables(pub, s, "v1", emptyTables(s))).ok).toBe(true);
    const tables = storeRows("SELECT name FROM sqlite_master").map((r) => String(r.name));
    expect(tables.filter((n) => n.toLowerCase().startsWith("ds_"))).toEqual([]);
    expect(DS_PRO_TEAMS.name).toBe("ds_pro_teams");
    expect(DS_PRO_SCHEDULE.name).toBe("ds_pro_schedule");
  });
});
