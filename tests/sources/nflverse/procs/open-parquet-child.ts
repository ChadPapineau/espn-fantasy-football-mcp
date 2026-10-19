// open-parquet-child.ts — a child process for tests/sources/nflverse/schema-bounds.test.ts (Stage C
// remediation nflverse-parquet-negative-children-hang): opens the parquet file at `argv[2]` with
// openParquet, then runs one `nflverse:players` refresh whose release serves that file through the
// fake transport (no network, no cookie), and prints both outcomes as one JSON line. Before the fix
// the finding's 35-byte file held openParquet in an endless synchronous loop, so this process never
// printed and the parent's deadline killed it; now it prints and exits 0. Run under
// `node --import tsx`.
import { readFileSync } from "node:fs";
import { fixedClock, seededRng } from "../../../../src/domain/clock.js";
import { playersSource } from "../../../../src/sources/nflverse/index.js";
import { openParquet } from "../../../../src/sources/nflverse/parquet.js";
import { NflverseSourceError } from "../../../../src/sources/nflverse/release.js";
import { fsTempArea, runRefresh } from "../../../../src/sources/runner.js";
import { fakeProSchedule, fakePublisher, fakeRefreshLog, proGame } from "../../runner/helpers.js";
import { REL } from "../helpers/fixtures.js";
import { makeCtx } from "../helpers/harness.js";

const path = process.argv[2] ?? "";
let opened: string;
try {
  await openParquet(path);
  opened = "opened";
} catch (e) {
  opened = e instanceof NflverseSourceError ? `${e.reason}: ${e.message}` : "threw";
}

const routes = new Map<string, Uint8Array>([
  [`${REL}/players/timestamp.txt`, new TextEncoder().encode("2026-10-06 01:46:36 EDT")],
  [`${REL}/players/players.parquet`, new Uint8Array(readFileSync(path))],
]);
const c = makeCtx([2026], { routes });
const publisher = fakePublisher();
const refreshLog = fakeRefreshLog();
try {
  const r = await runRefresh(
    { source: playersSource, seasons: [2026], week: null },
    {
      http: c.ctx.http,
      download: c.ctx.download,
      clock: fixedClock("2026-10-06T12:00:00.000Z"),
      rng: seededRng(1),
      publisher,
      refreshLog,
      proSchedule: fakeProSchedule([proGame(1, "2026-10-04T17:00:00.000Z")]),
      temp: fsTempArea(`${c.tempDir}/tmp`),
      sleep: () => Promise.resolve(),
    },
  );
  process.stdout.write(
    `${JSON.stringify({
      opened,
      status: r.status,
      source_error: r.status === "failed" ? r.source_error : null,
      published: publisher.published.length,
      logged: refreshLog.rows.at(-1)?.error ?? null,
    })}\n`,
  );
} finally {
  c.cleanup();
}
