// platform.test.ts — src/providers/platform.ts (plan 01 §9 FantasyPlatform; plan 07 G1 capabilities;
// plan 01 §5.3/§5.6/§6 per-call budget): ESPN-native capabilities true, writes literal false and
// frozen, the per-call constants, and the re-exports the mcp layer depends on.
import { describe, expect, it } from "vitest";
import * as espn from "../../src/providers/espn/types.js";
import {
  ATTEMPT_TIMEOUT_MS,
  ESPN_DST_PLAYER_ID_MAX,
  ESPN_DST_PLAYER_ID_MIN,
  ESPN_PRO_TEAM_ABBREVS,
  FORCE_REFRESH_MIN_INTERVAL_MS,
  KNOWN_UPSTREAM_TYPES,
  MAX_UPSTREAM_PER_CALL,
  NO_WRITES,
  PER_CALL_DEADLINE_MS,
  UPSTREAM_TYPE_FAMILY_RE,
  espnCapabilities,
  isEspnView,
  upstreamTypeOrUnknown,
  type PlatformCapabilities,
} from "../../src/providers/platform.js";

describe("espnCapabilities", () => {
  it.each(["faab", "priority_move_to_last", "continuous", "unknown"] as const)(
    "waiver system %s",
    (w) => {
      const c: PlatformCapabilities = espnCapabilities(w, "2026-10-05T18:00:00.000Z");
      expect(c).toEqual({
        read: true,
        native_projections: true,
        native_ownership: true,
        live_scoring: true,
        waiver_system: w,
        writes: false,
        write: { lineup: false, add_drop: false, waiver: false, trade: false },
        discovered_at: "2026-10-05T18:00:00.000Z",
      });
      expect(Object.isFrozen(c)).toBe(true);
    },
  );
  it("the result cannot be mutated into a write grant", () => {
    const c = espnCapabilities("faab", "x");
    expect(() => {
      (c as unknown as { writes: boolean }).writes = true;
    }).toThrow(TypeError);
    expect(() => {
      (NO_WRITES as unknown as { lineup: boolean }).lineup = true;
    }).toThrow(TypeError);
    expect(c.writes).toBe(false);
    expect(NO_WRITES.lineup).toBe(false);
  });
});

describe("per-call budget", () => {
  it("three upstream requests, a 20 s deadline with 15 s attempts, force_refresh ≥ 60 s apart", () => {
    expect(MAX_UPSTREAM_PER_CALL).toBe(3);
    expect(PER_CALL_DEADLINE_MS).toBe(20_000);
    expect(ATTEMPT_TIMEOUT_MS).toBe(15_000);
    expect(ATTEMPT_TIMEOUT_MS).toBeLessThan(PER_CALL_DEADLINE_MS);
    expect(FORCE_REFRESH_MIN_INTERVAL_MS).toBe(60_000);
  });
});

describe("re-exports (the only door from src/mcp into the ESPN provider)", () => {
  it("are the provider's own bindings", () => {
    expect(isEspnView).toBe(espn.isEspnView);
    expect(upstreamTypeOrUnknown).toBe(espn.upstreamTypeOrUnknown);
    expect(KNOWN_UPSTREAM_TYPES).toBe(espn.KNOWN_UPSTREAM_TYPES);
    expect(UPSTREAM_TYPE_FAMILY_RE).toBe(espn.UPSTREAM_TYPE_FAMILY_RE);
    expect(ESPN_PRO_TEAM_ABBREVS).toBe(espn.ESPN_PRO_TEAM_ABBREVS);
    expect([ESPN_DST_PLAYER_ID_MIN, ESPN_DST_PLAYER_ID_MAX]).toEqual([-16999, -16001]);
  });
});
