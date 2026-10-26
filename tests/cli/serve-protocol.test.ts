// serve-protocol.test.ts — `eff serve` over in-process stdio in fixture mode (plan 01 §3.1 dual-era
// serving; plan 03 §1.3 the close sequence; Stage C findings mcp-jsonrpc-batch-dropped,
// serve-invalid-params-internal-error, serve-listen-holds-drain, serve-stdout-not-drained-at-exit):
// a JSON-RPC batch (MCP 2025-03-26 §Batching: MUST be received) gets ONE array reply and `[]` a single
// -32600; the SDK's invalid-params replies are -32602 "Invalid params" (JSON-RPC 2.0 §5.1), never
// -32603 with a zod dump; an open `subscriptions/listen` (2026-07-28) does not hold the drain; and the
// exit code resolves only once stdout has flushed every reply. No network: the recorded fixtures.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import {
  BatchReplies,
  EXIT,
  batchElements,
  isInvalidParamsDump,
  serve,
  watchInvalidRequests,
  withInvalidParamsCoded,
} from "../../src/cli/serve.js";
import { createLogger } from "../../src/cli/log.js";
import { ESPN_FIXTURES, ROOT, T0, runningClock } from "../mcp/helpers/world.js";

type Msg = Record<string, unknown>;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-serve-proto-")));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  return {
    HOME: home,
    ESPN_LEAGUE_ID: "0",
    ESPN_SEASON: "2026",
    EFF_CONFIG_DIR: path.join(dir, "config"),
    EFF_CACHE_DIR: path.join(dir, "cache"),
    EFF_FIXTURE_DIR: ESPN_FIXTURES,
    EFF_LOG_LEVEL: "debug",
    ...extra,
  };
}

async function until<T>(f: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A server whose stdout lines (objects or arrays) are collected as they arrive. */
function start(env: Record<string, string>, opts: { readonly paused?: boolean } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines: unknown[] = [];
  const logs: Msg[] = [];
  let buf = "";
  const take = (c: Buffer | string): void => {
    buf += c.toString();
    let i = buf.indexOf("\n");
    while (i >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)) as unknown);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  };
  if (opts.paused !== true) stdout.on("data", take);
  let errBuf = "";
  stderr.on("data", (c: Buffer) => {
    errBuf += c.toString();
    let i = errBuf.indexOf("\n");
    while (i >= 0) {
      logs.push(JSON.parse(errBuf.slice(0, i)) as Msg);
      errBuf = errBuf.slice(i + 1);
      i = errBuf.indexOf("\n");
    }
  });
  const code = serve(
    { argv: [], env, stdin, stdout, stderr },
    { clock: runningClock(T0), signals: false, packageRoot: ROOT },
  );
  const objects = (): Msg[] =>
    lines.filter((l): l is Msg => typeof l === "object" && l !== null && !Array.isArray(l));
  return {
    code,
    stdin,
    stdout,
    lines,
    logs,
    take,
    send: (m: unknown) => stdin.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`),
    reply: (id: unknown, t = 15_000) =>
      until(() => objects().find((f) => f.id === id), t, `reply ${String(id)}`),
    array: (t = 15_000) =>
      until(() => lines.find((l): l is Msg[] => Array.isArray(l)), t, "an array reply"),
  };
}

const init = (protocolVersion: unknown, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "proto-test", version: "0" } },
});

describe("JSON-RPC batches (MCP 2025-03-26 §Batching; JSON-RPC 2.0 §6)", () => {
  it("a batch is answered with ONE array holding each response; [] gets a single -32600", async () => {
    const r = start(tempEnv());
    r.send(init("2025-03-26"));
    expect((await r.reply(1)).result).toMatchObject({ protocolVersion: "2025-03-26" });
    r.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    r.send([
      { jsonrpc: "2.0", id: "b1", method: "ping" },
      {
        jsonrpc: "2.0",
        id: "b2",
        method: "tools/call",
        params: { name: "espn_get_status", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "x", progress: 1 },
      },
      { jsonrpc: "2.0", id: "b3", method: 5 },
      7,
    ]);
    const arr = await r.array();
    const ids = arr.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["b1", "b2", "b3"]));
    expect(arr).toHaveLength(4);
    expect(arr.find((m) => m.id === "b1")).toMatchObject({ result: {} });
    expect(arr.find((m) => m.id === "b2")).toHaveProperty("result");
    expect(arr.find((m) => m.id === "b3")).toMatchObject({ error: { code: -32600 } });
    // the bare 7 is answered without an id (none can be read), never echoed
    expect(arr.filter((m) => m.id === undefined)).toEqual([
      { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } },
    ]);
    // no response of the batch was written on its own
    expect(r.lines.filter((l) => !Array.isArray(l) && (l as Msg).id === "b1")).toEqual([]);
    const before = r.lines.length;
    r.send("[]");
    await until(() => (r.lines.length > before ? true : undefined), 5_000, "the [] reply");
    expect(r.lines[before]).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request" },
    });
    // a batch of notifications only gets nothing
    const n = r.lines.length;
    r.send([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    r.send({ jsonrpc: "2.0", id: 9, method: "ping" });
    await r.reply(9);
    expect(r.lines.length).toBe(n + 1);
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
  });

  it("BatchReplies: a cancelled member settles; the close flushes a partial batch; unknown ids pass", () => {
    const written: unknown[][] = [];
    const b = new BatchReplies((x) => written.push([...x]));
    b.begin([1, 2], []);
    expect(b.claim({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
    expect(written).toEqual([]);
    b.cancel(2);
    expect(written).toEqual([[{ jsonrpc: "2.0", id: 1, result: {} }]]);
    b.begin([3, 4], []);
    b.claim({ jsonrpc: "2.0", id: 3, result: {} });
    b.flush();
    expect(written[1]).toEqual([{ jsonrpc: "2.0", id: 3, result: {} }]);
    expect(b.size).toBe(0);
    expect(b.claim({ jsonrpc: "2.0", id: 99, result: {} })).toBe(false);
    expect(batchElements([{ jsonrpc: "2.0", id: 1, method: "ping" }, null])).toMatchObject([
      { kind: "message" },
      { kind: "invalid", reply: { error: { code: -32600 } } },
    ]);
  });
});

// Stage C finding mcp-batch-deep-nesting-crash: batchElements re-serialised each element with
// JSON.stringify, which overflows V8's stack from about 7 000 levels that JSON.parse accepts; the
// RangeError escaped the stdin listener and the server exited 1 with every later request unanswered
describe("a batch element too deeply nested to re-serialise", () => {
  const deep = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;

  it("is answered -32600 under its id; the server keeps serving (no crash, the next ping answered)", async () => {
    const r = start(tempEnv());
    r.send(init("2025-03-26"));
    await r.reply(1);
    r.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    r.send(`[{"jsonrpc":"2.0","id":2,"method":"ping","params":{"x":${deep(20_000)}}}]`);
    r.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect((await r.reply(3)).result).toEqual({});
    const arr = await r.array();
    expect(arr).toEqual([
      { jsonrpc: "2.0", id: 2, error: { code: -32600, message: "Invalid Request" } },
    ]);
    // a nesting it can re-serialise is an ordinary element: the ping is answered in its array
    r.send(`[{"jsonrpc":"2.0","id":4,"method":"ping","params":{"x":${deep(500)}}}]`);
    await until(
      () => (r.lines.some((l) => Array.isArray(l) && (l as Msg[])[0]?.id === 4) ? true : undefined),
      10_000,
      "the shallow batch's array",
    );
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    expect(r.logs.map((l) => l.event)).not.toContain("serve.crash");
  });

  it("batchElements never throws: an element it cannot serialise is invalid, under its id when usable", () => {
    let v: unknown = 1;
    for (let i = 0; i < 20_000; i++) v = [v];
    const cyclic: Record<string, unknown> = { jsonrpc: "2.0", id: 7, method: "ping" };
    cyclic.self = cyclic;
    expect(
      batchElements([{ jsonrpc: "2.0", id: 5, method: "ping", params: { v } }, cyclic, v]),
    ).toEqual([
      {
        kind: "invalid",
        reply: { jsonrpc: "2.0", id: 5, error: { code: -32600, message: "Invalid Request" } },
      },
      {
        kind: "invalid",
        reply: { jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Invalid Request" } },
      },
      {
        kind: "invalid",
        reply: { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } },
      },
    ]);
  });
});

// Stage C finding mcp-batch-reorders-cancel-lost: the SDK read each stdin chunk before the batch
// watcher did, so for one write "[call]\n<cancel>\n" it queued the cancel first and the batch's
// call afterwards: the cancellation was a no-op, the call ran to completion and replied. One reader
// now feeds the SDK in arrival order, a batch's elements in its place.
describe("a cancellation written right behind a batched call", () => {
  const call = (id: number, name: string, args: Record<string, unknown> = {}): Msg => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const cancel = (id: number): Msg => ({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: id },
  });
  const repliesTo = (lines: readonly unknown[], id: number): unknown[] =>
    lines
      .flatMap((l): unknown[] => (Array.isArray(l) ? (l as unknown[]) : [l]))
      .filter((m) => (m as Msg).id === id);

  it("cancels it exactly as it cancels the same call sent alone: no reply, no tool.end", async () => {
    const r = start(tempEnv());
    r.send(init("2025-03-26"));
    await r.reply(1);
    r.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // the control: a call and its cancellation in ONE write, each a line of its own
    r.stdin.write(
      `${JSON.stringify(call(60, "espn_project_players"))}\n${JSON.stringify(cancel(60))}\n`,
    );
    // the batched call and its cancellation in one write
    r.stdin.write(
      `${JSON.stringify([call(70, "espn_project_players")])}\n${JSON.stringify(cancel(70))}\n`,
    );
    // and the reverse order: a call, then a batch holding its cancellation
    r.stdin.write(
      `${JSON.stringify(call(80, "espn_project_players"))}\n${JSON.stringify([cancel(80)])}\n`,
    );
    r.send({ jsonrpc: "2.0", id: 90, method: "ping" });
    await r.reply(90);
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    expect(repliesTo(r.lines, 60)).toEqual([]);
    expect(repliesTo(r.lines, 70)).toEqual([]);
    expect(repliesTo(r.lines, 80)).toEqual([]);
    // none of the three ran to an answer: a cancellation that lands before its call starts stops it
    // before the tool runs at all, one that lands after logs tool.cancelled — never tool.end
    expect(r.logs.filter((l) => l.event === "tool.end")).toEqual([]);
    expect(r.logs.map((l) => l.event)).not.toContain("serve.drain_timeout");
  });
});

describe("watchInvalidRequests as the SDK transport's one reader (forward)", () => {
  function reader() {
    const stdin = new PassThrough();
    const fed: string[] = [];
    const replies: unknown[] = [];
    const batches: unknown[][] = [];
    const events: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (l) => events.push(String((JSON.parse(l) as { event?: unknown }).event)),
    });
    const stop = watchInvalidRequests(
      stdin,
      (m) => replies.push(m),
      logger,
      (els) => {
        batches.push([...els]);
        // what serve does: each element fed in the batch's place
        for (const e of batchElements(els)) if (e.kind === "message") fed.push(`${e.line}\n`);
      },
      (b) => fed.push(b.toString("utf8")),
    );
    return { stdin, fed, replies, batches, events, stop };
  }
  const ping = (id: number): string => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });

  it("feeds lines in arrival order, a batch's elements in its place, within one chunk and across chunks", () => {
    const r = reader();
    r.stdin.write(`${ping(1)}\n[${ping(2)},${ping(3)}]\n${ping(4)}\n`);
    expect(r.fed).toEqual([`${ping(1)}\n`, `${ping(2)}\n`, `${ping(3)}\n`, `${ping(4)}\n`]);
    // a line split across reads is fed once it is whole, CR LF kept for the SDK to strip
    r.stdin.write(ping(5).slice(0, 10));
    r.stdin.write(`${ping(5).slice(10)}\r\n`);
    expect(r.fed.at(-1)).toBe(`${ping(5)}\r\n`);
    r.stop();
  });

  it("answers what the SDK would drop and does not feed it; blank lines and over-cap lines are fed raw", () => {
    const r = reader();
    r.stdin.write('not json\n42\n\n[]\n{"jsonrpc":"2.0","id":7,"method":5}\n');
    expect(r.replies).toHaveLength(4);
    expect(r.fed).toEqual(["\n"]);
    const big = `${"x".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE + 3)}\n`;
    r.stdin.write(big);
    expect(r.fed.at(-1)?.length).toBe(big.length);
    // past the cap without a newline: what was held, then the rest of the line, raw
    r.stdin.write("y".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE - 5));
    r.stdin.write("y".repeat(10));
    r.stdin.write("tail\n");
    expect(r.fed.slice(-2).map((x) => x.length)).toEqual([STDIO_DEFAULT_MAX_BUFFER_SIZE + 5, 5]);
    expect(r.replies).toHaveLength(4);
    r.stop();
  });

  it("a line it fails to judge is logged and fed as it came: nothing escapes the listener", () => {
    const stdin = new PassThrough();
    const fed: string[] = [];
    const events: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (l) => events.push(String((JSON.parse(l) as { event?: unknown }).event)),
    });
    watchInvalidRequests(
      stdin,
      () => undefined,
      logger,
      () => {
        throw new RangeError("boom");
      },
      (b) => fed.push(b.toString("utf8")),
    );
    expect(() => stdin.write(`[${ping(1)}]\n${ping(2)}\n`)).not.toThrow();
    expect(events).toContain("transport.line_failed");
    expect(fed).toEqual([`[${ping(1)}]\n`, `${ping(2)}\n`]);
  });
});

// Stage C finding mcp-nonobject-line-unanswered: a parseable line that is not a JSON-RPC message
// got no reply unless it was a request with a usable id, while the same value inside a batch got the
// id-less -32600
describe("an invalid single line is answered like the same value inside a batch", () => {
  it('42, "hello", null, {} and JSON-RPC §5.1\'s example each get one id-less -32600; the next ping is answered', async () => {
    const r = start(tempEnv());
    r.send(init("2025-03-26"));
    await r.reply(1);
    r.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const before = r.lines.length;
    for (const line of [
      "42",
      '"hello"',
      "null",
      "{}",
      '{"jsonrpc":"2.0","method":1,"params":"bar"}',
    ])
      r.send(line);
    r.send({ jsonrpc: "2.0", id: 9, method: "ping" });
    await r.reply(9);
    const INVALID = { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } };
    expect(r.lines.slice(before).filter((l) => (l as Msg).id === undefined)).toEqual([
      INVALID,
      INVALID,
      INVALID,
      INVALID,
      INVALID,
    ]);
    // inside a batch: the same answer per element
    r.send("[42, {}]");
    expect(await r.array()).toEqual([INVALID, INVALID]);
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
  });
});

describe("invalid params are -32602 (JSON-RPC 2.0 §5.1), never a -32603 zod dump", () => {
  it("initialize, prompts/get and resources/read with wrong-typed or missing params", async () => {
    const r = start(tempEnv());
    r.send(init(5, 1));
    r.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    r.send(init("2025-03-26", 3));
    await r.reply(3);
    r.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    r.send({
      jsonrpc: "2.0",
      id: 4,
      method: "prompts/get",
      params: { name: "weekly", arguments: { week: 5 } },
    });
    r.send({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: 5 } });
    for (const id of [1, 2, 4, 5])
      expect((await r.reply(id)).error, `id ${String(id)}`).toEqual({
        code: -32602,
        message: "Invalid params",
      });
    // a real server-side error keeps -32603
    expect(
      withInvalidParamsCoded({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "boom" },
      }),
    ).toMatchObject({ error: { code: -32603, message: "boom" } });
    expect(isInvalidParamsDump(JSON.stringify([{ code: "custom", path: ["result"] }]))).toBe(false);
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
  });
});

describe("the close sequence", () => {
  const PV = "io.modelcontextprotocol/protocolVersion";
  const CC = "io.modelcontextprotocol/clientCapabilities";
  const meta = { [PV]: "2026-07-28", [CC]: {} };

  it("an open subscriptions/listen does not hold the drain: EOF closes promptly, no drain_timeout", async () => {
    const r = start(tempEnv());
    r.send({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: meta } });
    await r.reply("d");
    r.send({
      jsonrpc: "2.0",
      id: "L1",
      method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true }, _meta: meta },
    });
    await until(
      () =>
        r.lines.find(
          (l) =>
            typeof l === "object" &&
            l !== null &&
            (l as Msg).method === "notifications/subscriptions/acknowledged",
        ),
      10_000,
      "the listen acknowledgement",
    );
    const t0 = Date.now();
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    // the default drain window is 3 s: a listen counted as in flight held all of it
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.logs.some((l) => l.event === "serve.drain_timeout")).toBe(false);
  });

  it("the exit code resolves only after stdout flushed every reply (a slow reader loses nothing)", async () => {
    const r = start(tempEnv({ EFF_TOOLSET: "full" }), { paused: true });
    // the reader drains in bursts, as a busy client does
    const reader = setInterval(() => {
      let c: unknown;
      while ((c = r.stdout.read()) !== null) r.take(c as Buffer);
    }, 30);
    try {
      r.send(init("2025-06-18"));
      r.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const n = 12;
      for (let i = 0; i < n; i++) r.send({ jsonrpc: "2.0", id: 100 + i, method: "tools/list" });
      r.stdin.end();
      const code = await r.code;
      // at the moment the exit code is known, nothing may still be queued in the stream
      expect(r.stdout.writableLength).toBe(0);
      expect(code).toBe(EXIT.ok);
      await until(() => (r.lines.length >= n + 1 ? true : undefined), 10_000, "every reply read");
      for (let i = 0; i < n; i++) expect(await r.reply(100 + i)).toHaveProperty("result");
    } finally {
      clearInterval(reader);
    }
  });
});
