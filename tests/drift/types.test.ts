// types.test.ts — src/drift/types.ts (plan 01 §7; research 03 §A.2 P28 skeleton; plan 03 §1.3 exit 4):
// status precedence host_moved > red (removed key or changed enum set) > additive > green, the probe
// exit code, the required-paths seed evaluated against the RECORDED skeleton (absent) and each
// recorded fixture of the view (present) (B2), the one manifest typed exactly and parsed (B1), and
// the signal severities. A 100 %-coverage module (plan 05 §7: src/drift/**).
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import committed from "../../fixtures/drift/manifest.json" with { type: "json" };
import { contentSha256, type Json } from "../../scripts/espn-fixture/canonical.js";
import {
  parsePattern,
  requiredPathStatus,
  validateManifest,
} from "../../scripts/espn-fixture/drift.js";
import { DEFAULT_MANIFEST, loadManifest } from "../../scripts/probe.js";
import { DRIFT_STATUSES, EXIT_CODES } from "../../src/config/schema.js";
import {
  DRIFT_EXIT_CODE,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_HASH_ALGORITHM,
  MANIFEST_PATH,
  REQUIRED_PATHS_BY_VIEW,
  REQUIRED_PATHS_UNVERIFIED,
  type DriftManifest,
  SIGNAL_SEVERITY,
  SKELETON_PATHS,
  SKELETON_TOP_LEVEL_KEYS,
  probeExitCode,
  reportStatus,
  type ViewDiff,
} from "../../src/drift/types.js";
import { ESPN_VIEWS } from "../../src/providers/espn/types.js";
import { ROOT } from "../lint/helpers.js";

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

describe("the required-path seed (skeleton detection, B2)", () => {
  const REC = path.join(ROOT, "fixtures", "espn", "recorded");
  const load = (rel: string) =>
    JSON.parse(readFileSync(path.join(ROOT, "fixtures", rel), "utf8")) as Json;
  const skeleton = load("espn/recorded/league-a/skeleton.json");
  const seasonSkeleton = load("espn/recorded/season/skeleton.json");
  const { manifest } = loadManifest(DEFAULT_MANIFEST);

  it("covers exactly the whitelisted views, in the probe manifest's pattern notation", () => {
    expect(Object.keys(REQUIRED_PATHS_BY_VIEW).sort()).toEqual([...ESPN_VIEWS].sort());
    for (const [view, paths] of Object.entries(REQUIRED_PATHS_BY_VIEW)) {
      expect(paths.length, view).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p, `${view}: ${p}`).toMatch(/^\$(?:\[\]|(?:\.[A-Za-z_]+(?:\[\])?)+)$/);
        expect(() => parsePattern(p), p).not.toThrow();
      }
    }
  });

  it("every required path is ABSENT from the recorded skeletons (a renamed view is caught)", () => {
    for (const [view, paths] of Object.entries(REQUIRED_PATHS_BY_VIEW))
      for (const p of paths) {
        expect(requiredPathStatus(skeleton, p), `${view}: ${p} (league skeleton)`).toBe("absent");
        expect(requiredPathStatus(seasonSkeleton, p), `${view}: ${p} (season skeleton)`).toBe(
          "absent",
        );
      }
  });

  it("every required path is PRESENT in each recorded fixture of its view (manifest views)", () => {
    const verified = Object.entries(manifest.views).filter(
      ([view]) => !(REQUIRED_PATHS_UNVERIFIED as readonly string[]).includes(view),
    );
    expect(verified.map(([v]) => v).sort()).toEqual([
      "kona_player_info",
      "mBoxscore",
      "mMatchup",
      "mNav",
      "mRoster",
      "mSettings",
      "mTeam",
      "proTeamSchedules_wl",
    ]);
    for (const [view, vm] of verified)
      for (const rel of vm.sources)
        for (const p of REQUIRED_PATHS_BY_VIEW[view as keyof typeof REQUIRED_PATHS_BY_VIEW])
          expect(requiredPathStatus(load(rel), p), `${view}: ${p} in ${rel}`).toBe("present");
  });

  it("required ⊆ the manifest's observed keys for every recorded view (plan 05 §3.3)", () => {
    for (const [view, vm] of Object.entries(manifest.views)) {
      if ((REQUIRED_PATHS_UNVERIFIED as readonly string[]).includes(view)) continue;
      for (const p of REQUIRED_PATHS_BY_VIEW[view as keyof typeof REQUIRED_PATHS_BY_VIEW]) {
        if (p.endsWith("[]")) continue;
        const dot = p.lastIndexOf(".");
        expect(vm.observed[p.slice(0, dot)] ?? [], `${view}: ${p}`).toContain(p.slice(dot + 1));
      }
    }
  });

  it("mNav's one key is not supplied by its composite partners (mTeam, mSettings) — B2", () => {
    for (const rel of [
      "league-a/mTeam.json",
      "league-a/mSettings.json",
      "league-b/mTeam.json",
      "league-c/mTeam.json",
    ]) {
      const body = JSON.parse(readFileSync(path.join(REC, rel), "utf8")) as Json;
      expect(requiredPathStatus(body, "$.members[].isLeagueCreator"), rel).toBe("absent");
    }
    expect(manifest.probes.shape.required["$.members[]"]).toMatchObject({
      isLeagueCreator: "boolean",
    });
  });

  it("the probe's required sets contain the seed for every view it requests (one notation)", () => {
    for (const probe of [manifest.probes.host, manifest.probes.shape])
      for (const view of probe.views)
        for (const p of REQUIRED_PATHS_BY_VIEW[view as keyof typeof REQUIRED_PATHS_BY_VIEW]) {
          const dot = p.lastIndexOf(".");
          expect(Object.keys(probe.required[p.slice(0, dot)] ?? {}), `${view}: ${p}`).toContain(
            p.slice(dot + 1),
          );
        }
  });

  it("SKELETON_PATHS are exactly what the recorded league skeleton carries; none is required", () => {
    for (const p of SKELETON_PATHS) {
      expect(requiredPathStatus(skeleton, p), p).toBe("present");
      expect(SKELETON_TOP_LEVEL_KEYS, p).toContain(p.slice(2).split(/[.[]/)[0]);
      for (const [view, paths] of Object.entries(REQUIRED_PATHS_BY_VIEW))
        expect(paths, `${view} requires a skeleton path ${p}`).not.toContain(p);
    }
    expect(Object.keys(skeleton as object).sort()).toEqual(
      SKELETON_TOP_LEVEL_KEYS.filter((k) => k !== "draftDetail"),
    );
  });

  it("REQUIRED_PATHS_UNVERIFIED only names views without a solo recording (the list can only shrink)", () => {
    const solo = new Set(
      (
        JSON.parse(readFileSync(path.join(ROOT, "fixtures", "espn", "manifest.json"), "utf8")) as {
          files: { views: string[]; status: number }[];
        }
      ).files
        .filter((f) => f.status === 200 && f.views.length === 1)
        .map((f) => f.views[0]),
    );
    for (const v of REQUIRED_PATHS_UNVERIFIED) expect(solo.has(v), v).toBe(false);
  });
});

describe("manifest and severities", () => {
  it("ONE manifest: the probe's file, typed exactly by DriftManifest, parsed and validated", () => {
    expect(MANIFEST_PATH).toBe("fixtures/drift/manifest.json");
    expect(path.join(ROOT, MANIFEST_PATH)).toBe(DEFAULT_MANIFEST);
    expect(MANIFEST_FORMAT_VERSION).toBe(1);
    expect(MANIFEST_HASH_ALGORITHM).toBe("sha256-canonical-json");
    const parsed: DriftManifest = committed;
    expect(parsed.version).toBe(MANIFEST_FORMAT_VERSION);
    expect(() => {
      validateManifest(JSON.parse(readFileSync(path.join(ROOT, MANIFEST_PATH), "utf8")));
    }).not.toThrow();
    const { sha256 } = loadManifest(DEFAULT_MANIFEST);
    expect(sha256).toBe(contentSha256(JSON.parse(readFileSync(DEFAULT_MANIFEST, "utf8")) as Json));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
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
