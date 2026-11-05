// fast-check-setup.test.ts — every fast-check property in the repo names its seed and path on
// failure (tests/setup/fast-check.ts, vitest `setupFiles`; the round-4b account: the seeding
// property failed once under a full coverage run and its counterexample was not captured). A
// failing property, sync or async, still throws fast-check's own report, and also writes one
// grep-able stderr line with the seed, the path and the counterexample; the seed it names replays
// the same failure. A passing property writes nothing.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../../vitest.config.js";
import { failureLine } from "../setup/fast-check.js";

const LINE =
  /^fast-check: property failed — seed (-?\d+), path "([\d:]+)" \(replay: FC_SEED=\1 FC_PATH=\2\); counterexample (.+)\n$/;

function captured(): { lines: () => string[] } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines: () => lines.filter((l) => l.startsWith("fast-check:")) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a failing property names its seed and path", () => {
  it("vitest runs the setup in every test file of both projects", () => {
    const setup = (config as { test?: { setupFiles?: unknown } }).test?.setupFiles;
    expect(setup).toEqual(["tests/setup/fast-check.ts"]);
  });

  it("sync: fast-check's error and the stderr line name the same seed; that seed replays the failure", () => {
    const err = captured();
    let message = "";
    try {
      fc.assert(fc.property(fc.nat(1000), (x) => x < 500));
    } catch (e) {
      message = (e as Error).message;
    }
    const lines = err.lines();
    vi.restoreAllMocks();
    expect(lines).toHaveLength(1);
    const m = LINE.exec(lines[0] ?? "");
    expect(m).not.toBeNull();
    expect(message).toContain(`seed: ${m?.[1] ?? "?"}`);
    expect(m?.[3]).toBe("[500]");
    // the named seed and path replay the same counterexample
    const again = fc.check(
      fc.property(fc.nat(1000), (x) => x < 500),
      {
        seed: Number(m?.[1]),
        path: m?.[2] ?? "",
      },
    );
    expect(again.failed).toBe(true);
    expect(again.counterexample).toEqual([500]);
  });

  it("async: the same line", async () => {
    const err = captured();
    await expect(
      fc.assert(fc.asyncProperty(fc.nat(1000), (x) => Promise.resolve(x < 500))),
    ).rejects.toThrow(/seed/);
    const lines = err.lines();
    vi.restoreAllMocks();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(LINE);
  });

  it("a passing property writes nothing", () => {
    const err = captured();
    fc.assert(fc.property(fc.nat(10), (x) => x <= 10));
    const lines = err.lines();
    vi.restoreAllMocks();
    expect(lines).toEqual([]);
    expect(failureLine({ failed: false } as unknown as fc.RunDetails<unknown>)).toBeNull();
  });
});
