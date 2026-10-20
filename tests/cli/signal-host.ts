// signal-host.ts — a fake process for the interrupt policy (src/cli/interrupt.ts; Stage C finding
// cli-first-signal-swallowed). It records every listener change, raise and exit in order, and it
// delivers a signal as the process would: to the listeners installed at that moment, or, with none,
// by the default action, which it records in `ended` (the real process would be gone).
import type { InterruptSignal, SignalHost } from "../../src/cli/interrupt.js";

export class FakeSignalHost implements SignalHost {
  /** `on SIGINT`, `off SIGTERM`, `raise SIGINT`, `exit 130`, `ended SIGINT`, in order. */
  readonly events: string[] = [];
  /** The signals whose default action ended the (fake) process: no listener was installed. */
  readonly ended: InterruptSignal[] = [];
  private readonly listeners = new Map<InterruptSignal, (() => void)[]>();
  /** Called after each listener is installed (a test delivers a signal "while the scope waits"). */
  onListen: ((sig: InterruptSignal) => void) | null = null;

  on(sig: InterruptSignal, listener: () => void): void {
    this.events.push(`on ${sig}`);
    this.listeners.set(sig, [...(this.listeners.get(sig) ?? []), listener]);
    this.onListen?.(sig);
  }

  off(sig: InterruptSignal, listener: () => void): void {
    this.events.push(`off ${sig}`);
    this.listeners.set(
      sig,
      (this.listeners.get(sig) ?? []).filter((l) => l !== listener),
    );
  }

  raise(sig: InterruptSignal): void {
    this.events.push(`raise ${sig}`);
    this.deliver(sig);
  }

  exit(code: number): void {
    this.events.push(`exit ${String(code)}`);
  }

  /** Delivers `sig`: every listener installed now, in order; none → the default action. */
  deliver(sig: InterruptSignal): void {
    const now = [...(this.listeners.get(sig) ?? [])];
    if (now.length === 0) {
      this.events.push(`ended ${sig}`);
      this.ended.push(sig);
      return;
    }
    for (const l of now) l();
  }

  /** Whether any listener is installed. */
  get listening(): boolean {
    return [...this.listeners.values()].some((ls) => ls.length > 0);
  }

  /** Delivers `sig` once, on the next turn, after the next listener installation. */
  deliverWhenListening(sig: InterruptSignal): void {
    this.onListen = () => {
      this.onListen = null;
      setImmediate(() => {
        this.deliver(sig);
      });
    };
  }
}
