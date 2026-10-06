// gates.test.ts — src/auth/gates.ts (plan 02 S4, §3.2; plan 03 §1.1 step 6, §5 #13; changelog V4;
// plan 10 W2): the four registration gates from persisted evidence, `firstFailing` in the plan's
// order, and the Phase W seam — no write tool is ever registered in this build, and the
// acknowledgement gate cannot hold while no acknowledgement sentence exists.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REGISTRATION_GATES,
  evaluateRegistrationGates,
  type RegistrationGateInput,
} from "../../src/auth/gates.js";
import { ROOT } from "../config/helpers.js";
import { stateRow } from "./helpers.js";

const SHA = createHash("sha256").update("a future acknowledgement sentence").digest("hex");
const all: RegistrationGateInput = {
  writesRequested: true,
  acknowledgement: { at: "2026-10-01T00:00:00.000Z", textSha256: SHA },
  currentAcknowledgementSha256: SHA,
  teamId: 3,
  teamIdOrigin: "file",
  credentialRow: stateRow({ state: "validated" }),
  leagueId: "0",
};

describe("evaluateRegistrationGates", () => {
  it("all four hold → allHold, but writeToolsRegistered stays false (PHASE W SEAM)", () => {
    const r = evaluateRegistrationGates(all);
    expect(r.gates).toEqual({ env: true, acknowledgement: true, own_team: true, credential: true });
    expect(r.allHold).toBe(true);
    expect(r.firstFailing).toBeNull();
    expect(r.writeToolsRegistered).toBe(false);
  });
  it("this build: no acknowledgement sentence (null) → the acknowledgement gate is false", () => {
    const r = evaluateRegistrationGates({ ...all, currentAcknowledgementSha256: null });
    expect(r.gates.acknowledgement).toBe(false);
    expect(r.firstFailing).toBe("acknowledgement");
  });
  it.each([
    ["env", { writesRequested: false }],
    ["acknowledgement", { acknowledgement: null }],
    ["acknowledgement", { currentAcknowledgementSha256: "not-a-sha" }],
    ["acknowledgement", { acknowledgement: { at: "x", textSha256: "0".repeat(64) } }],
    ["own_team", { teamId: null }],
    ["own_team", { teamIdOrigin: "env" as const }],
    ["own_team", { teamId: 0 }],
    ["own_team", { teamId: 1.5 }],
    ["credential", { credentialRow: null }],
    ["credential", { credentialRow: stateRow({ state: "stored" }) }],
    ["credential", { credentialRow: stateRow({ state: "rejected" }) }],
    ["credential", { credentialRow: stateRow({ state: "validated", league_id: "8" }) }],
  ] as const)("%s fails on %j", (gate, over) => {
    const r = evaluateRegistrationGates({ ...all, ...over });
    expect(r.gates[gate]).toBe(false);
    expect(r.firstFailing).toBe(gate);
    expect(r.allHold).toBe(false);
  });
  it("firstFailing follows plan 02 §3.2's order: env, acknowledgement, own team, credential", () => {
    expect(REGISTRATION_GATES).toEqual(["env", "acknowledgement", "own_team", "credential"]);
    const none = evaluateRegistrationGates({
      ...all,
      writesRequested: false,
      acknowledgement: null,
      teamId: null,
      credentialRow: null,
    });
    expect(none.firstFailing).toBe("env");
    expect(Object.values(none.gates).every((g) => !g)).toBe(true);
  });
  it("the gates object is frozen (a caller cannot flip a gate)", () => {
    expect(Object.isFrozen(evaluateRegistrationGates(all).gates)).toBe(true);
  });
  it("the Phase W seam marker is declared in the source", () => {
    const src = readFileSync(path.join(ROOT, "src/auth/gates.ts"), "utf8");
    expect(src).toContain("PHASE W SEAM — NOT IMPLEMENTED");
  });
});
