// types.test.ts — src/drift/types.ts (plan 01 §7; research 03 §A.2 P28 skeleton; plan 03 §1.3 exit 4):
// status precedence host_moved > red (removed key or changed enum set) > additive > green, the probe
// exit code, the required-paths seed covering every whitelisted view with no skeleton path, and the
// signal severities. A 100 %-coverage module (plan 05 §7: src/drift/**).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DRIFT_STATUSES, EXIT_CODES } from "../../src/config/schema.js";
import {
  DRIFT_EXIT_CODE,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_PATH,
  REQUIRED_PATHS_BY_VIEW,
  SIGNAL_SEVERITY,
  SKELETON_PATHS,
  SKELETON_TOP_LEVEL_KEYS,
  probeExitCode,
  reportStatus,
  type ViewDiff,
} from "../../src/drift/types.js";
import { ESPN_VIEWS } from "../../src/providers/espn/types.js";

const diff = (over: Partial<ViewDiff> = {}): ViewDiff => ({
  view: "mSettings",
  removed: [],
  added: [],
  enums: [],
  ...over,
});

describe("reportStatus", () => {
  it("green with nothing", () => {
    expect(reportStatus({ host_moved: false, diffs: [], additive: [] })).toBe("green");
    expect(reportStatus({ host_moved: false, diffs: [diff()], additive: [diff()] })).toBe("green");
  });
  it("host_moved wins over everything", () => {
    expect(
      reportStatus({
        host_moved: true,
        diffs: [diff({ removed: ["a"] })],
        additive: [diff({ added: ["b"] })],
      }),
    ).toBe("host_moved");
    expect(reportStatus({ host_moved: true, diffs: [], additive: [] })).toBe("host_moved");
  });
  it("red for a removed key or a changed enum set", () => {
    expect(
      reportStatus({ host_moved: false, diffs: [diff({ removed: ["settings.x"] })], additive: [] }),
    ).toBe("red");
    expect(
      reportStatus({ host_moved: false, diffs: [diff({ enums: ["status=NEW"] })], additive: [] }),
    ).toBe("red");
    expect(
      reportStatus({
        host_moved: false,
        diffs: [diff(), diff({ enums: ["x=Y"] })],
        additive: [diff({ added: ["z"] })],
      }),
    ).toBe("red");
  });
  it("additive for added keys only (in either list)", () => {
    expect(
      reportStatus({ host_moved: false, diffs: [], additive: [diff({ added: ["new"] })] }),
    ).toBe("additive");
    expect(
      reportStatus({ host_moved: false, diffs: [diff({ added: ["new"] })], additive: [] }),
    ).toBe("additive");
  });
  it("property: the status is the precedence maximum of its inputs", () => {
    const arb = fc.record({
      host_moved: fc.boolean(),
      diffs: fc.array(
        fc.record({
          view: fc.constantFrom(...ESPN_VIEWS),
          removed: fc.array(fc.constantFrom("a", "b"), { maxLength: 2 }),
          added: fc.array(fc.constantFrom("c"), { maxLength: 1 }),
          enums: fc.array(fc.constantFrom("e=F"), { maxLength: 1 }),
        }),
        { maxLength: 3 },
      ),
      additive: fc.array(
        fc.record({
          view: fc.constantFrom(...ESPN_VIEWS),
          removed: fc.constant([]),
          added: fc.array(fc.constantFrom("c"), { maxLength: 1 }),
          enums: fc.constant([]),
        }),
        { maxLength: 2 },
      ),
    });
    fc.assert(
      fc.property(arb, (r) => {
        const s = reportStatus(r);
        const red = r.diffs.some((d) => d.removed.length + d.enums.length > 0);
        const add = [...r.diffs, ...r.additive].some((d) => d.added.length > 0);
        const expected = r.host_moved ? "host_moved" : red ? "red" : add ? "additive" : "green";
        return s === expected;
      }),
    );
  });
});

describe("probeExitCode", () => {
  it.each([
    ["green", 0],
    ["additive", 0],
    ["red", 4],
    ["host_moved", 4],
  ] as const)("%s → %i", (s, code) => {
    expect(probeExitCode(s)).toBe(code);
  });
  it("covers every status and uses the shared exit-code table", () => {
    for (const s of DRIFT_STATUSES)
      expect([EXIT_CODES.ok, EXIT_CODES.drift]).toContain(probeExitCode(s));
    expect(DRIFT_EXIT_CODE).toBe(EXIT_CODES.drift);
    expect(DRIFT_EXIT_CODE).toBe(4);
  });
});

describe("the required-path seed (skeleton detection)", () => {
  it("covers exactly the whitelisted views", () => {
    expect(Object.keys(REQUIRED_PATHS_BY_VIEW).sort()).toEqual([...ESPN_VIEWS].sort());
  });
  it("every view requires at least one path, none of which a skeleton answer carries", () => {
    for (const [view, paths] of Object.entries(REQUIRED_PATHS_BY_VIEW)) {
      expect(paths.length, view).toBeGreaterThan(0);
      for (const p of paths) {
        expect(SKELETON_PATHS, `${view}: ${p}`).not.toContain(p);
        // a bare skeleton top-level key can never detect a renamed view
        expect(SKELETON_TOP_LEVEL_KEYS, `${view}: ${p}`).not.toContain(p);
        expect(p, `${view}: ${p}`).toMatch(
          /^(?:<root>\[\]|[A-Za-z]+(?:\[\])?(?:\.[A-Za-z]+(?:\[\])?)*)$/,
        );
      }
    }
  });
  it("skeleton paths start from skeleton top-level keys", () => {
    for (const p of SKELETON_PATHS)
      expect(SKELETON_TOP_LEVEL_KEYS, p).toContain(p.split(/[.[]/)[0]);
  });
});

describe("manifest and severities", () => {
  it("manifest location and version", () => {
    expect(MANIFEST_PATH).toBe("fixtures/espn/manifest.json");
    expect(MANIFEST_FORMAT_VERSION).toBe(1);
  });
  it("meaning-changing signals are errors; additive keys are counted", () => {
    expect(SIGNAL_SEVERITY).toEqual({
      missing_required_key: "error",
      skeleton: "error",
      meaning_changing_enum: "error",
      host_moved: "error",
      unknown_enum_value: "warning",
      additive_key: "count",
    });
  });
});
