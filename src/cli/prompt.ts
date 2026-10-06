// prompt.ts — the terminal prompt `eff setup` asks through (plan 03 §2.1 steps 2–3, 8: SWID echoed,
// espn_s2 with echo OFF via a muted readline output stream — no dependency; each prompt waits 10
// minutes; plan 02 §2.3: the value is never printed). Lines are queued as they arrive, so piped
// input that delivers several answers at once is never lost. History is disabled, so the hidden
// value is not kept in readline's history buffer. Also the y/N confirmation doctor --fix and
// uninstall ask.
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

/**
 * A prompt over `stdin`/`out`. On a TTY readline echoes typed characters through `out`, which is
 * muted while a hidden answer is read; on a pipe nothing is echoed at all.
 */
export function createTerminalPrompt(io: {
  readonly stdin: NodeJS.ReadableStream;
  readonly out: NodeJS.WritableStream;
}): TerminalPrompt {
  let muted = false;
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (!muted) io.out.write(chunk);
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
      const w = waiter;
      if (w !== null) {
        waiter = null;
        w({ kind: "answer", value: line });
      } else if (queue.length < 16) queue.push(line);
    });
    r.on("close", () => {
      closed = true;
      const w = waiter;
      waiter = null;
      w?.({ kind: "closed" });
    });
    rl = r;
    return r;
  };

  const ask = (
    question: string,
    opts: { hidden: boolean; timeoutMs: number },
  ): Promise<PromptAnswer> => {
    open();
    io.out.write(question);
    const queued = queue.shift();
    if (queued !== undefined) {
      if (opts.hidden) io.out.write("\n");
      return Promise.resolve({ kind: "answer", value: queued });
    }
    if (closed) return Promise.resolve({ kind: "closed" });
    muted = opts.hidden;
    return new Promise<PromptAnswer>((resolve) => {
      const timer = setTimeout(() => {
        waiter = null;
        muted = false;
        if (opts.hidden) io.out.write("\n");
        resolve({ kind: "timeout" });
      }, opts.timeoutMs);
      waiter = (a) => {
        clearTimeout(timer);
        muted = false;
        // the newline the muted echo swallowed
        if (opts.hidden && a.kind === "answer") io.out.write("\n");
        resolve(a);
      };
    });
  };

  return {
    ask,
    async confirm(question, timeoutMs = CONFIRM_TIMEOUT_MS) {
      const a = await ask(`${question} [y/N] `, { hidden: false, timeoutMs });
      return a.kind === "answer" && /^y(es)?$/i.test(a.value.trim());
    },
    close() {
      muted = false;
      rl?.close();
      rl = null;
    },
  };
}
