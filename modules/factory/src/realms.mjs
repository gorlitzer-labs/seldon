// factory realms — the machines factory can reach, straight from bifrost.
//
// Proves the integration is real: this list is not factory's own, it is
// bifrost's realm registry, read live. If bifrost knows a machine, factory can
// put a hive on it.
import { execFileSync } from "node:child_process";
import { listRealms, runnerArgv } from "./lib/realm.mjs";
import { c, say } from "./lib/log.mjs";

export async function factoryRealms() {
  const realms = listRealms();
  if (!realms.length) {
    say(c.dim("  no realms — bifrost has none configured (`bifrost realm add <name>`)"));
    return;
  }
  say(`${c.honey("🌐 realms")} ${c.dim("(from bifrost)")}`);
  for (const r of realms) {
    // A quick reachability probe, batch-mode so a dead realm cannot hang the list.
    const { bin, args } = runnerArgv(r, ["true"]);
    let up = false;
    try { execFileSync(bin, args, { stdio: "ignore", timeout: 9000 }); up = true; } catch { up = false; }
    const dot = up ? c.green("●") : c.dim("○");
    const who = r.user ? `${r.user}@${r.host}` : r.host;
    say(`  ${dot} ${c.bold(r.name)}  ${c.dim(who)}  ${up ? "" : c.dim("(unreachable)")}`);
  }
}
