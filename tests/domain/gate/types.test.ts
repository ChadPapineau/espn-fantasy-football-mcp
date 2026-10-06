// types.test.ts — src/domain/gate (PHASE W SEAM — NOT IMPLEMENTED; plan 10 §3.W; owner decision
// D11). Asserts the seam stays a seam: the marker on every declared seam, no write-only file, the
// seven write tool names nowhere else in src, the write host only where the read-host override
// refuses it, `writes`/`writesEnabled` literal false; and that the declared constants match plan
// 02 §3.2–§4.4 (journal transitions incl. `voided_code`/`voided_cancelled`, terminal states).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ESPN_WRITE_HOST } from "../../../src/config/schema.js";
import {
  CONFIRMATION_CHANNELS,
  GATE_CONSTANTS,
  GATE_ERROR_CODES,
  JOURNAL_STATES,
  JOURNAL_TRANSITIONS,
  PHASE_W_SEAM,
  PREPARED_ID_RE,
  TICKET_HMAC_FIELDS,
  WRITE_KINDS,
  WRITE_LIMITS,
  WRITE_REGISTRATION_GATES,
  WRITE_TOOL_NAMES,
  type JournalState,
} from "../../../src/domain/gate/types.js";
import { ERROR_CODES, ERROR_TABLE } from "../../../src/mcp/errors.js";
import {
  NO_WRITES,
  WRITES_SEAM_MARKER,
  espnCapabilities,
} from "../../../src/providers/platform.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SRC = path.join(ROOT, "src");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("the seam stays a seam", () => {
  it("one marker string, shared by the gate and the platform seam", () => {
    expect(PHASE_W_SEAM).toBe("PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; owner decision D11)");
    expect(WRITES_SEAM_MARKER).toBe(PHASE_W_SEAM);
  });
  it.each([
    "src/domain/gate/types.ts",
    "src/domain/gate/README.md",
    "src/providers/platform.ts",
    "src/providers/espn/types.ts",
    "src/config/schema.ts",
    "src/config/paths.ts",
    "src/store/types.ts",
    "src/mcp/errors.ts",
  ])("%s carries the marker", (rel) => {
    expect(read(rel)).toContain("PHASE W SEAM");
  });
  it("the full marker heads the gate's files", () => {
    expect(read("src/domain/gate/types.ts").split("\n")[0]).toContain(PHASE_W_SEAM);
    expect(read("src/domain/gate/README.md").split("\n")[0]).toContain(PHASE_W_SEAM);
  });
  it("the write-only files do not exist", () => {
    for (const rel of ["src/domain/gate/service.ts", "src/cli/confirm.ts", "src/cli/journal.ts"])
      expect(existsSync(path.join(ROOT, rel)), rel).toBe(false);
  });
  it("the gate directory holds only types.ts and README.md", () => {
    expect(readdirSync(path.join(SRC, "domain", "gate")).sort()).toEqual(["README.md", "types.ts"]);
  });
  it("no source file outside the gate's types names a write tool", () => {
    const gate = path.join(SRC, "domain", "gate", "types.ts");
    for (const f of tsFiles(SRC)) {
      if (f === gate) continue;
      const text = readFileSync(f, "utf8");
      for (const name of WRITE_TOOL_NAMES)
        expect(text.includes(name), `${path.relative(ROOT, f)}: ${name}`).toBe(false);
    }
  });
  it("the write host literal appears only in src/config/schema.ts (where the read-host override refuses it)", () => {
    const allowed = path.join(SRC, "config", "schema.ts");
    for (const f of tsFiles(SRC)) {
      if (f === allowed) continue;
      expect(readFileSync(f, "utf8").includes("lm-api-writes"), path.relative(ROOT, f)).toBe(false);
    }
    expect(ESPN_WRITE_HOST).toBe("lm-api-writes.fantasy.espn.com");
  });
  it("capabilities say read-only with literal false write flags", () => {
    const caps = espnCapabilities("faab", "2026-10-05T00:00:00Z");
    expect(caps.writes).toBe(false);
    expect(caps.write).toBe(NO_WRITES);
    expect(Object.values(NO_WRITES).every((v) => v === false)).toBe(true);
    expect(Object.isFrozen(NO_WRITES)).toBe(true);
  });
});

describe("declared constants match plan 02 §3.2–§4.4 and plan 07 §3.F", () => {
  it("three write kinds, seven tool names (a prepare/commit pair each, plus cancel)", () => {
    expect(WRITE_KINDS).toEqual(["lineup", "transaction", "trade"]);
    expect(WRITE_TOOL_NAMES).toHaveLength(7);
    for (const k of WRITE_KINDS) {
      expect(WRITE_TOOL_NAMES).toContain(`espn_prepare_${k}`);
      expect(WRITE_TOOL_NAMES).toContain(`espn_commit_${k}`);
    }
    expect(WRITE_TOOL_NAMES).toContain("espn_cancel_prepared");
  });
  it("four registration gates, two per-write limits, three channels in priority order", () => {
    expect(WRITE_REGISTRATION_GATES).toEqual(["env", "acknowledgement", "own_team", "credential"]);
    expect(WRITE_LIMITS).toEqual(["scope", "cap"]);
    expect(CONFIRMATION_CHANNELS).toEqual(["elicitation", "code", "cli"]);
  });
  it("gate constants", () => {
    expect(GATE_CONSTANTS).toEqual({
      preparedTtlMs: 600_000,
      maxWrongCodes: 3,
      dailyWriteCap: 5,
      kickoffFreezeMs: 900_000,
      codeDigits: 6,
      gateKeyBytes: 32,
      elicitationFallbackMs: 2000,
      maxLineupMoves: 20,
      maxTradeSide: 6,
    });
    expect(Object.isFrozen(GATE_CONSTANTS)).toBe(true);
  });
  it("the ticket HMAC covers the period and the precondition hash", () => {
    expect(TICKET_HMAC_FIELDS).toEqual([
      "prepared_id",
      "kind",
      "diff_hash",
      "precondition_hash",
      "period",
      "expires_at",
      "nonce",
    ]);
  });
  it("prepared ids are pw- + a Crockford ULID", () => {
    expect(PREPARED_ID_RE.test(`pw-${"0".repeat(26)}`)).toBe(true);
    for (const bad of [
      `pw-${"L".repeat(26)}`,
      `pw-${"0".repeat(27)}`,
      `rec-${"0".repeat(26)}`,
      `pw-${"a".repeat(26)}`,
    ])
      expect(PREPARED_ID_RE.test(bad), bad).toBe(false);
  });
  it("journal transitions: every state keyed, targets are states, the graph is acyclic", () => {
    expect(Object.keys(JOURNAL_TRANSITIONS).sort()).toEqual([...JOURNAL_STATES].sort());
    for (const [from, tos] of Object.entries(JOURNAL_TRANSITIONS))
      for (const to of tos) expect(JOURNAL_STATES, `${from}→${to}`).toContain(to);
    const seen = new Set<JournalState>();
    const visit = (s: JournalState, stack: Set<JournalState>): void => {
      expect(stack.has(s), `cycle at ${s}`).toBe(false);
      seen.add(s);
      for (const n of JOURNAL_TRANSITIONS[s]) visit(n, new Set([...stack, s]));
    };
    visit("prepared", new Set());
    expect(seen.size).toBe(JOURNAL_STATES.length);
  });
  it("prepared can be voided by a code or a cancel; only sent_unknown is reconciled", () => {
    expect(JOURNAL_TRANSITIONS.prepared).toEqual(
      expect.arrayContaining([
        "voided_code",
        "voided_cancelled",
        "voided_precondition",
        "denied",
        "expired",
        "sent",
      ]),
    );
    expect(JOURNAL_TRANSITIONS.sent_unknown).toEqual([
      "confirmed_applied",
      "confirmed_not_applied",
    ]);
    const nonTerminal = JOURNAL_STATES.filter((s) => JOURNAL_TRANSITIONS[s].length > 0);
    expect(nonTerminal).toEqual(["prepared", "sent", "sent_unknown"]);
  });
  it("the gate's error codes are in the error table, none retryable", () => {
    for (const c of GATE_ERROR_CODES) {
      expect(ERROR_CODES).toContain(c);
      expect(ERROR_TABLE[c].retryable, c).toBe(false);
    }
  });
});
