// status-dataset-refusal.test.ts — G1 espn_get_status and espn-ff://status/freshness judge each
// source's file against the dataset connection layer (StatusPort.datasetRefusal; src/store/datasets/
// connections.ts refuses a truncated, damaged or re-laid-out file and every reader then reads it as
// never loaded): a refused current file is unusable — freshness `never`, no rows, the refusal as
// `last_error` — with `eff refresh <source>` named, never "fresh" from refresh_log alone. Stage C
// finding status-damaged-dataset-reported-fresh: a half-truncated nflverse:stats_player_week read
// "fresh, 1168 rows" in the Step-0 snapshot while E2 and E1 warned it was not loaded. The port's
// answer is injected here; a bundle without the port reads every listed file as served. League-a
// with the nflverse excerpts published through the real runner; fixture mode, no network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServices } from "../../src/mcp/services.js";
import { refusedDatasetWarning } from "../../src/mcp/tools/ops.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

const SOURCE = "nflverse:stats_player_week";

let world: World;
let client: Client;
let close: () => Promise<void>;

interface Row {
  id: string;
  freshness: string;
  rows: number | null;
  last_error: string | null;
  last_success_at: string | null;
}

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
  ({ client, close } = await connect(world));
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** The services whose status port says the connection layer refuses `refused`. */
function refusing(refused: string, code = "dataset_unreadable"): McpServices {
  return {
    ...world.services,
    status: {
      ...world.services.status,
      datasetRefusal: (s) => (s === refused ? (code as "dataset_unreadable") : null),
    },
  };
}

async function sources(c: Client): Promise<{ rows: Row[]; warnings: string[] }> {
  const r = await call(c, "espn_get_status", {});
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return {
    rows: (r.body.data as { sources: Row[] }).sources,
    warnings: r.body.warnings as string[],
  };
}

describe("G1 reports a file the connection layer refuses as unusable (Stage C status-damaged-dataset-reported-fresh)", () => {
  it("control: the published file serves — fresh, its rows, no refusal", async () => {
    const got = await sources(client);
    const row = got.rows.find((x) => x.id === SOURCE);
    expect(row?.freshness).toBe("fresh");
    expect(row?.rows).toBeGreaterThan(0);
    expect(row?.last_error).toBeNull();
  });

  it("refused: freshness never, no rows, the refusal code, the refresh named — G1 and its resources", async () => {
    const c = await connect(world, { services: refusing(SOURCE) });
    try {
      const got = await sources(c.client);
      const row = got.rows.find((x) => x.id === SOURCE);
      expect(row).toMatchObject({
        freshness: "never",
        rows: null,
        last_error: "dataset_unreadable",
      });
      // the refresh that wrote it is still named: the next one republishes it
      expect(row?.last_success_at).not.toBeNull();
      expect(got.warnings).toContain(refusedDatasetWarning(SOURCE, "dataset_unreadable"));
      expect(refusedDatasetWarning(SOURCE, "dataset_unreadable")).toContain(
        `eff refresh ${SOURCE}`,
      );
      // every other source is untouched
      for (const r of got.rows.filter((x) => x.id !== SOURCE))
        expect(r.last_error === "dataset_unreadable").toBe(false);
      // the twin resources say the same
      for (const uri of ["espn-ff://status", "espn-ff://status/freshness"]) {
        const res = (await c.client.readResource({ uri })) as unknown as {
          contents: { text: string }[];
        };
        const env = JSON.parse(res.contents[0]?.text ?? "{}") as {
          data: { sources: Row[] };
          warnings: string[];
        };
        expect(
          env.data.sources.find((x) => x.id === SOURCE),
          uri,
        ).toMatchObject({
          freshness: "never",
          rows: null,
          last_error: "dataset_unreadable",
        });
        expect(env.warnings, uri).toContain(refusedDatasetWarning(SOURCE, "dataset_unreadable"));
      }
    } finally {
      await c.close();
    }
  });

  it("a source never refreshed stays `never` with no refusal line (the port is asked only for a current file)", async () => {
    let asked = 0;
    const s: McpServices = {
      ...world.services,
      status: {
        ...world.services.status,
        datasetRefusal: () => {
          asked++;
          return null;
        },
      },
    };
    const c = await connect(world, { services: s });
    try {
      const got = await sources(c.client);
      const never = got.rows.filter((x) => x.last_success_at === null);
      expect(never.length).toBeGreaterThan(0);
      for (const r of never) expect(r.freshness).toBe("never");
      expect(asked).toBe(got.rows.length - never.length);
    } finally {
      await c.close();
    }
  });
});
