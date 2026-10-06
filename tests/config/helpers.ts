// helpers.ts — temp directories and xattr stubs for the config tests (the path rules are about real
// modes, symlinks and realpaths, so they run against real files; the file-provider xattr check is
// stubbed except in the darwin-only test). Ported from sibling @d72e03b, adapted.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { XattrReader } from "../../src/config/paths.js";

/** The repository root (the checkout config must stay out of). */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** A fresh real-path temp dir (macOS /var → /private/var resolved) with a cleanup function. */
export function tempDir(prefix = "eff-config-"): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** An xattr reader that reports no attributes on any path. */
export const noXattrs: XattrReader = (paths) => new Map(paths.map((p) => [p, []]));

/** An xattr reader that reports `attrs` on every path inside `marked` (and nothing elsewhere). */
export function xattrsOn(marked: string, attrs: readonly string[]): XattrReader {
  return (paths) =>
    new Map(
      paths.map((p) => [p, p === marked || p.startsWith(`${marked}${path.sep}`) ? attrs : []]),
    );
}

/** An xattr reader that cannot read (spawn failure). */
export const brokenXattrs: XattrReader = () => null;
