// Who is actually working — asked of tmux, in one place.
//
// apiary keys agents by name MACHINE-WIDE (tmux session `apiary_<name>`), so a name alone
// never says which project an agent serves: checking only the name once started a second
// coordinator on a project that already had one. `agentsInProject` answers the question that
// actually matters — "is anyone working in THIS repo?" — by matching the pane's cwd.
//
// staff.mjs asks it to decide whether to start an agent; hive.mjs asks it to report agents to
// the board, to `factory state` and to seldon. Both import from here so they cannot disagree.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const PREFIX = "apiary_";
const tmux = (args) => execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// A path comparison that survives /tmp -> /private/tmp and other symlinked roots.
export const realpathOr = (p) => { try { return realpathSync(p); } catch { return p; } };

// Is there a session for this agent name, anywhere on this machine?
export function agentRunning(name) {
  try { execFileSync("tmux", ["has-session", "-t", PREFIX + name], { stdio: "ignore" }); return true; } catch { return false; }
}

// Every apiary agent session on this machine. No tmux server yet (nothing ever started) is
// the normal cold state, not an error — hence [] rather than a throw.
export function apiarySessions() {
  try { return tmux(["ls", "-F", "#{session_name}"]).split("\n").filter((s) => s.startsWith(PREFIX)); } catch { return []; }
}

// The agents whose pane sits in `dir` — this project's agents, whatever they are named.
export function agentsInProject(dir) {
  const want = realpathOr(dir);
  return apiarySessions().filter((s) => {
    try { return realpathOr(tmux(["display", "-p", "-t", s, "#{pane_current_path}"]).trim()) === want; }
    catch { return false; }
  }).map((s) => s.slice(PREFIX.length));
}
