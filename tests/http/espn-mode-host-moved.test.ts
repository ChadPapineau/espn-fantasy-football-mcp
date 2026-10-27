// espn-mode-host-moved.test.ts — src/http's ESPN mode judged against the server's classifier,
// through the CLI paths built on it (Stage C finding probe-same-host-redirect-green). Plan 01 §4.3
// and §7 ("Host answered 3xx / non-JSON → transport classifier → ESPN_HOST_MOVED"), plan 03 §5 #15
// ("a 3xx or non-JSON body → ESPN_HOST_MOVED") and plan 06 §1.2 (a host move notifies, always):
// when ESPN moves an API path on the read host — the season route answering 302 to another path on
// the same host — the server's provider, which follows no 3xx, answers ESPN_HOST_MOVED and records
// the move (breaker forced open, every ESPN-fact tool serving stale). The CLI's client followed that
// redirect, so `eff probe`, doctor #15 and `eff smoke` judged the redirected body green, and the
// probe's green run ended the move the server had recorded: drift_state flipped on every read and
// every probe, and no alarm ever fired. Every answer comes from an injected fetch over the recorded
// season fixture — no network, no cookie, temp directories only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onlineRows } from "../../src/cli/doctor-online.js";
import { EXIT } from "../../src/cli/exit.js";
import { hostProbe, probe, type ProbeCheck } from "../../src/cli/probe.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { smokeExit } from "../../src/cli/smoke.js";
import { openStore } from "../../src/cli/store-access.js";
import { ESPN_READ_HOST_DEFAULT } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import { applyProbe } from "../../src/drift/index.js";
import { createHttpClient, type FetchLike } from "../../src/http/client.js";
import { fakeExec, makeIo, movingClock, ROOT, sandbox, type Sandbox } from "../cli/helpers.js";
import { makeWorld, MemoryLimiterRepo } from "../providers/espn/helpers.js";

const HOST = ESPN_READ_HOST_DEFAULT;
const RECORDED = readFileSync(
  path.join(ROOT, "fixtures/espn/recorded/season/proTeamSchedules_wl.json"),
  "utf8",
);

let sb: Sandbox | null = null;
afterEach(() => {
  sb?.cleanup();
  sb = null;
});

/**
 * ESPN after a path move on the read host: every `/apis/v3/` URL answers `status` (default 302)
 * with a Location on the same host — `/apis/v4/`, same query — whose target serves the recorded
 * body; any other host (doctor #19's nflverse release timestamps) answers 200. Every URL asked for
 * is kept.
 */
function movedUpstream(
  status = 302,
  location: (u: URL) => string | null = (u) =>
    `https://${HOST}${u.pathname.replace("/apis/v3/", "/apis/v4/")}${u.search}`,
): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.hostname !== HOST)
      return Promise.resolve(new Response("2026-10-06 03:12:45 EDT", { status: 200 }));
    if (u.pathname.startsWith("/apis/v3/")) {
      const loc = location(u);
      return Promise.resolve(
        new Response(null, { status, headers: loc === null ? {} : { location: loc } }),
      );
    }
    return Promise.resolve(
      new Response(RECORDED, {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      }),
    );
  };
  return { fetch, urls };
}

/** The CLI's host probe (`eff probe`, doctor #14/#15, `eff smoke`) over `fetch`. */
function cliHostProbe(fetch: FetchLike): Promise<ProbeCheck> {
  return hostProbe(
    {
      http: createHttpClient({ fetch }),
      limiter: new MemoryLimiterRepo(),
      clock: fixedClock("2026-10-06T18:00:00.000Z"),
      host: HOST,
      observations: undefined,
      origin: "server",
    },
    2026,
  );
}

const asked = (urls: readonly string[], part: string): boolean =>
  urls.some((u) => u.includes(part));

describe("a path move on the read host: the server and the CLI judge it alike (ESPN_HOST_MOVED)", () => {
  it("the finding's scenario: the provider records the move, the CLI's probe agrees, and that probe run keeps it", async () => {
    const up = movedUpstream();
    // the server: its provider follows no 3xx — ESPN_HOST_MOVED, the move recorded
    const w = makeWorld({ fetch: up.fetch });
    await expect(w.provider.getProSchedule(2026)).rejects.toMatchObject({
      effCode: "ESPN_HOST_MOVED",
    });
    const server = w.drift.row;
    expect(server?.status).toBe("host_moved");
    expect(server?.host_moved_at).not.toBeNull();
    expect(w.provider.transportStatus().breaker_open).toBe(true);
    expect(up.urls).toHaveLength(1);
    // the CLI's host probe on the same upstream: host_moved after ONE request, never the target
    const check = await cliHostProbe(up.fetch);
    expect(check).toMatchObject({
      name: "host",
      status: "host_moved",
      reason: "redirect_refused",
      upstream_status: null,
    });
    expect(up.urls).toHaveLength(2);
    expect(asked(up.urls, "/apis/v4/")).toBe(false);
    // that probe run, applied to the server's row, keeps the move (it used to end it: green)
    const after = applyProbe(server ?? null, [check], null, HOST, "2026-10-06T18:00:00.000Z");
    expect(after.row.status).toBe("host_moved");
    expect(after.row.host_moved_at).toBe(server?.host_moved_at);
    // `eff smoke`'s verdict on that probe: exit 4, drift or a moved host (plan 03 §1.3)
    expect(smokeExit([], [check])).toBe(EXIT.drift);
  });

  it("every 3xx the read host answers, wherever it points: the provider says ESPN_HOST_MOVED and the CLI's probe host_moved", async () => {
    const locations: [string, (u: URL) => string | null][] = [
      ["another path on the read host", (u) => `https://${HOST}/apis/v4/x${u.search}`],
      ["the same URL with another query", (u) => `${u.href}&moved=1`],
      ["the old host's marketing page", () => "https://www.espn.com/fantasy/"],
      ["no Location", () => null],
    ];
    let checked = 0;
    for (let status = 300; status <= 399; status++)
      for (const [what, location] of locations) {
        const up = movedUpstream(status, location);
        const w = makeWorld({ fetch: up.fetch });
        const served = await w.provider.getProSchedule(2026).then(
          () => "served",
          (e: unknown) => (e as { effCode?: string }).effCode,
        );
        expect(served, `${String(status)} ${what}: provider`).toBe("ESPN_HOST_MOVED");
        const check = await cliHostProbe(up.fetch);
        expect(check.status, `${String(status)} ${what}: probe`).toBe("host_moved");
        expect(
          applyProbe(w.drift.row, [check], null, HOST, "2026-10-06T18:00:00.000Z").row.status,
        ).toBe("host_moved");
        expect(up.urls, `${String(status)} ${what}: one request each`).toHaveLength(2);
        checked++;
      }
    expect(checked).toBe(100 * locations.length);
  });

  it("eff probe --notify after the server recorded the move: exit 4, drift_state stays host_moved, one alarm", async () => {
    sb = sandbox();
    const up = movedUpstream();
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, { fetch: up.fetch, clock: movingClock(), platform: "darwin", exec });
    const { config, log } = await loadLenientRuntime(io);
    // the server's provider on the store the probe reads (its limiter, cache and drift_state rows)
    let movedAt: string | null = null;
    let store = openStore(config, io.clock, log, { migrate: true });
    try {
      const w = makeWorld({
        fetch: up.fetch,
        over: {
          repos: {
            limiter: store.repos.limiter,
            cache: store.repos.espnCache,
            driftState: store.repos.driftState,
          },
        },
      });
      await expect(w.provider.getProSchedule(config.season)).rejects.toMatchObject({
        effCode: "ESPN_HOST_MOVED",
      });
      const row = store.repos.driftState.get();
      expect(row?.status).toBe("host_moved");
      movedAt = row?.host_moved_at ?? null;
      expect(movedAt).not.toBeNull();
    } finally {
      store.close();
    }
    // the launchd drift probe (`eff probe --notify`) on the same upstream
    expect(await probe(io, config, log, { hostOnly: true, notify: true, json: true })).toBe(
      EXIT.drift,
    );
    const doc = JSON.parse(io.out.text) as {
      status: string;
      drift_state: string;
      checks: { name: string; status: string; reason: string | null }[];
    };
    expect(doc).toMatchObject({ status: "host_moved", drift_state: "host_moved" });
    expect(doc.checks[0]).toMatchObject({
      name: "host",
      status: "host_moved",
      reason: "redirect_refused",
    });
    store = openStore(config, io.clock, log, { migrate: true });
    try {
      expect(store.repos.driftState.get()).toMatchObject({
        status: "host_moved",
        host_moved_at: movedAt,
      });
    } finally {
      store.close();
    }
    // the drift alarm fires (plan 06 §1.2: a moved host always notifies), naming the move
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.join(" ")).toContain("ESPN host moved");
    expect(asked(up.urls, "/apis/v4/")).toBe(false);
  });

  it("eff doctor --online: row #15 says ESPN_HOST_MOVED, not that the read host answers with the expected shape", async () => {
    sb = sandbox();
    const up = movedUpstream();
    const io = makeIo(sb, { fetch: up.fetch, clock: movingClock() });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      const rows = await onlineRows(io, config, store, log);
      const r15 = rows.find((r) => r.n === 15);
      expect(r15).toMatchObject({ id: "host_probe", status: "drift" });
      expect(r15?.message).toContain("ESPN_HOST_MOVED");
    } finally {
      store.close();
    }
    expect(asked(up.urls, "/apis/v4/")).toBe(false);
  });
});
