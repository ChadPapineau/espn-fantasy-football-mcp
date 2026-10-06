// phase2-surface.test.ts — the Phase-2 market engines' public surface (src/domain/analytics/
// phase2.ts): every engine the P1 tools call is exported from the one barrel, so the tool layer
// imports a single module (plan 10 §3.2's E5 P1, E6, E7, E10, E11 and E1's player_sim hook).
import { describe, expect, it } from "vitest";
import * as P2 from "../../../src/domain/analytics/phase2.js";

describe("phase2.ts", () => {
  it("exports every engine entry point and its helpers", () => {
    for (const name of [
      "analyzeWaiversP1",
      "analyzeTrade",
      "analyzeInjuryCascade",
      "analyzeEvidence",
      "analyzeLeagueActivity",
      "playerSimDist",
      "hasOpportunityInputs",
      "detectSignals",
      "fitDemand",
      "fittedQ",
      "claimRuns",
      "demandObservations",
      "learnWaiverMechanics",
      "learnKickoffWaivers",
      "faabBid",
      "lambdaOf",
      "pricePerPoint",
      "positionGaps",
    ] as const)
      expect(typeof P2[name]).toBe("function");
    expect(P2.SIGNALS.snapJump).toBe(0.15);
    expect(Object.isFrozen(P2.TRADE)).toBe(true);
    expect(Object.isFrozen(P2.CASCADE)).toBe(true);
  });
});
