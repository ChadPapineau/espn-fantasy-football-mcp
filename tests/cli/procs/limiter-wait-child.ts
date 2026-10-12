// limiter-wait-child.ts — a child process for tests/cli/espn-http-wait.test.ts: ONE `espnRequest`
// awaited at the top level whose first limiter check is refused for a full window (retry after
// `argv[2]` ms), then accepted. Nothing else holds the event loop (no socket, no timer of its own),
// exactly like a CLI command between two ESPN requests. Before the fix the limiter wait was an
// unreferenced timer and Node ended the process with exit 13 before the request was sent; now it
// prints the answer and exits 0. No network: the http client is a stub.
import { espnRequest } from "../../../src/cli/espn-http.js";
import type { LimiterRepository } from "../../../src/store/types.js";

const retryAfter = Number(process.argv[2] ?? "300");
let checks = 0;
let sent = 0;
const limiter = {
  tryRecord: () => {
    checks++;
    return checks === 1
      ? { ok: false as const, reason: "window" as const, retry_after_ms: retryAfter }
      : { ok: true as const, id: 1 };
  },
  recordOutcome: () => undefined,
} as unknown as LimiterRepository;
const r = await espnRequest(
  {
    http: {
      espnGet: () => {
        sent++;
        return Promise.resolve({ status: 200, body: new Uint8Array(), headers: {} });
      },
    } as never,
    limiter,
    clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
    origin: "job",
  },
  { url: "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026", cookie: null },
);
process.stdout.write(
  `${JSON.stringify({ status: "status" in r ? r.status : r.error, checks, sent })}\n`,
);
