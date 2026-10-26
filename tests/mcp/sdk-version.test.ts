// sdk-version.test.ts — G1's `server.sdk_version` (plan 07 G1; README Ops "Server and SDK versions")
// is the MCP SDK the server actually runs on: the exact pin in package.json, the lockfile's entry and
// the installed package all agree with SDK_VERSION, and espn_get_status and espn-ff://status report
// it. src/mcp may not read files (plan 01 §1.1), so the constant is held to the package by this test,
// as src/version.ts is by tests/lint/package.test.ts. Stage C finding status-sdk-version-stale: the
// reviewed bump to 2.3.1 (changelog "Reviews") left the literal at 2.2.0 and no test noticed, so
// anyone checking the advisories with espn_get_status read that the vulnerable version was running.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SDK_VERSION } from "../../src/mcp/tools/ops.js";
import { ROOT, call, connect, makeWorld, type World } from "./helpers/world.js";

const SDK = "@modelcontextprotocol/server";

function json(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")) as Record<string, unknown>;
}

describe("SDK_VERSION is the SDK the server runs on (Stage C status-sdk-version-stale)", () => {
  it("equals package.json's exact pin, the lockfile's entry and the installed package", () => {
    const pkg = json("package.json") as { dependencies: Record<string, string> };
    expect(pkg.dependencies[SDK]).toMatch(/^\d+\.\d+\.\d+$/); // pinned exactly (plan 04 §2)
    expect(SDK_VERSION).toBe(pkg.dependencies[SDK]);
    const lock = json("package-lock.json") as {
      packages: Record<string, { version?: string } | undefined>;
    };
    expect(lock.packages[`node_modules/${SDK}`]?.version).toBe(SDK_VERSION);
    const installed = json(`node_modules/${SDK}/package.json`) as { version: string };
    expect(installed.version).toBe(SDK_VERSION);
  });

  describe("reported by G1 and its resource twin", () => {
    let world: World;
    let client: Client;
    let close: () => Promise<void>;
    beforeAll(async () => {
      world = await makeWorld({ publishEspn: false });
      ({ client, close } = await connect(world));
    }, 120_000);
    afterAll(async () => {
      await close();
      world.cleanup();
    });

    it("espn_get_status and espn-ff://status carry the pinned version", async () => {
      const pin = (json("package.json") as { dependencies: Record<string, string> }).dependencies[
        SDK
      ];
      const r = await call(client, "espn_get_status");
      expect(r.isError).toBe(false);
      expect((r.body.data as { server: { sdk_version: string } }).server.sdk_version).toBe(pin);
      const res = (await client.readResource({ uri: "espn-ff://status" })) as unknown as {
        contents: { text: string }[];
      };
      const env = JSON.parse(res.contents[0]?.text ?? "{}") as {
        data: { server: { sdk_version: string } };
      };
      expect(env.data.server.sdk_version).toBe(pin);
    });
  });
});
