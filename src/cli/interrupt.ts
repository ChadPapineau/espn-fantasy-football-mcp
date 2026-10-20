// interrupt.ts — what SIGINT and SIGTERM do to an `eff` command other than `serve` (plan 03 §1.3:
// `serve` installs its own shutdown handlers; §1.4 and §2.2: `eff setup --page` closes its page on
// SIGINT; launchd ends a job with SIGTERM, then SIGKILL). Stage C finding cli-first-signal-swallowed:
// the entry listened for both signals for every command, which takes Node's default exit away,
// while only a refresh and the setup page acted on them. The first Ctrl-C or SIGTERM to any other
// command (setup's prompt on a pipe, a backfill, an uninstall, a launchd job being booted out)
// did nothing; only a second one ended it.
//
// The rule: a signal keeps its default action (the process ends by it, as any program's does; a
// shell reports 128 + n), except while a scope that honours cancellation holds a claim.
//  - Only a claim listens. The first claim installs the listeners, so a command that claims nothing
//    never changes the process's signal handling: Node's own handler, which also restores the
//    terminal, stays in force.
//  - The first signal while a claim is held aborts every held claim's AbortSignal (the command stops
//    at its next check and exits by its own code) and removes the listeners, so a second signal
//    ends the process by the default action.
//  - After the last release the listeners stay until a signal arrives, so a signal already on its
//    way is never dropped. Such a signal finds no claim and ends the process by the default action:
//    the listeners are removed and the signal is raised again. Were it caught anyway (a listener
//    this module does not own), the process exits 128 + n.
//  - Once a signal has arrived, a new claim is born aborted.
// Once a listener has been installed, the default action is the kernel's: Node's handler, which
// restores the terminal mode, is gone. A scope that changes the terminal mode restores it itself
// (the setup prompt does; the claiming scopes never take the terminal).
import { constants } from "node:os";

/** The signals this policy governs (SIGHUP keeps Node's default; only `serve` handles it). */
export const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/** 128 + the signal's number: the status a shell reports for a process its signal ended. */
export function signalExitCode(sig: InterruptSignal): number {
  return 128 + constants.signals[sig];
}

/** The process surface the policy needs (src/cli.ts passes the real process; tests a fake). */
export interface SignalHost {
  on(sig: InterruptSignal, listener: () => void): void;
  off(sig: InterruptSignal, listener: () => void): void;
  /** Sends `sig` to this process; with no listener installed, its default action ends it. */
  raise(sig: InterruptSignal): void;
  /** Ends the process with `code` (reached only when a raised signal did not end it). */
  exit(code: number): void;
}

/** One scope's hold on SIGINT/SIGTERM. */
export interface InterruptClaim {
  /** Aborts on the first SIGINT/SIGTERM that arrives while this claim is held. */
  readonly signal: AbortSignal;
  /** Ends the hold (idempotent): call it where the scope ends, in a `finally`. */
  release(): void;
}

/** The claim source a command receives (src/cli/main.ts `MainDeps.interrupts`). */
export interface Interrupts {
  /** Claims the signals for one scope; born aborted when a signal has already arrived. */
  claim(): InterruptClaim;
}

/** Claims that never abort (in-process callers that wire no process: tests, the default). */
export const NO_INTERRUPTS: Interrupts = Object.freeze({
  claim: (): InterruptClaim => ({
    signal: new AbortController().signal,
    release: () => undefined,
  }),
});

/** The policy over `host` (one per process: src/cli.ts). */
export function createInterrupts(host: SignalHost): Interrupts {
  const held = new Set<AbortController>();
  let listening = false;
  let arrived = false;
  const listeners: Readonly<Record<InterruptSignal, () => void>> = {
    SIGINT: () => {
      onSignal("SIGINT");
    },
    SIGTERM: () => {
      onSignal("SIGTERM");
    },
  };

  function stopListening(): void {
    if (!listening) return;
    listening = false;
    for (const sig of INTERRUPT_SIGNALS) host.off(sig, listeners[sig]);
  }

  function onSignal(sig: InterruptSignal): void {
    arrived = true;
    // from here the next signal meets no listener: its default action ends the process
    stopListening();
    if (held.size > 0) {
      for (const c of [...held]) c.abort();
      return;
    }
    // no scope holds a claim: the signal ends the process as if nobody had listened
    host.raise(sig);
    host.exit(signalExitCode(sig));
  }

  return {
    claim(): InterruptClaim {
      const c = new AbortController();
      if (arrived) {
        c.abort();
        return { signal: c.signal, release: () => undefined };
      }
      held.add(c);
      if (!listening) {
        listening = true;
        for (const sig of INTERRUPT_SIGNALS) host.on(sig, listeners[sig]);
      }
      return {
        signal: c.signal,
        release: () => {
          held.delete(c);
        },
      };
    },
  };
}

/** The running process as a SignalHost (the entry's only use of it). */
export function processSignalHost(proc: NodeJS.Process = process): SignalHost {
  return {
    on: (sig, listener) => {
      proc.on(sig, listener);
    },
    off: (sig, listener) => {
      proc.off(sig, listener);
    },
    raise: (sig) => {
      proc.kill(proc.pid, sig);
    },
    exit: (code) => {
      proc.exit(code);
    },
  };
}
