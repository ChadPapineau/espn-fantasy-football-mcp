// analytics-exports.test.ts — E1's trailing reads have one form (the round-3 review's R3B-M4): the
// resumable steps its one caller runs with inTurns (changelog §R10 timing items). The synchronous
// wrapper `trailingFor` that 0f2d536 left had no caller and was the file's one uncovered added
// statement; it is gone, and nothing may bring back a second, unscheduled path. No network.
import { describe, expect, it } from "vitest";
import * as analytics from "../../src/mcp/tools/analytics.js";

describe("analytics.ts: E1's trailing reads", () => {
  it("are exported only as resumable steps (no synchronous wrapper beside them)", () => {
    expect(Object.keys(analytics)).not.toContain("trailingFor");
    expect(typeof analytics.trailingSteps).toBe("function");
  });
});
