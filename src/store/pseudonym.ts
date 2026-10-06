// pseudonym.ts — member-GUID pseudonymisation before persistence (plan 02 §2.4: snapshots, the
// journal and the recommendation log carry GUIDs only as deterministic pseudonyms
// `{00000000-0000-4000-8000-0000000000<nn>}` by first appearance, one map per store; plan 10 A6b: a
// grep for real GUIDs over the snapshot tables fails). The domain never carries GUIDs, so this is
// defence in depth for free text (a team name spelled as a GUID, a model-authored note). The map is
// keyed by sha256 of the upper-cased GUID, so the store holds no real GUID outside the parsed cache.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** A brace-GUID anywhere in a string (the logger's redaction shape, plan 01 §8). */
export const BRACE_GUID_RE =
  /\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}/g;
/**
 * The pseudonym range itself (never re-mapped): `{00000000-0000-4000-8000-<n as 12 hex digits>}` —
 * the fixture range of CLAUDE.md (`…-0000000000NN`) for the first 255 members.
 */
export const PSEUDONYM_RE = /^\{00000000-0000-4000-8000-[0-9a-f]{12}\}$/i;
/** The most pseudonyms one store can hold (12 hex digits). */
export const PSEUDONYM_MAX = 16 ** 12 - 1;

/** The pseudonym for the n-th distinct GUID (1-based). */
export function pseudonymOf(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > PSEUDONYM_MAX)
    throw new RangeError("store: pseudonym number out of range");
  return `{00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}}`;
}

/** sha256 hex of the upper-cased GUID (the map key). */
export function guidKey(guid: string): string {
  return createHash("sha256").update(guid.toUpperCase()).digest("hex");
}

/** Rewrites every real brace-GUID in a JSON string to its pseudonym. */
export interface Pseudonymizer {
  /** Must run inside the caller's write transaction (the map insert is part of it). */
  apply(json: string): string;
}

/** The store's pseudonymiser over the `guid_pseudonym` table of `db`. */
export function createPseudonymizer(db: DatabaseSync): Pseudonymizer {
  return {
    apply(json) {
      const found = json.match(BRACE_GUID_RE);
      if (found === null) return json;
      const map = new Map<string, string>();
      for (const g of found) {
        const upper = g.toUpperCase();
        if (map.has(upper) || PSEUDONYM_RE.test(g)) continue;
        const key = guidKey(upper);
        const row = db.prepare("SELECT n FROM guid_pseudonym WHERE guid_sha256 = ?").get(key) as
          { n: number } | undefined;
        let n = row?.n;
        if (n === undefined) {
          const next = db
            .prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM guid_pseudonym")
            .get() as { n: number };
          n = next.n;
          db.prepare("INSERT INTO guid_pseudonym (guid_sha256, n) VALUES (?, ?)").run(key, n);
        }
        map.set(upper, pseudonymOf(n));
      }
      return json.replace(BRACE_GUID_RE, (g) => map.get(g.toUpperCase()) ?? g);
    },
  };
}
