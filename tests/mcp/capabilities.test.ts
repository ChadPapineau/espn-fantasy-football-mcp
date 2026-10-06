// capabilities.test.ts — the server advertises `listChanged: false` for tools, resources and prompts
// in both eras (changelog R5): the sets are fixed at process start — no late registration and no
// notifications/*/list_changed (plan 01 §3.1, plan 02 §3.2, plan 03 §1.1 step 6, plan 07 §5.4) — so
// neither `initialize` (legacy) nor `server/discover` (2026-07-28) may advertise the SDK's default
// `true`, under either toolset.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_CAPABILITIES } from "../../src/mcp/server.js";
import { connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld({ publishEspn: false });
}, 120_000);
afterAll(() => {
  world.cleanup();
});

type Caps = Record<string, { listChanged?: boolean } | undefined>;
const FIXED = ["tools", "resources", "prompts"] as const;

describe("listChanged: false — the tool, resource and prompt sets never change mid-session", () => {
  it("the declared capabilities", () => {
    for (const k of FIXED) expect(SERVER_CAPABILITIES[k].listChanged).toBe(false);
  });

  it.each(["core", "full"] as const)(
    "legacy era: initialize advertises listChanged false (toolset %s)",
    async (toolset) => {
      const { client, close } = await connect(world, { options: { toolset } });
      const caps = client.getServerCapabilities() as Caps | undefined;
      for (const k of FIXED) expect(caps?.[k], k).toEqual({ listChanged: false });
      await close();
    },
  );

  it.each(["core", "full"] as const)(
    "2026-07-28 era: server/discover advertises listChanged false (toolset %s)",
    async (toolset) => {
      const { client, close } = await connect(world, { modern: true, options: { toolset } });
      expect(client.getProtocolEra()).toBe("modern");
      const d = client.getDiscoverResult() as unknown as { capabilities: Caps };
      for (const k of FIXED) expect(d.capabilities[k], k).toEqual({ listChanged: false });
      // and the lists still answer (the bit changes the advertisement, not the surface)
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
      expect((await client.listResources()).resources.length).toBeGreaterThan(0);
      await close();
    },
  );
});
