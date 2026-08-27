// Filesystem primitives with atomic + append-safe writes. No deps.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export const exists = (p) => existsSync(p);
export const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

// Atomic whole-file write: temp file in the same dir, then rename (rename is atomic on the same fs).
export function writeAtomic(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  // Deterministic temp name (no Date.now/Math.random — keeps behavior reproducible under retries).
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

// Lock-free concurrent append: single O_APPEND write syscall. Safe for many writers (DONE.md).
export function appendLine(p, line) {
  mkdirSync(dirname(p), { recursive: true });
  const fd = openSync(p, "a");
  try { writeSync(fd, line.endsWith("\n") ? line : line + "\n"); }
  finally { closeSync(fd); }
}

// UTC minute-precision ISO stamp, e.g. 2026-08-27T14:30Z — the tool stamps time, agents never do.
export function utcStamp(d) {
  const iso = d.toISOString();               // 2026-08-27T14:30:12.345Z
  return iso.slice(0, 16) + "Z";             // 2026-08-27T14:30Z
}
export const today = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD
