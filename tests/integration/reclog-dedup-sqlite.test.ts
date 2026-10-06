// reclog-dedup-sqlite.test.ts — the recommendation log's deduplication contract held against the
// REAL SQLite repository (plan 07 E12 `idempotentHint: true` on client_ref; src/domain/reclog/types.ts
// RECORD_DEDUP_SCOPE): tests/domain/reclog/dedup-contract.ts names the scenarios the in-memory
// reference passes; the reclog module asked the store to run them on store.sqlite. Every scenario
// opens a fresh store in a temp directory.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { fixedClock } from "../../src/domain/clock.js";
import { storeFactory } from "../../src/store/index.js";
import { checkRecordDedupContract, DEDUP_SCENARIOS } from "../domain/reclog/dedup-contract.js";

function openSqlite() {
  const root = mkdtempSync(path.join(tmpdir(), "eff-reclog-sqlite-"));
  const cache = path.join(root, "cache");
  mkdirSync(cache, { mode: 0o700 });
  const store = storeFactory.open({
    path: storePath(cache),
    datasetDir: datasetDir(cache),
    backupDir: backupDir(cache),
    clock: fixedClock("2026-10-06T12:00:00.000Z"),
    migrate: true,
  });
  return {
    repo: store.repos.recommendationLog,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("the recommendation log's dedup contract on store.sqlite", () => {
  it(`holds for every scenario (${String(Object.keys(DEDUP_SCENARIOS).length)})`, () => {
    expect(Object.keys(DEDUP_SCENARIOS).length).toBeGreaterThan(3);
    expect(checkRecordDedupContract(openSqlite)).toEqual([]);
  });
});
