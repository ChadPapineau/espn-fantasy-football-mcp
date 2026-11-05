// fixture-tree.ts — a derived fixture variant re-scripted in a temp tree of its own, with its
// RELATIVE root kept (the round-4c verifier's CR-3: a manifest root is never absolute, and nothing
// under it may resolve out of it). The files the variant's views name (each view's `path` and
// `patch`) are linked — hard links, else copies — under the temp tree at the same paths, and the
// manifest is written at the same depth, so its `root` still climbs to the tree's top.
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

interface ManifestView {
  readonly path?: unknown;
  readonly patch?: unknown;
}

/** `variantDir`'s manifest with `overrides` applied, in a new temp tree under `tmp`; its dir. */
export function variantTree(
  variantDir: string,
  overrides: Record<string, unknown>,
  tmp: string,
): string {
  const m = JSON.parse(readFileSync(path.join(variantDir, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  > & { root: string; views: readonly ManifestView[] };
  const fromRoot = path.resolve(variantDir, m.root);
  const tree = mkdtempSync(path.join(tmp, "tree-"));
  // the manifest at the same depth below the tree's top as below the fixture root
  const rel = path.relative(fromRoot, variantDir);
  const dir = path.join(tree, rel === "" ? "." : rel);
  mkdirSync(dir, { recursive: true });
  for (const v of m.views)
    for (const f of [v.path, v.patch]) {
      if (typeof f !== "string") continue;
      const to = path.join(tree, f);
      mkdirSync(path.dirname(to), { recursive: true });
      try {
        linkSync(path.join(fromRoot, f), to);
      } catch {
        copyFileSync(path.join(fromRoot, f), to);
      }
    }
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...m, ...overrides }));
  return dir;
}
