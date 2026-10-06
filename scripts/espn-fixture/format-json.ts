// format-json.ts — the one on-disk layout of every JSON file the fixture tooling writes: canonical
// content (canonical.ts) printed by the repo's pinned prettier, so `npm run format:check` accepts
// the files as written and reruns are byte-identical (plan 05 §3.1 step 3). Two profiles, each read
// explicitly from a config file in the repo (never a config found by walking up from a temp dir):
//   default  — the repo .prettierrc (manifests, the drift manifest);
//   recorded — fixtures/espn/recorded/.prettierrc: the same options at printWidth 1000, so each
//              stat map stays on one line (the 100-column layout triples a box score, past 1 MB).
// The content hash never depends on the layout (canonical.ts contentSha256).
import { readFileSync } from "node:fs";
import path from "node:path";
import * as prettier from "prettier";
import type { Json } from "./canonical.js";
import { REPO_ROOT } from "./http.js";

export type FormatProfile = "default" | "recorded";

export const PROFILE_CONFIG: Readonly<Record<FormatProfile, string>> = {
  default: path.join(REPO_ROOT, ".prettierrc"),
  recorded: path.join(REPO_ROOT, "fixtures", "espn", "recorded", ".prettierrc"),
};

const cache = new Map<FormatProfile, prettier.Options>();

function optionsFor(profile: FormatProfile): prettier.Options {
  let o = cache.get(profile);
  if (!o) {
    o = JSON.parse(readFileSync(PROFILE_CONFIG[profile], "utf8")) as prettier.Options;
    cache.set(profile, o);
  }
  return o;
}

/** Serialises `value` (key order as given) in the profile's prettier JSON style, newline-terminated. */
export async function formatJson(value: Json, profile: FormatProfile = "default"): Promise<string> {
  return prettier.format(JSON.stringify(value), { ...optionsFor(profile), parser: "json" });
}
