// interrupt-child.ts — a child process for tests/cli/interrupt.test.ts: the interrupt policy over
// the REAL process (processSignalHost), one case per run (argv[2]). It signals itself and writes on
// stdout (synchronously: a signal may end it the next instant) what it saw before the signal ended
// it, or "survived" when nothing did within 2 s.
import { writeSync } from "node:fs";
import { createInterrupts, processSignalHost } from "../../../src/cli/interrupt.js";

const say = (line: string): void => {
  writeSync(1, `${line}\n`);
};
const self = (sig: NodeJS.Signals): void => {
  process.kill(process.pid, sig);
};
const interrupts = createInterrupts(processSignalHost());

switch (process.argv[2]) {
  // a scope holds a claim: the first SIGINT aborts it; the listeners went with it, so a second
  // SIGINT meets the default action
  case "claimed": {
    const claim = interrupts.claim();
    claim.signal.addEventListener("abort", () => {
      say("aborted");
      claim.release();
      self("SIGINT");
      say("survived the second signal");
    });
    self("SIGINT");
    break;
  }
  // nothing ever claimed: no listener exists, Node's default ends the process
  case "unclaimed":
    say(`listeners ${String(process.listenerCount("SIGTERM"))}`);
    self("SIGTERM");
    break;
  // a claim came and went: the policy still listens, finds no claim and ends the process by the
  // signal
  case "released":
    interrupts.claim().release();
    say(`listeners ${String(process.listenerCount("SIGTERM"))}`);
    self("SIGTERM");
    break;
  // a listener the policy does not own catches the raised signal: the policy exits 128 + n
  case "caught-elsewhere":
    process.on("SIGTERM", () => {
      say("foreign listener");
    });
    interrupts.claim().release();
    self("SIGTERM");
    break;
  default:
    say("unknown case");
    process.exit(2);
}
setTimeout(() => {
  say("survived");
}, 2000);
