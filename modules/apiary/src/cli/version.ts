/**
 * This package's version, for the help banner and the update check.
 *
 * Its own module because both index.ts and help.ts need it, and help.ts must
 * be importable without pulling in index.ts (which runs main() on import).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read a top-level field from this package's package.json. Null on failure. */
export function readPackageField(field: string): string | null {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, "../../package.json"), "utf-8"));
    return typeof pkg[field] === "string" ? pkg[field] : null;
  } catch {
    return null;
  }
}

export function getVersion(): string {
  return readPackageField("version") ?? process.env.npm_package_version ?? "unknown";
}
