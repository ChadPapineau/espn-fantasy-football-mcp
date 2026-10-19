// prompt.ts — the terminal prompt `eff setup` asks through (plan 03 §2.1 steps 2–3, 8: SWID echoed,
// espn_s2 with echo OFF — no dependency; each prompt waits 10 minutes; plan 02 §2.3: the value is
// never printed). Lines are queued as they arrive, so piped input that delivers several answers at
// once is never lost. History is disabled, so no value is kept in readline's history buffer. Also
// the y/N confirmation doctor --fix and uninstall ask.
//
// The echo rule (Stage C finding setup-hidden-prompt-echo-burst): on a terminal, nothing typed is
// ever drawn except a key that a VISIBLE question receives while it waits for its own line. Every
// key is read here (raw mode: the terminal driver does not echo) and routed, as it is read, to
// exactly one line editor (node:readline, fed key by key as readline feeds itself):
//  - a visible question gets a fresh editor of its own, drawing on the terminal; it receives only
//    the keys typed while it waits, up to its line break, and is closed with its line;
//  - every other key — typed ahead, the rest of a burst after a visible answer, a hidden answer —
//    goes to one muted editor whose output is discarded, always.
// So no editor that draws ever holds a key it did not draw: a redraw (Backspace, Ctrl-L, Ctrl-W), an
// undo (Ctrl-_) or a yank (Ctrl-Y) at a visible question can only show what was typed at it. (The
// first fix muted one shared editor at the right moments, but that editor kept an unfinished line
// read while muted — and its undo history and kill ring — and the next visible question drew it on
// its first edit key: a refused SWID pasted with espn_s2 and no final line break showed espn_s2 on
// Backspace. Before that, the mute was tied to the time a hidden answer was awaited, so a burst, a
// line break inside espn_s2, and type-ahead were drawn too.)
//
// A visible question that finds an unfinished muted line drops it, unshown, and says so
// (`DISCARDED_NOTE`); a hidden question takes it as the start of its answer and says it is waiting
// (`PENDING_NOTE`: a SWID and espn_s2 pasted as two lines with no final line break, then Enter).
// Keys typed before this process took the terminal were echoed by the terminal driver itself, which
// no program can prevent: an answer or a dropped line holding keys read before the first question
// says so (`TYPED_AHEAD_NOTE`), so the owner can clear the terminal's scrollback. `takeTerminalNow`
// takes the terminal at construction instead of at the first question. Ctrl-C, and Ctrl-D on an
// empty line, end the input; Ctrl-Z gives the terminal back and suspends, and SIGCONT takes it again
// (readline's own suspend would leave raw mode on the terminal it never read, and its resume left
// the input paused).
import { createInterface, emitKeypressEvents, type Interface, type Key } from "node:readline";
import { PassThrough, Writable } from "node:stream";
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
 * Said on a terminal when a hidden answer, or a dropped unfinished line, holds keys typed before the
 * first question was asked: keys typed before this process took the terminal were echoed by the
 * terminal driver, not by us.
 */
export const TYPED_AHEAD_NOTE =
  "(typed before the first question: if the terminal showed it as you typed, clear this terminal's scrollback and any session log)";

/**
 * Said on a terminal when a visible question drops an unfinished line typed while no visible
 * question waited (never drawn, so it cannot be edited where it would be seen).
 */
export const DISCARDED_NOTE =
  "(keys typed before this question, with no line break after them, were dropped unshown: answer here, and paste anything else again when it is asked for)";

/**
 * Said on a terminal when a hidden question finds an unfinished line typed while no visible question
 * waited: it becomes the start of this answer (a SWID and espn_s2 pasted as two lines with no final
 * line break), so pasting the value again would double it.
 */
export const PENDING_NOTE =
  "(keys typed before this question are waiting, unshown: press Enter to use them, or Ctrl-U and paste again)";

/** readline's window for the LF of a CR LF pair (its `crlfDelay` default and minimum). */
const CRLF_DELAY_MS = 100;

/** An output that draws nothing. */
function nowhere(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

/** A line editor fed key by key (`write(s, key)`, as readline feeds itself); it reads no stream. */
function lineEditor(output: Writable, prompt: string): Interface {
  return createInterface({
    input: new PassThrough(),
    output,
    terminal: true,
    historySize: 0,
    prompt,
  });
}

/** A line read while no question waited for it, and whether it holds keys read before the first. */
interface Queued {
  readonly line: string;
  readonly early: boolean;
}

/** The question waiting for its line. */
interface Waiter {
  readonly hidden: boolean;
  settle(a: PromptAnswer, early: boolean): void;
}

/**
 * A prompt over `stdin`/`out`. On a TTY only a visible question draws, and only the keys typed at
 * it (see the echo rule above); on a pipe nothing is echoed at all. `takeTerminalNow` opens the
 * reader at once (on a TTY: raw mode now, not at the first ask).
 */
export function createTerminalPrompt(io: {
  readonly stdin: NodeJS.ReadableStream;
  readonly out: NodeJS.WritableStream;
  readonly takeTerminalNow?: boolean;
}): TerminalPrompt {
  const terminal = isTty(io.stdin);
  const queue: Queued[] = [];
  let asked = false;
  let opened = false;
  let closed = false;
  let waiter: Waiter | null = null;

  // a line no question waited for is queued (the first MAX_QUEUED_LINES); `anyQuestion` false: only
  // a hidden question may take it as it arrives (a terminal's muted lines never answer a visible one
  // while it waits — that one reads its own keys)
  const deliver = (line: string, early: boolean, anyQuestion: boolean): void => {
    const w = waiter;
    if (w !== null && (anyQuestion || w.hidden)) {
      waiter = null;
      w.settle({ kind: "answer", value: line }, early);
    } else if (queue.length < MAX_QUEUED_LINES) queue.push({ line, early });
  };

  // ---- a pipe: one reader; readline draws input only on a terminal ------------------------------
  let pipe: Interface | null = null;

  // ---- a terminal -------------------------------------------------------------------------------
  // reads every key no visible question receives; its output goes nowhere, always
  let muted: Interface | null = null;
  // the muted editor's unfinished line holds a key read before the first question
  let mutedEarly = false;
  // the muted editor's next line is the unfinished line a visible question drops
  let dropMuted = false;
  // the waiting visible question's own editor
  let visible: Interface | null = null;
  let lastReturnAt = 0;

  const setRaw = (on: boolean): void => {
    const s = io.stdin as { setRawMode?: (mode: boolean) => unknown };
    if (typeof s.setRawMode === "function") s.setRawMode(on);
  };

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    if (opened && terminal) {
      io.stdin.removeListener("keypress", onKey);
      io.stdin.removeListener("end", shutdown);
      setRaw(false);
      io.stdin.pause();
    }
    const w = waiter;
    waiter = null;
    // a visible question closes its own editor
    w?.settle({ kind: "closed" }, false);
    muted?.close();
    pipe?.close();
  };

  // readline's own suspend, on the terminal this prompt reads: raw mode off first, on again after
  const suspend = (): void => {
    setRaw(false);
    process.once("SIGCONT", () => {
      if (!closed) setRaw(true);
    });
    process.kill(process.pid, "SIGTSTP");
  };

  // every key read on the terminal, in order, to exactly one editor
  function onKey(s: string | undefined, key: Key | undefined): void {
    if (closed) return;
    const k: Key = key ?? {};
    const plain = k.ctrl !== true && k.meta !== true && k.shift !== true;
    // the LF of a CR LF pair ends no second line, whichever editor took the CR (readline's rule)
    if (plain && k.name === "enter" && Date.now() - lastReturnAt <= CRLF_DELAY_MS) {
      lastReturnAt = 0;
      return;
    }
    lastReturnAt = plain && k.name === "return" ? Date.now() : 0;
    if (k.ctrl === true && k.name === "z" && process.platform !== "win32") {
      suspend();
      return;
    }
    if (visible !== null) {
      visible.write(s, k);
      return;
    }
    const m = muted;
    if (m === null) return;
    m.write(s, k);
    // a key read before the first question that stays in the unfinished line
    if (!asked && m.line !== "") mutedEarly = true;
  }

  const onMutedLine = (line: string): void => {
    const early = mutedEarly || !asked;
    mutedEarly = false;
    if (dropMuted) {
      dropMuted = false;
      return;
    }
    deliver(line, early, false);
  };

  const open = (): void => {
    if (opened || closed) return;
    opened = true;
    if (!terminal) {
      const r = createInterface({
        input: io.stdin,
        output: nowhere(),
        terminal: false,
        historySize: 0,
        prompt: "",
      });
      r.on("line", (line: string) => {
        deliver(line, !asked, true);
      });
      r.on("close", shutdown);
      pipe = r;
      return;
    }
    // raw mode first: from here the terminal driver echoes nothing
    setRaw(true);
    const m = lineEditor(nowhere(), "");
    m.on("line", onMutedLine);
    // Ctrl-C, or Ctrl-D on an empty line, read while no visible question waits
    m.on("close", shutdown);
    muted = m;
    emitKeypressEvents(io.stdin);
    io.stdin.on("keypress", onKey);
    io.stdin.on("end", shutdown);
    io.stdin.resume();
  };
  if (io.takeTerminalNow === true) open();

  // a visible question never edits a line it did not draw: an unfinished muted line is dropped
  const dropUnshown = (): void => {
    const m = muted;
    if (m === null || closed || m.line === "") return;
    const early = mutedEarly;
    // ends the muted line as Enter would (readline resets the line and its undo history); dropped
    dropMuted = true;
    m.write("\r");
    dropMuted = false;
    io.out.write(`${DISCARDED_NOTE}\n`);
    if (early) io.out.write(`${TYPED_AHEAD_NOTE}\n`);
  };

  const ask = (
    question: string,
    opts: { hidden: boolean; timeoutMs: number },
  ): Promise<PromptAnswer> => {
    open();
    asked = true;
    const queued = queue.shift();
    if (queued === undefined && terminal) {
      if (!opts.hidden) dropUnshown();
      else if (muted !== null && !closed && muted.line !== "") io.out.write(`${PENDING_NOTE}\n`);
    }
    io.out.write(question);
    if (queued !== undefined) {
      // a line read before this question was never drawn (nor its line break): end the question's
      // line here — on a pipe only after a hidden answer, as before
      if (opts.hidden || terminal) io.out.write("\n");
      if (opts.hidden && terminal && queued.early) io.out.write(`${TYPED_AHEAD_NOTE}\n`);
      return Promise.resolve({ kind: "answer", value: queued.line });
    }
    if (closed) return Promise.resolve({ kind: "closed" });
    if (opts.hidden || !terminal) {
      return new Promise<PromptAnswer>((resolve) => {
        const timer = setTimeout(() => {
          waiter = null;
          if (opts.hidden) io.out.write("\n");
          resolve({ kind: "timeout" });
        }, opts.timeoutMs);
        waiter = {
          hidden: opts.hidden,
          settle: (a, early) => {
            clearTimeout(timer);
            if (opts.hidden && a.kind === "answer") {
              // the line break the muted editor did not draw
              io.out.write("\n");
              if (terminal && early) io.out.write(`${TYPED_AHEAD_NOTE}\n`);
            }
            resolve(a);
          },
        };
      });
    }
    // a visible question on a terminal: an editor of its own draws the keys typed while it waits
    return new Promise<PromptAnswer>((resolve) => {
      let live = true;
      const screen = new Writable({
        write(chunk: Buffer | string, _enc, cb) {
          if (live) io.out.write(chunk);
          cb();
        },
      });
      // the question is its prompt, so a redraw keeps it in front of the line
      const v = lineEditor(screen, question);
      let settled = false;
      const finish = (a: PromptAnswer): void => {
        if (settled) return;
        settled = true;
        live = false;
        clearTimeout(timer);
        if (visible === v) visible = null;
        if (waiter === w) waiter = null;
        v.close();
        resolve(a);
      };
      const w: Waiter = {
        hidden: false,
        settle: (a) => {
          finish(a);
        },
      };
      v.on("line", (line: string) => {
        finish({ kind: "answer", value: line });
      });
      v.on("close", () => {
        if (settled) return;
        // Ctrl-C, or Ctrl-D on an empty line, at this question: the input ends
        finish({ kind: "closed" });
        shutdown();
      });
      const timer = setTimeout(() => {
        finish({ kind: "timeout" });
      }, opts.timeoutMs);
      visible = v;
      waiter = w;
    });
  };

  return {
    ask,
    async confirm(question, timeoutMs = CONFIRM_TIMEOUT_MS) {
      const a = await ask(`${question} [y/N] `, { hidden: false, timeoutMs });
      return a.kind === "answer" && /^y(es)?$/i.test(a.value.trim());
    },
    close() {
      shutdown();
    },
  };
}
