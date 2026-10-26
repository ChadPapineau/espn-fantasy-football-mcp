// prompt-interrupt-child.ts — a child process for tests/cli/setup-interrupt.test.ts: the terminal
// prompt over a stand-in terminal (it says it is a TTY and records raw mode) in the REAL process,
// with its DEFAULT Ctrl-C action. One visible question is answered; then Ctrl-C arrives while no
// question waits (setup's checks and writes after the last answer). It writes on stdout,
// synchronously (the signal may end it the next instant), each raw-mode change and the answer; the
// process must then end by SIGINT, the signal the terminal driver would have sent with ISIG on. It
// writes "survived" when nothing ended it within 2 s.
import { writeSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { createTerminalPrompt } from "../../../src/cli/prompt.js";

const say = (line: string): void => {
  writeSync(1, `${line}\n`);
};

class StandInTty extends PassThrough {
  readonly isTTY = true;
  setRawMode(mode: boolean): this {
    say(`raw ${String(mode)}`);
    return this;
  }
}

const stdin = new StandInTty();
const screen = new Writable({
  write(_c, _e, cb) {
    cb();
  },
});
const prompt = createTerminalPrompt({ stdin, out: screen, takeTerminalNow: true });
// the question is shown once its input has been quiet for the flush window
const answer = prompt.ask("Q: ", { hidden: false, timeoutMs: 10_000 });
setTimeout(() => {
  stdin.emit("data", Buffer.from("y\r"));
}, 400);
const a = await answer;
say(`answered ${a.kind}`);
// no question waits now: Ctrl-C
stdin.emit("data", Buffer.from("\x03"));
setTimeout(() => {
  say("survived");
  process.exit(0);
}, 2_000);
