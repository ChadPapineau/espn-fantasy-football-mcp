// caches.test.ts — the best-effort cache tables (plan 01 §5.3 the ESPN cache; plan 05 §2
// `providers/espn/cache`: raw bodies are NOT written unless EFF_FIXTURE_RECORD=1 — a grep of the store
// after a normal run finds no raw-only string; plan 08 §9 points_cache) and their input refusals.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ESPN_CACHE_KEY_MAX } from "../../src/store/repos/caches.js";
import type { EspnCacheEntry, Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const RAW_MARKER = "RAW-ONLY-MARKER-7f3a9c";
const entry = (over: Partial<EspnCacheEntry> = {}): EspnCacheEntry => ({
  key: "2026|0|mSettings|1|{}",
  parsed_json: '{"settings":{"name":"Example League"}}',
  fetched_at: "2026-10-06T12:00:00.000Z",
  server_time: "2026-10-06T11:59:59.000Z",
  etag: 'W/"abc"',
  http_status: 200,
  raw_body: `{"raw":"${RAW_MARKER}"}`,
  ...over,
});

describe("espn_cache", () => {
  it("round-trips the parsed entry; the raw body is dropped unless recording", () => {
    expect(s.repos.espnCache.put(entry())).toEqual({ written: true });
    expect(s.repos.espnCache.get(entry().key)).toEqual({ ...entry(), raw_body: null });
    s.close();
    const bytes = readFileSync(t.storePath).toString("latin1");
    let wal = "";
    try {
      wal = readFileSync(`${t.storePath}-wal`).toString("latin1");
    } catch {
      wal = "";
    }
    expect(bytes + wal).not.toContain(RAW_MARKER);
    s = openStore(t, { recordRawBodies: true });
    s.repos.espnCache.put(entry({ key: "k2" }));
    expect(s.repos.espnCache.get("k2")?.raw_body).toContain(RAW_MARKER);
  });

  it("put replaces; get of an unknown or hostile key is null; nullable fields stay null", () => {
    s.repos.espnCache.put(entry({ etag: null, server_time: null, raw_body: null }));
    s.repos.espnCache.put(entry({ parsed_json: "{}", http_status: 304 }));
    expect(s.repos.espnCache.get(entry().key)).toMatchObject({
      parsed_json: "{}",
      http_status: 304,
    });
    expect(s.repos.espnCache.get("nope")).toBeNull();
    expect(s.repos.espnCache.get("")).toBeNull();
    expect(s.repos.espnCache.get("x".repeat(ESPN_CACHE_KEY_MAX + 1))).toBeNull();
    expect(s.repos.espnCache.get(42 as never)).toBeNull();
  });

  it("refuses malformed entries", () => {
    for (const bad of [
      entry({ key: "" }),
      entry({ key: "a\0b" }),
      entry({ key: "x".repeat(ESPN_CACHE_KEY_MAX + 1) }),
      entry({ fetched_at: "yesterday" }),
      entry({ server_time: "2026-13-45" }),
      entry({ http_status: 99 }),
      entry({ http_status: 600 }),
      entry({ http_status: 200.5 }),
      entry({ etag: "" }),
      entry({ parsed_json: 5 as never }),
      entry({ raw_body: 5 as never }),
    ])
      expect(() => s.repos.espnCache.put(bad)).toThrow(RangeError);
  });

  it("prune removes entries fetched before the cutoff", () => {
    s.repos.espnCache.put(entry({ key: "old", fetched_at: "2026-09-01T00:00:00.000Z" }));
    s.repos.espnCache.put(entry({ key: "new", fetched_at: "2026-10-06T00:00:00.000Z" }));
    expect(s.repos.espnCache.prune("2026-10-01T00:00:00.000Z")).toBe(1);
    expect(s.repos.espnCache.get("old")).toBeNull();
    expect(s.repos.espnCache.get("new")).not.toBeNull();
    expect(() => s.repos.espnCache.prune("nope")).toThrow(RangeError);
  });
});

describe("points_cache", () => {
  it("round-trips by (line hash, settings hash); put replaces; refuses malformed input", () => {
    expect(s.repos.pointsCache.get("l", "s")).toBeNull();
    expect(s.repos.pointsCache.put("l", "s", '{"points":12.5}')).toEqual({ written: true });
    s.repos.pointsCache.put("l", "s", '{"points":13}');
    expect(s.repos.pointsCache.get("l", "s")).toBe('{"points":13}');
    expect(s.repos.pointsCache.get("l", "other")).toBeNull();
    expect(s.repos.pointsCache.get(1 as never, "s")).toBeNull();
    expect(() => s.repos.pointsCache.put("", "s", "{}")).toThrow(RangeError);
    expect(() => s.repos.pointsCache.put("l", "x".repeat(129), "{}")).toThrow(RangeError);
    expect(() => s.repos.pointsCache.put("l", "s", "x".repeat(1024 * 1024 + 1))).toThrow(
      RangeError,
    );
    expect(() => s.repos.pointsCache.put("l", "s", null as never)).toThrow(RangeError);
  });
});
