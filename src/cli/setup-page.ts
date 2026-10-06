// setup-page.ts — `eff setup --page`, the opt-in one-shot local page (plan 03 L2, L3, §1.4, §2.2):
// one `http.Server` on 127.0.0.1 only (never 0.0.0.0 or ::); port EFF_SETUP_PORT when set (no
// fallback — a wrong explicit port is a user statement; busy → the `lsof` owner and exit 2), else
// 8790 then 8790–8799; the URL printed exactly as bound with a 32-byte hex token; POST-only form
// with the token in the path AND a hidden field, accepted only when Host is exactly
// `127.0.0.1:<port>`, Origin (or, without one, Referer) matches, and the values pass the format
// rules; `Cache-Control: no-store`; nothing is logged; the first valid POST ends it (the server
// closes), every other path is 404; 120 s timeout; SIGINT closes it; `keepAliveTimeout` 1 s.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  normalizePastedValue,
  validateEspnS2,
  validateSwid,
  formatRefusalText,
} from "../auth/format.js";
import { SETUP_TEXT } from "../auth/setup.js";
import { SETUP_PORT_DEFAULT, SETUP_PORT_RANGE } from "../config/schema.js";
import type { Exec } from "./io.js";

/** The page waits this long for the one valid submission (plan 03 §2.2, [V-03 §C.4]). */
export const PAGE_TIMEOUT_MS = 120_000;
/** Largest form body accepted. */
export const MAX_FORM_BYTES = 16 * 1024;
/** The lsof binary (macOS; skipped when absent). */
export const LSOF = "/usr/sbin/lsof";

/** The page's outcome. */
export type PageOutcome =
  | { readonly kind: "values"; readonly swid: string; readonly espn_s2: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "port_busy"; readonly port: number | null; readonly owner: string | null };

/** The ports to try, in order (plan 03 §2.2). */
export function candidatePorts(explicit: number | null): number[] {
  if (explicit !== null) return [explicit];
  const range = Array.from(
    { length: SETUP_PORT_RANGE.max - SETUP_PORT_RANGE.min + 1 },
    (_, i) => SETUP_PORT_RANGE.min + i,
  );
  return [SETUP_PORT_DEFAULT, ...range.filter((p) => p !== SETUP_PORT_DEFAULT)];
}

/** The `lsof -nP -iTCP:<port> -sTCP:LISTEN` owner of a port, as `<command> (pid <n>)`, or null. */
export async function portOwner(run: Exec, port: number): Promise<string | null> {
  const r = await run(LSOF, ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN"], { timeoutMs: 5_000 });
  if (r.code !== 0) return null;
  const line = r.stdout.split("\n")[1];
  const m = line === undefined ? null : /^(\S{1,64})\s+(\d{1,10})\s/.exec(line);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return `${m[1].replace(/[^A-Za-z0-9._-]/g, "?")} (pid ${m[2]})`;
}

/** The busy-port message (plan 03 §2.2, verbatim shape). */
export function portBusyMessage(port: number | null, owner: string | null): string {
  if (port === null)
    return `Ports ${String(SETUP_PORT_RANGE.min)}-${String(SETUP_PORT_RANGE.max)} are all in use. Set EFF_SETUP_PORT to a free port or run 'eff setup' (no page needed).`;
  return `Port ${String(port)} is in use${owner === null ? "" : ` by ${owner}`}. Set EFF_SETUP_PORT to a free port or run 'eff setup' (no page needed).`;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The form page (instructions + two fields + the hidden token; no external resources). */
export function formHtml(token: string, notice: string | null): string {
  const items = SETUP_TEXT.instructions.map((l) => `<li>${esc(l.trim())}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>eff setup</title>
<meta name="referrer" content="no-referrer"><style>body{font:15px system-ui;max-width:40em;margin:2em auto;padding:0 1em}input{width:100%;font:14px monospace;margin:.3em 0 1em}</style></head>
<body><h1>Connect your ESPN league</h1><ul>${items}</ul>${notice === null ? "" : `<p><strong>${esc(notice)}</strong></p>`}
<form method="post" action="/setup/${esc(token)}" autocomplete="off"><input type="hidden" name="token" value="${esc(token)}">
<label>SWID<input name="swid" spellcheck="false" autocomplete="off"></label>
<label>espn_s2<input name="espn_s2" type="password" spellcheck="false" autocomplete="off"></label>
<button type="submit">Store and check</button></form></body></html>`;
}

const DONE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>eff setup</title></head><body><p>Done — you can close this tab. The result is in your terminal.</p></body></html>';

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Whether a request's Origin (or, without one, its Referer) is this page's origin. */
export function sameOrigin(req: Pick<IncomingMessage, "headers">, origin: string): boolean {
  const o = req.headers.origin;
  if (typeof o === "string") return o === origin;
  const r = req.headers.referer;
  return typeof r === "string" && (r === origin || r.startsWith(`${origin}/`));
}

function send(res: ServerResponse, status: number, html: string | null): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    connection: "close",
  });
  res.end(html ?? "");
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_FORM_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      resolve(null);
    });
  });
}

function listen(server: Server, port: number): Promise<"ok" | "busy" | "error"> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      resolve(e.code === "EADDRINUSE" || e.code === "EACCES" ? "busy" : "error");
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve("ok");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

/** Options of the page. */
export interface PageOptions {
  /** EFF_SETUP_PORT, or null for the default and its range. */
  readonly explicitPort: number | null;
  readonly exec: Exec;
  /** One terminal line (the URL, the result). */
  readonly out: (line: string) => void;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  /** Called once bound (tests). */
  readonly onListening?: (url: string, port: number) => void;
}

/** Runs the one-shot page until the first valid submission, the timeout, or SIGINT. */
export async function runSetupPage(opts: PageOptions): Promise<PageOutcome> {
  const token = randomBytes(32).toString("hex");
  let done: ((o: PageOutcome) => void) | null = null;
  const finished = new Promise<PageOutcome>((resolve) => {
    done = resolve;
  });
  const finish = (o: PageOutcome): void => {
    const d = done;
    done = null;
    d?.(o);
  };
  let port = 0;
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${String(port)}`;
    const pathOk = req.url === `/setup/${token}`;
    if (req.headers.host !== `127.0.0.1:${String(port)}` || !pathOk || done === null) {
      send(res, 404, null);
      return;
    }
    if (req.method === "GET") {
      send(res, 200, formHtml(token, null));
      return;
    }
    if (req.method !== "POST" || !sameOrigin(req, origin)) {
      send(res, 404, null);
      return;
    }
    void readBody(req).then((body) => {
      if (body === null || done === null) {
        send(res, 404, null);
        return;
      }
      const form = new URLSearchParams(body);
      const posted = form.get("token");
      if (posted === null || !sameToken(posted, token)) {
        send(res, 404, null);
        return;
      }
      const swid = normalizePastedValue(form.get("swid") ?? "");
      const s2 = normalizePastedValue(form.get("espn_s2") ?? "");
      const vs = validateSwid(swid);
      const ve = validateEspnS2(s2);
      if (!vs.ok || !ve.ok) {
        const bad = !vs.ok ? vs : ve.ok ? null : ve;
        send(res, 400, formHtml(token, bad === null ? "Value refused." : formatRefusalText(bad)));
        return;
      }
      send(res, 200, DONE_HTML);
      finish({ kind: "values", swid, espn_s2: s2 });
    });
  });
  server.keepAliveTimeout = 1_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  let bound = false;
  for (const p of candidatePorts(opts.explicitPort)) {
    const r = await listen(server, p);
    if (r === "ok") {
      port = p;
      bound = true;
      break;
    }
    if (opts.explicitPort !== null) {
      server.close();
      return { kind: "port_busy", port: p, owner: await portOwner(opts.exec, p) };
    }
  }
  if (!bound) {
    server.close();
    return { kind: "port_busy", port: null, owner: null };
  }
  const url = `http://127.0.0.1:${String(port)}/setup/${token}`;
  opts.out(
    `Open ${url} in your browser (this terminal waits ${String(Math.round((opts.timeoutMs ?? PAGE_TIMEOUT_MS) / 1000))} s; Ctrl-C stops it).`,
  );
  opts.onListening?.(url, port);
  const timer = setTimeout(() => {
    finish({ kind: "timeout" });
  }, opts.timeoutMs ?? PAGE_TIMEOUT_MS);
  const onAbort = (): void => {
    finish({ kind: "interrupted" });
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });
  if (opts.signal.aborted) onAbort();
  try {
    return await finished;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
    // let the last response flush (it carries `connection: close`), then force any idle or stray
    // connection shut so the port is free within a second (plan 03 §1.4)
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    server.closeIdleConnections();
    const force = setTimeout(() => {
      server.closeAllConnections();
    }, 300);
    await closed;
    clearTimeout(force);
  }
}
