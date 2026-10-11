// Hive ports: which are free, and which another registered hive already claims.
import { createServer } from "node:net";
import { readRegistry } from "./hive.mjs";

const portFree = (port) => new Promise((res) => {
  const s = createServer();
  s.once("error", () => res(false));
  s.once("listening", () => s.close(() => res(true)));
  s.listen(port, "127.0.0.1");
});

// `taken`: ports other registered hives claim. A hive that is down leaves its port free on the
// OS, but reusing it would make the registry send that hive's traffic to this one.
export async function freePort(start = 7920, span = 50, taken = new Set()) {
  for (let p = start; p < start + span; p++) if (!taken.has(p) && await portFree(p)) return p;
  throw new Error(`no free port in ${start}-${start + span - 1} for the hive`);
}

/** Ports claimed by registered hives, ignoring the one for `exceptDir` (a re-run reuses its own). */
export const registeredPorts = (exceptDir) => new Set(readRegistry().filter((e) => e.dir !== exceptDir)
  .map((e) => { try { return parseInt(new URL(e.hive.serverUrl).port, 10); } catch { return 0; } }));
