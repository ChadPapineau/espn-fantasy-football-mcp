// prompt.ts — the terminal prompt `eff setup` asks through (plan 03 §2.1 steps 2–3, 8: SWID echoed,
// espn_s2 with echo OFF via a muted readline output stream — no dependency; each prompt waits 10
// minutes; plan 02 §2.3: the value is never printed). Lines are queued as they arrive, so piped
// input that delivers several answers at once is never lost. History is disabled, so the hidden
// value is not kept in readline's history buffer. Also the y/N confirmation doctor --fix and
// uninstall ask.
//
// The echo rule (Stage C finding setup-hidden-prompt-echo-burst): on a terminal readline draws every
// character it reads through `sink`, and it reads a whole input chunk in one synchronous pass —
// several lines of one paste, a line break inside a pasted value, keys typed ahead. The echo is
// therefore OFF by default and ON only while a VISIBLE question waits for its line; it goes off
// again inside the 'line' handler — the same synchronous step that completes that line, before
// readline reads the next character of the chunk. So a line typed ahead, the rest of a burst after
// a visible answer, and every character of a hidden answer are never drawn. Until now the echo was
// muted only while a hidden answer was awaited, so a SWID and espn_s2 pasted together, the tail of
// an espn_s2 split by a line break, and type-ahead were drawn in clear. `takeTerminalNow` takes the
// terminal (raw mode: the terminal driver stops echoing) at construction instead of at the first
// question, so keys typed while setup starts are read here, muted. What was typed before the
// process took the terminal has already been echoed by the terminal driver itself; no program can
// prevent that.
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { PromptAnswer, SetupPrompt } from "../auth/setup.js";
import { isTty } from "./io.js";

/** A prompt that can be closed (releases stdin so the process can exit). */
export interface TerminalPrompt extends SetupPrompt {
  /** Asks a y/N question; anything but y/yes (or a closed input, or a timeout) is no. */
  confirm(question: string, timeoutMs?: number): Promise<boolean>;
  close(): void;
}

/** The default y/N wait. */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/** Most lines kept while no question waits (piped input with several answers). */
export const MAX_QUEUED_LINES = 16;

/**
 * A prompt over `stdin`/`out`. On a TTY readline echoes typed characters through `out` only while
 * a visible question waits for its line (see the echo rule above); on a pipe nothing is echoed at
 * all. `takeTerminalNow` opens the reader at once (on a TTY: raw mode now, not at the first ask).
 */
export function createTerminalPrompt(io: {
  readonly stdin: NodeJS.ReadableStream;
  readonly out: NodeJS.WritableStream;
  readonly takeTerminalNow?: boolean;
}): TerminalPrompt {
  // true only while a visible question waits for its line
  let echo = false;
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (echo) io.out.write(chunk);
      cb();
    },
  });
  const terminal = isTty(io.stdin);
  let rl: Interface | null = null;
  const queue: string[] = [];
  let closed = false;
  let waiter: ((a: PromptAnswer) => void) | null = null;

  const open = (): Interface => {
    if (rl !== null) return rl;
    const r = createInterface({
      input: io.stdin,
      output: sink,
      terminal,
      historySize: 0,
      prompt: "",
    });
    r.on("line", (line: string) => {
      // first: the rest of this input chunk is read after this handler returns, and none of it
      // may be drawn (the next visible question turns the echo on again)
      echo = false;
      const w = waiter;
      if (w !== null) {
        waiter = null;
        w({ kind: "answer", value: line });
      } else if (queue.length < MAX_QUEUED_LINES) queue.push(line);
    });
    r.on("close", () => {
      closed = true;
      echo = false;
      const w = waiter;
      waiter = null;
      w?.({ kind: "closed" });
    });
    rl = r;
    return r;
  };
  if (io.takeTerminalNow === true) open();

  const ask = (
    question: string,
    opts: { hidden: boolean; timeoutMs: number },
  ): Promise<PromptAnswer> => {
    open();
    io.out.write(question);
    const queued = queue.shift();
    if (queued !== undefined) {
      // a line read before this question was never drawn (nor its line break): end the question's
      // line here — on a pipe only after a hidden answer, as before
      if (opts.hidden || terminal) io.out.write("\n");
      return Promise.resolve({ kind: "answer", value: queued });
    }
    if (closed) return Promise.resolve({ kind: "closed" });
    return new Promise<PromptAnswer>((resolve) => {
      const timer = setTimeout(() => {
        waiter = null;
        echo = false;
        if (opts.hidden) io.out.write("\n");
        resolve({ kind: "timeout" });
      }, opts.timeoutMs);
      waiter = (a) => {
        clearTimeout(timer);
        // the newline the muted echo swallowed
        if (opts.hidden && a.kind === "answer") io.out.write("\n");
        resolve(a);
      };
      // only a visible question's own line is drawn; the 'line' handler turns it off again
      echo = !opts.hidden;
    });
  };

  return {
    ask,
    async confirm(question, timeoutMs = CONFIRM_TIMEOUT_MS) {
      const a = await ask(`${question} [y/N] `, { hidden: false, timeoutMs });
      return a.kind === "answer" && /^y(es)?$/i.test(a.value.trim());
    },
    close() {
      echo = false;
      rl?.close();
      rl = null;
    },
  };
}
