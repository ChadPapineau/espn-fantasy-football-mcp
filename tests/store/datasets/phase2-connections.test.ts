// phase2-connections.test.ts — the per-source connection design (plan 01 §5.1/§5.5 after ADV OBJ-22)
// re-checked with Phase 2 and the history files: 25 contract dataset files plus the registry's
// uncontracted sources (28 files, against SQLite's 10-attachment limit) are each published the way the
// publisher does (journal_mode=DELETE, no sidecar), opened at once as their OWN read-only connections,
// every Phase-2 reader statement runs on its own file's connection, every write is refused by the open
// mode (A-13), no reader leaves a -wal/-shm beside a published file, and one connection attaching them
// all fails at the 11th — the reason there is no attach loop.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATASET_SOURCE_IDS } from "../../../src/config/freshness.js";
import { datasetFileStem } from "../../../src/config/paths.js";
import {
  CONTRACT_DATASET_SOURCES,
  HISTORY_DATASET_SOURCES,
  PHASE_2_READER_QUERIES,
  PHASE_2_UNCONTRACTED_SOURCES,
  contractTablesFor,
  ddlFor,
  isContractDatasetSource,
  quoteIdentifier,
} from "../../../src/store/datasets/tables.js";
import { MAX_ON_DEMAND_ATTACHMENTS, SQLITE_ATTACH_LIMIT } from "../../../src/store/types.js";

/** Every dataset file a full install can hold: the contract files + the uncontracted registry ids. */
const ALL_FILES: readonly string[] = [
  ...CONTRACT_DATASET_SOURCES,
  ...DATASET_SOURCE_IDS.filter((s) => !isContractDatasetSource(s)),
];

let dir = "";
const fileOf = (source: string): string => path.join(dir, `${datasetFileStem(source)}.sqlite`);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "eff-ds-p2-"));
  for (const s of ALL_FILES) {
    const db = new DatabaseSync(fileOf(s));
    db.exec("PRAGMA journal_mode=DELETE");
    const tables = contractTablesFor(s);
    if (tables.length === 0)
      db.exec('CREATE TABLE "ds_probe" ("id" INTEGER NOT NULL, PRIMARY KEY ("id")) STRICT');
    for (const t of tables) for (const sql of ddlFor(t)) db.exec(sql);
    db.close();
  }
});
afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

const sidecars = (): string[] => readdirSync(dir).filter((f) => /-(wal|shm|journal)$/.test(f));

describe("ADV OBJ-22 holds with Phase 2 and the history files", () => {
  it("counts more files than SQLite can attach — so the attach loop stays out", () => {
    expect(CONTRACT_DATASET_SOURCES).toHaveLength(25);
    expect(HISTORY_DATASET_SOURCES).toHaveLength(7);
    expect(ALL_FILES).toHaveLength(28);
    expect(new Set(ALL_FILES.map((s) => datasetFileStem(s))).size).toBe(ALL_FILES.length);
    expect(ALL_FILES.length).toBeGreaterThan(SQLITE_ATTACH_LIMIT);
    expect(MAX_ON_DEMAND_ATTACHMENTS).toBeLessThan(SQLITE_ATTACH_LIMIT);
    expect(PHASE_2_UNCONTRACTED_SOURCES.every((s) => ALL_FILES.includes(s))).toBe(true);
  });

  it("one connection attaching every file fails at the 11th attachment", () => {
    const db = new DatabaseSync(":memory:");
    let attached = 0;
    let error = "";
    try {
      for (const s of ALL_FILES) {
        db.prepare(`ATTACH DATABASE ? AS ${quoteIdentifier(`a${String(attached)}`)}`).run(
          `file:${fileOf(s)}?mode=ro`,
        );
        attached++;
      }
    } catch (e) {
      error = String(e);
    } finally {
      db.close();
    }
    expect(attached).toBe(SQLITE_ATTACH_LIMIT);
    expect(error).toMatch(/too many attached databases/i);
  });

  it("all 28 files open at once, each its own read-only connection with nothing attached", () => {
    const conns = ALL_FILES.map(
      (s) => [s, new DatabaseSync(fileOf(s), { readOnly: true })] as const,
    );
    try {
      expect(new Set(conns.map(([, c]) => c)).size).toBe(28);
      for (const [s, c] of conns) {
        const list = c.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
        expect(
          list.map((d) => d.name),
          s,
        ).toEqual(["main"]);
        expect(path.basename(list[0]?.file ?? "")).toBe(`${datasetFileStem(s)}.sqlite`);
      }
      // every Phase-2 statement runs on ITS file's connection (and its history twin's), while all
      // the other connections stay open
      const byId = new Map(conns);
      const p: Record<string, string | number> = {
        season: 2026,
        week: 1,
        weeks: "[1]",
        gsis_ids: "[]",
        teams: "[]",
        pfr_ids: "[]",
        sleeper_ids: "[]",
        item_ids: "[]",
        since_ms: 0,
        limit: 1,
        at_ms: 0,
      };
      for (const r of Object.values(PHASE_2_READER_QUERIES))
        for (const st of r.statements) {
          const args = Object.fromEntries(st.params.map((k) => [k, p[k] ?? 0]));
          for (const on of [st.source, ...(st.history ? [st.history] : [])]) {
            const c = byId.get(on);
            expect(c, `${r.method} on ${on}`).toBeDefined();
            expect(c?.prepare(st.sql).all(args), `${r.method} on ${on}`).toEqual([]);
          }
        }
    } finally {
      for (const [, c] of conns) c.close();
    }
    expect(sidecars()).toEqual([]);
  });

  it.each(CONTRACT_DATASET_SOURCES.map((s) => [s] as const))(
    "%s: every write is refused by the read-only open mode (plan 01 §5.5, A-13)",
    (s) => {
      const c = new DatabaseSync(fileOf(s), { readOnly: true });
      try {
        const t = contractTablesFor(s)[0];
        expect(t).toBeDefined();
        const tbl = quoteIdentifier(t?.name ?? "ds_x");
        const col = quoteIdentifier(t?.columns[0]?.name ?? "x");
        for (const sql of [
          `INSERT INTO ${tbl} (${col}) VALUES (1)`,
          `UPDATE ${tbl} SET ${col} = NULL`,
          `DELETE FROM ${tbl}`,
          `DROP TABLE ${tbl}`,
          `CREATE TABLE "ds_evil" ("x" INTEGER) STRICT`,
          `CREATE INDEX "ix_evil" ON ${tbl} (${col})`,
          `ALTER TABLE ${tbl} ADD COLUMN "evil" TEXT`,
        ])
          expect(() => {
            c.exec(sql);
          }, sql).toThrow(/readonly|read-only/i);
        // a journal-mode switch cannot turn a reader into a WAL writer: refused, or a no-op
        let mode: string | null = null;
        try {
          mode = (c.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode: string })
            .journal_mode;
        } catch (e) {
          expect(String(e)).toMatch(/readonly|read-only/i);
        }
        expect(mode).not.toBe("wal");
      } finally {
        c.close();
      }
      expect(existsSync(`${fileOf(s)}-wal`)).toBe(false);
      expect(existsSync(`${fileOf(s)}-shm`)).toBe(false);
    },
  );
});
