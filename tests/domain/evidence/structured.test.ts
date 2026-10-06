// structured.test.ts — the structured-field comparator (src/domain/evidence/structured.ts; plan 07
// E10; research 05 §6 rule 3 and case 3; plan 10 B8 "`structured_disagrees` fires on `inj-ir-cleared`
// naming `injury_status`").
import { describe, expect, it } from "vitest";
import { INJECTIONS } from "../../../scripts/fx10h/variants.js";
import {
  DESIGNATIONS,
  extractClaim,
  statusClass,
  structuredDisagreement,
  type RulesV1Claim,
} from "../../../src/domain/evidence/index.js";
import { ESPN_INJURY_STATUSES } from "../../../src/domain/league/types.js";

const avail = (designation: RulesV1Claim["designation"]): RulesV1Claim => ({
  type: "availability",
  direction: "up",
  extractor: "rules_v1",
  rule: "availability.cleared",
  designation,
  field: "text",
});

describe("structuredDisagreement", () => {
  it("fires on inj-ir-cleared: an OUT player whose outlook says cleared to play → injury_status", () => {
    const claim = extractClaim(INJECTIONS.irCleared);
    const d = structuredDisagreement(claim, { injury_status: "OUT" });
    expect(d).toEqual({ field: "injury_status", structured_value: "OUT", claim_value: "cleared" });
    // the comparator never alters the structured value: the same call with INJURY_RESERVE / SUSPENSION
    expect(
      structuredDisagreement(claim, { injury_status: "INJURY_RESERVE" })?.structured_value,
    ).toBe("INJURY_RESERVE");
    expect(structuredDisagreement(claim, { injury_status: "SUSPENSION" })?.field).toBe(
      "injury_status",
    );
  });

  it("fires the other way: ACTIVE vs a report that he is out", () => {
    expect(
      structuredDisagreement(extractClaim("Player A: Ruled out Sunday"), {
        injury_status: "ACTIVE",
      }),
    ).toEqual({ field: "injury_status", structured_value: "ACTIVE", claim_value: "out" });
  });

  it("is quiet when either side is uncertain, when they agree, or when there is nothing to compare", () => {
    expect(
      structuredDisagreement(extractClaim("Player A: Questionable for Week 5"), {
        injury_status: "OUT",
      }),
    ).toBeNull();
    expect(
      structuredDisagreement(extractClaim("Player A: Ruled out"), {
        injury_status: "QUESTIONABLE",
      }),
    ).toBeNull();
    expect(
      structuredDisagreement(extractClaim("Player A: Ruled out"), { injury_status: "OUT" }),
    ).toBeNull();
    expect(
      structuredDisagreement(extractClaim("Player A: Will play"), { injury_status: "ACTIVE" }),
    ).toBeNull();
    expect(
      structuredDisagreement(extractClaim("Player A: Will play"), { injury_status: null }),
    ).toBeNull();
    expect(
      structuredDisagreement(extractClaim("Player A: Will play"), {
        injury_status: "NEW_ESPN_STATUS",
      }),
    ).toBeNull();
    expect(
      structuredDisagreement(extractClaim("Player A signs with Bills"), { injury_status: "OUT" }),
    ).toBeNull();
    expect(structuredDisagreement(null, { injury_status: "OUT" })).toBeNull();
    expect(structuredDisagreement(avail(null), { injury_status: "OUT" })).toBeNull();
  });

  it("classes every ESPN status and every designation", () => {
    expect(ESPN_INJURY_STATUSES.map((s) => statusClass(s))).toEqual([
      "plays",
      "uncertain",
      "out",
      "out",
      "out",
      "uncertain",
      "out",
    ]);
    expect(statusClass(null)).toBeNull();
    expect(statusClass("__proto__")).toBeNull();
    for (const d of DESIGNATIONS) {
      const r = structuredDisagreement(avail(d), { injury_status: "OUT" });
      expect(r === null || r.claim_value === d).toBe(true);
    }
  });
});
