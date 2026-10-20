// interrupt.test.ts — the interrupt policy of every `eff` command but `serve` (src/cli/interrupt.ts;
// plan 03 §1.3, §1.4; Stage C finding cli-first-signal-swallowed: the entry's listeners took Node's
// default exit away from every command while only a refresh and the setup page acted on them, so
// the first SIGINT/SIGTERM did nothing). Held here: a policy nobody claims never listens; the first
// signal while a claim is held aborts every held claim, stops listening and ends nothing; any other
// signal ends the process by the default action, with 128 + n as the fallback when a raised signal
// is caught elsewhere; a claim after a signal is born aborted. A model property over random
// claim/release/signal sequences, and the real process (processSignalHost) in a child process.
import { spawn } from "node:child_process";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INTERRUPT_SIGNALS,
  NO_INTERRUPTS,
  createInterrupts,
  processSignalHost,
  signalExitCode,
  type InterruptClaim,
  type InterruptSignal,
} from "../../src/cli/interrupt.js";
import { ROOT } from "./helpers.js";
import { FakeSignalHost } from "./signal-host.js";

describe("the policy over a fake process", () => {
  it("nobody claims: no listener is ever installed, so every signal keeps Node's default action", () => {
    const host = new FakeSignalHost();
    createInterrupts(host);
    host.deliver("SIGINT");
    expect(host.events).toEqual(["ended SIGINT"]);
  });

  it("the first claim listens (once for every claim); the first signal aborts every held claim, stops listening, ends nothing", () => {
    const host = new FakeSignalHost();
    const interrupts = createInterrupts(host);
    const a = interrupts.claim();
    const b = interrupts.claim();
    expect(host.events).toEqual(["on SIGINT", "on SIGTERM"]);
    expect([a.signal.aborted, b.signal.aborted]).toEqual([false, false]);
    host.deliver("SIGTERM");
    expect([a.signal.aborted, b.signal.aborted]).toEqual([true, true]);
    expect(host.events).toEqual(["on SIGINT", "on SIGTERM", "off SIGINT", "off SIGTERM"]);
    expect(host.listening).toBe(false);
    expect(host.ended).toEqual([]);
  });

  it("a second signal while the scope is still stopping ends the process by the default action", () => {
    const host = new FakeSignalHost();
    const interrupts = createInterrupts(host);
    const claim = interrupts.claim();
    host.deliver("SIGINT");
    expect(claim.signal.aborted).toBe(true);
    expect(host.ended).toEqual([]);
    host.deliver("SIGINT");
    expect(host.ended).toEqual(["SIGINT"]);
    claim.release();
    expect(host.events.filter((e) => e.startsWith("on "))).toHaveLength(2);
  });

  for (const sig of INTERRUPT_SIGNALS)
    it(`a ${sig} after the last release ends the process: listeners removed, the signal raised, exit 128 + n only as the fallback`, () => {
      const host = new FakeSignalHost();
      const interrupts = createInterrupts(host);
      const claim = interrupts.claim();
      claim.release();
      // the listeners stay until a signal arrives: one already on its way is never dropped
      expect(host.listening).toBe(true);
      host.deliver(sig);
      expect(claim.signal.aborted).toBe(false);
      expect(host.events).toEqual([
        "on SIGINT",
        "on SIGTERM",
        "off SIGINT",
        "off SIGTERM",
        `raise ${sig}`,
        // raised with no listener left: the default action
        `ended ${sig}`,
        `exit ${String(signalExitCode(sig))}`,
      ]);
    });

  it("release ends only its own claim, and a second release is harmless", () => {
    const host = new FakeSignalHost();
    const interrupts = createInterrupts(host);
    const a = interrupts.claim();
    const b = interrupts.claim();
    a.release();
    a.release();
    host.deliver("SIGINT");
    expect([a.signal.aborted, b.signal.aborted]).toEqual([false, true]);
    expect(host.events.some((e) => e.startsWith("raise") || e.startsWith("ended"))).toBe(false);
  });

  it("a claim after a signal is born aborted and installs nothing; a later signal meets the default action", () => {
    const host = new FakeSignalHost();
    const interrupts = createInterrupts(host);
    const first = interrupts.claim();
    host.deliver("SIGTERM");
    first.release();
    const before = [...host.events];
    const late = interrupts.claim();
    expect(late.signal.aborted).toBe(true);
    late.release();
    expect(host.events).toEqual(before);
    host.deliver("SIGINT");
    expect(host.ended).toEqual(["SIGINT"]);
  });

  it("the exit codes are 128 + n: SIGINT 130, SIGTERM 143", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });

  it("NO_INTERRUPTS: claims that never abort, a harmless release", () => {
    const claim = NO_INTERRUPTS.claim();
    claim.release();
    claim.release();
    expect(claim.signal.aborted).toBe(false);
    expect(Object.isFrozen(NO_INTERRUPTS)).toBe(true);
  });
});

describe("the policy as a model (any claim/release/signal sequence)", () => {
  type Op =
    | { readonly kind: "claim" }
    | { readonly kind: "release"; readonly pick: number }
    | { readonly kind: "signal"; readonly sig: InterruptSignal };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.constant({ kind: "claim" as const }),
    fc.nat({ max: 7 }).map((pick) => ({ kind: "release" as const, pick })),
    fc.constantFrom(...INTERRUPT_SIGNALS).map((sig) => ({ kind: "signal" as const, sig })),
  );

  it("only the first signal can be absorbed, and only while a claim is held; a claim aborts iff it was held then or came after", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const host = new FakeSignalHost();
        const interrupts = createInterrupts(host);
        const claims: { claim: InterruptClaim; released: boolean; expectAborted: boolean }[] = [];
        let absorbedOne = false;
        let claimedBeforeAnySignal = false;
        let signals = 0;
        let expectedRaises = 0;
        for (const o of ops) {
          if (o.kind === "claim") {
            if (signals === 0) claimedBeforeAnySignal = true;
            claims.push({ claim: interrupts.claim(), released: false, expectAborted: absorbedOne });
            continue;
          }
          if (o.kind === "release") {
            const c = claims[o.pick % Math.max(1, claims.length)];
            if (c === undefined) continue;
            c.claim.release();
            c.released = true;
            continue;
          }
          const held = claims.filter((c) => !c.released);
          const absorbed = signals === 0 && held.length > 0;
          // a first signal nobody holds meets the policy's listener when a claim came and went
          // (it raises the signal again), else no listener at all (the default action directly)
          if (signals === 0 && !absorbed && claimedBeforeAnySignal) expectedRaises = 1;
          host.deliver(o.sig);
          signals++;
          if (!absorbed) {
            // ended by the default action, exactly once: the process is gone, the sequence ends
            expect(host.ended).toEqual([o.sig]);
            break;
          }
          expect(host.ended).toEqual([]);
          absorbedOne = true;
          for (const c of held) c.expectAborted = true;
        }
        for (const c of claims) expect(c.claim.signal.aborted).toBe(c.expectAborted);
        // the listeners are installed once, by a claim made before any signal, or never
        const ons = host.events.filter((e) => e.startsWith("on ")).length;
        expect(ons).toBe(claimedBeforeAnySignal ? INTERRUPT_SIGNALS.length : 0);
        // a signal is raised again only by the policy's listener finding no claim
        expect(host.events.filter((e) => e.startsWith("raise ")).length).toBe(expectedRaises);
      }),
      { numRuns: 300 },
    );
  });
});

describe("processSignalHost: the adapter", () => {
  it("maps on, off, raise and exit onto the process it is given", () => {
    const calls: string[] = [];
    const proc = {
      pid: 4242,
      on: (sig: string) => {
        calls.push(`on ${sig}`);
      },
      off: (sig: string) => {
        calls.push(`off ${sig}`);
      },
      kill: (pid: number, sig: string) => {
        calls.push(`kill ${String(pid)} ${sig}`);
        return true;
      },
      exit: (code: number) => {
        calls.push(`exit ${String(code)}`);
      },
    } as unknown as NodeJS.Process;
    const host = processSignalHost(proc);
    const l = (): void => undefined;
    host.on("SIGINT", l);
    host.off("SIGINT", l);
    host.raise("SIGTERM");
    host.exit(143);
    expect(calls).toEqual(["on SIGINT", "off SIGINT", "kill 4242 SIGTERM", "exit 143"]);
  });

  it("defaults to the running process: a listener it installs is the process's own", () => {
    const host = processSignalHost();
    const before = process.listenerCount("SIGTERM");
    const l = (): void => undefined;
    host.on("SIGTERM", l);
    try {
      expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    } finally {
      host.off("SIGTERM", l);
    }
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("processSignalHost: the real process (a child per case)", () => {
  const CHILD = path.join(ROOT, "tests", "cli", "procs", "interrupt-child.ts");
  function run(
    which: string,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", "tsx", CHILD, which], {
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
  }

  it("a claimed SIGINT aborts the scope; the next SIGINT ends the process by the signal", async () => {
    expect(await run("claimed")).toEqual({ code: null, signal: "SIGINT", out: "aborted\n" });
  }, 30_000);

  it("nothing claimed: no listener, and SIGTERM ends the process by Node's default", async () => {
    expect(await run("unclaimed")).toEqual({ code: null, signal: "SIGTERM", out: "listeners 0\n" });
  }, 30_000);

  it("after a release: the policy's listener finds no claim and the process ends by the signal", async () => {
    expect(await run("released")).toEqual({ code: null, signal: "SIGTERM", out: "listeners 1\n" });
  }, 30_000);

  it("a raised signal another listener catches: the process exits 143 all the same", async () => {
    expect(await run("caught-elsewhere")).toEqual({
      code: 143,
      signal: null,
      out: "foreign listener\n",
    });
  }, 30_000);
});
