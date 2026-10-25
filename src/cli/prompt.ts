// prompt.ts — the terminal prompt `eff setup` asks through (plan 03 §2.1 steps 2–3, 8: SWID echoed,
// espn_s2 with echo OFF — no dependency; each prompt waits 10 minutes; plan 02 §2.3: the value is
// never printed). Also the y/N confirmation `eff doctor --fix` and `eff uninstall` ask, and the word
// `eff tune` asks for. On a pipe, lines are queued as they arrive, so piped input that delivers
// several answers at once is never lost, and nothing is echoed.
//
// On a terminal (Stage C finding setup-hidden-prompt-echo-burst, ruling R7-3 — three fixes each
// closed one paste pattern and the next round found another, so the approach changed):
//  - ECHO is OFF at the terminal driver for the prompt's whole life: raw mode, taken when `eff setup`
//    builds the prompt (`takeTerminalNow`) or at the first question, and given back on close. There
//    is no line editor — no node:readline, so no redraw, no undo, no kill ring, no history: this
//    module reads the bytes itself and draws nothing it was not asked to.
//  - Only a VISIBLE question draws, and only the characters typed at it, one by one as they are read
//    (Backspace and Ctrl-U erase what it drew; every other control key and escape sequence is
//    ignored). A question that names the shape of its answer (`echo`: the SWID) draws a character
//    only while the line can still be one, so a value pasted at the wrong question is not drawn
//    either.
//  - Every question is asked on a quiet input: whatever was read before it — keys typed ahead, the
//    rest of an earlier answer's paste — is discarded unshown, and so is every byte that arrives
//    until the input has been quiet for FLUSH_QUIET_MS (Node has no tcflush; this is how the
//    terminal's own buffer is drained). Before espn_s2 this is the ruling's "all pending input is
//    discarded"; before a visible question it keeps the rest of a paste from being typed at it.
//  - A HIDDEN answer is never drawn. It is refused and asked again when it holds a line break — more
//    than blanks after its line break, in the same read or within HIDDEN_SETTLE_MS — and when it is
//    empty, so the rest of a paste meets the hidden question again (after its flush), never a
//    visible one.
// Keys typed before this process took the terminal were echoed by the terminal driver itself, which
// no program can prevent: a question that discards keys read before the first question says so
// (TYPED_AHEAD_NOTE), so the owner can clear the scrollback. Ctrl-C, and Ctrl-D on an empty line at a
// question, end the input; Ctrl-Z gives the terminal back and suspends, and takes it again right
// after (and on SIGCONT: readline's own suspend left raw mode on a terminal it no longer read).
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { AskOptions, PromptAnswer, SetupPrompt } from "../auth/setup.js";
import { isTty } from "./io.js";

/** A prompt that can be closed (releases stdin so the process can exit). */
export interface TerminalPrompt extends SetupPrompt {
  /** Asks a y/N question; anything but y/yes (or a closed input, or a timeout) is no. */
  confirm(question: string, timeoutMs?: number): Promise<boolean>;
  close(): void;
}

/** The default y/N wait. */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/** Most lines kept while no question waits (a pipe with several answers). */
export const MAX_QUEUED_LINES = 16;

/**
 * Said on a terminal when a question discards keys read before the first question was asked: keys
 * typed before this process took the terminal were echoed by the terminal driver, not by us.
 */
export const TYPED_AHEAD_NOTE =
  "(typed before the first question: if the terminal showed it as you typed, clear this terminal's scrollback and any session log)";

/**
 * Said on a terminal when a question discards keys that reached it before it was asked (typed
 * ahead, or the rest of an earlier paste still arriving): never drawn, never an answer.
 */
export const DISCARDED_NOTE =
  "(keys that reached this question before it was asked were dropped unshown: answer here, and paste anything else again when it is asked for)";

/** Said when a hidden answer is refused for a line break: nothing of it was kept. */
export const HIDDEN_REFUSED_NOTE =
  "(that paste held a line break or more than one value: nothing of it was kept — paste the value alone, then press Enter)";

/** Said when a hidden answer is refused because nothing was entered. */
export const HIDDEN_EMPTY_NOTE = "(nothing was entered: paste the value, then press Enter)";

/** Said when a visible answer held characters its question did not draw (not its shape). */
export const NOT_SHOWN_NOTE =
  "(the rest of that line was not shown: it is not the shape this question asks for)";

/**
 * How long the input must have been quiet before a question is asked: until then every byte read is
 * discarded. No person reads a new question and answers it this fast; the rest of one paste (a read
 * the kernel split, a slow link) arrives within it.
 */
export const FLUSH_QUIET_MS = 250;

/** The longest a question waits for the input to go quiet (keys still arriving are then its own). */
export const FLUSH_MAX_MS = 5_000;

/** How long after a hidden answer's line break more input refuses it (the rest of a paste). */
export const HIDDEN_SETTLE_MS = 250;

/** The longest line kept; characters past it are ignored (espn_s2 is at most 4096). */
export const MAX_LINE_CHARS = 16_384;

/** The window for the LF of a CR LF pair arriving in a later read (readline's `crlfDelay`). */
const CRLF_DELAY_MS = 100;

/** A y/N answer's shape: a prefix of yes or no (confirm draws nothing else). */
export function yesNoShape(line: string): boolean {
  return /^[ \t]*(?:y(?:e(?:s)?)?|n(?:o)?)?[ \t]*$/i.test(line);
}

/** An output that draws nothing. */
function nowhere(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

/**
 * A prompt over `stdin`/`out`: on a terminal only a visible question draws, and only the keys typed
 * at it (see the header); on a pipe nothing is echoed at all. `takeTerminalNow` opens the reader at
 * once (on a terminal: raw mode now, not at the first question).
 */
export function createTerminalPrompt(io: {
  readonly stdin: NodeJS.ReadableStream;
  readonly out: NodeJS.WritableStream;
  readonly takeTerminalNow?: boolean;
}): TerminalPrompt {
  return isTty(io.stdin) ? terminalPrompt(io) : pipePrompt(io);
}

/** The y/N question over any `ask`. */
function confirmOver(
  ask: SetupPrompt["ask"],
): (question: string, timeoutMs?: number) => Promise<boolean> {
  return async (question, timeoutMs = CONFIRM_TIMEOUT_MS) => {
    const a = await ask(`${question} [y/N] `, { hidden: false, timeoutMs, echo: yesNoShape });
    return a.kind === "answer" && /^y(es)?$/i.test(a.value.trim());
  };
}

// ---- a pipe -------------------------------------------------------------------------------------

/** On a pipe: one line reader, lines queued as they arrive, nothing echoed. */
function pipePrompt(io: {
  readonly stdin: NodeJS.ReadableStream;
  readonly out: NodeJS.WritableStream;
  readonly takeTerminalNow?: boolean;
}): TerminalPrompt {
  const queue: string[] = [];
  let opened = false;
  let closed = false;
  let reader: Interface | null = null;
  let waiter: ((a: PromptAnswer) => void) | null = null;

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    const w = waiter;
    waiter = null;
    w?.({ kind: "closed" });
    reader?.close();
  };
  const open = (): void => {
    if (opened || closed) return;
    opened = true;
    const r = createInterface({
      input: io.stdin,
      output: nowhere(),
      terminal: false,
      historySize: 0,
      prompt: "",
    });
    r.on("line", (line: string) => {
      const w = waiter;
      if (w !== null) {
        waiter = null;
        w({ kind: "answer", value: line });
      } else if (queue.length < MAX_QUEUED_LINES) queue.push(line);
    });
    r.on("close", shutdown);
    reader = r;
  };
  if (io.takeTerminalNow === true) open();

  const ask = (question: string, opts: AskOptions): Promise<PromptAnswer> => {
    open();
    io.out.write(question);
    const queued = queue.shift();
    if (queued !== undefined) {
      // a line read before this question: end its line after a hidden answer, as a terminal would
      if (opts.hidden) io.out.write("\n");
      return Promise.resolve({ kind: "answer", value: queued });
    }
    if (closed) return Promise.resolve({ kind: "closed" });
    return new Promise<PromptAnswer>((resolve) => {
      const timer = setTimeout(() => {
        waiter = null;
        if (opts.hidden) io.out.write("\n");
        resolve({ kind: "timeout" });
      }, opts.timeoutMs);
      waiter = (a) => {
        clearTimeout(timer);
        if (opts.hidden && a.kind === "answer") io.out.write("\n");
        resolve(a);
      };
    });
  };
  return {
    ask,
    confirm: confirmOver(ask),
    close() {
      shutdown();
    },
  };
}

// ---- a terminal ---------------------------------------------------------------------------------

/** What the bytes read now go to. */
type Mode =
  /** No question is waiting, or its input is not quiet yet: everything read is discarded. */
  | { readonly kind: "discard" }
  /** A visible question: its line, how many of its characters it drew, and its shape (null: none). */
  | {
      readonly kind: "visible";
      readonly line: string[];
      drawn: number;
      readonly echo: ((line: string) => boolean) | null;
    }
  /** A hidden question: its line (never drawn). */
  | { readonly kind: "hidden"; readonly line: string[] }
  /** A hidden answer whose line break was read: anything but blanks now refuses it. */
  | { readonly kind: "settle"; readonly line: string[] };

/** The question being asked (one at a time). */
interface Asking {
  readonly question: string;
  readonly opts: AskOptions;
  /** The question has been written (its input went quiet). */
  shown: boolean;
  finish(a: PromptAnswer): void;
}

/** A blank: what may follow a hidden answer's line break without refusing it. */
const isBlank = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\n";

/** A control character: never inserted, never drawn (Backspace, Ctrl-U, Ctrl-D are handled first). */
const isControl = (c: string): boolean => {
  const n = c.codePointAt(0) ?? 0;
  return n < 0x20 || n === 0x7f || (n >= 0x80 && n < 0xa0);
};

/** On a terminal (see the header). */
function terminalPrompt(io: {
  readonly stdin: NodeJS.ReadableStream;
  readonly out: NodeJS.WritableStream;
  readonly takeTerminalNow?: boolean;
}): TerminalPrompt {
  const out = io.out;
  const decoder = new StringDecoder("utf8");
  let opened = false;
  // the input ended (Ctrl-C, Ctrl-D at an empty line, end of file): every question answers closed
  let ended = false;
  // the terminal was given back (close): its own modes, no longer read
  let released = false;
  // a question has been asked (keys read before then may have been echoed by the terminal driver)
  let asked = false;
  let mode: Mode = { kind: "discard" };
  let asking: Asking | null = null;
  let lastByteAt = Number.NEGATIVE_INFINITY;
  let lastCrAt = Number.NEGATIVE_INFINITY;
  // characters discarded since the last question's notes, and whether one was read before the first
  let discarded = 0;
  let discardedEarly = false;
  // an escape sequence being skipped: after ESC, inside CSI (ESC [ … final), or SS3 (ESC O x)
  let esc: "esc" | "csi" | "ss3" | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  // a SIGCONT listener is waiting (at most one, however many Ctrl-Z)
  let contPending = false;

  const setRaw = (on: boolean): void => {
    const s = io.stdin as { setRawMode?: (mode: boolean) => unknown };
    if (typeof s.setRawMode === "function") s.setRawMode(on);
  };
  const clearTimers = (): void => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    if (settleTimer !== null) clearTimeout(settleTimer);
    flushTimer = null;
    settleTimer = null;
  };

  /**
   * The input ended: the waiting question and every later one answer closed. The terminal stays raw
   * and is still read — what arrives is dropped — until close(), so echo stays off for the caller's
   * whole run and nothing typed is left unread for the shell after it (a paste would run as a
   * command there).
   */
  const endInput = (): void => {
    if (ended) return;
    ended = true;
    clearTimers();
    const a = asking;
    asking = null;
    mode = { kind: "discard" };
    a?.finish({ kind: "closed" });
  };

  /** Gives the terminal back: its own modes, no longer read. */
  const release = (): void => {
    if (released) return;
    released = true;
    endInput();
    if (opened) {
      io.stdin.removeListener("data", onData);
      io.stdin.removeListener("end", endInput);
      setRaw(false);
      io.stdin.pause();
    }
  };

  // Ctrl-Z: raw mode off, stop, raw mode on again. A stop that happens returns from kill only once
  // continued; a stop the system discards (an orphaned process group, SIGTSTP ignored) returns at once
  // — either way raw mode is taken again right after, so the driver never echoes while a question
  // waits; SIGCONT takes it again too, after a shell restored its own modes on `fg`
  const suspend = (): void => {
    setRaw(false);
    if (!contPending) {
      contPending = true;
      process.once("SIGCONT", () => {
        contPending = false;
        if (!released) setRaw(true);
      });
    }
    try {
      process.kill(process.pid, "SIGTSTP");
    } finally {
      if (!released) setRaw(true);
    }
  };

  /** Discards what was read, then — once the input has been quiet FLUSH_QUIET_MS — runs `then`. */
  const flushThen = (then: () => void): void => {
    mode = { kind: "discard" };
    const started = Date.now();
    const check = (): void => {
      flushTimer = null;
      if (ended) return;
      const now = Date.now();
      const quiet = now - lastByteAt;
      if (quiet < FLUSH_QUIET_MS && now - started < FLUSH_MAX_MS) {
        flushTimer = setTimeout(check, Math.max(1, FLUSH_QUIET_MS - quiet));
        return;
      }
      then();
    };
    check();
  };

  /** Says what the flush dropped (once per question), then asks `a`'s question on a quiet input. */
  const present = (a: Asking, note: string | null): void => {
    flushThen(() => {
      if (asking !== a) return;
      // a refusal's note covers the rest of the refused paste; anything else dropped is said
      if (note !== null) out.write(`${note}\n`);
      else if (discarded > 0) out.write(`${DISCARDED_NOTE}\n`);
      if (discarded > 0 && discardedEarly) out.write(`${TYPED_AHEAD_NOTE}\n`);
      discarded = 0;
      discardedEarly = false;
      out.write(a.question);
      a.shown = true;
      mode = a.opts.hidden
        ? { kind: "hidden", line: [] }
        : { kind: "visible", line: [], drawn: 0, echo: a.opts.echo ?? null };
    });
  };

  /** A hidden answer refused: its line ended, said, and the hidden question asked again. */
  const refuseHidden = (note: string): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    const a = asking;
    mode = { kind: "discard" };
    out.write("\n");
    if (a !== null) present(a, note);
  };

  /** The settle window passed: the hidden answer stands (or is refused when empty). */
  const acceptHidden = (): void => {
    settleTimer = null;
    if (mode.kind !== "settle") return;
    const value = mode.line.join("");
    if (value.trim().length === 0) {
      refuseHidden(HIDDEN_EMPTY_NOTE);
      return;
    }
    const a = asking;
    mode = { kind: "discard" };
    out.write("\n");
    a?.finish({ kind: "answer", value });
  };

  /** One key at the visible question (`term`: a line break). */
  const visibleKey = (m: Extract<Mode, { kind: "visible" }>, c: string, term: boolean): void => {
    if (term) {
      const value = m.line.join("");
      const notShown = m.drawn < m.line.length;
      const a = asking;
      mode = { kind: "discard" };
      out.write("\n");
      if (notShown) out.write(`${NOT_SHOWN_NOTE}\n`);
      a?.finish({ kind: "answer", value });
      return;
    }
    if (c === "\x7f" || c === "\b") {
      if (m.line.length === 0) return;
      m.line.pop();
      if (m.drawn > m.line.length) {
        out.write("\b \b");
        m.drawn = m.line.length;
      }
      return;
    }
    if (c === "\x15") {
      out.write("\b \b".repeat(m.drawn));
      m.line.length = 0;
      m.drawn = 0;
      return;
    }
    if (c === "\x04") {
      if (m.line.length === 0) endInput();
      return;
    }
    if (isControl(c) || m.line.length >= MAX_LINE_CHARS) return;
    // drawn only while every earlier character was drawn and the line keeps its question's shape
    const draw = m.drawn === m.line.length && (m.echo === null || m.echo([...m.line, c].join("")));
    m.line.push(c);
    if (draw) {
      out.write(c);
      m.drawn += 1;
    }
  };

  /** One key at the hidden question: never drawn. */
  const hiddenKey = (m: Extract<Mode, { kind: "hidden" }>, c: string, term: boolean): void => {
    if (term) {
      mode = { kind: "settle", line: m.line };
      settleTimer = setTimeout(acceptHidden, HIDDEN_SETTLE_MS);
      return;
    }
    if (c === "\x7f" || c === "\b") {
      m.line.pop();
      return;
    }
    if (c === "\x15") {
      m.line.length = 0;
      return;
    }
    if (c === "\x04") {
      if (m.line.length === 0) endInput();
      return;
    }
    if (isControl(c) || m.line.length >= MAX_LINE_CHARS) return;
    m.line.push(c);
  };

  /** One character read. */
  const key = (c: string, now: number): void => {
    // an escape sequence (an arrow, Delete, Meta-x) is skipped whole: never inserted, never drawn; a
    // control key ends a broken one and counts as itself (no sequence swallows a line break)
    if (esc !== null) {
      const n = c.codePointAt(0) ?? 0;
      if (n >= 0x20 || c === "\x1b") {
        if (esc === "esc")
          esc = c === "[" ? "csi" : c === "O" ? "ss3" : c === "\x1b" ? "esc" : null;
        else if (esc === "csi") {
          if (n >= 0x40 && n <= 0x7e) esc = null;
        } else esc = null;
        return;
      }
      esc = null;
    }
    if (c === "\x1b") {
      esc = "esc";
      return;
    }
    if (c === "\x03") {
      endInput();
      return;
    }
    if (c === "\x1a" && process.platform !== "win32") {
      suspend();
      return;
    }
    // CR, LF and CR LF each end one line (the LF of a pair may arrive in a later read)
    let term = false;
    if (c === "\r") {
      lastCrAt = now;
      term = true;
    } else if (c === "\n") {
      if (now - lastCrAt <= CRLF_DELAY_MS) {
        lastCrAt = Number.NEGATIVE_INFINITY;
        return;
      }
      term = true;
    } else lastCrAt = Number.NEGATIVE_INFINITY;
    const m = mode;
    switch (m.kind) {
      case "discard":
        discarded += 1;
        if (!asked) discardedEarly = true;
        return;
      case "visible":
        visibleKey(m, c, term);
        return;
      case "hidden":
        hiddenKey(m, c, term);
        return;
      case "settle":
        if (!isBlank(c)) refuseHidden(HIDDEN_REFUSED_NOTE);
        return;
    }
  };

  // every byte read, in order
  function onData(chunk: Buffer | string): void {
    if (released) return;
    const now = Date.now();
    lastByteAt = now;
    const s = typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (const c of s) key(c, now);
  }

  const open = (): void => {
    if (opened || released) return;
    opened = true;
    // raw mode first: from here the terminal driver echoes nothing
    setRaw(true);
    io.stdin.on("data", onData);
    io.stdin.on("end", endInput);
    io.stdin.resume();
  };
  if (io.takeTerminalNow === true) open();

  const ask = (question: string, opts: AskOptions): Promise<PromptAnswer> => {
    open();
    asked = true;
    if (ended) return Promise.resolve({ kind: "closed" });
    return new Promise<PromptAnswer>((resolve) => {
      let done = false;
      const a: Asking = {
        question,
        opts,
        shown: false,
        finish: (ans) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (asking === a) {
            asking = null;
            clearTimers();
          }
          resolve(ans);
        },
      };
      const timer = setTimeout(() => {
        if (asking !== a) return;
        mode = { kind: "discard" };
        // the line of a question it wrote ends here
        if (a.shown) out.write("\n");
        a.finish({ kind: "timeout" });
      }, opts.timeoutMs);
      asking = a;
      present(a, null);
    });
  };

  return {
    ask,
    confirm: confirmOver(ask),
    close() {
      release();
    },
  };
}
