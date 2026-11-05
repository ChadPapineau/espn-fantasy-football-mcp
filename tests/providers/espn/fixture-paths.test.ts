// fixture-paths.test.ts — src/providers/espn/fixture.ts: the recorded fixture fetch reads every
// manifest file through derivedFileText, the one resolver the derived fetch already used (the
// round-4d verifier's F1; CR-3's class). A recorded manifest whose entry names `../outside.json` or
// an absolute path fails at load; a symlinked file or subdirectory pointing out of the tree, or an
// oversized file, is a fixture_missing read — never the outside file's contents as ESPN's body.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DERIVED_FILE_MAX_BYTES,
  FixtureError,
  createFixtureFetch,
} from "../../../src/providers/espn/fixture.js";
import { resolveFixtureDir } from "../../../src/providers/espn/index.js";

const LEAGUE_PATH = "/apis/v3/games/ffl/seasons/2025/segments/0/leagues/0";
const URL_SETTINGS = `https://lm-api-reads.fantasy.espn.com${LEAGUE_PATH}?view=mSettings`;
const SECRET = "OUTSIDE-TREE";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A temp tree: <tmp>/outside.json (never served) and <tmp>/fx/manifest.json naming `rel`. */
function tree(rel: string, setup?: (fx: string, tmp: string) => void): string {
  const tmp = mkdtempSync(path.join(tmpdir(), "eff-fixture-paths-"));
  tmps.push(tmp);
  const fx = path.join(tmp, "fx");
  mkdirSync(fx);
  writeFileSync(path.join(tmp, "outside.json"), JSON.stringify({ secret: SECRET }));
  mkdirSync(path.join(tmp, "outdir"));
  writeFileSync(path.join(tmp, "outdir", "body.json"), JSON.stringify({ secret: SECRET }));
  setup?.(fx, tmp);
  const file = {
    path: rel,
    league: "league-a",
    status: 200,
    headers: { "content-type": "application/json" },
    request: { route: "league", path: LEAGUE_PATH, query: "view=mSettings", filter: null },
    part: null,
  };
  writeFileSync(path.join(fx, "manifest.json"), JSON.stringify({ files: [file] }));
  return fx;
}

async function answer(fx: string): Promise<unknown> {
  const f = createFixtureFetch({ dir: fx, league: "league-a" });
  const p = f(URL_SETTINGS, {});
  expect(p).toBeInstanceOf(Promise); // a refusal rejects, never throws out of fetch
  return p.then(
    async (r) => r.text(),
    (e: unknown) => e,
  );
}

describe("the recorded fixture fetch keeps every file inside its tree (F1)", () => {
  it("control: a file inside the tree is served", async () => {
    const fx = tree("recorded/league-a/mSettings.json", (d) => {
      mkdirSync(path.join(d, "recorded", "league-a"), { recursive: true });
      writeFileSync(path.join(d, "recorded", "league-a", "mSettings.json"), '{"ok":true}');
    });
    expect(await answer(fx)).toBe('{"ok":true}');
  });

  it.each([["../outside.json"], ["recorded/../../outside.json"], ["..\\outside.json"], [""]])(
    "a manifest naming %j fails at load, before any request",
    (rel) => {
      const fx = tree(rel);
      // the finding's scenario: EFF_FIXTURE_DIR resolves to this recorded tree
      expect(resolveFixtureDir(fx)).toMatchObject({ dir: fx, league: "league-a" });
      expect(() => createFixtureFetch({ dir: fx, league: "league-a" })).toThrow(
        /manifest path refused/,
      );
    },
  );

  it("an absolute path (POSIX or Windows form) fails at load", () => {
    for (const rel of [path.join(tmpdir(), "outside.json"), "C:\\outside.json"]) {
      const fx = tree(rel);
      expect(() => createFixtureFetch({ dir: fx, league: "league-a" })).toThrow(
        /manifest path refused/,
      );
    }
  });

  it("a symlinked file pointing out of the tree is fixture_missing, never its contents", async () => {
    const fx = tree("recorded/link.json", (d, tmp) => {
      mkdirSync(path.join(d, "recorded"));
      symlinkSync(path.join(tmp, "outside.json"), path.join(d, "recorded", "link.json"));
    });
    const e = await answer(fx);
    expect(e).toBeInstanceOf(FixtureError);
    expect((e as FixtureError).effDetails.reason).toBe("fixture_missing");
    expect((e as Error).message).not.toContain(SECRET);
  });

  it("a symlinked subdirectory pointing out of the tree is fixture_missing", async () => {
    const fx = tree("recorded/body.json", (d, tmp) => {
      symlinkSync(path.join(tmp, "outdir"), path.join(d, "recorded"));
    });
    const e = await answer(fx);
    expect(e).toBeInstanceOf(FixtureError);
    expect((e as FixtureError).effDetails.reason).toBe("fixture_missing");
  });

  it("a file over the size bound is refused before its bytes are read", async () => {
    const fx = tree("recorded/big.json", (d) => {
      mkdirSync(path.join(d, "recorded"));
      const big = path.join(d, "recorded", "big.json");
      writeFileSync(big, "");
      truncateSync(big, DERIVED_FILE_MAX_BYTES + 1); // sparse: no bytes written
    });
    const e = await answer(fx);
    expect(e).toBeInstanceOf(FixtureError);
    expect((e as FixtureError).effDetails.reason).toBe("fixture_missing");
    expect((e as Error).message).toContain("too large");
  });
});
