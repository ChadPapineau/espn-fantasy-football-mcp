// serve.test.ts — `eff serve` in-process (plan 03 §1.1–§1.3; plan 05 §4.2): usage and config errors
// exit 2; the store's open failures (newer → 1 with plan 03 §7's message, pending migration → 1, an
// unsafe path → 2, anything else → 1); fixture mode answers initialize, tools/list and a call with
// ONLY JSON-RPC frames on stdout; an invalid request gets -32600 under its id, a line that is not
// JSON -32700 with no id; a tools/call argument key `__proto__` is a coded VALIDATION; stdin EOF, stdout
// EPIPE, an over-cap frame, SIGTERM/SIGINT/SIGHUP and reparenting all run the single-flight close
// (exit 0); in-flight reads are drained; a stuck close exits 5 at the deadline; a second SIGINT
// forces it; a crash exits 1. The spawned-process twin is tests/process/serve.test.ts.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { fakeEspnS2, fakeGuid, fakeIpv4 } from "../../scripts/ci/secret-fixtures.mjs";
import {
  EXIT,
  PROTO_KEY_STANDIN,
  invalidRequestReply,
  newerStoreMessage,
  parseErrorReply,
  serve,
  stdinLineReply,
  watchInvalidRequests,
  withProtoKeyCarried,
  withoutEchoedName,
  type ServeInternals,
} from "../../src/cli/serve.js";
import { toolsFor } from "../../src/mcp/registry.js";
import { createLogger } from "../../src/cli/log.js";
import { PathSecurityError } from "../../src/config/paths.js";
import { storeFactory } from "../../src/store/index.js";
import {
  StoreMigrationPendingError,
  StoreVersionError,
  type Store,
  type StoreFactory,
} from "../../src/store/types.js";
import { ESPN_FIXTURES, ROOT, T0, runningClock } from "./helpers/world.js";

type Msg = Record<string, unknown>;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-serve-")));
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

interface Run {
  readonly code: Promise<number>;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly frames: Msg[];
  readonly logs: Msg[];
  readonly raw: () => string;
  send(m: Msg): void;
  reply(id: number, timeoutMs?: number): Promise<Msg>;
  log(event: string, timeoutMs?: number): Promise<Msg>;
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

function start(
  env: Record<string, string | undefined>,
  internals: ServeInternals = {},
  argv: string[] = [],
): Run {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const frames: Msg[] = [];
  const logs: Msg[] = [];
  let out = "";
  let outBuf = "";
  let errBuf = "";
  stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
    outBuf += c.toString("utf8");
    let i = outBuf.indexOf("\n");
    while (i >= 0) {
      frames.push(JSON.parse(outBuf.slice(0, i)) as Msg);
      outBuf = outBuf.slice(i + 1);
      i = outBuf.indexOf("\n");
    }
  });
  stderr.on("data", (c: Buffer) => {
    errBuf += c.toString("utf8");
    let i = errBuf.indexOf("\n");
    while (i >= 0) {
      logs.push(JSON.parse(errBuf.slice(0, i)) as Msg);
      errBuf = errBuf.slice(i + 1);
      i = errBuf.indexOf("\n");
    }
  });
  const code = serve(
    { argv, env, stdin, stdout, stderr },
    { clock: runningClock(T0), signals: false, packageRoot: ROOT, ...internals },
  );
  return {
    code,
    stdin,
    stdout,
    frames,
    logs,
    raw: () => out,
    send: (m) => stdin.write(`${JSON.stringify(m)}\n`),
    reply: (id, t = 15_000) =>
      until(() => frames.find((f) => f.id === id), t, `reply ${String(id)}`),
    log: (event, t = 15_000) => until(() => logs.find((l) => l.event === event), t, event),
  };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "serve-test", version: "0" },
  },
};

async function ready(r: Run): Promise<void> {
  r.send(INIT);
  await r.reply(1);
  r.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

/** Emits a process event with only serve's listeners attached (the runner's own are set aside). */
function emitIsolated(
  event: string,
  foreign: readonly ((...a: unknown[]) => void)[],
  ...args: unknown[]
): void {
  for (const l of foreign) process.off(event, l);
  try {
    process.emit(event as "SIGTERM", ...(args as [never]));
  } finally {
    for (const l of foreign) process.on(event, l);
  }
}

const eventOf = (l: Msg): string => (typeof l.event === "string" ? l.event : "");

describe("startup refusals", () => {
  it("any argument is a usage error (exit 2), nothing on stdout", async () => {
    const r = start(tempEnv(), {}, ["--port", "1"]);
    expect(await r.code).toBe(EXIT.usage);
    expect(r.raw()).toBe("");
    expect(r.logs.map(eventOf)).toContain("serve.usage");
  });

  it("a missing league id is a config error (exit 2) naming the key, never a value", async () => {
    const env = tempEnv();
    delete env.ESPN_LEAGUE_ID;
    const r = start(env);
    expect(await r.code).toBe(EXIT.usage);
    const issue = r.logs.find((l) => eventOf(l) === "config.invalid");
    expect(JSON.stringify(issue)).toContain("ESPN_LEAGUE_ID");
    expect(r.raw()).toBe("");
  });

  it("an unreadable config.json is a config error (exit 2)", async () => {
    const env = tempEnv();
    mkdirSync(env.EFF_CONFIG_DIR!, { mode: 0o700 });
    writeFileSync(path.join(env.EFF_CONFIG_DIR!, "config.json"), "{not json", {
      mode: 0o600,
    });
    const r = start(env);
    expect(await r.code).toBe(EXIT.usage);
  });

  const failing = (e: unknown): StoreFactory =>
    ({
      open: () => {
        throw e;
      },
    }) as unknown as StoreFactory;

  it("a store written by a newer binary exits 1 with plan 03 §7's message", async () => {
    const r = start(tempEnv(), { factory: failing(new StoreVersionError(9, 1)) });
    expect(await r.code).toBe(EXIT.error);
    const l = r.logs.find((x) => eventOf(x) === "store.open_failed");
    expect(l).toMatchObject({ reason: "newer_version", store_version: 9, binary_version: 1 });
    expect(JSON.stringify(l)).toContain(newerStoreMessage(9, 1));
    expect(r.raw()).toBe("");
  });

  it("a pending migration exits 1; an unsafe path exits 2; anything else exits 1 with a coarse reason", async () => {
    const pending = start(tempEnv(), { factory: failing(new StoreMigrationPendingError(1, 2)) });
    expect(await pending.code).toBe(EXIT.error);
    expect(pending.logs.find((x) => eventOf(x) === "store.open_failed")).toMatchObject({
      reason: "migration_pending",
    });
    const unsafe = start(tempEnv(), {
      factory: failing(new PathSecurityError("relative", "x", "store")),
    });
    expect(await unsafe.code).toBe(EXIT.usage);
    const busy = start(tempEnv(), {
      factory: failing(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })),
    });
    expect(await busy.code).toBe(EXIT.error);
    expect(busy.logs.find((x) => eventOf(x) === "store.open_failed")).toMatchObject({
      reason: "sqlite_busy",
    });
    const odd = start(tempEnv(), { factory: failing("not an error") });
    expect(await odd.code).toBe(EXIT.error);
    expect(odd.logs.find((x) => eventOf(x) === "store.open_failed")).toMatchObject({
      reason: "unknown",
    });
  });

  it("a composition failure closes what is open and exits 1", async () => {
    let closed = false;
    const factory = {
      open: (o: Parameters<StoreFactory["open"]>[0]) => {
        const real = storeFactory.open(o);
        return new Proxy(real, {
          get(t, k, rcv) {
            if (k === "repos") throw new Error("composition failed");
            if (k === "close")
              return () => {
                closed = true;
                real.close();
              };
            return Reflect.get(t, k, rcv) as unknown;
          },
        });
      },
    } as unknown as StoreFactory;
    const r = start(tempEnv(), { factory });
    expect(await r.code).toBe(EXIT.error);
    expect(r.logs.map(eventOf)).toContain("serve.start_failed");
    expect(closed).toBe(true);
  });
});

describe("fixture mode over stdio", () => {
  it("initialize, tools/list and a call; stdout carries only JSON-RPC frames; EOF exits 0", async () => {
    const r = start(tempEnv());
    await ready(r);
    const init = await r.reply(1);
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "espn-fantasy-football-mcp-server",
    );
    r.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await r.reply(2);
    const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain("espn_get_league");
    expect(names).toContain("espn_debug_echo");
    r.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "espn_get_status", arguments: {} },
    });
    const st = await r.reply(3);
    expect((st.result as { isError?: boolean }).isError ?? false).toBe(false);
    const readyLog = await r.log("serve.ready");
    expect(readyLog).toMatchObject({
      fixture_mode: true,
      credential_state: "not_configured",
      toolset: "core",
    });
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    expect(r.logs.find((l) => eventOf(l) === "serve.shutdown")).toMatchObject({ reason: "stdin" });
    for (const f of r.frames) expect(f.jsonrpc).toBe("2.0");
    expect(r.raw().endsWith("\n")).toBe(true);
  });

  it("an invalid request is answered -32600 under its id; a line that is not JSON -32700 with no id", async () => {
    const r = start(tempEnv());
    await ready(r);
    r.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 41, method: 5 })}\n`);
    r.stdin.write("{this is not json\r\n\n");
    r.stdin.write("this is not json\n");
    const bad = await r.reply(41);
    expect(bad.error).toEqual({ code: -32600, message: "Invalid Request" });
    const parseErrors = await until(
      () => {
        const p = r.frames.filter(
          (f) => (f.error as { code?: number } | undefined)?.code === -32700,
        );
        return p.length >= 2 ? p : undefined;
      },
      15_000,
      "two -32700 replies",
    );
    // one reply per unparseable line (the blank line is skipped); no id: it could not be read, and
    // MCP's RequestId has no null
    expect(parseErrors).toEqual([
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } },
    ]);
    expect(r.raw()).not.toContain("this is not json");
    await r.log("transport.parse_error");
    // the server still answers
    r.send({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} });
    expect((await r.reply(42)).result).toBeDefined();
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    expect(
      r.frames.filter((f) => (f.error as { code?: number } | undefined)?.code === -32700),
    ).toHaveLength(2);
  });

  it("a multi-byte character split across two writes is one valid line, not a parse error", async () => {
    const r = start(tempEnv());
    await ready(r);
    const line = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", id: 43, method: "tools/list", params: { _meta: { note: "\u00e9\u{1F3C8}" } } })}\n`,
      "utf8",
    );
    const cut = line.indexOf(Buffer.from("\u{1F3C8}", "utf8")) + 2; // inside the 4-byte character
    r.stdin.write(line.subarray(0, cut));
    await new Promise((res) => setTimeout(res, 20));
    r.stdin.write(line.subarray(cut));
    expect((await r.reply(43)).result).toBeDefined();
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    expect(r.frames.some((f) => (f.error as { code?: number } | undefined)?.code === -32700)).toBe(
      false,
    );
  });

  it("a tools/call argument key __proto__ is a coded VALIDATION like any unknown key (top level and nested)", async () => {
    const r = start(tempEnv());
    await ready(r);
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    // raw lines: an own `__proto__` key exists only in JSON text (a JS literal would set a prototype)
    const raw = (id: number, name: string, args: string): void => {
      r.stdin.write(
        `{"jsonrpc":"2.0","id":${String(id)},"method":"tools/call","params":{"name":"${name}","arguments":${args}}}\n`,
      );
    };
    const toolError = (f: Msg): Record<string, unknown> => {
      const res = f.result as { isError?: boolean; content: { text: string }[] };
      expect(res.isError).toBe(true);
      return (JSON.parse(res.content[0]?.text ?? "{}") as { error: Record<string, unknown> }).error;
    };
    raw(71, "espn_get_league", '{"__proto__":{"polluted":"yes-71"}}');
    raw(72, "espn_get_status", '{"__proto__":null}');
    raw(73, "espn_get_league", '{"include":["rules"],"__proto__":{"include":["bogus"]}}');
    raw(74, "espn_get_injuries", '{"players":{"__proto__":{"x":1},"team_id":1}}');
    for (const id of [71, 72, 73]) {
      const e = toolError(await r.reply(id));
      expect(e).toMatchObject({
        code: "VALIDATION",
        field: "(root) (unknown key)",
        reason: "unrecognized_keys",
      });
    }
    expect(toolError(await r.reply(74)).code).toBe("VALIDATION");
    // controls: the same calls without the key answer (not VALIDATION)
    raw(75, "espn_get_league", "{}");
    raw(76, "espn_get_league", '{"include":["rules"]}');
    raw(77, "espn_get_injuries", '{"players":{"team_id":1}}');
    for (const id of [75, 76]) {
      const res = (await r.reply(id)).result as { isError?: boolean };
      expect(res.isError ?? false).toBe(false);
    }
    const nested = (await r.reply(77)).result as { isError?: boolean; content: { text: string }[] };
    if (nested.isError === true) expect(toolError(await r.reply(77)).code).not.toBe("VALIDATION");
    // nothing reached a prototype, nothing was echoed, and the carry is logged value-free
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.raw()).not.toContain("yes-71");
    expect(r.raw()).not.toContain("__proto__");
    expect(await r.log("transport.proto_key")).toMatchObject({ method: "tools/call" });
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
  });

  it("an unregistered tool or prompt is answered -32602 without echoing the caller's string", async () => {
    const r = start(tempEnv());
    await ready(r);
    const pieces = [
      fakeEspnS2("serve-echo", 80),
      fakeGuid("serve-echo"),
      fakeIpv4("serve-echo"),
      "evil\u0000\u001b[2Jname\u202e",
    ];
    const hostile = `espn_s2=${pieces[0] ?? ""} {${pieces[1] ?? ""}} ${pieces.slice(2).join(" ")} not found`;
    r.send({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: hostile, arguments: {} },
    });
    r.send({ jsonrpc: "2.0", id: 52, method: "prompts/get", params: { name: hostile } });
    const tool = await r.reply(51);
    const prompt = await r.reply(52);
    expect(tool.error).toMatchObject({ code: -32602, message: "Tool not found" });
    expect(prompt.error).toMatchObject({ code: -32602, message: "Prompt not found" });
    for (const piece of pieces) expect(r.raw()).not.toContain(JSON.stringify(piece).slice(1, -1));
    expect(r.raw()).not.toContain("evil");
    // a registered tool still answers normally
    r.send({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: { name: "espn_get_status", arguments: {} },
    });
    expect((await r.reply(53)).result).toBeDefined();
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
  });

  it("resources/read of an unknown or invalid URI answers -32602 without echoing it, at any size", async () => {
    const r = start(tempEnv());
    await ready(r);
    const pieces = [
      fakeEspnS2("serve-uri", 80),
      fakeGuid("serve-uri"),
      fakeIpv4("serve-uri"),
      "evil\u0000\u001b[2Juri‮",
    ];
    const hostile = `espn-ff://x?espn_s2=${pieces[0] ?? ""}&SWID={${pieces[1] ?? ""}}&ip=${pieces[2] ?? ""}&n=${pieces[3] ?? ""}`;
    r.send({ jsonrpc: "2.0", id: 61, method: "resources/read", params: { uri: hostile } });
    // not a URL at all: the SDK's "is invalid" reply
    r.send({
      jsonrpc: "2.0",
      id: 62,
      method: "resources/read",
      params: { uri: `not a uri ${pieces.join(" ")}` },
    });
    // megabytes in, a constant-size reply out (no amplification): a 2 MB non-URL (the "is invalid"
    // path), a 900 kB URL that matches nothing, and a 2 MB URL (the SDK's template matcher refuses
    // a URI over 1 000 000 chars — the SDK's -32603 length refusal is the caller's invalid params:
    // -32602 "Invalid params", JSON-RPC 2.0 §5.1)
    const bigInvalid = `bad ${"Ab9%2F ".repeat(300_000)}`;
    const bigUnmatched = `espn-ff://${"Ab9%2F".repeat(150_000)}`;
    const bigOverCap = `espn-ff://${"Ab9%2F".repeat(350_000)}`;
    r.send({ jsonrpc: "2.0", id: 63, method: "resources/read", params: { uri: bigInvalid } });
    r.send({ jsonrpc: "2.0", id: 66, method: "resources/read", params: { uri: bigUnmatched } });
    r.send({ jsonrpc: "2.0", id: 67, method: "resources/read", params: { uri: bigOverCap } });
    const notFound = await r.reply(61);
    const invalid = await r.reply(62);
    expect(notFound.error).toEqual({
      code: -32602,
      message: "Resource not found",
      data: { uri: "" },
    });
    expect(invalid.error).toEqual({
      code: -32602,
      message: "Resource URI is invalid",
      data: { uri: "", reason: "invalid_uri" },
    });
    expect((await r.reply(63)).error).toEqual(invalid.error);
    expect((await r.reply(66)).error).toEqual(notFound.error);
    expect((await r.reply(67)).error).toEqual({ code: -32602, message: "Invalid params" });
    for (const id of [63, 66, 67])
      expect(JSON.stringify(r.frames.find((f) => f.id === id)).length).toBeLessThan(200);
    for (const piece of pieces) expect(r.raw()).not.toContain(JSON.stringify(piece).slice(1, -1));
    expect(r.raw()).not.toContain("evil");
    expect(r.raw()).not.toContain("Ab9%2F");
    // a template URI with no row answers with the template, never the caller's id
    r.send({
      jsonrpc: "2.0",
      id: 64,
      method: "resources/read",
      params: { uri: `espn-ff://rec/${fakeGuid("serve-rec")}` },
    });
    expect((await r.reply(64)).error).toMatchObject({
      code: -32602,
      data: { uri: "espn-ff://rec/{log_id}" },
    });
    expect(r.raw()).not.toContain(fakeGuid("serve-rec"));
    // a registered resource still reads normally
    r.send({
      jsonrpc: "2.0",
      id: 65,
      method: "resources/read",
      params: { uri: "espn-ff://status" },
    });
    expect((await r.reply(65)).result).toBeDefined();
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
  });

  it("EOF: an in-flight call finishes and its reply is written before the store closes", async () => {
    const r = start(tempEnv());
    await ready(r);
    r.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "espn_get_standings", arguments: {} },
    });
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    const events = r.logs.map(eventOf);
    expect(events.indexOf("tool.end")).toBeGreaterThan(events.indexOf("serve.shutdown"));
    expect(events).not.toContain("serve.drain_timeout");
    expect(events).not.toContain("store.close_failed");
    expect(r.logs.find((l) => eventOf(l) === "serve.shutdown")).toMatchObject({ reason: "stdin" });
    // the drained call's reply reaches the client (SIGTERM's behaviour; stdout is still open)
    const reply = r.frames.find((f) => f.id === 7);
    expect(reply?.result).toBeDefined();
    expect(reply?.error).toBeUndefined();
  });

  it("EOF right behind a resource read, a prompt and a call: every reply is written (exit 0)", async () => {
    const r = start(tempEnv());
    await ready(r);
    // all three are still queued in the SDK's dispatch pump when EOF lands
    r.send({
      jsonrpc: "2.0",
      id: 71,
      method: "resources/read",
      params: { uri: "espn-ff://league" },
    });
    r.send({ jsonrpc: "2.0", id: 72, method: "prompts/get", params: { name: "espn.waivers" } });
    r.send({
      jsonrpc: "2.0",
      id: 73,
      method: "tools/call",
      params: { name: "espn_get_status", arguments: {} },
    });
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    for (const id of [71, 72, 73]) {
      const f = r.frames.find((x) => x.id === id);
      expect(f?.result, `reply ${String(id)}`).toBeDefined();
    }
    expect(r.logs.map(eventOf)).not.toContain("serve.drain_timeout");
  });

  it("a cancelled request does not hold the drain (the SDK sends it no reply)", async () => {
    const r = start(tempEnv());
    await ready(r);
    r.send({
      jsonrpc: "2.0",
      id: 74,
      method: "tools/call",
      params: { name: "espn_get_standings", arguments: {} },
    });
    r.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 74 } });
    // a malformed cancellation (no usable id) is ignored
    r.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: null } });
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    expect(r.logs.map(eventOf)).not.toContain("serve.drain_timeout");
  });

  it("a stdin that ended before serve() wired its listeners still shuts down (exit 0)", async () => {
    const stdin = new PassThrough();
    stdin.end();
    stdin.resume();
    await new Promise((res) => stdin.once("end", res));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    const code = await serve(
      { argv: [], env: tempEnv(), stdin, stdout, stderr },
      { clock: runningClock(T0), signals: false, packageRoot: ROOT },
    );
    expect(code).toBe(EXIT.ok);
    expect(err).toContain('"event":"serve.shutdown"');
    expect(err).toContain('"reason":"stdin"');
  });

  it("a stdin error is logged without crashing; the server answers on and EOF exits 0", async () => {
    const r = start(tempEnv());
    await ready(r);
    r.stdin.emit("error", new Error("read EIO"));
    expect(await r.log("transport.error")).toMatchObject({ error: "Error" });
    r.send({
      jsonrpc: "2.0",
      id: 75,
      method: "tools/call",
      params: { name: "espn_get_status", arguments: {} },
    });
    expect((await r.reply(75)).result).toBeDefined();
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
  });

  it("a drain shorter than the call logs drain_timeout and still closes (exit 0)", async () => {
    const r = start(tempEnv(), { drainMs: 0 });
    await ready(r);
    r.send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "espn_get_standings", arguments: {} },
    });
    await until(
      () =>
        r.logs.some((l) => eventOf(l) === "espn.request.ok" || eventOf(l) === "limiter.wait")
          ? true
          : undefined,
      15_000,
      "a request",
    );
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    expect(r.logs.find((l) => eventOf(l) === "serve.drain_timeout")).toMatchObject({ inflight: 1 });
  });

  it("stdout EPIPE and other stdout errors close cleanly (exit 0)", async () => {
    const r = start(tempEnv());
    await ready(r);
    r.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(await r.code).toBe(EXIT.ok);
    expect(r.logs.find((l) => eventOf(l) === "serve.shutdown")).toMatchObject({ reason: "epipe" });
    const o = start(tempEnv());
    await ready(o);
    o.stdout.emit("error", new Error("other"));
    expect(await o.code).toBe(EXIT.ok);
    expect(o.logs.find((l) => eventOf(l) === "serve.shutdown")).toMatchObject({
      reason: "stdout_error",
    });
  });

  it("a frame over the transport's read cap closes the transport, then the server (exit 0)", async () => {
    const r = start(tempEnv());
    await ready(r);
    r.stdin.write("x".repeat(10 * 1024 * 1024 + 16));
    expect(await r.code).toBe(EXIT.ok);
    expect(r.logs.find((l) => eventOf(l) === "serve.shutdown")).toMatchObject({
      reason: "transport_closed",
    });
  });

  it("a stuck close exits 5 at the deadline", async () => {
    const r = start(tempEnv(), { closeDelayMs: 2_000, closeDeadlineMs: 50 });
    await ready(r);
    r.stdin.end();
    expect(await r.code).toBe(EXIT.forced);
    expect(r.logs.map(eventOf)).toContain("serve.forced_exit");
  });

  it("a store that fails to close turns exit 0 into 1", async () => {
    const factory = {
      open: (o: Parameters<StoreFactory["open"]>[0]): Store => {
        const real = storeFactory.open(o);
        return new Proxy(real, {
          get(t, k, rcv) {
            if (k === "close")
              return () => {
                real.close();
                throw new Error("checkpoint failed");
              };
            return Reflect.get(t, k, rcv) as unknown;
          },
        });
      },
    } as unknown as StoreFactory;
    const r = start(tempEnv(), { factory });
    await ready(r);
    r.stdin.end();
    expect(await r.code).toBe(EXIT.error);
    expect(r.logs.map(eventOf)).toContain("store.close_failed");
  });

  it("a non-fixture start with a file credential store touches neither network nor keychain", async () => {
    const env = tempEnv({ EFF_CREDENTIAL_STORE: "file" });
    delete env.EFF_FIXTURE_DIR;
    env.EFF_CREDENTIAL_FILE = path.join(env.EFF_CONFIG_DIR!, "session.json");
    let network = 0;
    let keychain = 0;
    const r = start(env, {
      fetch: () => {
        network++;
        return Promise.reject(new Error("no network in tests"));
      },
      loadKeyring: () => {
        keychain++;
        return Promise.reject(new Error("no keychain in tests"));
      },
    });
    await ready(r);
    expect(await r.log("serve.ready")).toMatchObject({
      fixture_mode: false,
      credential_state: "not_configured",
    });
    r.stdin.end();
    expect(await r.code).toBe(EXIT.ok);
    expect(network).toBe(0);
    expect(keychain).toBe(0);
  });
});

describe("signals, crashes and reparenting (process handlers, the runner's own set aside)", () => {
  const foreignOf = (e: string): ((...a: unknown[]) => void)[] =>
    process.listeners(e as "SIGTERM") as never;

  it.each(["SIGTERM", "SIGHUP", "SIGINT"] as const)("%s runs the close (exit 0)", async (sig) => {
    const foreign = foreignOf(sig);
    const r = start(tempEnv(), { signals: true });
    await ready(r);
    emitIsolated(sig, foreign, sig);
    expect(await r.code).toBe(EXIT.ok);
    expect(r.logs.find((l) => eventOf(l) === "serve.shutdown")).toMatchObject({
      reason: sig.toLowerCase(),
    });
    expect(process.listeners(sig)).toEqual(foreign);
  });

  it("SIGTERM with a call in flight: the call is drained and its reply delivered before the close", async () => {
    const foreign = foreignOf("SIGTERM");
    const r = start(tempEnv(), { signals: true });
    await ready(r);
    r.send({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "espn_get_standings", arguments: {} },
    });
    await until(
      () =>
        r.logs.some((l) => eventOf(l) === "espn.request.ok" || eventOf(l) === "limiter.wait")
          ? true
          : undefined,
      15_000,
      "a request",
    );
    emitIsolated("SIGTERM", foreign, "SIGTERM");
    expect(await r.code).toBe(EXIT.ok);
    expect(r.frames.some((f) => f.id === 9)).toBe(true);
  });

  it("a second SIGINT during the close forces exit 5; a second SIGTERM is ignored", async () => {
    const fInt = foreignOf("SIGINT");
    const fTerm = foreignOf("SIGTERM");
    const r = start(tempEnv(), { signals: true, closeDelayMs: 2_000 });
    await ready(r);
    emitIsolated("SIGTERM", fTerm, "SIGTERM");
    emitIsolated("SIGTERM", fTerm, "SIGTERM");
    emitIsolated("SIGINT", fInt, "SIGINT");
    expect(await r.code).toBe(EXIT.forced);
    expect(r.logs.find((l) => eventOf(l) === "serve.forced_exit")).toMatchObject({
      reason: "second_signal",
    });
  });

  it("an uncaught exception or unhandled rejection exits 1", async () => {
    for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
      const foreign = foreignOf(ev);
      const r = start(tempEnv(), { signals: true });
      await ready(r);
      emitIsolated(ev, foreign, ev === "uncaughtException" ? new TypeError("boom") : "rejected");
      expect(await r.code).toBe(EXIT.error);
      expect(r.logs.map(eventOf)).toContain("serve.crash");
    }
  });

  it("reparenting (the parent pid changes) closes the server", async () => {
    const r = start(tempEnv(), { signals: true, watchdogMs: 20 });
    await ready(r);
    const real = process.ppid;
    Object.defineProperty(process, "ppid", {
      value: real + 1,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    try {
      expect(await r.code).toBe(EXIT.ok);
    } finally {
      Object.defineProperty(process, "ppid", {
        value: real,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    expect(r.logs.find((l) => eventOf(l) === "serve.shutdown")).toMatchObject({
      reason: "orphaned",
    });
  });
});

describe("invalidRequestReply", () => {
  it("answers only a request with a usable id that is not a valid message", () => {
    expect(invalidRequestReply('{"jsonrpc":"2.0","id":1,"method":5}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid Request" },
    });
    expect(invalidRequestReply('{"jsonrpc":"1.0","id":"a","method":"x"}')?.id).toBe("a");
    expect(invalidRequestReply('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toBeNull();
    expect(invalidRequestReply("not json")).toBeNull();
    expect(invalidRequestReply("[1,2]")).toBeNull();
    expect(invalidRequestReply("null")).toBeNull();
    expect(invalidRequestReply('{"jsonrpc":"2.0","result":5}')).toBeNull();
    expect(invalidRequestReply('{"jsonrpc":"1.0","method":"x"}')).toBeNull();
    expect(invalidRequestReply('{"jsonrpc":"1.0","id":null,"method":"x"}')).toBeNull();
    expect(
      invalidRequestReply(`{"jsonrpc":"1.0","id":"${"a".repeat(257)}","method":"x"}`),
    ).toBeNull();
    expect(invalidRequestReply('{"jsonrpc":"1.0","id":{"a":1},"method":"x"}')).toBeNull();
  });
});

describe("stdinLineReply", () => {
  const PARSE = { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } };
  it("a line that is not JSON gets -32700 with no id; everything else as invalidRequestReply", () => {
    for (const line of [
      "not json",
      "this is not json",
      "{this is not json",
      "{",
      '{"a":1',
      "'x'",
      "NaN",
      "\u0000",
    ])
      expect(stdinLineReply(line)).toEqual(PARSE);
    expect(Object.hasOwn(stdinLineReply("not json") ?? {}, "id")).toBe(false);
    expect(stdinLineReply('{"jsonrpc":"2.0","id":1,"method":5}')).toEqual(
      invalidRequestReply('{"jsonrpc":"2.0","id":1,"method":5}'),
    );
    for (const line of [
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      "[1,2]",
      "null",
      "5",
      '"x"',
    ])
      expect(stdinLineReply(line)).toBeNull();
    // a fresh object per reply: one caller mutating it cannot change the next
    expect(parseErrorReply()).not.toBe(parseErrorReply());
    expect(parseErrorReply()).toEqual(PARSE);
  });
  it("property: -32700 exactly when JSON.parse rejects the line; never an echo of it", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: "binary" }), fc.json()), (line) => {
        let parses = true;
        try {
          JSON.parse(line);
        } catch {
          parses = false;
        }
        const r = stdinLineReply(line);
        if (!parses) expect(r).toEqual(PARSE);
        else expect(r?.error.code ?? null).not.toBe(-32700);
        if (r !== null && line.length > 12) expect(JSON.stringify(r)).not.toContain(line);
      }),
    );
  });
});

describe("watchInvalidRequests", () => {
  const MAX = STDIO_DEFAULT_MAX_BUFFER_SIZE;
  function watch(): { stdin: PassThrough; replies: unknown[]; events: string[]; stop: () => void } {
    const stdin = new PassThrough();
    const replies: unknown[] = [];
    const events: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (line) => {
        events.push(String((JSON.parse(line) as { event?: unknown }).event));
      },
    });
    const stop = watchInvalidRequests(stdin, (m) => replies.push(m), logger);
    return { stdin, replies, events, stop };
  }
  const PARSE = { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } };

  it("answers each unparseable line and each invalid request; skips blank and valid lines", () => {
    const w = watch();
    w.stdin.write('not json\n\n  \r\n{"jsonrpc":"2.0","id":7,"method":5}\r\n');
    w.stdin.write('{"jsonrpc":"2.0","id":8,"method":"tools/list"}\nnot');
    expect(w.replies).toEqual([
      PARSE,
      { jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Invalid Request" } },
    ]);
    w.stdin.write(" json either\n"); // the line completes across two chunks
    expect(w.replies).toHaveLength(3);
    expect(w.replies[2]).toEqual(PARSE);
    expect(w.events).toEqual([
      "transport.parse_error",
      "transport.invalid_request",
      "transport.parse_error",
    ]);
    w.stop();
    w.stdin.write("not json\n");
    expect(w.replies).toHaveLength(3);
  });

  it("a line over the read cap is never judged, in one chunk or across many; the next line is", () => {
    const w = watch();
    w.stdin.write(`${"x".repeat(MAX + 5)}\n`);
    expect(w.replies).toEqual([]);
    // across chunks: the remainder passes the cap mid-line; its tail after the reset is not a line
    w.stdin.write("y".repeat(MAX - 10));
    w.stdin.write("y".repeat(20));
    w.stdin.write("tail of the long line\nnot json\n");
    expect(w.replies).toEqual([PARSE]);
    w.stop();
  });

  it("a multi-byte character split across chunks is decoded whole", () => {
    const w = watch();
    const line = Buffer.from('{"jsonrpc":"2.0","id":"\u00e9\u{1F3C8}","method":5}\n', "utf8");
    const cut = line.indexOf(Buffer.from("\u{1F3C8}", "utf8")) + 1;
    w.stdin.write(line.subarray(0, cut));
    w.stdin.write(line.subarray(cut));
    expect(w.replies).toEqual([
      {
        jsonrpc: "2.0",
        id: "\u00e9\u{1F3C8}",
        error: { code: -32600, message: "Invalid Request" },
      },
    ]);
    w.stop();
  });
});

describe("withProtoKeyCarried", () => {
  /** An object with an own enumerable `__proto__` data property (what JSON.parse builds). */
  const withOwnProto = (rest: Record<string, unknown>, value: unknown): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, "__proto__", {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return Object.assign(o, rest);
  };
  const call = (args: unknown, method = "tools/call"): JSONRPCMessage => ({
    jsonrpc: "2.0",
    id: 9,
    method,
    params: { name: "espn_get_league", arguments: args },
  });
  const argsOf = (m: JSONRPCMessage): Record<string, unknown> =>
    (m as unknown as { params: { arguments: Record<string, unknown> } }).params.arguments;

  it("carries a top-level own __proto__ key under the stand-in; the value and every other key unchanged", () => {
    const payload = { include: ["bogus"] };
    const msg = JSON.parse(
      '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"espn_get_league","arguments":{"week":3,"__proto__":{"include":["bogus"]}},"_meta":{"k":1}}}',
    ) as JSONRPCMessage;
    const out = withProtoKeyCarried(msg);
    expect(out).not.toBe(msg);
    const a = argsOf(out);
    expect(Object.keys(a)).toEqual(["week", PROTO_KEY_STANDIN]);
    expect(Object.hasOwn(a, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(a[PROTO_KEY_STANDIN]).toEqual(payload);
    expect((out as unknown as { params: { _meta: unknown; name: string } }).params).toMatchObject({
      name: "espn_get_league",
      _meta: { k: 1 },
    });
    expect((out as { id: number }).id).toBe(9);
    // the input is not modified
    expect(Object.hasOwn(argsOf(msg), "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).include).toBeUndefined();
  });

  it("returns every other message as is (the same object)", () => {
    const own = withOwnProto({ week: 1 }, { x: 1 });
    for (const m of [
      call({ week: 1 }),
      call({ players: withOwnProto({ team_id: 1 }, { x: 1 }) }), // nested: the strict schema sees it
      call(own, "prompts/get"),
      call(own, "resources/read"),
      call([own]),
      call(null),
      call("x"),
      { jsonrpc: "2.0", id: 9, method: "tools/call" },
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 9, result: { arguments: own } },
      { jsonrpc: "2.0", id: 9, error: { code: -32600, message: "Invalid Request" } },
    ] as JSONRPCMessage[])
      expect(withProtoKeyCarried(m)).toBe(m);
  });

  it("property: the carried arguments are the input's with only that key renamed", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string().filter((k) => k !== "__proto__" && k !== PROTO_KEY_STANDIN),
          fc.jsonValue(),
        ),
        fc.jsonValue(),
        (rest, value) => {
          const args = withOwnProto(rest, value);
          const out = argsOf(withProtoKeyCarried(call(args)));
          expect(Object.hasOwn(out, "__proto__")).toBe(false);
          expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
          expect(Object.keys(out).sort()).toEqual([...Object.keys(rest), PROTO_KEY_STANDIN].sort());
          expect(out[PROTO_KEY_STANDIN]).toBe(value);
          for (const k of Object.keys(rest)) expect(out[k]).toBe(rest[k]);
        },
      ),
    );
  });

  it("no tool of either toolset declares the stand-in: its strict schema rejects it as an unknown key", () => {
    const tools = [
      ...new Map([...toolsFor("core"), ...toolsFor("full")].map((t) => [t.name, t])).values(),
    ];
    expect(tools.length).toBeGreaterThanOrEqual(34);
    for (const t of tools) {
      const r = t.input.safeParse({ [PROTO_KEY_STANDIN]: 1 });
      expect(r.success, t.name).toBe(false);
      const unknown = r.error?.issues.find((i) => i.code === "unrecognized_keys");
      expect(unknown, t.name).toBeDefined();
      expect((unknown as { keys: string[] }).keys).toContain(PROTO_KEY_STANDIN);
    }
  });
});

describe("withoutEchoedName", () => {
  const err = (message: string, id: number | string = 1): JSONRPCMessage => ({
    jsonrpc: "2.0",
    id,
    error: { code: -32602, message },
  });
  it("drops the name from the SDK's unknown-name replies; keeps the code and the id", () => {
    expect(withoutEchoedName(err("Tool x not found", "a"))).toEqual(err("Tool not found", "a"));
    expect(withoutEchoedName(err("Tool x disabled"))).toEqual(err("Tool disabled"));
    expect(withoutEchoedName(err("Prompt p\nq not found"))).toEqual(err("Prompt not found"));
    expect(withoutEchoedName(err("Resource template espn-ff://x/{y} not found"))).toEqual(
      err("Resource template not found"),
    );
  });
  it("leaves every other message alone", () => {
    for (const m of [
      err("Invalid Request"),
      err("Tool not found"), // nothing echoed: no name between the words
      err("Input validation error: Invalid arguments for tool espn_get_league: x"),
      { jsonrpc: "2.0", id: 1, result: { content: [] } },
      { jsonrpc: "2.0", method: "notifications/progress", params: {} },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Tool x not found" } },
    ] as JSONRPCMessage[])
      expect(withoutEchoedName(m)).toBe(m);
  });
  it("property: whatever the name, the reply carries none of it (huge, unicode, controls)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Tool", "Prompt", "Resource template"),
        fc.string({ minLength: 1, maxLength: 200, unit: "binary" }),
        fc.constantFrom("not found", "disabled"),
        (kind, name, tail) => {
          const out = withoutEchoedName(err(`${kind} ${name} ${tail}`)) as {
            error: { message: string; code: number };
          };
          expect(out.error).toEqual({ code: -32602, message: `${kind} ${tail}` });
        },
      ),
    );
    const huge = withoutEchoedName(err(`Tool ${"\u0007x".repeat(200_000)} not found`)) as {
      error: { message: string };
    };
    expect(huge.error.message).toBe("Tool not found");
  });

  const errData = (message: string, data?: unknown, id: number | string = 1): JSONRPCMessage => ({
    jsonrpc: "2.0",
    id,
    error: { code: -32602, message, ...(data === undefined ? {} : { data }) },
  });
  it("drops the URI from the SDK's resources/read misses: message and data.uri; keys, code, id stay", () => {
    expect(
      withoutEchoedName(errData("Resource not found: espn-ff://x", { uri: "espn-ff://x" }, "r")),
    ).toEqual(errData("Resource not found", { uri: "" }, "r"));
    expect(
      withoutEchoedName(
        errData("Resource URI ::: is invalid", { uri: ":::", reason: "invalid_uri" }),
      ),
    ).toEqual(errData("Resource URI is invalid", { uri: "", reason: "invalid_uri" }));
    expect(withoutEchoedName(errData("Resource espn-ff://x disabled"))).toEqual(
      errData("Resource disabled"),
    );
    // data without a uri key keeps its value; data that is not an object (it could only be the
    // echo) is dropped
    expect(withoutEchoedName(errData("Resource not found: x", { other: 1 }))).toEqual(
      errData("Resource not found", { other: 1 }),
    );
    for (const d of ["espn-ff://x", ["espn-ff://x"], 7, null])
      expect(withoutEchoedName(errData("Resource not found: espn-ff://x", d))).toEqual(
        errData("Resource not found"),
      );
  });
  it("leaves our own template misses and other resource text alone", () => {
    for (const m of [
      errData("not found", { uri: "espn-ff://rec/{log_id}" }),
      errData("Resource not found"), // nothing echoed
      errData("Resources not found: x", { uri: "x" }),
      errData("Resource URI is invalid"),
    ])
      expect(withoutEchoedName(m)).toBe(m);
  });
  it("property: whatever the URI, a resources/read miss carries none of it (huge, unicode, controls)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200, unit: "binary" }), (uri) => {
        const nf = withoutEchoedName(errData(`Resource not found: ${uri}`, { uri })) as {
          error: unknown;
        };
        expect(nf.error).toEqual({
          code: -32602,
          message: "Resource not found",
          data: { uri: "" },
        });
        const inv = withoutEchoedName(
          errData(`Resource URI ${uri} is invalid`, { uri, reason: "invalid_uri" }),
        ) as { error: unknown };
        expect(inv.error).toEqual({
          code: -32602,
          message: "Resource URI is invalid",
          data: { uri: "", reason: "invalid_uri" },
        });
        const dis = withoutEchoedName(errData(`Resource ${uri} disabled`)) as {
          error: { message: string };
        };
        // `Resource template <x> disabled` is the template rule's (same outcome: no echo)
        expect(["Resource disabled", "Resource template disabled"]).toContain(dis.error.message);
      }),
    );
    const big = "\u0007espn_s2=".repeat(250_000);
    const huge = withoutEchoedName(errData(`Resource not found: ${big}`, { uri: big }));
    expect(JSON.stringify(huge).length).toBeLessThan(200);
  });
});
