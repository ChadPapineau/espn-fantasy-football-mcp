// fake-tty.ts — a terminal for the prompt's tests (src/cli/prompt.ts; Stage C finding
// setup-hidden-prompt-echo-burst, ruling R7-3): a stdin that says it is a terminal, records raw mode
// and delivers each `type(s)` as ONE read, dispatched at once (the bytes a terminal hands over
// together); a screen that keeps every byte written, in order, at once; and the leak check (any run
// of `n` characters of a secret on the screen). No real terminal, no timers of its own.
import { PassThrough, Writable } from "node:stream";

/** A stdin that says it is a terminal. */
export class FakeTty extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawCalls: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawCalls.push(mode);
    return this;
  }
  /** One read of `s`, dispatched now (the prompt reads `data` events). */
  type(s: string): void {
    this.emit("data", Buffer.from(s, "utf8"));
  }
  /** The input ends (end of file). */
  eof(): void {
    this.emit("end");
  }
}

/** The screen: every byte the prompt wrote, in order, kept at once. */
export class Screen extends Writable {
  private readonly parts: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.parts.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    cb();
  }
  get text(): string {
    return this.parts.join("");
  }
  /** How many times `s` was written. */
  count(s: string): number {
    return this.text.split(s).length - 1;
  }
}

/** True when any `n`-character run of `secret` reached `text`. */
export function shows(text: string, secret: string, n = 8): boolean {
  for (let i = 0; i + n <= secret.length; i++)
    if (text.includes(secret.slice(i, i + n))) return true;
  return false;
}
