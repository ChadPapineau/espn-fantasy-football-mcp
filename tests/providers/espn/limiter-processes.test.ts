// limiter-processes.test.ts — the cross-process limiter property (plan 05 §2 `providers/espn/limiter`,
// §4.1 "two processes, one limiter table, 40 requests in a minute → 30 sent, 10 wait; never > 30 in
// any 60 s"): two real child processes run the real EspnLimiter against ONE SQLite limiter table on a
// shared virtual clock; afterwards no 60 s window holds more than 30 rows and no 1 s window more
// than 1, and every acquisition was either recorded or refused (never sent unrecorded).
import { spawn } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ESPN_LIMITER } from "../../../src/config/schema.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { storeFactory } from "../../../src/store/index.js";
import { ROOT, tempDir } from "../../lint/helpers.js";
import { openSqliteLimiter } from "./procs/sqlite-limiter.js";

const CHILD = path.join(ROOT, "tests", "providers", "espn", "procs", "limiter-child.ts");
let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

function runChild(args: string[]): Promise<{ sent: number; refused: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`child exited ${String(code)}: ${err.slice(0, 500)}`));
      else
        resolve(
          JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { sent: number; refused: number },
        );
    });
  });
}

function assertWindows(ts: readonly number[]): void {
  expect(ts.length).toBeGreaterThanOrEqual(ESPN_LIMITER.perMinute);
  for (const t of ts) {
    expect(ts.filter((x) => x > t - 60_000 && x <= t).length).toBeLessThanOrEqual(
      ESPN_LIMITER.perMinute,
    );
    expect(ts.filter((x) => x > t - 1000 && x <= t).length).toBeLessThanOrEqual(
      ESPN_LIMITER.perSecond,
    );
  }
  // 40 asked, at most 30 fit in the first minute — the rest waited or were refused
  expect(ts.filter((x) => x < ts[0]! + 60_000).length).toBeLessThanOrEqual(ESPN_LIMITER.perMinute);
}

describe("two processes share one bucket (plan 01 §6)", () => {
  it("40 requests from two processes: never > 30 in any 60 s, never > 1 in any second", async () => {
    tmp = tempDir("eff-limiter-");
    const file = path.join(tmp.dir, "limiter.sqlite");
    openSqliteLimiter(file).close();
    const base = Date.parse("2026-10-06T12:00:00Z");
    const realStart = Date.now() + 1500;
    const speed = "40";
    const args = [file, "20", String(base), String(realStart), speed];
    const [a, b] = await Promise.all([runChild(args), runChild(args)]);
    expect(a.sent + a.refused).toBe(20);
    expect(b.sent + b.refused).toBe(20);
    const db = new DatabaseSync(file, { readOnly: true });
    const ts = db
      .prepare("SELECT ts FROM espn_requests ORDER BY ts")
      .all()
      .map((r) => (r as { ts: number }).ts);
    db.close();
    expect(ts.length).toBe(a.sent + b.sent);
    assertWindows(ts);
  }, 60_000);

  it("the same property over the REAL store's limiter repository (store.sqlite, two processes)", async () => {
    tmp = tempDir("eff-limiter-store-");
    const file = path.join(tmp.dir, "store.sqlite");
    const setup = storeFactory.open({
      path: file,
      datasetDir: path.join(tmp.dir, "datasets"),
      backupDir: path.join(tmp.dir, "backups"),
      clock: fixedClock("2026-10-06T12:00:00Z"),
      migrate: true,
    });
    setup.close();
    const base = Date.parse("2026-10-06T12:00:00Z");
    const args = [file, "20", String(base), String(Date.now() + 1500), "40", "store"];
    const [a, b] = await Promise.all([runChild(args), runChild(args)]);
    expect(a.sent + a.refused + b.sent + b.refused).toBe(40);
    const db = new DatabaseSync(file, { readOnly: true });
    const ts = db
      .prepare("SELECT ts FROM espn_requests ORDER BY ts")
      .all()
      .map((r) => Number((r as { ts: number | bigint }).ts));
    db.close();
    expect(ts.length).toBe(a.sent + b.sent);
    assertWindows(ts);
  }, 60_000);
});
