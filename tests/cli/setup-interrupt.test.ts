// setup-interrupt.test.ts — Ctrl-C after `eff setup`'s questions stops it before anything more is
// stored or sent (plan 03 §1.3, §2.1; src/cli/interrupt.ts: a signal ends a command by its default
// action unless a scope claims it). Ruling R7-3 holds the terminal in raw mode for the whole of setup,
// and raw mode turns the driver's ISIG off: Ctrl-C arrives as a byte, never as SIGINT. Stage C finding
// setup-raw-mode-ctrl-c-ignored: once the last answer was in, no question waited, so every Ctrl-C was
// read and dropped while setup ran its keychain self-test, wrote config.json and the credential, and
// sent the cookie to ESPN — and exited 0. The prompt now gives the terminal back and raises SIGINT
// itself while no question waits; at a question Ctrl-C still ends the input.
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEspnS2 } from "../../scripts/ci/secret-fixtures.mjs";
import { SETUP_TEXT, runSetup } from "../../src/auth/setup.js";
import type { KeychainSelftestResult } from "../../src/auth/selftest.js";
import { FLUSH_QUIET_MS, HIDDEN_SETTLE_MS, createTerminalPrompt } from "../../src/cli/prompt.js";
import { MemoryStateRepo, MemoryStore, RecordingRegistrar } from "../auth/helpers.js";
import { FakeTty, Screen } from "./fake-tty.js";
import { ROOT } from "./helpers.js";

const SWID = "{00000000-0000-4000-8000-000000000001}";
const S2 = fakeEspnS2("cli-setup-interrupt", 228);

describe("the prompt's Ctrl-C (fake time, a fake terminal)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("with no question waiting: the terminal given back, then the interrupt — once; later questions answer closed", async () => {
    const stdin = new FakeTty();
    const screen = new Screen();
    const interrupt = vi.fn();
    const p = createTerminalPrompt({ stdin, out: screen, takeTerminalNow: true, interrupt });
    const a = p.ask("Q: ", { hidden: false, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(FLUSH_QUIET_MS);
    stdin.type("y\r");
    expect(await a).toEqual({ kind: "answer", value: "y" });
    expect(interrupt).not.toHaveBeenCalled();
    stdin.type("\x03");
    expect(interrupt).toHaveBeenCalledTimes(1);
    // the driver's modes are back BEFORE the signal (a process ended by it leaves no raw terminal)
    expect(stdin.rawCalls).toEqual([true, false]);
    stdin.type("\x03");
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(await p.ask("Q: ", { hidden: true, timeoutMs: 60_000 })).toEqual({ kind: "closed" });
    p.close();
    expect(stdin.rawCalls).toEqual([true, false]);
  });

  it("at a question (visible, hidden, still flushing) Ctrl-C ends the input and raises nothing", async () => {
    for (const [hidden, shown] of [
      [false, true],
      [true, true],
      [true, false],
    ] as const) {
      const stdin = new FakeTty();
      const interrupt = vi.fn();
      const p = createTerminalPrompt({
        stdin,
        out: new Screen(),
        takeTerminalNow: true,
        interrupt,
      });
      const a = p.ask("Q: ", { hidden, timeoutMs: 60_000 });
      if (shown) await vi.advanceTimersByTimeAsync(FLUSH_QUIET_MS);
      stdin.type("\x03");
      expect(await a).toEqual({ kind: "closed" });
      expect(interrupt).not.toHaveBeenCalled();
      p.close();
    }
  });

  it("before the first question (the terminal taken at start): Ctrl-C is the interrupt", () => {
    const stdin = new FakeTty();
    const interrupt = vi.fn();
    const p = createTerminalPrompt({ stdin, out: new Screen(), takeTerminalNow: true, interrupt });
    stdin.type("\x03");
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(stdin.rawCalls).toEqual([true, false]);
    p.close();
  });

  it("setup itself: Ctrl-C during the keychain self-test comes before every store write and every ESPN request", async () => {
    const stdin = new FakeTty();
    const screen = new Screen();
    const events: string[] = [];
    const interrupt = vi.fn(() => {
      events.push("SIGINT");
    });
    const prompt = createTerminalPrompt({ stdin, out: screen, takeTerminalNow: true, interrupt });
    const keychain = new MemoryStore("keychain");
    const file = new MemoryStore("file");
    const realWrite = keychain.write.bind(keychain);
    keychain.write = (c, m) => {
      events.push("keychain.write");
      return realWrite(c, m);
    };
    let finishSelftest: ((r: KeychainSelftestResult) => void) | null = null;
    const note = (name: string) => (): Promise<{ status: number }> => {
      events.push(name);
      return Promise.resolve({ status: 200 });
    };
    const run = runSetup(
      {
        reset: false,
        storage: null,
        serviceName: null,
        leagueId: "0",
        season: 2026,
        recordedStore: null,
        filePath: "/nonexistent/session.json",
      },
      {
        prompt,
        out: (l) => screen.write(`${l}\n`),
        now: () => new Date().toISOString(),
        stores: { keychain, file },
        runSelftest: () => {
          events.push("selftest.start");
          return new Promise((resolve) => {
            finishSelftest = resolve;
          });
        },
        network: {
          anonymousSettings: note("anonymousSettings"),
          anonymousBoard: note("anonymousBoard"),
          settingsWithCookies: note("settingsWithCookies"),
          boardWithCookies: note("boardWithCookies"),
          resolveTeam: () => {
            events.push("resolveTeam");
            return Promise.resolve({ kind: "none" as const });
          },
        },
        config: {
          record: () => {
            events.push("config.record");
            return Promise.resolve();
          },
        },
        credentialState: new MemoryStateRepo(),
        registrar: new RecordingRegistrar(),
      },
    );
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    const waitFor = async (s: string): Promise<void> => {
      for (let t = 0; t < 20_000 && !screen.text.includes(s); t += 10) await tick(10);
    };
    await waitFor(SETUP_TEXT.askSwid);
    stdin.type(`${SWID}\r`);
    await waitFor(SETUP_TEXT.askEspnS2);
    stdin.type(`${S2}\r`);
    await tick(HIDDEN_SETTLE_MS + 10);
    for (let t = 0; t < 2_000 && !events.includes("selftest.start"); t += 10) await tick(10);
    expect(events).toContain("selftest.start");
    // the owner aborts while the self-test runs (up to 10 s on a real Mac)
    stdin.type("\x03");
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(stdin.rawCalls.at(-1)).toBe(false);
    // the real process ends by that SIGINT; here the run is let go on to show the order
    (finishSelftest as ((r: KeychainSelftestResult) => void) | null)?.({
      outcome: "ok",
      reason: "ok",
      code: null,
      at: new Date().toISOString(),
      cleanup: "deleted",
    });
    await tick(1_000);
    await run;
    const sigint = events.indexOf("SIGINT");
    expect(sigint).toBeGreaterThan(events.indexOf("selftest.start"));
    for (const later of [
      "keychain.write",
      "config.record",
      "anonymousSettings",
      "settingsWithCookies",
      "resolveTeam",
    ])
      if (events.includes(later)) expect(events.indexOf(later), later).toBeGreaterThan(sigint);
    prompt.close();
  });
});

describe("the default: a real SIGINT (a child process)", () => {
  it("Ctrl-C with no question waiting ends the process by SIGINT, the terminal given back first", async () => {
    const child = path.join(ROOT, "tests", "cli", "procs", "prompt-interrupt-child.ts");
    const r = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      out: string;
    }>((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", "tsx", child], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr.resume();
      p.on("error", reject);
      p.on("close", (code, signal) => {
        resolve({ code, signal, out });
      });
    });
    expect(r).toEqual({
      code: null,
      signal: "SIGINT",
      out: "raw true\nanswered answer\nraw false\n",
    });
  }, 30_000);
});
