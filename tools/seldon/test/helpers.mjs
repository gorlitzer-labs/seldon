// Shared by tests that run `seldon up` / `seldon go`: those start REAL detached daemons (the
// watcher) under the sandbox's SELDON_HOME. Every such test must stop them, or each run of the
// suite leaves watchers polling forever — which it did, ten deep, before this existed.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function reapDaemons(seldonHome) {
  const run = join(seldonHome, "run");
  if (!existsSync(run)) return;
  for (const f of readdirSync(run).filter((n) => n.endsWith(".pid"))) {
    const pid = parseInt(readFileSync(join(run, f), "utf8"), 10);
    if (!pid) continue;
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  }
}
