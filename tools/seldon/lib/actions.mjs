// What you can do to a lane, in one place: start, stop, resume. The panel calls these, and so
// does `seldon lane …` — which is also how the panel acts on another machine (it runs
// `ssh <machine> seldon lane …`). One implementation, so the two can never disagree.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  readLanes, runSteps, run, harnessBins, recordLane, markLane, SELDON_HOME,
} from "./agents.mjs";
import { startCommands, resumeCommands, stopCommand, slugify, uniqueSlug, HARNESSES } from "./lanes.mjs";

const branchExists = (root, ref) => {
  try { execFileSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], { stdio: "ignore" }); return true; } catch { return false; }
};

export function startLane({ root, name, task, harness = "claude" }) {
  if (!HARNESSES.includes(harness)) return { ok: false, error: `unknown agent "${harness}" (${HARNESSES.join(", ")})` };
  if (!task || !String(task).trim()) return { ok: false, error: "a lane needs a task" };
  const bins = harnessBins();
  if (!bins[harness]) return { ok: false, slug: slugify(task), error: `${harness} is not installed (not on PATH)` };
  const worktreesDir = join(SELDON_HOME, "worktrees", name || root.split("/").pop());
  const names = new Set(allLanes().map((l) => l.name));
  const slug = uniqueSlug(slugify(task), (s) => names.has(s) || existsSync(join(worktreesDir, s)) || existsSync(join(root, ".claude", "worktrees", s)) || branchExists(root, `lane/${s}`));
  const cmds = startCommands({ harness, task, root, slug, worktreesDir, bins, env: { PATH: process.env.PATH } });
  const r = runSteps(cmds);
  const tmux = cmds.find((c) => c.session);
  if (r.ok && tmux) recordLane({ session: tmux.session, harness, task, slug, root, worktree: tmux.cwd, startedAt: Date.now() });
  return { ...r, slug };
}

export function stopLane(lane) {
  const how = stopCommand(lane);
  if (how.why) return { ok: false, why: how.why };
  const r = run(how, { quiet: true });
  // Stopped on purpose: not offered for resume after a reboot.
  if (r.ok && lane.tmuxSession) markLane(lane.tmuxSession, { stoppedAt: Date.now() });
  return r;
}

export function resumeLane(lane) {
  const how = resumeCommands(lane, { bins: harnessBins(), env: { PATH: process.env.PATH } });
  if (how.why) return { ok: false, why: how.why };
  const r = runSteps(how.cmds);
  if (r.ok && lane.tmuxSession) markLane(lane.tmuxSession, { stoppedAt: undefined, startedAt: Date.now() });
  return { ...r, fresh: !!how.fresh };
}

export const allLanes = () => readLanes().flatMap((g) => g.lanes);
// By key, or by name when exactly one lane has it (keys are long; names are what you see).
export function findLane(ref) {
  const lanes = allLanes();
  const byKey = lanes.find((l) => l.key === ref);
  if (byKey) return byKey;
  const named = lanes.filter((l) => l.name === ref);
  return named.length === 1 ? named[0] : null;
}
