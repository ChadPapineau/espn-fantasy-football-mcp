// freeze.ts — regenerates fixtures/golden/{espn-recorded.json,manifest.json} (plan 08 §6 step 1) from
// the recorded fixtures. Run deliberately, after an engine change the golden test explains or a
// re-recording:  scripts/dev/with-node.sh npx tsx tests/golden/freeze.ts
// Tests never write; tests/golden/espn-recorded.test.ts compares the engine with these files.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Json } from "../../scripts/espn-fixture/canonical.js";
import { formatJson } from "../../scripts/espn-fixture/format-json.js";
import {
  buildGolden,
  GOLDEN_DIR,
  GOLDEN_MANIFEST_PATH,
  GOLDEN_PATH,
  goldenManifest,
  goldenMismatches,
} from "./build.js";

const mismatches = goldenMismatches();
if (mismatches.length > 0) {
  process.stderr.write(
    `refusing to freeze: ${String(mismatches.length)} player-weeks do not match ESPN\n`,
  );
  process.exit(1);
}

const golden = buildGolden();
mkdirSync(GOLDEN_DIR, { recursive: true });
writeFileSync(GOLDEN_PATH, await formatJson(golden as unknown as Json));
writeFileSync(GOLDEN_MANIFEST_PATH, await formatJson(goldenManifest(golden)));
process.stderr.write(`wrote ${GOLDEN_PATH} and ${GOLDEN_MANIFEST_PATH}\n`);
