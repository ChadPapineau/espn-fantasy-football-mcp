// interrupt-commands.test.ts — which `eff` commands claim SIGINT/SIGTERM (src/cli/main.ts
// `MainDeps.interrupts`, src/cli/interrupt.ts; Stage C finding cli-first-signal-swallowed: the
// entry listened for both signals for every command, so the first one did nothing to any command
// but a refresh and the setup page). Run through main with the process's policy over a fake
// process: every command but `refresh` and `setup --page` installs no listener at all, so the first
// signal ends it by Node's default action. A refresh holds a claim for its run: its first SIGINT,
// while a request hangs, ends that request at once (the fetch's own signal aborts as the signal is
// delivered), raises nothing, records no source failure, exits 1 and leaves no listener behind.
import type { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createInterrupts } from "../../src/cli/interrupt.js";
import { main } from "../../src/cli/main.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import type { FetchLike } from "../../src/http/client.js";
import { stateRow } from "../auth/helpers.js";
import { fakePackage, makeIo, noNetwork, sandbox, type Sandbox } from "./helpers.js";
import { FakeSignalHost } from "./signal-host.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

describe("no command but a refresh and the setup page claims SIGINT/SIGTERM", () => {
  it("every other command, run through main with the process's policy, installs no listener", async () => {
    sb = sandbox();
    const env = { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" };
    // the strict jobs gate on a rejected credential row before any request (as dispatch.test.ts)
    const rt = await loadLenientRuntime(makeIo(sb, { env }));
    const store = openStore(rt.config, makeIo(sb).clock, rt.log, { migrate: true });
    store.repos.credentialState.put(
      stateRow({ store: "file", state: "rejected", rejected_since: "2026-10-06T09:00:00.000Z" }),
    );
    store.close();
    const cases: readonly (readonly string[])[] = [
      ["version"],
      ["help"],
      ["status"],
      ["doctor", "--json"],
      ["check-auth", "--json"],
      ["credential-check"],
      ["snapshot", "roster"],
      ["transactions", "--force"],
      ["pre-kickoff"],
      ["crosswalk", "rebuild"],
      ["print-config", "--client", "code"],
      ["install-launchd", "--dry-run", "--jobs", "probe"],
      ["uninstall-launchd", "--dry-run"],
      ["backup"],
      ["prune"],
      ["uninstall", "--dry-run"],
      ["tune", "--json"],
      ["setup", "--seeding", "espn_rule"],
      // the terminal flow: its prompt reads a closed stdin and ends the run
      ["setup", "--storage", "file"],
      ["selftest-read", "--service", "eff-test-x-selftest"],
      ["nope"],
    ];
    for (const argv of cases) {
      const host = new FakeSignalHost();
      const io = makeIo(sb, { env, fetch: noNetwork, packageRoot: fakePackage(sb) });
      (io.stdin as PassThrough).end();
      const code = await main(argv, io, { interrupts: createInterrupts(host) });
      expect(Number.isInteger(code), argv.join(" ")).toBe(true);
      // no listener: a signal anywhere in this command meets Node's default action
      expect(host.events, argv.join(" ")).toEqual([]);
    }
  });

  it("a refresh claims the signals for its run: the first SIGINT ends the hung request at once and the run cleanly", async () => {
    sb = sandbox();
    const host = new FakeSignalHost();
    let calls = 0;
    let abortedAtOnce: boolean | null = null;
    // a hung ESPN request: it never settles and ignores its signal; the SIGINT arrives while it hangs
    const fetch: FetchLike = (_url, init) => {
      calls++;
      const own = init.signal;
      setImmediate(() => {
        host.deliver("SIGINT");
        abortedAtOnce = own?.aborted ?? null;
      });
      return new Promise<Response>(() => undefined);
    };
    const io = makeIo(sb, { fetch, packageRoot: fakePackage(sb) });
    const code = await main(["refresh", "espn:players", "--json"], io, {
      interrupts: createInterrupts(host),
    });
    expect(code).toBe(1);
    // one request: the abort is never retried, and the run's later steps never start
    expect(calls).toBe(1);
    // before the season GET passed the run's signal on, the request ran to its 15 s timeout
    expect(abortedAtOnce).toBe(true);
    // the claim absorbed the signal: nothing raised, no default action, the listeners gone
    expect(host.events).toEqual(["on SIGINT", "on SIGTERM", "off SIGINT", "off SIGTERM"]);
    expect(host.ended).toEqual([]);
    const out = JSON.parse(io.out.text) as {
      results: { source: string; status: string }[];
      crosswalk: boolean;
    };
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ source: "espn:players", status: "failed" });
    expect(out.crosswalk).toBe(false);
    // a cancel is not a source failure: the refresh log records nothing for it
    const rt = await loadLenientRuntime(makeIo(sb));
    const store = openStore(rt.config, makeIo(sb).clock, rt.log, { migrate: true });
    try {
      expect(store.repos.refreshLog.current().filter((r) => r.source === "espn:players")).toEqual(
        [],
      );
    } finally {
      store.close();
    }
  });

  it("a refresh that ends without a signal releases its claim: a later signal ends the process by the default action", async () => {
    sb = sandbox();
    const host = new FakeSignalHost();
    const io = makeIo(sb, { fetch: noNetwork, packageRoot: fakePackage(sb) });
    expect(
      await main(["refresh", "espn:players", "--json"], io, {
        interrupts: createInterrupts(host),
      }),
    ).toBe(1);
    expect(host.events).toEqual(["on SIGINT", "on SIGTERM"]);
    host.deliver("SIGTERM");
    expect(host.events.slice(2)).toEqual([
      "off SIGINT",
      "off SIGTERM",
      "raise SIGTERM",
      "ended SIGTERM",
      "exit 143",
    ]);
  });
});
